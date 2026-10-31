import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { PASSWORD, newContext, patchSettingsViaPage, uniqueEmail } from './helpers';
import { fillSecret } from './vault-settings-secret';
import {
  CRYPTO_WAIT_MS,
  UI_WAIT_MS,
  VAULT_PASSPHRASE,
  addAuthenticator,
  enableWebAuthn,
  expectPasskeyAdded,
  expectVaultOpen,
  expectVaultShut,
  gotoSettings,
  installPasskeyProbe,
  isApiGet,
  lockVault,
  openAddPasskeyDialog,
  readProbe,
  submitPasskeyName,
} from './vault-passkey-support';
import {
  RECOVERED_PASSPHRASE,
  REWRAPPED_PASSPHRASE,
  acquireGrantViaPage,
  completeRecoveryWithNewPassphrase,
  createVaultViaOnboarding,
  deleteVaultViaPage,
  deviceRecordCount,
  expectLockedListOnApp,
  expectNoRecoveryKeyInDom,
  expectPassphraseRejected,
  expectUnlockedOnApp,
  fetchVaultMetaViaPage,
  autoLockMinutesOf,
  jsonField,
  type OnboardingKeys,
  freshRateBucket,
  isRecoveryKeyShape,
  journeyStep,
  loginViaUiSecret,
  openRecoveryFromUnlock,
  openUnlockFromLockedList,
  readRecoveryKeySlot,
  readVaultObservables,
  rememberViaBridge,
  reloadUnlockPage,
  signupOauthUser,
  signupPasswordUser,
  submitRecoveryKey,
  submitUnlock,
  unlockFromLockedList,
} from './vault-journey-support';

// P03-T23 Part 2, stage J1: the vault journey of plan Task 23 bullet 1 against the compose stack's real API and
// database (E2E_STACK), in the `vault` Playwright project. The compose web service is the production build (`next
// build` + `next start`), so every request below already goes through the production Next proxy.
//
// No page.route / context.route for /api/** lives in this file or in vault-journey-support.ts (helpers.isolateRateLimit,
// used by the login/signup helpers, only forwards cred-limited auth calls to the real API under a per-context client
// IP; it never fulfills anything itself). Gate: E2E_STACK, never E2E_API_URL.
//
// Secrets: passphrases, login password, recovery keys and grant tokens only live in local variables, every secret field
// is written with fillSecret(), recovery keys are compared through booleans only, and nothing is screenshotted or
// attached. The recovery key used for recovery is the one this test generated and read from the onboarding sheet.
//
// Runs under both AUTH_REQUIRE_EMAIL_VERIFICATION values: `e2e-browser` (false) through the vault project, and the
// `Vault journey e2e (email verification required)` job (true), where signup goes through the mail-sink confirmation.

// Argon2id runs in the real crypto Worker on a shared CI runner. The journey has ~15 derive-bound steps (onboarding,
// 2 unlocks, rewrap, 3 rejected/accepted unlocks, recovery lookup + new passphrase, regenerate, rotate, passkey, auto-lock
// unlock) at <= 90 s each in the worst case; the expected total is a few minutes, so 10 min is the ceiling, not the plan.
const JOURNEY_TIMEOUT_MS = 600_000;
const OAUTH_TIMEOUT_MS = 300_000;
const AUTO_LOCK_MINUTES = 5;

async function closeAll(contexts: BrowserContext[]) {
  for (const context of contexts) {
    await context.close().catch(() => undefined);
  }
}

