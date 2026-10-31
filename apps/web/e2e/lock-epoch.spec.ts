import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  DEVICE_META_RECORD_KEY,
  DEVKEY_STORE_NAME,
  META_STORE_NAME,
  SABK_DEVICE_DB_NAME,
  SABK_DEVICE_DB_VERSION,
} from '../features/vault/lock-epoch';

/**
 * Deterministic JS v1 crypto vectors from `packages/crypto-vectors/vectors/js-v1.json`
 * so the real browser Worker (`worker.ts`) can unlock a real Argon2id-64MiB wrapped VK.
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
const WAKE_SECRET_PLAINTEXT = 'engram-wake-decrypted-entry-secret-vs-r7-1';

async function installAuthenticatedVaultApiMocks(
  context: BrowserContext,
  options: { autoLockMinutes?: 0 | 5 | 15 | 60 } = {},
) {
  const autoLockMinutes = options.autoLockMinutes ?? 0;

  await context.route('**/api/v1/auth/csrf', async (route) => {
    await route.fulfill({
      status: 204,
      headers: {
        'set-cookie': 'sabk_csrf=v1.sess.e2e-lock-epoch-csrf.sig.extra; Path=/; SameSite=Lax',
      },
    });
  });

  await context.route('**/api/v1/auth/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        oauth_providers: [],
        email_verification_required: false,
        captcha_site_key: null,
      }),
    });
  });

  await context.route('**/api/v1/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'lock-epoch-e2e@example.test',
          email_verified: true,
          created_at: '2026-10-28T00:00:00Z',
        },
        settings: {
          locale: 'vi',
          theme: 'light',
          auto_lock_minutes: autoLockMinutes,
          semantic_suggest: false,
        },
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

  await context.route('**/api/v1/auth/sessions', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    });
  });

  await context.route('**/api/v1/auth/audit*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    });
  });

  await context.route('**/api/v1/me/notifications*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], unread_count: 0 }),
    });
  });

  await context.route('**/api/v1/readyz', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        semantic_available: false,
      }),
    });
  });

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
        recovery_keys: {
          total: 10,
          remaining: 10,
          used_slots: [],
          low_warning: false,
        },
        passkeys: [],
      }),
    });
  });
}

async function waitForVaultBridge(page: Page) {
  await page.waitForFunction(() => {
    const win = window as unknown as {
      __engramVaultTestBridge?: { state: string };
    };
    return Boolean(win.__engramVaultTestBridge);
  });
}

async function unlockPageViaRealWorker(page: Page) {
  await waitForVaultBridge(page);
  await page.evaluate(
    async ({ passphrase, kdf, wrappedVk, wrappedPriv }) => {
      const win = window as unknown as {
        __engramVaultTestBridge: {
          beginOp: () => { opGeneration: number };
          unlockPassphrase: (params: {
            passphrase: string;
            kdf: typeof kdf;
            vaultKeyWrappedByKek: string;
            privateKeysWrapped: string;
            opGeneration: number;
          }) => Promise<{ unlocked: true }>;
        };
      };
      const bridge = win.__engramVaultTestBridge;
      const { opGeneration } = bridge.beginOp();
      await bridge.unlockPassphrase({
        passphrase,
        kdf,
        vaultKeyWrappedByKek: wrappedVk,
        privateKeysWrapped: wrappedPriv,
        opGeneration,
      });
    },
    {
      passphrase: TEST_VECTOR_PASSPHRASE,
      kdf: TEST_VECTOR_KDF,
      wrappedVk: TEST_VECTOR_WRAPPED_VK,
      wrappedPriv: TEST_VECTOR_WRAPPED_PRIV,
    },
  );
  await expect(page.locator('.vault-pill')).toHaveClass(/vault-open/);
}

async function readPersistedLockEpochMarker(
  page: Page,
): Promise<{ epochIncarnation: string; lockEpoch: number } | null> {
  return page.evaluate(async () => {
    return new Promise<{ epochIncarnation: string; lockEpoch: number } | null>((resolve) => {
      const req = indexedDB.open('sabk.device', 1);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('lock_epoch', 'readonly');
        const getReq = tx.objectStore('lock_epoch').get('__lock_epoch__');
        getReq.onsuccess = () => {
          db.close();
          resolve(getReq.result ?? null);
        };
        getReq.onerror = () => {
          db.close();
          resolve(null);
        };
      };
      req.onerror = () => resolve(null);
    });
  });
}
const WAKE_ROW_COUNT = 400;
/** Display-only fixture, not a recovery key. */
const WAKE_RK_DISPLAY_FIXTURE = 'WAKE-FIXTURE-AAAA-BBBB-CCCC-DDDD';

interface WakeSnapshot {
  state: string;
  workerState: string;
  consumerState: string | null;
  bodyNodePresent: boolean;
  recoveryGridText: boolean;
  documentHasSecret: boolean;
  rowsMounted: number;
  rowsWithSecret: number;
  cacheCleared: boolean;
}

/**
 * Mounts the REAL React vault consumer (`features/vault/vault-test-consumer.tsx`, rendered inside the production
 * `VaultProvider` tree, gating on `useVault().state`, holding display RKs in React state behind the real untagged
 * `RecoveryKeysSheet`, with a few hundred `useVault()` subscribers) and fills it with data that went through the
 * real Worker: a VALID entry is sealed and opened (`sealEntryNow` / `openEntryNow`), its plaintext is put into
 * the `['vault','body',entryId]` cache and the same envelope is kept for a post-lock decrypt probe.
 * Nothing in the page wipes its own DOM: whatever hides is the provider's synchronous gate.
 */
