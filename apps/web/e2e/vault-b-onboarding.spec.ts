import { expect, test } from '@playwright/test';
import { PASSWORD, uniqueEmail } from './helpers';
import { fillSecret } from './vault-settings-secret';
import {
  CRYPTO_WAIT_MS,
  FLOW_TIMEOUT_MS,
  UI_WAIT_MS,
  VAULT_PASSPHRASE,
  addAuthenticator,
  addDialog,
  enableWebAuthn,
  expectVaultOpen,
  expectVaultShut,
  isApiPost,
  lockVault,
  removeAuthenticator,
  signupViaUiSecret,
} from './vault-passkey-support';

// P03-T16B real-API onboarding step 3 E2E spec.
// Gated on E2E_STACK=1; uses fresh virtual authenticators per credential flow and fillSecret() for all secrets.
// No /api/v1/vault* or /api/v1/auth* route stubs.

test.describe('P03-T16B onboarding step 3 against the real API', () => {
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  test('16B: onboarding step 3 add passkey then unlock with it', async ({ page }) => {
    test.setTimeout(FLOW_TIMEOUT_MS);

    const cdp = await enableWebAuthn(page);
    const authenticatorId = await addAuthenticator(cdp, { hasPrf: true, isUserVerified: true });

    try {
      const email = uniqueEmail('vaultb-onboard-add');
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

      // Step 3 renders after RK confirm with Remember this device toggle default off
      await expect(page.getByTestId('onboarding-step-passkey')).toBeVisible({
        timeout: UI_WAIT_MS,
      });
      await expect(page.getByTestId('onboarding-remember-device-switch')).toHaveAttribute(
        'aria-checked',
        'false',
      );
      // Add a passkey on Step 3 using PasskeyAddEntry / PasskeyAddDialog
      await page
        .getByTestId('onboarding-passkey-card')
        .getByRole('button', { name: 'Add passkey' })
        .click();
      const dialog = addDialog(page);
      await expect(dialog).toBeVisible({ timeout: UI_WAIT_MS });

      const passwordField = dialog.getByLabel('Login password');
      const continueBtn = dialog.getByRole('button', { name: 'Continue' });
      await expect(passwordField.or(continueBtn.and(page.locator(':enabled'))).first()).toBeVisible({
        timeout: UI_WAIT_MS,
      });
      if (await passwordField.isVisible()) {
        const reauthed = page.waitForResponse((r) => isApiPost(r, '/api/v1/auth/reauth'), {
          timeout: UI_WAIT_MS,
        });
        await fillSecret(passwordField, PASSWORD, UI_WAIT_MS);
        await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
        expect((await reauthed).ok()).toBe(true);
      }
      await expect(continueBtn).toBeEnabled({ timeout: UI_WAIT_MS });

      const passkeySaved = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault/passkeys'), {
        timeout: CRYPTO_WAIT_MS,
      });
      await dialog.getByLabel('Passkey name').fill('Onboarding passkey');
      await continueBtn.click();
      expect((await passkeySaved).ok()).toBe(true);

      // Adding the passkey completes onboarding and navigates to /app unlocked
      await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
      await expectVaultOpen(page);

      // Lock the vault (stays on /app per advisor-dec-048, open /app/unlock via banner CTA), then unlock with the passkey
      await lockVault(page);
      const passkeyUnlockBtn = page.getByTestId('unlock-passkey-button');
      await expect(passkeyUnlockBtn).toBeVisible({ timeout: UI_WAIT_MS });
      await passkeyUnlockBtn.click();
      await expect(page).toHaveURL(/\/app$/, { timeout: CRYPTO_WAIT_MS });
      await expectVaultOpen(page);
    } finally {
      await removeAuthenticator(cdp, authenticatorId).catch(() => undefined);
    }
  });

  test('16B: onboarding step 3 skip', async ({ page }) => {
    test.setTimeout(FLOW_TIMEOUT_MS);

    const email = uniqueEmail('vaultb-onboard-skip');
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

    // Step 3 renders with Remember this device default off; clicking Skip goes on to /app with the vault unlocked
    await expect(page.getByTestId('onboarding-step-passkey')).toBeVisible({ timeout: UI_WAIT_MS });
    await expect(page.getByTestId('onboarding-remember-device-switch')).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await page.getByTestId('onboarding-skip-passkey-button').click();
    await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
    await expectVaultOpen(page);

    // Locking shows no passkey unlock button since step 3 was skipped
    await lockVault(page);
    await expectVaultShut(page);
    await expect(page.getByTestId('unlock-passphrase-section')).toBeVisible({ timeout: UI_WAIT_MS });
    await expect(page.getByTestId('unlock-passkey-section')).toHaveCount(0);
  });
});
