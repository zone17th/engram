import { ProblemError } from '@engram/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatDevKeyRecordKey,
  purgeDeviceKeysOnRevoked,
  readDeviceMetaRecord,
  setDefaultDeviceStoreEnvironmentForTests,
  setKnownDeviceSessionUserId,
  subscribeDevicePurge,
  type DeviceMetaRecord,
} from '@/features/vault/device-store';
import {
  DEVICE_META_RECORD_KEY,
  DEVKEY_STORE_NAME,
  META_STORE_NAME,
} from '@/features/vault/lock-epoch';
import { authFetch } from '@/lib/api/auth-fetch';
import { CryptoClient, CryptoClientError } from './client';
import {
  DEVKEY_WRAPPED_VK_BYTES,
  forgetDevice,
  readDeviceRememberedState,
  readDeviceSnapshot,
  rememberDevice,
  runSilentDeviceUnlock,
  type DeviceEnvironment,
  type RememberDeviceResult,
  type RememberTestHooks,
  type SilentUnlockParams,
} from './device';
import { KEK_BYTES, type DeriveKekFn, type ValidatedKdfParams } from './kdf';
import type { Sodium } from './sodium';
import { FakeDeviceIdb, FakeWebLocks } from './test/fake-device-idb';
import { createWorkerShim, type ShimmedWorkerInstance } from './test/worker-shim';

// Plan Task 18 (DevKey): device.ts + device-store.ts against a real CryptoClient / Worker core (MessageChannel shim),
// real WebCrypto and a transaction-faithful fake of `sabk.device` (see ./test/fake-device-idb.ts).

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VAULT_K = 'vk:0123456789abcdefghijkl';
const VAULT_K2 = 'vk:mnopqrstuvwxyz0123456_';
const PASSPHRASE = 'device-test-passphrase-not-a-secret';

const fastTestDeriveKek: DeriveKekFn = (sodium: Sodium, passphrase: Uint8Array, params: ValidatedKdfParams) => {
  const input = new Uint8Array(passphrase.byteLength + params.saltBytes.byteLength + 8);
  input.set(passphrase, 0);
  input.set(params.saltBytes, passphrase.byteLength);
  const view = new DataView(input.buffer, input.byteOffset + passphrase.byteLength + params.saltBytes.byteLength, 8);
  view.setUint32(0, params.ops, true);
  view.setUint32(4, params.mem, true);
  return sodium.crypto_generichash(KEK_BYTES, input, null, 'uint8array');
};

function vaultAbsentError(): ProblemError {
  return new ProblemError({
    type: 'https://key.zone17th.click/problems/vault_absent',
    title: 'Vault absent',
    status: 404,
    code: 'vault_absent',
  });
}

interface Tab {
  client: CryptoClient;
  created: Awaited<ReturnType<CryptoClient['createVault']>>;
}

/** One-shot gate: `reached` resolves when the parked flow arrives, `release()` lets it continue. */
function makeGate() {
  let release!: () => void;
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hooks: RememberTestHooks = {
    afterWebCrypto: async () => {
      reach();
      await gate;
    },
  };
  return { hooks, reached, release };
}

