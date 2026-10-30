import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * ADR 0003 "Hệ quả" two-page / two-Worker test for Remember (plan Task 18, FE R3-5).
 *
 * Tab B (its own real crypto Worker, unlocked with the committed js-v1 test vector) starts Remember through the gated
 * `window.__engramDeviceTestBridge`, captures `(startIncarnation, startRevision)` (first-time meta init included) and is
 * PARKED right after WebCrypto. Tab A (same browser context, so the same real IndexedDB `sabk.device`) then runs Forget /
 * reset / revoked purge (known and unknown user_id) / a deleted-and-re-created DB. When B resumes, its final readwrite tx
 * must abort: no DevKey record exists in `sabk.device`, and B's toggle re-reads off with the neutral notice.
 *
 * `/api/v1/auth` and `/api/v1/vault` are stubbed here on purpose (the real-API spec is vault-devkey-real-api.spec.ts).
 * Only booleans, counts and revisions leave the pages: no DevKey material, VK or wrap is read, logged or attached.
 */

const TEST_VECTOR_PASSPHRASE = 'correct-horse-battery-staple-engram-js-v1';
const TEST_VECTOR_KDF = {
  alg: 'argon2id13' as const,
  ops: 3,
  mem: 67_108_864,
  parallelism: 1,
  salt: 'oKGio6SlpqeoqaqrrK2urw',
};
const TEST_VECTOR_WRAPPED_VK =
  'AbCxsrO0tba3uLm6u7y9vr_AwcLDxMXGxyfYfNv-vuDRS6i3Up5z_wCEX2cLt1xXgujuY7dGa_eirv2y5QQSBXkKR95PrK-ilA';
const TEST_VECTOR_WRAPPED_PRIV =
  'AeDh4uPk5ebn6Onq6-zt7u_w8fLz9PX299I6ypcubNr8Ofy8RwtQE-3gVPZ1cTrHgeO1ZMoyFkOJgqz7gG75ofa4qHejTdUrskM0hqoPmKH-rt_ZLSoHn2BH9MF-TUGyovpu_punj7v-';
const TEST_VECTOR_VAULT_KEY_ID = 'vk:7f3a9b2c4d5e6f7a8b9c0d';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CRYPTO_WAIT_MS = 60_000;

interface RememberState {
  status: string;
  remembered: boolean;
  busy: boolean;
  notice: string | null;
  lastAbortReason: string | null;
  meta: { incarnation: string; deviceRevision: number } | null;
}

interface DeviceBridge {
  startPausedRemember: () => void;
  isPausedAtWebCrypto: () => boolean;
  release: () => void;
  awaitRemember: () => Promise<RememberState>;
  remember: () => Promise<RememberState>;
  forget: () => Promise<RememberState>;
  purge: (scope: 'known' | 'unknown_user') => Promise<{ ok: boolean }>;
  state: () => RememberState;
  refresh: () => Promise<RememberState>;
  snapshot: () => Promise<{
    userRecordCount: number;
    allRecordCount: number;
    meta: { incarnation: string; deviceRevision: number } | null;
  }>;
}

interface VaultBridge {
  serverVaultStatus: string;
  beginOp: () => { opGeneration: number };
  unlockPassphrase: (params: Record<string, unknown>) => Promise<{ unlocked: true }>;
  reloadVaultMeta: () => Promise<unknown>;
}

/** The gated test globals the vault provider installs on loopback / non-production builds. */
type DeviceWindow = Window & {
  __engramDeviceTestBridge?: DeviceBridge;
  __engramVaultTestBridge?: VaultBridge;
};

