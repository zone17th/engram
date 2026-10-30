import { ProblemError } from '@engram/shared-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatDevKeyRecordKey,
  purgeDeviceKeysOnRevoked,
  readDeviceMetaRecord,
  setDefaultDeviceStoreEnvironmentForTests,
  setKnownDeviceSessionUserId,
} from '@/features/vault/device-store';
import { DEVKEY_STORE_NAME } from '@/features/vault/lock-epoch';
import { resetVaultBroadcastForTests } from '@/features/vault/broadcast';
import { VaultProvider, useVault, type VaultContextValue } from '@/features/vault/vault-provider';
import type { Me } from '@/lib/api/auth';
import type * as VaultApi from '@/lib/api/vault';
import type { VaultState } from '@/lib/api/vault';
import type { CreateVaultResult } from '@/lib/crypto/client';
import type { DeviceEnvironment, RememberTestHooks } from '@/lib/crypto/device';
import { KEK_BYTES, type DeriveKekFn, type ValidatedKdfParams } from '@/lib/crypto/kdf';
import type { Sodium } from '@/lib/crypto/sodium';
import { FakeDeviceIdb, FakeWebLocks } from '@/lib/crypto/test/fake-device-idb';
import { createWorkerShim, type ShimmedWorkerInstance } from '@/lib/crypto/test/worker-shim';
import { createRememberDeviceStore } from './remember-store';
import { useRememberDevice, type UseRememberDeviceResult } from './use-remember-device';

// Plan Task 18 at the provider / hook level: silent unlock after reload, reset elsewhere then reload, key-scoped purges
// through the provider's 404 / replacement rows, the toggle's DB re-read + neutral notice. The session layer and the
// `GET /vault` call are mocked; the Worker core, WebCrypto, Web Locks and `sabk.device` (transaction-faithful fake) are real.

const mocks = vi.hoisted(() => ({
  session: {
    me: null as unknown,
    status: 'authenticated_with_vault' as string,
    refetchMe: async () => undefined,
  },
  fetchVault: vi.fn(),
}));

vi.mock('@/features/auth/session-provider', () => ({
  useSession: () => mocks.session,
}));

vi.mock('@/lib/api/vault', async (importOriginal) => ({
  ...(await importOriginal<typeof VaultApi>()),
  fetchVault: (...args: unknown[]) => mocks.fetchVault(...args),
}));

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VAULT_K = 'vk:0123456789abcdefghijkl';
const VAULT_K2 = 'vk:mnopqrstuvwxyz0123456_';
const PASSPHRASE = 'device-flow-test-passphrase-not-a-secret';

const fastTestDeriveKek: DeriveKekFn = (sodium: Sodium, passphrase: Uint8Array, params: ValidatedKdfParams) => {
  const input = new Uint8Array(passphrase.byteLength + params.saltBytes.byteLength + 8);
  input.set(passphrase, 0);
  input.set(params.saltBytes, passphrase.byteLength);
  const view = new DataView(input.buffer, input.byteOffset + passphrase.byteLength + params.saltBytes.byteLength, 8);
  view.setUint32(0, params.ops, true);
  view.setUint32(4, params.mem, true);
  return sodium.crypto_generichash(KEK_BYTES, input, null, 'uint8array');
};

class QuietBroadcastChannel {
  constructor(readonly name: string) {}
  addEventListener(): void {}
  removeEventListener(): void {}
  postMessage(): void {}
  close(): void {}
}

function makeMe(userId: string): Me {
  return {
    user: { id: userId, email: `${userId.slice(0, 4)}@example.test`, email_verified: true, created_at: '2026-01-01T00:00:00Z' },
    settings: { locale: 'en', theme: 'system', auto_lock_minutes: 0, semantic_suggest: false },
    identities: [{ provider: 'password', linked_at: '2026-01-01T00:00:00Z' }],
    features: {
      semantic_available: false,
      email_verification_required: false,
      oauth_providers: [],
      oauth_reauth_providers: [],
      password_enrollment_available: false,
      captcha_site_key: null,
    },
    vault: { status: 'present' },
  } as Me;
}

function vaultAbsentError(): ProblemError {
  return new ProblemError({
    type: 'https://key.zone17th.click/problems/vault_absent',
    title: 'Vault absent',
    status: 404,
    code: 'vault_absent',
  });
}

