import { expect, test, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
  PASSWORD,
  expectSignedIn,
  newContext,
  patchSettingsViaPage,
  tokenFromLink,
  uniqueEmail,
  verifyRequired,
  waitForMail,
} from './helpers';
import {
  CRYPTO_WAIT_MS,
  UI_WAIT_MS,
  VAULT_PASSPHRASE,
  expectVaultOpen,
  expectVaultShut,
  isApiPost,
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
  type StateSpec,
} from './vault-journey-a11y';
import { fillSecret } from './vault-settings-secret';

/**
 * P03-T23 Part 2, bullet 2 (stage J1): a11y sweep of U3 onboarding, U4 unlock / forgot / recovery, U5 locked list and
 * U7 Settings vault security with its dialogs, on the compose stack's REAL API (no route stubs anywhere in this file;
 * the only auth routing is helpers.isolateRateLimit, which forwards cred-limited calls to the real API with a per-context
 * client IP).
 *
 * Each of the four lang x theme groups owns one fresh user and one page. Per state the viewport is resized through
 * 390 / 768 / 1440 and the page is checked for horizontal overflow, axe (wcag2a + wcag2aa, 0 serious / critical) and a
 * sanitized screenshot named `vault-a11y-<screen>-<lang>-<theme>-<w>.png`. The en/light group additionally drives every
 * transition with the keyboard (Enter / Space), walks the Tab order of every screen, checks the focus trap and the focus
 * return of every dialog (Escape and the Cancel button) and asserts reduced motion at 1440. The four groups run
 * concurrently in separate browser contexts to stay inside the CI time budget (workers is 1 under E2E_STACK).
 *
 * Secrets: the vault passphrases, the login password and the recovery key (read from the DOM of the group's own
 * onboarding into a local variable) are written with fillSecret only, never logged, asserted on as text, or
 * screenshotted: every recovery-key cell and grid is masked in each frame.
 *
 * TODO(J2): onboarding step 3, passkey list, remember device, auto-lock card and the forgot-page additions.
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
async function checkScreen(ctx: A11yContext, state: StateSpec, scope: string, options: { trap?: boolean } = {}) {
  await checkState(ctx, state);
  if (ctx.keyboard) await keyboardWalk(ctx.page, scope, state.screen, options);
}

async function confirmEmailToken(page: Page, token: string) {
  await page.goto(`/app/auth/verify-email?token=${encodeURIComponent(token)}`, {
    waitUntil: 'domcontentloaded',
    timeout: UI_WAIT_MS,
  });
  const confirmed = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/api/v1/auth/verify-email/confirm'),
    { timeout: UI_WAIT_MS },
  );
  await page.getByRole('button', { name: /Confirm|Xác nhận email/ }).click({ timeout: UI_WAIT_MS });
  expect((await confirmed).status()).toBe(200);
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

async function openDialog(ctx: A11yContext, opener: Locator): Promise<Locator> {
  await activate(ctx, opener);
  const dialog = ctx.page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: UI_WAIT_MS });
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
  await activate(ctx, dialog.getByRole('button', { name }), 'Space');
  await expectClosed(ctx, dialog, opener);
}

/** Closes through `first`; the keyboard group then reopens the dialog and closes it through the other path. */
async function closeBothWays(
  ctx: A11yContext,
  dialog: Locator,
  opener: Locator,
  cancel: RegExp,
  first: 'escape' | 'button',
) {
  if (first === 'escape') await closeByEscape(ctx, dialog, opener);
  else await closeByButton(ctx, dialog, opener, cancel);
  if (!ctx.keyboard) return;
  const again = await openDialog(ctx, opener);
  if (first === 'escape') await closeByButton(ctx, again, opener, cancel);
  else await closeByEscape(ctx, again, opener);
}

