import { expect, test, type Page } from '@playwright/test';
import {
  completeFakeOAuth,
  expectSignedIn,
  fetchMeViaPage,
  isolateRateLimit,
  loginViaUi,
  newContextWithRateLimit,
  patchSettingsViaPage,
  postRefreshViaPage,
  signupViaUi,
  tokenFromLink,
  uniqueEmail,
  verifyRequired,
  waitForMail,
  PASSWORD,
} from './helpers';

async function confirmEmailLink(page: Page) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/api/v1/auth/verify-email/confirm'),
  );
  await page.getByRole('button', { name: /Confirm email|Xác minh email/ }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  await expect(page).toHaveURL(/\/app\/onboarding/, { timeout: 15_000 });
}

async function linkGoogleFromSettings(page: Page, email: string, subject: string) {
  await page.goto('/app/settings');
  await expectSignedIn(page);
  await expect(page.getByRole('button', { name: /Link Google|Liên kết Google/ })).toBeVisible();
  await page.getByRole('button', { name: /Link Google|Liên kết Google/ }).click();
  await page.locator('#linkProviderDlg').getByRole('button', { name: /Continue|Tiếp tục/ }).click();

  const reauth = page.locator('#reauthDlg');
  await expect(reauth).toBeVisible();
  await reauth.getByLabel(/Login password|Mật khẩu đăng nhập/).fill(PASSWORD);
  await reauth.getByRole('button', { name: /^Confirm$|^Xác nhận$/ }).click();
  await expect(reauth).toBeHidden({ timeout: 15_000 });

  await completeFakeOAuth(page, { email, subject });
  await expect(page).toHaveURL(/\/app\/settings/, { timeout: 20_000 });
  await expectSignedIn(page);
}

