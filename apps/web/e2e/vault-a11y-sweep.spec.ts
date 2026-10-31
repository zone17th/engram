process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

import { expect, test, type Browser, type CDPSession, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
  PASSWORD,
  expectSignedIn,
  newContext,
  patchSettingsViaPage,
  uniqueEmail,
} from './helpers';
import {
  CRYPTO_WAIT_MS,
  UI_WAIT_MS,
  VAULT_PASSPHRASE,
  addAuthenticator,
  enableWebAuthn,
  expectPasskeyAdded,
  expectVaultOpen,
  expectVaultShut,
  isApiPost,
  removeAuthenticator,
  signupViaUiSecret,
} from './vault-passkey-support';
import {
  A11Y_LANGS,
  A11Y_THEMES,
  activate,
  checkState,
  expectAppAnimatesWithoutPreference,
  fillSecretVerified,
  keyboardWalk,
  type A11yContext,
  type A11yLang,
  type A11yTheme,
  type KeyboardWalkOptions,
  type StateSpec,
} from './vault-journey-a11y';
import { fillSecret } from './vault-settings-secret';

/**
 * P03-T23 Part 2, bullet 2 (stages J1 + J2): a11y sweep of U3 onboarding (incl. step 3 passkey offer & remember-device
 * toggle), U4 unlock / forgot (incl. T17B recovery paths) / recovery, U5 locked list and U7 Settings vault security
 * with its dialogs, passkey list / rename / revoke dialog, auto-lock card and remember-device control, on the compose
 * stack's REAL API (no route stubs anywhere in this file; the only auth routing is helpers.isolateRateLimit, which
 * forwards cred-limited calls to the real API with a per-context client IP).
 *
 * Each of the four lang x theme groups owns one fresh user, one page and one fresh PRF virtual authenticator. Per state
 * the viewport is resized through 390 / 768 / 1440 and the page is checked for horizontal overflow, axe (wcag2a +
 * wcag2aa, 0 serious / critical) and a sanitized screenshot named `vault-a11y-<screen>-<lang>-<theme>-<w>.png`. The
 * en/light group additionally drives every transition with the keyboard (Enter / Space from focus reached by sequential
 * Tab traversal, never locator.press), walks the Tab order of every screen, asserts initial dialog focus before any
 * focus mutation, checks the focus trap and the focus return of every dialog (Escape and Cancel/Later button) and
 * asserts reduced motion at 1440. The four groups run concurrently in separate browser contexts to stay inside the CI
 * time budget (workers is 1 under E2E_STACK).
 *
 * Secrets: `process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1'` is set at module top so Playwright's worker never captures
 * `_snapshotForAI()` / `error-context.md` DOM snapshots on context closure. The vault passphrases, login password and
 * recovery key (read from the DOM of the group's own onboarding into a local variable) are written with fillSecret
 * only, never logged, asserted on as text, or screenshotted: every recovery-key cell and grid is masked in each frame.
 */

const NEW_PASSPHRASE = 'Zk7$vQm2-Rn9&Tp4w-Lx8#Bd5y';
const WRONG_PASSPHRASE = 'wrong-passphrase-a11y-sweep-0';
const RECOVERY_KEY_SHAPE = /^rk\d{1,2}_[0-7][0-9A-TV-Z]{3}(?:-[0-9A-TV-Z]{4}){5}-[0-9A-TV-Z]{2}$/;
const CANCEL_BUTTON = /^(Cancel|Huỷ)$/;
const LATER_BUTTON = /^(Later|Để sau)$/;
const MOTION_ROOTS = 'body';

function spec(screen: StateSpec['screen'], overrides: Partial<StateSpec> = {}): StateSpec {
  return { screen, motionRoots: MOTION_ROOTS, fullPage: true, ...overrides };
}

function dialogSpec(screen: StateSpec['screen']): StateSpec {
  return spec(screen, { axeInclude: '[role="dialog"]', fullPage: false });
}

