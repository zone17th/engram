import { expect, test } from '@playwright/test';
import { PASSWORD, uniqueEmail } from './helpers';
import { fillSecret } from './vault-settings-secret';
import {
  CRYPTO_WAIT_MS,
  FLOW_TIMEOUT_MS,
  UI_WAIT_MS,
  addAuthenticator,
  addDialog,
  enableWebAuthn,
  expectPasskeyAdded,
  expectVaultOpen,
  expectVaultShut,
  gotoSettings,
  installPasskeyProbe,
  isApiGet,
  isApiPost,
  lockVault,
  openAddPasskeyDialog,
  readProbe,
  removeAuthenticator,
  setUserVerified,
  signupAndCreateVault,
  submitPasskeyName,
  unlockWithPassphrase,
} from './vault-passkey-support';

// Passkey E2E (P03-T19, advisor-dec-047): Add passkey in Settings and unlock with a passkey, against the compose
// stack's real API and database with Chrome's CDP virtual authenticator (ctap2, internal, resident key, user
// verification, PRF). No page.route / context.route for /api/v1/vault* or /api/v1/auth* lives in this file (the only
// auth routing is helpers.isolateRateLimit, which forwards to the real API with a per-context client IP).
//
// The WebAuthn RP ID is the host of APP_ORIGIN/BASE_URL (nothing is hardcoded here). Chrome rejects an IP address as
// an RP ID, so this spec needs the stack served from a hostname such as http://localhost:3000.
//
// Secrets: passphrase and login password are written with fillSecret() only; the recovery key is never read; the PRF
// output never leaves the page (the probe records booleans about its shape). No screenshots, traces or attachments.

const COPY = {
  prfUnsupported:
    'This browser or authenticator does not support the WebAuthn PRF extension. You cannot register a passkey. Keep using your passphrase and recovery keys.',
  registerCancelled: 'Passkey registration was cancelled.',
  unlockCancelled: 'Passkey prompt was cancelled.',
  orphanNotice: /The passkey was not saved to your vault\./,
} as const;

