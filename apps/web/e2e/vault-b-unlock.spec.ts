import { expect, test, type Page } from '@playwright/test';
import { PASSWORD, uniqueEmail } from './helpers';
import { fillSecret } from './vault-settings-secret';
import {
  CRYPTO_WAIT_MS,
  FLOW_TIMEOUT_MS,
  UI_WAIT_MS,
  VAULT_PASSPHRASE,
  addAuthenticator,
  enableWebAuthn,
  expectPasskeyAdded,
  expectVaultOpen,
  expectVaultShut,
  gotoSettings,
  isApiPost,
  lockVault,
  openAddPasskeyDialog,
  removeAuthenticator,
  signupViaUiSecret,
  submitPasskeyName,
} from './vault-passkey-support';

// P03-T17B real-API unlock + recovery + passkey rewrap + CF-T17B-UNLOCK-EMAIL-WRAP E2E spec.
// Gated on E2E_STACK=1; uses fresh virtual authenticators per credential flow and fillSecret() for all secrets.
// No /api/v1/vault* or /api/v1/auth* route stubs.

const RECOVERED_PASSPHRASE = 'Zk7$vQm2-Rn9&Tp4w-Lx8#Bd5y';
const REWRAPPED_PASSPHRASE = 'Mp4#xWq8-Kr2!Vn7z-Yt5$Cf9b';
const RECOVERY_KEY_SHAPE = /^rk\d{1,2}_[0-7][0-9A-TV-Z]{3}(?:-[0-9A-TV-Z]{4}){5}-[0-9A-TV-Z]{2}$/;

