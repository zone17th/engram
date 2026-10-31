import { expect, test, type Page, type Response } from '@playwright/test';
import { PASSWORD, uniqueEmail } from './helpers';
import { fillSecret } from './vault-settings-secret';
import {
  CRYPTO_WAIT_MS,
  FLOW_TIMEOUT_MS,
  UI_WAIT_MS,
  VAULT_PASSPHRASE,
  expectVaultOpen,
  expectVaultShut,
  gotoSettings,
  isApiPost,
  lockVault,
  signupViaUiSecret,
} from './vault-passkey-support';

// P03-T16B / T17B / T20B Part D real-API Remember device E2E spec.
// Gated on E2E_STACK=1; uses fillSecret() for all secrets.
// No /api/v1/vault* or /api/v1/auth* route stubs.

const REWRAPPED_PASSPHRASE = 'Mp4#xWq8-Kr2!Vn7z-Yt5$Cf9b';

const isApiGet = (response: Response, pathname: string) =>
  response.request().method() === 'GET' && new URL(response.url()).pathname === pathname;

async function expectLockedListOnApp(page: Page) {
  await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
  await expect(page.locator('.vault-pill')).toHaveAttribute('data-vault-state', 'locked', {
    timeout: UI_WAIT_MS,
  });
  await expect(page.locator('.vault-pill')).toHaveClass(/vault-shut/, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('entry-body')).toHaveCount(0);
}

async function signupAndReachOnboardingStep3(page: Page, emailPrefix: string): Promise<string> {
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
  await page.getByTestId('recovery-keys-confirm-checkbox').check();
  const created = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault'), {
    timeout: CRYPTO_WAIT_MS,
  });
  await page.getByTestId('onboarding-create-vault-button').click();
  expect((await created).ok()).toBe(true);

  await expect(page.getByTestId('onboarding-step-passkey')).toBeVisible({
    timeout: UI_WAIT_MS,
  });
  return email;
}

