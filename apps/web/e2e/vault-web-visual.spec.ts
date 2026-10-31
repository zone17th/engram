import { expect, test, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * P03-T16 visual captures for AC VISUAL: onboarding (U3), unlock (U4), forgot-passphrase and recovery,
 * compared later with `mockups/onboarding.html`, `unlock.html` and `recovery.html`.
 *
 * State is seeded exactly like `vault-onboarding.spec.ts`, `vault-unlock.spec.ts` and `recovery.spec.ts`: context-level
 * API mocks plus the real Argon2id/AEAD Worker and the committed js-v1 crypto vectors. Nothing here is a real secret,
 * and every frame still masks (Playwright `mask:`) each input that has content and every recovery-key cell.
 */
const THEMES = ['light', 'dark'] as const;
const WIDTHS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const;

const STEP_TIMEOUT = 15_000;
const CRYPTO_STEP_TIMEOUT = 45_000;

const STRONG_PASSPHRASE = 'Tràm-Hương-94!Kỷ-Vật-Xanh';
const WRONG_PASSPHRASE = 'wrong-passphrase-in-fresh-context';
const REAUTH_PASSWORD = 'login-password-123';

/** `packages/crypto-vectors/vectors/js-v1.json`, same values as `vault-unlock.spec.ts` and `recovery.spec.ts`. */
const TEST_VECTOR_VAULT_KEY_ID = 'vk:7f3a9b2c4d5e6f7a8b9c0d';
const TEST_VECTOR_KDF = {
  alg: 'argon2id13' as const,
  ops: 3,
  mem: 67_108_864,
  parallelism: 1 as const,
  salt: 'oKGio6SlpqeoqaqrrK2urw',
};
const TEST_VECTOR_WRAPPED_VK =
  'AbCxsrO0tba3uLm6u7y9vr_AwcLDxMXGxyfYfNv-vuDRS6i3Up5z_wCEX2cLt1xXgujuY7dGa_eirv2y5QQSBXkKR95PrK-ilA';
const TEST_VECTOR_WRAPPED_PRIV =
  'AeDh4uPk5ebn6Onq6-zt7u_w8fLz9PX299I6ypcubNr8Ofy8RwtQE-3gVPZ1cTrHgeO1ZMoyFkOJgqz7gG75ofa4qHejTdUrskM0hqoPmKH-rt_ZLSoHn2BH9MF-TUGyovpu_punj7v-';
const TEST_VECTOR_RK_DISPLAY = 'rk1_014D-2PF2-DBSQ-QG28-T5CY-4TQK-FF';
const TEST_VECTOR_RK_WRAP =
  'AcDBwsPExcbHyMnKy8zNzs_Q0dLT1NXW18dWA3zmQXAPuHHij0feHrlM3pVUBUhmQ3zog3pdtAPVR3sl2xkLHUk5qkxO2bwUUQ';

type Theme = (typeof THEMES)[number];
type ViewportWidth = (typeof WIDTHS)[number]['width'];
type VaultStatus = 'absent' | 'present';

let accountSeq = 0;

function logStep(label: string, step: string) {
  console.log(`[vault-web-visual][${label}] ${step}`);
}

async function installApiMocks(context: BrowserContext, theme: Theme, vaultStatus: VaultStatus) {
  accountSeq += 1;
  const origin = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:3000').origin;
  // One synthetic account per test; the mock is the only identity the page ever sees.
  const userId = `00000000-0000-4000-8000-${String(accountSeq).padStart(12, '0')}`;
  const email = `vault-web-visual-${accountSeq}@example.test`;

  await context.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
  await context.addCookies([
    { name: 'sabk_locale', value: 'en', url: `${origin}/` },
    { name: 'sabk_theme', value: theme, url: `${origin}/` },
    { name: 'sabk_csrf', value: 'test-csrf-token', url: `${origin}/` },
  ]);

  await context.route('**/api/v1/auth/csrf', async (route) => {
    await route.fulfill({
      status: 204,
      headers: { 'set-cookie': 'sabk_csrf=test-csrf-token; Path=/; SameSite=Lax' },
    });
  });

  await context.route('**/api/v1/auth/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        oauth_providers: [],
        email_verification_required: false,
        captcha_site_key: null,
      }),
    });
  });

  await context.route('**/api/v1/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: userId, email, email_verified: true, created_at: '2026-10-29T00:00:00Z' },
        settings: { locale: 'en', theme, auto_lock_minutes: 15, semantic_suggest: false },
        identities: [{ provider: 'password', linked_at: '2026-10-29T00:00:00Z' }],
        features: {
          semantic_available: false,
          email_verification_required: false,
          oauth_providers: [],
          oauth_reauth_providers: [],
          password_enrollment_available: false,
          captcha_site_key: null,
        },
        vault: { status: vaultStatus },
      }),
    });
  });

  await context.route('**/api/v1/readyz', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', semantic_available: false }),
    });
  });

  await context.route('**/api/v1/auth/reauth', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { action?: string };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        grant: `grant-${body.action ?? 'action'}-token`,
        action: body.action ?? 'action',
        expires_at: new Date(Date.now() + 300 * 1000).toISOString(),
      }),
    });
  });

  await context.route('**/api/v1/vault', async (route) => {
    if (vaultStatus === 'absent') {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'https://engram.zone17.click/problems/vault_absent',
          title: 'vault_absent',
          status: 404,
          code: 'vault_absent',
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: 1,
        vault_key_id: TEST_VECTOR_VAULT_KEY_ID,
        kdf: TEST_VECTOR_KDF,
        vault_key_wrapped_by_kek: TEST_VECTOR_WRAPPED_VK,
        x25519_public: 'EIT5fcwxJb3Sw8y-V9yHL-JGU5pDVlgw9H5ueCV7OnI',
        ed25519_public: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
        private_keys_wrapped: TEST_VECTOR_WRAPPED_PRIV,
        recovery_keys_remaining: 9,
        passkeys: [],
      }),
    });
  });

  await context.route('**/api/v1/vault/unlock/recovery', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ recovery_key_id: 'rk-id-slot-1', slot: 1, wrap: TEST_VECTOR_RK_WRAP }),
    });
  });

  let vaultVersion = 1;
  await context.route('**/api/v1/vault/recover/complete', async (route) => {
    vaultVersion += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: vaultVersion }),
    });
  });

  await context.route('**/api/v1/vault/recovery-keys', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ remaining: 9, empty_slots: [1] }),
    });
  });

  await context.route('**/api/v1/vault/recovery-keys/regenerate', async (route) => {
    vaultVersion += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: vaultVersion, remaining: 10 }),
    });
  });
}