test.describe('P02 account (real API)', () => {
  test.skip(!process.env.E2E_STACK, 'requires API + worker + mail sink');
  test.skip(verifyRequired(), 'uses a verified-optional account on the false flag run');

  // Serial run still shares the loopback IP; give each test its own 5/min cred
  // bucket instead of raising the product quota (plan Task 24).
  test.beforeEach(async ({ page }) => {
    await isolateRateLimit(page);
  });

  test('locale and theme persist after reload', async ({ page }) => {
    const email = uniqueEmail('prefs');
    await signupViaUi(page, email);
    await expect(page).toHaveURL(/\/app\/onboarding/);
    await page.goto('/app/settings');
    await expectSignedIn(page);
    await page.getByRole('radio', { name: 'Tiếng Việt' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi', { timeout: 10_000 });
    await page.getByRole('radio', { name: /Tối|Dark/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('unlinking Google preserves password sign-in', async ({ page }) => {
    const email = uniqueEmail('unlink-google');
    await signupViaUi(page, email);
    await linkGoogleFromSettings(page, email, `unlink-${email}`);

    await expect(page.getByRole('button', { name: /Unlink Google|Gỡ Google/ })).toBeVisible();
    await page.getByRole('button', { name: /Unlink Google|Gỡ Google/ }).click();
    await page.locator('#unlinkProviderDlg').getByRole('button', { name: /Unlink|Gỡ liên kết/ }).click();

    const reauth = page.locator('#reauthDlg');
    await expect(reauth).toBeVisible();
    await reauth.getByLabel(/Login password|Mật khẩu đăng nhập/).fill(PASSWORD);
    await reauth.getByRole('button', { name: /^Confirm$|^Xác nhận$/ }).click();
    await expect(reauth).toBeHidden({ timeout: 15_000 });

    await expect(page.getByRole('button', { name: /Link Google|Liên kết Google/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Unlink Google|Gỡ Google/ })).toHaveCount(0);
    const me = (await fetchMeViaPage(page)).body as { identities?: Array<{ provider: string }> };
    expect(me.identities?.map((identity) => identity.provider)).toEqual(['password']);

    await page.getByRole('button', { name: /^(Sign out|Đăng xuất)$/ }).click();
    await expect(page).toHaveURL(/\/app\/auth\/login/, { timeout: 15_000 });
    await loginViaUi(page, email, PASSWORD);
    await expectSignedIn(page);
  });

  test('second browser context can sign in and current session stays', async ({ browser }) => {
    const email = uniqueEmail('revoke');
    const first = await newContextWithRateLimit(browser);
    const pageA = await first.newPage();
    await signupViaUi(pageA, email);
    await expectSignedIn(pageA);

    const second = await newContextWithRateLimit(browser);
    const pageB = await second.newPage();
    await loginViaUi(pageB, email, PASSWORD);
    await expectSignedIn(pageB);

    await pageA.goto('/app/settings');
    await expect(pageA.getByText(/this session|phiên này/).first()).toBeVisible();
    await first.close();
    await second.close();
  });

  /**
   * P02-A3: E2E stack has no clock env to expire the 10m access JWT without sleeping.
   * This covers shared cookie jar + explicit refresh from one tab while the other still reads Me.
   * Full access_expired + Web Locks coordination: apps/web/tests/auth-fetch.test.ts.
   */
  test('P02-A3: two tabs share cookies after refresh in one tab', async ({ context }) => {
    const email = uniqueEmail('twotab');
    const pageA = await context.newPage();
    await signupViaUi(pageA, email);
    await expectSignedIn(pageA);

    const pageB = await context.newPage();
    await pageB.goto('/app/settings');
    await expectSignedIn(pageB);

    expect(await postRefreshViaPage(pageA)).toBe(204);
    const meOnB = await fetchMeViaPage(pageB);
    expect(meOnB.status).toBe(200);

    const meOnA = await fetchMeViaPage(pageA);
    expect(meOnA.status).toBe(200);
    await pageA.close();
    await pageB.close();
  });

  test('P02-A4: revoke others signs out the second browser context', async ({ browser }) => {
    const email = uniqueEmail('revokeothers');
    const ctxA = await newContextWithRateLimit(browser);
    const pageA = await ctxA.newPage();
    await signupViaUi(pageA, email);
    await expectSignedIn(pageA);

    const ctxB = await newContextWithRateLimit(browser);
    const pageB = await ctxB.newPage();
    await loginViaUi(pageB, email, PASSWORD);
    await expectSignedIn(pageB);

    await pageA.goto('/app/settings');
    await expect(pageA.getByRole('button', { name: /Sign out elsewhere|Đăng xuất nơi khác/ })).toBeEnabled();
    await pageA.getByRole('button', { name: /Sign out elsewhere|Đăng xuất nơi khác/ }).click();
    await pageA
      .locator('#revokeSessionsDlg')
      .getByRole('button', { name: /Sign out elsewhere|Đăng xuất nơi khác/ })
      .click();
    await pageA.locator('#reauthDlg').getByLabel(/Login password|Mật khẩu đăng nhập/).fill(PASSWORD);
    await pageA.locator('#reauthDlg').getByRole('button', { name: /^Confirm$|^Xác nhận$/ }).click();
    await expect(pageA.locator('#reauthDlg')).toBeHidden({ timeout: 15_000 });
    await expect(pageA.getByText(/Only this session is signed in|Chỉ phiên này đang đăng nhập/)).toBeVisible({
      timeout: 15_000,
    });

    await pageB.goto('/app/settings');
    await expect(pageB).toHaveURL(/\/app\/auth\/login/, { timeout: 20_000 });

    await ctxA.close();
    await ctxB.close();
  });

  test('changing password replaces the current session and revokes other sessions', async ({ browser }) => {
    const email = uniqueEmail('password-rotate');
    const nextPassword = 'rotated-login-password-12';
    const ctxA = await newContextWithRateLimit(browser);
    const pageA = await ctxA.newPage();
    const ctxB = await newContextWithRateLimit(browser);
    const pageB = await ctxB.newPage();

    try {
      await signupViaUi(pageA, email);
      await expectSignedIn(pageA);
      await loginViaUi(pageB, email, PASSWORD);
      await expectSignedIn(pageB);

      await pageA.goto('/app/settings');
      await expect(pageA.getByRole('button', { name: /Change password|Đổi mật khẩu/ })).toBeVisible();
      await pageA.getByRole('button', { name: /Change password|Đổi mật khẩu/ }).click();
      const passwordDlg = pageA.locator('#passwordChangeDlg');
      await passwordDlg.getByLabel(/New password|Mật khẩu mới/).fill(nextPassword);
      await passwordDlg.getByLabel(/^Confirm$|^Nhập lại$|^Xác nhận$/).fill(nextPassword);
      await passwordDlg.getByRole('button', { name: /Change password|Đổi mật khẩu/ }).click();

      const reauth = pageA.locator('#reauthDlg');
      await expect(reauth).toBeVisible();
      await reauth.getByLabel(/Login password|Mật khẩu đăng nhập/).fill(PASSWORD);
      await reauth.getByRole('button', { name: /^Confirm$|^Xác nhận$/ }).click();
      await expect(reauth).toBeHidden({ timeout: 15_000 });
      await expect(pageA.getByText(/Login password updated|Đã đổi mật khẩu đăng nhập/)).toBeVisible({ timeout: 15_000 });
      await expectSignedIn(pageA);

      await pageB.goto('/app/settings');
      await expect(pageB).toHaveURL(/\/app\/auth\/login/, { timeout: 20_000 });
      await loginViaUi(pageB, email, nextPassword);
      await expectSignedIn(pageB);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('P02-A6: change email via mail sink and confirm', async ({ page }) => {
    const email = uniqueEmail('oldmail');
    const newEmail = uniqueEmail('newmail');
    await signupViaUi(page, email);
    await page.goto('/app/settings');
    await expectSignedIn(page);

    await page.getByRole('button', { name: /Change email|Đổi email/ }).click();
    await page.getByLabel(/New email|Email mới/).fill(newEmail);
    await page.getByRole('button', { name: /Send verification|Gửi xác minh/ }).click();
    await page.locator('#reauthDlg').getByLabel(/Login password|Mật khẩu đăng nhập/).fill(PASSWORD);
    await page.locator('#reauthDlg').getByRole('button', { name: /^Confirm$|^Xác nhận$/ }).click();
    await expect(page.locator('#reauthDlg')).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(newEmail)).toBeVisible({ timeout: 10_000 });

    const mail = await waitForMail(newEmail, 'email_change');
    const token = tokenFromLink(mail.link);
    await page.goto(`/app/auth/verify-email#token=${token}`);
    await expect(page).not.toHaveURL(/token=/);
    await confirmEmailLink(page);
    await expectSignedIn(page);
    await page.goto('/app/settings');
    await expect(page.getByText(newEmail)).toBeVisible();
    await expect(page.getByText(email)).toHaveCount(0);
  });

  test('verified account can confirm a pending email change from the verification link', async ({ page }) => {
    test.setTimeout(120_000);
    const email = uniqueEmail('verified-oldmail');
    const newEmail = uniqueEmail('verified-newmail');
    await signupViaUi(page, email);

    await page.goto('/app/auth/verify-email');
    await page.getByRole('button', { name: /Resend|Gửi lại/ }).click();
    const signupMail = await waitForMail(email, 'signup');
    const signupToken = tokenFromLink(signupMail.link);
    await page.goto(`/app/auth/verify-email#token=${signupToken}`);
    await expect(page).not.toHaveURL(/token=/);
    await confirmEmailLink(page);
    await expectSignedIn(page);

    // The API shares a fixed 60s, 1-per-user window across verification and email-change mail.
    await page.waitForTimeout(61_000);
    await page.goto('/app/settings');
    await expectSignedIn(page);
    await page.getByRole('button', { name: /Change email|Đổi email/ }).click();
    await page.getByLabel(/New email|Email mới/).fill(newEmail);
    await page.getByRole('button', { name: /Send verification|Gửi xác minh/ }).click();
    await page.locator('#reauthDlg').getByLabel(/Login password|Mật khẩu đăng nhập/).fill(PASSWORD);
    await page.locator('#reauthDlg').getByRole('button', { name: /^Confirm$|^Xác nhận$/ }).click();
    await expect(page.locator('#reauthDlg')).toBeHidden({ timeout: 15_000 });

    const mail = await waitForMail(newEmail, 'email_change');
    const token = tokenFromLink(mail.link);
    await page.goto(`/app/auth/verify-email#token=${token}`);
    await expect(page).not.toHaveURL(/token=/);
    await expect(page).not.toHaveURL(/\/app\/onboarding/);
    await confirmEmailLink(page);
    await expectSignedIn(page);
    await page.goto('/app/settings');
    await expect(page.getByText(newEmail)).toBeVisible();
    await expect(page.getByText(email)).toHaveCount(0);
  });

  test('P02-A11: enabling semantic_suggest returns 409 when embedding provider is noop', async ({ page }) => {
    test.skip(process.env.EMBEDDING_PROVIDER === 'tei', 'noop/unavailable profile only — do not fake 409 in app');

    const email = uniqueEmail('semantic');
    await signupViaUi(page, email);
    await page.goto('/app/settings');
    await expectSignedIn(page);

    const before = await fetchMeViaPage(page);
    expect(before.status).toBe(200);
    const meBefore = before.body as { features?: { semantic_available?: boolean }; settings?: { semantic_suggest?: boolean } };
    expect(meBefore.features?.semantic_available).toBe(false);

    const patch = await patchSettingsViaPage(page, { semantic_suggest: true });
    expect(patch.status).toBe(409);
    const problem = patch.body as { code?: string };
    expect(problem.code).toBe('semantic_unavailable');

    const after = await fetchMeViaPage(page);
    const meAfter = after.body as { settings?: { semantic_suggest?: boolean } };
    expect(meAfter.settings?.semantic_suggest).toBe(meBefore.settings?.semantic_suggest ?? false);
  });
});
