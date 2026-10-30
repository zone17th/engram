import { expect, test } from '@playwright/test';
import {
  cookieMap,
  expectSignedIn,
  isolateRateLimit,
  loginViaUi,
  newContext,
  signupViaUi,
  tokenFromLink,
  uniqueEmail,
  verifyRequired,
  waitForAuthPageReady,
  waitForMail,
  PASSWORD,
} from './helpers';

test.describe.configure({ mode: 'serial' });

test.describe('P02 auth (real API)', () => {
  test.skip(!process.env.E2E_STACK, 'requires API + worker + mail sink');

  // Serial run still shares the loopback IP; give each test its own 5/min cred
  // bucket instead of raising the product quota (plan Task 24).
  test.beforeEach(async ({ page }) => {
    await isolateRateLimit(page);
  });

  test('signup, reload, logout, login', async ({ page, context }) => {
    const email = uniqueEmail('signup');
    await signupViaUi(page, email);
    if (verifyRequired()) {
      await expect(page).toHaveURL(/\/app\/auth\/verify-email/);
    } else {
      await expect(page).toHaveURL(/\/app\/onboarding/);
    }
    await expectSignedIn(page);

    const cookies = await cookieMap(context);
    const session = cookies.get('sabk_session');
    const refresh = cookies.get('sabk_refresh');
    const csrf = cookies.get('sabk_csrf');
    expect(session?.httpOnly, 'access cookie HttpOnly').toBe(true);
    expect(session?.path).toBe('/api');
    expect(refresh?.httpOnly).toBe(true);
    expect(refresh?.path).toBe('/api/v1/auth');
    expect(csrf?.httpOnly).toBe(false);
    expect(csrf?.path).toBe('/');

    // page.request / APIRequestContext drops Secure cookies on http:// — use the page jar.
    const me = await page.evaluate(async () => {
      const res = await fetch('/api/v1/auth/me', { credentials: 'same-origin' });
      return { status: res.status, cache: res.headers.get('cache-control') ?? '' };
    });
    expect(me.status).toBe(200);
    expect(me.cache).toMatch(/no-store/i);

    await page.reload({ waitUntil: 'networkidle' });
    await expectSignedIn(page);

    await page.getByRole('button', { name: /^(Sign out|Đăng xuất)$/ }).click();
    await expect(page).toHaveURL(/\/app\/auth\/login/, { timeout: 15_000 });

    await loginViaUi(page, email);
    if (verifyRequired()) {
      await expect(page).toHaveURL(/\/app\/auth\/verify-email|\/app\/settings/);
    } else {
      await expect(page).toHaveURL(/\/app\/onboarding/);
    }
    await expectSignedIn(page);
  });

  test('recovers after the access cookie is missing while refresh remains', async ({ page, context }) => {
    const email = uniqueEmail('missing-access');
    await signupViaUi(page, email);
    await expectSignedIn(page);

    const before = await context.cookies();
    const refreshBefore = before.find((cookie) => cookie.name === 'sabk_refresh');
    const csrfBefore = before.find((cookie) => cookie.name === 'sabk_csrf');
    expect(refreshBefore, 'refresh cookie should survive access expiry').toBeDefined();
    expect(csrfBefore, 'session CSRF cookie should survive access expiry').toBeDefined();

    await context.clearCookies({ name: 'sabk_session' });
    const missing = await context.cookies();
    expect(missing.find((cookie) => cookie.name === 'sabk_session')).toBeUndefined();
    expect(missing.find((cookie) => cookie.name === 'sabk_refresh')?.value === refreshBefore?.value).toBe(true);
    expect(missing.find((cookie) => cookie.name === 'sabk_csrf')?.value === csrfBefore?.value).toBe(true);

    await page.reload({ waitUntil: 'networkidle' });
    await expectSignedIn(page);

    const after = await context.cookies();
    const restored = after.find((cookie) => cookie.name === 'sabk_session');
    expect(restored?.httpOnly, 'refresh should issue an HttpOnly access cookie').toBe(true);
    expect(restored?.path).toBe('/api');
    expect(Boolean(restored?.value)).toBe(true);
  });

  test('invalid credentials do not enumerate accounts', async ({ browser }) => {
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    const card = page.getByTestId('auth-error-card');
    const submit = async (email: string, password: string) => {
      await page.goto('/app/auth/login');
      await waitForAuthPageReady(page);
      await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
      await page.getByLabel(/Login password|Mật khẩu đăng nhập/).fill(password);
      await page.getByRole('button', { name: /Sign in|Đăng nhập/ }).click();
      try {
        await expect(card).toBeVisible();
      } catch (err) {
        // Diagnostics for VW-AUTH-E2E: say whether the form was hydrated and what React kept.
        const form = page.locator('form').first();
        console.log(
          'VW-AUTH-E2E diag',
          JSON.stringify({
            url: page.url(),
            hydrated: await form.getAttribute('data-hydrated').catch(() => null),
            emailLen: await page.getByRole('textbox', { name: 'Email', exact: true }).inputValue().then((v) => v.length).catch(() => -1),
            passwordLen: await page.getByLabel(/Login password|Mật khẩu đăng nhập/).inputValue().then((v) => v.length).catch(() => -1),
            formText: await form.innerText().then((t) => t.replace(/\s+/g, ' ').slice(0, 300)).catch(() => null),
          }),
        );
        throw err;
      }
      await expect(card).toContainText(/incorrect|không đúng/i);
      await expect(card).not.toContainText(/does not exist|không tồn tại/i);
      await expect(card).not.toContainText(/turnstile|additional verification|xác minh bổ sung|temporarily locked|tạm khóa|tạm khoá|too many attempts|thử quá nhiều/i);
      return (await card.innerText()).replace(/\s+/g, ' ').trim();
    };
    try {
      const unknownCopy = await submit(uniqueEmail('unknown'), PASSWORD);
      const known = uniqueEmail('known-wrong');
      await signupViaUi(page, known);
      await page.getByRole('button', { name: /^(Sign out|Đăng xuất)$/ }).click();
      await expect(page).toHaveURL(/\/app\/auth\/login/, { timeout: 15_000 });
      const wrongCopy = await submit(known, 'wrong-password-99');
      expect(wrongCopy).toBe(unknownCopy);
    } finally {
      await ctx.close();
    }
  });

  test('verification flag true still allows account settings', async ({ page }) => {
    test.skip(!verifyRequired(), 'only when AUTH_REQUIRE_EMAIL_VERIFICATION=true');
    const email = uniqueEmail('verify');
    await signupViaUi(page, email);
    await expect(page).toHaveURL(/\/app\/auth\/verify-email/);
    await page.goto('/app/settings');
    await expect(page.getByRole('heading', { name: /Account|Tài khoản/ }).first()).toBeVisible();
    await expect(page).not.toHaveURL(/\/app\/onboarding/);

    await page.goto('/app/auth/verify-email');
    await page.getByRole('button', { name: /Resend|Gửi lại/ }).click();
    const mail = await waitForMail(email, 'signup');
    const token = tokenFromLink(mail.link);
    await page.goto(`/app/auth/verify-email#token=${token}`);
    await expect(page).not.toHaveURL(/token=/);
    const confirmation = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/api/v1/auth/verify-email/confirm'),
    );
    await page.getByRole('button', { name: /Confirm email|Xác minh email/ }).click();
    expect((await confirmation).status()).toBe(200);
    await expect(page).toHaveURL(/\/app\/onboarding/);
    await expectSignedIn(page);

    await page.goto(`/app/auth/verify-email#token=${token}`);
    await expect(page).not.toHaveURL(/token=/);
    const replay = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/api/v1/auth/verify-email/confirm'),
    );
    await page.getByRole('button', { name: /Confirm email|Xác minh email/ }).click();
    const rejected = await replay;
    expect(rejected.status()).toBe(400);
    expect((await rejected.json() as { code: string }).code).toBe('verification_invalid');
    await expectSignedIn(page);
  });
});
