import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * P03-T21 visual captures for AC VISUAL: the U5 locked list and locked item page (+ vault pill), compared later with
 * `mockups/index.html` and `mockups/item.html` in their locked state. Same seeding as `vault-web-visual.spec.ts`:
 * context-level API mocks, vault `present`, a fresh context so the vault is locked. Nothing in these frames is secret:
 * names/tags are the public demo metadata and every body is the `🔒 ••••••` mask.
 */
const THEMES = ['light', 'dark'] as const;
const WIDTHS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const;
const STEP_TIMEOUT = 15_000;
const DEMO_ITEM_ID = 'd1';

type Theme = (typeof THEMES)[number];
type ViewportWidth = (typeof WIDTHS)[number]['width'];

async function installApiMocks(context: BrowserContext, theme: Theme) {
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

async function prepare(page: Page, theme: Theme, width: ViewportWidth, height: number) {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
}

async function gotoLocked(page: Page, route: string, theme: Theme) {
  await page.goto(route, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT });
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: STEP_TIMEOUT });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en', { timeout: STEP_TIMEOUT });
  await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: STEP_TIMEOUT });
  await expect(page.getByTestId('entry-body-locked').first()).toBeVisible({ timeout: STEP_TIMEOUT });
  await expect(page.getByTestId('entry-body')).toHaveCount(0);
}

async function capture(page: Page, testInfo: TestInfo, state: string, theme: Theme, width: ViewportWidth) {
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

test.describe('P03-T21 Locked state U5 visual captures (AC VISUAL)', () => {
  for (const theme of THEMES) {
    for (const viewport of WIDTHS) {
      const label = `${theme}-${viewport.width}`;

      test(`locked list (${label})`, async ({ context, page }, testInfo) => {
        test.setTimeout(90_000);
        await installApiMocks(context, theme);
        await prepare(page, theme, viewport.width, viewport.height);
        await gotoLocked(page, '/app', theme);
        await expect(page.locator('.vault-pill, [data-vault-state="locked"]').first()).toBeAttached();
        await capture(page, testInfo, 'locked-list', theme, viewport.width);
      });

      test(`locked item (${label})`, async ({ context, page }, testInfo) => {
        test.setTimeout(90_000);
        await installApiMocks(context, theme);
        await prepare(page, theme, viewport.width, viewport.height);
        await gotoLocked(page, `/app/items/${DEMO_ITEM_ID}`, theme);
        await capture(page, testInfo, 'locked-item', theme, viewport.width);
      });
    }
  }
});