test.describe('passkey against the real API', () => {
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  test('PRF matrix in a real browser: unsupported, cancel at create/get, register, passkey unlock, two credentials', async ({
    page,
    context,
  }) => {
    test.setTimeout(FLOW_TIMEOUT_MS);

    const passkeyButton = page.getByTestId('unlock-passkey-button');
    await installPasskeyProbe(context);
    const cdp = await enableWebAuthn(page);

    await test.step('1. real signup and onboarding create a vault; the vault is open', async () => {
      await signupAndCreateVault(page, 'vault-passkey', uniqueEmail);
      // PKW-R2-2: an actionability timeout on a secret field must never include the secret value in the Playwright call log.
      let actionabilityFailureMessage = '';
      try {
        await fillSecret(page.getByTestId('nonexistent-secret-input-pkw-r2-2'), PASSWORD, 50);
      } catch (err) {
        actionabilityFailureMessage = err instanceof Error ? err.message : String(err);
      }
      expect(actionabilityFailureMessage.length > 0 && !actionabilityFailureMessage.includes(PASSWORD)).toBe(true);
    });
    await test.step('2. PRF matrix: an authenticator without PRF -> passkey.prf_unsupported, nothing saved', async () => {
      const noPrf = await addAuthenticator(cdp, { hasPrf: false });
      await gotoSettings(page);
      const dialog = await openAddPasskeyDialog(page);
      await submitPasskeyName(page, 'No PRF key');
      await expect(dialog.getByRole('alert')).toHaveText(COPY.prfUnsupported, { timeout: CRYPTO_WAIT_MS });
      // create() worked on the authenticator but the server never saw it: the orphan notice says so.
      await expect(dialog.getByText(COPY.orphanNotice)).toBeVisible();
      const probe = await readProbe(page);
      expect(probe.creates.at(-1)?.error).toBeNull();
      expect(probe.creates.at(-1)?.prfEnabled).not.toBe(true);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden({ timeout: UI_WAIT_MS });
      await removeAuthenticator(cdp, noPrf);
    });

    await test.step('3. a user with no saved passkey gets no passkey button on the unlock screen (fresh page load)', async () => {
      await lockVault(page);
      const metaLoaded = page.waitForResponse((r) => isApiGet(r, '/api/v1/vault'), { timeout: UI_WAIT_MS });
      await page.reload();
      await metaLoaded;
      await expect(page.getByTestId('unlock-passphrase-section')).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(page.getByTestId('unlock-passkey-section')).toHaveCount(0);
      await unlockWithPassphrase(page);
    });

    const unverifiedAuth = await addAuthenticator(cdp, { hasPrf: true, isUserVerified: false });

    await test.step('4. PRF matrix: cancel at create() (user verification fails) -> passkey.register_cancelled, no orphan', async () => {
      await gotoSettings(page);
      const dialog = await openAddPasskeyDialog(page);
      await submitPasskeyName(page, 'E2E passkey A');
      await expect(dialog.getByRole('alert')).toHaveText(COPY.registerCancelled, { timeout: CRYPTO_WAIT_MS });
      await expect(dialog.getByText(COPY.orphanNotice)).toHaveCount(0);
      const probe = await readProbe(page);
      expect(probe.creates.at(-1)?.error).toBe('NotAllowedError');
    });

    // Chromium's AuthTokenRequester retries internal UV until VirtualCtap2Device::State::uv_retries reaches 0
    // (kCtap2ErrUvBlocked), and WebAuthn.setUserVerified does not reset uv_retries: replace with a fresh verified
    // authenticator before registering (PKW-R2-5).
    await removeAuthenticator(cdp, unverifiedAuth);
    const authenticatorA = await addAuthenticator(cdp, { hasPrf: true, isUserVerified: true });

    await test.step('5. PRF matrix: register with PRF; the flow follows whichever PRF path Chrome takes', async () => {
      const before = await readProbe(page);
      const dialog = addDialog(page);
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await expectPasskeyAdded(page);

      const after = await readProbe(page);
      const created = after.creates.at(-1);
      expect(created?.error).toBeNull();
      expect(created?.prfEnabled).toBe(true);
      const followUpGets = after.gets.slice(before.gets.length);
      if (created?.prfFirst) {
        // PRF output directly at create(): no follow-up get().
        expect(followUpGets).toHaveLength(0);
        test.info().annotations.push({ type: 'prf-path', description: 'output directly at create()' });
      } else {
        // prf.enabled at create() without output: exactly one follow-up get() returns the output.
        expect(followUpGets).toHaveLength(1);
        expect(followUpGets[0]?.error).toBeNull();
        expect(followUpGets[0]?.prfFirst).toBe(true);
        test.info().annotations.push({ type: 'prf-path', description: 'enabled at create(), then get()' });
      }
    });

    await test.step('6. lock, then unlock with the passkey button on /app/unlock', async () => {
      await lockVault(page);
      await expect(passkeyButton).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(page.getByTestId('unlock-passkey-section')).toContainText('Or enter your passphrase below.');
      await passkeyButton.click();
      await expect(page).toHaveURL(/\/app$/, { timeout: CRYPTO_WAIT_MS });
      await expectVaultOpen(page);
    });

    await test.step('7. fresh page load on /app/unlock loads the passkey list and unlocks with the passkey', async () => {
      await lockVault(page);
      const metaLoaded = page.waitForResponse((r) => isApiGet(r, '/api/v1/vault'), { timeout: UI_WAIT_MS });
      await page.reload();
      await metaLoaded;
      await expect(passkeyButton).toBeVisible({ timeout: UI_WAIT_MS });
      await passkeyButton.click();
      await expect(page).toHaveURL(/\/app$/, { timeout: CRYPTO_WAIT_MS });
      await expectVaultOpen(page);
    });

    await test.step('8. PRF matrix: cancel at get() (user verification fails) -> passkey.unlock_cancelled, vault stays locked', async () => {
      await lockVault(page);
      await expect(passkeyButton).toBeVisible({ timeout: UI_WAIT_MS });
      await setUserVerified(cdp, authenticatorA, false);
      await passkeyButton.click();
      await expect(page.getByTestId('unlock-passkey-error')).toHaveText(COPY.unlockCancelled, {
        timeout: CRYPTO_WAIT_MS,
      });
      await expect(page).toHaveURL(/\/app\/unlock$/);
      await expectVaultShut(page);
      const probe = await readProbe(page);
      expect(probe.gets.at(-1)?.error).toBe('NotAllowedError');
      await unlockWithPassphrase(page);
    });

    await test.step('9. two credentials: the second passkey unlocks with its own salt while both are listed', async () => {
      // Chrome refuses a second registration on an authenticator that already holds a credential listed in
      // excludeCredentials (and authenticatorA's uv_retries were exhausted by step 8), so the second credential lives
      // on a fresh verified authenticator and the first one is detached.
      await removeAuthenticator(cdp, authenticatorA);
      await addAuthenticator(cdp, { hasPrf: true });
      await gotoSettings(page);
      await openAddPasskeyDialog(page);
      await submitPasskeyName(page, 'E2E passkey B');
      await expectPasskeyAdded(page);

      await lockVault(page);
      await expect(passkeyButton).toBeVisible({ timeout: UI_WAIT_MS });
      const optionsResponse = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault/unlock/passkey/options'), {
        timeout: UI_WAIT_MS,
      });
      await passkeyButton.click();
      const options: { credentials?: Array<{ prf_salt?: string }> } = await (await optionsResponse).json();
      const salts = (options.credentials ?? []).map((c) => c.prf_salt);
      expect(salts).toHaveLength(2);
      // Booleans on purpose: a failing toEqual would print the salts into the CI log.
      expect(new Set(salts).size === 2 && salts.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);

      await expect(page).toHaveURL(/\/app$/, { timeout: CRYPTO_WAIT_MS });
      await expectVaultOpen(page);
    });
  });
});
