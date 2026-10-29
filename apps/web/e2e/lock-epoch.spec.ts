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
async function seedHeavyConsumerAndDecryptedSecret(
  page: Page,
  bodyEntryId: string,
  secretDomId: string,
) {
  await page.evaluate(
    ({ entryId, domId, secretText }) => {
      const win = window as unknown as {
        __engramVaultTestBridge: {
          registerSecretFormReset: (fn: () => void) => () => void;
        };
        __engramQueryClient?: { setQueryData: (key: unknown[], val: unknown) => void };
      };
      win.__engramQueryClient?.setQueryData(['vault', 'body', entryId], secretText);

      // Mount a heavy consumer DOM subtree (500 nodes) + decrypted entry surface
      let heavyRoot = document.getElementById(`${domId}-heavy-root`);
      if (!heavyRoot) {
        heavyRoot = document.createElement('div');
        heavyRoot.id = `${domId}-heavy-root`;
        for (let i = 0; i < 500; i += 1) {
          const row = document.createElement('div');
          row.className = 'heavy-consumer-node';
          row.textContent = `heavy-item-${i}`;
          heavyRoot.appendChild(row);
        }
        document.body.appendChild(heavyRoot);
      }

      let host = document.getElementById(domId);
      if (!host) {
        host = document.createElement('div');
        host.id = domId;
        host.setAttribute('data-testid', domId);
        host.setAttribute('data-vault-decrypted', 'true');
        document.body.appendChild(host);
      }
      host.textContent = secretText;

      win.__engramVaultTestBridge.registerSecretFormReset(() => {
        if (host) {
          host.textContent = '[LOCKED]';
        }
      });
    },
    { entryId: bodyEntryId, domId: secretDomId, secretText: WAKE_SECRET_PLAINTEXT },
  );
  await expect(page.getByTestId(secretDomId)).toHaveText(WAKE_SECRET_PLAINTEXT);
}