test.describe('P03-T16B / T17B / T20B Part D Remember device against the real API', () => {
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  test('16B: onboarding step 3 remember this device default off', async ({ page }) => {
    test.setTimeout(FLOW_TIMEOUT_MS);

    await test.step('1. reach onboarding step 3, verify toggle is default off, turn it on and finish', async () => {
      await signupAndReachOnboardingStep3(page, 'vaultb-16b-device');

      const rememberSwitch = page.getByTestId('onboarding-remember-device-switch');
      await expect(rememberSwitch).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(rememberSwitch).toHaveAttribute('aria-checked', 'false');

      await rememberSwitch.click();
      await expect(rememberSwitch).toHaveAttribute('aria-checked', 'true', {
        timeout: CRYPTO_WAIT_MS,
      });

      await page.getByTestId('onboarding-finish-button').click();
      await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
      await expectVaultOpen(page);
    });

    await test.step('2. reload -> silent unlock opens the vault without typing a passphrase', async () => {
      const vaultRead = page.waitForResponse((r) => isApiGet(r, '/api/v1/vault') && r.ok(), {
        timeout: CRYPTO_WAIT_MS,
      });
      await page.reload();
      expect(await vaultRead).toBeTruthy();
      await expectVaultOpen(page);
      await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('unlock-passphrase-input')).toHaveCount(0);
    });
  });

  test('17B: unlock by DevKey -> re-auth -> set new passphrase via rewrap without the old passphrase', async ({
    page,
  }) => {
    test.setTimeout(FLOW_TIMEOUT_MS);

    await test.step('1. onboard, remember this device on step 3, then reload so silent unlock opens via DevKey', async () => {
      await signupAndReachOnboardingStep3(page, 'vaultb-17b-devkey-rewrap');

      const rememberSwitch = page.getByTestId('onboarding-remember-device-switch');
      await expect(rememberSwitch).toHaveAttribute('aria-checked', 'false');
      await rememberSwitch.click();
      await expect(rememberSwitch).toHaveAttribute('aria-checked', 'true', {
        timeout: CRYPTO_WAIT_MS,
      });

      await page.getByTestId('onboarding-finish-button').click();
      await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
      await expectVaultOpen(page);

      const vaultRead = page.waitForResponse((r) => isApiGet(r, '/api/v1/vault') && r.ok(), {
        timeout: CRYPTO_WAIT_MS,
      });
      await page.reload();
      expect(await vaultRead).toBeTruthy();
      await expectVaultOpen(page);
      await expect(page.getByTestId('unlock-passphrase-input')).toHaveCount(0);
    });

    await test.step('2. Settings -> Change passphrase (re-auth, old passphrase never asked) -> rewrap', async () => {
      await gotoSettings(page);
      await page.locator('[data-open-dialog="passDlg"]').click({ timeout: UI_WAIT_MS });
      const passDialog = page.locator('#passDlg');
      await expect(passDialog).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(passDialog.getByLabel(/Old passphrase|Passphrase cũ/i)).toHaveCount(0);

      const loginPwdField = passDialog.locator('#pass-login-pwd');
      const newPpField = passDialog.locator('#pass-new-pp');
      await expect(loginPwdField.or(newPpField).first()).toBeVisible({ timeout: UI_WAIT_MS });
      if (await loginPwdField.isVisible()) {
        await fillSecret(loginPwdField, PASSWORD, UI_WAIT_MS);
      }
      await fillSecret(newPpField, REWRAPPED_PASSPHRASE, UI_WAIT_MS);
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

    await test.step('3. Forget device + lock: old passphrase fails, new passphrase unlocks', async () => {
      const forgetBtn = page.getByTestId('settings-forget-device-button');
      await expect(forgetBtn).toBeVisible({ timeout: UI_WAIT_MS });
      await forgetBtn.click();
      await expect(page.getByTestId('settings-remember-device-switch')).toHaveAttribute(
        'aria-checked',
        'false',
        { timeout: UI_WAIT_MS },
      );

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
  });

  test('20B: remember / forget device in Settings', async ({ page }) => {
    test.setTimeout(FLOW_TIMEOUT_MS);

    await test.step('1. onboard with Skip on step 3 (not remembered), then Remember in Settings -> reload silent unlocks', async () => {
      await signupAndReachOnboardingStep3(page, 'vaultb-20b-settings-device');
      await page.getByTestId('onboarding-skip-passkey-button').click();
      await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
      await expectVaultOpen(page);

      await gotoSettings(page);
      const settingsSwitch = page.getByTestId('settings-remember-device-switch');
      await expect(settingsSwitch).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(settingsSwitch).toHaveAttribute('aria-checked', 'false');

      await settingsSwitch.click();
      await expect(settingsSwitch).toHaveAttribute('aria-checked', 'true', {
        timeout: CRYPTO_WAIT_MS,
      });
      await expect(page.getByTestId('settings-forget-device-button')).toBeVisible({
        timeout: UI_WAIT_MS,
      });

      const vaultRead = page.waitForResponse((r) => isApiGet(r, '/api/v1/vault') && r.ok(), {
        timeout: CRYPTO_WAIT_MS,
      });
      await page.reload();
      expect(await vaultRead).toBeTruthy();
      await expectVaultOpen(page);
      await expect(page.getByTestId('unlock-passphrase-input')).toHaveCount(0);
    });

    await test.step('2. Forget in Settings -> reload stays locked and asks for passphrase', async () => {
      await gotoSettings(page);
      const forgetBtn = page.getByTestId('settings-forget-device-button');
      await expect(forgetBtn).toBeVisible({ timeout: UI_WAIT_MS });
      await forgetBtn.click();
      await expect(page.getByTestId('settings-remember-device-switch')).toHaveAttribute(
        'aria-checked',
        'false',
        { timeout: UI_WAIT_MS },
      );

      await page.goto('/app');
      await page.reload();
      await expectLockedListOnApp(page);

      await page.getByTestId('vault-locked-unlock-cta').click();
      await expect(page).toHaveURL(/\/app\/unlock$/, { timeout: UI_WAIT_MS });
      await fillSecret(page.getByTestId('unlock-passphrase-input'), VAULT_PASSPHRASE, CRYPTO_WAIT_MS);
      await page.getByTestId('unlock-submit-button').click();
      await expect(page).toHaveURL(/\/app$/, { timeout: CRYPTO_WAIT_MS });
      await expectVaultOpen(page);
    });
  });
});