describe('P03-T18 DevKey: provider + toggle flows', () => {
  const shims: ShimmedWorkerInstance[] = [];
  let idb: FakeDeviceIdb;
  let locks: FakeWebLocks;
  let env: DeviceEnvironment;
  let created: CreateVaultResult | null;
  let serverKeyId: string | null;

  const vaultState = (keyId: string): VaultState =>
    ({
      vault_key_id: keyId,
      version: 1,
      kdf: created!.kdf,
      vault_key_wrapped_by_kek: created!.vault_key_wrapped_by_kek,
      x25519_public: created!.x25519_public,
      ed25519_public: created!.ed25519_public,
      private_keys_wrapped: created!.private_keys_wrapped,
      recovery_keys_remaining: 10,
      passkeys: [],
    }) as unknown as VaultState;

  beforeEach(() => {
    document.cookie = 'sabk_csrf=test-csrf-token';
    resetVaultBroadcastForTests();
    locks = new FakeWebLocks();
    idb = new FakeDeviceIdb(locks);
    env = { idbFactory: idb.createFactory(), locksManager: locks.createLockManager() };
    created = null;
    serverKeyId = VAULT_K;
    mocks.session.me = makeMe(USER_A);
    mocks.session.status = 'authenticated_with_vault';
    mocks.fetchVault.mockReset();
    mocks.fetchVault.mockImplementation(async () => {
      if (serverKeyId === null) throw vaultAbsentError();
      return vaultState(serverKeyId);
    });
    vi.stubGlobal('BroadcastChannel', QuietBroadcastChannel);
    vi.stubGlobal('indexedDB', idb.createFactory());
    vi.stubGlobal('navigator', { ...navigator, locks: locks.createLockManager() });
    setDefaultDeviceStoreEnvironmentForTests({ idbFactory: idb.createFactory() });
    setKnownDeviceSessionUserId(null);
  });

  afterEach(() => {
    cleanup();
    for (const shim of shims.splice(0)) shim.close();
    resetVaultBroadcastForTests();
    vi.unstubAllGlobals();
  });

  interface TabHandle {
    vault: () => VaultContextValue;
    remember: () => UseRememberDeviceResult;
  }

  function renderTab(
    options: { silentUnlockOnLoad?: boolean; testHooks?: RememberTestHooks } = {},
  ): TabHandle {
    const shim = createWorkerShim({ deriveKek: fastTestDeriveKek });
    shims.push(shim);
    const handle: { vault?: VaultContextValue; remember?: UseRememberDeviceResult } = {};
    function Probe() {
      const vault = useVault();
      const remember = useRememberDevice({ env, testHooks: options.testHooks });
      handle.vault = vault;
      handle.remember = remember;
      return <div data-testid="vault-state">{vault.state}</div>;
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <VaultProvider
          createWorker={() => shim.port}
          lockEpochEnv={{ idbFactory: idb.createFactory(), locksManager: locks.createLockManager() }}
          deviceStoreEnv={{ idbFactory: idb.createFactory() }}
          silentUnlockOnLoad={options.silentUnlockOnLoad}
        >
          <Probe />
        </VaultProvider>
      </QueryClientProvider>,
    );
    return { vault: () => handle.vault!, remember: () => handle.remember! };
  }

  const stateText = () => screen.getByTestId('vault-state').textContent;
  const devkeys = () => idb.store(DEVKEY_STORE_NAME);

  /** A tab with a freshly created, unlocked vault whose metadata (vault_key_id) the provider has loaded. */
  async function openUnlockedTab(options: Parameters<typeof renderTab>[0] = {}): Promise<TabHandle> {
    const tab = renderTab(options);
    await act(async () => {
      created = await tab.vault().createVault({ passphrase: PASSPHRASE, opGeneration: tab.vault().captureOpGeneration() });
    });
    await act(async () => {
      await tab.vault().reloadVaultMeta();
    });
    await waitFor(() => expect(stateText()).toBe('unlocked'), { timeout: 10_000 });
    await waitFor(() => expect(tab.remember().available).toBe(true));
    return tab;
  }

  // ------------------------------------------------------------------------------------------------------------
  // default off, hook toggle, Remember / Forget
  // ------------------------------------------------------------------------------------------------------------

  it('default off: the toggle reads off from an empty device, and a provider without the opt-in never reads sabk.device', async () => {
    const tab = await openUnlockedTab();
    await waitFor(() => expect(tab.remember().status).toBe('ready'));
    expect(tab.remember().remembered).toBe(false);
    expect(tab.remember().notice).toBeNull();
    expect(devkeys().size).toBe(0);
  });

  it('remember() then forget() drive the toggle from the DB: on after Remember, off after Forget, no notice', async () => {
    const tab = await openUnlockedTab();
    await act(async () => {
      await tab.remember().remember();
    });
    expect(tab.remember().remembered).toBe(true);
    expect(devkeys().has(formatDevKeyRecordKey(USER_A, VAULT_K))).toBe(true);
    expect(tab.remember().notice).toBeNull();
    // Forget does not lock: the open vault stays open.
    await act(async () => {
      await tab.remember().forget();
    });
    expect(tab.remember().remembered).toBe(false);
    expect(devkeys().size).toBe(0);
    expect(stateText()).toBe('unlocked');
  });

  it('tab B parked at WebCrypto while tab A purges: B\u2019s final tx aborts, no DevKey exists, the toggle re-reads off with the neutral notice', async () => {
    let release!: () => void;
    let reached!: () => void;
    const reachedP = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tab = await openUnlockedTab({
      testHooks: {
        afterWebCrypto: async () => {
          reached();
          await gate;
        },
      },
    });
    let pending!: Promise<unknown>;
    act(() => {
      pending = tab.remember().remember();
    });
    await reachedP;
    // Tab A (another Worker): unknown-user revoked purge, one readwrite tx, new incarnation.
    await act(async () => {
      await purgeDeviceKeysOnRevoked(null, env);
    });
    await act(async () => {
      release();
      await pending;
    });
    expect(devkeys().size).toBe(0);
    expect(tab.remember().remembered).toBe(false);
    expect(tab.remember().notice).toBe('device_state_changed');
    expect(tab.remember().lastAbortReason).toBe('meta_changed');
    act(() => tab.remember().dismissNotice());
    expect(tab.remember().notice).toBeNull();
  });

  it('IDB blocked (private mode): Remember reports unavailable, the toggle stays off, nothing throws', async () => {
    const tab = await openUnlockedTab();
    idb.options = { blockOpen: true };
    await act(async () => {
      await tab.remember().remember();
    });
    expect(tab.remember().status).toBe('unavailable');
    expect(tab.remember().remembered).toBe(false);
    expect(stateText()).toBe('unlocked');
  });

  // ------------------------------------------------------------------------------------------------------------
  // silent unlock through the provider
  // ------------------------------------------------------------------------------------------------------------

  it('reload on a remembered device silently unlocks only after GET /vault matches the stored vault_key_id (no passphrase)', async () => {
    const first = await openUnlockedTab();
    await act(async () => {
      await first.remember().remember();
    });
    expect(devkeys().size).toBe(1);
    cleanup();
    shims.splice(0).forEach((s) => s.close());

    mocks.fetchVault.mockClear();
    renderTab({ silentUnlockOnLoad: true });
    await waitFor(() => expect(stateText()).toBe('unlocked'), { timeout: 10_000 });
    expect(mocks.fetchVault).toHaveBeenCalledTimes(1);
  });

  it('without the opt-in a remembered device does not unlock by itself, but silentUnlock() does on demand', async () => {
    const first = await openUnlockedTab();
    await act(async () => {
      await first.remember().remember();
    });
    cleanup();
    shims.splice(0).forEach((s) => s.close());

    mocks.fetchVault.mockClear();
    const tab = renderTab();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(stateText()).toBe('locked');
    expect(mocks.fetchVault).not.toHaveBeenCalled();
    let result: unknown;
    await act(async () => {
      result = await tab.vault().silentUnlock();
    });
    expect(result).toEqual({ status: 'unlocked' });
    await waitFor(() => expect(stateText()).toBe('unlocked'), { timeout: 10_000 });
  });

  it('a manual lock never silently re-opens within the same mount (one automatic attempt per user)', async () => {
    const first = await openUnlockedTab();
    await act(async () => {
      await first.remember().remember();
    });
    cleanup();
    shims.splice(0).forEach((s) => s.close());

    const tab = renderTab({ silentUnlockOnLoad: true });
    await waitFor(() => expect(stateText()).toBe('unlocked'), { timeout: 10_000 });
    await act(async () => {
      await tab.vault().lock({ broadcast: false, reason: 'manual' });
    });
    await waitFor(() => expect(stateText()).toBe('locked'));
    mocks.fetchVault.mockClear();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(stateText()).toBe('locked');
    expect(mocks.fetchVault).not.toHaveBeenCalled();
  });

  it('reset elsewhere then reload here: the 404 purges the DevKey (user-scoped, unnamed), no silent unlock', async () => {
    const first = await openUnlockedTab();
    await act(async () => {
      await first.remember().remember();
    });
    const before = (await readDeviceMetaRecord(env))!;
    cleanup();
    shims.splice(0).forEach((s) => s.close());

    serverKeyId = null; // the vault was reset on another device
    renderTab({ silentUnlockOnLoad: true });
    await waitFor(() => expect(devkeys().size).toBe(0), { timeout: 10_000 });
    expect(stateText()).toBe('locked');
    const after = (await readDeviceMetaRecord(env))!;
    expect(after.deviceRevision).toBe(before.deviceRevision + 1);
    expect(after.incarnation).not.toBe(before.incarnation);
    expect(idb.deleteDatabaseCalls).toBe(0);
  });

  it('reload after the vault was re-created elsewhere (other vault_key_id): the stale record is purged key-scoped, the passphrase path stays', async () => {
    const first = await openUnlockedTab();
    await act(async () => {
      await first.remember().remember();
    });
    cleanup();
    shims.splice(0).forEach((s) => s.close());

    serverKeyId = VAULT_K2;
    renderTab({ silentUnlockOnLoad: true });
    await waitFor(() => expect(devkeys().size).toBe(0), { timeout: 10_000 });
    expect(stateText()).toBe('locked');
  });

  it('account switch: a device remembered for user A is never used for user B, and A\u2019s record is untouched', async () => {
    const first = await openUnlockedTab();
    await act(async () => {
      await first.remember().remember();
    });
    cleanup();
    shims.splice(0).forEach((s) => s.close());

    mocks.session.me = makeMe(USER_B);
    mocks.fetchVault.mockClear();
    renderTab({ silentUnlockOnLoad: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(stateText()).toBe('locked');
    expect(mocks.fetchVault).not.toHaveBeenCalled();
    expect(devkeys().has(formatDevKeyRecordKey(USER_A, VAULT_K))).toBe(true);
  });

  // ------------------------------------------------------------------------------------------------------------
  // CF-T18-KEYSCOPED-PURGE through the provider rows
  // ------------------------------------------------------------------------------------------------------------

  const seedRecord = (userId: string, keyId: string) =>
    devkeys().set(formatDevKeyRecordKey(userId, keyId), { user_id: userId, vault_key_id: keyId, wrapped_vk: new Uint8Array(60) });

  it('CF-T18-KEYSCOPED-PURGE: a 404 for the issued key K deletes K\u2019s record and keeps the K\u2019 record another tab created later', async () => {
    const tab = await openUnlockedTab();
    seedRecord(USER_A, VAULT_K);
    seedRecord(USER_A, VAULT_K2);
    const before = (await readDeviceMetaRecord(env))?.deviceRevision ?? 0;
    serverKeyId = null;
    await act(async () => {
      expect(await tab.vault().reloadVaultMeta()).toBeNull();
    });
    await waitFor(async () => expect((await readDeviceMetaRecord(env))?.deviceRevision).toBe(before + 1));
    expect([...devkeys().keys()]).toEqual([formatDevKeyRecordKey(USER_A, VAULT_K2)]);
  });

  it('CF-T18-KEYSCOPED-PURGE: a replacement vault K\u2019 deletes every stale key of the user and keeps K\u2019\u2019s own record', async () => {
    const tab = await openUnlockedTab();
    seedRecord(USER_A, VAULT_K);
    seedRecord(USER_A, VAULT_K2);
    serverKeyId = VAULT_K2;
    await act(async () => {
      await tab.vault().reloadVaultMeta();
    });
    await waitFor(() => expect(devkeys().has(formatDevKeyRecordKey(USER_A, VAULT_K))).toBe(false));
    expect(devkeys().has(formatDevKeyRecordKey(USER_A, VAULT_K2))).toBe(true);
  });
});

describe('P03-T18 DevKey: toggle store wake re-reads', () => {
  it('visibilitychange (visible), pageshow and focus re-read the toggle from sabk.device; a record deleted behind the tab shows off', async () => {
    const locks = new FakeWebLocks();
    const idb = new FakeDeviceIdb(locks);
    const env: DeviceEnvironment = { idbFactory: idb.createFactory(), locksManager: locks.createLockManager() };
    const record = { user_id: USER_A, vault_key_id: VAULT_K, dev_key: {}, wrapped_vk: new Uint8Array(60), created_at: 'x' };
    idb.store(DEVKEY_STORE_NAME).set(formatDevKeyRecordKey(USER_A, VAULT_K), record);
    const store = createRememberDeviceStore({
      env,
      getContext: () => ({
        userId: USER_A,
        vaultKeyId: VAULT_K,
        captureOp: () => {
          throw new Error('unused');
        },
        reloadVaultMeta: async () => null,
      }),
    });
    const stop = store.start();
    await waitFor(() => expect(store.getState().remembered).toBe(true));

    for (const wake of [
      () => document.dispatchEvent(new Event('visibilitychange')),
      () => window.dispatchEvent(new Event('pageshow')),
      () => window.dispatchEvent(new Event('focus')),
    ]) {
      idb.store(DEVKEY_STORE_NAME).set(formatDevKeyRecordKey(USER_A, VAULT_K), record);
      await store.refresh();
      expect(store.getState().remembered).toBe(true);
      idb.store(DEVKEY_STORE_NAME).clear(); // another tab Forgot without this tab hearing about it
      wake();
      await waitFor(() => expect(store.getState().remembered).toBe(false));
    }
    stop();
  });
});