async function installAuthenticatedVaultApiMocks(context: BrowserContext) {
  await context.route('**/api/v1/auth/csrf', async (route) => {
    await route.fulfill({
      status: 204,
      headers: { 'set-cookie': 'sabk_csrf=v1.sess.e2e-devkey-csrf.sig.extra; Path=/; SameSite=Lax' },
    });
  });
  await context.route('**/api/v1/auth/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ oauth_providers: [], email_verification_required: false, captcha_site_key: null }),
    });
  });
  await context.route('**/api/v1/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: USER_ID, email: 'devkey-e2e@example.test', email_verified: true, created_at: '2026-10-28T00:00:00Z' },
        settings: { locale: 'vi', theme: 'light', auto_lock_minutes: 0, semantic_suggest: false },
        identities: [{ provider: 'password', linked_at: '2026-10-28T00:00:00Z' }],
        features: {
          semantic_available: false,
          email_verification_required: false,
          oauth_providers: [],
          oauth_reauth_providers: [],
          password_enrollment_available: false,
          captcha_site_key: null,
        },
        vault: { status: 'present' },
      }),
    });
  });
  for (const [pattern, body] of [
    ['**/api/v1/auth/sessions', { items: [] }],
    ['**/api/v1/auth/audit*', { items: [] }],
    ['**/api/v1/me/notifications*', { items: [], unread_count: 0 }],
    ['**/api/v1/readyz', { status: 'ok', semantic_available: false }],
  ] as const) {
    await context.route(pattern, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
  }
  await context.route('**/api/v1/vault', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: 1,
        vault_key_id: TEST_VECTOR_VAULT_KEY_ID,
        kdf: TEST_VECTOR_KDF,
        vault_key_wrapped_by_kek: TEST_VECTOR_WRAPPED_VK,
        private_keys_wrapped: TEST_VECTOR_WRAPPED_PRIV,
        public_keys: {
          x25519: 'EIT5fcwxJb3Sw8y-V9yHL-JGU5pDVlgw9H5ueCV7OnI',
          ed25519: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
        },
        recovery_keys: { total: 10, remaining: 10, used_slots: [], low_warning: false },
        passkeys: [],
      }),
    });
  });
}

async function waitForBridges(page: Page) {
  await page.waitForFunction(() => {
    const testWindow: DeviceWindow = window;
    // `serverVaultStatus` comes from `Me`: once it reads 'present' the signed-in user is known to the provider.
    return (
      testWindow.__engramVaultTestBridge?.serverVaultStatus === 'present' &&
      Boolean(testWindow.__engramDeviceTestBridge)
    );
  });
}

async function unlockViaRealWorker(page: Page) {
  await waitForBridges(page);
  await page.evaluate(
    async ({ passphrase, kdf, wrappedVk, wrappedPriv }) => {
      const testWindow: DeviceWindow = window;
      const bridge = testWindow.__engramVaultTestBridge;
      if (!bridge) throw new Error('vault test bridge is not installed');
      const { opGeneration } = bridge.beginOp();
      await bridge.unlockPassphrase({
        passphrase,
        kdf,
        vaultKeyWrappedByKek: wrappedVk,
        privateKeysWrapped: wrappedPriv,
        opGeneration,
      });
      // The provider learns the current vault_key_id from the (stubbed) GET /vault, as after any real load.
      await bridge.reloadVaultMeta();
    },
    {
      passphrase: TEST_VECTOR_PASSPHRASE,
      kdf: TEST_VECTOR_KDF,
      wrappedVk: TEST_VECTOR_WRAPPED_VK,
      wrappedPriv: TEST_VECTOR_WRAPPED_PRIV,
    },
  );
  await expect(page.locator('.vault-pill')).toHaveClass(/vault-open/, { timeout: CRYPTO_WAIT_MS });
}

/** Independent of the app code path: counts DevKey records straight from the real IndexedDB (never creates the DB). */
async function rawDevKeyCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open('sabk.device', 1);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('devkeys')) {
            db.close();
            resolve(-1);
            return;
          }
          const keys = db.transaction('devkeys', 'readonly').objectStore('devkeys').getAllKeys();
          keys.onsuccess = () => {
            db.close();
            resolve(keys.result.length);
          };
          keys.onerror = () => {
            db.close();
            resolve(-2);
          };
        };
        req.onerror = () => resolve(-3);
      }),
  );
}

async function deleteDeviceDatabase(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase('sabk.device');
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'));
        // `blocked` is not terminal: the deletion proceeds once the other connections close (onversionchange).
      }),
  );
}

const SCENARIOS = [
  { name: 'Forget in tab A', reason: 'meta_changed' },
  { name: 'reset (known-user purge) in tab A', reason: 'meta_changed' },
  { name: 'revoked purge with an unknown user_id in tab A', reason: 'meta_changed' },
  { name: 'the sabk.device database deleted and re-created behind both tabs', reason: 'meta_missing' },
] as const;

