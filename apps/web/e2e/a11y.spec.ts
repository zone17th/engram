import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { expectSignedIn, signupViaUi, uniqueEmail, verifyRequired } from './helpers';

const AUTH_PAGES = [
  { name: 'login-en', path: '/app/auth/login', locale: 'en' },
  { name: 'login-vi', path: '/app/auth/login', locale: 'vi' },
  { name: 'signup-en', path: '/app/auth/signup', locale: 'en' },
] as const;

async function setPrefs(page: Page, locale: 'en' | 'vi', theme: 'light' | 'dark') {
  const url = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
  await page.context().addCookies([
    { name: 'sabk_locale', value: locale, url },
    { name: 'sabk_theme', value: theme, url },
  ]);
}

async function noOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'horizontal overflow').toBeLessThanOrEqual(0);
}

test.describe('P02 a11y', () => {
  for (const route of AUTH_PAGES) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${route.name} ${theme} axe and overflow`, async ({ page }, testInfo) => {
        await setPrefs(page, route.locale, theme);
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(route.path, { waitUntil: 'networkidle' });
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await noOverflow(page);
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
        expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
        const shot = await page.screenshot({
          path: testInfo.outputPath(`${route.name}-${theme}.png`),
          fullPage: true,
        });
        expect(shot.byteLength).toBeGreaterThan(0);
      });
    }
  }

  test('settings account/security keyboard and axe when signed in', async ({ page }, testInfo) => {
    test.skip(!process.env.E2E_STACK, 'requires API');
    test.skip(verifyRequired(), 'settings a11y uses the verification=false job');
    const email = uniqueEmail('a11y');
    await signupViaUi(page, email);
    await expectSignedIn(page);
    await page.goto('/app/settings');
    await expect(page.getByRole('heading', { name: /Account|Tài khoản/ }).first()).toBeVisible();
    await page.keyboard.press('Tab');
    await noOverflow(page);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    const shot = await page.screenshot({
      path: testInfo.outputPath('settings-account.png'),
      fullPage: true,
    });
    expect(shot.byteLength).toBeGreaterThan(0);
  });
});