describe('P03-T18 DevKey: lib/crypto/device.ts + sabk.device', () => {
  const shims: ShimmedWorkerInstance[] = [];
  let idb: FakeDeviceIdb;
  let locks: FakeWebLocks;
  let env: DeviceEnvironment;
  let serverVaultKeyId: string | null;
  let vaultGetLockHeld: boolean[];

  beforeEach(() => {
    locks = new FakeWebLocks();
    idb = new FakeDeviceIdb(locks);
    env = { idbFactory: idb.createFactory(), locksManager: locks.createLockManager() };
    serverVaultKeyId = VAULT_K;
    vaultGetLockHeld = [];
    setDefaultDeviceStoreEnvironmentForTests({ idbFactory: idb.createFactory() });
    setKnownDeviceSessionUserId(null);
  });

  afterEach(() => {
    for (const shim of shims.splice(0)) shim.close();
    vi.unstubAllGlobals();
  });

  async function openTab(): Promise<Tab> {
    const shim = createWorkerShim({ deriveKek: fastTestDeriveKek });
    shims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });
    const created = await client.createVault({ passphrase: PASSPHRASE, opGeneration: client.captureGeneration() });
    return { client, created };
  }

  /** `GET /vault` as the server currently answers it; records whether the Web Lock was held when it was sent. */
  const fetchVault = async () => {
    vaultGetLockHeld.push(locks.isHeld());
    if (serverVaultKeyId === null) throw vaultAbsentError();
    return { vault_key_id: serverVaultKeyId };
  };

  function remember(
    tab: Tab,
    over: Partial<{ userId: string; vaultKeyId: string; testHooks: RememberTestHooks; opGeneration: number }> = {},
  ): Promise<RememberDeviceResult> {
    return rememberDevice({
      client: tab.client,
      opGeneration: over.opGeneration ?? tab.client.captureGeneration(),
      userId: over.userId ?? USER_A,
      vaultKeyId: over.vaultKeyId ?? VAULT_K,
      env,
      fetchVault,
      testHooks: over.testHooks,
    });
  }

  const devkeys = () => idb.store(DEVKEY_STORE_NAME);
  const metaNow = () => readDeviceMetaRecord(env);

  /** Silent unlock wired like the provider does it: authoritative GET, then the Worker command. */
  function silentUnlock(tab: Tab, over: Partial<SilentUnlockParams> = {}, vault?: { id: string | null }) {
    const opGeneration = tab.client.captureGeneration();
    const unlock = vi.fn((params: Parameters<CryptoClient['unlockDevKey']>[0]) => tab.client.unlockDevKey(params));
    const lockOnInvalidate = vi.fn(() => tab.client.lock());
    const loadVault = vi.fn(async () => {
      const id = vault ? vault.id : serverVaultKeyId;
      return id === null ? null : { vault_key_id: id, private_keys_wrapped: tab.created.private_keys_wrapped };
    });
    const run = runSilentDeviceUnlock({
      userId: USER_A,
      opGeneration,
      isCurrent: () => tab.client.captureGeneration() === opGeneration,
      loadVault,
      unlock,
      lockOnInvalidate,
      env,
      ...over,
    });
    return { run, unlock, loadVault, lockOnInvalidate };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Task 18 bullet 1: DevKey in sabk.device, namespace, meta, wrap layout
  // -------------------------------------------------------------------------------------------------------------

  it('default off: an empty device reads as not remembered, writes nothing, and silent unlock never touches the network', async () => {
    const tab = await openTab();
    expect(await readDeviceRememberedState(USER_A, VAULT_K, env)).toEqual({ remembered: false, meta: null });
    expect(devkeys().size).toBe(0);
    expect(idb.store(META_STORE_NAME).size).toBe(0);

    await tab.client.lock();
    const { run, loadVault, unlock } = silentUnlock(tab);
    expect(await run).toEqual({ status: 'skipped', reason: 'not_remembered' });
    expect(loadVault).not.toHaveBeenCalled();
    expect(unlock).not.toHaveBeenCalled();
    expect(tab.client.getState()).toBe('locked');
  });

  it('Remember stores a non-extractable AES-GCM DevKey + the 60-byte wrapped VK under user_id:vault_key_id, creates meta on first use and bumps deviceRevision once', async () => {
    const tab = await openTab();
    const result = await remember(tab);
    expect(result.status).toBe('remembered');

    expect([...devkeys().keys()]).toEqual([formatDevKeyRecordKey(USER_A, VAULT_K)]);
    const snapshot = await readDeviceSnapshot(USER_A, env);
    const record = snapshot.entries[0]?.record;
    expect(record).not.toBeNull();
    expect(record!.user_id).toBe(USER_A);
    expect(record!.vault_key_id).toBe(VAULT_K);
    expect(record!.wrapped_vk.byteLength).toBe(DEVKEY_WRAPPED_VK_BYTES);
    const key = record!.dev_key as CryptoKey;
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect([...key.usages].sort()).toEqual(['decrypt', 'encrypt']);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();

    // First use: meta did not exist -> created as revision 1, then bumped to 2 by the successful Remember.
    const meta = await metaNow();
    expect(meta?.deviceRevision).toBe(2);
    expect(meta?.incarnation).toMatch(/^[0-9a-f]{32}$/);
    expect(result.status === 'remembered' && result.meta).toEqual(meta);
    expect(idb.deleteDatabaseCalls).toBe(0);
  });

  it('Remember holds sabk.vault.lock for the in-lock GET /vault and the ONE final readwrite tx, and the fake proves no foreign await sits inside a tx', async () => {
    const tab = await openTab();
    idb.transactions.length = 0;
    expect((await remember(tab)).status).toBe('remembered');

    expect(vaultGetLockHeld).toEqual([true]);
    const readwrite = idb.transactions.filter((t) => t.mode === 'readwrite');
    expect(readwrite).toHaveLength(2);
    // 1: first-use meta init before WebCrypto (no lock); 2: the compare-and-write, under the lock, over both stores.
    expect(readwrite[0]).toMatchObject({ storeNames: [META_STORE_NAME], lockHeld: false });
    expect(readwrite[1]).toMatchObject({ storeNames: [DEVKEY_STORE_NAME, META_STORE_NAME], lockHeld: true });
    expect(locks.isHeld()).toBe(false);
  });

  // -------------------------------------------------------------------------------------------------------------
  // Task 18 bullet 2 + 3: silent unlock, Forget, purge, rewrap, logout
  // -------------------------------------------------------------------------------------------------------------

  it('silent unlock after a lock opens the Worker only once GET /vault names the stored vault_key_id', async () => {
    const tab = await openTab();
    await remember(tab);
    await tab.client.lock();
    expect(tab.client.getState()).toBe('locked');

    const { run, loadVault, unlock } = silentUnlock(tab);
    expect(await run).toEqual({ status: 'unlocked' });
    expect(loadVault).toHaveBeenCalledTimes(1);
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(tab.client.getState()).toBe('unlocked');
    // The GET came before the Worker command and unlockDevKey carried the opGeneration captured before it.
    expect(loadVault.mock.invocationCallOrder[0]!).toBeLessThan(unlock.mock.invocationCallOrder[0]!);
    expect(unlock.mock.calls[0]![0]).toMatchObject({ userId: USER_A, vaultKeyId: VAULT_K, opGeneration: expect.any(Number) });
  });

  it('a lock between the GET and the Worker command makes silent unlock stale: the Worker stays locked', async () => {
    const tab = await openTab();
    await remember(tab);
    await tab.client.lock();
    const lockDuringGet = vi.fn(async () => {
      await tab.client.lock();
      return { vault_key_id: VAULT_K, private_keys_wrapped: tab.created.private_keys_wrapped };
    });
    const { run, unlock } = silentUnlock(tab, { loadVault: lockDuringGet });
    expect(await run).toEqual({ status: 'skipped', reason: 'stale' });
    expect(unlock).not.toHaveBeenCalled();
    expect(tab.client.getState()).toBe('locked');
  });

  it('R1-8 / R1-19: Forget or cross-tab meta change while silent unlock GET /vault is held invalidates the cached DevKey (no unlockDevKey dispatch, store empty, stays locked)', async () => {
    const tab = await openTab();
    await remember(tab);
    await tab.client.lock();

    // 1. Held GET, Forget completes, same-key GET released -> no unlockDevKey dispatch, store empty, still locked.
    let releaseGet!: () => void;
    let getStarted!: () => void;
    const getStartedP = new Promise<void>((r) => {
      getStarted = r;
    });
    const getGate = new Promise<void>((r) => {
      releaseGet = r;
    });
    const forgetDuringGet = silentUnlock(tab, {
      loadVault: async () => {
        getStarted();
        await getGate;
        return { vault_key_id: VAULT_K, private_keys_wrapped: tab.created.private_keys_wrapped };
      },
    });
    await getStartedP;
    expect(await forgetDevice(USER_A, env)).toMatchObject({ status: 'forgotten', deletedCount: 1 });
    releaseGet();
    expect(await forgetDuringGet.run).toEqual({ status: 'skipped', reason: 'stale' });
    expect(forgetDuringGet.unlock).not.toHaveBeenCalled();
    expect(devkeys().size).toBe(0);
    expect(tab.client.getState()).toBe('locked');

    // 2. Cross-tab meta-change variant (e.g., another tab re-remembered or rotated meta while GET was held).
    await tab.client.unlockPassphrase({
      passphrase: PASSPHRASE,
      kdf: tab.created.kdf,
      vaultKeyWrappedByKek: tab.created.vault_key_wrapped_by_kek,
      privateKeysWrapped: tab.created.private_keys_wrapped,
      opGeneration: tab.client.captureGeneration(),
    });
    await remember(tab);
    await tab.client.lock();

    let releaseGet2!: () => void;
    let getStarted2!: () => void;
    const getStartedP2 = new Promise<void>((r) => {
      getStarted2 = r;
    });
    const getGate2 = new Promise<void>((r) => {
      releaseGet2 = r;
    });
    const metaChangedDuringGet = silentUnlock(tab, {
      loadVault: async () => {
        getStarted2();
        await getGate2;
        return { vault_key_id: VAULT_K, private_keys_wrapped: tab.created.private_keys_wrapped };
      },
    });
    await getStartedP2;
    // Another tab purges / rotates device meta for another user (keeps USER_A record, bumps meta revision/incarnation).
    await purgeDeviceKeysOnRevoked(USER_B, env);
    releaseGet2();
    expect(await metaChangedDuringGet.run).toEqual({ status: 'skipped', reason: 'stale' });
    expect(metaChangedDuringGet.unlock).not.toHaveBeenCalled();
    expect(tab.client.getState()).toBe('locked');

    // 3. No-Forget control: without Forget or meta change, held GET unlocks normally.
    let releaseGet3!: () => void;
    let getStarted3!: () => void;
    const getStartedP3 = new Promise<void>((r) => {
      getStarted3 = r;
    });
    const getGate3 = new Promise<void>((r) => {
      releaseGet3 = r;
    });
    const control = silentUnlock(tab, {
      loadVault: async () => {
        getStarted3();
        await getGate3;
        return { vault_key_id: VAULT_K, private_keys_wrapped: tab.created.private_keys_wrapped };
      },
    });
    await getStartedP3;
    releaseGet3();
    expect(await control.run).toEqual({ status: 'unlocked' });
    expect(control.unlock).toHaveBeenCalledTimes(1);
    expect(tab.client.getState()).toBe('unlocked');
  });

  it('R1-8 / R1-19 (advisor-dec-054 post-dispatch window): Forget landing while unlockDevKey is in flight locks and wipes the Worker and reports stale (not unlocked)', async () => {
    const tab = await openTab();
    await remember(tab);
    await tab.client.lock();

    let releasePostUnlock!: () => void;
    let unlockDispatched!: () => void;
    const unlockDispatchedP = new Promise<void>((r) => {
      unlockDispatched = r;
    });
    const postUnlockGate = new Promise<void>((r) => {
      releasePostUnlock = r;
    });

    const inFlightAttempt = silentUnlock(tab, {
      unlock: async (params) => {
        const res = await tab.client.unlockDevKey(params);
        unlockDispatched();
        await postUnlockGate;
        return res;
      },
    });

    await unlockDispatchedP;
    // Forget completes while unlockDevKey is in flight (after beforePostMessage already passed).
    expect(await forgetDevice(USER_A, env)).toMatchObject({ status: 'forgotten', deletedCount: 1 });
    releasePostUnlock();

    expect(await inFlightAttempt.run).toEqual({ status: 'skipped', reason: 'stale' });
    expect(inFlightAttempt.lockOnInvalidate).toHaveBeenCalledTimes(1);
    expect(devkeys().size).toBe(0);
    expect(tab.client.getState()).toBe('locked');
  });

  it('account switch never uses another user\u2019s DevKey: B sees no record, A\u2019s record is untouched, and A\u2019s DevKey cannot open B\u2019s namespace', async () => {
    const tab = await openTab();
    await remember(tab, { userId: USER_A });
    await tab.client.lock();

    const asB = silentUnlock(tab, { userId: USER_B });
    expect(await asB.run).toEqual({ status: 'skipped', reason: 'not_remembered' });
    expect(asB.loadVault).not.toHaveBeenCalled();
    expect(asB.unlock).not.toHaveBeenCalled();
    expect(devkeys().has(formatDevKeyRecordKey(USER_A, VAULT_K))).toBe(true);

    // Defence in depth: the AES-GCM AAD binds user_id, so even a forced attempt with A's material fails for B.
    const record = (await readDeviceSnapshot(USER_A, env)).entries[0]!.record!;
    const attempt = tab.client.unlockDevKey({
      devKey: record.dev_key as CryptoKey,
      wrappedVk: record.wrapped_vk,
      userId: USER_B,
      vaultKeyId: VAULT_K,
      privateKeysWrapped: tab.created.private_keys_wrapped,
      opGeneration: tab.client.captureGeneration(),
    });
    await expect(attempt).rejects.toBeInstanceOf(CryptoClientError);
    expect(tab.client.getState()).not.toBe('unlocked');
  });

  it('IndexedDB error or blocked storage (private mode) falls back to the passphrase everywhere and never throws', async () => {
    const tab = await openTab();
    for (const mode of ['failOpen', 'blockOpen'] as const) {
      idb.options = { [mode]: true };
      expect(await remember(tab)).toEqual({ status: 'unavailable', reason: 'idb_error' });
      expect(await readDeviceRememberedState(USER_A, VAULT_K, env)).toEqual({ remembered: false, meta: null });
      expect(await forgetDevice(USER_A, env)).toEqual({ status: 'unavailable' });
      await tab.client.lock();
      const silent = silentUnlock(tab);
      expect(await silent.run).toEqual({ status: 'fallback', reason: 'idb_error' });
      expect(silent.unlock).not.toHaveBeenCalled();
      expect(tab.client.getState()).toBe('locked');
      // Back to a usable passphrase state for the next round.
      await tab.client.unlockPassphrase({
        passphrase: PASSPHRASE,
        kdf: tab.created.kdf,
        vaultKeyWrappedByKek: tab.created.vault_key_wrapped_by_kek,
        privateKeysWrapped: tab.created.private_keys_wrapped,
        opGeneration: tab.client.captureGeneration(),
      });
    }
    expect(devkeys().size).toBe(0);
  });

  it('Web Locks unavailable: Remember fails closed (no write) and reports unavailable', async () => {
    const tab = await openTab();
    locks.failLocks = true;
    expect((await remember(tab)).status).toBe('unavailable');
    expect(devkeys().size).toBe(0);
  });

  it('a record for another vault_key_id is purged key-scoped (the present vault\u2019s key survives) and silent unlock falls back to the passphrase', async () => {
    const tab = await openTab();
    await remember(tab, { vaultKeyId: VAULT_K });
    const before = await metaNow();
    await tab.client.lock();
    // The vault was reset and re-created elsewhere: the server names VAULT_K2 now.
    const silent = silentUnlock(tab, {}, { id: VAULT_K2 });
    expect(await silent.run).toEqual({ status: 'fallback', reason: 'vault_mismatch' });
    expect(silent.unlock).not.toHaveBeenCalled();
    expect(tab.client.getState()).toBe('locked');
    expect(devkeys().size).toBe(0);
    const after = await metaNow();
    expect(after?.deviceRevision).toBe(before!.deviceRevision + 1);
    expect(after?.incarnation).not.toBe(before!.incarnation);
  });

  it('GET /vault 404 vault_absent never silently unlocks', async () => {
    const tab = await openTab();
    await remember(tab);
    await tab.client.lock();
    serverVaultKeyId = null;
    const silent = silentUnlock(tab);
    expect(await silent.run).toEqual({ status: 'fallback', reason: 'vault_absent' });
    expect(silent.unlock).not.toHaveBeenCalled();
    expect(tab.client.getState()).toBe('locked');
  });

  it('Forget is ONE readwrite purge tx (records deleted, new incarnation, deviceRevision + 1), keeps other users, never deleteDatabase, and the next lock needs the passphrase', async () => {
    const tab = await openTab();
    await remember(tab);
    devkeys().set(formatDevKeyRecordKey(USER_B, 'vk:bbbbbbbbbbbbbbbbbbbbbb'), { user_id: USER_B, vault_key_id: 'vk:bbbbbbbbbbbbbbbbbbbbbb' });
    const before = (await metaNow())!;
    const notifications: unknown[] = [];
    const off = subscribeDevicePurge((r) => notifications.push(r));
    idb.transactions.length = 0;

    const result = await forgetDevice(USER_A, env);
    off();
    expect(result.status).toBe('forgotten');
    expect(idb.transactions.filter((t) => t.mode === 'readwrite')).toHaveLength(1);
    expect(idb.deleteDatabaseCalls).toBe(0);
    expect(notifications).toHaveLength(1);
    expect([...devkeys().keys()]).toEqual([formatDevKeyRecordKey(USER_B, 'vk:bbbbbbbbbbbbbbbbbbbbbb')]);
    const after = (await metaNow())!;
    expect(after.deviceRevision).toBe(before.deviceRevision + 1);
    expect(after.incarnation).not.toBe(before.incarnation);

    // The open VK stays until lock; after the lock there is nothing to silently unlock with.
    expect(tab.client.getState()).toBe('unlocked');
    await tab.client.lock();
    expect(await silentUnlock(tab).run).toEqual({ status: 'skipped', reason: 'not_remembered' });
  });

  it('rewrap does not purge: record and meta are unchanged and silent unlock still opens the vault', async () => {
    const tab = await openTab();
    await remember(tab);
    const before = (await metaNow())!;
    idb.transactions.length = 0;
    await tab.client.rewrap({
      passphrase: 'a-new-device-test-passphrase',
      currentKdf: tab.created.kdf,
      opGeneration: tab.client.captureGeneration(),
    });
    expect(idb.transactions).toHaveLength(0);
    expect(devkeys().has(formatDevKeyRecordKey(USER_A, VAULT_K))).toBe(true);
    expect(await metaNow()).toEqual(before);

    await tab.client.lock();
    expect(await silentUnlock(tab).run).toEqual({ status: 'unlocked' });
  });

  it('logout keeps the DevKey: nothing in device.ts or the purge path runs on sign-out, the record stays readable for the next login', async () => {
    const tab = await openTab();
    await remember(tab);
    const before = (await metaNow())!;
    // Voluntary logout = lock the Worker + clear caches; the session layer never calls the purge (session-provider.signOut).
    await tab.client.lock();
    expect(devkeys().has(formatDevKeyRecordKey(USER_A, VAULT_K))).toBe(true);
    expect(await metaNow()).toEqual(before);
    expect((await readDeviceRememberedState(USER_A, VAULT_K, env)).remembered).toBe(true);
  });

  it('revoked purge right after reload (user_id unknown): the 401 revoked path deletes EVERY user\u2019s DevKey in ONE readwrite tx and rotates the fence', async () => {
    const tab = await openTab();
    await remember(tab, { userId: USER_A });
    devkeys().set(formatDevKeyRecordKey(USER_B, 'vk:bbbbbbbbbbbbbbbbbbbbbb'), { user_id: USER_B, vault_key_id: 'vk:bbbbbbbbbbbbbbbbbbbbbb' });
    const before = (await metaNow())!;
    setKnownDeviceSessionUserId(null); // a fresh page: `me` has not loaded yet
    document.cookie = 'sabk_csrf=test-csrf-token';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: 'https://key.zone17th.click/problems/session_invalid',
            title: 'Session invalid',
            status: 401,
            code: 'session_invalid',
            reason: 'revoked',
          }),
          { status: 401, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    idb.transactions.length = 0;

    await expect(authFetch('/vault', { requireSession: true })).rejects.toThrow();
    await vi.waitFor(() => expect(devkeys().size).toBe(0));
    expect(idb.transactions.filter((t) => t.mode === 'readwrite')).toHaveLength(1);
    expect(idb.deleteDatabaseCalls).toBe(0);
    const after = (await metaNow())!;
    expect(after.deviceRevision).toBe(before.deviceRevision + 1);
    expect(after.incarnation).not.toBe(before.incarnation);
  });

  // -------------------------------------------------------------------------------------------------------------
  // Task 18 bullet 4 (ADR 0003 "Hệ quả", FE R3-5): Remember tx abort on meta / generation change
  // -------------------------------------------------------------------------------------------------------------

  describe('Remember is parked at WebCrypto while another tab changes the device (first-time meta included)', () => {
    it.each([
      ['Forget in tab A', 'meta_changed'],
      ['reset / known-user purge in tab A', 'meta_changed'],
      ['revoked purge with an unknown user_id in tab A', 'meta_changed'],
      ['the DB deleted and re-created behind the tabs', 'meta_missing'],
    ] as const)('%s -> the final tx aborts, NO DevKey record exists, the toggle re-reads off', async (name, reason) => {
      const tabB = await openTab();
      const gate = makeGate();
      const pending = remember(tabB, { testHooks: gate.hooks });
      await gate.reached; // B captured (startIncarnation, startRevision = 1, created on first use) and parked

      const start = (await metaNow())!;
      expect(start.deviceRevision).toBe(1);
      if (name.startsWith('Forget')) await forgetDevice(USER_A, env);
      else if (name.startsWith('reset')) await purgeDeviceKeysOnRevoked(USER_A, env);
      else if (name.startsWith('revoked')) await purgeDeviceKeysOnRevoked(null, env);
      else idb.wipe();

      gate.release();
      const result = await pending;
      expect(result).toEqual({ status: 'aborted', reason });
      expect(devkeys().size).toBe(0);
      expect(await readDeviceRememberedState(USER_A, VAULT_K, env)).toMatchObject({ remembered: false });
      if (reason === 'meta_changed') {
        const now = (await metaNow())!;
        expect(now.deviceRevision).toBe(2);
        expect(now.incarnation).not.toBe(start.incarnation);
      }
      expect(idb.deleteDatabaseCalls).toBe(0);
    });

    it('a Remember that completed first in another tab also aborts the parked one (exactly one record survives)', async () => {
      const tabA = await openTab();
      const tabB = await openTab();
      const gate = makeGate();
      const parked = remember(tabB, { testHooks: gate.hooks });
      await gate.reached;
      expect((await remember(tabA)).status).toBe('remembered');
      gate.release();
      expect(await parked).toEqual({ status: 'aborted', reason: 'meta_changed' });
      expect(devkeys().size).toBe(1);
    });

    it('a lock during the WebCrypto wait (generation moved) aborts inside the tx with no record', async () => {
      const tab = await openTab();
      const gate = makeGate();
      const pending = remember(tab, { testHooks: gate.hooks });
      await gate.reached;
      await tab.client.lock();
      gate.release();
      expect(await pending).toEqual({ status: 'aborted', reason: 'generation_changed' });
      expect(devkeys().size).toBe(0);
    });

    it('a generation that moved before the first await is refused up front (opGeneration is the caller\u2019s, captured earlier)', async () => {
      const tab = await openTab();
      const stale = tab.client.captureGeneration();
      await tab.client.lock();
      expect(await remember(tab, { opGeneration: stale })).toEqual({ status: 'aborted', reason: 'generation_changed' });
      expect(idb.transactions).toHaveLength(0);
    });

    it('R1-2 / R1-7 / R1-18: generation advanced between metaReq.onsuccess and keysReq.onsuccess aborts before any delete/put and rolls back', async () => {
      const tab = await openTab();
      // Seed an older key record for USER_A to prove no delete/put survives when aborted in keysReq.onsuccess.
      const oldKey = formatDevKeyRecordKey(USER_A, VAULT_K2);
      devkeys().set(oldKey, { user_id: USER_A, vault_key_id: VAULT_K2, wrapped_vk: new Uint8Array(60) });

      let lockFiredInKeyListCallback = false;
      const res = await remember(tab, {
        testHooks: {
          onKeyListSuccess: () => {
            lockFiredInKeyListCallback = true;
            // Synchronous generation bump (CryptoClient.lock increments generation synchronously before Worker message).
            void tab.client.lock();
          },
        },
      });
      expect(lockFiredInKeyListCallback).toBe(true);
      expect(res).toEqual({ status: 'aborted', reason: 'generation_changed' });
      expect([...devkeys().keys()]).toEqual([oldKey]);
      expect(devkeys().has(formatDevKeyRecordKey(USER_A, VAULT_K))).toBe(false);
      expect((await metaNow())?.deviceRevision).toBe(1);

      // Control without lock in callback succeeds and replaces the old record.
      await tab.client.unlockPassphrase({
        passphrase: PASSPHRASE,
        kdf: tab.created.kdf,
        vaultKeyWrappedByKek: tab.created.vault_key_wrapped_by_kek,
        privateKeysWrapped: tab.created.private_keys_wrapped,
        opGeneration: tab.client.captureGeneration(),
      });
      const controlRes = await remember(tab);
      expect(controlRes.status).toBe('remembered');
      expect([...devkeys().keys()]).toEqual([formatDevKeyRecordKey(USER_A, VAULT_K)]);
      expect((await metaNow())?.deviceRevision).toBe(2);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  // CF-T18-REMEMBER-FENCE (advisor-dec-036): in-lock vault re-verification; cross-tab BE2-9 scenario
  // -------------------------------------------------------------------------------------------------------------

  describe('CF-T18-REMEMBER-FENCE', () => {
    it('BE2-9 cross-tab: a missed reset notification + an unnamed 404 whose purge is skipped (no DevKey yet) leaves meta untouched, and the pending Remember is still fenced by the in-lock GET /vault', async () => {
      const tabB = await openTab();
      const gate = makeGate();
      const pending = remember(tabB, { testHooks: gate.hooks });
      await gate.reached;
      const startMeta = (await metaNow())!;

      // Tab A: the vault was reset elsewhere; tab A holds a reset receipt and meets an unnamed 404. Its purge finds no
      // DevKey (B has not written yet) and commits nothing: the device fence does NOT move.
      serverVaultKeyId = null;
      const skipped = await purgeDeviceKeysOnRevoked(USER_A, env, { skipIfNoDevKeys: true });
      expect(skipped).toMatchObject({ ok: true, skipped: true });
      expect(await metaNow()).toEqual(startMeta);

      gate.release();
      expect(await pending).toEqual({ status: 'aborted', reason: 'vault_absent' });
      expect(devkeys().size).toBe(0);
      expect(vaultGetLockHeld).toEqual([true]);
    });

    it('negative control: the same sequence with the vault still present DOES write (the meta fence alone would not have stopped the stale write above)', async () => {
      const tabB = await openTab();
      const gate = makeGate();
      const pending = remember(tabB, { testHooks: gate.hooks });
      await gate.reached;
      expect(await purgeDeviceKeysOnRevoked(USER_A, env, { skipIfNoDevKeys: true })).toMatchObject({ skipped: true });
      gate.release();
      expect((await pending).status).toBe('remembered');
      expect(devkeys().size).toBe(1);
    });

    it('another vault_key_id after the WebCrypto wait aborts with no write', async () => {
      const tab = await openTab();
      const gate = makeGate();
      const pending = remember(tab, { testHooks: gate.hooks });
      await gate.reached;
      serverVaultKeyId = VAULT_K2;
      gate.release();
      expect(await pending).toEqual({ status: 'aborted', reason: 'vault_mismatch' });
      expect(devkeys().size).toBe(0);
    });

    it('an unverifiable GET /vault (network error) fails closed with no write and releases the lock', async () => {
      const tab = await openTab();
      const result = await rememberDevice({
        client: tab.client,
        opGeneration: tab.client.captureGeneration(),
        userId: USER_A,
        vaultKeyId: VAULT_K,
        env,
        fetchVault: async () => {
          throw new TypeError('network down');
        },
      });
      expect(result).toEqual({ status: 'aborted', reason: 'vault_unverifiable' });
      expect(devkeys().size).toBe(0);
      expect(locks.isHeld()).toBe(false);
    });

    it('the vault is verified INSIDE the lock, before the final tx, and the lock is not held across the WebCrypto wait', async () => {
      const tab = await openTab();
      const gate = makeGate();
      const pending = remember(tab, { testHooks: gate.hooks });
      await gate.reached;
      expect(locks.isHeld()).toBe(false); // parked at WebCrypto: other tabs can still lock / purge
      gate.release();
      await pending;
      expect(vaultGetLockHeld).toEqual([true]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  // CF-T18-KEYSCOPED-PURGE (advisor-dec-039)
  // -------------------------------------------------------------------------------------------------------------

  describe('CF-T18-KEYSCOPED-PURGE', () => {
    const rec = (userId: string, vaultKeyId: string) => ({ user_id: userId, vault_key_id: vaultKeyId, wrapped_vk: new Uint8Array(60) });
    const seed = () => {
      devkeys().set(formatDevKeyRecordKey(USER_A, VAULT_K), rec(USER_A, VAULT_K));
      devkeys().set(formatDevKeyRecordKey(USER_A, VAULT_K2), rec(USER_A, VAULT_K2)); // created later by another tab
      devkeys().set(formatDevKeyRecordKey(USER_B, VAULT_K), rec(USER_B, VAULT_K));
      idb.store(META_STORE_NAME).set(DEVICE_META_RECORD_KEY, { incarnation: '00112233445566778899aabbccddeeff', deviceRevision: 4 });
    };
    const keys = () => [...devkeys().keys()].sort();

    it('only: a 404 for issued key K deletes K\u2019s record, not the K\u2019 a later vault created, and not another user\u2019s', async () => {
      seed();
      const res = await purgeDeviceKeysOnRevoked(USER_A, env, { keyScope: { only: [VAULT_K] } });
      expect(res).toMatchObject({ ok: true, deletedCount: 1 });
      expect(keys()).toEqual([formatDevKeyRecordKey(USER_A, VAULT_K2), formatDevKeyRecordKey(USER_B, VAULT_K)].sort());
      const meta = (await metaNow()) as DeviceMetaRecord;
      expect(meta.deviceRevision).toBe(5); // the fence still moves exactly once: a pending Remember always aborts
    });

    it('except: a replacement purge deletes every key of the user but the one now current', async () => {
      seed();
      const res = await purgeDeviceKeysOnRevoked(USER_A, env, { keyScope: { except: VAULT_K2 } });
      expect(res).toMatchObject({ ok: true, deletedCount: 1 });
      expect(keys()).toEqual([formatDevKeyRecordKey(USER_A, VAULT_K2), formatDevKeyRecordKey(USER_B, VAULT_K)].sort());
    });

    it('the unknown-user branch ignores the scope and deletes every DevKey record in one readwrite tx', async () => {
      seed();
      idb.transactions.length = 0;
      const res = await purgeDeviceKeysOnRevoked(null, env, { keyScope: { only: [VAULT_K] } });
      expect(res).toMatchObject({ ok: true, deletedCount: 3 });
      expect(devkeys().size).toBe(0);
      expect(idb.transactions.filter((t) => t.mode === 'readwrite')).toHaveLength(1);
    });

    it('skipIfNoDevKeys keeps its receipt semantics: no in-scope record -> commit nothing (no rotation); an in-scope one -> purge', async () => {
      seed();
      const skipped = await purgeDeviceKeysOnRevoked(USER_A, env, {
        skipIfNoDevKeys: true,
        keyScope: { only: ['vk:nothingNothingNothing00'] },
      });
      expect(skipped).toMatchObject({ ok: true, skipped: true, deletedCount: 0 });
      expect(keys()).toHaveLength(3);
      expect((await metaNow())?.deviceRevision).toBe(4);

      const purged = await purgeDeviceKeysOnRevoked(USER_A, env, { skipIfNoDevKeys: true, keyScope: { only: [VAULT_K] } });
      expect(purged).toMatchObject({ ok: true, deletedCount: 1 });
      expect((await metaNow())?.deviceRevision).toBe(5);
    });

    it('a scoped purge that matches nothing still rotates (without skipIfNoDevKeys) so an in-flight Remember aborts', async () => {
      seed();
      await purgeDeviceKeysOnRevoked(USER_A, env, { keyScope: { only: ['vk:nothingNothingNothing00'] } });
      expect(keys()).toHaveLength(3);
      expect((await metaNow())?.deviceRevision).toBe(5);
    });
  });
});
