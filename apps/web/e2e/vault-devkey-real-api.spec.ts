import { expect, test, type Locator, type Page, type Response } from '@playwright/test';
import { PASSWORD, signupViaUi, uniqueEmail } from './helpers';

// LANE-AC real-API spec for Remember device (plan Task 18, silent unlock after reload). The browser talks to the compose
// stack's real API and database: no page.route / context.route for /api/v1/vault* or /api/v1/auth* lives in this file
// (helpers.isolateRateLimit, used by signupViaUi, only forwards cred-limited auth calls to the real API under a per-context
// client IP; it never fulfills anything itself). Gate: E2E_STACK, never E2E_API_URL.
//
// Remember / Forget are driven through the gated `window.__engramDeviceTestBridge` (no toggle UI exists before T16B / T17B /
// T20B); everything it does is the production code path (real Worker, real WebCrypto, real IndexedDB, real Web Lock).
//
// Secrets: the passphrase and the login password live only in local variables. Nothing here screenshots, attaches, logs or
// asserts on a secret; every secret field is written via fillSecret(), whose evaluate() argument is not echoed in a
// Playwright call log. The bridge only exposes booleans, counts and revisions: never DevKey material, VK or wraps.

const PASSPHRASE = 'Tràm-Hương-94!Kỷ-Vật-Xanh';
const FLOW_TIMEOUT_MS = 300_000;
const CRYPTO_WAIT_MS = 90_000;
const UI_WAIT_MS = 30_000;

interface RememberState {
  status: string;
  remembered: boolean;
  notice: string | null;
}

interface DeviceBridge {
  remember: () => Promise<RememberState>;
  forget: () => Promise<RememberState>;
  refresh: () => Promise<RememberState>;
  snapshot: () => Promise<{ userRecordCount: number; allRecordCount: number }>;
}

interface VaultBridge {
  reloadVaultMeta: () => Promise<unknown>;
}

type DeviceWindow = Window & {
  __engramDeviceTestBridge?: DeviceBridge;
  __engramVaultTestBridge?: VaultBridge;
};

const isApiGet = (response: Response, pathname: string) =>
  response.request().method() === 'GET' && new URL(response.url()).pathname === pathname;
const isApiPost = (response: Response, pathname: string) =>
  response.request().method() === 'POST' && new URL(response.url()).pathname === pathname;

async function expectVaultOpen(page: Page) {
  await expect(page.locator('.vault-pill')).toHaveClass(/vault-open/, { timeout: CRYPTO_WAIT_MS });
}

async function expectOnUnlockPage(page: Page) {
  await expect(page).toHaveURL(/\/app\/unlock$/, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('vault-unlock-page')).toBeVisible({ timeout: UI_WAIT_MS });
  await expect(page.locator('.vault-pill')).toHaveClass(/vault-shut/, { timeout: UI_WAIT_MS });
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

async function waitForDeviceBridge(page: Page) {
  await page.waitForFunction(() => {
    const testWindow: DeviceWindow = window;
    return Boolean(testWindow.__engramDeviceTestBridge && testWindow.__engramVaultTestBridge);
  });
}

async function rememberViaBridge(page: Page): Promise<RememberState> {
  await waitForDeviceBridge(page);
  return page.evaluate(async () => {
    const testWindow: DeviceWindow = window;
    // Make the provider learn the current vault_key_id from the real GET /vault (as any page that read the vault does).
    await testWindow.__engramVaultTestBridge!.reloadVaultMeta();
    return testWindow.__engramDeviceTestBridge!.remember();
  });
}

test.describe('Remember device against the real API', () => {
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  test('onboarding, Remember, reload -> silent unlock after the real GET /vault, manual lock stays locked, Forget -> reload needs the passphrase', async ({
    page,
  }) => {
    test.setTimeout(FLOW_TIMEOUT_MS);
    const email = uniqueEmail('vault-devkey');

    await test.step('1. real signup, onboarding creates the vault with a real POST /vault', async () => {
      await signupViaUi(page, email, PASSWORD);
      await expect(page).toHaveURL(/\/app\/onboarding$/, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('onboarding-step-passphrase')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
      await fillSecret(page.getByLabel('Passphrase', { exact: true }), PASSPHRASE);
      await fillSecret(page.getByLabel('Confirm passphrase'), PASSPHRASE);
      await page.getByTestId('onboarding-continue-button').click();
      await expect(page.getByTestId('onboarding-step-recovery-keys')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
      await expect(page.getByTestId('recovery-keys-grid').getByRole('listitem')).toHaveCount(10);
      await page.getByTestId('recovery-keys-confirm-checkbox').check();
      const created = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault'), { timeout: CRYPTO_WAIT_MS });
      await page.getByTestId('onboarding-create-vault-button').click();
      expect((await created).ok()).toBe(true);
      await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
      await expectVaultOpen(page);
    });

    await test.step('2. default off, then Remember stores exactly one DevKey record in the real IndexedDB', async () => {
      await waitForDeviceBridge(page);
      const before = await page.evaluate(() => (window as DeviceWindow).__engramDeviceTestBridge!.snapshot());
      expect(before.allRecordCount).toBe(0);

      const state = await rememberViaBridge(page);
      expect(state.status).toBe('ready');
      expect(state.remembered).toBe(true);
      expect(state.notice).toBeNull();
      const after = await page.evaluate(() => (window as DeviceWindow).__engramDeviceTestBridge!.snapshot());
      expect(after.userRecordCount).toBe(1);
    });

    await test.step('3. reload: the real GET /vault is read, then the vault opens WITHOUT a passphrase', async () => {
      const vaultRead = page.waitForResponse((r) => isApiGet(r, '/api/v1/vault') && r.ok(), { timeout: CRYPTO_WAIT_MS });
      await page.reload();
      expect(await vaultRead).toBeTruthy();
      await expectVaultOpen(page);
      await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('unlock-passphrase-input')).toHaveCount(0);
    });

    await test.step('4. a manual lock is not silently re-opened by the remembered device', async () => {
      await page.getByTestId('vault-lock-button').click();
      await expectOnUnlockPage(page);
      await page.waitForTimeout(1500);
      await expectOnUnlockPage(page);
    });

    await test.step('5. Forget deletes the record; the next reload asks for the passphrase', async () => {
      await waitForDeviceBridge(page);
      const forgotten = await page.evaluate(() => (window as DeviceWindow).__engramDeviceTestBridge!.forget());
      expect(forgotten.remembered).toBe(false);
      const snapshot = await page.evaluate(() => (window as DeviceWindow).__engramDeviceTestBridge!.snapshot());
      expect(snapshot.allRecordCount).toBe(0);

      await page.reload();
      await expectOnUnlockPage(page);
      await fillSecret(page.getByTestId('unlock-passphrase-input'), PASSPHRASE);
      await page.getByTestId('unlock-submit-button').click();
      await expect(page).toHaveURL(/\/app$/, { timeout: CRYPTO_WAIT_MS });
      await expectVaultOpen(page);
    });
  });
});
