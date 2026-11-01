import { expect, test } from '@playwright/test';
import {
  cookieMap,
  expectSignedIn,
  fillSecret,
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
      await fillSecret(page.getByLabel(/^(Login password|Mật khẩu đăng nhập)$/), password);
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

  test('forgot password shows unavailable state when mail delivery is disabled (E2E_VERIFY=false)', async ({ page }) => {
    test.skip(verifyRequired(), 'runs in e2e-browser where AUTH_MAIL_CAPTURE_AS_DELIVERY is off');
    await page.goto('/app/auth/forgot-password');
    await waitForAuthPageReady(page);
    const unavailable = page.getByTestId('forgot-unavailable');
    await expect(unavailable).toBeVisible();
    await expect(unavailable.getByRole('link', { name: /contact channel|kênh liên hệ/i })).toHaveAttribute(
      'href',
      /^(?:\/vi)?\/privacy#contact$/,
    );
    await expect(unavailable.getByRole('link', { name: /Back to sign in|Quay lại đăng nhập/ })).toHaveAttribute(
      'href',
      '/app/auth/login',
    );
  });

  test('forgot -> sink mail -> reset -> login banner, token single-use, and old password rejected (E2E_VERIFY=true)', async ({
    page,
  }) => {
    test.skip(!verifyRequired(), 'only when AUTH_MAIL_CAPTURE_AS_DELIVERY=true in e2e-auth-verify-true');
    const email = uniqueEmail('pw-reset');
    const newPassword = 'reset-login-password-2026!';

    await signupViaUi(page, email, PASSWORD);
    await expectSignedIn(page);
    await page.getByRole('button', { name: /^(Sign out|Đăng xuất)$/ }).click();
    await expect(page).toHaveURL(/\/app\/auth\/login/, { timeout: 15_000 });

    await page.getByRole('link', { name: /Forgot password\?|Quên mật khẩu\?/ }).click();
    await expect(page).toHaveURL(/\/app\/auth\/forgot-password/);
    await waitForAuthPageReady(page);

    await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
    await page.getByRole('button', { name: /Send reset instructions|Gửi hướng dẫn đặt lại/ }).click();
    await expect(page.getByTestId('forgot-sent')).toBeVisible({ timeout: 15_000 });

    const mail = await waitForMail(email, 'password_reset');
    const token = tokenFromLink(mail.link);

    await page.goto('/app/auth/reset-password');
    await waitForAuthPageReady(page);
    await expect(page.getByTestId('reset-invalid-token')).toBeVisible();
    await page.evaluate((t) => {
      window.location.hash = 'token=' + encodeURIComponent(t);
    }, token);
    await expect
      .poll(() => page.evaluate(() => window.location.hash.includes('token=')), {
        timeout: 15_000,
      })
      .toBe(false);
    await expect(page.locator('form[data-hydrated="true"]')).toBeVisible({ timeout: 15_000 });
    await fillSecret(page.getByLabel(/^(New login password|Mật khẩu đăng nhập mới)$/), newPassword);
    await fillSecret(page.getByLabel(/^(Confirm new password|Nhập lại mật khẩu mới)$/), newPassword);
    await page.getByRole('button', { name: /Save new password|Lưu mật khẩu mới/ }).click();

    await expect(page).toHaveURL(/\/app\/auth\/login/, { timeout: 15_000 });
    await expect(page.getByTestId('login-reset-banner')).toBeVisible();
    await expect(page).not.toHaveURL(/reset=done/);

    // Old password must fail with 401 invalid_credentials.
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
    await fillSecret(page.getByLabel(/^(Login password|Mật khẩu đăng nhập)$/), PASSWORD);
    await page.getByRole('button', { name: /Sign in|Đăng nhập/ }).click();
    await expect(page.getByTestId('auth-error-card')).toBeVisible();
    await expect(page.getByTestId('login-reset-banner')).toHaveCount(0);

    // Replaying the same reset token must fail with reset_token_invalid and show the invalid-token card.
    await page.goto('/app/auth/reset-password');
    await waitForAuthPageReady(page);
    await expect(page.getByTestId('reset-invalid-token')).toBeVisible();
    await page.evaluate((t) => {
      window.location.hash = 'token=' + encodeURIComponent(t);
    }, token);
    await expect
      .poll(() => page.evaluate(() => window.location.hash.includes('token=')), {
        timeout: 15_000,
      })
      .toBe(false);
    await expect(page.locator('form[data-hydrated="true"]')).toBeVisible({ timeout: 15_000 });
    await fillSecret(page.getByLabel(/^(New login password|Mật khẩu đăng nhập mới)$/), 'another-new-password-2026!');
    await fillSecret(page.getByLabel(/^(Confirm new password|Nhập lại mật khẩu mới)$/), 'another-new-password-2026!');
    await page.getByRole('button', { name: /Save new password|Lưu mật khẩu mới/ }).click();
    await expect(page.getByTestId('reset-invalid-token')).toBeVisible({ timeout: 15_000 });

    // New password signs in cleanly.
    await loginViaUi(page, email, newPassword);
    await expectSignedIn(page);
  });
});