async function runGroup(browser: Browser, testInfo: TestInfo, lang: A11yLang, theme: A11yTheme) {
  const tag = `${lang}-${theme}`;
  const log = (step: string) => console.log(`[vault-a11y][${tag}] ${step}`);
  const context = await newContext(browser);
  try {
    const page = await context.newPage();
    const ctx: A11yContext = { page, testInfo, lang, theme, keyboard: lang === 'en' && theme === 'light' };
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });

    log('signup');
    const email = uniqueEmail(`a11y-${tag}`);
    await signupViaUiSecret(page, email, PASSWORD);
    if (verifyRequired()) {
      const mail = await waitForMail(email, 'verify_email');
      await confirmEmailToken(page, tokenFromLink(mail.link));
    }
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
    await checkScreen(ctx, spec('onboarding-step1'), '[data-testid="onboarding-step-passphrase"]');
    await activate(ctx, page.getByTestId('onboarding-continue-button'));

    log('onboarding recovery-key sheet');
    await expect(page.getByTestId('onboarding-step-recovery-keys')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
    await expect(page.locator('[data-testid^="recovery-key-slot-"]')).toHaveCount(10, { timeout: UI_WAIT_MS });
    // The group's own key, kept in a local variable only; the boolean keeps a failing match from printing it.
    const recoveryKey = ((await page.getByTestId('recovery-key-slot-1').textContent()) ?? '').trim();
    expect(RECOVERY_KEY_SHAPE.test(recoveryKey)).toBe(true);
    await checkScreen(ctx, spec('onboarding-rk-sheet'), '[data-testid="onboarding-step-recovery-keys"]');

    const confirmBox = page.getByTestId('recovery-keys-confirm-checkbox');
    await activate(ctx, confirmBox, 'Space');
    await expect(confirmBox).toBeChecked({ timeout: UI_WAIT_MS });
    await expect(page.getByTestId('onboarding-create-vault-button')).toBeEnabled({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, spec('onboarding-confirm'), '[data-testid="onboarding-step-recovery-keys"]');

    log('create vault');
    const created = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault'), { timeout: CRYPTO_WAIT_MS });
    await activate(ctx, page.getByTestId('onboarding-create-vault-button'));
    expect((await created).ok()).toBe(true);
    await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
    await expectVaultOpen(page);

    // ---- U5 locked state on /app ---------------------------------------------------------------------------------
    log('lock');
    await activate(ctx, page.getByTestId('vault-lock-button'));
    await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
    await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
    await expectVaultShut(page);
    await checkScreen(ctx, spec('locked-list'), '[data-testid="vault-locked-banner"]');
    await activate(ctx, page.getByTestId('vault-locked-unlock-cta'));

    // ---- U4 unlock, forgot passphrase, recovery ------------------------------------------------------------------
    log('unlock empty');
    await expect(page).toHaveURL(/\/app\/unlock$/, { timeout: UI_WAIT_MS });
    await expect(page.getByTestId('vault-unlock-page')).toBeVisible({ timeout: UI_WAIT_MS });
    const unlockInput = page.getByTestId('unlock-passphrase-input');
    await expect(unlockInput).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, spec('unlock-empty'), '[data-testid="vault-unlock-page"]');

    log('unlock incorrect passphrase');
    await fillSecretVerified(unlockInput, WRONG_PASSPHRASE);
    await activate(ctx, page.getByTestId('unlock-submit-button'));
    await expect(page.getByTestId('unlock-error-incorrect-passphrase')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
    await expect
      .poll(() => unlockInput.evaluate((el) => (el as HTMLInputElement).value.length), { timeout: UI_WAIT_MS })
      .toBe(0);
    await expect(unlockInput).toBeEnabled({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, spec('unlock-incorrect'), '[data-testid="vault-unlock-page"]');

    log('forgot passphrase');
    await activate(ctx, page.getByTestId('unlock-forgot-passphrase-link'));
    await expect(page).toHaveURL(/\/app\/unlock\/forgot$/, { timeout: UI_WAIT_MS });
    await expect(page.getByTestId('forgot-passphrase-page')).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, spec('forgot-passphrase'), '[data-testid="forgot-passphrase-page"]');
    await activate(ctx, page.getByTestId('forgot-use-recovery-key-cta'));

    log('recovery re-auth');
    await expect(page).toHaveURL(/\/app\/recovery$/, { timeout: UI_WAIT_MS });
    await expect(page.getByTestId('recovery-step-reauth')).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, spec('recovery-reauth'), '[data-testid="recovery-step-reauth"]');
    const recoveryReauthed = page.waitForResponse((r) => isApiPost(r, '/api/v1/auth/reauth'), { timeout: UI_WAIT_MS });
    await fillSecretVerified(page.getByTestId('recovery-reauth-password-input'), PASSWORD);
    await activate(ctx, page.getByTestId('recovery-reauth-password-submit'));
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
    await activate(ctx, page.getByTestId('recovery-key-submit'));
    expect((await lookedUp).ok()).toBe(true);

    log('recovery new passphrase');
    await expect(page.getByTestId('recovery-step-new-passphrase')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
    await fillSecretVerified(page.getByTestId('recovery-new-passphrase-input'), NEW_PASSPHRASE);
    await fillSecretVerified(page.getByTestId('recovery-confirm-passphrase-input'), NEW_PASSPHRASE);
    await expect(page.getByTestId('recovery-passphrase-strength-label')).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, spec('recovery-new-passphrase'), '[data-testid="recovery-step-new-passphrase"]');
    // Completing the recovery frees slot 1 (a real empty slot for the Settings regenerate dialog) and leaves the vault open.
    const completed = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault/recover/complete'), {
      timeout: CRYPTO_WAIT_MS,
    });
    await activate(ctx, page.getByTestId('recovery-step3-submit'));
    expect((await completed).ok()).toBe(true);
    await expect(page.getByTestId('recovery-step-regenerate-reauth')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
    await expectVaultOpen(page);
    await activate(ctx, page.getByTestId('recovery-step4-skip-button'));
    await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
    await expectVaultOpen(page);

    // ---- U7 Settings vault security ------------------------------------------------------------------------------
    log('settings section');
    await activate(ctx, page.locator('a[href="/app/settings"]:visible').first());
    await expect(page).toHaveURL(/\/app\/settings$/, { timeout: UI_WAIT_MS });
    await expect(page.getByTestId('vault-security-section')).toBeVisible({ timeout: UI_WAIT_MS });
    await expect(page.getByTestId('recovery-keys-slot-chips')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
    await expect(page.getByTestId('settings-passkey-card')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
    await checkScreen(
      ctx,
      spec('settings-section', { axeInclude: '#baomat' }),
      '[data-testid="vault-security-section"]',
    );

    log('settings change-passphrase dialog');
    const passOpener = page.locator('[data-open-dialog="passDlg"]');
    let dialog = await openDialog(ctx, passOpener);
    await expect(dialog.locator('[data-view="pass-form"]')).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, dialogSpec('settings-passphrase-dialog'), '[role="dialog"]', { trap: true });
    await closeBothWays(ctx, dialog, passOpener, CANCEL_BUTTON, 'escape');

    log('settings regenerate dialog');
    const regenerateOpener = page.locator('[data-open-dialog="rkDlg"]');
    await expect(regenerateOpener).toBeEnabled({ timeout: CRYPTO_WAIT_MS });
    dialog = await openDialog(ctx, regenerateOpener);
    await expect(dialog.locator('[data-view="rk-reauth"]')).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, dialogSpec('settings-rk-regenerate-reauth'), '[role="dialog"]', { trap: true });
    await closeBothWays(ctx, dialog, regenerateOpener, CANCEL_BUTTON, 'escape');

    log('settings rotate dialog');
    const rotateOpener = page.locator('[data-open-dialog="rotateDlg"]');
    dialog = await openDialog(ctx, rotateOpener);
    await expect(dialog.locator('[data-view="rot-reauth"]')).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, dialogSpec('settings-rk-rotate-reauth'), '[role="dialog"]', { trap: true });
    await fillSecretVerified(dialog.locator('#rot-reauth-pwd'), PASSWORD);
    await activate(ctx, dialog.getByRole('button', { name: /^(Continue|Tiếp tục)$/ }));
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

    log('settings reset dialog');
    const resetOpener = page.locator('[data-open-dialog="resetDlg"]');
    dialog = await openDialog(ctx, resetOpener);
    await expect(dialog.locator('[data-view="rst-s1"]')).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, dialogSpec('settings-reset-step1'), '[role="dialog"]', { trap: true });
    await dialog.getByRole('button', { name: /^(None of these work|Không đường nào dùng được)$/ }).click();
    await expect(dialog.locator('[data-view="rst-s2"]')).toBeVisible({ timeout: UI_WAIT_MS });
    await dialog.getByRole('button', { name: /^(Checked backups|Đã kiểm tra backup)$/ }).click();
    await expect(dialog.locator('[data-view="rst-s3"]')).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, dialogSpec('settings-reset-reauth'), '[role="dialog"]', { trap: true });
    // The reset is never confirmed. Escape from step 3; the keyboard group reopens at step 1 and uses "Later".
    await closeBothWays(ctx, dialog, resetOpener, LATER_BUTTON, 'escape');

    log('settings add-passkey dialog');
    const passkeyOpener = page.locator('[data-testid="settings-passkey-card"] button');
    dialog = await openDialog(ctx, passkeyOpener);
    await expect(dialog.locator('input[type="password"]')).toBeVisible({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, dialogSpec('settings-passkey-reauth'), '[role="dialog"]', { trap: true });
    const passkeyReauthed = page.waitForResponse((r) => isApiPost(r, '/api/v1/auth/reauth'), { timeout: UI_WAIT_MS });
    await fillSecret(dialog.locator('input[type="password"]'), PASSWORD, UI_WAIT_MS);
    await activate(ctx, dialog.getByRole('button', { name: /^(Confirm|Xác nhận)$/ }));
    expect((await passkeyReauthed).ok()).toBe(true);
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0, { timeout: UI_WAIT_MS });
    await expect(dialog.getByRole('button', { name: /^(Continue|Tiếp tục)$/ })).toBeEnabled({ timeout: UI_WAIT_MS });
    await checkScreen(ctx, dialogSpec('settings-passkey-name'), '[role="dialog"]', { trap: true });
    // Nothing is registered: no authenticator is attached and Continue is never pressed.
    await closeBothWays(ctx, dialog, passkeyOpener, CANCEL_BUTTON, 'button');

    log('done');
  } finally {
    await context.close();
  }
}

test.describe('P03-T23 vault a11y sweep (U3/U4/U5/U7, J1)', () => {
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  test('en and vi x light and dark x 390/768/1440: axe, overflow, screenshots; keyboard, focus and reduced motion', async ({
    browser,
  }, testInfo) => {
    // Four groups run concurrently (one browser context each): each does 19 screen states x 3 widths plus four Argon2id
    // derives on a shared CI runner. Target is <= 6 min wall clock; 7 min is the hard cap before the first retry.
    test.setTimeout(420_000);

    const groups = A11Y_LANGS.flatMap((lang) => A11Y_THEMES.map((theme) => ({ lang, theme })));
    const outcomes = await Promise.allSettled(
      groups.map(({ lang, theme }) => runGroup(browser, testInfo, lang, theme)),
    );
    const failures = outcomes.flatMap((outcome, index) =>
      outcome.status === 'rejected'
        ? [`${groups[index].lang}-${groups[index].theme}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`]
        : [],
    );
    // Every group's failure is reported, not only the first.
    expect(failures, failures.join('\n---\n')).toEqual([]);
  });
});
