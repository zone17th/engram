import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PASSWORD, uniqueEmail } from './helpers';
import {
  CRYPTO_WAIT_MS,
  FLOW_TIMEOUT_MS,
  UI_WAIT_MS,
  VAULT_PASSPHRASE,
  addAuthenticator,
  enableWebAuthn,
  expectPasskeyAdded,
  expectVaultOpen,
  gotoSettings,
  isApiPost,
  lockVault,
  openAddPasskeyDialog,
  removeAuthenticator,
  signupViaUiSecret,
  submitPasskeyName,
} from './vault-passkey-support';
import { fillSecret } from './vault-settings-secret';

// P03-T16B / T17B / T20B visual captures (AC VISUAL, advisor-dec-043 pattern):
// - onboarding step 3 (`onboarding-step-passkey`) -> `vault-b-onboarding-step3-<theme>-<w>.png`
// - forgot-passphrase page with the new 17B paths -> `vault-b-forgot-<theme>-<w>.png`
// - unlock U4 with a long email (CF-T17B-UNLOCK-EMAIL-WRAP visible) -> `vault-b-unlock-long-email-<theme>-<w>.png`
// - Settings security: passkey list with >= 1 passkey -> `vault-b-settings-passkeys-<theme>-<w>.png`
// - Settings auto-lock card -> `vault-b-settings-autolock-<theme>-<w>.png`
//
// All captures run against the real stack (E2E_STACK=1) and a fresh virtual authenticator per theme.
// No secret is in any frame: login password and passphrase are entered via fillSecret() outside capture frames,
// recovery keys are wiped before Step 3 is rendered, and any populated input or recovery-key cell is masked.

const THEMES = ['light', 'dark'] as const;
const WIDTHS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const;

type Theme = (typeof THEMES)[number];
type ViewportWidth = (typeof WIDTHS)[number]['width'];
type CaptureState =
  | 'onboarding-step3'
  | 'forgot'
  | 'unlock-long-email'
  | 'settings-passkeys'
  | 'settings-autolock';

async function settleForCapture(page: Page, theme: Theme, scrollTarget?: Locator) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: UI_WAIT_MS });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}.toast{display:none!important;}',
  });
  if (scrollTarget) {
    await scrollTarget.evaluate((el) => {
      const header = document.querySelector('header');
      const headerHeight = header ? header.getBoundingClientRect().height : 68;
      const rect = el.getBoundingClientRect();
      const targetTop = Math.max(0, window.scrollY + rect.top - headerHeight - 16);
      window.scrollTo({ top: targetTop, behavior: 'instant' });
    });
  } else {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  }
  await page.evaluate(() => {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    return promise;
  });
}

async function capture(
  page: Page,
  testInfo: TestInfo,
  state: CaptureState,
  theme: Theme,
  width: ViewportWidth,
  options: {
    fullPage?: boolean;
    scrollTarget?: Locator;
  } = {},
) {
  await settleForCapture(page, theme, options.scrollTarget);
  await page.evaluate(() => {
    for (const input of document.querySelectorAll<HTMLInputElement>('input')) {
      if (input.type === 'checkbox' || input.type === 'radio' || input.type === 'hidden') continue;
      if (input.value !== '') input.setAttribute('data-visual-mask', 'true');
      else input.removeAttribute('data-visual-mask');
    }
    for (const rk of document.querySelectorAll<HTMLElement>('[data-testid^="recovery-key-slot-"]')) {
      rk.setAttribute('data-visual-mask', 'true');
    }
  });
  const outputPath = testInfo.outputPath(`vault-b-${state}-${theme}-${width}.png`);
  mkdirSync(dirname(outputPath), { recursive: true });
  const buffer = await page.screenshot({
    path: outputPath,
    timeout: UI_WAIT_MS,
    fullPage: options.fullPage ?? false,
    animations: 'disabled',
    caret: 'hide',
    mask: [page.locator('[data-visual-mask]')],
  });
  expect(buffer.byteLength).toBeGreaterThan(0);
}

async function setViewport(page: Page, viewport: (typeof WIDTHS)[number]) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
}