async function mountRealConsumerWithDecryptedData(page: Page, entryId: string) {
  await page.evaluate(
    async ({ entryId: id, secretText, rkDisplay, keyId, rowCount }) => {
      const win = window as unknown as {
        __engramVaultTestBridge: {
          getClient: () => {
            sealEntryNow: (p: {
              entryId: string;
              keyId: string;
              plaintext: string;
            }) => Promise<{ envelope: unknown; ciphertext: string }>;
            openEntryNow: (p: {
              entryId: string;
              envelope: unknown;
              ciphertext: string;
            }) => Promise<{ plaintext: string }>;
          };
        };
        __engramQueryClient?: { setQueryData: (key: unknown[], val: unknown) => void };
        __engramMountVaultTestConsumer?: (
          host: HTMLElement,
          options: { entryId: string; rowCount: number },
        ) => Promise<{ setRecoveryKeys: (keys: Array<{ slot: number; display: string }>) => void }>;
        __vsR71Payload?: { entryId: string; envelope: unknown; ciphertext: string; plaintext: string };
      };
      if (!win.__engramMountVaultTestConsumer || !win.__engramQueryClient) {
        throw new Error('vault test consumer mount hook is not available');
      }
      document.getElementById('vs-r7-1-host')?.remove();
      const host = document.createElement('div');
      host.id = 'vs-r7-1-host';
      document.body.appendChild(host);
      const api = await win.__engramMountVaultTestConsumer(host, { entryId: id, rowCount });

      const client = win.__engramVaultTestBridge.getClient();
      const sealed = await client.sealEntryNow({ entryId: id, keyId, plaintext: secretText });
      const opened = await client.openEntryNow({
        entryId: id,
        envelope: sealed.envelope,
        ciphertext: sealed.ciphertext,
      });
      win.__vsR71Payload = {
        entryId: id,
        envelope: sealed.envelope,
        ciphertext: sealed.ciphertext,
        plaintext: opened.plaintext,
      };
      win.__engramQueryClient.setQueryData(['vault', 'body', id], opened.plaintext);
      api.setRecoveryKeys([{ slot: 1, display: rkDisplay }]);
    },
    {
      entryId,
      secretText: WAKE_SECRET_PLAINTEXT,
      rkDisplay: WAKE_RK_DISPLAY_FIXTURE,
      keyId: TEST_VECTOR_VAULT_KEY_ID,
      rowCount: WAKE_ROW_COUNT,
    },
  );
  // Positive control: before any wake the consumer renders the decrypted data through the production contract.
  await expect(page.getByTestId('vs-r7-1-body')).toHaveText(WAKE_SECRET_PLAINTEXT);
  await expect(page.locator('code', { hasText: WAKE_RK_DISPLAY_FIXTURE })).toBeVisible();
  await expect(page.getByTestId('vs-r7-1-row').first()).toContainText(WAKE_SECRET_PLAINTEXT);
}

/**
 * Dispatches the wake events and reads the DOM in the SAME synchronous turn: there is no `await` (and no
 * `return`) between `dispatchEvent` and the snapshot, so React must already have re-rendered through the
 * provider's synchronous store notification + `flushSync`, not "one task later".
 */
async function dispatchWakeAndSnapshotSameTurn(
  page: Page,
  entryId: string,
  options: { watchLeaks?: boolean } = {},
): Promise<WakeSnapshot> {
  return page.evaluate(
    ({ id, secretText, rkDisplay, watchLeaks }) => {
      const win = window as unknown as {
        __engramVaultTestBridge: { state: string; workerState: string };
        __engramQueryClient?: { getQueryData: (key: unknown[]) => unknown };
        __vsR71Leaks?: { count: number; observer: MutationObserver | null };
      };
      if (watchLeaks) {
        const leaks = { count: 0, observer: null as MutationObserver | null };
        leaks.observer = new MutationObserver(() => {
          if ((document.body.textContent ?? '').includes(secretText)) leaks.count += 1;
        });
        leaks.observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        win.__vsR71Leaks = leaks;
      }
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      window.dispatchEvent(new Event('resume'));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      // ---- same synchronous turn: nothing above is awaited ----
      const rows = Array.from(document.querySelectorAll('[data-testid="vs-r7-1-row"]'));
      return {
        state: win.__engramVaultTestBridge.state,
        workerState: win.__engramVaultTestBridge.workerState,
        consumerState:
          document.querySelector('[data-testid="vs-r7-1-consumer"]')?.getAttribute('data-vault-state') ?? null,
        bodyNodePresent: document.querySelector('[data-testid="vs-r7-1-body"]') !== null,
        recoveryGridText: Array.from(document.querySelectorAll('code')).some((c) =>
          (c.textContent ?? '').includes(rkDisplay),
        ),
        documentHasSecret: (document.body.textContent ?? '').includes(secretText),
        rowsMounted: rows.length,
        rowsWithSecret: rows.filter((r) => (r.textContent ?? '').includes(secretText)).length,
        cacheCleared: win.__engramQueryClient?.getQueryData(['vault', 'body', id]) === undefined,
      };
    },
    {
      id: entryId,
      secretText: WAKE_SECRET_PLAINTEXT,
      rkDisplay: WAKE_RK_DISPLAY_FIXTURE,
      watchLeaks: options.watchLeaks ?? false,
    },
  );
}

function expectSnapshotGated(snap: WakeSnapshot) {
  expect(snap.state).not.toBe('unlocked');
  expect(snap.consumerState).not.toBe('unlocked');
  expect(snap.cacheCleared).toBe(true);
  expect(snap.bodyNodePresent).toBe(false);
  expect(snap.recoveryGridText).toBe(false);
  expect(snap.documentHasSecret).toBe(false);
  expect(snap.rowsMounted).toBe(WAKE_ROW_COUNT);
  expect(snap.rowsWithSecret).toBe(0);
}

/**
 * Valid-envelope decrypt probe: the SAME envelope/ciphertext that decrypted successfully before the wake must now
 * be refused by the locked Worker with the specific `VAULT_LOCKED` code (never "any error").
 */
