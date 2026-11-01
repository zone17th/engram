import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { expectSignedIn, fillSecret, signupViaUi, uniqueEmail, verifyRequired, waitForAuthPageReady } from './helpers';

type AuthPageCapture = {
  name: string;
  path: string;
  locale: 'en' | 'vi';
  mailAvailable?: boolean;
  action?: 'signup-mismatch' | 'forgot-sent';
};

const DUMMY_RESET_TOKEN = 'x'.repeat(43);

const AUTH_PAGES: readonly AuthPageCapture[] = [
  { name: 'login-en', path: '/app/auth/login', locale: 'en' },
  { name: 'login-vi', path: '/app/auth/login', locale: 'vi' },
  { name: 'signup-en', path: '/app/auth/signup', locale: 'en' },
  { name: 'signup-vi', path: '/app/auth/signup', locale: 'vi' },
  { name: 'login-reset-done-en', path: '/app/auth/login?reset=done', locale: 'en' },
  { name: 'login-reset-done-vi', path: '/app/auth/login?reset=done', locale: 'vi' },
  { name: 'signup-mismatch-en', path: '/app/auth/signup', locale: 'en', action: 'signup-mismatch' },
  { name: 'signup-mismatch-vi', path: '/app/auth/signup', locale: 'vi', action: 'signup-mismatch' },
  { name: 'forgot-en', path: '/app/auth/forgot-password', locale: 'en', mailAvailable: true },
  { name: 'forgot-vi', path: '/app/auth/forgot-password', locale: 'vi', mailAvailable: true },
  { name: 'forgot-sent-en', path: '/app/auth/forgot-password', locale: 'en', mailAvailable: true, action: 'forgot-sent' },
  { name: 'forgot-sent-vi', path: '/app/auth/forgot-password', locale: 'vi', mailAvailable: true, action: 'forgot-sent' },
  { name: 'forgot-unavailable-en', path: '/app/auth/forgot-password', locale: 'en', mailAvailable: false },
  { name: 'forgot-unavailable-vi', path: '/app/auth/forgot-password', locale: 'vi', mailAvailable: false },
  { name: 'reset-en', path: `/app/auth/reset-password#token=${DUMMY_RESET_TOKEN}`, locale: 'en' },
  { name: 'reset-vi', path: `/app/auth/reset-password#token=${DUMMY_RESET_TOKEN}`, locale: 'vi' },
  { name: 'reset-invalid-en', path: '/app/auth/reset-password', locale: 'en' },
  { name: 'reset-invalid-vi', path: '/app/auth/reset-password', locale: 'vi' },
  { name: 'oauth-callback-invalid-en', path: '/app/auth/callback/google?status=invalid_flow', locale: 'en' },
  { name: 'oauth-callback-invalid-vi', path: '/app/auth/callback/google?status=invalid_flow', locale: 'vi' },
  { name: 'terms-en', path: '/terms', locale: 'en' },
  { name: 'terms-vi', path: '/vi/terms', locale: 'vi' },
  { name: 'privacy-en', path: '/privacy', locale: 'en' },
  { name: 'privacy-vi', path: '/vi/privacy', locale: 'vi' },
];

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
        if (route.mailAvailable !== undefined) {
          await page.route('**/api/v1/auth/config', async (r) => {
            await r.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                oauth_providers: ['google'],
                email_verification_required: false,
                captcha_site_key: null,
                mail_delivery_available: route.mailAvailable,
              }),
            });
          });
        }
        if (route.action === 'forgot-sent') {
          await page.route('**/api/v1/auth/password/forgot', async (r) => {
            await r.fulfill({ status: 202, body: '' });
          });
        }
        await setPrefs(page, route.locale, theme);
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(route.path, { waitUntil: 'networkidle' });
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        if (route.path.startsWith('/app/auth/')) {
          await waitForAuthPageReady(page);
        }
        if (route.action === 'signup-mismatch') {
          await page.getByLabel('Email', { exact: true }).fill('visual.mismatch@example.test');
          await fillSecret(
            page.getByLabel(route.locale === 'vi' ? 'Mật khẩu đăng nhập' : 'Login password', { exact: true }),
            'DemoStrengthValue!2026',
          );
          await fillSecret(
            page.getByLabel(route.locale === 'vi' ? 'Nhập lại mật khẩu' : 'Confirm password', { exact: true }),
            'DifferentDemoValue!2026',
          );
          await page.getByRole('checkbox').check();
          await page
            .getByRole('button', { name: route.locale === 'vi' ? 'Tạo tài khoản' : 'Create account', exact: true })
            .click();
          await expect(
            page.getByText(route.locale === 'vi' ? 'Hai mật khẩu không khớp.' : 'Passwords do not match.'),
          ).toBeVisible();
        } else if (route.action === 'forgot-sent') {
          await page.getByRole('textbox', { name: 'Email', exact: true }).fill('visual.forgot@example.test');
          await page.getByRole('button', { name: /Send reset instructions|Gửi hướng dẫn đặt lại/ }).click();
          await expect(page.getByTestId('forgot-sent')).toBeVisible();
        } else if (route.name.startsWith('login-reset-done-')) {
          await expect(page.getByTestId('login-reset-banner')).toBeVisible();
        } else if (route.name === 'forgot-en' || route.name === 'forgot-vi') {
          await expect(page.getByRole('textbox', { name: 'Email', exact: true })).toBeVisible();
          await expect(page.getByTestId('forgot-unavailable')).toHaveCount(0);
        } else if (route.name.startsWith('forgot-unavailable-')) {
          await expect(page.getByTestId('forgot-unavailable')).toBeVisible();
        } else if (route.name === 'reset-en' || route.name === 'reset-vi') {
          await expect(
            page.getByLabel(route.locale === 'vi' ? 'Mật khẩu đăng nhập mới' : 'New login password', { exact: true }),
          ).toBeVisible();
          await expect(page.getByTestId('reset-invalid-token')).toHaveCount(0);
        } else if (route.name.startsWith('reset-invalid-')) {
          await expect(page.getByTestId('reset-invalid-token')).toBeVisible();
        } else if (route.name.startsWith('oauth-callback-invalid-')) {
          await expect(page.getByTestId('oauth-callback-error')).toBeVisible();
        }
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
