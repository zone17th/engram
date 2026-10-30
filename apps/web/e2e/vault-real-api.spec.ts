import { expect, test, type Locator, type Page, type Response } from '@playwright/test';
import { PASSWORD, signupViaUi, uniqueEmail } from './helpers';

// Real-API vault spec (LANE-AC, advisor-dec-044, closes T1-1). The browser talks to the compose stack's real
// API and DB: no page.route / context.route for /api/v1/vault* or /api/v1/auth* lives in this file. The only
// auth routing is helpers.isolateRateLimit, which forwards cred-limited auth calls to the real API with a
// per-context client IP so the 5/min bucket is not shared (it never fulfills anything itself).
//
// Secrets: the recovery key, the passphrases and the login password live only in local variables. Nothing here
// screenshots, attaches, logs or puts them in an assertion message (assertions on secret text compare booleans, and
// every secret field is written via fillSecret(), whose evaluate() argument is not echoed in a Playwright call log).

const INITIAL_PASSPHRASE = 'Tràm-Hương-94!Kỷ-Vật-Xanh';
const WRONG_PASSPHRASE = 'wrong-passphrase-real-api-e2e-0';
const NEW_PASSPHRASE = 'Zk7$vQm2-Rn9&Tp4w-Lx8#Bd5y';
const RECOVERY_KEY_SHAPE = /^rk\d{1,2}_[0-7][0-9A-TV-Z]{3}(?:-[0-9A-TV-Z]{4}){5}-[0-9A-TV-Z]{2}$/;

// Argon2id runs in the real crypto Worker on a shared CI runner, so every derive-bound wait is generous.
const FLOW_TIMEOUT_MS = 300_000;
const CRYPTO_WAIT_MS = 90_000;
const UI_WAIT_MS = 30_000;

const isApiPost = (response: Response, pathname: string) =>
  response.request().method() === 'POST' && new URL(response.url()).pathname === pathname;

async function expectVaultOpen(page: Page) {
  await expect(page.locator('.vault-pill')).toHaveClass(/vault-open/, { timeout: CRYPTO_WAIT_MS });
}

async function expectVaultShut(page: Page) {
  await expect(page.locator('.vault-pill')).toHaveClass(/vault-shut/, { timeout: UI_WAIT_MS });
}

async function expectOnUnlockPage(page: Page) {
  await expect(page).toHaveURL(/\/app\/unlock$/, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('vault-unlock-page')).toBeVisible({ timeout: UI_WAIT_MS });
  await expectVaultShut(page);
}

/**
 * After a lock from /app the route guard keeps the user on the U5 list (advisor-dec-048): the banner offers the way to
 * the unlock page, which is then reached through the user's own click.
 */
async function expectLockedListThenOpenUnlock(page: Page) {
  await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
  await expectVaultShut(page);
  await page.getByTestId('vault-locked-unlock-cta').click();
  await expectOnUnlockPage(page);
}

async function submitUnlock(page: Page, passphrase: string) {
  await fillSecret(page.getByTestId('unlock-passphrase-input'), passphrase);
  await page.getByTestId('unlock-submit-button').click();
}

/**
 * Types a secret into a controlled React input without the value appearing in a Playwright call log: pinned
 * Playwright progress-logs the argument of fill(), which the list reporter prints on an actionability timeout
 * into the public CI log. The field is waited for first (visible, enabled, editable) so a failure still diagnoses.
 */