test.describe('P03-T18 two-page / two-Worker Remember vs Forget / reset / revoked purge (ADR 0003 Hệ quả, FE R3-5)', () => {
  for (const scenario of SCENARIOS) {
    test(`Tab B Remember parked at WebCrypto, ${scenario.name} -> B's final tx aborts, NO DevKey record, toggle re-reads off with the neutral notice`, async ({
      context,
    }) => {
      test.setTimeout(120_000);
      await installAuthenticatedVaultApiMocks(context);
      const pageA = await context.newPage();
      const pageB = await context.newPage();
      await pageA.goto('/app/settings');
      await pageB.goto('/app/settings');
      await waitForBridges(pageA);
      await unlockViaRealWorker(pageB);

      // Tab B starts Remember on a device that has never stored anything (first-time meta init) and parks.
      await pageB.evaluate(() => (window as DeviceWindow).__engramDeviceTestBridge!.startPausedRemember());
      await pageB.waitForFunction(() => (window as DeviceWindow).__engramDeviceTestBridge!.isPausedAtWebCrypto());
      const startSnapshot = await pageB.evaluate(() => (window as DeviceWindow).__engramDeviceTestBridge!.snapshot());
      expect(startSnapshot.meta?.deviceRevision).toBe(1);
      expect(startSnapshot.allRecordCount).toBe(0);

      // Tab A (another Worker, same real IndexedDB) changes the device state.
      if (scenario.name.startsWith('Forget')) {
        const res = await pageA.evaluate(() => (window as DeviceWindow).__engramDeviceTestBridge!.forget());
        expect(res.status).toBe('ready');
      } else if (scenario.name.startsWith('reset')) {
        const res = await pageA.evaluate(() => (window as DeviceWindow).__engramDeviceTestBridge!.purge('known'));
        expect(res.ok).toBe(true);
      } else if (scenario.name.startsWith('revoked')) {
        const res = await pageA.evaluate(() => (window as DeviceWindow).__engramDeviceTestBridge!.purge('unknown_user'));
        expect(res.ok).toBe(true);
      } else {
        await deleteDeviceDatabase(pageA);
      }

      // B resumes: its final readwrite tx must abort.
      await pageB.evaluate(() => (window as DeviceWindow).__engramDeviceTestBridge!.release());
      const state = await pageB.evaluate(() => (window as DeviceWindow).__engramDeviceTestBridge!.awaitRemember());

      expect(state.remembered).toBe(false);
      expect(state.lastAbortReason).toBe(scenario.reason);
      expect(state.notice).toBe('device_state_changed');
      expect(await rawDevKeyCount(pageB)).toBe(0);
      expect(await rawDevKeyCount(pageA)).toBe(0);
      // The toggle really re-reads the DB (not a cached "off"): a fresh read still says off.
      const reread = await pageB.evaluate(() => (window as DeviceWindow).__engramDeviceTestBridge!.refresh());
      expect(reread.remembered).toBe(false);
      // The open VK in B is untouched by an aborted Remember.
      await expect(pageB.locator('.vault-pill')).toHaveClass(/vault-open/);
    });
  }

  test('control: with no concurrent change the same Remember in tab B commits exactly one DevKey record and the toggle reads on in both tabs', async ({
    context,
  }) => {
    test.setTimeout(120_000);
    await installAuthenticatedVaultApiMocks(context);
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await pageA.goto('/app/settings');
    await pageB.goto('/app/settings');
    await waitForBridges(pageA);
    await unlockViaRealWorker(pageB);

    await pageB.evaluate(() => (window as DeviceWindow).__engramDeviceTestBridge!.startPausedRemember());
    await pageB.waitForFunction(() => (window as DeviceWindow).__engramDeviceTestBridge!.isPausedAtWebCrypto());
    await pageB.evaluate(() => (window as DeviceWindow).__engramDeviceTestBridge!.release());
    const state = await pageB.evaluate(() => (window as DeviceWindow).__engramDeviceTestBridge!.awaitRemember());
    expect(state.remembered).toBe(true);
    expect(state.notice).toBeNull();
    expect(await rawDevKeyCount(pageB)).toBe(1);

    // Tab A (not even unlocked) reads the same toggle state from the shared DB.
    const inA = await pageA.evaluate(() => (window as DeviceWindow).__engramDeviceTestBridge!.refresh());
    expect(inA.remembered).toBe(true);
  });
});
