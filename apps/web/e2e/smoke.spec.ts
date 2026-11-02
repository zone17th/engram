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

  test('landing locale switch navigates / <-> /vi with query/hash, fits pill without overflow, persists sabk_locale into /app/auth/login, and has 0 header axe violations', async ({
    page,
  }) => {
    const assertNoPillOrPageOverflow = async (label: string) => {
      const metrics = await page.evaluate(() => {
        const root = document.documentElement;
        const nav = document.querySelector<HTMLElement>('nav[aria-label="Primary"]');
        return {
          docOverflow: root.scrollWidth - root.clientWidth,
          navOverflow: nav ? nav.scrollWidth - nav.clientWidth : -1,
        };
      });
      expect(metrics.docOverflow, `${label} document horizontal overflow`).toBeLessThanOrEqual(0);
      expect(metrics.navOverflow, `${label} primary nav horizontal overflow`).toBeLessThanOrEqual(0);
    };

    await page.goto('/?from=smoke#riengtu', { waitUntil: 'networkidle' });
    await assertNoPillOrPageOverflow('landing-en');

    const enGroup = page.getByRole('radiogroup', { name: 'Language' });
    const enRadio = enGroup.getByRole('radio', { name: 'English (EN)' });
    const viRadio = enGroup.getByRole('radio', { name: 'Vietnamese (VI)' });
    await expect(enRadio).toHaveAttribute('aria-checked', 'true');
    await expect(enRadio).toHaveAttribute('data-state', 'on');
    await expect(enRadio).toHaveAttribute('lang', 'en');
    await expect(viRadio).toHaveAttribute('aria-checked', 'false');
    await expect(viRadio).toHaveAttribute('data-state', 'off');
    await expect(viRadio).toHaveAttribute('lang', 'vi');

    const enHeaderAxe = await new AxeBuilder({ page })
      .include('nav[aria-label="Primary"]')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(enHeaderAxe.violations, JSON.stringify(enHeaderAxe.violations, null, 2)).toEqual([]);

    // Toggle dark theme before switching locale to verify sabk_theme=dark survives the [locale] layout navigation (FE1-5)
    await page.getByRole('button', { name: 'Toggle light/dark theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await viRadio.click();
    await expect(page).toHaveURL(/\/vi\?from=smoke#riengtu$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Gõ một từ bạn còn nhớ.');
    await assertNoPillOrPageOverflow('landing-vi');

    const viGroup = page.getByRole('radiogroup', { name: 'Ngôn ngữ' });
    const viActiveRadio = viGroup.getByRole('radio', { name: 'Tiếng Việt (VI)' });
    const enInactiveRadio = viGroup.getByRole('radio', { name: 'English (EN)' });
    await expect(viActiveRadio).toHaveAttribute('aria-checked', 'true');
    await expect(viActiveRadio).toHaveAttribute('data-state', 'on');
    await expect(enInactiveRadio).toHaveAttribute('aria-checked', 'false');
    await expect(enInactiveRadio).toHaveAttribute('data-state', 'off');

    const cookiesAfterVi = await page.context().cookies();
    expect(cookiesAfterVi.find((c) => c.name === 'sabk_locale')?.value).toBe('vi');
    expect(cookiesAfterVi.find((c) => c.name === 'sabk_theme')?.value).toBe('dark');

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page).toHaveURL(/\/vi\?from=smoke#riengtu$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(
      page.getByRole('radiogroup', { name: 'Ngôn ngữ' }).getByRole('radio', { name: 'Tiếng Việt (VI)' }),
    ).toHaveAttribute('aria-checked', 'true');
    await assertNoPillOrPageOverflow('landing-vi-reloaded');

    const viHeaderAxe = await new AxeBuilder({ page })
      .include('nav[aria-label="Primary"]')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(viHeaderAxe.violations, JSON.stringify(viHeaderAxe.violations, null, 2)).toEqual([]);

    // Marketing legal route check: /privacy and /vi/privacy under next-intl [locale] routing (FE1-5)
    await page.goto('/vi/privacy#contact', { waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
    await expect(page.getByRole('heading', { level: 1, name: 'Điều khoản & Chính sách bảo mật' })).toBeVisible();
    await page.goto('/privacy#contact', { waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1, name: 'Terms of Service & Privacy Policy' })).toBeVisible();

    // FE1-10: sabk_locale='vi' set on landing is consumed when opening /app/auth/login
    await page.goto('/app/auth/login', { waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
    await expect(page.getByRole('heading', { level: 1, name: 'Đăng nhập' })).toBeVisible();

    // Return to /vi and switch back to EN -> /
    await page.goto('/vi', { waitUntil: 'networkidle' });
    await page.getByRole('radiogroup', { name: 'Ngôn ngữ' }).getByRole('radio', { name: 'English (EN)' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    const cookiesAfterEn = await page.context().cookies();
    expect(cookiesAfterEn.find((c) => c.name === 'sabk_locale')?.value).toBe('en');
  });
});
