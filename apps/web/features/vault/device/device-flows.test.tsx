import { ProblemError } from '@engram/shared-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DeviceStoreEnvironment,
  formatDevKeyRecordKey,
  purgeDeviceKeysOnRevoked,
  readDeviceMetaRecord,
  setDefaultDeviceStoreEnvironmentForTests,
  setKnownDeviceSessionUserId,
} from '@/features/vault/device-store';
import { DEVKEY_STORE_NAME, type LockEpochEnvironment, recordLockEpochEvent } from '@/features/vault/lock-epoch';
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
import { createRememberDeviceStore, type RememberDeviceState } from './remember-store';
import type { DeviceTestBridge } from './test-bridge';
import { useRememberDevice, type UseRememberDeviceResult } from './use-remember-device';

function getDeviceTestBridge(): DeviceTestBridge {
  const win = window as unknown as Record<string, unknown>;
  const bridge = win['__engramDeviceTestBridge'];
  if (!bridge || typeof bridge !== 'object') {
    throw new Error('Missing __engramDeviceTestBridge');
  }
  return bridge as DeviceTestBridge;
}

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
  router: {
    pathname: '/app',
    searchParams: new URLSearchParams(),
    replace: vi.fn(),
    push: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.router.pathname,
  useRouter: () => ({ replace: mocks.router.replace, push: mocks.router.push }),
  useSearchParams: () => mocks.router.searchParams,
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
    mocks.router.pathname = '/app';
    mocks.router.searchParams = new URLSearchParams();
    mocks.router.replace.mockReset();
    mocks.router.push.mockReset();
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
    rerender: () => void;
  }

  function renderTab(
    options: {
      silentUnlockOnLoad?: boolean;
      testHooks?: RememberTestHooks;
      deviceStoreEnv?: DeviceStoreEnvironment;
      lockEpochEnv?: LockEpochEnvironment;
    } = {},
  ): TabHandle {
    const shim = createWorkerShim({ deriveKek: fastTestDeriveKek });
    shims.push(shim);
    const handle: { vault?: VaultContextValue; remember?: UseRememberDeviceResult } = {};
    const queryClient = new QueryClient();
    const effectiveLockEpochEnv =
      options.lockEpochEnv ?? { idbFactory: idb.createFactory(), locksManager: locks.createLockManager() };
    const effectiveDeviceStoreEnv = options.deviceStoreEnv ?? { idbFactory: idb.createFactory() };
    function Probe() {
      const vault = useVault();
      const remember = useRememberDevice({ env, testHooks: options.testHooks });
      handle.vault = vault;
      handle.remember = remember;
      return <div data-testid="vault-state">{vault.state}</div>;
    }
    const rendered = render(
      <QueryClientProvider client={queryClient}>
        <VaultProvider
          createWorker={() => shim.port}
          lockEpochEnv={effectiveLockEpochEnv}
          deviceStoreEnv={effectiveDeviceStoreEnv}
          silentUnlockOnLoad={options.silentUnlockOnLoad}
        >
          <Probe />
        </VaultProvider>
      </QueryClientProvider>,
    );
    return {
      vault: () => handle.vault!,
      remember: () => handle.remember!,
      rerender: () =>
        rendered.rerender(
          <QueryClientProvider client={queryClient}>
            <VaultProvider
              createWorker={() => shim.port}
              lockEpochEnv={effectiveLockEpochEnv}
              deviceStoreEnv={effectiveDeviceStoreEnv}
              silentUnlockOnLoad={options.silentUnlockOnLoad}
            >
              <Probe />
            </VaultProvider>
          </QueryClientProvider>,
        ),
    };
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

  it('R1-12: remember() and forget() resolve with the settled final state (busy: false) matching getState() on success, abort, and storage failure', async () => {
    let releaseAbort!: () => void;
    let reachedAbort!: () => void;
    let pauseOnNextRemember = false;
    const tab = await openUnlockedTab({
      testHooks: {
        afterWebCrypto: async () => {
          if (!pauseOnNextRemember) return;
          reachedAbort();
          await new Promise<void>((r) => {
            releaseAbort = r;
          });
        },
      },
    });

    // 1. Success for remember() and forget()
    let remSuccess!: RememberDeviceState;
    await act(async () => {
      remSuccess = await tab.remember().remember();
    });
    expect(remSuccess.busy).toBe(false);
    expect(remSuccess.remembered).toBe(true);
    expect(remSuccess.status).toBe('ready');
    expect(tab.remember().busy).toBe(false);

    let fgtSuccess!: RememberDeviceState;
    await act(async () => {
      fgtSuccess = await tab.remember().forget();
    });
    expect(fgtSuccess.busy).toBe(false);
    expect(fgtSuccess.remembered).toBe(false);
    expect(fgtSuccess.status).toBe('ready');
    expect(tab.remember().busy).toBe(false);

    // 2. Abort for remember()
    pauseOnNextRemember = true;
    const reachedP = new Promise<void>((r) => {
      reachedAbort = r;
    });
    let remAbortPromise!: Promise<RememberDeviceState>;
    act(() => {
      remAbortPromise = tab.remember().remember();
    });
    await reachedP;
    await act(async () => {
      await purgeDeviceKeysOnRevoked(null, env);
    });
    let remAborted!: RememberDeviceState;
    await act(async () => {
      releaseAbort();
      remAborted = await remAbortPromise;
    });
    pauseOnNextRemember = false;
    expect(remAborted.busy).toBe(false);
    expect(remAborted.lastAbortReason).toBe('meta_changed');
    expect(tab.remember().busy).toBe(false);

    // 3. Storage failure for remember() and forget()
    idb.options = { blockOpen: true };
    let remUnavailable!: RememberDeviceState;
    await act(async () => {
      remUnavailable = await tab.remember().remember();
    });
    expect(remUnavailable.busy).toBe(false);
    expect(remUnavailable.status).toBe('unavailable');
    expect(tab.remember().busy).toBe(false);

    let fgtUnavailable!: RememberDeviceState;
    await act(async () => {
      fgtUnavailable = await tab.remember().forget();
    });
    expect(fgtUnavailable.busy).toBe(false);
    expect(fgtUnavailable.status).toBe('unavailable');
    expect(tab.remember().busy).toBe(false);
  });

  it('R1-13: initial and wake refresh keep storage failure as unavailable (never erasing unavailable to ready/off while IDB is broken), and storage recovery returns ready while passphrase stays usable', async () => {
    // Separate device IDB for the remember hook so we can fault its initial/wake reads without breaking
    // VaultProvider's fail-closed lockEpoch baseline check on createVault / unlockPassphrase.
    const hookIdb = new FakeDeviceIdb(locks);
    hookIdb.options = { failOpen: true };
    env = { idbFactory: hookIdb.createFactory(), locksManager: locks.createLockManager() };

    const tab = await openUnlockedTab();
    await waitFor(() => expect(tab.remember().status).toBe('unavailable'));
    expect(tab.remember().remembered).toBe(false);

    // Wake events while storage is still broken must keep status: 'unavailable', not overwrite with 'ready'.
    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('pageshow'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      await tab.remember().refresh();
    });
    expect(tab.remember().status).toBe('unavailable');
    expect(tab.remember().remembered).toBe(false);

    // Passphrase operations remain usable while the hook's device storage is unavailable.
    await act(async () => {
      await tab.vault().lock({ broadcast: false, reason: 'manual' });
    });
    expect(stateText()).toBe('locked');
    await act(async () => {
      await tab.vault().unlockPassphrase({
        passphrase: PASSPHRASE,
        kdf: created!.kdf,
        vaultKeyWrappedByKek: created!.vault_key_wrapped_by_kek,
        privateKeysWrapped: created!.private_keys_wrapped,
        opGeneration: tab.vault().captureOpGeneration(),
      });
    });
    expect(stateText()).toBe('unlocked');

    // Storage recovery: wake / refresh returns status to 'ready'.
    hookIdb.options = {};
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await tab.remember().refresh();
    });
    await waitFor(() => expect(tab.remember().status).toBe('ready'));
    expect(tab.remember().remembered).toBe(false);
  });

  it('R1-11 / R1-24: account switch A->B while A\u2019s Remember is parked fences A\u2019s aborted continuation so it never overwrites B\u2019s ready/off hook state', async () => {
    let releaseParkedA!: () => void;
    let reachedParkedA!: () => void;
    const reachedP = new Promise<void>((r) => {
      reachedParkedA = r;
    });
    const parkedGate = new Promise<void>((r) => {
      releaseParkedA = r;
    });

    const tab = await openUnlockedTab({
      testHooks: {
        afterWebCrypto: async () => {
          reachedParkedA();
          await parkedGate;
        },
      },
    });

    // Seed an existing valid record for USER_A so A's post-abort DB read would see remembered: true if unfenced.
    await act(async () => {
      idb.store(DEVKEY_STORE_NAME).set(formatDevKeyRecordKey(USER_A, VAULT_K), {
        user_id: USER_A,
        vault_key_id: VAULT_K,
        dev_key: {},
        wrapped_vk: new Uint8Array(60),
        created_at: '2026-01-01T00:00:00Z',
      });
    });

    let pendingA!: Promise<unknown>;
    act(() => {
      pendingA = tab.remember().remember();
    });
    await reachedP;

    // Switch session to USER_B while A's Remember is parked, and load B's vault metadata (VAULT_K2).
    serverKeyId = VAULT_K2;
    mocks.session.me = makeMe(USER_B);
    await act(async () => {
      await tab.vault().reloadVaultMeta();
    });
    await act(async () => {
      await tab.remember().refresh();
    });
    await waitFor(() => expect(tab.remember().status).toBe('ready'));
    expect(tab.remember().remembered).toBe(false);
    expect(tab.remember().busy).toBe(false);

    // Now release A's parked Remember: it aborts (generation moved on account switch) and must NOT publish A's state over B.
    await act(async () => {
      releaseParkedA();
      await pendingA;
    });
    expect(tab.remember().status).toBe('ready');
    expect(tab.remember().remembered).toBe(false);
    expect(tab.remember().busy).toBe(false);
    expect(tab.remember().notice).toBeNull();
    expect(tab.remember().lastAbortReason).toBeNull();
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

  it('R1-4 / R1-23: automatic silentUnlockOnLoad on /app/unlock redirects to sanitized returnTo and rejects unsafe returnTo', async () => {
    const first = await openUnlockedTab();
    await act(async () => {
      await first.remember().remember();
    });
    cleanup();
    shims.splice(0).forEach((s) => s.close());

    // 1. Valid returnTo=%2Fapp%2Fsettings -> replaces to /app/settings (and re-applies if RouteGuard replaced to /app first).
    mocks.router.pathname = '/app/unlock';
    mocks.router.searchParams = new URLSearchParams('returnTo=%2Fapp%2Fsettings');
    mocks.router.replace.mockReset();
    const tab1 = renderTab({ silentUnlockOnLoad: true });
    await waitFor(() => expect(stateText()).toBe('unlocked'), { timeout: 10_000 });
    await waitFor(() => expect(mocks.router.replace).toHaveBeenCalledWith('/app/settings'));

    // Simulate RouteGuard replacing to /app right before SilentUnlockReturnTo's effect or concurrently:
    mocks.router.pathname = '/app';
    await act(async () => {
      tab1.rerender();
    });
    expect(mocks.router.replace).toHaveBeenLastCalledWith('/app/settings');
    cleanup();
    shims.splice(0).forEach((s) => s.close());

    // 2. Unsafe returnTo -> rejected, replaces to /app.
    mocks.router.pathname = '/app/unlock';
    mocks.router.searchParams = new URLSearchParams('returnTo=https%3A%2F%2Fevil.example%2Fphish');
    mocks.router.replace.mockReset();
    renderTab({ silentUnlockOnLoad: true });
    await waitFor(() => expect(stateText()).toBe('unlocked'), { timeout: 10_000 });
    await waitFor(() => expect(mocks.router.replace).toHaveBeenCalledWith('/app'));
    expect(mocks.router.replace).not.toHaveBeenCalledWith(expect.stringContaining('evil.example'));
  });

  it('R2-5 / R2-8: navigating away from /app/unlock (to /app/unlock/forgot or /app/auth/reauth) while automatic silent GET is held retires the captured returnTo so completion stays on the chosen route', async () => {
    const first = await openUnlockedTab();
    await act(async () => {
      await first.remember().remember();
    });
    cleanup();
    shims.splice(0).forEach((s) => s.close());

    for (const intentionalRoute of ['/app/unlock/forgot', '/app/auth/reauth'] as const) {
      let holdGet = true;
      let releaseGet: (() => void) | null = null;
      mocks.fetchVault.mockImplementation(async () => {
        if (holdGet) {
          await new Promise<void>((resolve) => {
            releaseGet = resolve;
          });
        }
        return vaultState(VAULT_K);
      });

      mocks.router.pathname = '/app/unlock';
      mocks.router.searchParams = new URLSearchParams('returnTo=%2Fapp%2Fsettings');
      mocks.router.replace.mockReset();
      const tab = renderTab({ silentUnlockOnLoad: true });
      await waitFor(() => expect(releaseGet).not.toBeNull());

      // User intentionally navigates away (e.g. clicks "Forgot passphrase" -> /app/unlock/forgot, or /app/auth/reauth) while GET is held:
      mocks.router.pathname = intentionalRoute;
      mocks.router.searchParams = new URLSearchParams();
      await act(async () => {
        tab.rerender();
      });

      // Release automatic silent GET -> vault unlocks, but SilentUnlockReturnTo MUST NOT redirect to /app/settings or /app!
      await act(async () => {
        holdGet = false;
        releaseGet?.();
      });
      await waitFor(() => expect(stateText()).toBe('unlocked'), { timeout: 10_000 });
      expect(mocks.router.pathname).toBe(intentionalRoute);
      expect(mocks.router.replace).not.toHaveBeenCalled();

      // Even if the user later visits /app after having retired the capture on the intentional route, the retired capture must not resurface:
      mocks.router.pathname = '/app';
      await act(async () => {
        tab.rerender();
      });
      expect(mocks.router.replace).not.toHaveBeenCalled();

      cleanup();
      shims.splice(0).forEach((s) => s.close());
    }
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

  it('R1-1 / R1-20: silent unlock registers durable lockEpoch baseline at intent start BEFORE snapshot/GET; sibling durable lock with suppressed notification keeps the vault locked (and control without the lock unlocks)', async () => {
    const first = await openUnlockedTab();
    await act(async () => {
      await first.remember().remember();
    });
    cleanup();
    shims.splice(0).forEach((s) => s.close());

    // 1. Held GET + sibling durable lock + suppressed notification (QuietBroadcastChannel drops all broadcasts) -> stays locked.
    let holdGet = true;
    let releaseGet: (() => void) | null = null;
    mocks.fetchVault.mockImplementation(async () => {
      if (holdGet) {
        await new Promise<void>((resolve) => {
          releaseGet = resolve;
        });
      }
      if (serverKeyId === null) throw vaultAbsentError();
      return vaultState(serverKeyId);
    });

    const tab = renderTab({ silentUnlockOnLoad: false });
    let silentPromise!: Promise<unknown>;
    act(() => {
      silentPromise = tab.vault().silentUnlock();
    });
    await waitFor(() => expect(releaseGet).not.toBeNull());

    // Sibling tab commits a durable lockEpoch increment while GET /vault is held (BroadcastChannel is suppressed).
    await act(async () => {
      await recordLockEpochEvent(tab.vault().tabKnownLockEpoch, {
        idbFactory: idb.createFactory(),
        locksManager: locks.createLockManager(),
      });
    });

    let silentResult: unknown;
    await act(async () => {
      holdGet = false;
      releaseGet?.();
      silentResult = await silentPromise;
    });
    expect(silentResult).toEqual({ status: 'skipped', reason: 'stale' });
    expect(stateText()).toBe('locked');
    expect(tab.vault().workerState).toBe('locked');
    expect(tab.vault().lastErrorCode).toBeNull();

    // 2. Control without the sibling lock: held GET released without a lockEpoch change unlocks cleanly.
    holdGet = true;
    releaseGet = null;
    let controlPromise!: Promise<unknown>;
    act(() => {
      controlPromise = tab.vault().silentUnlock();
    });
    await waitFor(() => expect(releaseGet).not.toBeNull());
    let controlResult: unknown;
    await act(async () => {
      holdGet = false;
      releaseGet?.();
      controlResult = await controlPromise;
    });
    expect(controlResult).toEqual({ status: 'unlocked' });
    await waitFor(() => expect(stateText()).toBe('unlocked'), { timeout: 10_000 });
  });

  it('R2-1 / R2-7: per-intent baseline ownership keeps a manual unlock baseline intact when an overlapping automatic silent attempt skips (parked snapshot) or fails GET and cleans up across a missed sibling durable lock', async () => {
    // Create the vault so `created` holds valid KDF + wrapped VK + wrapped private keys, and seal an entry to verify no plaintext can be opened while locked.
    const first = await openUnlockedTab();
    const sealed = await first.vault().getClient().sealEntryNow({
      entryId: '11111111-1111-4111-8111-111111111111',
      keyId: VAULT_K,
      plaintext: new TextEncoder().encode('r2-1-secret-entry-plaintext'),
    });
    cleanup();
    shims.splice(0).forEach((s) => s.close());

    // --- Variant A (R2-1): unremembered device, park automatic silent snapshot, begin manual GET, automatic cleans up, sibling durable lock, release manual GET -> stale, locked, no plaintext ---
    expect(devkeys().size).toBe(0);
    const baseFactoryA = idb.createFactory();
    let holdAutoSnapshot = true;
    let releaseAutoSnapshot: (() => void) | null = null;
    const gatedDeviceFactoryA: IDBFactory = {
      ...baseFactoryA,
      open: ((...args: Parameters<IDBFactory['open']>) => {
        if (!holdAutoSnapshot) {
          return baseFactoryA.open(...args);
        }
        const outerReq: Record<string, unknown> = {
          result: null,
          error: null,
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
          onblocked: null,
        };
        releaseAutoSnapshot = () => {
          const inner = baseFactoryA.open(...args);
          inner.onupgradeneeded = (ev) => {
            outerReq.result = inner.result;
            (outerReq.onupgradeneeded as ((e: IDBVersionChangeEvent) => void) | null)?.(ev);
          };
          inner.onsuccess = (ev) => {
            outerReq.result = inner.result;
            (outerReq.onsuccess as ((e: Event) => void) | null)?.(ev);
          };
          inner.onerror = (ev) => {
            outerReq.error = inner.error;
            (outerReq.onerror as ((e: Event) => void) | null)?.(ev);
          };
          inner.onblocked = (ev) => {
            (outerReq.onblocked as ((e: IDBVersionChangeEvent) => void) | null)?.(ev);
          };
        };
        return outerReq as unknown as IDBOpenDBRequest;
      }) as IDBFactory['open'],
    };

    let holdManualGet = true;
    let releaseManualGet: (() => void) | null = null;
    mocks.fetchVault.mockImplementation(async () => {
      if (holdManualGet) {
        await new Promise<void>((resolve) => {
          releaseManualGet = resolve;
        });
      }
      return vaultState(VAULT_K);
    });

    const tabA = renderTab({
      silentUnlockOnLoad: true,
      deviceStoreEnv: { idbFactory: gatedDeviceFactoryA },
    });
    await waitFor(() => expect(releaseAutoSnapshot).not.toBeNull());

    // Begin manual passphrase unlock in the same generation while automatic silent snapshot is parked:
    const manualOpA = tabA.vault().beginOp();
    let manualMetaPromiseA!: Promise<VaultState | null>;
    act(() => {
      manualMetaPromiseA = tabA.vault().reloadVaultMeta();
    });
    await waitFor(() => expect(releaseManualGet).not.toBeNull());

    // Let automatic silent snapshot finish (no records -> skipped -> finally cleans up ONLY its own baseline):
    await act(async () => {
      holdAutoSnapshot = false;
      releaseAutoSnapshot?.();
      await new Promise((r) => setTimeout(r, 20));
    });

    // Sibling tab commits a durable lockEpoch increment with BroadcastChannel notifications suppressed:
    await act(async () => {
      await recordLockEpochEvent(tabA.vault().tabKnownLockEpoch, {
        idbFactory: idb.createFactory(),
        locksManager: locks.createLockManager(),
      });
    });

    // Release manual GET and run unlockPassphrase: MUST verify manualOpA's original baseline and reject STALE_GENERATION!
    let manualMetaA: VaultState | null = null;
    await act(async () => {
      holdManualGet = false;
      releaseManualGet?.();
      manualMetaA = await manualMetaPromiseA;
    });
    expect(manualMetaA).not.toBeNull();
    let manualErrA: unknown = null;
    await act(async () => {
      try {
        await tabA.vault().unlockPassphrase({
          passphrase: PASSPHRASE,
          kdf: manualMetaA!.kdf,
          vaultKeyWrappedByKek: manualMetaA!.vault_key_wrapped_by_kek,
          privateKeysWrapped: manualMetaA!.private_keys_wrapped,
          opGeneration: manualOpA.opGeneration,
        });
      } catch (err) {
        manualErrA = err;
      }
    });
    expect(manualErrA).toMatchObject({ code: 'STALE_GENERATION' });
    expect(stateText()).toBe('locked');
    expect(tabA.vault().workerState).toBe('locked');
    await expect(
      tabA.vault().getClient().openEntryNow({
        entryId: '11111111-1111-4111-8111-111111111111',
        envelope: sealed.envelope,
        ciphertext: sealed.ciphertext,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_LOCKED' });

    cleanup();
    shims.splice(0).forEach((s) => s.close());

    // --- Variant B (R2-7): remembered device, automatic GET fails while manual GET is pending in same generation, automatic cleans up, sibling durable lock, release manual GET -> stale, locked, no plaintext ---
    // Unlock the EXISTING vault from Variant A (do not call createVault a second time, which would generate a different VK than `sealed`!).
    const rememberSetup = renderTab();
    await act(async () => {
      await rememberSetup.vault().unlockPassphrase({
        passphrase: PASSPHRASE,
        kdf: created!.kdf,
        vaultKeyWrappedByKek: created!.vault_key_wrapped_by_kek,
        privateKeysWrapped: created!.private_keys_wrapped,
        opGeneration: rememberSetup.vault().captureOpGeneration(),
      });
      await rememberSetup.vault().reloadVaultMeta();
    });
    await waitFor(() => expect(stateText()).toBe('unlocked'), { timeout: 10_000 });
    await waitFor(() => expect(rememberSetup.remember().available).toBe(true));
    await act(async () => {
      await rememberSetup.remember().remember();
    });
    expect(devkeys().size).toBe(1);
    cleanup();
    shims.splice(0).forEach((s) => s.close());
    let callIndex = 0;
    let releaseAutoGetFail: (() => void) | null = null;
    let releaseManualGetB: (() => void) | null = null;
    mocks.fetchVault.mockImplementation(async () => {
      callIndex += 1;
      const myCall = callIndex;
      if (myCall === 1) {
        await new Promise<void>((resolve) => {
          releaseAutoGetFail = resolve;
        });
        throw new TypeError('simulated transient network error during automatic silent GET');
      }
      if (myCall === 2) {
        await new Promise<void>((resolve) => {
          releaseManualGetB = resolve;
        });
      }
      return vaultState(VAULT_K);
    });

    const tabB = renderTab({ silentUnlockOnLoad: true });
    await waitFor(() => expect(releaseAutoGetFail).not.toBeNull());

    // Begin manual unlock in the same generation while automatic GET #1 is held:
    const manualOpB = tabB.vault().beginOp();
    let manualMetaPromiseB!: Promise<VaultState | null>;
    act(() => {
      manualMetaPromiseB = tabB.vault().reloadVaultMeta();
    });
    await waitFor(() => expect(releaseManualGetB).not.toBeNull());

    // Also exercise a second same-generation beginOp() before manualOpB dispatches to prove it cannot overwrite manualOpB's earlier marker:
    await act(async () => {
      await recordLockEpochEvent(tabB.vault().tabKnownLockEpoch, {
        idbFactory: idb.createFactory(),
        locksManager: locks.createLockManager(),
      });
    });
    // A later same-generation beginOp() captures the post-lock marker E2, while manualOpB still owns E1:
    tabB.vault().beginOp();

    // Release automatic GET #1 so it fails with network error and runs its `finally` cleanup:
    await act(async () => {
      releaseAutoGetFail?.();
      await new Promise((r) => setTimeout(r, 20));
    });

    // Release manual GET #2 and dispatch manualOpB: MUST verify manualOpB's pre-lock baseline E1 and reject STALE_GENERATION!
    let manualMetaB: VaultState | null = null;
    await act(async () => {
      releaseManualGetB?.();
      manualMetaB = await manualMetaPromiseB;
    });
    expect(manualMetaB).not.toBeNull();
    let manualErrB: unknown = null;
    await act(async () => {
      try {
        await tabB.vault().unlockPassphrase({
          passphrase: PASSPHRASE,
          kdf: manualMetaB!.kdf,
          vaultKeyWrappedByKek: manualMetaB!.vault_key_wrapped_by_kek,
          privateKeysWrapped: manualMetaB!.private_keys_wrapped,
          opGeneration: manualOpB.opGeneration,
        });
      } catch (err) {
        manualErrB = err;
      }
    });
    expect(manualErrB).toMatchObject({ code: 'STALE_GENERATION' });
    expect(stateText()).toBe('locked');
    expect(tabB.vault().workerState).toBe('locked');
    await expect(
      tabB.vault().getClient().openEntryNow({
        entryId: '11111111-1111-4111-8111-111111111111',
        envelope: sealed.envelope,
        ciphertext: sealed.ciphertext,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_LOCKED' });

    // --- Control: same overlapping sequence WITHOUT a sibling durable lock opens cleanly and decrypts ---
    callIndex = 0;
    releaseAutoGetFail = null;
    releaseManualGetB = null;
    let manualOnlyPromise!: Promise<VaultState | null>;
    mocks.fetchVault.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseManualGetB = resolve;
      });
      return vaultState(VAULT_K);
    });
    const controlOp = tabB.vault().beginOp();
    act(() => {
      manualOnlyPromise = tabB.vault().reloadVaultMeta();
    });
    await waitFor(() => expect(releaseManualGetB).not.toBeNull());
    let controlMeta: VaultState | null = null;
    await act(async () => {
      releaseManualGetB?.();
      controlMeta = await manualOnlyPromise;
    });
    await act(async () => {
      await tabB.vault().unlockPassphrase({
        passphrase: PASSPHRASE,
        kdf: controlMeta!.kdf,
        vaultKeyWrappedByKek: controlMeta!.vault_key_wrapped_by_kek,
        privateKeysWrapped: controlMeta!.private_keys_wrapped,
        opGeneration: controlOp.opGeneration,
      });
    });
    await waitFor(() => expect(stateText()).toBe('unlocked'), { timeout: 10_000 });
    expect(tabB.vault().workerState).toBe('unlocked');
    const opened = await tabB.vault().getClient().openEntryNow({
      entryId: '11111111-1111-4111-8111-111111111111',
      envelope: sealed.envelope,
      ciphertext: sealed.ciphertext,
    });
    expect(opened.plaintext).toBe('r2-1-secret-entry-plaintext');
  });

  it('R3-1: silent intent registers owned baseline and parks; manual beginOp + wrong-passphrase dispatch fails without consuming silent entry; sibling durable lock + release silent fails closed (and control without lock opens)', async () => {
    const first = await openUnlockedTab();
    const sealed = await first.vault().getClient().sealEntryNow({
      entryId: '11111111-1111-4111-8111-111111111111',
      keyId: VAULT_K,
      plaintext: new TextEncoder().encode('r3-1-secret-entry-plaintext'),
    });
    await act(async () => {
      await first.remember().remember();
    });
    expect(devkeys().size).toBe(1);
    cleanup();
    shims.splice(0).forEach((s) => s.close());

    let callIndex = 0;
    let releaseSilentGet: (() => void) | null = null;
    mocks.fetchVault.mockImplementation(async () => {
      callIndex += 1;
      if (callIndex === 1) {
        await new Promise<void>((resolve) => {
          releaseSilentGet = resolve;
        });
      }
      return vaultState(VAULT_K);
    });

    const tab = renderTab({ silentUnlockOnLoad: false });
    const activeShim = shims[shims.length - 1]!;
    const deviceBridge = getDeviceTestBridge;

    // 1. Silent intent starts first, registers its `owned` baseline entry, and parks on GET /vault #1:
    let silentPromise!: Promise<unknown>;
    act(() => {
      silentPromise = tab.vault().silentUnlock();
    });
    await waitFor(() => expect(releaseSilentGet).not.toBeNull());
    const afterSilentStart = deviceBridge().intentBaselineWitness();
    expect(afterSilentStart.pending).toHaveLength(1);
    const silentEntry = afterSilentStart.pending[0]!;
    expect(silentEntry.kind).toBe('owned');
    const genBefore = tab.vault().getClient().getGeneration();

    // 2. Manual beginOp() registers a `manual` baseline entry, fetches GET /vault #2, and dispatches with a WRONG passphrase:
    const manualOp = tab.vault().beginOp();
    expect(manualOp.opGeneration).toBe(genBefore);
    const afterManualBegin = deviceBridge().intentBaselineWitness();
    expect(afterManualBegin.pending).toEqual([
      { generation: genBefore, id: silentEntry.id, kind: 'owned' },
      { generation: genBefore, id: silentEntry.id + 1, kind: 'manual' },
    ]);
    let manualMeta: VaultState | null = null;
    await act(async () => {
      manualMeta = await tab.vault().reloadVaultMeta();
    });
    expect(manualMeta).not.toBeNull();
    let manualErr: unknown = null;
    await act(async () => {
      try {
        await tab.vault().unlockPassphrase({
          passphrase: 'wrong-passphrase-for-r3-1',
          kdf: manualMeta!.kdf,
          vaultKeyWrappedByKek: manualMeta!.vault_key_wrapped_by_kek,
          privateKeysWrapped: manualMeta!.private_keys_wrapped,
          opGeneration: manualOp.opGeneration,
        });
      } catch (err) {
        manualErr = err;
      }
    });
    expect(manualErr).toMatchObject({ code: 'AEAD_DECRYPT_FAILED' });
    // Generation is unchanged and Worker stays locked; manual dispatch consumed ONLY its own `manual` entry, leaving silent's `owned` entry intact!
    expect(tab.vault().getClient().getGeneration()).toBe(genBefore);
    expect(tab.vault().workerState).toBe('locked');
    const afterManualFail = deviceBridge().intentBaselineWitness();
    expect(afterManualFail.pending).toEqual([
      { generation: genBefore, id: silentEntry.id, kind: 'owned' },
    ]);
    expect(afterManualFail.trace).toContainEqual({
      action: 'consume',
      generation: genBefore,
      id: silentEntry.id + 1,
      kind: 'manual',
    });

    // 3. Sibling tab commits a durable lockEpoch increment with BroadcastChannel notifications suppressed:
    await act(async () => {
      await recordLockEpochEvent(tab.vault().tabKnownLockEpoch, {
        idbFactory: idb.createFactory(),
        locksManager: locks.createLockManager(),
      });
    });

    // 4. Release parked silent GET #1 -> silent consumes its own `owned` baseline (pre-lock E1), sees mismatch against E2, and FAILS CLOSED:
    const devKeyCmdsBefore = activeShim.workerReceivedRequests.filter((c) => c.type === 'unlockDevKey').length;
    let silentResult: unknown;
    await act(async () => {
      releaseSilentGet?.();
      silentResult = await silentPromise;
    });
    expect(silentResult).toEqual({ status: 'skipped', reason: 'stale' });
    expect(activeShim.workerReceivedRequests.filter((c) => c.type === 'unlockDevKey')).toHaveLength(devKeyCmdsBefore);
    expect(stateText()).toBe('locked');
    expect(tab.vault().workerState).toBe('locked');
    const afterSilentDone = deviceBridge().intentBaselineWitness();
    expect(afterSilentDone.pending).toHaveLength(0);
    expect(afterSilentDone.trace).toContainEqual({
      action: 'consume',
      generation: genBefore,
      id: silentEntry.id,
      kind: 'owned',
    });
    expect(afterSilentDone.trace.some((e) => e.action === 'capture_fresh')).toBe(false);
    await expect(
      tab.vault().getClient().openEntryNow({
        entryId: '11111111-1111-4111-8111-111111111111',
        envelope: sealed.envelope,
        ciphertext: sealed.ciphertext,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_LOCKED' });

    // 5. Control without the sibling lock: silent parked + manual wrong passphrase -> release silent opens cleanly and decrypts!
    callIndex = 0;
    releaseSilentGet = null;
    let controlSilentPromise!: Promise<unknown>;
    act(() => {
      controlSilentPromise = tab.vault().silentUnlock();
    });
    await waitFor(() => expect(releaseSilentGet).not.toBeNull());
    const controlManualOp = tab.vault().beginOp();
    let controlManualMeta: VaultState | null = null;
    await act(async () => {
      controlManualMeta = await tab.vault().reloadVaultMeta();
    });
    await act(async () => {
      await expect(
        tab.vault().unlockPassphrase({
          passphrase: 'wrong-passphrase-for-r3-1-control',
          kdf: controlManualMeta!.kdf,
          vaultKeyWrappedByKek: controlManualMeta!.vault_key_wrapped_by_kek,
          privateKeysWrapped: controlManualMeta!.private_keys_wrapped,
          opGeneration: controlManualOp.opGeneration,
        }),
      ).rejects.toMatchObject({ code: 'AEAD_DECRYPT_FAILED' });
    });
    expect(tab.vault().workerState).toBe('locked');
    let controlSilentResult: unknown;
    await act(async () => {
      releaseSilentGet?.();
      controlSilentResult = await controlSilentPromise;
    });
    expect(controlSilentResult).toEqual({ status: 'unlocked' });
    await waitFor(() => expect(stateText()).toBe('unlocked'), { timeout: 10_000 });
    expect(tab.vault().workerState).toBe('unlocked');
    const opened = await tab.vault().getClient().openEntryNow({
      entryId: '11111111-1111-4111-8111-111111111111',
      envelope: sealed.envelope,
      ciphertext: sealed.ciphertext,
    });
    expect(opened.plaintext).toBe('r3-1-secret-entry-plaintext');
  });

  it('R3-2: reverse registration order (manual beginOp + parked GET first, silent intent second, then manual wrong-passphrase dispatch, sibling durable lock, release silent) fails closed; control opens', async () => {
    const first = await openUnlockedTab();
    const sealed = await first.vault().getClient().sealEntryNow({
      entryId: '11111111-1111-4111-8111-111111111111',
      keyId: VAULT_K,
      plaintext: new TextEncoder().encode('r3-2-secret-entry-plaintext'),
    });
    await act(async () => {
      await first.remember().remember();
    });
    expect(devkeys().size).toBe(1);
    cleanup();
    shims.splice(0).forEach((s) => s.close());

    let callIndex = 0;
    let releaseManualGet: (() => void) | null = null;
    let releaseSilentGet: (() => void) | null = null;
    mocks.fetchVault.mockImplementation(async () => {
      callIndex += 1;
      const myCall = callIndex;
      if (myCall === 1) {
        await new Promise<void>((resolve) => {
          releaseManualGet = resolve;
        });
      } else if (myCall === 2) {
        await new Promise<void>((resolve) => {
          releaseSilentGet = resolve;
        });
      }
      return vaultState(VAULT_K);
    });

    const tab = renderTab({ silentUnlockOnLoad: false });
    const activeShim = shims[shims.length - 1]!;
    const deviceBridge = getDeviceTestBridge;

    // 1. Manual intent starts FIRST (`manual` entry #1) and parks on GET /vault #1:
    const manualOp = tab.vault().beginOp();
    let manualMetaPromise!: Promise<VaultState | null>;
    act(() => {
      manualMetaPromise = tab.vault().reloadVaultMeta();
    });
    await waitFor(() => expect(releaseManualGet).not.toBeNull());

    // 2. Silent intent starts SECOND (`owned` entry #2) and parks on GET /vault #2:
    let silentPromise!: Promise<unknown>;
    act(() => {
      silentPromise = tab.vault().silentUnlock();
    });
    await waitFor(() => expect(releaseSilentGet).not.toBeNull());

    const witnessBefore = deviceBridge().intentBaselineWitness();
    expect(witnessBefore.pending).toHaveLength(2);
    expect(witnessBefore.pending[0]!.kind).toBe('manual');
    expect(witnessBefore.pending[1]!.kind).toBe('owned');
    const manualEntryId = witnessBefore.pending[0]!.id;
    const silentEntryId = witnessBefore.pending[1]!.id;

    // 3. Release manual GET #1 and dispatch with WRONG passphrase -> consumes `manualEntryId`, leaves `silentEntryId` untouched:
    let manualMeta: VaultState | null = null;
    await act(async () => {
      releaseManualGet?.();
      manualMeta = await manualMetaPromise;
    });
    await act(async () => {
      await expect(
        tab.vault().unlockPassphrase({
          passphrase: 'wrong-passphrase-for-r3-2',
          kdf: manualMeta!.kdf,
          vaultKeyWrappedByKek: manualMeta!.vault_key_wrapped_by_kek,
          privateKeysWrapped: manualMeta!.private_keys_wrapped,
          opGeneration: manualOp.opGeneration,
        }),
      ).rejects.toMatchObject({ code: 'AEAD_DECRYPT_FAILED' });
    });
    expect(tab.vault().workerState).toBe('locked');
    expect(deviceBridge().intentBaselineWitness().pending).toEqual([
      { generation: manualOp.opGeneration, id: silentEntryId, kind: 'owned' },
    ]);
    expect(deviceBridge().intentBaselineWitness().trace).toContainEqual({
      action: 'consume',
      generation: manualOp.opGeneration,
      id: manualEntryId,
      kind: 'manual',
    });

    // 4. Sibling tab commits a durable lockEpoch increment with BroadcastChannel notifications suppressed:
    await act(async () => {
      await recordLockEpochEvent(tab.vault().tabKnownLockEpoch, {
        idbFactory: idb.createFactory(),
        locksManager: locks.createLockManager(),
      });
    });

    // 5. Release silent GET #2 -> consumes `silentEntryId` (pre-lock baseline), detects lockEpoch mismatch, fails closed:
    const devKeyCmdsBefore = activeShim.workerReceivedRequests.filter((c) => c.type === 'unlockDevKey').length;
    let silentResult: unknown;
    await act(async () => {
      releaseSilentGet?.();
      silentResult = await silentPromise;
    });
    expect(silentResult).toEqual({ status: 'skipped', reason: 'stale' });
    expect(activeShim.workerReceivedRequests.filter((c) => c.type === 'unlockDevKey')).toHaveLength(devKeyCmdsBefore);
    expect(stateText()).toBe('locked');
    expect(tab.vault().workerState).toBe('locked');
    expect(deviceBridge().intentBaselineWitness().pending).toHaveLength(0);
    await expect(
      tab.vault().getClient().openEntryNow({
        entryId: '11111111-1111-4111-8111-111111111111',
        envelope: sealed.envelope,
        ciphertext: sealed.ciphertext,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_LOCKED' });

    // 6. Control without the sibling lock: manual first + silent second -> manual wrong passphrase -> release silent opens cleanly!
    callIndex = 0;
    releaseManualGet = null;
    releaseSilentGet = null;
    const controlManualOp = tab.vault().beginOp();
    let controlManualMetaPromise!: Promise<VaultState | null>;
    act(() => {
      controlManualMetaPromise = tab.vault().reloadVaultMeta();
    });
    await waitFor(() => expect(releaseManualGet).not.toBeNull());
    let controlSilentPromise!: Promise<unknown>;
    act(() => {
      controlSilentPromise = tab.vault().silentUnlock();
    });
    await waitFor(() => expect(releaseSilentGet).not.toBeNull());
    let controlManualMeta: VaultState | null = null;
    await act(async () => {
      releaseManualGet?.();
      controlManualMeta = await controlManualMetaPromise;
    });
    await act(async () => {
      await expect(
        tab.vault().unlockPassphrase({
          passphrase: 'wrong-passphrase-for-r3-2-control',
          kdf: controlManualMeta!.kdf,
          vaultKeyWrappedByKek: controlManualMeta!.vault_key_wrapped_by_kek,
          privateKeysWrapped: controlManualMeta!.private_keys_wrapped,
          opGeneration: controlManualOp.opGeneration,
        }),
      ).rejects.toMatchObject({ code: 'AEAD_DECRYPT_FAILED' });
    });
    let controlSilentResult: unknown;
    await act(async () => {
      releaseSilentGet?.();
      controlSilentResult = await controlSilentPromise;
    });
    expect(controlSilentResult).toEqual({ status: 'unlocked' });
    await waitFor(() => expect(stateText()).toBe('unlocked'), { timeout: 10_000 });
    expect(tab.vault().workerState).toBe('unlocked');
    const opened = await tab.vault().getClient().openEntryNow({
      entryId: '11111111-1111-4111-8111-111111111111',
      envelope: sealed.envelope,
      ciphertext: sealed.ciphertext,
    });
    expect(opened.plaintext).toBe('r3-2-secret-entry-plaintext');
  });

  it('missing-own-entry: an ID-carrying dispatch whose owned baseline entry was removed fails closed without capture_fresh fallback', async () => {
    const first = await openUnlockedTab();
    await act(async () => {
      await first.remember().remember();
    });
    expect(devkeys().size).toBe(1);
    cleanup();
    shims.splice(0).forEach((s) => s.close());

    let holdGet = true;
    let releaseGet: (() => void) | null = null;
    mocks.fetchVault.mockImplementation(async () => {
      if (holdGet) {
        await new Promise<void>((resolve) => {
          releaseGet = resolve;
        });
      }
      return vaultState(VAULT_K);
    });

    const tab = renderTab({ silentUnlockOnLoad: false });
    const activeShim = shims[shims.length - 1]!;
    const deviceBridge = getDeviceTestBridge;

    let silentPromise!: Promise<unknown>;
    act(() => {
      silentPromise = tab.vault().silentUnlock();
    });
    await waitFor(() => expect(releaseGet).not.toBeNull());

    // Verify the owned baseline entry exists, then remove it before dispatch:
    const witness = deviceBridge().intentBaselineWitness();
    expect(witness.pending).toHaveLength(1);
    const ownedEntry = witness.pending[0]!;
    expect(ownedEntry.kind).toBe('owned');
    expect(witness.removeEntry(ownedEntry.generation, ownedEntry.id)).toBe(true);
    expect(deviceBridge().intentBaselineWitness().pending).toHaveLength(0);

    // Also register a `manual` entry in the same generation to prove the ID-carrying dispatch never steals a manual entry either:
    tab.vault().beginOp();
    expect(deviceBridge().intentBaselineWitness().pending).toHaveLength(1);
    expect(deviceBridge().intentBaselineWitness().pending[0]!.kind).toBe('manual');

    // Release GET -> silent dispatch reaches prepareBaseline with its intentId, sees its own entry missing, and FAILS CLOSED (no capture_fresh, no unlockDevKey command):
    let silentResult: unknown;
    await act(async () => {
      holdGet = false;
      releaseGet?.();
      silentResult = await silentPromise;
    });
    expect(silentResult).toEqual({ status: 'skipped', reason: 'stale' });
    expect(activeShim.workerReceivedRequests.filter((c) => c.type === 'unlockDevKey')).toHaveLength(0);
    expect(stateText()).toBe('locked');
    expect(tab.vault().workerState).toBe('locked');
    const finalWitness = deviceBridge().intentBaselineWitness();
    expect(finalWitness.trace).toContainEqual({
      action: 'missing_owned',
      generation: ownedEntry.generation,
      id: ownedEntry.id,
      kind: 'owned',
    });
    expect(finalWitness.trace.some((e) => e.action === 'capture_fresh')).toBe(false);
  });

  it.each([
    { pair: 'manual+manual' as const },
    { pair: 'manual+silent' as const },
    { pair: 'silent+manual' as const },
    { pair: 'silent+auto-silent' as const },
  ])(
    'intent-kind pair table ($pair): no intent ever consumes or deletes another intent’s baseline entry',
    async ({ pair }) => {
      const first = await openUnlockedTab();
      await act(async () => {
        await first.remember().remember();
      });
      expect(devkeys().size).toBe(1);
      cleanup();
      shims.splice(0).forEach((s) => s.close());

      let releaseGet1: (() => void) | null = null;
      let releaseGet2: (() => void) | null = null;
      let callIndex = 0;
      mocks.fetchVault.mockImplementation(async () => {
        callIndex += 1;
        if (callIndex === 1) {
          await new Promise<void>((resolve) => {
            releaseGet1 = resolve;
          });
        } else if (callIndex === 2) {
          await new Promise<void>((resolve) => {
            releaseGet2 = resolve;
          });
        }
        return vaultState(VAULT_K);
      });

      const isAutoSilent = pair === 'silent+auto-silent';
      const tab = renderTab({ silentUnlockOnLoad: isAutoSilent });
      const deviceBridge = getDeviceTestBridge;

      if (pair === 'manual+manual') {
        const op1 = tab.vault().beginOp();
        // Sibling durable lock between op1 and op2 in the same generation: op1 has pre-lock E1, op2 has post-lock E2.
        await act(async () => {
          await recordLockEpochEvent(tab.vault().tabKnownLockEpoch, {
            idbFactory: idb.createFactory(),
            locksManager: locks.createLockManager(),
          });
        });
        const op2 = tab.vault().beginOp();
        const w0 = deviceBridge().intentBaselineWitness();
        expect(w0.pending).toHaveLength(2);
        const [e1, e2] = w0.pending;
        expect(e1!.kind).toBe('manual');
        expect(e2!.kind).toBe('manual');

        // First manual dispatch consumes oldest manual entry (e1, pre-lock) and fails closed with STALE_GENERATION, bumping generation and clearing remaining stale-generation entries:
        await act(async () => {
          await expect(
            tab.vault().unlockPassphrase({
              passphrase: PASSPHRASE,
              kdf: created!.kdf,
              vaultKeyWrappedByKek: created!.vault_key_wrapped_by_kek,
              privateKeysWrapped: created!.private_keys_wrapped,
              opGeneration: op1.opGeneration,
            }),
          ).rejects.toMatchObject({ code: 'STALE_GENERATION' });
        });
        const w1 = deviceBridge().intentBaselineWitness();
        expect(w1.trace).toContainEqual({
          action: 'consume',
          generation: op1.opGeneration,
          id: e1!.id,
          kind: 'manual',
        });
        expect(w1.trace).not.toContainEqual({
          action: 'consume',
          generation: op2.opGeneration,
          id: e2!.id,
          kind: 'manual',
        });
        expect(stateText()).toBe('locked');
        return;
      }

      if (pair === 'manual+silent') {
        const manualOp = tab.vault().beginOp();
        let manualMetaPromise!: Promise<VaultState | null>;
        act(() => {
          manualMetaPromise = tab.vault().reloadVaultMeta();
        });
        await waitFor(() => expect(releaseGet1).not.toBeNull());

        let silentPromise!: Promise<unknown>;
        act(() => {
          silentPromise = tab.vault().silentUnlock();
        });
        await waitFor(() => expect(releaseGet2).not.toBeNull());

        const w0 = deviceBridge().intentBaselineWitness();
        expect(w0.pending).toHaveLength(2);
        const [manualEntry, silentEntry] = w0.pending;
        expect(manualEntry!.kind).toBe('manual');
        expect(silentEntry!.kind).toBe('owned');

        // Release manual first (wrong passphrase) -> consumes manualEntry, silentEntry stays pending:
        let manualMeta: VaultState | null = null;
        await act(async () => {
          releaseGet1?.();
          manualMeta = await manualMetaPromise;
        });
        await act(async () => {
          await expect(
            tab.vault().unlockPassphrase({
              passphrase: 'wrong-passphrase',
              kdf: manualMeta!.kdf,
              vaultKeyWrappedByKek: manualMeta!.vault_key_wrapped_by_kek,
              privateKeysWrapped: manualMeta!.private_keys_wrapped,
              opGeneration: manualOp.opGeneration,
            }),
          ).rejects.toMatchObject({ code: 'AEAD_DECRYPT_FAILED' });
        });
        expect(deviceBridge().intentBaselineWitness().pending).toEqual([silentEntry]);

        // Release silent second -> consumes silentEntry and unlocks:
        let silentRes: unknown;
        await act(async () => {
          releaseGet2?.();
          silentRes = await silentPromise;
        });
        expect(silentRes).toEqual({ status: 'unlocked' });
        const wFinal = deviceBridge().intentBaselineWitness();
        expect(wFinal.pending).toHaveLength(0);
        expect(wFinal.trace.filter((e) => e.action === 'consume')).toEqual([
          { action: 'consume', generation: manualEntry!.generation, id: manualEntry!.id, kind: 'manual' },
          { action: 'consume', generation: silentEntry!.generation, id: silentEntry!.id, kind: 'owned' },
        ]);
        return;
      }

      if (pair === 'silent+manual') {
        let silentPromise!: Promise<unknown>;
        act(() => {
          silentPromise = tab.vault().silentUnlock();
        });
        await waitFor(() => expect(releaseGet1).not.toBeNull());

        const manualOp = tab.vault().beginOp();
        let manualMetaPromise!: Promise<VaultState | null>;
        act(() => {
          manualMetaPromise = tab.vault().reloadVaultMeta();
        });
        await waitFor(() => expect(releaseGet2).not.toBeNull());

        const w0 = deviceBridge().intentBaselineWitness();
        expect(w0.pending).toHaveLength(2);
        const [silentEntry, manualEntry] = w0.pending;
        expect(silentEntry!.kind).toBe('owned');
        expect(manualEntry!.kind).toBe('manual');

        // Manual dispatches first while silent is still parked -> skips owned silentEntry and consumes manualEntry!
        let manualMeta: VaultState | null = null;
        await act(async () => {
          releaseGet2?.();
          manualMeta = await manualMetaPromise;
        });
        await act(async () => {
          await expect(
            tab.vault().unlockPassphrase({
              passphrase: 'wrong-passphrase',
              kdf: manualMeta!.kdf,
              vaultKeyWrappedByKek: manualMeta!.vault_key_wrapped_by_kek,
              privateKeysWrapped: manualMeta!.private_keys_wrapped,
              opGeneration: manualOp.opGeneration,
            }),
          ).rejects.toMatchObject({ code: 'AEAD_DECRYPT_FAILED' });
        });
        expect(deviceBridge().intentBaselineWitness().pending).toEqual([silentEntry]);

        // Silent dispatches second -> consumes its own silentEntry and unlocks:
        let silentRes: unknown;
        await act(async () => {
          releaseGet1?.();
          silentRes = await silentPromise;
        });
        expect(silentRes).toEqual({ status: 'unlocked' });
        const wFinal = deviceBridge().intentBaselineWitness();
        expect(wFinal.pending).toHaveLength(0);
        expect(wFinal.trace.filter((e) => e.action === 'consume')).toEqual([
          { action: 'consume', generation: manualEntry!.generation, id: manualEntry!.id, kind: 'manual' },
          { action: 'consume', generation: silentEntry!.generation, id: silentEntry!.id, kind: 'owned' },
        ]);
        return;
      }

      // pair === 'silent+auto-silent':
      // Auto-silent starts on mount and parks on GET #1; explicit silentUnlock() starts second and parks on GET #2.
      const activeShim = shims[shims.length - 1]!;
      await waitFor(() => expect(releaseGet1).not.toBeNull());
      let explicitSilentPromise!: Promise<unknown>;
      act(() => {
        explicitSilentPromise = tab.vault().silentUnlock();
      });
      await waitFor(() => expect(releaseGet2).not.toBeNull());

      const w0 = deviceBridge().intentBaselineWitness();
      expect(w0.pending).toHaveLength(2);
      const [autoEntry, explicitEntry] = w0.pending;
      expect(autoEntry!.kind).toBe('owned');
      expect(explicitEntry!.kind).toBe('owned');
      expect(autoEntry!.id).not.toBe(explicitEntry!.id);

      // First, release explicit silent (2nd entry) while auto-silent (1st entry) is still parked at GET #1!
      let explicitRes: unknown;
      await act(async () => {
        releaseGet2?.();
        explicitRes = await explicitSilentPromise;
      });
      expect(explicitRes).toEqual({ status: 'unlocked' });
      expect(activeShim.workerReceivedRequests.filter((c) => c.type === 'unlockDevKey')).toHaveLength(1);
      const wAfterExplicit = deviceBridge().intentBaselineWitness();
      // Explicit silent consumed ONLY `explicitEntry.id` (even though `autoEntry.id` was earlier in the list!), leaving `autoEntry` untouched until auto-silent finishes:
      expect(wAfterExplicit.trace.filter((e) => e.action === 'consume')).toEqual([
        { action: 'consume', generation: explicitEntry!.generation, id: explicitEntry!.id, kind: 'owned' },
      ]);
      expect(wAfterExplicit.pending).toEqual([autoEntry]);

      // Release auto-silent GET #1 -> vault is already unlocked in its generation, so it MUST NOT dispatch a second unlockDevKey Worker command and releases its own `autoEntry` in `finally`:
      await act(async () => {
        releaseGet1?.();
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(activeShim.workerReceivedRequests.filter((c) => c.type === 'unlockDevKey')).toHaveLength(1);
      const wFinal = deviceBridge().intentBaselineWitness();
      expect(wFinal.pending).toHaveLength(0);
      expect(wFinal.trace.filter((e) => e.action === 'consume')).toEqual([
        { action: 'consume', generation: explicitEntry!.generation, id: explicitEntry!.id, kind: 'owned' },
      ]);
      expect(wFinal.trace).toContainEqual({
        action: 'release',
        generation: autoEntry!.generation,
        id: autoEntry!.id,
        kind: 'owned',
      });
    },
  );

  it('R2-4 (advisor-dec-054 / user-dec-010 pre-dispatch window): Forget completing while provider prepareBaseline is parked after post-GET reread prevents any unlockDevKey Worker command, returns stale, and keeps Worker locked (with no-change control)', async () => {
    const first = await openUnlockedTab();
    await act(async () => {
      await first.remember().remember();
    });
    expect(devkeys().size).toBe(1);
    cleanup();
    shims.splice(0).forEach((s) => s.close());

    // Gate the 2nd `sabk.vault.lock` request on the provider's lockEpochEnv:
    // Request #1 is `beginIntentOp -> captureUnlockBaseline`; Request #2 is `prepareBaseline -> verifyUnlockBaseline`,
    // which runs inside `unlockDevKey.beforePostMessage` AFTER initial snapshot, GET /vault, and post-GET reread all pass.
    const baseLocksManager = locks.createLockManager();
    let lockRequestCount = 0;
    let holdPrepareBaseline = true;
    let reachedPrepareBaseline: (() => void) | null = null;
    let releasePrepareBaseline: (() => void) | null = null;
    const gatedLocksManager: LockManager = {
      ...baseLocksManager,
      request: (async (name: string, optionsOrCallback: unknown, maybeCallback?: unknown) => {
        lockRequestCount += 1;
        if (holdPrepareBaseline && lockRequestCount === 2) {
          reachedPrepareBaseline?.();
          await new Promise<void>((resolve) => {
            releasePrepareBaseline = resolve;
          });
        }
        return (baseLocksManager.request as (...a: unknown[]) => Promise<unknown>)(
          name,
          optionsOrCallback,
          maybeCallback,
        );
      }) as LockManager['request'],
    };

    const tab = renderTab({
      silentUnlockOnLoad: false,
      lockEpochEnv: { idbFactory: idb.createFactory(), locksManager: gatedLocksManager },
    });
    const activeShim = shims[shims.length - 1]!;
    const unlockedDevKeyCommands = () =>
      activeShim.workerReceivedRequests.filter((cmd) => cmd.type === 'unlockDevKey');

    const reachedP = new Promise<void>((resolve) => {
      reachedPrepareBaseline = resolve;
    });
    let silentPromise!: Promise<unknown>;
    act(() => {
      silentPromise = tab.vault().silentUnlock();
    });
    await reachedP;
    expect(releasePrepareBaseline).not.toBeNull();
    // At this exact point: snapshot #1, GET /vault, and post-GET snapshot #2 all passed; Worker has received NO unlockDevKey yet.
    expect(unlockedDevKeyCommands()).toHaveLength(0);

    // Another context completes Forget while `prepareBaseline` is parked:
    const siblingRememberStore = createRememberDeviceStore({
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
    await act(async () => {
      const forgotten = await siblingRememberStore.forget();
      expect(forgotten.remembered).toBe(false);
    });
    expect(devkeys().size).toBe(0);

    // Release `prepareBaseline`: `device.ts`'s `beforePostMessage` reread runs immediately after `prepareBaseline` and MUST abort before posting `unlockDevKey`.
    let silentResult: unknown;
    await act(async () => {
      holdPrepareBaseline = false;
      releasePrepareBaseline?.();
      silentResult = await silentPromise;
    });
    expect(silentResult).toEqual({ status: 'skipped', reason: 'stale' });
    expect(unlockedDevKeyCommands()).toHaveLength(0);
    expect(devkeys().size).toBe(0);
    expect(stateText()).toBe('locked');
    expect(tab.vault().workerState).toBe('locked');

    // No-change control: re-seed the legitimate DevKey record, park at the same `prepareBaseline` gate without Forget, then release -> dispatches `unlockDevKey` and opens.
    cleanup();
    shims.splice(0).forEach((s) => s.close());
    const reseed = await openUnlockedTab();
    await act(async () => {
      await reseed.remember().remember();
    });
    expect(devkeys().size).toBe(1);
    cleanup();
    shims.splice(0).forEach((s) => s.close());

    lockRequestCount = 0;
    holdPrepareBaseline = true;
    reachedPrepareBaseline = null;
    releasePrepareBaseline = null;
    const controlTab = renderTab({
      silentUnlockOnLoad: false,
      lockEpochEnv: { idbFactory: idb.createFactory(), locksManager: gatedLocksManager },
    });
    const controlShim = shims[shims.length - 1]!;
    const controlReachedP = new Promise<void>((resolve) => {
      reachedPrepareBaseline = resolve;
    });
    let controlPromise!: Promise<unknown>;
    act(() => {
      controlPromise = controlTab.vault().silentUnlock();
    });
    await controlReachedP;
    expect(controlShim.workerReceivedRequests.filter((cmd) => cmd.type === 'unlockDevKey')).toHaveLength(0);

    let controlResult: unknown;
    await act(async () => {
      holdPrepareBaseline = false;
      releasePrepareBaseline?.();
      controlResult = await controlPromise;
    });
    expect(controlResult).toEqual({ status: 'unlocked' });
    expect(controlShim.workerReceivedRequests.filter((cmd) => cmd.type === 'unlockDevKey')).toHaveLength(1);
    await waitFor(() => expect(stateText()).toBe('unlocked'), { timeout: 10_000 });
    expect(controlTab.vault().workerState).toBe('unlocked');
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

  it('R1-22: same-provider A->B switch reconciles and locks A before consuming B\u2019s automatic silent unlock attempt, opening B once after its own authoritative GET and keeping subsequent manual lock locked', async () => {
    // 1. Setup: remember both USER_A (VAULT_K) and USER_B (VAULT_K2) with legitimate separate records.
    mocks.session.me = makeMe(USER_B);
    serverKeyId = VAULT_K2;
    const setupB = await openUnlockedTab();
    const createdB = created!;
    await act(async () => {
      await setupB.remember().remember();
    });
    expect(devkeys().has(formatDevKeyRecordKey(USER_B, VAULT_K2))).toBe(true);
    cleanup();
    shims.splice(0).forEach((s) => s.close());

    mocks.session.me = makeMe(USER_A);
    serverKeyId = VAULT_K;
    const tab = await openUnlockedTab({ silentUnlockOnLoad: true });
    await act(async () => {
      await tab.remember().remember();
    });
    expect(devkeys().has(formatDevKeyRecordKey(USER_A, VAULT_K))).toBe(true);
    expect(stateText()).toBe('unlocked');

    // 2. Switch directly from unlocked USER_A to remembered USER_B on the same mounted VaultProvider.
    created = createdB;
    serverKeyId = VAULT_K2;
    mocks.session.me = makeMe(USER_B);
    mocks.fetchVault.mockClear();
    await act(async () => {
      tab.rerender();
    });

    // Reconciliation locks A first, then B's one-shot automatic attempt runs after reconciliation and unlocks B.
    await waitFor(() => expect(stateText()).toBe('unlocked'), { timeout: 10_000 });
    expect(mocks.fetchVault).toHaveBeenCalledTimes(1);
    expect(tab.vault().vaultMeta?.vault_key_id).toBe(VAULT_K2);

    // 3. Subsequent manual lock for B remains locked (one-shot attempt already consumed).
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