/** A retried fill: the SSR input is visible before React hydrates, and hydration resets a controlled value. */
async function fillStable(input: Locator, value: string) {
  await expect(async () => {
    await input.fill(value);
    await expect(input).toHaveValue(value, { timeout: 2_000 });
  }).toPass({ timeout: STEP_TIMEOUT });
}

async function prepare(page: Page, theme: Theme, width: ViewportWidth, height: number) {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
}

async function gotoRoute(page: Page, route: string, theme: Theme) {
  await page.goto(route, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT });
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: STEP_TIMEOUT });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en', { timeout: STEP_TIMEOUT });
}

async function settleForCapture(page: Page, theme: Theme) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: STEP_TIMEOUT });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}',
  });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  // Two frames so the style tag and any pending layout have been painted before the screenshot.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/**
 * Tag every text-like input that holds a value so it is masked in the frame (masking beats blanking for filled
 * fields); empty inputs stay unmasked so the blank field still matches the mockup.
 */
async function tagFilledInputs(page: Page) {
  await page.evaluate(() => {
    for (const input of document.querySelectorAll<HTMLInputElement>('input')) {
      if (input.type === 'checkbox' || input.type === 'radio' || input.type === 'hidden') continue;
      if (input.value !== '') input.setAttribute('data-visual-mask', 'true');
      else input.removeAttribute('data-visual-mask');
    }
  });
}

