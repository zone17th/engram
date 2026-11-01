import { expect, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Shared non-demo helpers for the split P03-T21 locked state specs (`vault-locked-{list,item,search}.spec.ts` and
 * `vault-locked-visual-{list,item}.spec.ts`).
 *
 * Frozen in W3 (P4FE5-3): W3 lanes needing extra helpers add their own `e2e/content-<lane>-support.ts`.
 */
export const TEST_VECTOR_PASSPHRASE = 'correct-horse-battery-staple-engram-js-v1';
export const TEST_VECTOR_KDF = {
  alg: 'argon2id13' as const,
  ops: 3,
  mem: 67_108_864,
  parallelism: 1 as const,
  salt: 'oKGio6SlpqeoqaqrrK2urw',
};
export const TEST_VECTOR_WRAPPED_VK =
  'AbCxsrO0tba3uLm6u7y9vr_AwcLDxMXGxyfYfNv-vuDRS6i3Up5z_wCEX2cLt1xXgujuY7dGa_eirv2y5QQSBXkKR95PrK-ilA';
export const TEST_VECTOR_WRAPPED_PRIV =
  'AeDh4uPk5ebn6Onq6-zt7u_w8fLz9PX299I6ypcubNr8Ofy8RwtQE-3gVPZ1cTrHgeO1ZMoyFkOJgqz7gG75ofa4qHejTdUrskM0hqoPmKH-rt_ZLSoHn2BH9MF-TUGyovpu_punj7v-';
export const TEST_VECTOR_VAULT_KEY_ID = 'vk:7f3a9b2c4d5e6f7a8b9c0d';

export const UI_WAIT_MS = 30_000;
export const CRYPTO_WAIT_MS = 60_000;

export const THEMES = ['light', 'dark'] as const;
export const WIDTHS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const;
export const STEP_TIMEOUT = 15_000;

export type Theme = (typeof THEMES)[number];
export type ViewportWidth = (typeof WIDTHS)[number]['width'];

export async function installApiMocks(context: BrowserContext) {
  await context.route('**/api/v1/**', async (route) => {
    const request = route.request();
    throw new Error(`Unmocked API call in vault-locked spec: ${request.method()} ${request.url()}`);
  });

  const url = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
  await context.addCookies([
    { name: 'sabk_csrf', value: 'test-csrf-token', url },
    { name: 'sabk_locale', value: 'en', url },
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
      body: JSON.stringify({ oauth_providers: [], email_verification_required: false, captcha_site_key: null }),
    });
  });
  await context.route('**/api/v1/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: '22222222-2222-4222-8222-222222222222',
          email: 'vault-locked@example.test',
          email_verified: true,
          created_at: '2026-10-30T00:00:00Z',
        },
        settings: { locale: 'en', theme: 'light', auto_lock_minutes: 15, semantic_suggest: false },
        identities: [{ provider: 'password', linked_at: '2026-10-30T00:00:00Z' }],
        features: {
          semantic_available: false,
          email_verification_required: false,
          oauth_providers: [],
          oauth_reauth_providers: [],
          password_enrollment_available: false,
          captcha_site_key: null,
        },
        vault: { status: 'present' },
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
  await context.route('**/api/v1/vault', async (route) => {
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
        recovery_keys_remaining: 10,
        passkeys: [],
      }),
    });
  });
}

export async function installVisualApiMocks(context: BrowserContext, theme: Theme) {
  await context.route('**/api/v1/**', async (route) => {
    const request = route.request();
    throw new Error(`Unmocked API call in vault-locked-visual spec: ${request.method()} ${request.url()}`);
  });

  const origin = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:3000').origin;
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
      body: JSON.stringify({ oauth_providers: [], email_verification_required: false, captcha_site_key: null }),
    });
  });
  await context.route('**/api/v1/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: '00000000-0000-4000-8000-000000000021',
          email: 'vault-locked-visual@example.test',
          email_verified: true,
          created_at: '2026-10-30T00:00:00Z',
        },
        settings: { locale: 'en', theme, auto_lock_minutes: 15, semantic_suggest: false },
        identities: [{ provider: 'password', linked_at: '2026-10-30T00:00:00Z' }],
        features: {
          semantic_available: false,
          email_verification_required: false,
          oauth_providers: [],
          oauth_reauth_providers: [],
          password_enrollment_available: false,
          captcha_site_key: null,
        },
        vault: { status: 'present' },
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
}

/** Writes a secret into a controlled React input without the value appearing in a Playwright call log (no fill()). */
export async function fillSecret(input: Locator, value: string) {
  await expect(input).toBeEditable({ timeout: CRYPTO_WAIT_MS });
  await input.evaluate((element, next) => {
    const field = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('HTMLInputElement value setter is missing');
    setter.call(field, next);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

/** Where plaintext may never be while locked: any attribute value, `dataset`, visible text, or serialised markup. */
export async function findBodyLeaks(page: Page, bodies: readonly string[]): Promise<string[]> {
  return page.evaluate((needles) => {
    const leaks: string[] = [];
    const nodes = [document.documentElement, ...Array.from(document.querySelectorAll<HTMLElement>('*'))];
    for (const node of nodes) {
      for (const attr of Array.from(node.attributes)) {
        if (needles.some((needle) => attr.value.includes(needle))) {
          leaks.push(`attribute ${attr.name} on <${node.tagName.toLowerCase()}>`);
        }
      }
      for (const [key, value] of Object.entries(node.dataset ?? {})) {
        if (needles.some((needle) => (value ?? '').includes(needle))) leaks.push(`dataset.${key}`);
      }
    }
    const markup = document.documentElement.outerHTML;
    const text = document.body.innerText;
    for (const needle of needles) {
      if (markup.includes(needle)) leaks.push('markup');
      if (text.includes(needle)) leaks.push('text');
    }
    return [...new Set(leaks)];
  }, bodies);
}

export async function unlockFromBanner(page: Page) {
  await page.getByTestId('vault-locked-unlock-cta').click({ timeout: UI_WAIT_MS });
  await expect(page.getByTestId('vault-unlock-page')).toBeVisible({ timeout: UI_WAIT_MS });
  await fillSecret(page.getByTestId('unlock-passphrase-input'), TEST_VECTOR_PASSPHRASE);
  await page.getByTestId('unlock-submit-button').click();
  await expect(page.locator('.vault-pill')).toHaveAttribute('data-vault-state', 'unlocked', {
    timeout: CRYPTO_WAIT_MS,
  });
}

export async function prepare(page: Page, theme: Theme, width: ViewportWidth, height: number) {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
}

export async function gotoLocked(page: Page, route: string, theme: Theme) {
  await page.goto(route, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT });
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: STEP_TIMEOUT });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en', { timeout: STEP_TIMEOUT });
  await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: STEP_TIMEOUT });
  await expect(page.getByTestId('entry-body-locked').first()).toBeVisible({ timeout: STEP_TIMEOUT });
  await expect(page.getByTestId('entry-body')).toHaveCount(0);
}

export async function capture(page: Page, testInfo: TestInfo, state: string, theme: Theme, width: ViewportWidth) {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}',
  });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  const outputPath = testInfo.outputPath(`vault-web-${state}-${theme}-${width}.png`);
  mkdirSync(dirname(outputPath), { recursive: true });
  const buffer = await page.screenshot({
    path: outputPath,
    timeout: STEP_TIMEOUT,
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  });
  expect(buffer.byteLength).toBeGreaterThan(0);
}