test.describe('P04 authui completeness, legal pages, and mocked forgot/reset flows', () => {
  const VIETNAMESE_DIACRITIC_RE =
    /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/;

  test('login <-> signup <-> forgot cross-links, confirm-password mismatch, strength meter, and zero language mixing', async ({
    page,
  }) => {
    const origin = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:3000').origin;
    await page.context().addCookies([{ name: 'sabk_locale', value: 'en', url: `${origin}/` }]);

    await page.goto('/app/auth/login');
    await waitForAuthPageReady(page);
    await expect(page.getByTestId('auth-explainer-aside')).toBeAttached();

    // Password toggle in English must be "Show"/"Hide", never "Hiện"/"Ẩn".
    await expect(page.getByRole('button', { name: 'Show' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hiện' })).toHaveCount(0);
    const enLoginBody = await page.locator('body').innerText();
    expect(enLoginBody).not.toMatch(VIETNAMESE_DIACRITIC_RE);

    // Cross-link Login -> Signup
    await page.getByRole('link', { name: 'Create one' }).click();
    await expect(page).toHaveURL(/\/app\/auth\/signup/);
    await waitForAuthPageReady(page);

    // Local strength meter updates as password changes without network traffic.
    const meter = page.locator('#signup-password-meter [role="meter"]');
    await expect(meter).toHaveAttribute('aria-valuenow', '0');
    await fillSecret(page.getByLabel('Login password', { exact: true }), 'StrongAccountPass!2026');
    await expect(meter).toHaveAttribute('aria-valuenow', '4');

    // Legal links on signup open in a new tab (AU4-FE1-15, AU4-FE2-8)
    const termsLink = page.getByRole('link', { name: 'Terms of Service' });
    await expect(termsLink).toHaveAttribute('href', '/terms');
    await expect(termsLink).toHaveAttribute('target', '_blank');
    await expect(termsLink).toHaveAttribute('rel', 'noopener noreferrer');
    const privacyLink = page.getByRole('link', { name: 'Privacy Policy' });
    await expect(privacyLink).toHaveAttribute('href', '/privacy');
    await expect(privacyLink).toHaveAttribute('target', '_blank');
    await expect(privacyLink).toHaveAttribute('rel', 'noopener noreferrer');

    // Confirm password mismatch validation
    await page.getByLabel('Email', { exact: true }).fill('mismatch@example.test');
    await fillSecret(page.getByLabel('Confirm password', { exact: true }), 'DifferentPass!2026');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.getByText('Passwords do not match.')).toBeVisible();

    // Cross-link Signup -> Login -> Forgot
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/app\/auth\/login/);
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(page).toHaveURL(/\/app\/auth\/forgot-password/);
  });

  test('legal pages /terms and /privacy render in en and vi with working anchor navigation', async ({ page }) => {
    await page.goto('/terms');
    await expect(page.getByRole('heading', { level: 1, name: 'Terms of Service & Privacy Policy' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Terms of Service' })).toBeVisible();
    await expect(page.locator('main section').first()).toHaveAttribute('id', 'terms');
    await expect(page.locator('nav a').first()).toHaveAttribute('href', '#terms');
    await expect(page.locator('#terms')).toBeVisible();
    await expect(page.locator('#privacy')).toBeVisible();
    await expect(page.locator('#contact')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Điều khoản sử dụng');

    await page.goto('/privacy#contact');
    await expect(page.getByRole('heading', { level: 1, name: 'Terms of Service & Privacy Policy' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Privacy Policy & End-to-End Scope' })).toBeVisible();
    await expect(page.locator('main section').first()).toHaveAttribute('id', 'privacy');
    await expect(page.locator('nav a').first()).toHaveAttribute('href', '#privacy');
    await expect(page.locator('#contact')).toBeVisible();

    await page.goto('/vi/terms');
    await expect(page.getByRole('heading', { level: 1, name: 'Điều khoản sử dụng & Chính sách quyền riêng tư' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Điều khoản sử dụng' })).toBeVisible();
    await expect(page.locator('main section').first()).toHaveAttribute('id', 'terms');
    await expect(page.locator('nav a').first()).toHaveAttribute('href', '#terms');
    await expect(page.locator('#terms')).toBeVisible();

    await page.goto('/vi/privacy#contact');
    await expect(page.getByRole('heading', { level: 1, name: 'Điều khoản sử dụng & Chính sách quyền riêng tư' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Chính sách quyền riêng tư & Phạm vi mã hoá đầu-cuối' })).toBeVisible();
    await expect(page.locator('main section').first()).toHaveAttribute('id', 'privacy');
    await expect(page.locator('nav a').first()).toHaveAttribute('href', '#privacy');
    await expect(page.locator('#contact')).toBeVisible();
  });

  test('mocked forgot/reset states: mail_delivery_available=false, 429 countdown, missing/invalid token, and 204 hard navigation to /app/auth/login?reset=done', async ({
    page,
  }) => {
    const origin = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:3000').origin;
    await page.context().addCookies([{ name: 'sabk_locale', value: 'en', url: `${origin}/` }]);

    let mailAvailable = false;
    let forgotOutcome: '202' | '429' = '429';
    let resetOutcome: '204' | '400' = '400';

    await page.route('**/api/v1/auth/config', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          oauth_providers: ['google'],
          email_verification_required: false,
          captcha_site_key: null,
          mail_delivery_available: mailAvailable,
        }),
      });
    });

    await page.route('**/api/v1/auth/password/forgot', async (route) => {
      if (forgotOutcome === '429') {
        await route.fulfill({
          status: 429,
          contentType: 'application/problem+json',
          headers: { 'Retry-After': '3' },
          body: JSON.stringify({
            type: 'https://engram.zone17.click/problems/rate-limited',
            title: 'Too Many Requests',
            status: 429,
            code: 'rate_limited',
            retry_after: 3,
          }),
        });
        return;
      }
      await route.fulfill({ status: 202, body: '' });
    });

    await page.route('**/api/v1/auth/password/reset', async (route) => {
      if (resetOutcome === '400') {
        await route.fulfill({
          status: 400,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'https://engram.zone17.click/problems/reset-token-invalid',
            title: 'Bad Request',
            status: 400,
            code: 'reset_token_invalid',
          }),
        });
        return;
      }
      await route.fulfill({ status: 204, body: '' });
    });

    // 1. mail_delivery_available === false renders unavailable card
    await page.goto('/app/auth/forgot-password');
    await expect(page.getByTestId('forgot-unavailable')).toBeVisible();

    // 2. mail_delivery_available === true + 429 countdown -> 202 sent -> Try another email
    mailAvailable = true;
    await page.reload();
    await waitForAuthPageReady(page);
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill('person@example.test');
    await page.getByRole('button', { name: 'Send reset instructions' }).click();
    await expect(page.getByTestId('auth-error-card')).toContainText(/Too many attempts/i);

    forgotOutcome = '202';
    await expect(page.getByRole('button', { name: 'Send reset instructions' })).toBeEnabled({ timeout: 6_000 });
    await page.getByRole('button', { name: 'Send reset instructions' }).click();
    await expect(page.getByTestId('forgot-sent')).toBeVisible();
    await page.getByRole('button', { name: 'Try another email' }).click();
    await expect(page.getByRole('textbox', { name: 'Email', exact: true })).toBeVisible();

    // 3. Reset page without #token shows missing-token card
    await page.goto('/app/auth/reset-password');
    await expect(page.getByTestId('reset-invalid-token')).toBeVisible();

    // 4. Reset page with valid 43-char #token strips hash immediately; 400 reset_token_invalid shows invalid card
    const validToken = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq';
    await page.evaluate((t) => {
      window.location.hash = 'token=' + encodeURIComponent(t);
    }, validToken);
    await expect
      .poll(() => page.evaluate(() => window.location.hash.includes('token=')), {
        timeout: 15_000,
      })
      .toBe(false);
    await expect(page.locator('form[data-hydrated="true"]')).toBeVisible({ timeout: 15_000 });
    await fillSecret(page.getByLabel('New login password', { exact: true }), 'ValidReplacementPass!2026');
    await fillSecret(page.getByLabel('Confirm new password', { exact: true }), 'ValidReplacementPass!2026');
    await page.getByRole('button', { name: 'Save new password' }).click();
    await expect(page.getByTestId('reset-invalid-token')).toBeVisible();

    // 5. Reset page 204 hard-navigates to /app/auth/login?reset=done and shows one-shot banner
    resetOutcome = '204';
    await page.evaluate((t) => {
      window.location.hash = 'token=' + encodeURIComponent(t);
    }, validToken);
    await expect
      .poll(() => page.evaluate(() => window.location.hash.includes('token=')), {
        timeout: 15_000,
      })
      .toBe(false);
    await expect(page.locator('form[data-hydrated="true"]')).toBeVisible({ timeout: 15_000 });
    await fillSecret(page.getByLabel('New login password', { exact: true }), 'ValidReplacementPass!2026');
    await fillSecret(page.getByLabel('Confirm new password', { exact: true }), 'ValidReplacementPass!2026');
    await page.getByRole('button', { name: 'Save new password' }).click();

    await expect(page).toHaveURL(/\/app\/auth\/login/, { timeout: 15_000 });
    await expect(page.getByTestId('login-reset-banner')).toBeVisible();
    await expect(page).not.toHaveURL(/reset=done/);
  });
});