/** Checks the state at three widths and, in the keyboard group, walks its Tab order (once, at 1440). */
async function checkScreen(ctx: A11yContext, state: StateSpec, scope: string, options: KeyboardWalkOptions = {}) {
  await checkState(ctx, state);
  if (ctx.keyboard) await keyboardWalk(ctx.page, scope, state.screen, options);
}

/** The signed-in user's settings win over cookies (LocaleThemeSync), so PATCH them, then align the cookies SSR reads. */
async function applyLangAndTheme(page: Page, lang: A11yLang, theme: A11yTheme) {
  expect((await patchSettingsViaPage(page, { locale: lang, theme })).status).toBe(200);
  const origin = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:3000').origin;
  await page.context().addCookies([
    { name: 'sabk_locale', value: lang, url: `${origin}/` },
    { name: 'sabk_theme', value: theme, url: `${origin}/` },
  ]);
}

/**
 * Opens a dialog and, right after it becomes visible and before `checkScreen` or any focus mutation, asserts that
 * `document.activeElement` is already inside `[role="dialog"]` (JR1-10).
 */
async function openDialog(ctx: A11yContext, opener: Locator, scopeSelector = 'body'): Promise<Locator> {
  await activate(ctx, opener, 'Enter', scopeSelector);
  const dialog = ctx.page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: UI_WAIT_MS });
  await expect
    .poll(
      () =>
        dialog.evaluate((el) => {
          const active = document.activeElement;
          return Boolean(active && active !== document.body && el.contains(active));
        }),
      { timeout: UI_WAIT_MS, message: 'initial focus must transfer inside newly opened dialog' },
    )
    .toBe(true);
  return dialog;
}

/** Keyboard group: focus must land on the opener after the dialog closes (Radix returns it; the passkey dialog does it by hand). */
async function expectClosed(ctx: A11yContext, dialog: Locator, opener: Locator) {
  await expect(dialog).toBeHidden({ timeout: UI_WAIT_MS });
  if (ctx.keyboard) await expect(opener).toBeFocused({ timeout: UI_WAIT_MS });
}

async function closeByEscape(ctx: A11yContext, dialog: Locator, opener: Locator) {
  await ctx.page.keyboard.press('Escape');
  await expectClosed(ctx, dialog, opener);
}

async function closeByButton(ctx: A11yContext, dialog: Locator, opener: Locator, name: RegExp) {
  await activate(ctx, dialog.getByRole('button', { name }), 'Space', '[role="dialog"]');
  await expectClosed(ctx, dialog, opener);
}

/** Closes through `first`; the keyboard group then reopens the dialog and closes it through the other path. */
async function closeBothWays(
  ctx: A11yContext,
  dialog: Locator,
  opener: Locator,
  cancel: RegExp,
  first: 'escape' | 'button',
  openerScope = '[data-testid="vault-security-section"]',
) {
  if (first === 'escape') await closeByEscape(ctx, dialog, opener);
  else await closeByButton(ctx, dialog, opener, cancel);
  if (!ctx.keyboard) return;
  const again = await openDialog(ctx, opener, openerScope);
  if (first === 'escape') await closeByButton(ctx, again, opener, cancel);
  else await closeByEscape(ctx, again, opener);
}