async function fillSecret(input: Locator, value: string) {
  await expect(input).toBeEditable({ timeout: CRYPTO_WAIT_MS });
  await input.evaluate((element, next) => {
    const field = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('HTMLInputElement value setter is missing');
    setter.call(field, next);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

test.describe('vault web against the real API', () => {
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  test('onboarding, lock, wrong then right unlock, recovery with the recovery key, unlock with the new passphrase', async ({
    page,
  }) => {
    test.setTimeout(FLOW_TIMEOUT_MS);

    const email = uniqueEmail('vault-real-api');
    let recoveryKey = '';

    await test.step('1. real signup lands on the onboarding guard (vault absent)', async () => {
      await signupViaUi(page, email, PASSWORD);
      await expect(page).toHaveURL(/\/app\/onboarding$/, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('onboarding-step-passphrase')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
      await expect(page.locator('.vault-pill')).toContainText('No vault yet');
    });

    await test.step('2. onboarding through the UI creates the vault with a real POST /vault', async () => {
      await fillSecret(page.getByLabel('Passphrase', { exact: true }), INITIAL_PASSPHRASE);
      await fillSecret(page.getByLabel('Confirm passphrase'), INITIAL_PASSPHRASE);
      await page.getByTestId('onboarding-continue-button').click();
      await expect(page.getByTestId('onboarding-step-recovery-keys')).toBeVisible({ timeout: CRYPTO_WAIT_MS });

      await expect(page.getByTestId('recovery-keys-grid').getByRole('listitem')).toHaveCount(10);
      recoveryKey = ((await page.getByTestId('recovery-key-slot-1').textContent()) ?? '').trim();
      // Boolean on purpose: a failing toMatch would print the key into the CI log.
      expect(RECOVERY_KEY_SHAPE.test(recoveryKey)).toBe(true);

      await page.getByTestId('recovery-keys-confirm-checkbox').check();
      const created = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault'), { timeout: CRYPTO_WAIT_MS });
      await page.getByTestId('onboarding-create-vault-button').click();
      expect((await created).ok()).toBe(true);

      await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
      await expectVaultOpen(page);
      const bodyText = await page.locator('body').innerText();
      expect(bodyText.includes(recoveryKey)).toBe(false);
    });

    await test.step('3. the lock button locks the vault', async () => {
      await page.getByTestId('vault-lock-button').click();
      await expectLockedListThenOpenUnlock(page);
    });

    await test.step('4. a wrong passphrase is rejected locally, the right one unlocks', async () => {
      await submitUnlock(page, WRONG_PASSPHRASE);
      await expect(page.getByTestId('unlock-error-incorrect-passphrase')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
      await expect(page).toHaveURL(/\/app\/unlock$/);
      await expectVaultShut(page);

      await submitUnlock(page, INITIAL_PASSPHRASE);
      await expect(page).toHaveURL(/\/app$/, { timeout: CRYPTO_WAIT_MS });
      await expectVaultOpen(page);
    });

    await test.step('5. forgot passphrase -> real re-auth -> recovery key lookup -> new passphrase -> unlocked', async () => {
      await page.getByTestId('vault-lock-button').click();
      await expectLockedListThenOpenUnlock(page);

      await page.getByTestId('unlock-forgot-passphrase-link').click();
      await expect(page).toHaveURL(/\/app\/unlock\/forgot$/, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('forgot-passphrase-page')).toBeVisible();
      await page.getByTestId('forgot-use-recovery-key-cta').click();
      await expect(page).toHaveURL(/\/app\/recovery$/, { timeout: UI_WAIT_MS });

      await expect(page.getByTestId('recovery-step-reauth')).toBeVisible({ timeout: UI_WAIT_MS });
      const reauthed = page.waitForResponse((r) => isApiPost(r, '/api/v1/auth/reauth'), { timeout: UI_WAIT_MS });
      await fillSecret(page.getByTestId('recovery-reauth-password-input'), PASSWORD);
      await page.getByTestId('recovery-reauth-password-submit').click();
      expect((await reauthed).ok()).toBe(true);

      await expect(page.getByTestId('recovery-step-enter-key')).toBeVisible({ timeout: UI_WAIT_MS });
      const lookedUp = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault/unlock/recovery'), {
        timeout: CRYPTO_WAIT_MS,
      });
      await fillSecret(page.getByTestId('recovery-key-input'), recoveryKey);
      await page.getByTestId('recovery-key-submit').click();
      expect((await lookedUp).ok()).toBe(true);

      await expect(page.getByTestId('recovery-step-new-passphrase')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
      await fillSecret(page.getByTestId('recovery-new-passphrase-input'), NEW_PASSPHRASE);
      await fillSecret(page.getByTestId('recovery-confirm-passphrase-input'), NEW_PASSPHRASE);
      const completed = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault/recover/complete'), {
        timeout: CRYPTO_WAIT_MS,
      });
      await page.getByTestId('recovery-step3-submit').click();
      expect((await completed).ok()).toBe(true);

      // The consumed key's slot is empty, so the flow now offers a replacement key; the vault is already open.
      await expect(page.getByTestId('recovery-step-regenerate-reauth')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
      await expectVaultOpen(page);

      await page.getByTestId('recovery-step4-skip-button').click();
      await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
      await expectVaultOpen(page);
    });

    await test.step('6. lock with L, the old passphrase is rejected, the new one unlocks', async () => {
      await expect(page.getByTestId('vault-lock-button')).toBeVisible({ timeout: UI_WAIT_MS });
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('L');
      await expectLockedListThenOpenUnlock(page);

      await submitUnlock(page, INITIAL_PASSPHRASE);
      await expect(page.getByTestId('unlock-error-incorrect-passphrase')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
      await expectVaultShut(page);

      await submitUnlock(page, NEW_PASSPHRASE);
      await expect(page).toHaveURL(/\/app$/, { timeout: CRYPTO_WAIT_MS });
      await expectVaultOpen(page);
    });
  });
});
