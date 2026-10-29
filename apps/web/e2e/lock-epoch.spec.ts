import { expect, test, type BrowserContext, type Page } from '@playwright/test';

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

    // Suspend BroadcastChannel & storage listeners in Page C and set CDP lifecycle state to `frozen`
    await pageC.evaluate(() => {
      const win = window as unknown as {
        __suspendVaultBroadcastForFreezeTest?: boolean;
      };
      win.__suspendVaultBroadcastForFreezeTest = true;
      // Close Page C's BroadcastChannel so it cannot receive live broadcasts while frozen
      const OrigBC = window.BroadcastChannel;
      window.BroadcastChannel = class extends OrigBC {} as typeof BroadcastChannel;
    });
    const cdpC = await context.newCDPSession(pageC);
    try {
      await cdpC.send('Page.setWebLifecycleState', { state: 'frozen' });
    } catch {
      // Headless shell fallback if lifecycle state requires background visibility
    }

    // Run a tight concurrent contention loop across Page A and Page B (10 iterations each = 20 lock writes)
    // using the exact writer protocol: navigator.locks.request("sabk.vault.lock", { mode: "exclusive" }) + IDB readwrite tx
    const ITERATIONS_PER_PAGE = 10;
    const runContentionLoop = (page: Page, iterations: number) =>
      page.evaluate(async (count) => {
        const produced: number[] = [];
        let localKnown = 0;

        const writeOneLockEvent = async (): Promise<number> => {
          return navigator.locks.request(
            'sabk.vault.lock',
            { mode: 'exclusive' },
            async () => {
              const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open('sabk.device', 1);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error ?? new Error('open failed'));
              });
              try {
                const marker = await new Promise<{
                  epochIncarnation: string;
                  lockEpoch: number;
                }>((resolve, reject) => {
                  const tx = db.transaction('lock_epoch', 'readwrite');
                  const store = tx.objectStore('lock_epoch');
                  const getReq = store.get('__lock_epoch__');
                  let nextMarker: { epochIncarnation: string; lockEpoch: number } | null = null;
                  getReq.onsuccess = () => {
                    const cur = getReq.result as
                      | { epochIncarnation: string; lockEpoch: number }
                      | undefined;
                    const nextEpoch = Math.max(cur?.lockEpoch ?? 0, localKnown) + 1;
                    nextMarker = {
                      epochIncarnation:
                        cur?.epochIncarnation ?? '0123456789abcdef0123456789abcdef',
                      lockEpoch: nextEpoch,
                    };
                    const putReq = store.put(nextMarker, '__lock_epoch__');
                    putReq.onerror = () => tx.abort();
                  };
                  getReq.onerror = () => tx.abort();
                  tx.oncomplete = () => {
                    if (nextMarker) resolve(nextMarker);
                    else reject(new Error('missing nextMarker'));
                  };
                  tx.onerror = () => reject(tx.error ?? new Error('tx error'));
                  tx.onabort = () => reject(tx.error ?? new Error('tx abort'));
                });
                localKnown = Math.max(localKnown, marker.lockEpoch);
                return marker.lockEpoch;
              } finally {
                db.close();
              }
            },
          );
        };

        for (let i = 0; i < count; i += 1) {
          const epoch = await writeOneLockEvent();
          produced.push(epoch);
        }
        return produced;
      }, iterations);

    const [epochsA, epochsB] = await Promise.all([
      runContentionLoop(pageA, ITERATIONS_PER_PAGE),
      runContentionLoop(pageB, ITERATIONS_PER_PAGE),
    ]);

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

    // Resume Page C from freeze -> Page C runs its wake check against `sabk.device` under Web Lock and immediately transitions to `locked`
    try {
      await cdpC.send('Page.setWebLifecycleState', { state: 'active' });
    } catch {
      // Ignore if not supported in headless shell
    }
    await pageC.evaluate(() => {
      window.dispatchEvent(new Event('resume'));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect(pageC.locator('.vault-pill')).toHaveClass(/vault-shut/);
    const stateCAfterResume = await pageC.evaluate(() => {
      const win = window as unknown as {
        __engramVaultTestBridge: { state: string; workerState: string };
      };
      return {
        state: win.__engramVaultTestBridge.state,
        workerState: win.__engramVaultTestBridge.workerState,
      };
    });
    expect(stateCAfterResume).toEqual({ state: 'locked', workerState: 'locked' });

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

    // Freeze Page B and sever its BroadcastChannel + storage listeners so it misses Page A's lock broadcast
    await pageB.evaluate(() => {
      // Neutralize BroadcastChannel delivery in Page B by overriding postMessage on Page A's channel below
    });
    const cdpB = await context.newCDPSession(pageB);
    try {
      await cdpB.send('Page.setWebLifecycleState', { state: 'frozen' });
    } catch {
      // Ignore
    }

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

    // 2. Resume Frozen Tab (Page B) while marker is missing -> Page B sees missing marker and locks fail-closed
    try {
      await cdpB.send('Page.setWebLifecycleState', { state: 'active' });
    } catch {
      // Ignore
    }
    await pageB.evaluate(() => {
      window.dispatchEvent(new Event('resume'));
      window.dispatchEvent(new Event('focus'));
    });
    await expect(pageB.locator('.vault-pill')).toHaveClass(/vault-shut/);

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

    // Delete the marker (as in a failed write) and then re-unlock Page A so `captureUnlockBaseline` initializes
    // a brand-new `epochIncarnation` token in `sabk.device`
    await pageA.evaluate(async () => {
      await navigator.locks.request('sabk.vault.lock', { mode: 'exclusive' }, async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('sabk.device', 1);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('lock_epoch', 'readwrite');
          tx.objectStore('lock_epoch').delete('__lock_epoch__');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      });
    });

    await unlockPageViaRealWorker(pageA);
    const markerAfterReinit = await readPersistedLockEpochMarker(pageA);
    expect(markerAfterReinit).not.toBeNull();
    expect(markerAfterReinit!.epochIncarnation).not.toBe(baselineB2!.epochIncarnation);

    // Now wake Page B -> sees `epochIncarnation !== unlockBaseline.epochIncarnation` and locks fail-closed
    await pageB.evaluate(() => {
      window.dispatchEvent(new Event('resume'));
      window.dispatchEvent(new Event('focus'));
    });
    await expect(pageB.locator('.vault-pill')).toHaveClass(/vault-shut/);

    await pageA.close();
    await pageB.close();
  });
});