async function runGroup(browser: Browser, testInfo: TestInfo, lang: A11yLang, theme: A11yTheme) {
  const tag = `${lang}-${theme}`;
  const log = (step: string) => console.log(`[vault-a11y][${tag}] ${step}`);
  const context = await newContext(browser);
  let cdp: CDPSession | null = null;
  let authenticatorId: string | null = null;
  try {
    const page = await context.newPage();
    cdp = await enableWebAuthn(page);
    authenticatorId = await addAuthenticator(cdp, { hasPrf: true, isUserVerified: true });

    const ctx: A11yContext = { page, testInfo, lang, theme, keyboard: lang === 'en' && theme === 'light' };
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });

    log('signup');
    const email = uniqueEmail(`a11y-${tag}`);
    await signupViaUiSecret(page, email, PASSWORD);
    await expectSignedIn(page);
    await applyLangAndTheme(page, lang, theme);

    // ---- U3 onboarding -------------------------------------------------------------------------------------------
    log('onboarding step 1');
    await page.goto('/app/onboarding', { waitUntil: 'domcontentloaded', timeout: UI_WAIT_MS });
    const step1 = page.getByTestId('onboarding-step-passphrase');
    await expect(step1).toBeVisible({ timeout: CRYPTO_WAIT_MS });
    await fillSecretVerified(page.locator('#onboarding-passphrase'), VAULT_PASSPHRASE, CRYPTO_WAIT_MS);
    await fillSecretVerified(page.locator('#onboarding-confirm-passphrase'), VAULT_PASSPHRASE, CRYPTO_WAIT_MS);
    await expect(page.getByTestId('passphrase-strength-label')).toBeVisible({ timeout: UI_WAIT_MS });
    if (ctx.keyboard) await expectAppAnimatesWithoutPreference(page);
    await checkScreen(ctx, spec('onboarding-step1'), '[data-testid="onboarding-step-passphrase"]', {
      leaveFocusedSelector: '[data-testid="onboarding-continue-button"]',
    });
    await activate(
      ctx,
      page.getByTestId('onboarding-continue-button'),
      'Enter',
      '[data-testid="onboarding-step-passphrase"]',
    );

    log('onboarding recovery-key sheet');
    await expect(page.getByTestId('onboarding-step-recovery-keys')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
    await expect(page.locator('[data-testid^="recovery-key-slot-"]')).toHaveCount(10, { timeout: UI_WAIT_MS });
    // The group's own key, kept in a local variable only; the boolean keeps a failing match from printing it.
    const recoveryKey = ((await page.getByTestId('recovery-key-slot-1').textContent()) ?? '').trim();
    expect(RECOVERY_KEY_SHAPE.test(recoveryKey)).toBe(true);
    await checkScreen(ctx, spec('onboarding-rk-sheet'), '[data-testid="onboarding-step-recovery-keys"]', {
      leaveFocusedSelector: '[data-testid="recovery-keys-confirm-checkbox"]',
    });

    const confirmBox = page.getByTestId('recovery-keys-confirm-checkbox');
    await activate(ctx, confirmBox, 'Space', '[data-testid="onboarding-step-recovery-keys"]');
    await expect(confirmBox).toBeChecked({ timeout: UI_WAIT_MS });
    await expect(page.getByTestId('onboarding-create-vault-button')).toBeEnabled({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, spec('onboarding-confirm'), '[data-testid="onboarding-step-recovery-keys"]', {
      leaveFocusedSelector: '[data-testid="onboarding-create-vault-button"]',
    });

    log('create vault -> onboarding step 3');
    const created = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault'), { timeout: CRYPTO_WAIT_MS });
    await activate(
      ctx,
      page.getByTestId('onboarding-create-vault-button'),
      'Enter',
      '[data-testid="onboarding-step-recovery-keys"]',
    );
    expect((await created).ok()).toBe(true);
    await expect(page.getByTestId('onboarding-step-passkey')).toBeVisible({ timeout: UI_WAIT_MS });
    await expect(page.getByTestId('recovery-keys-grid')).toHaveCount(0);
    const onboardingRememberSwitch = page.getByTestId('onboarding-remember-device-switch');
    await expect(onboardingRememberSwitch).toHaveAttribute('aria-checked', 'false', { timeout: UI_WAIT_MS });
    await checkScreen(ctx, spec('onboarding-step3'), '[data-testid="onboarding-step-passkey"]', {
      leaveFocusedSelector: '[data-testid="onboarding-remember-device-switch"]',
    });
    // Exercise the step-3 remember-device switch (on then back off so lock/unlock below is not bypassed by silent DevKey).
    await activate(ctx, onboardingRememberSwitch, 'Space', '[data-testid="onboarding-step-passkey"]');
    await expect(onboardingRememberSwitch).toHaveAttribute('aria-checked', 'true', { timeout: CRYPTO_WAIT_MS });
    await activate(ctx, onboardingRememberSwitch, 'Space', '[data-testid="onboarding-step-passkey"]');
    await expect(onboardingRememberSwitch).toHaveAttribute('aria-checked', 'false', { timeout: UI_WAIT_MS });
    await activate(
      ctx,
      page.getByTestId('onboarding-skip-passkey-button'),
      'Enter',
      '[data-testid="onboarding-step-passkey"]',
    );
    await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
    await expectVaultOpen(page);

    // ---- U5 locked state on /app ---------------------------------------------------------------------------------
    log('lock');
    await activate(ctx, page.getByTestId('vault-lock-button'), 'Enter', 'header');
    await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
    await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
    await expectVaultShut(page);
    await checkScreen(ctx, spec('locked-list'), '[data-testid="vault-locked-banner"]', {
      leaveFocusedSelector: '[data-testid="vault-locked-unlock-cta"]',
    });
    await activate(ctx, page.getByTestId('vault-locked-unlock-cta'), 'Enter', '[data-testid="vault-locked-banner"]');

    // ---- U4 unlock, forgot passphrase (T17B additions), recovery -------------------------------------------------
    log('unlock empty');
    await expect(page).toHaveURL(/\/app\/unlock$/, { timeout: UI_WAIT_MS });
    await expect(page.getByTestId('vault-unlock-page')).toBeVisible({ timeout: UI_WAIT_MS });
    const unlockInput = page.getByTestId('unlock-passphrase-input');
    await expect(unlockInput).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, spec('unlock-empty'), '[data-testid="vault-unlock-page"]');

    log('unlock incorrect passphrase');
    await fillSecretVerified(unlockInput, WRONG_PASSPHRASE);
    await activate(ctx, page.getByTestId('unlock-submit-button'), 'Enter', '[data-testid="vault-unlock-page"]');
    await expect(page.getByTestId('unlock-error-incorrect-passphrase')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
    await expect
      .poll(() => unlockInput.evaluate((el) => (el as HTMLInputElement).value.length), { timeout: UI_WAIT_MS })
      .toBe(0);
    await expect(unlockInput).toBeEnabled({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, spec('unlock-incorrect'), '[data-testid="vault-unlock-page"]', {
      leaveFocusedSelector: '[data-testid="unlock-forgot-passphrase-link"]',
    });

    log('forgot passphrase (with T17B recovery paths)');
    await activate(
      ctx,
      page.getByTestId('unlock-forgot-passphrase-link'),
      'Enter',
      '[data-testid="vault-unlock-page"]',
    );
    await expect(page).toHaveURL(/\/app\/unlock\/forgot$/, { timeout: UI_WAIT_MS });
    await expect(page.getByTestId('forgot-passphrase-page')).toBeVisible({ timeout: UI_WAIT_MS });
    await expect(page.getByTestId('forgot-path-passkey')).toBeVisible({ timeout: UI_WAIT_MS });
    await expect(page.getByTestId('forgot-path-remembered-device')).toBeVisible({ timeout: UI_WAIT_MS });
    await expect(page.getByTestId('forgot-path-unlocked-tab')).toBeVisible({ timeout: UI_WAIT_MS });
    await expect(page.getByTestId('forgot-path-recovery-key')).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, spec('forgot-passphrase'), '[data-testid="forgot-passphrase-page"]', {
      leaveFocusedSelector: '[data-testid="forgot-use-recovery-key-cta"]',
    });
    await activate(
      ctx,
      page.getByTestId('forgot-use-recovery-key-cta'),
      'Enter',
      '[data-testid="forgot-passphrase-page"]',
    );

    log('recovery re-auth');
    await expect(page).toHaveURL(/\/app\/recovery$/, { timeout: UI_WAIT_MS });
    await expect(page.getByTestId('recovery-step-reauth')).toBeVisible({ timeout: UI_WAIT_MS });
    await fillSecretVerified(page.getByTestId('recovery-reauth-password-input'), PASSWORD);
    await expect(page.getByTestId('recovery-reauth-password-submit')).toBeEnabled({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, spec('recovery-reauth'), '[data-testid="recovery-step-reauth"]', {
      leaveFocusedSelector: '[data-testid="recovery-reauth-password-submit"]',
    });
    const recoveryReauthed = page.waitForResponse((r) => isApiPost(r, '/api/v1/auth/reauth'), { timeout: UI_WAIT_MS });
    await activate(
      ctx,
      page.getByTestId('recovery-reauth-password-submit'),
      'Enter',
      '[data-testid="recovery-step-reauth"]',
    );
    expect((await recoveryReauthed).ok()).toBe(true);

    log('recovery enter key');
    await expect(page.getByTestId('recovery-step-enter-key')).toBeVisible({ timeout: UI_WAIT_MS });
    const keyInput = page.getByTestId('recovery-key-input');
    await expect(keyInput).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, spec('recovery-enter-key'), '[data-testid="recovery-step-enter-key"]');
    const lookedUp = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault/unlock/recovery'), {
      timeout: CRYPTO_WAIT_MS,
    });
    await fillSecretVerified(keyInput, recoveryKey);
    await activate(ctx, page.getByTestId('recovery-key-submit'), 'Enter', '[data-testid="recovery-step-enter-key"]');
    expect((await lookedUp).ok()).toBe(true);

    log('recovery new passphrase');
    await expect(page.getByTestId('recovery-step-new-passphrase')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
    await fillSecretVerified(page.getByTestId('recovery-new-passphrase-input'), NEW_PASSPHRASE);
    await fillSecretVerified(page.getByTestId('recovery-confirm-passphrase-input'), NEW_PASSPHRASE);
    await expect(page.getByTestId('recovery-passphrase-strength-label')).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, spec('recovery-new-passphrase'), '[data-testid="recovery-step-new-passphrase"]', {
      leaveFocusedSelector: '[data-testid="recovery-step3-submit"]',
    });
    // Completing the recovery frees slot 1 (a real empty slot for the Settings regenerate dialog) and leaves the vault open.
    const completed = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault/recover/complete'), {
      timeout: CRYPTO_WAIT_MS,
    });
    await activate(
      ctx,
      page.getByTestId('recovery-step3-submit'),
      'Enter',
      '[data-testid="recovery-step-new-passphrase"]',
    );
    expect((await completed).ok()).toBe(true);
    await expect(page.getByTestId('recovery-step-regenerate-reauth')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
    await expectVaultOpen(page);
    await activate(
      ctx,
      page.getByTestId('recovery-step4-skip-button'),
      'Enter',
      '[data-testid="recovery-step-regenerate-reauth"]',
    );
    await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
    await expectVaultOpen(page);

    // ---- U7 Settings vault security ------------------------------------------------------------------------------
    log('settings section');
    await activate(ctx, page.locator('a[href="/app/settings"]:visible').first(), 'Enter', 'header');
    await expect(page).toHaveURL(/\/app\/settings$/, { timeout: UI_WAIT_MS });
    await expect(page.getByTestId('vault-security-section')).toBeVisible({ timeout: UI_WAIT_MS });
    await expect(page.getByTestId('recovery-keys-slot-chips')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
    await expect(page.getByTestId('settings-passkey-card')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
    await expect(page.getByTestId('settings-auto-lock-card')).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(
      ctx,
      spec('settings-section', { axeInclude: '#baomat' }),
      '[data-testid="vault-security-section"]',
      { leaveFocusedSelector: '[data-open-dialog="passDlg"]' },
    );

    log('settings change-passphrase dialog');
    const passOpener = page.locator('[data-open-dialog="passDlg"]');
    let dialog = await openDialog(ctx, passOpener, '[data-testid="vault-security-section"]');
    await expect(dialog.locator('[data-view="pass-form"]')).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, dialogSpec('settings-passphrase-dialog'), '[role="dialog"]', { trap: true });
    await closeBothWays(ctx, dialog, passOpener, CANCEL_BUTTON, 'escape');

    log('settings regenerate dialog');
    const regenerateOpener = page.locator('[data-open-dialog="rkDlg"]');
    await expect(regenerateOpener).toBeEnabled({ timeout: CRYPTO_WAIT_MS });
    dialog = await openDialog(ctx, regenerateOpener, '[data-testid="vault-security-section"]');
    await expect(dialog.locator('[data-view="rk-reauth"]')).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, dialogSpec('settings-rk-regenerate-reauth'), '[role="dialog"]', { trap: true });
    await closeBothWays(ctx, dialog, regenerateOpener, CANCEL_BUTTON, 'escape');

    log('settings rotate dialog');
    const rotateOpener = page.locator('[data-open-dialog="rotateDlg"]');
    dialog = await openDialog(ctx, rotateOpener, '[data-testid="vault-security-section"]');
    await expect(dialog.locator('[data-view="rot-reauth"]')).toBeVisible({ timeout: UI_WAIT_MS });
    await fillSecretVerified(dialog.locator('#rot-reauth-pwd'), PASSWORD);
    await expect(dialog.getByRole('button', { name: /^(Continue|Tiếp tục)$/ })).toBeEnabled({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, dialogSpec('settings-rk-rotate-reauth'), '[role="dialog"]', {
      trap: true,
      leaveFocusedSelector: 'button.btn-primary',
    });
    await activate(ctx, dialog.getByRole('button', { name: /^(Continue|Tiếp tục)$/ }), 'Enter', '[role="dialog"]');
    await expect(dialog.locator('[data-view="rot-keys"]')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
    await expect(dialog.locator('[data-testid^="recovery-key-slot-"]')).toHaveCount(10, { timeout: UI_WAIT_MS });
    await checkScreen(ctx, dialogSpec('settings-rk-rotate-sheet'), '[role="dialog"]', { trap: true });
    // Cancel closes the sheet without confirming: the rotation is never committed.
    await closeBothWays(ctx, dialog, rotateOpener, CANCEL_BUTTON, 'button');
    // Boolean on purpose: a failing text match would print a recovery key into the CI log.
    await expect
      .poll(() => page.evaluate(() => /rk\d+_[0-9A-Z]{4}-[0-9A-Z]{4}/.test(document.body.innerText)), {
        timeout: UI_WAIT_MS,
      })
      .toBe(false);

    log('settings reset dialog (JR1-11 keyboard transitions)');
    const resetOpener = page.locator('[data-open-dialog="resetDlg"]');
    dialog = await openDialog(ctx, resetOpener, '[data-testid="vault-security-section"]');
    await expect(dialog.locator('[data-view="rst-s1"]')).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, dialogSpec('settings-reset-step1'), '[role="dialog"]', {
      trap: true,
      leaveFocusedSelector: 'button.btn-secondary',
    });
    await activate(
      ctx,
      dialog.getByRole('button', { name: /^(None of these work|Không đường nào dùng được)$/ }),
      'Enter',
      '[role="dialog"]',
    );
    await expect(dialog.locator('[data-view="rst-s2"]')).toBeVisible({ timeout: UI_WAIT_MS });
    if (ctx.keyboard) {
      await keyboardWalk(page, '[role="dialog"]', 'settings-reset-step2', {
        trap: true,
        leaveFocusedSelector: 'button.btn-secondary',
      });
    }
    await activate(
      ctx,
      dialog.getByRole('button', { name: /^(Checked backups|Đã kiểm tra backup)$/ }),
      'Enter',
      '[role="dialog"]',
    );
    await expect(dialog.locator('[data-view="rst-s3"]')).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, dialogSpec('settings-reset-reauth'), '[role="dialog"]', { trap: true });
    // The reset is never confirmed. Escape from step 3; the keyboard group reopens at step 1 and uses "Later".
    await closeBothWays(ctx, dialog, resetOpener, LATER_BUTTON, 'escape');

    log('settings add-passkey dialog -> register passkey -> passkey list, rename & revoke dialog');
    const passkeyOpener = page.locator('[data-testid="settings-passkey-card"] button').first();
    dialog = await openDialog(ctx, passkeyOpener, '[data-testid="settings-passkey-card"]');
    await expect(dialog.locator('input[type="password"]')).toBeVisible({ timeout: UI_WAIT_MS });
    await fillSecret(dialog.locator('input[type="password"]'), PASSWORD, UI_WAIT_MS);
    await expect(dialog.getByRole('button', { name: /^(Confirm|Xác nhận)$/ })).toBeEnabled({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, dialogSpec('settings-passkey-reauth'), '[role="dialog"]', {
      trap: true,
      leaveFocusedSelector: 'button.btn-primary',
    });
    const passkeyReauthed = page.waitForResponse((r) => isApiPost(r, '/api/v1/auth/reauth'), { timeout: UI_WAIT_MS });
    await activate(ctx, dialog.getByRole('button', { name: /^(Confirm|Xác nhận)$/ }), 'Enter', '[role="dialog"]');
    expect((await passkeyReauthed).ok()).toBe(true);
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0, { timeout: UI_WAIT_MS });
    await expect(dialog.getByRole('button', { name: /^(Continue|Tiếp tục)$/ })).toBeEnabled({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, dialogSpec('settings-passkey-name'), '[role="dialog"]', { trap: true });
    // Close both ways (Cancel + Escape) while the vault.passkey_register grant stays active, then reopen to register.
    await closeBothWays(ctx, dialog, passkeyOpener, CANCEL_BUTTON, 'button', '[data-testid="settings-passkey-card"]');

    dialog = await openDialog(ctx, passkeyOpener, '[data-testid="settings-passkey-card"]');
    await expect(dialog.getByRole('button', { name: /^(Continue|Tiếp tục)$/ })).toBeEnabled({ timeout: UI_WAIT_MS });
    const nameInput = dialog.locator('input[type="text"]');
    await nameInput.fill('MacBook Pro · Touch ID');
    const passkeySaved = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault/passkeys'), {
      timeout: CRYPTO_WAIT_MS,
    });
    await activate(ctx, dialog.getByRole('button', { name: /^(Continue|Tiếp tục)$/ }), 'Enter', '[role="dialog"]');
    expect((await passkeySaved).ok()).toBe(true);
    await expectPasskeyAdded(page);

    const passkeyList = page.getByTestId('settings-passkey-list');
    await expect(passkeyList).toBeVisible({ timeout: UI_WAIT_MS });
    await expect(passkeyList).toContainText('MacBook Pro · Touch ID');
    // Stabilize dynamic created_at date inside the passkey list for deterministic visual review
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>('[data-testid="settings-passkey-list"] .mono')) {
        const text = el.textContent?.trim() ?? '';
        if (/^(added|thêm)\s/i.test(text)) {
          el.textContent = /^thêm/i.test(text) ? 'thêm 12/02/2026' : 'added 02/12/2026';
        }
      }
    });
    await checkScreen(
      ctx,
      spec('settings-passkey-list', { axeInclude: '[data-testid="settings-passkey-card"]' }),
      '[data-testid="settings-passkey-card"]',
      { leaveFocusedSelector: '[data-testid^="settings-passkey-rename-"]' },
    );

    log('settings passkey inline rename');
    const renameOpener = page.locator('[data-testid^="settings-passkey-rename-"]').first();
    await activate(ctx, renameOpener, 'Enter', '[data-testid="settings-passkey-card"]');
    const renameInput = page.locator('[data-testid^="settings-passkey-rename-input-"]').first();
    await expect(renameInput).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(
      ctx,
      spec('settings-passkey-rename', { axeInclude: '[data-testid="settings-passkey-card"]' }),
      '[data-testid="settings-passkey-card"]',
      { leaveFocusedSelector: '[data-testid^="settings-passkey-rename-cancel-"]' },
    );
    await activate(
      ctx,
      page.locator('[data-testid^="settings-passkey-rename-cancel-"]').first(),
      'Enter',
      '[data-testid="settings-passkey-card"]',
    );
    await expect(renameInput).toHaveCount(0, { timeout: UI_WAIT_MS });
    if (ctx.keyboard) await expect(renameOpener).toBeFocused({ timeout: UI_WAIT_MS });

    log('settings passkey revoke dialog');
    const revokeOpener = page.locator('[data-testid^="settings-passkey-revoke-"]').first();
    dialog = await openDialog(ctx, revokeOpener, '[data-testid="settings-passkey-card"]');
    await expect(dialog.getByTestId('settings-passkey-revoke-confirm')).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, dialogSpec('settings-passkey-revoke'), '[role="dialog"]', { trap: true });
    await closeBothWays(ctx, dialog, revokeOpener, CANCEL_BUTTON, 'escape', '[data-testid="settings-passkey-card"]');

    log('settings auto-lock card & remember-device control');
    const autoLockCard = page.getByTestId('settings-auto-lock-card');
    await expect(autoLockCard).toBeVisible({ timeout: UI_WAIT_MS });
    const settingsRememberSwitch = page.getByTestId('settings-remember-device-switch');
    await expect(settingsRememberSwitch).toHaveAttribute('aria-checked', 'false', { timeout: UI_WAIT_MS });
    await checkScreen(
      ctx,
      spec('settings-auto-lock', { axeInclude: '[data-testid="settings-auto-lock-card"]' }),
      '[data-testid="settings-auto-lock-card"]',
      { leaveFocusedSelector: '[data-testid="settings-remember-device-switch"]' },
    );

    await activate(ctx, settingsRememberSwitch, 'Space', '[data-testid="settings-auto-lock-card"]');
    await expect(settingsRememberSwitch).toHaveAttribute('aria-checked', 'true', { timeout: CRYPTO_WAIT_MS });
    await expect(page.getByTestId('settings-forget-device-button')).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(
      ctx,
      spec('settings-remember-device', { axeInclude: '[data-testid="settings-auto-lock-card"]' }),
      '[data-testid="settings-auto-lock-card"]',
      { leaveFocusedSelector: '[data-testid="settings-forget-device-button"]' },
    );
    await activate(
      ctx,
      page.getByTestId('settings-forget-device-button'),
      'Enter',
      '[data-testid="settings-auto-lock-card"]',
    );
    await expect(settingsRememberSwitch).toHaveAttribute('aria-checked', 'false', { timeout: UI_WAIT_MS });

    log('done');
  } finally {
    if (cdp && authenticatorId) {
      await removeAuthenticator(cdp, authenticatorId).catch(() => undefined);
    }
    await context.close();
  }
}

test.describe('P03-T23 vault a11y sweep (U3/U4/U5/U7, J1 + J2)', () => {
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  test('en and vi x light and dark x 390/768/1440: axe, overflow, screenshots; keyboard, focus and reduced motion', async ({
    browser,
  }, testInfo) => {
    // Four groups run concurrently (one browser context each): each does 25 screen states x 3 widths plus four Argon2id
    // derives and one passkey PRF registration on a shared CI runner. Target is <= 7 min wall clock.
    test.setTimeout(420_000);

    const groups = A11Y_LANGS.flatMap((lang) => A11Y_THEMES.map((theme) => ({ lang, theme })));
    const outcomes = await Promise.allSettled(
      groups.map(({ lang, theme }) => runGroup(browser, testInfo, lang, theme)),
    );
    const failures = outcomes.flatMap((outcome, index) =>
      outcome.status === 'rejected'
        ? [
            `${groups[index].lang}-${groups[index].theme}: ${
              outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
            }`,
          ]
        : [],
    );
    // Every group's failure is reported, not only the first.
    expect(failures, failures.join('\n---\n')).toEqual([]);
  });
});
