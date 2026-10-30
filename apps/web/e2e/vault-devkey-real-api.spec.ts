import { expect, test, type Locator, type Page, type Response } from '@playwright/test';
import { PASSWORD, isolateRateLimit, uniqueEmail, waitForAuthPageReady } from './helpers';

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

async function expectLockedListOnApp(page: Page) {
  await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
  await expect(page.locator('.vault-pill')).toHaveAttribute('data-vault-state', 'locked', { timeout: UI_WAIT_MS });
  await expect(page.locator('.vault-pill')).toHaveClass(/vault-shut/, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('entry-body')).toHaveCount(0);
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

async function quietSignupViaUi(page: Page, email: string, password = PASSWORD) {
  await isolateRateLimit(page);
  await page.goto('/app/auth/signup');
  await waitForAuthPageReady(page);
  await page.getByLabel('Email').fill(email);
  await fillSecret(page.getByLabel(/Login password|Mật khẩu đăng nhập/), password);
  await page.getByRole('checkbox', { name: /agree|terms|điều khoản/i }).check();
  await page.getByRole('button', { name: /Create account|Tạo tài khoản/ }).click();
  const outcome = await Promise.race([
    page.waitForURL(/\/app\/(onboarding|auth\/verify-email)/, { timeout: UI_WAIT_MS }).then(() => 'ok' as const),
    page.getByTestId('auth-error-card').waitFor({ state: 'visible', timeout: UI_WAIT_MS }).then(() => 'err' as const),
  ]).catch(() => 'timeout' as const);
  if (outcome === 'err') {
    const text = await page.getByTestId('auth-error-card').innerText();
    throw new Error(`signup failed: ${text}`);
  }
  if (outcome !== 'ok') {
    throw new Error('signup did not reach onboarding or verify-email');
  }
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
      await quietSignupViaUi(page, email, PASSWORD);
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

    await test.step('3. reload (and /app/unlock?returnTo): the real GET /vault is read, then the vault opens WITHOUT a passphrase, honoring sanitized returnTo and rejecting unsafe returnTo', async () => {
      const vaultRead = page.waitForResponse((r) => isApiGet(r, '/api/v1/vault') && r.ok(), { timeout: CRYPTO_WAIT_MS });
      await page.reload();
      expect(await vaultRead).toBeTruthy();
      await expectVaultOpen(page);
      await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('unlock-passphrase-input')).toHaveCount(0);

      // R1-4 / R1-23: reload `/app/unlock?returnTo=%2Fapp%2Fsettings` -> automatic silent unlock ends at `/app/settings`.
      const settingsVaultRead = page.waitForResponse((r) => isApiGet(r, '/api/v1/vault') && r.ok(), {
        timeout: CRYPTO_WAIT_MS,
      });
      await page.goto('/app/unlock?returnTo=%2Fapp%2Fsettings');
      expect(await settingsVaultRead).toBeTruthy();
      await expectVaultOpen(page);
      await expect(page).toHaveURL(/\/app\/settings$/, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('unlock-passphrase-input')).toHaveCount(0);

      // Unsafe returnTo (e.g. external URL or protocol-relative URL) is rejected -> falls back to `/app`.
      const unsafeVaultRead = page.waitForResponse((r) => isApiGet(r, '/api/v1/vault') && r.ok(), {
        timeout: CRYPTO_WAIT_MS,
      });
      await page.goto('/app/unlock?returnTo=https%3A%2F%2Fevil.example%2Fphish');
      expect(await unsafeVaultRead).toBeTruthy();
      await expectVaultOpen(page);
      await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('unlock-passphrase-input')).toHaveCount(0);
    });

    await test.step('4. a manual lock is not silently re-opened by the remembered device', async () => {
      await page.getByTestId('vault-lock-button').click();
      // Under advisor-dec-048 (P03-T21), locking on `/app` stays on `/app` and renders the locked U5 state.
      await expectLockedListOnApp(page);
      await page.waitForTimeout(1500);
      await expectLockedListOnApp(page);
    });

    await test.step('5. Forget deletes the record; the next reload asks for the passphrase', async () => {
      await waitForDeviceBridge(page);
      const forgotten = await page.evaluate(() => (window as DeviceWindow).__engramDeviceTestBridge!.forget());
      expect(forgotten.remembered).toBe(false);
      const snapshot = await page.evaluate(() => (window as DeviceWindow).__engramDeviceTestBridge!.snapshot());
      expect(snapshot.allRecordCount).toBe(0);

      await page.reload();
      await expectLockedListOnApp(page);
      await page.waitForTimeout(1500);
      await expectLockedListOnApp(page);
      const afterReloadSnapshot = await page.evaluate(() => (window as DeviceWindow).__engramDeviceTestBridge!.snapshot());
      expect(afterReloadSnapshot.allRecordCount).toBe(0);

      await page.getByTestId('vault-locked-unlock-cta').click();
      await expectOnUnlockPage(page);
      await fillSecret(page.getByTestId('unlock-passphrase-input'), PASSPHRASE);
      await page.getByTestId('unlock-submit-button').click();
      await expect(page).toHaveURL(/\/app$/, { timeout: CRYPTO_WAIT_MS });
      await expectVaultOpen(page);
    });
  });
});