async function signupAndCompleteOnboardingWithStep3Skip(
  page: Page,
  emailPrefix: string,
): Promise<{ email: string; recoveryKey: string }> {
  const email = uniqueEmail(emailPrefix);
  await signupViaUiSecret(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/app\/onboarding$/, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('onboarding-step-passphrase')).toBeVisible({
    timeout: CRYPTO_WAIT_MS,
  });

  await fillSecret(
    page.getByLabel('Passphrase', { exact: true }),
    VAULT_PASSPHRASE,
    CRYPTO_WAIT_MS,
  );
  await fillSecret(page.getByLabel('Confirm passphrase'), VAULT_PASSPHRASE, CRYPTO_WAIT_MS);
  await page.getByTestId('onboarding-continue-button').click();

  await expect(page.getByTestId('onboarding-step-recovery-keys')).toBeVisible({
    timeout: CRYPTO_WAIT_MS,
  });
  const recoveryKey = ((await page.getByTestId('recovery-key-slot-1').textContent()) ?? '').trim();
  expect(RECOVERY_KEY_SHAPE.test(recoveryKey)).toBe(true);

  await page.getByTestId('recovery-keys-confirm-checkbox').check();
  const created = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault'), {
    timeout: CRYPTO_WAIT_MS,
  });
  await page.getByTestId('onboarding-create-vault-button').click();
  expect((await created).ok()).toBe(true);

  await expect(page.getByTestId('onboarding-step-passkey')).toBeVisible({ timeout: UI_WAIT_MS });
  await page.getByTestId('onboarding-skip-passkey-button').click();
  await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
  await expectVaultOpen(page);
  return { email, recoveryKey };
}
test.describe('P03-T17B unlock, recovery passkey persistence, passkey rewrap & email wrap against the real API', () => {
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  test('17B: after recovery, the old passkey still opens the vault (VK unchanged)', async ({ page }) => {
    test.setTimeout(FLOW_TIMEOUT_MS);

    const cdp = await enableWebAuthn(page);
    const authenticatorId = await addAuthenticator(cdp, { hasPrf: true, isUserVerified: true });

    try {
      let recoveryKey = '';

      await test.step('1. signup, capture one RK during onboarding, and register a passkey', async () => {
        const setup = await signupAndCompleteOnboardingWithStep3Skip(page, 'vaultb-17b-recover');
        recoveryKey = setup.recoveryKey;

        await gotoSettings(page);
        await openAddPasskeyDialog(page);
        await submitPasskeyName(page, 'Pre-recovery passkey');
        await expectPasskeyAdded(page);
      });

      await test.step('2. lock, recover with the RK + new passphrase via Forgot Passphrase -> Recovery', async () => {
        await lockVault(page);
        await page.getByTestId('unlock-forgot-passphrase-link').click();
        await expect(page).toHaveURL(/\/app\/unlock\/forgot$/, { timeout: UI_WAIT_MS });
        await expect(page.getByTestId('forgot-passphrase-page')).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(page.getByTestId('forgot-path-passkey')).toBeVisible();
        await expect(page.getByTestId('forgot-path-unlocked-tab')).toBeVisible();

        await page.getByTestId('forgot-use-recovery-key-cta').click();
        await expect(page).toHaveURL(/\/app\/recovery$/, { timeout: UI_WAIT_MS });

        await expect(page.getByTestId('recovery-step-reauth')).toBeVisible({ timeout: UI_WAIT_MS });
        const reauthed = page.waitForResponse((r) => isApiPost(r, '/api/v1/auth/reauth'), {
          timeout: UI_WAIT_MS,
        });
        await fillSecret(page.getByTestId('recovery-reauth-password-input'), PASSWORD, UI_WAIT_MS);
        await page.getByTestId('recovery-reauth-password-submit').click();
        expect((await reauthed).ok()).toBe(true);

        await expect(page.getByTestId('recovery-step-enter-key')).toBeVisible({
          timeout: UI_WAIT_MS,
        });
        const lookedUp = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault/unlock/recovery'), {
          timeout: CRYPTO_WAIT_MS,
        });
        await fillSecret(page.getByTestId('recovery-key-input'), recoveryKey, CRYPTO_WAIT_MS);
        await page.getByTestId('recovery-key-submit').click();
        expect((await lookedUp).ok()).toBe(true);

        await expect(page.getByTestId('recovery-step-new-passphrase')).toBeVisible({
          timeout: CRYPTO_WAIT_MS,
        });
        await fillSecret(
          page.getByTestId('recovery-new-passphrase-input'),
          RECOVERED_PASSPHRASE,
          CRYPTO_WAIT_MS,
        );
        await fillSecret(
          page.getByTestId('recovery-confirm-passphrase-input'),
          RECOVERED_PASSPHRASE,
          CRYPTO_WAIT_MS,
        );
        const completed = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault/recover/complete'), {
          timeout: CRYPTO_WAIT_MS,
        });
        await page.getByTestId('recovery-step3-submit').click();
        expect((await completed).ok()).toBe(true);

        await expect(page.getByTestId('recovery-step-regenerate-reauth')).toBeVisible({
          timeout: CRYPTO_WAIT_MS,
        });
        await page.getByTestId('recovery-step4-skip-button').click();
        await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
        await expectVaultOpen(page);
      });

      await test.step('3. lock and unlock with the old passkey -> unlocked (VK unchanged)', async () => {
        await lockVault(page);
        const passkeyUnlockBtn = page.getByTestId('unlock-passkey-button');
        await expect(passkeyUnlockBtn).toBeVisible({ timeout: UI_WAIT_MS });
        await passkeyUnlockBtn.click();
        await expect(page).toHaveURL(/\/app$/, { timeout: CRYPTO_WAIT_MS });
        await expectVaultOpen(page);
      });
    } finally {
      await removeAuthenticator(cdp, authenticatorId).catch(() => undefined);
    }
  });

  test('17B: unlock by passkey -> re-auth -> set new passphrase via rewrap without the old passphrase', async ({
    page,
  }) => {
    test.setTimeout(FLOW_TIMEOUT_MS);

    const cdp = await enableWebAuthn(page);
    const authenticatorId = await addAuthenticator(cdp, { hasPrf: true, isUserVerified: true });

    try {
      await test.step('1. create vault, register a passkey, lock, and unlock with the passkey', async () => {
        await signupAndCompleteOnboardingWithStep3Skip(page, 'vaultb-17b-rewrap');
        await gotoSettings(page);
        await openAddPasskeyDialog(page);
        await submitPasskeyName(page, 'Rewrap passkey');
        await expectPasskeyAdded(page);

        await lockVault(page);
        const passkeyUnlockBtn = page.getByTestId('unlock-passkey-button');
        await expect(passkeyUnlockBtn).toBeVisible({ timeout: UI_WAIT_MS });
        await passkeyUnlockBtn.click();
        await expect(page).toHaveURL(/\/app$/, { timeout: CRYPTO_WAIT_MS });
        await expectVaultOpen(page);
      });

      await test.step('2. Settings -> Change passphrase (re-auth, old passphrase never asked) -> rewrap', async () => {
        await gotoSettings(page);
        await page.locator('[data-open-dialog="passDlg"]').click({ timeout: UI_WAIT_MS });
        const passDialog = page.locator('#passDlg');
        await expect(passDialog).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(passDialog.getByLabel(/Old passphrase|Passphrase cũ/i)).toHaveCount(0);

        const loginPwdField = passDialog.locator('#pass-login-pwd');
        if (await loginPwdField.isVisible()) {
          await fillSecret(loginPwdField, PASSWORD, UI_WAIT_MS);
        }
        await fillSecret(passDialog.locator('#pass-new-pp'), REWRAPPED_PASSPHRASE, UI_WAIT_MS);
        await fillSecret(passDialog.locator('#pass-confirm-pp'), REWRAPPED_PASSPHRASE, UI_WAIT_MS);
        await passDialog
          .getByRole('button', { name: /Change passphrase|Đổi passphrase/ })
          .click({ timeout: UI_WAIT_MS });

        await expect(passDialog.locator('[data-view="pass-done"]')).toBeVisible({
          timeout: CRYPTO_WAIT_MS,
        });
        await passDialog.getByRole('button', { name: /Done|Xong/ }).click({ timeout: UI_WAIT_MS });
        await expect(passDialog).toBeHidden({ timeout: UI_WAIT_MS });
      });

      await test.step('3. lock: old passphrase fails, new passphrase unlocks', async () => {
        await lockVault(page);

        // Old passphrase fails with Incorrect passphrase
        await fillSecret(page.getByTestId('unlock-passphrase-input'), VAULT_PASSPHRASE, CRYPTO_WAIT_MS);
        await page.getByTestId('unlock-submit-button').click();
        await expect(page.getByTestId('unlock-error-incorrect-passphrase')).toBeVisible({
          timeout: CRYPTO_WAIT_MS,
        });
        await expectVaultShut(page);

        // New passphrase unlocks
        await fillSecret(
          page.getByTestId('unlock-passphrase-input'),
          REWRAPPED_PASSPHRASE,
          CRYPTO_WAIT_MS,
        );
        await page.getByTestId('unlock-submit-button').click();
        await expect(page).toHaveURL(/\/app$/, { timeout: CRYPTO_WAIT_MS });
        await expectVaultOpen(page);
      });
    } finally {
      await removeAuthenticator(cdp, authenticatorId).catch(() => undefined);
    }
  });

  test('CF-T17B-UNLOCK-EMAIL-WRAP: 390 px scrollWidth <= innerWidth with a long email', async ({
    page,
  }) => {
    test.setTimeout(FLOW_TIMEOUT_MS);

    await page.setViewportSize({ width: 390, height: 844 });
    const longPrefix =
      'cf-t17b-unlock-email-wrap-very-long-recipient-identifier-for-390px-mobile-viewport-guard';
    const { email } = await signupAndCompleteOnboardingWithStep3Skip(page, longPrefix);
    expect(email.length).toBeGreaterThan(70);
    // A locked vault stays on /app per advisor-dec-048; lockVault clicks lock then follows vault-locked-unlock-cta to /app/unlock
    await lockVault(page);

    const signedInLine = page.getByTestId('unlock-signed-in-line');
    await expect(signedInLine).toBeVisible({ timeout: UI_WAIT_MS });
    await expect(signedInLine).toContainText(email);

    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      overflowWrap: window.getComputedStyle(
        document.querySelector('[data-testid="unlock-signed-in-line"]')!,
      ).overflowWrap,
    }));
    expect(dimensions.innerWidth).toBe(390);
    expect(dimensions.overflowWrap).toBe('anywhere');
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);
  });
});