async function probeValidDecrypt(page: Page) {
  return page.evaluate(async () => {
    const win = window as unknown as {
      __engramVaultTestBridge: {
        state: string;
        workerState: string;
        getClient: () => {
          openEntryNow: (p: {
            entryId: string;
            envelope: unknown;
            ciphertext: string;
          }) => Promise<{ plaintext: string }>;
        };
      };
      __vsR71Payload?: { entryId: string; envelope: unknown; ciphertext: string; plaintext: string };
    };
    const payload = win.__vsR71Payload;
    if (!payload) throw new Error('missing valid decrypt payload');
    try {
      const opened = await win.__engramVaultTestBridge.getClient().openEntryNow({
        entryId: payload.entryId,
        envelope: payload.envelope,
        ciphertext: payload.ciphertext,
      });
      return { outcome: 'decrypted', code: null, matches: opened.plaintext === payload.plaintext };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      return { outcome: 'refused', code: typeof code === 'string' ? code : 'NO_CODE', matches: false };
    }
  });
}

async function expectWakeFailClosedWithinDeadline(page: Page, entryId: string, startedAt: number) {
  // Deterministically poll until BOTH UI `state` and `workerState` reach `'locked'`, the decrypted cache and DOM stay
  // clean, AND the Worker refuses a previously VALID decrypt with `VAULT_LOCKED`, strictly within the 5s deadline
  // measured from the wake dispatch (VS-R7-1, ADR 0003 §8.4).
  await expect
    .poll(
      async () => {
        const live = await page.evaluate(
          ({ id, secretText }) => {
            const win = window as unknown as {
              __engramVaultTestBridge: { state: string; workerState: string };
              __engramQueryClient?: { getQueryData: (key: unknown[]) => unknown };
            };
            return {
              state: win.__engramVaultTestBridge.state,
              workerState: win.__engramVaultTestBridge.workerState,
              bodyCacheCleared: win.__engramQueryClient?.getQueryData(['vault', 'body', id]) === undefined,
              domCleared: !(document.body.textContent ?? '').includes(secretText),
            };
          },
          { id: entryId, secretText: WAKE_SECRET_PLAINTEXT },
        );
        const probe =
          live.workerState === 'locked' ? await probeValidDecrypt(page) : { outcome: 'not-probed', code: null };
        return { ...live, decryptOutcome: probe.outcome, decryptCode: probe.code };
      },
      { timeout: 5_000, intervals: [25, 50, 100] },
    )
    .toEqual({
      state: 'locked',
      workerState: 'locked',
      bodyCacheCleared: true,
      domCleared: true,
      decryptOutcome: 'refused',
      decryptCode: 'VAULT_LOCKED',
    });

  expect(Date.now() - startedAt).toBeLessThanOrEqual(5_000);
  await expect(page.locator('.vault-pill')).toHaveClass(/vault-shut/);
}

/** Holds the wake's authoritative `GET /auth/me` until released (or failed) so verification stays pending. */
async function installHeldWakeMe(context: BrowserContext) {
  let armed = false;
  let markArrived: () => void = () => undefined;
  let decide: (mode: 'ok' | 'fail') => void = () => undefined;
  let arrived: Promise<void> = Promise.resolve();
  let gate: Promise<'ok' | 'fail'> = Promise.resolve('ok');
  await context.route('**/api/v1/auth/me', async (route) => {
    if (!armed) {
      await route.fallback();
      return;
    }
    armed = false;
    markArrived();
    if ((await gate) === 'fail') {
      await route.fulfill({
        status: 503,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'https://engram.zone17.click/problems/service_unavailable',
          title: 'service_unavailable',
          status: 503,
          code: 'service_unavailable',
        }),
      });
      return;
    }
    await route.fallback();
  });
  return {
    /** Holds the NEXT `/auth/me` request (the wake's verification) until `release`. */
    arm() {
      armed = true;
      arrived = new Promise<void>((resolve) => {
        markArrived = resolve;
      });
      gate = new Promise<'ok' | 'fail'>((resolve) => {
        decide = resolve;
      });
    },
    /** Resolves once the held request reached the network layer (verification is genuinely pending). */
    arrived: () => arrived,
    release: (mode: 'ok' | 'fail') => decide(mode),
  };
}