async function expectWakeFailClosedWithinDeadline(
  page: Page,
  bodyEntryId: string,
  secretDomId: string,
) {
  const startedAt = Date.now();

  // Synchronously right after wake is triggered:
  // 1. State must already be gated (`'unlocking'` or `'locked'`, NEVER `'unlocked'`)
  // 2. Decrypted query cache must already be cleared AND no decrypted entry text remains in the DOM (VS-R7-1)
  const immediateSnap = await page.evaluate(
    ({ entryId, domId, secretText }) => {
      const win = window as unknown as {
        __engramVaultTestBridge: { state: string; workerState: string };
        __engramQueryClient?: { getQueryData: (key: unknown[]) => unknown };
      };
      const state = win.__engramVaultTestBridge.state;
      const cached = win.__engramQueryClient?.getQueryData(['vault', 'body', entryId]);
      const hostText = document.getElementById(domId)?.textContent ?? '';
      const bodyHasPlaintext = (document.body.textContent ?? '').includes(secretText);
      return {
        state,
        isPlaintextGated: state !== 'unlocked' && cached === undefined,
        hostText,
        bodyHasPlaintext,
      };
    },
    { entryId: bodyEntryId, domId: secretDomId, secretText: WAKE_SECRET_PLAINTEXT },
  );
  expect(immediateSnap.state).not.toBe('unlocked');
  expect(immediateSnap.isPlaintextGated).toBe(true);
  expect(immediateSnap.hostText).toBe('[LOCKED]');
  expect(immediateSnap.bodyHasPlaintext).toBe(false);

  // Deterministically poll until BOTH UI `state` and `workerState` reach `'locked'`, decrypted body cache is wiped,
  // no decrypted text is in the DOM, AND Worker decrypt (`openEntryNow`) is refused strictly within the 5s deadline (VS-R7-1, ADR 0003 §8.4).
  await expect
    .poll(
      async () =>
        page.evaluate(
          async ({ entryId, secretText }) => {
            const win = window as unknown as {
              __engramVaultTestBridge: {
                state: string;
                workerState: string;
                getClient: () => {
                  openEntryNow: (params: {
                    entryId: string;
                    envelope: { v: 1; alg: 'xchacha20poly1305'; key_id: string };
                    ciphertext: string;
                  }) => Promise<unknown>;
                };
              };
              __engramQueryClient?: { getQueryData: (key: unknown[]) => unknown };
            };
            const bridge = win.__engramVaultTestBridge;
            const state = bridge.state;
            const workerState = bridge.workerState;
            const bodyCacheCleared =
              win.__engramQueryClient?.getQueryData(['vault', 'body', entryId]) === undefined;
            const domCleared = !(document.body.textContent ?? '').includes(secretText);

            let workerDecryptRefused = false;
            if (workerState === 'locked') {
              try {
                await bridge.getClient().openEntryNow({
                  entryId,
                  envelope: { v: 1, alg: 'xchacha20poly1305', key_id: 'vk:test' },
                  ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                });
              } catch {
                workerDecryptRefused = true;
              }
            }

            return {
              state,
              workerState,
              bodyCacheCleared,
              domCleared,
              workerDecryptRefused,
            };
          },
          { entryId: bodyEntryId, secretText: WAKE_SECRET_PLAINTEXT },
        ),
      { timeout: 5_000, intervals: [25, 50, 100] },
    )
    .toEqual({
      state: 'locked',
      workerState: 'locked',
      bodyCacheCleared: true,
      domCleared: true,
      workerDecryptRefused: true,
    });

  expect(Date.now() - startedAt).toBeLessThanOrEqual(5_000);
  await expect(page.locator('.vault-pill')).toHaveClass(/vault-shut/);
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

    await seedHeavyConsumerAndDecryptedSecret(pageC, 'lock-epoch-c', 'wake-secret-c');
    await pageC.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => false,
      });
      window.dispatchEvent(new Event('resume'));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expectWakeFailClosedWithinDeadline(pageC, 'lock-epoch-c', 'wake-secret-c');
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
    await seedHeavyConsumerAndDecryptedSecret(pageB, 'lock-epoch-b1', 'wake-secret-b1');
    await pageB.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => false,
      });
      window.dispatchEvent(new Event('resume'));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expectWakeFailClosedWithinDeadline(pageB, 'lock-epoch-b1', 'wake-secret-b1');
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
    await seedHeavyConsumerAndDecryptedSecret(pageB, 'lock-epoch-b2', 'wake-secret-b2');
    await pageB.evaluate(() => {
      window.dispatchEvent(new Event('resume'));
      window.dispatchEvent(new Event('focus'));
    });
    await expectWakeFailClosedWithinDeadline(pageB, 'lock-epoch-b2', 'wake-secret-b2');
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

    // Wait slightly so Date.now() advances, then trigger real user input (`pointerdown` + `keydown`) in Page A.
    // Page A's production listener calls `recordActivity` -> `postVaultBroadcast({ type: 'activity', at })`
    // over the browser's real `BroadcastChannel('sabk.vault')` to the separate browsing context Page B.
    await pageA.waitForTimeout(100);
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

    // 2. Intercept `IDBObjectStore.prototype.put` on `'meta'` so the production `purgeDeviceKeysInSingleTx`
    //    readwrite transaction aborts AFTER `devkeys.delete` and `meta.put` have been issued inside the single
    //    transaction, then trigger a reset purge via `vault_changed { version: null }`.
    const snapshotAfterAbortedPurge = await page.evaluate(
      async ({ recKey, dbName, dbVersion, devStore, metaStore, metaKey }) => {
        const origPut = IDBObjectStore.prototype.put;
        let metaPutAbortedOnce = false;

        IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
          const req = origPut.call(this, value, key);
          if (!metaPutAbortedOnce && this.name === metaStore && key === metaKey) {
            metaPutAbortedOnce = true;
            const tx = this.transaction;
            req.addEventListener('success', () => {
              try {
                tx.abort();
              } catch {
                // Ignore if already aborting
              }
            });
          }
          return req;
        };

        try {
          const bc = new BroadcastChannel('sabk.vault');
          bc.postMessage({
            type: 'vault_changed',
            vault_key_id: 'vk:be1-18-browser-test',
            version: null,
          });
          bc.close();
          await new Promise((r) => setTimeout(r, 150));
        } finally {
          IDBObjectStore.prototype.put = origPut;
        }

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
    // Because the real Chromium IndexedDB readwrite transaction aborted after `devkeys.delete` and `meta.put`,
    // Chromium rolled back BOTH stores atomically AND BE2-8 did NOT cache the failed purge as committed!
    expect(snapshotAfterAbortedPurge.hasDevKey).toBe(true);
    expect(snapshotAfterAbortedPurge.meta).toEqual({
      incarnation: initialIncarnation,
      deviceRevision: 7,
    });

    // 3. Now repeat the reset broadcast without the abort injection -> the retry purge succeeds (`ok: true`),
    //    deleting the DevKey and rotating `meta.__meta__` (`deviceRevision: 8`).
    const snapshotAfterRetryPurge = await page.evaluate(
      async ({ recKey, dbName, dbVersion, devStore, metaStore, metaKey }) => {
        const bc = new BroadcastChannel('sabk.vault');
        bc.postMessage({
          type: 'vault_changed',
          vault_key_id: 'vk:be1-18-browser-test',
          version: null,
        });
        bc.close();
        await new Promise((r) => setTimeout(r, 150));

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
    expect(snapshotAfterRetryPurge.hasDevKey).toBe(false);
    expect(snapshotAfterRetryPurge.meta?.deviceRevision).toBe(8);
    expect(snapshotAfterRetryPurge.meta?.incarnation).not.toBe(initialIncarnation);

    await page.close();
  });
});