async function capture(
  page: Page,
  testInfo: TestInfo,
  state: string,
  theme: Theme,
  width: ViewportWidth,
  extraMasks: Locator[] = [],
) {
  await settleForCapture(page, theme);
  await tagFilledInputs(page);
  const fileName = `vault-web-${state}-${theme}-${width}.png`;
  const outputPath = testInfo.outputPath(fileName);
  mkdirSync(dirname(outputPath), { recursive: true });
  const buffer = await page.screenshot({
    path: outputPath,
    timeout: STEP_TIMEOUT,
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
    mask: [page.locator('[data-visual-mask]'), ...extraMasks],
  });
  expect(buffer.byteLength).toBeGreaterThan(0);
}

function recoveryKeyCells(page: Page): Locator {
  return page.locator('[data-testid^="recovery-key-slot-"]');
}

test.describe('P03-T16 Vault web visual captures (AC VISUAL)', () => {
  for (const theme of THEMES) {
    for (const viewport of WIDTHS) {
      const label = `${theme}-${viewport.width}`;

      test(`onboarding step 1 and RK sheet (${label})`, async ({ context, page }, testInfo) => {
        test.setTimeout(120_000);
        await installApiMocks(context, theme, 'absent');
        await prepare(page, theme, viewport.width, viewport.height);

        logStep(label, 'onboarding step 1');
        await gotoRoute(page, '/app/onboarding', theme);
        await expect(page.getByTestId('onboarding-step-passphrase')).toBeVisible({ timeout: STEP_TIMEOUT });
        const passphrase = page.getByLabel('Passphrase', { exact: true });
        const confirm = page.getByLabel('Confirm passphrase');
        await fillStable(passphrase, STRONG_PASSPHRASE);
        await fillStable(confirm, STRONG_PASSPHRASE);
        await expect(page.getByTestId('passphrase-strength-bar')).toBeVisible({ timeout: STEP_TIMEOUT });
        await expect(page.getByTestId('passphrase-strength-label')).toBeVisible({ timeout: STEP_TIMEOUT });
        // (a) strength meter visible, both passphrase fields masked
        await capture(page, testInfo, 'onboarding-step1', theme, viewport.width);

        logStep(label, 'onboarding step 2');
        await page.getByTestId('onboarding-continue-button').click({ timeout: STEP_TIMEOUT });
        await expect(page.getByTestId('onboarding-step-recovery-keys')).toBeVisible({
          timeout: CRYPTO_STEP_TIMEOUT,
        });
        await expect(page.getByTestId('recovery-keys-grid')).toBeVisible({ timeout: STEP_TIMEOUT });
        const cells = recoveryKeyCells(page);
        await expect(cells).toHaveCount(10, { timeout: STEP_TIMEOUT });
        await expect(page.getByTestId('onboarding-screenshot-warning')).toBeVisible({ timeout: STEP_TIMEOUT });
        await expect(page.getByTestId('recovery-keys-confirm-checkbox')).toBeVisible({ timeout: STEP_TIMEOUT });
        // (b) RK grid sheet with the screenshot warning and the confirm checkbox, every RK cell masked
        await capture(page, testInfo, 'onboarding-rk-sheet', theme, viewport.width, [cells]);
        // No POST /vault is mocked for success: the flow stops here, nothing is submitted.
      });

      test(`unlock empty, incorrect passphrase and forgot-passphrase (${label})`, async ({ context, page }, testInfo) => {
        test.setTimeout(120_000);
        await installApiMocks(context, theme, 'present');
        await prepare(page, theme, viewport.width, viewport.height);

        logStep(label, 'unlock empty');
        await gotoRoute(page, '/app/unlock', theme);
        await expect(page.getByTestId('vault-unlock-page')).toBeVisible({ timeout: STEP_TIMEOUT });
        const input = page.getByTestId('unlock-passphrase-input');
        await expect(input).toBeVisible({ timeout: STEP_TIMEOUT });
        await expect(input).toHaveValue('');
        // (c) U4 with an empty passphrase field
        await capture(page, testInfo, 'unlock-empty', theme, viewport.width);

        logStep(label, 'unlock incorrect passphrase');
        await fillStable(input, WRONG_PASSPHRASE);
        await page.getByTestId('unlock-submit-button').click({ timeout: STEP_TIMEOUT });
        const error = page.getByTestId('unlock-error-incorrect-passphrase');
        await expect(error).toBeVisible({ timeout: CRYPTO_STEP_TIMEOUT });
        await expect(error).toContainText('Incorrect passphrase');
        await expect(input).toHaveValue('');
        await expect(input).toBeEnabled({ timeout: STEP_TIMEOUT });
        // (d) incorrect-passphrase error state (the field is cleared by the page; any residue would be masked)
        await capture(page, testInfo, 'unlock-incorrect', theme, viewport.width);

        logStep(label, 'forgot passphrase');
        await page.getByTestId('unlock-forgot-passphrase-link').click({ timeout: STEP_TIMEOUT });
        await expect(page).toHaveURL(/\/app\/unlock\/forgot$/, { timeout: STEP_TIMEOUT });
        await expect(page.getByTestId('forgot-passphrase-page')).toBeVisible({ timeout: STEP_TIMEOUT });
        // (e) forgot-passphrase page
        await capture(page, testInfo, 'forgot-passphrase', theme, viewport.width);
      });

      test(`recovery steps (${label})`, async ({ context, page }, testInfo) => {
        test.setTimeout(150_000);
        await installApiMocks(context, theme, 'present');
        await prepare(page, theme, viewport.width, viewport.height);

        logStep(label, 'recovery reauth');
        await gotoRoute(page, '/app/recovery', theme);
        await expect(page.getByTestId('recovery-step-reauth')).toBeVisible({ timeout: STEP_TIMEOUT });
        await capture(page, testInfo, 'recovery-reauth', theme, viewport.width);

        await fillStable(page.getByTestId('recovery-reauth-password-input'), REAUTH_PASSWORD);
        await page.getByTestId('recovery-reauth-password-submit').click({ timeout: STEP_TIMEOUT });

        logStep(label, 'recovery paste-RK step');
        await expect(page.getByTestId('recovery-step-enter-key')).toBeVisible({ timeout: STEP_TIMEOUT });
        const keyInput = page.getByTestId('recovery-key-input');
        await expect(keyInput).toHaveValue('');
        // (f) paste-RK step with a blank input
        await capture(page, testInfo, 'recovery-enter-key', theme, viewport.width);

        await fillStable(keyInput, TEST_VECTOR_RK_DISPLAY);
        await page.getByTestId('recovery-key-submit').click({ timeout: STEP_TIMEOUT });

        logStep(label, 'recovery new-passphrase step');
        await expect(page.getByTestId('recovery-step-new-passphrase')).toBeVisible({
          timeout: CRYPTO_STEP_TIMEOUT,
        });
        await fillStable(page.getByTestId('recovery-new-passphrase-input'), STRONG_PASSPHRASE);
        await fillStable(page.getByTestId('recovery-confirm-passphrase-input'), STRONG_PASSPHRASE);
        await expect(page.getByTestId('recovery-passphrase-strength-label')).toBeVisible({ timeout: STEP_TIMEOUT });
        // new-passphrase step, both passphrase fields masked
        await capture(page, testInfo, 'recovery-new-passphrase', theme, viewport.width);

        await page.getByTestId('recovery-step3-submit').click({ timeout: STEP_TIMEOUT });

        logStep(label, 'recovery suggest-regenerate step');
        await expect(page.getByTestId('recovery-step-regenerate-reauth')).toBeVisible({
          timeout: CRYPTO_STEP_TIMEOUT,
        });
        await capture(page, testInfo, 'recovery-regenerate-reauth', theme, viewport.width);

        await fillStable(page.getByTestId('recovery-step4-reauth-password-input'), REAUTH_PASSWORD);
        await page.getByTestId('recovery-step4-reauth-password-submit').click({ timeout: STEP_TIMEOUT });

        logStep(label, 'recovery regenerate keys step');
        await expect(page.getByTestId('recovery-step-regenerate-keys')).toBeVisible({
          timeout: CRYPTO_STEP_TIMEOUT,
        });
        const cells = recoveryKeyCells(page);
        await expect(cells).toHaveCount(1, { timeout: STEP_TIMEOUT });
        // regenerated key sheet, the replacement RK cell masked; the flow is not saved/confirmed
        await capture(page, testInfo, 'recovery-regenerate-keys', theme, viewport.width, [cells]);
      });
    }
  }
});