test.describe('P03-T15B Two-page / Three-page lockEpoch writer contention, freeze/resume, and failed-write fail-closed (ADR 0003 §8, FE R3-5)', () => {
  test('(a) two pages contend writing lock events under Web Lock "sabk.vault.lock" + IDB readwrite while a third page is frozen then resumed -> unique strictly increasing lockEpochs, no lost update, resumed page always locked', async ({
    context,
  }) => {
    test.setTimeout(90_000);
    await installAuthenticatedVaultApiMocks(context, { autoLockMinutes: 0 });

    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const pageC = await context.newPage();

    await pageA.goto('/app/settings');
    await pageB.goto('/app/settings');
    await pageC.goto('/app/settings');

    // Unlock Page C so it captures an authoritative `unlockBaseline` in IndexedDB `sabk.device`
    await unlockPageViaRealWorker(pageC);
    const baselineC = await pageC.evaluate(() => {
      const win = window as unknown as {
        __engramVaultTestBridge: {
          unlockBaseline: { epochIncarnation: string; lockEpoch: number } | null;
        };
      };
      return win.__engramVaultTestBridge.unlockBaseline;
    });
    expect(baselineC).not.toBeNull();
    const initialEpoch = baselineC!.lockEpoch;

    // Deterministically suppress live broadcast/storage delivery from Page A and Page B while Page C is frozen
    // so Page C must rely on its wake check against `sabk.device` under Web Lock `'sabk.vault.lock'`.
    const setSenderBroadcastSuppressed = async (page: Page, suppressed: boolean) => {
      await page.evaluate((shouldSuppress) => {
        const win = window as unknown as {
          __origPostMessage?: typeof BroadcastChannel.prototype.postMessage;
          __origSetItem?: typeof Storage.prototype.setItem;
        };
        if (shouldSuppress) {
          if (!win.__origPostMessage) {
            win.__origPostMessage = BroadcastChannel.prototype.postMessage;
          }
          if (!win.__origSetItem) {
            win.__origSetItem = Storage.prototype.setItem;
          }
          BroadcastChannel.prototype.postMessage = function () {
            // Simulated dropped broadcast to frozen receiver Page C
          };
          Storage.prototype.setItem = function () {
            // Simulated dropped storage event to frozen receiver Page C
          };
        } else {
          if (win.__origPostMessage) {
            BroadcastChannel.prototype.postMessage = win.__origPostMessage;
          }
          if (win.__origSetItem) {
            Storage.prototype.setItem = win.__origSetItem;
          }
        }
      }, suppressed);
    };

    await setSenderBroadcastSuppressed(pageA, true);
    await setSenderBroadcastSuppressed(pageB, true);

    const cdpC = await context.newCDPSession(pageC);
    await pageA.bringToFront();
    await pageC.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await cdpC.send('Page.setWebLifecycleState', { state: 'frozen' });
    // Run a tight concurrent contention loop across Page A and Page B (10 iterations each = 20 lock writes)
    // driving the ACTUAL product `VaultProvider.lock()` -> `recordLockEpochEvent` writer (BE1-12)
    const ITERATIONS_PER_PAGE = 10;
    const runContentionLoop = (page: Page, iterations: number) =>
      page.evaluate(async (count) => {
        const produced: number[] = [];
        const win = window as unknown as {
          __engramVaultTestBridge: {
            lock: (opts?: { broadcast?: boolean; reason?: string }) => Promise<unknown>;
            tabKnownLockEpoch: number;
          };
        };

        for (let i = 0; i < count; i += 1) {
          await win.__engramVaultTestBridge.lock({
            broadcast: true,
            reason: `contention_${i}`,
          });
          // Wait for the queued exclusive Web Lock `'sabk.vault.lock'` + IDB readwrite tx from `recordLockEpochEvent` to settle
          await navigator.locks.request('sabk.vault.lock', { mode: 'exclusive' }, async () => {});
          produced.push(win.__engramVaultTestBridge.tabKnownLockEpoch);
        }
        return produced;
      }, iterations);

    const [epochsA, epochsB] = await Promise.all([
      runContentionLoop(pageA, ITERATIONS_PER_PAGE),
      runContentionLoop(pageB, ITERATIONS_PER_PAGE),
    ]);

    await setSenderBroadcastSuppressed(pageA, false);
    await setSenderBroadcastSuppressed(pageB, false);

    // Every single page's own sequence must be strictly increasing
    for (let i = 1; i < epochsA.length; i += 1) {
      expect(epochsA[i]!).toBeGreaterThan(epochsA[i - 1]!);
    }
    for (let i = 1; i < epochsB.length; i += 1) {
      expect(epochsB[i]!).toBeGreaterThan(epochsB[i - 1]!);
    }

    // Across both pages combined: all 20 produced lockEpochs must be unique and cover initialEpoch+1 .. initialEpoch+20 with zero lost updates
    const combined = [...epochsA, ...epochsB].sort((x, y) => x - y);
    const unique = new Set(combined);
    expect(unique.size).toBe(ITERATIONS_PER_PAGE * 2);
    const expectedEpochs = Array.from(
      { length: ITERATIONS_PER_PAGE * 2 },
      (_, idx) => initialEpoch + idx + 1,
    );
    expect(combined).toEqual(expectedEpochs);

    const persistedAfterContention = await readPersistedLockEpochMarker(pageA);
    expect(persistedAfterContention?.lockEpoch).toBe(initialEpoch + ITERATIONS_PER_PAGE * 2);

    // Resume Page C from freeze -> verify Page C was still unlocked while suspended (BE1-13),
    // then runs its wake check against `sabk.device` under Web Lock and transitions BOTH UI and Worker to `locked`.
    await cdpC.send('Page.setWebLifecycleState', { state: 'active' });
    const stateCBeforeWake = await pageC.evaluate(() => {
      const win = window as unknown as {
        __engramVaultTestBridge: { state: string; workerState: string };
      };
      return {
        state: win.__engramVaultTestBridge.state,
        workerState: win.__engramVaultTestBridge.workerState,
      };
    });
    expect(stateCBeforeWake).toEqual({ state: 'unlocked', workerState: 'unlocked' });

    const entryIdC = '018f3a40-0000-7000-8000-0000000000c1';
    await mountRealConsumerWithDecryptedData(pageC, entryIdC);
    const wakeStartedAtC = Date.now();
    expectSnapshotGated(await dispatchWakeAndSnapshotSameTurn(pageC, entryIdC));
    await expectWakeFailClosedWithinDeadline(pageC, entryIdC, wakeStartedAtC);
    await pageA.close();
    await pageB.close();
    await pageC.close();
  });

  test('(b) when locking tab increment tx fails (quota / abort) and frozen tab misses BroadcastChannel (even with auto_lock_minutes = 0), locking tab self-locks and deletes marker in fallback tx; frozen tab on resume sees missing marker (or new epochIncarnation after re-init) and locks fail-closed', async ({
    context,
  }) => {
    test.setTimeout(90_000);
    await installAuthenticatedVaultApiMocks(context, { autoLockMinutes: 0 });

    const pageA = await context.newPage();
    const pageB = await context.newPage();

    await pageA.goto('/app/settings');
    await pageB.goto('/app/settings');

    // Unlock both Page A and Page B with `auto_lock_minutes = 0`
    await unlockPageViaRealWorker(pageA);
    await unlockPageViaRealWorker(pageB);

    const baselineB1 = await pageB.evaluate(() => {
      const win = window as unknown as {
        __engramVaultTestBridge: {
          unlockBaseline: { epochIncarnation: string; lockEpoch: number } | null;
        };
      };
      return win.__engramVaultTestBridge.unlockBaseline;
    });
    expect(baselineB1).not.toBeNull();

    // Freeze Page B via CDP (with explicit observable precondition, BE1-13) and suppress sender broadcasts so it misses Page A's lock broadcast
    const cdpB = await context.newCDPSession(pageB);
    await pageA.bringToFront();
    await pageB.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await cdpB.send('Page.setWebLifecycleState', { state: 'frozen' });
    // In Page A: suppress BroadcastChannel.prototype.postMessage + localStorage.setItem (simulating frozen Page B missing all notifications)
    // AND inject a `QuotaExceededError` on the primary `put` in `lock_epoch` so the increment tx aborts,
    // while allowing the fallback `delete('__lock_epoch__')` readwrite tx inside the same Web Lock region to succeed.
    await pageA.evaluate(async () => {
      const origPostMessage = BroadcastChannel.prototype.postMessage;
      const origSetItem = Storage.prototype.setItem;
      const origPut = IDBObjectStore.prototype.put;

      BroadcastChannel.prototype.postMessage = function () {
        // Simulated dropped broadcast to frozen tab
      };
      Storage.prototype.setItem = function () {
        // Simulated dropped storage event to frozen tab
      };

      let putFailedOnce = false;
      IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
        if (!putFailedOnce && this.name === 'lock_epoch') {
          putFailedOnce = true;
          this.transaction.abort();
          throw new DOMException('Simulated QuotaExceededError on lock_epoch put', 'QuotaExceededError');
        }
        return origPut.call(this, value, key);
      };

      try {
        const win = window as unknown as {
          __engramVaultTestBridge: {
            lockNow: () => Promise<unknown>;
          };
        };
        await win.__engramVaultTestBridge.lockNow();
      } finally {
        // Wait for the async Web Lock writer + fallback delete transaction to finish before restoring prototypes
        await navigator.locks.request('sabk.vault.lock', { mode: 'exclusive' }, async () => {});
        BroadcastChannel.prototype.postMessage = origPostMessage;
        Storage.prototype.setItem = origSetItem;
        IDBObjectStore.prototype.put = origPut;
      }
    });

    // 1. Verify Locking Tab (Page A) self-locked immediately and deleted the marker in the fallback readwrite tx
    await expect(pageA.locator('.vault-pill')).toHaveClass(/vault-shut/);
    const markerAfterFailedWrite = await readPersistedLockEpochMarker(pageA);
    expect(markerAfterFailedWrite).toBeNull();

    // 2. Resume Frozen Tab (Page B) while marker is missing -> verify Page B was still unlocked while frozen (BE1-13),
    //    then sees missing marker on wake and locks fail-closed
    await cdpB.send('Page.setWebLifecycleState', { state: 'active' });
    const stateBBeforeWake = await pageB.evaluate(() => {
      const win = window as unknown as {
        __engramVaultTestBridge: { state: string; workerState: string };
      };
      return {
        state: win.__engramVaultTestBridge.state,
        workerState: win.__engramVaultTestBridge.workerState,
      };
    });
    expect(stateBBeforeWake).toEqual({ state: 'unlocked', workerState: 'unlocked' });
    const entryIdB1 = '018f3a40-0000-7000-8000-0000000000b1';
    await mountRealConsumerWithDecryptedData(pageB, entryIdB1);
    const wakeStartedAtB1 = Date.now();
    expectSnapshotGated(await dispatchWakeAndSnapshotSameTurn(pageB, entryIdB1));
    await expectWakeFailClosedWithinDeadline(pageB, entryIdB1, wakeStartedAtB1);
    // 3. Also verify the sub-case where another tab (Page A) re-initializes the marker with a new `epochIncarnation`
    //    before Frozen Tab (Page B) wakes up -> Page B sees `persistedMarker.epochIncarnation !== unlockBaseline.epochIncarnation`
    //    and locks fail-closed.
    await unlockPageViaRealWorker(pageB);
    const baselineB2 = await pageB.evaluate(() => {
      const win = window as unknown as {
        __engramVaultTestBridge: {
          unlockBaseline: { epochIncarnation: string; lockEpoch: number } | null;
        };
      };
      return win.__engramVaultTestBridge.unlockBaseline;
    });
    expect(baselineB2).not.toBeNull();

    // Replace the marker in `sabk.device` with the EXACT SAME numeric `lockEpoch` (`baselineB2.lockEpoch`)
    // but a brand-new `epochIncarnation` token (BE1-17: isolates incarnation-only mismatch from numeric lockEpoch mismatch)
    const fixedEpoch = baselineB2!.lockEpoch;
    const newIncarnation =
      baselineB2!.epochIncarnation === 'ffffffffffffffffffffffffffffffff'
        ? 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
        : 'ffffffffffffffffffffffffffffffff';
    await pageA.evaluate(
      async ({ lockEpoch, epochIncarnation }) => {
        await navigator.locks.request('sabk.vault.lock', { mode: 'exclusive' }, async () => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open('sabk.device', 1);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('lock_epoch', 'readwrite');
            tx.objectStore('lock_epoch').put(
              { epochIncarnation, lockEpoch },
              '__lock_epoch__',
            );
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
          db.close();
        });
      },
      { lockEpoch: fixedEpoch, epochIncarnation: newIncarnation },
    );

    const markerAfterReinit = await readPersistedLockEpochMarker(pageA);
    expect(markerAfterReinit).not.toBeNull();
    expect(markerAfterReinit!.lockEpoch).toBe(baselineB2!.lockEpoch);
    expect(markerAfterReinit!.epochIncarnation).not.toBe(baselineB2!.epochIncarnation);

    // Now wake Page B -> sees `epochIncarnation !== unlockBaseline.epochIncarnation` (even though numeric lockEpoch is identical) and locks fail-closed within 5s
    const entryIdB2 = '018f3a40-0000-7000-8000-0000000000b2';
    await mountRealConsumerWithDecryptedData(pageB, entryIdB2);
    const wakeStartedAtB2 = Date.now();
    expectSnapshotGated(await dispatchWakeAndSnapshotSameTurn(pageB, entryIdB2));
    await expectWakeFailClosedWithinDeadline(pageB, entryIdB2, wakeStartedAtB2);
    await pageA.close();
    await pageB.close();
  });

  test('(c) BE1-14: real two-page BroadcastChannel activity transport from Page A user input advances Page B lastActivityAt across separate browsing contexts so Page B does not idle-lock early', async ({
    context,
  }) => {
    test.setTimeout(90_000);
    await installAuthenticatedVaultApiMocks(context, { autoLockMinutes: 5 });

    const pageA = await context.newPage();
    const pageB = await context.newPage();

    await pageA.goto('/app/settings');
    await pageB.goto('/app/settings');

    await unlockPageViaRealWorker(pageA);
    await unlockPageViaRealWorker(pageB);

    const initialLastActivityB = await pageB.evaluate(() => {
      const win = window as unknown as {
        __engramVaultTestBridge: { lastActivityAt: number };
      };
      return win.__engramVaultTestBridge.lastActivityAt;
    });

    // Page A already broadcast `activity` when its unlock finished, and `recordActivity` throttles the broadcast
    // (`ACTIVITY_BROADCAST_THROTTLE_MS` = 1s, leading edge only). Unlocking Page B can take less than that, so a click
    // right away would be throttled by design and never reach Page B. Let the throttle window pass, then trigger
    // real user input (`pointerdown`) in Page A: its production listener calls `recordActivity` ->
    // `postVaultBroadcast({ type: 'activity', at })` over the browser's real `BroadcastChannel('sabk.vault')`
    // to the separate browsing context Page B.
    await pageA.waitForTimeout(1_250);
    await pageA.locator('body').click();

    await expect
      .poll(
        async () =>
          pageB.evaluate((prevLastActivityB) => {
            const win = window as unknown as {
              __engramVaultTestBridge: { lastActivityAt: number; state: string; workerState: string };
            };
            return {
              advanced: win.__engramVaultTestBridge.lastActivityAt > prevLastActivityB,
              state: win.__engramVaultTestBridge.state,
              workerState: win.__engramVaultTestBridge.workerState,
            };
          }, initialLastActivityB),
        { timeout: 5_000, intervals: [25, 50, 100] },
      )
      .toEqual({
        advanced: true,
        state: 'unlocked',
        workerState: 'unlocked',
      });

    await pageA.close();
    await pageB.close();
  });

  test('(d) BE1-18: real-browser IndexedDB readwrite transaction abort during revoked DevKey purge rolls back devkeys deletion and meta rotation atomically, then succeeds on retry', async ({
    context,
  }) => {
    test.setTimeout(90_000);
    await installAuthenticatedVaultApiMocks(context, { autoLockMinutes: 0 });

    const page = await context.newPage();
    await page.goto('/app/settings');
    // Unlock first via the real app path so `openSabkDeviceDb` creates `sabk.device` (version 1)
    // with all three object stores (`lock_epoch`, `devkeys`, `meta`) in Chromium IndexedDB.
    await unlockPageViaRealWorker(page);

    // 1. Seed a real DevKey record (`devkeys`) and initial `meta.__meta__` record (`deviceRevision: 7`) in Chromium IndexedDB `sabk.device`
    const userId = '11111111-1111-4111-8111-111111111111';
    const devKeyId = `${userId}:vk:be1-18-browser-test`;
    const initialIncarnation = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    await page.evaluate(
      async ({ uId, recKey, inc, dbName, dbVersion, devStore, metaStore, metaKey }) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open(dbName, dbVersion);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction([devStore, metaStore], 'readwrite');
          tx.objectStore(devStore).put(
            {
              user_id: uId,
              vault_key_id: 'vk:be1-18-browser-test',
              wrapped_vk: new Uint8Array([9, 8, 7, 6]),
            },
            recKey,
          );
          tx.objectStore(metaStore).put(
            {
              incarnation: inc,
              deviceRevision: 7,
            },
            metaKey,
          );
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      },
      {
        uId: userId,
        recKey: devKeyId,
        inc: initialIncarnation,
        dbName: SABK_DEVICE_DB_NAME,
        dbVersion: SABK_DEVICE_DB_VERSION,
        devStore: DEVKEY_STORE_NAME,
        metaStore: META_STORE_NAME,
        metaKey: DEVICE_META_RECORD_KEY,
      },
    );

    // 2. Intercept `IDBObjectStore.prototype.put` on `'meta'` so the production device-purge readwrite transaction
    //    (`devkeys` + `meta`) aborts AFTER `meta.put` succeeded. The interception installs an `abort` listener on
    //    that very transaction and records it in a witness, so the test can PROVE the abort ran instead of
    //    reading unchanged stores that would equally satisfy "the purge never started".
    await page.evaluate(
      ({ metaStore, metaKey }) => {
        const win = window as unknown as {
          __be118Witness?: {
            intercepted: boolean;
            storeNames: string[];
            abortEvents: number;
            txErrorName: string | null;
          };
          __be118OrigPut?: typeof IDBObjectStore.prototype.put;
        };
        const witness = { intercepted: false, storeNames: [] as string[], abortEvents: 0, txErrorName: null as string | null };
        win.__be118Witness = witness;
        const origPut = IDBObjectStore.prototype.put;
        win.__be118OrigPut = origPut;
        let armed = true;
        IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
          const req = origPut.call(this, value, key);
          if (armed && this.name === metaStore && key === metaKey) {
            armed = false;
            const tx = this.transaction;
            witness.intercepted = true;
            witness.storeNames = Array.from(tx.objectStoreNames).sort();
            tx.addEventListener('abort', () => {
              witness.abortEvents += 1;
              witness.txErrorName = tx.error?.name ?? null;
            });
            req.addEventListener('success', () => {
              tx.abort();
            });
          }
          return req;
        };
      },
      { metaStore: META_STORE_NAME, metaKey: DEVICE_META_RECORD_KEY },
    );

    const broadcastReset = () =>
      page.evaluate(() => {
        const bc = new BroadcastChannel('sabk.vault');
        bc.postMessage({
          type: 'vault_changed',
          vault_key_id: 'vk:be1-18-browser-test',
          version: null,
        });
        bc.close();
      });
    await broadcastReset();

    // Wait on the OBSERVABLE: the production purge transaction (devkeys + meta) was intercepted and its `abort`
    // event fired. A purge that never reached `meta.put` can never satisfy this and times out instead.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __be118Witness?: unknown }).__be118Witness), {
        timeout: 10_000,
        intervals: [25, 50, 100],
      })
      .toMatchObject({
        intercepted: true,
        storeNames: [DEVKEY_STORE_NAME, META_STORE_NAME].sort(),
        abortEvents: 1,
      });
    await page.evaluate(() => {
      const win = window as unknown as { __be118OrigPut?: typeof IDBObjectStore.prototype.put };
      if (win.__be118OrigPut) IDBObjectStore.prototype.put = win.__be118OrigPut;
    });

    // Because the real Chromium IndexedDB readwrite transaction aborted after `devkeys.delete` and `meta.put`
    // were issued, Chromium rolled back BOTH stores atomically AND the failed purge was not cached as committed.
    const readDeviceState = () =>
      page.evaluate(
        async ({ recKey, dbName, dbVersion, devStore, metaStore, metaKey }) => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(dbName, dbVersion);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const state = await new Promise<{
            hasDevKey: boolean;
            meta: { incarnation: string; deviceRevision: number } | null;
          }>((resolve, reject) => {
            const tx = db.transaction([devStore, metaStore], 'readonly');
            const devReq = tx.objectStore(devStore).get(recKey);
            const metaReq = tx.objectStore(metaStore).get(metaKey);
            tx.oncomplete = () =>
              resolve({
                hasDevKey: devReq.result !== undefined,
                meta: metaReq.result ?? null,
              });
            tx.onerror = () => reject(tx.error);
          });
          db.close();
          return state;
        },
        {
          recKey: devKeyId,
          dbName: SABK_DEVICE_DB_NAME,
          dbVersion: SABK_DEVICE_DB_VERSION,
          devStore: DEVKEY_STORE_NAME,
          metaStore: META_STORE_NAME,
          metaKey: DEVICE_META_RECORD_KEY,
        },
      );
    const snapshotAfterAbortedPurge = await readDeviceState();
    expect(snapshotAfterAbortedPurge.hasDevKey).toBe(true);
    expect(snapshotAfterAbortedPurge.meta).toEqual({
      incarnation: initialIncarnation,
      deviceRevision: 7,
    });

    // 3. Now repeat the reset broadcast without the abort injection -> the retry purge succeeds (`ok: true`),
    //    deleting the DevKey and rotating `meta.__meta__` (`deviceRevision: 8`). Poll the committed state.
    await broadcastReset();
    await expect
      .poll(async () => (await readDeviceState()).meta?.deviceRevision, {
        timeout: 10_000,
        intervals: [25, 50, 100],
      })
      .toBe(8);
    const snapshotAfterRetryPurge = await readDeviceState();
    expect(snapshotAfterRetryPurge.hasDevKey).toBe(false);
    expect(snapshotAfterRetryPurge.meta?.deviceRevision).toBe(8);
    expect(snapshotAfterRetryPurge.meta?.incarnation).not.toBe(initialIncarnation);

    await page.close();
  });

  test('(e) VS-R7-1 / BE3-4: a wake whose authoritative verification is HELD hides every decrypted surface of a real heavy React consumer in the same synchronous turn, and a matching release restores access only after verification', async ({
    context,
  }) => {
    test.setTimeout(90_000);
    await installAuthenticatedVaultApiMocks(context, { autoLockMinutes: 15 });
    const heldMe = await installHeldWakeMe(context);

    const page = await context.newPage();
    await page.goto('/app/settings');
    await unlockPageViaRealWorker(page);
    const entryId = '018f3a40-0000-7000-8000-0000000000e1';
    await mountRealConsumerWithDecryptedData(page, entryId);

    heldMe.arm();
    const snapshot = await dispatchWakeAndSnapshotSameTurn(page, entryId, { watchLeaks: true });
    // Same turn as the wake event: the provider has flushed the gate before this callback returned.
    expectSnapshotGated(snapshot);
    expect(snapshot.state).toBe('unlocking');

    // Verification is genuinely pending at the network layer; access stays withheld while it is held.
    await heldMe.arrived();
    const whileHeld = await page.evaluate((secretText) => {
      const win = window as unknown as {
        __engramVaultTestBridge: { state: string; workerState: string };
      };
      return {
        state: win.__engramVaultTestBridge.state,
        documentHasSecret: (document.body.textContent ?? '').includes(secretText),
        bodyNodePresent: document.querySelector('[data-testid="vs-r7-1-body"]') !== null,
      };
    }, WAKE_SECRET_PLAINTEXT);
    expect(whileHeld).toEqual({ state: 'unlocking', documentHasSecret: false, bodyNodePresent: false });

    // Release the matching verification: access resumes ONLY now (the consumer is no longer gated).
    heldMe.release('ok');
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const win = window as unknown as { __engramVaultTestBridge: { state: string } };
            return win.__engramVaultTestBridge.state;
          }),
        { timeout: 5_000, intervals: [25, 50, 100] },
      )
      .toBe('unlocked');
    await expect(page.getByTestId('vs-r7-1-consumer')).toHaveAttribute('data-vault-state', 'unlocked');

    // Nothing decrypted ever reappeared while the wake was pending or on release (the cache was purged).
    const leaks = await page.evaluate(() => {
      const win = window as unknown as { __vsR71Leaks?: { count: number; observer: MutationObserver | null } };
      win.__vsR71Leaks?.observer?.disconnect();
      return win.__vsR71Leaks?.count ?? -1;
    });
    expect(leaks).toBe(0);

    // The verified session decrypts the same valid envelope again and the consumer renders it.
    const reopened = await probeValidDecrypt(page);
    expect(reopened).toEqual({ outcome: 'decrypted', code: null, matches: true });
    await page.close();
  });

  test('(f) VS-R7-1 / BE3-4: a wake whose verification FAILS leaves no decrypted DOM and the Worker refuses a previously valid decrypt with VAULT_LOCKED within the 5s budget', async ({
    context,
  }) => {
    test.setTimeout(90_000);
    await installAuthenticatedVaultApiMocks(context, { autoLockMinutes: 15 });
    const heldMe = await installHeldWakeMe(context);

    const page = await context.newPage();
    await page.goto('/app/settings');
    await unlockPageViaRealWorker(page);
    const entryId = '018f3a40-0000-7000-8000-0000000000f1';
    await mountRealConsumerWithDecryptedData(page, entryId);

    // Positive control right before the wake: the valid envelope decrypts through the live Worker.
    expect(await probeValidDecrypt(page)).toEqual({ outcome: 'decrypted', code: null, matches: true });

    heldMe.arm();
    const startedAt = Date.now();
    const snapshot = await dispatchWakeAndSnapshotSameTurn(page, entryId, { watchLeaks: true });
    expectSnapshotGated(snapshot);
    await heldMe.arrived();

    // The authoritative refresh fails -> the provider fails closed.
    heldMe.release('fail');
    await expectWakeFailClosedWithinDeadline(page, entryId, startedAt);
    const leaks = await page.evaluate(() => {
      const win = window as unknown as { __vsR71Leaks?: { count: number; observer: MutationObserver | null } };
      win.__vsR71Leaks?.observer?.disconnect();
      return win.__vsR71Leaks?.count ?? -1;
    });
    expect(leaks).toBe(0);
    await page.close();
  });

  /**
   * BE1-14 deadline crossing on an INDEPENDENT page. The shared `context.clock` (installed before any page loads, so
   * both pages and the `BroadcastChannel` live under the same fake time) is jumped past the ORIGINAL idle deadline
   * of Page B. Only the activity that real Page A sent over the real `BroadcastChannel` can explain Page B surviving.
   */
  async function readAutoLockObservables(page: Page) {
    return page.evaluate(() => {
      const win = window as unknown as {
        __engramVaultTestBridge: {
          state: string;
          workerState: string;
          lastActivityAt: number;
          minutesLeft: number | undefined;
        };
      };
      const bridge = win.__engramVaultTestBridge;
      return {
        state: bridge.state,
        workerState: bridge.workerState,
        lastActivityAt: bridge.lastActivityAt,
        minutesLeft: bridge.minutesLeft ?? null,
        now: Date.now(),
      };
    });
  }

  test('(g) BE1-14: user input in real Page A extends independent Page B idle deadline -> Page B survives the ORIGINAL 5 minute deadline and locks only at the extended one', async ({
    context,
  }) => {
    test.setTimeout(120_000);
    const FIVE_MINUTES_MS = 5 * 60_000;
    await context.clock.install();
    await installAuthenticatedVaultApiMocks(context, { autoLockMinutes: 5 });

    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await pageA.goto('/app/settings');
    await pageB.goto('/app/settings');
    await unlockPageViaRealWorker(pageA);
    await unlockPageViaRealWorker(pageB);
    const before = await readAutoLockObservables(pageB);
    expect(before.state).toBe('unlocked');

    // 4 minutes of silence: both pages are still inside the original deadline.
    await context.clock.fastForward(4 * 60_000);
    // Real user input on Page A (clock is >1 s past A's unlock broadcast, so the activity throttle is open).
    await pageA.locator('body').click();
    await expect
      .poll(async () => (await readAutoLockObservables(pageB)).lastActivityAt, {
        timeout: 10_000,
        intervals: [25, 50, 100],
      })
      .toBeGreaterThan(before.lastActivityAt + 3.5 * 60_000);

    // Cross the ORIGINAL deadline of Page B (its own last activity + 5 min) but stay short of the extended one.
    await context.clock.fastForward(2 * 60_000);
    await expect
      .poll(
        async () => {
          const o = await readAutoLockObservables(pageB);
          // `minutesLeft` <= 3 proves the idle check re-ran after the jump (it was 5 or 4 before) and chose to keep the session.
          return {
            state: o.state,
            workerState: o.workerState,
            recheckedAfterJump: o.minutesLeft !== null && o.minutesLeft <= 3,
          };
        },
        { timeout: 10_000, intervals: [25, 50, 100] },
      )
      .toEqual({ state: 'unlocked', workerState: 'unlocked', recheckedAfterJump: true });
    const middle = await readAutoLockObservables(pageB);
    expect(middle.now - before.lastActivityAt).toBeGreaterThan(FIVE_MINUTES_MS);
    expect(middle.now - middle.lastActivityAt).toBeLessThan(FIVE_MINUTES_MS);

    // Now cross the EXTENDED deadline with no further input: Page B (and A) lock.
    await context.clock.fastForward(4 * 60_000);
    await expect
      .poll(
        async () => {
          const o = await readAutoLockObservables(pageB);
          return { state: o.state, workerState: o.workerState };
        },
        { timeout: 10_000, intervals: [25, 50, 100] },
      )
      .toEqual({ state: 'locked', workerState: 'locked' });
    await pageA.close();
    await pageB.close();
  });

  test('(h) BE1-14 control: with NO input anywhere, independent Page B idle-locks at the ORIGINAL 5 minute deadline', async ({
    context,
  }) => {
    test.setTimeout(120_000);
    const FIVE_MINUTES_MS = 5 * 60_000;
    await context.clock.install();
    await installAuthenticatedVaultApiMocks(context, { autoLockMinutes: 5 });

    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await pageA.goto('/app/settings');
    await pageB.goto('/app/settings');
    await unlockPageViaRealWorker(pageA);
    await unlockPageViaRealWorker(pageB);
    const before = await readAutoLockObservables(pageB);
    expect(before.state).toBe('unlocked');

    await context.clock.fastForward(FIVE_MINUTES_MS + 30_000);
    await expect
      .poll(
        async () => {
          const o = await readAutoLockObservables(pageB);
          return { state: o.state, workerState: o.workerState };
        },
        { timeout: 10_000, intervals: [25, 50, 100] },
      )
      .toEqual({ state: 'locked', workerState: 'locked' });
    const after = await readAutoLockObservables(pageB);
    expect(after.now - before.lastActivityAt).toBeGreaterThan(FIVE_MINUTES_MS);
    await pageA.close();
    await pageB.close();
  });
});
