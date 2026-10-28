import { expect, test, type Page } from '@playwright/test';
import {
  completeFakeOAuth,
  expectSignedIn,
  fetchMeViaPage,
  isolateRateLimit,
  signupViaUi,
  waitForAuthPageReady,
  waitForOAuthProviders,
  tokenFromLink,
  uniqueEmail,
  verifyRequired,
  waitForMail,
  PASSWORD,
} from './helpers';

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

test.describe('P02 fake OAuth (not Google/GitHub production)', () => {
  test.skip(!process.env.E2E_STACK, 'requires API with AUTH_FAKE_OAUTH');
  test.skip(verifyRequired(), 'OAuth login coverage runs on the verification=false job');

  test.beforeEach(async ({ page }) => {
    await isolateRateLimit(page);
  });

  test('fake Google login reaches onboarding', async ({ page }) => {
    const email = uniqueEmail('oauth');
    await page.goto('/app/auth/login');
    await waitForOAuthProviders(page);
    await page.getByRole('link', { name: /Continue with Google|Tiếp tục với Google/ }).click();
    await completeFakeOAuth(page, { email, subject: `sub-${email}` });
    await page.waitForURL(/\/app\/(onboarding|auth\/callback)/, { timeout: 20_000 });
    await expectSignedIn(page);
    await expect(page.getByText(/Local fake provider/)).toHaveCount(0);
  });

  test('cancel at the fake provider does not create a session', async ({ page }) => {
    await page.goto('/app/auth/login');
    await waitForOAuthProviders(page);
    await page.getByRole('link', { name: /Continue with Google|Tiếp tục với Google/ }).click();
    await completeFakeOAuth(page, { outcome: 'cancel' });
    await expect(page.getByText(/cancelled|huỷ|hủy/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('session-status')).toHaveCount(0);
  });

  test('reusing a fake subject signs into the same account', async ({ page }) => {
    const subject = `same-${Date.now()}`;
    const email = uniqueEmail('oa1');
    await page.goto('/app/auth/login');
    await waitForOAuthProviders(page);
    await page.getByRole('link', { name: /Continue with Google|Tiếp tục với Google/ }).click();
    await completeFakeOAuth(page, { email, subject });
    await expectSignedIn(page);
    await page.getByRole('button', { name: /^(Sign out|Đăng xuất)$/ }).click();
    await expect(page).toHaveURL(/\/app\/auth\/login/, { timeout: 15_000 });
    await waitForOAuthProviders(page);

    await page.getByRole('link', { name: /Continue with Google|Tiếp tục với Google/ }).click();
    await completeFakeOAuth(page, { email: uniqueEmail('oa-reuse'), subject });
    await expectSignedIn(page);
    await page.goto('/app/settings');
    await expect(page.getByText(email)).toBeVisible();
  });

  test('password account links Google after password re-authentication', async ({ page }) => {
    const email = uniqueEmail('oauth-link');
    await signupViaUi(page, email);
    await linkGoogleFromSettings(page, email, `link-${email}`);

    const me = (await fetchMeViaPage(page)).body as { identities?: Array<{ provider: string }> };
    expect(me.identities?.map((identity) => identity.provider)).toEqual(expect.arrayContaining(['password', 'google']));
    await expect(page.getByRole('button', { name: /Unlink Google|Gỡ Google/ })).toBeVisible();
  });

  test('linking a provider subject owned by another user shows an identity conflict', async ({ page }) => {
    const subject = `collision-${Date.now()}`;
    const firstEmail = uniqueEmail('oauth-owner');
    await signupViaUi(page, firstEmail);
    await linkGoogleFromSettings(page, firstEmail, subject);

    await page.getByRole('button', { name: /^(Sign out|Đăng xuất)$/ }).click();
    await expect(page).toHaveURL(/\/app\/auth\/login/, { timeout: 15_000 });

    const secondEmail = uniqueEmail('oauth-conflict');
    await signupViaUi(page, secondEmail);
    await page.goto('/app/settings');
    await expectSignedIn(page);
    await page.getByRole('button', { name: /Link Google|Liên kết Google/ }).click();
    await page.locator('#linkProviderDlg').getByRole('button', { name: /Continue|Tiếp tục/ }).click();
    await page.locator('#reauthDlg').getByLabel(/Login password|Mật khẩu đăng nhập/).fill(PASSWORD);
    await page.locator('#reauthDlg').getByRole('button', { name: /^Confirm$|^Xác nhận$/ }).click();
    await expect(page.locator('#reauthDlg')).toBeHidden({ timeout: 15_000 });
    await completeFakeOAuth(page, { email: secondEmail, subject });

    await expect(page).toHaveURL(/\/app\/auth\/callback\/google\?status=identity_conflict/, { timeout: 20_000 });
    await expect(page.getByText(/Identity conflict|Tài khoản provider này đã liên kết user khác/)).toBeVisible();
    await expect(page.getByRole('link', { name: /Back to sign in|Về đăng nhập/ })).toBeVisible();
  });

  test('OAuth-only account does not expose last-method unlink', async ({ page }) => {
    const email = uniqueEmail('oauth-only');
    await page.goto('/app/auth/login');
    await waitForOAuthProviders(page);
    await page.getByRole('link', { name: /Continue with Google|Tiếp tục với Google/ }).click();
    await completeFakeOAuth(page, { email, subject: `only-${email}` });
    await expectSignedIn(page);

    await page.goto('/app/settings');
    await expectSignedIn(page);
    await expect(page.getByRole('button', { name: /Set password|Đặt mật khẩu/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Unlink Google|Gỡ Google/ })).toHaveCount(0);
  });

  test('P02-A6: OAuth-only account sets login password via mail sink', async ({ page }) => {
    const email = uniqueEmail('oauth-enroll');
    await page.goto('/app/auth/login');
    await waitForOAuthProviders(page);
    await page.getByRole('link', { name: /Continue with Google|Tiếp tục với Google/ }).click();
    await completeFakeOAuth(page, { email, subject: `enroll-${email}` });
    await expectSignedIn(page);

    await page.goto('/app/settings');
    await page.getByRole('button', { name: /Set password|Đặt mật khẩu/ }).click();
    await page.getByRole('button', { name: /Send setup email|Gửi email đặt mật khẩu/ }).click();

    const mail = await waitForMail(email, 'password_enroll');
    const token = tokenFromLink(mail.link);
    await page.goto(`/app/auth/password-enroll#token=${token}`);
    await waitForAuthPageReady(page);
    await expect(page).not.toHaveURL(/token=/);
    await page.getByLabel(/New password|Mật khẩu mới/).fill(PASSWORD);
    await page.getByLabel(/Confirm password|Xác nhận mật khẩu/).fill(PASSWORD);
    await page.getByRole('button', { name: /Set password|Đặt mật khẩu/ }).click();

    await expect(page).toHaveURL(/\/app\/settings/, { timeout: 20_000 });
    await expect(page.getByRole('button', { name: /Change password|Đổi mật khẩu/ })).toBeVisible();
  });
});