test.describe('vault journey against the real API', () => {
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  test('signup -> onboarding -> reload -> new-context unlock -> rewrap -> recovery -> regenerate -> rotate -> passkey -> DevKey -> auto-lock -> reset, with a prod-proxy If-Match 412 then success', async ({
    browser,
  }) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS);
    const email = uniqueEmail('vault-journey');
    const contexts: BrowserContext[] = [];
    // The passphrase the vault currently answers to (changes at rewrap and at recovery).
    let passphrase = VAULT_PASSPHRASE;
    let pageA: Page;
    let pageB: Page;
    let keys: OnboardingKeys;

    try {
      const contextA = await newContext(browser);
      contexts.push(contextA);
      pageA = await contextA.newPage();

      await journeyStep('1. signup (password user)', async () => {
        await signupPasswordUser(pageA, email);
        await expect(pageA.locator('.vault-pill').first()).toContainText('No vault yet');
      });

      await journeyStep('2. onboarding: passphrase + recovery-key sheet creates the vault (real POST /vault)', async () => {
        keys = await createVaultViaOnboarding(pageA, passphrase);
      });

      await journeyStep('3. reload: the vault is locked and the unlock prompt is offered (advisor-dec-048)', async () => {
        await pageA.reload();
        await expectLockedListOnApp(pageA);
        await openUnlockFromLockedList(pageA);
        await expect(pageA.getByTestId('unlock-passphrase-input')).toBeVisible({ timeout: UI_WAIT_MS });
      });

      const contextB = await newContext(browser);
      contexts.push(contextB);
      // Installed before the first page of the context so every navigation records the WebAuthn call shapes (passkey step).
      await installPasskeyProbe(contextB);
      pageB = await contextB.newPage();

      await journeyStep('4. unlock in a NEW browser context (same user, login)', async () => {
        await loginViaUiSecret(pageB, email);
        await expectLockedListOnApp(pageB);
        await unlockFromLockedList(pageB, passphrase);
        // Context A is done: the journey continues in B, the context a returning user would have opened.
        await contextA.close();
      });

      await journeyStep('5. rewrap: change the passphrase in Settings; the old one fails, the new one unlocks', async () => {
        await freshRateBucket(pageB);
        await gotoSettings(pageB);
        await pageB.locator('[data-open-dialog="passDlg"]').click();
        const dialog = pageB.getByRole('dialog');
        await expect(dialog).toBeVisible({ timeout: UI_WAIT_MS });
        await fillSecret(dialog.locator('#pass-login-pwd'), PASSWORD, UI_WAIT_MS);
        await fillSecret(dialog.locator('#pass-new-pp'), REWRAPPED_PASSPHRASE, UI_WAIT_MS);
        await fillSecret(dialog.locator('#pass-confirm-pp'), REWRAPPED_PASSPHRASE, UI_WAIT_MS);
        const rewrapped = pageB.waitForResponse(
          (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/v1/vault/kek',
          { timeout: CRYPTO_WAIT_MS },
        );
        await dialog.getByRole('button', { name: /Change passphrase|Đổi passphrase/ }).click();
        const rewrapResponse = await rewrapped;
        expect(rewrapResponse.ok()).toBe(true);
        // create = version 1, rewrap = 2 (plan section 3: rewrap bumps the version).
        expect(await jsonField(rewrapResponse, 'version')).toBe(2);
        await expect(dialog.locator('[data-view="pass-done"]')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
        await dialog.getByRole('button', { name: /Done|Xong/ }).click();
        await expect(dialog).toBeHidden({ timeout: UI_WAIT_MS });

        await lockVault(pageB);
        await reloadUnlockPage(pageB);
        await expectPassphraseRejected(pageB, passphrase);
        passphrase = REWRAPPED_PASSPHRASE;
        await submitUnlock(pageB, passphrase);
        await expectUnlockedOnApp(pageB);
      });

      await journeyStep('6. recovery with the test-generated recovery key (forgot flow, new passphrase)', async () => {
        await freshRateBucket(pageB);
        await lockVault(pageB);
        await openRecoveryFromUnlock(pageB, { kind: 'password' });
        const lookup = await submitRecoveryKey(pageB, keys.slot1);
        expect(lookup.ok()).toBe(true);
        expect(await completeRecoveryWithNewPassphrase(pageB, RECOVERED_PASSPHRASE)).toBe(3);

        await lockVault(pageB);
        await reloadUnlockPage(pageB);
        await expectPassphraseRejected(pageB, passphrase);
        passphrase = RECOVERED_PASSPHRASE;
        await submitUnlock(pageB, passphrase);
        await expectUnlockedOnApp(pageB);
      });

      await journeyStep('7. regenerate the consumed recovery key slot (Settings)', async () => {
        await freshRateBucket(pageB);
        await gotoSettings(pageB);
        // Recovery consumed one key: 9 of 10 left, one empty slot to regenerate.
        await expect(pageB.getByTestId('recovery-keys-remaining-badge')).toHaveText(/^9 of 10 left$/, {
          timeout: CRYPTO_WAIT_MS,
        });
        await pageB.locator('[data-open-dialog="rkDlg"]').click();
        const dialog = pageB.getByRole('dialog');
        await expect(dialog).toBeVisible({ timeout: UI_WAIT_MS });
        await fillSecret(dialog.locator('#rk-reauth-pwd'), PASSWORD, UI_WAIT_MS);
        await dialog.getByRole('button', { name: /Continue|Tiếp tục/ }).click();
        await expect(dialog.getByTestId('recovery-keys-grid')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
        await expect(dialog.getByRole('listitem')).toHaveCount(1, { timeout: UI_WAIT_MS });
        // The new key has the RK shape and is not the key this journey just consumed.
        const regenerated = await readRecoveryKeySlot(pageB, 1);
        expect(regenerated !== keys.slot1).toBe(true);
        await dialog.getByRole('checkbox').check();
        await dialog.locator('#rkRegenDoneBtn').click();
        await expect(dialog).toBeHidden({ timeout: CRYPTO_WAIT_MS });
        await expect(pageB.getByTestId('recovery-keys-remaining-badge')).toHaveText(/^10 of 10 left$/, {
          timeout: UI_WAIT_MS,
        });
        await expectNoRecoveryKeyInDom(pageB);
      });

      await journeyStep('8. rotate all 10 recovery keys; a key from before the rotation is rejected', async () => {
        await freshRateBucket(pageB);
        await pageB.locator('[data-open-dialog="rotateDlg"]').click();
        const dialog = pageB.getByRole('dialog');
        await expect(dialog).toBeVisible({ timeout: UI_WAIT_MS });
        await fillSecret(dialog.locator('#rot-reauth-pwd'), PASSWORD, UI_WAIT_MS);
        await dialog.getByRole('button', { name: /Continue|Tiếp tục/ }).click();
        await expect(dialog.getByTestId('recovery-keys-grid')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
        await expect(dialog.getByRole('listitem')).toHaveCount(10, { timeout: UI_WAIT_MS });
        const rotatedSlot2 = await readRecoveryKeySlot(pageB, 2);
        expect(rotatedSlot2 !== keys.slot2).toBe(true);
        await dialog.getByRole('checkbox').check();
        await dialog.locator('#rkRotateConfirmBtn').click();
        await expect(dialog).toBeHidden({ timeout: CRYPTO_WAIT_MS });
        await expect(pageB.getByTestId('recovery-keys-remaining-badge')).toHaveText(/^10 of 10 left$/, {
          timeout: UI_WAIT_MS,
        });
        await expectNoRecoveryKeyInDom(pageB);

        // Slot 2 of the onboarding sheet was valid and unused before the rotation; the real lookup now refuses it.
        await lockVault(pageB);
        await openRecoveryFromUnlock(pageB, { kind: 'password' });
        const rejected = await submitRecoveryKey(pageB, keys.slot2);
        expect(rejected.status()).toBe(401);
        expect(await jsonField(rejected, 'code')).toBe('recovery_key_invalid');
        await expect(pageB.getByTestId('recovery-error-invalid-key')).toBeVisible({ timeout: UI_WAIT_MS });
        await pageB.goto('/app/unlock');
        await submitUnlock(pageB, passphrase);
        await expectUnlockedOnApp(pageB);
      });

      await journeyStep('9. passkey: register (virtual authenticator with PRF) and unlock with it', async () => {
        await freshRateBucket(pageB);
        const cdp = await enableWebAuthn(pageB);
        await addAuthenticator(cdp, { hasPrf: true, isUserVerified: true });
        await gotoSettings(pageB);
        await openAddPasskeyDialog(pageB);
        const before = await readProbe(pageB);
        await submitPasskeyName(pageB, 'Journey passkey');
        await expectPasskeyAdded(pageB);

        const after = await readProbe(pageB);
        const created = after.creates.at(-1);
        expect(created?.error).toBeNull();
        expect(created?.prfEnabled).toBe(true);
        const followUpGets = after.gets.slice(before.gets.length);
        // advisor-dec-059: the raw Actions log records which PRF path Chrome's virtual authenticator takes.
        if (created?.prfFirst) {
          expect(followUpGets).toHaveLength(0);
          console.log('prf-path: direct');
          test.info().annotations.push({ type: 'prf-path', description: 'output directly at create()' });
        } else {
          expect(followUpGets).toHaveLength(1);
          expect(followUpGets[0]?.error).toBeNull();
          expect(followUpGets[0]?.prfFirst).toBe(true);
          console.log('prf-path: enabled-then-get');
          test.info().annotations.push({ type: 'prf-path', description: 'enabled at create(), then get()' });
        }
        // TODO(J2): assert the new row in the Settings passkey list once T20B ships it.

        await lockVault(pageB);
        const passkeyButton = pageB.getByTestId('unlock-passkey-button');
        await expect(passkeyButton).toBeVisible({ timeout: UI_WAIT_MS });
        await passkeyButton.click();
        await expectUnlockedOnApp(pageB);
      });

      await journeyStep('10. DevKey: Remember device, reload -> silent unlock without a passphrase', async () => {
        const state = await rememberViaBridge(pageB);
        expect(state.status).toBe('ready');
        expect(state.remembered).toBe(true);
        expect(state.notice).toBeNull();
        expect((await deviceRecordCount(pageB)).userRecordCount).toBe(1);

        const vaultRead = pageB.waitForResponse((r) => isApiGet(r, '/api/v1/vault') && r.ok(), {
          timeout: CRYPTO_WAIT_MS,
        });
        await pageB.reload();
        expect(await vaultRead).toBeTruthy();
        await expectVaultOpen(pageB);
        await expect(pageB).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
        await expect(pageB.getByTestId('unlock-passphrase-input')).toHaveCount(0);
      });

      await journeyStep(`11. auto-lock: auto_lock_minutes=${AUTO_LOCK_MINUTES} through PATCH /me/settings, the clock passes the idle deadline, the vault locks`, async () => {
        // A fresh context whose clock is installed before any page loads, so the app's idle timer runs on fake time.
        // TODO(J2): set the timeout through the Settings auto-lock card instead of PATCH /me/settings.
        const contextC = await newContext(browser);
        contexts.push(contextC);
        await contextC.clock.install();
        const pageC = await contextC.newPage();

        await loginViaUiSecret(pageC, email);
        await expectLockedListOnApp(pageC);
        const patched = await patchSettingsViaPage(pageC, { auto_lock_minutes: AUTO_LOCK_MINUTES });
        expect(patched.status).toBe(200);
        expect(autoLockMinutesOf(patched.body)).toBe(AUTO_LOCK_MINUTES);

        // The provider reads the server's value at page load: reload, then unlock.
        await pageC.reload();
        await expectLockedListOnApp(pageC);
        await unlockFromLockedList(pageC, passphrase);
        await expect
          .poll(async () => (await readVaultObservables(pageC)).autoLockMinutes, { timeout: UI_WAIT_MS })
          .toBe(AUTO_LOCK_MINUTES);

        // Past the idle deadline (no input since unlock), the shared timer fires on fake time.
        await contextC.clock.fastForward(AUTO_LOCK_MINUTES * 60_000 + 30_000);
        await expect
          .poll(
            async () => {
              const observed = await readVaultObservables(pageC);
              return { state: observed.state, workerState: observed.workerState };
            },
            { timeout: UI_WAIT_MS },
          )
          .toEqual({ state: 'locked', workerState: 'locked' });
        await expectVaultShut(pageC);
        await expect(pageC.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
        await contextC.close();
      });

      await journeyStep('12. reset the vault in Settings (stale If-Match -> 412, fresh If-Match -> success through the prod proxy)', async () => {
        await freshRateBucket(pageB);
        await gotoSettings(pageB);

        // Version bookkeeping of the journey: create 1, rewrap 2, recover 3, regenerate 4, rotate 5; the passkey adds a
        // row but no version (plan section 3).
        const meta = await fetchVaultMetaViaPage(pageB);
        expect(meta.status).toBe(200);
        expect(meta.version).toBe(5);
        expect(meta.recoveryKeysRemaining).toBe(10);
        expect(meta.passkeyCount).toBe(1);
        expect(meta.vaultKeyId).toMatch(/^vk:[A-Za-z0-9_-]{22}$/);
        const vaultKeyId = meta.vaultKeyId as string;
        const version = meta.version as number;

        // Same-origin DELETE /api/v1/vault through the production Next proxy with a stale version: 412, nothing changes.
        const grant = await acquireGrantViaPage(pageB, 'vault.reset', PASSWORD);
        expect(grant.status).toBe(200);
        expect(grant.grant).not.toBeNull();
        const stale = await deleteVaultViaPage(pageB, {
          grant: grant.grant as string,
          ifMatch: `"${vaultKeyId}:${version - 1}"`,
        });
        expect(stale.status).toBe(412);
        expect(stale.code).toBe('version_mismatch');
        expect(stale.currentVersion).toBe(version);
        const afterStale = await fetchVaultMetaViaPage(pageB);
        expect(afterStale.status).toBe(200);
        expect(afterStale.version).toBe(version);

        // The Reset dialog sends the fresh version through the same proxy.
        await pageB.locator('[data-open-dialog="resetDlg"]').click();
        const dialog = pageB.getByRole('dialog');
        await expect(dialog).toBeVisible({ timeout: UI_WAIT_MS });
        await dialog.getByRole('button', { name: /None of these work|Không đường nào dùng được/ }).click();
        await dialog.getByRole('button', { name: /Checked backups|Đã kiểm tra backup/ }).click();
        await fillSecret(dialog.locator('#rst-reauth-pwd'), PASSWORD, UI_WAIT_MS);
        await dialog.getByRole('button', { name: /Continue|Tiếp tục/ }).click();
        await dialog.locator('#rst-confirm-word').fill('RESET');
        await expect(dialog.locator('#rstConfirmBtn')).toBeEnabled({ timeout: UI_WAIT_MS });
        const resetResponse = pageB.waitForResponse(
          (r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname === '/api/v1/vault',
          { timeout: CRYPTO_WAIT_MS },
        );
        await dialog.locator('#rstConfirmBtn').click();
        const fresh = await resetResponse;
        // Booleans on purpose: the If-Match value carries the vault_key_id.
        expect(fresh.request().headers()['if-match'] === `"${vaultKeyId}:${version}"`).toBe(true);
        expect(fresh.status()).toBe(204);
        console.log(`if-match: DELETE /api/v1/vault stale=${stale.status} fresh=${fresh.status()}`);

        await expect(dialog.locator('[data-view="rst-s5"]')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
        await expect(pageB.locator('.vault-pill').first()).toContainText(/No vault yet|Chưa tạo kho/, {
          timeout: UI_WAIT_MS,
        });
        const gone = await fetchVaultMetaViaPage(pageB);
        expect(gone.status).toBe(404);
        expect(gone.code).toBe('vault_absent');
        // Onboarding is offered again.
        await dialog.getByRole('link', { name: /Create new vault|Tạo vault mới/ }).click();
        await expect(pageB).toHaveURL(/\/app\/onboarding$/, { timeout: UI_WAIT_MS });
        await expect(pageB.getByTestId('onboarding-step-passphrase')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
      });
    } finally {
      await closeAll(contexts);
    }
  });

  test('OAuth-only user: create a vault, recover with its test-generated recovery key (Google re-auth, new passphrase), unlock with the new passphrase', async ({
    browser,
  }) => {
    // Onboarding + recovery lookup + new-passphrase derive + two unlocks + the fake-OAuth redirect: ~6 derive-bound steps.
    test.setTimeout(OAUTH_TIMEOUT_MS);
    const email = uniqueEmail('vault-journey-oauth');
    const subject = `sub-${email}`;
    const context = await newContext(browser);
    try {
      const page = await context.newPage();
      let slot1 = '';

      await journeyStep('OAuth-1. OAuth-only signup and onboarding create the vault', async () => {
        await signupOauthUser(page, email, subject);
        const keys = await createVaultViaOnboarding(page, VAULT_PASSPHRASE);
        slot1 = keys.slot1;
        expect(isRecoveryKeyShape(slot1)).toBe(true);
      });

      await journeyStep('OAuth-2. forgot flow: Google re-auth, the test-generated recovery key, a new passphrase', async () => {
        await lockVault(page);
        await openRecoveryFromUnlock(page, { kind: 'oauth', email, subject });
        const lookup = await submitRecoveryKey(page, slot1);
        expect(lookup.ok()).toBe(true);
        expect(await completeRecoveryWithNewPassphrase(page, RECOVERED_PASSPHRASE)).toBe(2);
      });

      await journeyStep('OAuth-3. the old passphrase is rejected and the new one unlocks', async () => {
        await lockVault(page);
        await reloadUnlockPage(page);
        await expectPassphraseRejected(page, VAULT_PASSPHRASE);
        await submitUnlock(page, RECOVERED_PASSPHRASE);
        await expectUnlockedOnApp(page);
      });
    } finally {
      await context.close().catch(() => undefined);
    }
  });
});
