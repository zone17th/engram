import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const PAGES = [
  { name: 'landing-en', path: '/' },
  { name: 'landing-vi', path: '/vi' },
  { name: 'app', path: '/app' },
] as const;

const THEMES = ['light', 'dark'] as const;

async function waitForTheme(page: Page, theme: string) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

test.describe('P01 browser smoke', () => {
  for (const pageRoute of PAGES) {
    for (const theme of THEMES) {
      test(`${pageRoute.name} renders at ${theme} without overflow or axe violations`, async ({ page }, testInfo) => {
        const pageErrors: Error[] = [];
        page.on('pageerror', (error) => pageErrors.push(error));
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(pageRoute.path, { waitUntil: 'networkidle' });
        await waitForTheme(page, theme);

        const overflow = await page.evaluate(() => {
          const root = document.documentElement;
          return root.scrollWidth - root.clientWidth;
        });
        expect(overflow, `${pageRoute.path} overflows by ${overflow}px`).toBeLessThanOrEqual(0);

        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
        expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
        expect(pageErrors, `${pageRoute.path} emitted browser errors`).toEqual([]);

        // Keep screenshots as reviewable CI artifacts; golden baselines are OS-sensitive.
        const screenshot = await page.screenshot({
          path: testInfo.outputPath(`${pageRoute.name}-${theme}.png`),
          fullPage: true,
        });
        expect(screenshot.byteLength).toBeGreaterThan(0);
      });
    }
  }

  test('canonical marketing routes and app route stay on one origin', async ({ request, baseURL }) => {
    const canonicalEnglish = await request.get('/en?from=e2e&q=hello%20world', { maxRedirects: 0 });
    expect(canonicalEnglish.status()).toBe(307);
    const location = canonicalEnglish.headers().location;
    expect(location).toBeTruthy();
    const redirectUrl = new URL(location!, baseURL);
    expect(redirectUrl.origin).toBe(new URL(baseURL!).origin);
    expect(redirectUrl.pathname).toBe('/');
    expect(Array.from(redirectUrl.searchParams.entries())).toEqual([
      ['from', 'e2e'],
      ['q', 'hello world'],
    ]);

    const root = await request.get('/');
    expect(root.status()).toBe(200);
    expect(new URL(root.url()).pathname).toBe('/');

    const vi = await request.get('/vi');
    expect(vi.status()).toBe(200);
    expect(new URL(vi.url()).pathname).toBe('/vi');

    const app = await request.get('/app');
    expect(app.status()).toBe(200);
    expect(new URL(app.url()).pathname).toBe('/app');

    expect(new URL(root.url()).origin).toBe(baseURL);
    expect(new URL(vi.url()).origin).toBe(baseURL);
    expect(new URL(app.url()).origin).toBe(baseURL);
  });

  test('root marketing route stays English despite Vietnamese locale hints', async ({ request }) => {
    const variants: Array<{ name: string; headers: Record<string, string> }> = [
      {
        name: 'Accept-Language',
        headers: { 'accept-language': 'vi-VN,vi;q=0.9' },
      },
      {
        name: 'NEXT_LOCALE cookie',
        headers: { cookie: 'NEXT_LOCALE=vi' },
      },
    ];

    for (const variant of variants) {
      const root = await request.get('/', { headers: variant.headers });
      expect(root.status(), variant.name).toBe(200);
      const html = await root.text();
      expect(html, variant.name).toContain('<html lang="en"');
      expect(html, variant.name).toContain('Type one word you still remember.');
    }
  });

  test('same-origin health proxy is available when the stack is running', async ({ request }) => {
    test.skip(!process.env.E2E_STACK, 'requires the Compose API');

    const health = await request.get('/api/v1/healthz');
    expect(health.status()).toBe(200);
    await expect(health).toBeOK();
    await expect(health.json()).resolves.toMatchObject({ status: 'ok' });

    const rootHealth = await request.get('/healthz');
    expect(rootHealth.status()).toBe(404);
  });

  test('landing demo stays local while supporting keyboard selection', async ({ page, baseURL }) => {
    const outbound: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin !== new URL(baseURL!).origin || url.pathname.startsWith('/api/')) {
        outbound.push(request.url());
      }
    });

    await page.goto('/');
    const input = page.getByRole('combobox', { name: 'Search sample notes' });
    // P04 uipolish UIA-5/24: the hero searches the landing-local en fixture (mockup seed "wif");
    // the first option is the tag row of the Tags group.
    await input.fill('wif');
    await input.press('ArrowDown');
    await expect(page.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await input.press('Enter');
    await expect(page.getByRole('status')).toContainText('Selected #wifi-guest');
    expect(outbound).toEqual([]);
  });

  test('theme preference hydrates and persists across reloads', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByRole('button', { name: 'Toggle light/dark theme' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