test.describe('vaultb visual captures (AC VISUAL)', () => {
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  for (const theme of THEMES) {
    test(`captures onboarding step 3, forgot paths, unlock email wrap, and settings passkeys + auto-lock (${theme})`, async ({
      page,
      context,
    }, testInfo) => {
      test.setTimeout(FLOW_TIMEOUT_MS);
      const origin = new URL(process.env.BASE_URL ?? 'http://localhost:3000').origin;
      await context.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
      await context.addCookies([
        { name: 'sabk_locale', value: 'en', url: `${origin}/` },
        { name: 'sabk_theme', value: theme, url: `${origin}/` },
      ]);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });

      const cdp = await enableWebAuthn(page);
      const authenticatorId = await addAuthenticator(cdp, { hasPrf: true, isUserVerified: true });

      try {
        const [mobile, desktop] = WIDTHS;
        await setViewport(page, desktop);

        const longPrefix = `vaultb-visual-long-recipient-identifier-for-390px-email-wrap-${theme}`;
        const email = uniqueEmail(longPrefix);
        expect(email.length).toBeGreaterThan(70);

        await signupViaUiSecret(page, email, PASSWORD);
        await expect(page).toHaveURL(/\/app\/onboarding$/, { timeout: UI_WAIT_MS });
        await expect(page.getByTestId('onboarding-step-passphrase')).toBeVisible({
          timeout: CRYPTO_WAIT_MS,
        });

        await fillSecret(
          page.getByLabel('Passphrase', { exact: true }),
          VAULT_PASSPHRASE,
          CRYPTO_WAIT_MS,
        );
        await fillSecret(page.getByLabel('Confirm passphrase'), VAULT_PASSPHRASE, CRYPTO_WAIT_MS);
        await page.getByTestId('onboarding-continue-button').click();

        await expect(page.getByTestId('onboarding-step-recovery-keys')).toBeVisible({
          timeout: CRYPTO_WAIT_MS,
        });
        await page.getByTestId('recovery-keys-confirm-checkbox').check();
        const created = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault'), {
          timeout: CRYPTO_WAIT_MS,
        });
        await page.getByTestId('onboarding-create-vault-button').click();
        expect((await created).ok()).toBe(true);

        // 1. Onboarding step 3 (`onboarding-step-passkey`) — RK cells are already wiped from DOM
        await expect(page.getByTestId('onboarding-step-passkey')).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(page.getByTestId('recovery-keys-grid')).toHaveCount(0);
        await capture(page, testInfo, 'onboarding-step3', theme, desktop.width, { fullPage: true });
        await setViewport(page, mobile);
        await expect(page.getByTestId('onboarding-step-passkey')).toBeVisible({ timeout: UI_WAIT_MS });
        await capture(page, testInfo, 'onboarding-step3', theme, mobile.width, { fullPage: true });

        // Finish onboarding via Skip -> /app unlocked
        await page.getByTestId('onboarding-skip-passkey-button').click({ timeout: UI_WAIT_MS });
        await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
        await expectVaultOpen(page);

        // 2. Settings security: register 1 passkey, then capture passkeys card and auto-lock card
        await setViewport(page, desktop);
        await gotoSettings(page);
        await openAddPasskeyDialog(page);
        await submitPasskeyName(page, 'MacBook Pro · Touch ID');
        await expectPasskeyAdded(page);

        const passkeyCard = page.getByTestId('settings-passkey-card');
        const passkeyList = page.getByTestId('settings-passkey-list');
        const autoLockCard = page.getByTestId('settings-auto-lock-card');
        await expect(passkeyList).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(passkeyList).toContainText('MacBook Pro · Touch ID');
        await expect(autoLockCard).toBeVisible({ timeout: UI_WAIT_MS });

        // Stabilize dynamic created_at date inside the passkey list for deterministic visual review
        await page.evaluate(() => {
          for (const el of document.querySelectorAll<HTMLElement>('[data-testid="settings-passkey-list"] .mono')) {
            const text = el.textContent?.trim() ?? '';
            if (/^(Added|Đã thêm)\s/.test(text)) {
              el.textContent = text.startsWith('Đã thêm') ? 'Đã thêm 12/02/2026' : 'Added 02/12/2026';
            }
          }
        });

        await capture(page, testInfo, 'settings-passkeys', theme, desktop.width, {
          fullPage: false,
          scrollTarget: passkeyCard,
        });
        await capture(page, testInfo, 'settings-autolock', theme, desktop.width, {
          fullPage: false,
          scrollTarget: autoLockCard,
        });

        await setViewport(page, mobile);
        await expect(passkeyList).toBeVisible({ timeout: UI_WAIT_MS });
        await capture(page, testInfo, 'settings-passkeys', theme, mobile.width, {
          fullPage: false,
          scrollTarget: passkeyCard,
        });
        await capture(page, testInfo, 'settings-autolock', theme, mobile.width, {
          fullPage: false,
          scrollTarget: autoLockCard,
        });

        // 3. Unlock U4 with long email (CF-T17B-UNLOCK-EMAIL-WRAP visible) + passkey unlock card
        await lockVault(page);
        const signedInLine = page.getByTestId('unlock-signed-in-line');
        await expect(signedInLine).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(signedInLine).toContainText(email);
        await expect(page.getByTestId('unlock-passkey-section')).toBeVisible({ timeout: UI_WAIT_MS });

        const mobileDimensions = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        expect(mobileDimensions.scrollWidth).toBeLessThanOrEqual(mobileDimensions.innerWidth);

        await capture(page, testInfo, 'unlock-long-email', theme, mobile.width, { fullPage: true });
        await setViewport(page, desktop);
        await expect(page.getByTestId('unlock-passkey-section')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
        await capture(page, testInfo, 'unlock-long-email', theme, desktop.width, { fullPage: true });

        // 4. Forgot-passphrase page with the new 17B paths (passkey, remembered-device, unlocked-tab, recovery-key)
        await page.getByTestId('unlock-forgot-passphrase-link').click({ timeout: UI_WAIT_MS });
        await expect(page).toHaveURL(/\/app\/unlock\/forgot$/, { timeout: UI_WAIT_MS });
        await expect(page.getByTestId('forgot-passphrase-page')).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(page.getByTestId('forgot-path-passkey')).toBeVisible();
        await expect(page.getByTestId('forgot-path-remembered-device')).toBeVisible();
        await expect(page.getByTestId('forgot-path-unlocked-tab')).toBeVisible();
        await expect(page.getByTestId('forgot-path-recovery-key')).toBeVisible();

        await capture(page, testInfo, 'forgot', theme, desktop.width, { fullPage: true });
        await setViewport(page, mobile);
        await expect(page.getByTestId('forgot-passphrase-page')).toBeVisible({ timeout: UI_WAIT_MS });
        await capture(page, testInfo, 'forgot', theme, mobile.width, { fullPage: true });
      } finally {
        await removeAuthenticator(cdp, authenticatorId).catch(() => undefined);
      }
    });
  }
});
