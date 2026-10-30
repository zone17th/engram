import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { uniqueEmail } from './helpers';
import {
  CRYPTO_WAIT_MS,
  FLOW_TIMEOUT_MS,
  UI_WAIT_MS,
  addAuthenticator,
  addDialog,
  enableWebAuthn,
  expectPasskeyAdded,
  gotoSettings,
  lockVault,
  openAddPasskeyDialog,
  signupAndCreateVault,
  submitPasskeyName,
} from './vault-passkey-support';

// Passkey visual captures (P03-T19 AC VISUAL, advisor-dec-043 pattern): the passkey unlock card on /app/unlock and the
// Add-passkey dialog (name step), light + dark x 390 + 1440, against the real stack and a real virtual authenticator.
// Files land in test-results and reach CI artifacts only through the allowlist block in
// scripts/sanitize-e2e-artifacts.mjs.
//
// No secret is in any frame: the passphrase and the login password are typed with fillSecret() at times when no
// capture happens, the recovery key is never read, the re-auth password field is gone before the dialog is captured,
// and every input that holds a value is masked anyway.

const THEMES = ['light', 'dark'] as const;
const WIDTHS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const;

type Theme = (typeof THEMES)[number];
type ViewportWidth = (typeof WIDTHS)[number]['width'];

async function settleForCapture(page: Page, theme: Theme) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: UI_WAIT_MS });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}',
  });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  // Two frames so the style tag and any pending layout have been painted before the screenshot.
  await page.evaluate(() => {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    return promise;
  });
}

async function capture(
  page: Page,
  testInfo: TestInfo,
  state: 'unlock-card' | 'add-dialog',
  theme: Theme,
  width: ViewportWidth,
  fullPage: boolean,
) {
  await settleForCapture(page, theme);
  await page.evaluate(() => {
    for (const input of document.querySelectorAll<HTMLInputElement>('input')) {
      if (input.type === 'checkbox' || input.type === 'radio' || input.type === 'hidden') continue;
      if (input.value !== '') input.setAttribute('data-visual-mask', 'true');
      else input.removeAttribute('data-visual-mask');
    }
  });
  const outputPath = testInfo.outputPath(`vault-passkey-${state}-${theme}-${width}.png`);
  mkdirSync(dirname(outputPath), { recursive: true });
  const buffer = await page.screenshot({
    path: outputPath,
    timeout: UI_WAIT_MS,
    fullPage,
    animations: 'disabled',
    caret: 'hide',
    mask: [page.locator('[data-visual-mask]')],
  });
  expect(buffer.byteLength).toBeGreaterThan(0);
}

async function setViewport(page: Page, viewport: (typeof WIDTHS)[number]) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
}

async function expectNameStep(dialog: Locator) {
  await expect(dialog.getByLabel('Passkey name')).toBeVisible({ timeout: UI_WAIT_MS });
  await expect(dialog.getByLabel('Login password')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Continue' })).toBeEnabled();
}

test.describe('passkey visual captures (AC VISUAL)', () => {
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  for (const theme of THEMES) {
    test(`Add-passkey dialog and passkey unlock card (${theme})`, async ({ page, context }, testInfo) => {
      test.setTimeout(FLOW_TIMEOUT_MS);
      const origin = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:3000').origin;
      await context.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
      await context.addCookies([
        { name: 'sabk_locale', value: 'en', url: `${origin}/` },
        { name: 'sabk_theme', value: theme, url: `${origin}/` },
      ]);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      const cdp = await enableWebAuthn(page);
      await addAuthenticator(cdp, { hasPrf: true });

      await signupAndCreateVault(page, `vault-passkey-visual-${theme}`, uniqueEmail);

      const [mobile, desktop] = WIDTHS;

      // Dialog, name step, desktop; then the credential is registered so the unlock card has a passkey to show.
      await setViewport(page, desktop);
      await gotoSettings(page);
      let dialog = await openAddPasskeyDialog(page);
      await expectNameStep(dialog);
      await capture(page, testInfo, 'add-dialog', theme, desktop.width, false);
      await submitPasskeyName(page, 'Work laptop');
      await expectPasskeyAdded(page);

      // Dialog, name step, mobile.
      await setViewport(page, mobile);
      dialog = await openAddPasskeyDialog(page);
      await expectNameStep(dialog);
      await capture(page, testInfo, 'add-dialog', theme, mobile.width, false);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(addDialog(page)).toBeHidden({ timeout: UI_WAIT_MS });

      // Unlock card, mobile then desktop.
      await lockVault(page);
      await expect(page.getByTestId('unlock-passkey-section')).toBeVisible({ timeout: UI_WAIT_MS });
      await capture(page, testInfo, 'unlock-card', theme, mobile.width, true);
      await setViewport(page, desktop);
      await expect(page.getByTestId('unlock-passkey-section')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
      await capture(page, testInfo, 'unlock-card', theme, desktop.width, true);
    });
  }
});
