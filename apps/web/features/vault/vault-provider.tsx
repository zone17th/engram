'use client';

import { ProblemError } from '@engram/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import {
  Suspense,
  createContext,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useSession } from '@/features/auth/session-provider';
import {
  ACTIVITY_BROADCAST_THROTTLE_MS,
  CLOCK_ROLLBACK_TOLERANCE_MS,
  WAKE_ME_REFRESH_DEADLINE_MS,
  evaluateAutoLockAt,
  normalizeAutoLockMinutes,
} from '@/features/vault/auto-lock';
import {
  postVaultBroadcast,
  subscribeVaultBroadcast,
  type VaultBroadcastMessage,
} from '@/features/vault/broadcast';
import {
  purgeDeviceKeysOnRevoked,
  type DeviceStoreEnvironment,
} from '@/features/vault/device-store';
import {
  captureUnlockBaseline,
  recordLockEpochEvent,
  verifyUnlockBaseline,
  type LockEpochEnvironment,
  type LockEpochMarker,
} from '@/features/vault/lock-epoch';
import type { VaultTestConsumerApi } from '@/features/vault/vault-test-consumer';
import { fetchVault, type VaultState } from '@/lib/api/vault';
import { fetchMe } from '@/lib/api/auth';
import {
  CryptoClient,
  CryptoClientError,
  type ConfirmRecoveryClientParams,
  type ConfirmRecoveryResult,
  type CreateVaultClientParams,
  type CreateVaultResult,
  type CryptoClientErrorCode,
  type CryptoWorkerPort,
  type DeriveRecoveryLookupResult,
  type LockResult,
  type ResumeRecoveryClientParams,
  type ResumeRecoveryResult,
  type RewrapClientParams,
  type RewrapResult,
  type UnlockDevKeyClientParams,
  type UnlockPassphraseClientParams,
  type UnlockPrfClientParams,
  type UnlockRecoveryClientParams,
  type VaultClientState,
} from '@/lib/crypto/client';

/**
 * TanStack Query cache namespace for decrypted entry bodies (`['vault', 'body', ...]`).
 * Cleared immediately (synchronously) on every lock, logout, user switch, or reset — never gated on `await client.lock()`.
 * P04 entry queries MUST use `vaultBodyQueryKey(entryId)` or the `VAULT_BODY_QUERY_KEY_PREFIX` prefix.
 */
export const VAULT_BODY_QUERY_KEY_PREFIX = ['vault', 'body'] as const;

/** TanStack Query key for the server-side `GET /vault` metadata snapshot (`['vault', 'meta', ...]`). */
export const VAULT_META_QUERY_KEY_PREFIX = ['vault', 'meta'] as const;

export function vaultBodyQueryKey(entryId: string, ...rest: ReadonlyArray<string | number>) {
  return [...VAULT_BODY_QUERY_KEY_PREFIX, entryId, ...rest] as const;
}

/**
 * Authoritative vault state machine states per plan §2.6:
 * - Primary: `'no_vault'` -> `'onboarding'` -> `'unlocked'`; `'locked'` <-> `'unlocking'` -> `'unlocked'`
 * - Sub-states: `'recovering'`, `'rewrapping'`, `'resetting'`, `'error'`
 *
 * Server state (`absent` / `present`) comes ONLY from `Me.vault.status`.
 * Crypto state (`locked` / `unlocked` / `recovering` / `error`) comes ONLY from the Worker's
 * `{ mode, generation, epoch }` via `CryptoClient.onStateChange` (never inferred by the provider).
 */
export type VaultStateMachineMode =
  | 'no_vault'
  | 'onboarding'
  | 'locked'
  | 'unlocking'
  | 'unlocked'
  | 'recovering'
  | 'rewrapping'
  | 'resetting'
  | 'error';

export type VaultActiveOperation = 'onboarding' | 'unlocking' | 'rewrapping' | 'resetting' | null;

export type VaultUiErrorKind =
  | 'busy'
  | 'recovering_locked_to_whitelist'
  | 'wrong_passphrase'
  | 'passphrase_invalid'
  | 'insufficient_memory'
  | 'recovery_key_invalid'
  | 'stale_generation'
  | 'worker_error'
  | 'other';

/**
 * Maps a `CryptoClientError` / `CryptoClientErrorCode` into a distinct UI category so:
 * - `CLIENT_BUSY` is NEVER shown as wrong passphrase
 * - `KDF_ALLOCATION_FAILED` / `KDF_DERIVE_FAILED` is NEVER shown as wrong passphrase
 * - `PASSPHRASE_INVALID` / `PRIVATE_KEYS_WRAP_INVALID` is NEVER shown as wrong passphrase
 * - `VAULT_RECOVERING` surfaces the recovering whitelist rule ("lock() first to switch")
 */
export function classifyCryptoError(err: unknown): {
  kind: VaultUiErrorKind;
  code: CryptoClientErrorCode | null;
  requiresLockFirstToSwitch: boolean;
} {
  let code: CryptoClientErrorCode | null = null;
  if (err instanceof CryptoClientError) {
    code = err.code;
  } else if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
    code = err.code as CryptoClientErrorCode;
  }

  switch (code) {
    case 'CLIENT_BUSY':
      return { kind: 'busy', code, requiresLockFirstToSwitch: false };
    case 'VAULT_RECOVERING':
      return {
        kind: 'recovering_locked_to_whitelist',
        code,
        requiresLockFirstToSwitch: true,
      };
    case 'AEAD_DECRYPT_FAILED':
      return { kind: 'wrong_passphrase', code, requiresLockFirstToSwitch: false };
    case 'PASSPHRASE_INVALID':
      return { kind: 'passphrase_invalid', code, requiresLockFirstToSwitch: false };
    case 'KDF_ALLOCATION_FAILED':
    case 'KDF_DERIVE_FAILED':
      return { kind: 'insufficient_memory', code, requiresLockFirstToSwitch: false };
    case 'RECOVERY_KEY_INVALID':
    case 'RECOVERY_CONTINUATION_MISSING':
      return { kind: 'recovery_key_invalid', code, requiresLockFirstToSwitch: false };
    case 'STALE_GENERATION':
      return { kind: 'stale_generation', code, requiresLockFirstToSwitch: false };
    case 'WORKER_INIT_FAILED':
    case 'WORKER_INTERNAL_ERROR':
    case 'WORKER_CRASHED':
      return { kind: 'worker_error', code, requiresLockFirstToSwitch: false };
    default:
      return { kind: 'other', code, requiresLockFirstToSwitch: false };
  }
}

export interface VaultContextValue {
  /** Combined state machine mode per plan §2.6. */
  state: VaultStateMachineMode;
  /** Raw authoritative state reported by `CryptoClient.onStateChange`. */
  workerState: VaultClientState;
  /** Server vault status from `Me.vault.status` (`'absent'` | `'present'`). */
  serverVaultStatus: 'absent' | 'present';
  /** Current monotonic generation of the tab's `CryptoClient`. */
  generation: number;
  /** Last authoritative Worker epoch adopted by the tab's `CryptoClient`. */
  epoch: number;
  /** True while a single-flight state-changing operation is in flight (UI buttons/forms disabled). */
  inFlight: boolean;
  /** Which state-changing UI operation is currently active, if any. */
  activeOperation: VaultActiveOperation;
  /** Last error code surfaced from `CryptoClient` (e.g. `CLIENT_BUSY`, `VAULT_RECOVERING`). */
  lastErrorCode: CryptoClientErrorCode | null;
  /** True when the Worker is in `recovering` mode (only `rewrap`, `confirmRecovery`, and `lock` are allowed; call `lock()` first to switch flows). */
  isRecovering: boolean;
  /** Cached server `GET /vault` snapshot for the current session/vault, updated on `vault_changed` for future operations. */
  vaultMeta: VaultState | null;
  /** Monotonic `lockEpoch` known to this tab. */
  tabKnownLockEpoch: number;
  /** Baseline `{ epochIncarnation, lockEpoch }` captured when the current unlock began. */
  unlockBaseline: LockEpochMarker | null;
  /** Effective `auto_lock_minutes` setting (`0` = never, default `15`). */
  autoLockMinutes: number;
  /** Shared `max(lastActivity across tabs)` timestamp in ms. */
  lastActivityAt: number;
  /** Remaining whole minutes before auto-lock while unlocked (`undefined` when `autoLockMinutes === 0` or locked). */
  minutesLeft: number | undefined;
  /** Lazily returns the tab's single `CryptoClient` instance. */
  getClient: () => CryptoClient;
  /**
   * Captures the immutable `opGeneration` BEFORE the first `await` of a multi-step async flow
   * (ADR 0002 §10.2).
   */
  captureOpGeneration: () => number;
  /**
   * Begins an async flow by capturing `opGeneration` synchronously before any `await`.
   * Also provides `isCurrent()` to check whether an intervening lock/logout bumped generation.
   */
  beginOp: () => { opGeneration: number; isCurrent: () => boolean; client: CryptoClient };
  /**
   * Locks the vault immediately ("Lock now" API / header button / `L` shortcut):
   * - Synchronously clears the decrypted-body query cache (`['vault', 'body', ...]`), resets secret forms,
   *   and dispatches `client.lock()` (which sends `lock` to the Worker before `onStateChange`).
   * - UI/cache cleanup is NEVER gated on `await client.lock()`.
   * - Increments durable `lockEpoch` in IndexedDB `sabk.device` under Web Lock `'sabk.vault.lock'` and broadcasts `lock`.
   */
  lock: (options?: { broadcast?: boolean; reason?: string }) => Promise<LockResult>;
  /** Alias for `lock()` matching the "Lock now" API requirement. */
  lockNow: () => Promise<LockResult>;
  /** Registers a callback invoked synchronously whenever the vault locks or user logs out (e.g. to clear secret-holding forms). */
  registerSecretFormReset: (resetFn: () => void) => () => void;
  /** Broadcasts `vault_changed { vault_key_id, version }` on `'sabk.vault'` and updates local `vaultMeta`. */
  notifyVaultChanged: (payload: { vault_key_id: string; version: number | null }) => void;
  /** Broadcasts `settings_changed { auto_lock_minutes }` on `'sabk.vault'` and applies the new timeout immediately. */
  notifySettingsChanged: (payload: { auto_lock_minutes: number }) => void;
  /** Records user activity in this tab and broadcasts throttled `{ type: 'activity', at }` on `'sabk.vault'`. */
  recordActivity: (at?: number) => void;
  /** Reloads `GET /vault` from the server and reconciles `vault_key_id` (locks immediately on 404 or `vault_key_id` mismatch). */
  reloadVaultMeta: () => Promise<VaultState | null>;
  /**
   * Marks the current reset transition (keyed to `vaultKeyId`, or the tab's last known `vault_key_id`)
   * as already purged on this device so a subsequent 404 in `reloadVaultMeta()` does not purge a second time (VS-R4-1).
   */
  markResetPurged: (vaultKeyId?: string | null) => void;
  /** Sets the active sub-state operation (`'onboarding'` | `'unlocking'` | `'rewrapping'` | `'resetting'` | `null`) while a flow is running. */
  setActiveOperation: (op: VaultActiveOperation) => void;
  /** Clears `lastErrorCode`. */
  clearError: () => void;
  /** State-changing wrappers that coordinate `inFlight`, `activeOperation`, `unlockBaseline`, and `CLIENT_BUSY` / `VAULT_RECOVERING`. */
  createVault: (params: CreateVaultClientParams) => Promise<CreateVaultResult>;
  unlockPassphrase: (params: UnlockPassphraseClientParams) => Promise<{ unlocked: true }>;
  unlockRecovery: (
    params: UnlockRecoveryClientParams,
  ) => Promise<DeriveRecoveryLookupResult & { recovering?: boolean }>;
  resumeRecovery: (params: ResumeRecoveryClientParams) => Promise<ResumeRecoveryResult>;
  confirmRecovery: (params: ConfirmRecoveryClientParams) => Promise<ConfirmRecoveryResult>;
  unlockPrf: (params: UnlockPrfClientParams) => Promise<{ unlocked: true }>;
  unlockDevKey: (params: UnlockDevKeyClientParams) => Promise<{ unlocked: true }>;
  rewrap: (params: RewrapClientParams) => Promise<RewrapResult>;
}

interface VaultStoreContextValue {
  value: VaultContextValue;
  subscribe: (listener: () => void) => () => void;
  getStateSnapshot: () => VaultStateMachineMode;
}

const VaultContext = createContext<VaultStoreContextValue | null>(null);

// Browser-test-only vault consumer (VS-R7-1 / BE3-4): a lazily loaded real React consumer that the e2e specs mount
// into this provider's tree through `window.__engramMountVaultTestConsumer` (same gate as the test bridge).
const VaultTestConsumer = lazy(() => import('@/features/vault/vault-test-consumer'));

export interface VaultProviderProps {
  children: ReactNode;
  /** Optional custom Worker factory (used in unit tests with `createWorkerShim`; defaults to real `worker.ts`). */
  createWorker?: () => CryptoWorkerPort;
  /** Optional custom IndexedDB / Web Locks environment for unit tests. */
  lockEpochEnv?: LockEpochEnvironment;
  /** Optional custom IndexedDB environment for `sabk.device` DevKey / purge tests. */
  deviceStoreEnv?: DeviceStoreEnvironment;
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  if (target.getAttribute('contenteditable') === 'true') return true;
  if (target.getAttribute('contenteditable') === 'plaintext-only') return true;
  if (typeof target.closest === 'function') {
    const editableAncestor = target.closest(
      'input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""]',
    );
    if (editableAncestor) return true;
  }
  return false;
}

function clearDomSecretInputs(): void {
  if (typeof document === 'undefined') return;
  try {
    const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input[data-vault-secret], textarea[data-vault-secret]',
    );
    inputs.forEach((el) => {
      el.value = '';
    });
    const decryptedPreviews = document.querySelectorAll<HTMLElement>('[data-vault-decrypted]');
    decryptedPreviews.forEach((el) => {
      el.textContent = '[LOCKED]';
    });
  } catch {
    // Ignore DOM traversal errors
  }
}
export function deriveVaultStateMachineMode(input: {
  serverVaultStatus: 'absent' | 'present';
  workerState: VaultClientState;
  activeOperation: VaultActiveOperation;
  baselineVerified?: boolean;
  wakeVerifying?: boolean;
}): VaultStateMachineMode {
  const {
    serverVaultStatus,
    workerState,
    activeOperation,
    baselineVerified = true,
    wakeVerifying = false,
  } = input;

  // Worker error or recovering state is authoritative over sub-states
  if (workerState === 'error') return 'error';
  if (workerState === 'recovering') return 'recovering';

  if (workerState === 'unlocked' && baselineVerified) {
    if (activeOperation === 'rewrapping') return 'rewrapping';
    if (activeOperation === 'resetting') return 'resetting';
    return 'unlocked';
  }

  // workerState === 'locked' (or post-unlock / wake baseline verification is still pending/unverified)
  if (serverVaultStatus === 'absent') {
    if (activeOperation === 'onboarding') return 'onboarding';
    return 'no_vault';
  }

  // serverVaultStatus === 'present' && (workerState === 'locked' || !baselineVerified)
  // While `workerState === 'unlocked'` and wake verification is pending (`wakeVerifying`),
  // report `'unlocking'` so plaintext consumers are gated without falsely reporting `'locked'`
  // before `client.lock()` has locked the Worker.
  if (
    activeOperation === 'unlocking' ||
    activeOperation === 'onboarding' ||
    (workerState === 'unlocked' && (!baselineVerified || wakeVerifying))
  ) {
    return 'unlocking';
  }
  if (activeOperation === 'rewrapping') return 'recovering';
  if (activeOperation === 'resetting') return 'resetting';
  return 'locked';
}

export function VaultProvider({
  children,
  createWorker,
  lockEpochEnv,
  deviceStoreEnv,
}: VaultProviderProps) {
  const queryClient = useQueryClient();
  const { me, status: sessionStatus, refetchMe } = useSession();
  const [workerState, setWorkerState] = useState<VaultClientState>('locked');
  const [generation, setGeneration] = useState<number>(0);
  const [epoch, setEpoch] = useState<number>(-1);
  const [inFlightCount, setInFlightCount] = useState<number>(0);
  const [activeOperation, setActiveOperation] = useState<VaultActiveOperation>(null);
  const [lastErrorCode, setLastErrorCode] = useState<CryptoClientErrorCode | null>(null);
  const [vaultMeta, setVaultMetaState] = useState<VaultState | null>(null);
  const [tabKnownLockEpoch, setTabKnownLockEpoch] = useState<number>(0);
  const [unlockBaseline, setUnlockBaseline] = useState<LockEpochMarker | null>(null);
  const [baselineVerified, setBaselineVerified] = useState<boolean>(false);
  const [wakeVerifyingCount, setWakeVerifyingCount] = useState<number>(0);
  const [autoLockMinutesOverride, setAutoLockMinutesOverride] = useState<number | null>(null);
  const [lastActivityAt, setLastActivityAt] = useState<number>(() => Date.now());
  const [minutesLeft, setMinutesLeft] = useState<number | undefined>(undefined);
  const providerSenderIdRef = useRef<symbol>(Symbol('VaultProvider'));
  const clientRef = useRef<CryptoClient | null>(null);
  const createWorkerRef = useRef<VaultProviderProps['createWorker']>(createWorker);
  createWorkerRef.current = createWorker;
  const lockEpochEnvRef = useRef<VaultProviderProps['lockEpochEnv']>(lockEpochEnv);
  lockEpochEnvRef.current = lockEpochEnv;
  const workerStateRef = useRef<VaultClientState>('locked');
  const inFlightStateOpCountRef = useRef<number>(0);
  const activeOperationRef = useRef<VaultActiveOperation>(null);
  const tabKnownLockEpochRef = useRef<number>(0);
  const unlockBaselineRef = useRef<LockEpochMarker | null>(null);
  const intentBaselinesRef = useRef<Map<number, Promise<LockEpochMarker | null>>>(new Map());
  const baselineVerifiedRef = useRef<boolean>(false);
  const wakeVerificationSeqRef = useRef<number>(0);
  const wakeVerifyingCountRef = useRef<number>(0);
  const wakePreIdleAtRef = useRef<number | null>(null);
  const settingsSyncSeqRef = useRef<number>(0);
  const vaultMetaSessionEpochRef = useRef<number>(0);
  const vaultMetaRequestSeqRef = useRef<number>(0);
  // Newest request whose authoritative outcome (present metadata or `404 vault_absent`) this provider has applied.
  // Only an applied (verified) newer outcome may supersede an older response; a newer request that merely started,
  // stalled or failed is not evidence about vault state (BE3-7 / BE3-9).
  const vaultMetaAppliedRef = useRef<{
    seq: number;
    sessionEpoch: number;
    meta: VaultState | null;
  } | null>(null);
  // `vault_key_id`s that stopped being current (replaced or reset). Keys are never reused, so a `GET /vault` response
  // naming one is stale by key (BE4-1).
  const retiredVaultKeyIdsRef = useRef<Set<string>>(new Set());
  // Synchronous mirror of the committed `vaultMeta` state, so a stale response and `notifyVaultChanged` can compare
  // versions without waiting for a render (BE4-5).
  const liveVaultMetaRef = useRef<VaultState | null>(null);
  const currentVaultKeyIdRef = useRef<string | null>(null);
  const resetPurgedVaultKeyIdRef = useRef<string | null>(null);
  const resetPurgeInFlightVaultKeyIdRef = useRef<string | null>(null);
  // `vault_key_id`s of resets this provider itself observed (reload key change / 404, `vault_changed` reset,
  // local `notifyVaultChanged`). `markResetPurged` only accepts such a token (BE2-9).
  const observedResetKeyIdsRef = useRef<Set<string>>(new Set());
  const setVaultMeta = useCallback((next: VaultState | null) => {
    liveVaultMetaRef.current = next;
    setVaultMetaState(next);
  }, []);
  const currentUserIdRef = useRef<string | null>(me?.user.id ?? null);
  currentUserIdRef.current = me?.user.id ?? null;
  const previousUserIdRef = useRef<string | null>(null);
  const secretFormResettersRef = useRef<Set<() => void>>(new Set());
  const storeListenersRef = useRef<Set<() => void>>(new Set());
  const notifyStoreListeners = useCallback(() => {
    for (const listener of [...storeListenersRef.current]) {
      try {
        listener();
      } catch {
        // Ignore listener errors
      }
    }
  }, []);
  const lastActivityAtRef = useRef<number>(Date.now());
  const lastBroadcastedActivityAtRef = useRef<number>(0);
  const autoLockMinutesRef = useRef<number>(normalizeAutoLockMinutes(me?.settings.auto_lock_minutes));
  const autoLockTimerRef = useRef<number | null>(null);
  const effectiveDeviceStoreEnv = useMemo<DeviceStoreEnvironment>(
    () => ({
      idbFactory: deviceStoreEnv?.idbFactory ?? lockEpochEnv?.idbFactory,
    }),
    [deviceStoreEnv?.idbFactory, lockEpochEnv?.idbFactory],
  );

  const serverAutoLockMinutes = me?.settings.auto_lock_minutes;
  useEffect(() => {
    if (typeof serverAutoLockMinutes === 'number' && Number.isFinite(serverAutoLockMinutes)) {
      setAutoLockMinutesOverride(null);
    }
  }, [me, serverAutoLockMinutes]);

  const autoLockMinutes = useMemo(
    () =>
      normalizeAutoLockMinutes(
        autoLockMinutesOverride !== null ? autoLockMinutesOverride : serverAutoLockMinutes,
      ),
    [autoLockMinutesOverride, serverAutoLockMinutes],
  );
  autoLockMinutesRef.current = autoLockMinutes;

  const updateTabKnownLockEpoch = useCallback((nextEpoch: number) => {
    if (!Number.isSafeInteger(nextEpoch) || nextEpoch < 0) return;
    if (nextEpoch > tabKnownLockEpochRef.current) {
      tabKnownLockEpochRef.current = nextEpoch;
      setTabKnownLockEpoch(nextEpoch);
    }
  }, []);

  /**
   * Synchronously clears decrypted entry body cache (`['vault', 'body', ...]`) and resets secret-holding forms.
   * Never gated on `await client.lock()`.
   */
  const clearPlaintextAndFormsSync = useCallback(() => {
    queryClient.removeQueries({ queryKey: VAULT_BODY_QUERY_KEY_PREFIX });
    clearDomSecretInputs();
    for (const resetFn of [...secretFormResettersRef.current]) {
      try {
        resetFn();
      } catch {
        // Ignore individual form reset errors
      }
    }
  }, [queryClient]);

  const getClient = useCallback((): CryptoClient => {
    if (!clientRef.current) {
      const instance = new CryptoClient({
        createWorker: createWorkerRef.current,
        onStateChange: (nextState, nextGen) => {
          workerStateRef.current = nextState;
          setWorkerState(nextState);
          setGeneration(nextGen);
          setEpoch(instance.getEpoch());
          if (nextState === 'locked' || nextState === 'error') {
            wakeVerificationSeqRef.current += 1;
            wakeVerifyingCountRef.current = 0;
            wakePreIdleAtRef.current = null;
            // Note: unlockRecovery leaves Worker in 'locked' while holding the pending continuation;
            // only clear unlockBaseline when the client is not mid-operation (BE1-6) or on error/explicit lockLocalOnly.
            if (nextState === 'error' || inFlightStateOpCountRef.current === 0) {
              unlockBaselineRef.current = null;
              setUnlockBaseline(null);
            }
            baselineVerifiedRef.current = false;
            setWakeVerifyingCount(0);
            setBaselineVerified(false);
            activeOperationRef.current = null;
            setActiveOperation(null);
            clearPlaintextAndFormsSync();
            notifyStoreListeners();
          }
          notifyStoreListeners();
        },
      });
      clientRef.current = instance;
    }
    return clientRef.current;
  }, [clearPlaintextAndFormsSync, notifyStoreListeners]);

  const envWithBroadcast = useMemo<LockEpochEnvironment>(
    () => ({
      get idbFactory() {
        return lockEpochEnvRef.current?.idbFactory;
      },
      get locksManager() {
        return lockEpochEnvRef.current?.locksManager;
      },
      onBroadcastLock: (nextLockEpoch: number) => {
        updateTabKnownLockEpoch(nextLockEpoch);
        lockEpochEnvRef.current?.onBroadcastLock?.(nextLockEpoch);
        postVaultBroadcast({ type: 'lock', lockEpoch: nextLockEpoch }, providerSenderIdRef.current);
      },
    }),
    [updateTabKnownLockEpoch],
  );

  /**
   * Local lock execution (used when receiving a remote `lock` broadcast or wake fail-closed):
   * synchronously clears cache + forms and invokes `client.lock()` without re-writing `lockEpoch`.
   */
  const lockLocalOnly = useCallback((): Promise<LockResult> => {
    inFlightStateOpCountRef.current = 0;
    wakeVerificationSeqRef.current += 1;
    wakeVerifyingCountRef.current = 0;
    wakePreIdleAtRef.current = null;
    unlockBaselineRef.current = null;
    intentBaselinesRef.current.clear();
    baselineVerifiedRef.current = false;
    activeOperationRef.current = null;
    setWakeVerifyingCount(0);
    setUnlockBaseline(null);
    setBaselineVerified(false);
    setActiveOperation(null);
    clearPlaintextAndFormsSync();
    notifyStoreListeners();
    const client = getClient();
    const lockPromise = client.lock();
    setGeneration(client.getGeneration());
    setEpoch(client.getEpoch());
    return lockPromise;
  }, [clearPlaintextAndFormsSync, getClient, notifyStoreListeners]);

  /**
   * Full lock operation:
   * 1. Synchronously clears decrypted body cache and resets secret forms (never gated on `await client.lock()`).
   * 2. Calls `client.lock()` which bumps generation and posts `lock` to the Worker BEFORE `onStateChange`.
   * 3. If `broadcast !== false`, enters Web Lock `'sabk.vault.lock'` to increment durable `lockEpoch` in
   *    IndexedDB `sabk.device` and broadcasts `lock` on `BroadcastChannel('sabk.vault')` (plus localStorage wake).
   */
  const lock = useCallback(
    (options?: { broadcast?: boolean; reason?: string }): Promise<LockResult> => {
      const shouldBroadcast = options?.broadcast ?? true;
      const lockPromise = lockLocalOnly();

      if (!shouldBroadcast) {
        return lockPromise;
      }

      // Immediate wake notification before acquiring the Web Lock (ADR 0003 §8.3)
      postVaultBroadcast(
        {
          type: 'lock',
          lockEpoch: tabKnownLockEpochRef.current + 1,
        },
        providerSenderIdRef.current,
      );
      const epochPromise = recordLockEpochEvent(
        tabKnownLockEpochRef.current,
        envWithBroadcast,
      ).then((res) => {
        updateTabKnownLockEpoch(res.lockEpoch);
      });

      return Promise.all([lockPromise, epochPromise]).then(([lockRes]) => lockRes);
    },
    [envWithBroadcast, lockLocalOnly, updateTabKnownLockEpoch],
  );

  const lockNow = useCallback(() => lock({ broadcast: true, reason: 'manual' }), [lock]);

  const registerSecretFormReset = useCallback((resetFn: () => void) => {
    secretFormResettersRef.current.add(resetFn);
    return () => {
      secretFormResettersRef.current.delete(resetFn);
    };
  }, []);

  const captureOpGeneration = useCallback((): number => {
    return getClient().captureGeneration();
  }, [getClient]);

  const beginOp = useCallback(() => {
    const client = getClient();
    const opGeneration = client.captureGeneration();
    // Capture durable lockEpoch baseline at intent start (before any metadata GET or async work — BE2-1, ADR 0003 §8.4).
    const baselinePromise = captureUnlockBaseline(
      tabKnownLockEpochRef.current,
      envWithBroadcast,
    ).then(
      (marker) => {
        if (marker && client.getGeneration() === opGeneration) {
          updateTabKnownLockEpoch(marker.lockEpoch);
        }
        return marker;
      },
      () => null,
    );
    intentBaselinesRef.current.set(opGeneration, baselinePromise);
    return {
      opGeneration,
      client,
      isCurrent: () => client.getGeneration() === opGeneration,
    };
  }, [envWithBroadcast, getClient, updateTabKnownLockEpoch]);

  const clearError = useCallback(() => {
    setLastErrorCode(null);
  }, []);
  const rememberObservedReset = useCallback((vaultKeyId: string | null | undefined) => {
    if (typeof vaultKeyId !== 'string' || vaultKeyId.length === 0) return;
    const observed = observedResetKeyIdsRef.current;
    observed.delete(vaultKeyId);
    observed.add(vaultKeyId);
    if (observed.size > 16) {
      const oldest = observed.values().next().value;
      if (oldest !== undefined) observed.delete(oldest);
    }
  }, []);

  // BE4-3: an observed reset id is only a valid `markResetPurged` token while its transition is still the active one,
  // i.e. before a replacement vault key became current. Once a replacement is established the historical ids are
  // retired so a stale mark can never overwrite the replacement's purge receipt.
  const retireObservedResets = useCallback(() => {
    observedResetKeyIdsRef.current.clear();
  }, []);

  const markResetPurged = useCallback((vaultKeyId?: string | null) => {
    // BE2-9: Require a positive reset identity that this provider can tie to a reset it observed: the tab's own
    // current `vault_key_id`, or the key of the still-active observed reset transition. An arbitrary or historical
    // token is an assertion, not evidence, and would suppress a later purge for a vault whose reset was never seen
    // here (or replace the valid receipt of the replacement vault, BE4-3).
    const explicit = typeof vaultKeyId === 'string' && vaultKeyId.length > 0 ? vaultKeyId : null;
    const token = explicit ?? currentVaultKeyIdRef.current;
    if (typeof token !== 'string' || token.length === 0) return;
    if (
      explicit !== null &&
      explicit !== currentVaultKeyIdRef.current &&
      !observedResetKeyIdsRef.current.has(explicit)
    ) {
      return;
    }
    resetPurgedVaultKeyIdRef.current = token;
  }, []);

  const runIdempotentResetPurge = useCallback(
    (userId: string | null | undefined, transitionKeyId: string | null) => {
      // BE2-8 & BE2-9: Only skip when we have a positive transition vault_key_id that matches
      // an already-committed (`ok: true`) or currently in-flight purge for that exact key ID.
      if (
        transitionKeyId !== null &&
        (resetPurgedVaultKeyIdRef.current === transitionKeyId ||
          resetPurgeInFlightVaultKeyIdRef.current === transitionKeyId)
      ) {
        return;
      }
      const purgeEpoch = vaultMetaSessionEpochRef.current;
      if (transitionKeyId !== null) {
        resetPurgeInFlightVaultKeyIdRef.current = transitionKeyId;
      }
      // A transition that cannot name its vault (unknown 404) skips its purge only when a receipt for a reset exists
      // (an accepted `markResetPurged`, an observed reset or a committed purge) AND the purge transaction itself finds
      // no DevKey for this user: the check and the skip happen inside the same readwrite transaction (`skipIfNoDevKeys`),
      // so marked-but-not-purged and a DevKey written after the mark both purge, and a true duplicate costs nothing
      // (BE2-9, BE7-2).
      const skipIfNoDevKeys = transitionKeyId === null && resetPurgedVaultKeyIdRef.current !== null;
      const run = purgeDeviceKeysOnRevoked(
        userId,
        effectiveDeviceStoreEnv,
        skipIfNoDevKeys ? { skipIfNoDevKeys: true } : undefined,
      ).then((res) => {
        if (
          res.ok &&
          !res.skipped &&
          transitionKeyId !== null &&
          vaultMetaSessionEpochRef.current === purgeEpoch &&
          currentVaultKeyIdRef.current === null
        ) {
          resetPurgedVaultKeyIdRef.current = transitionKeyId;
        }
      });
      void run
        .catch(() => undefined)
        .finally(() => {
          if (
            transitionKeyId !== null &&
            resetPurgeInFlightVaultKeyIdRef.current === transitionKeyId
          ) {
            resetPurgeInFlightVaultKeyIdRef.current = null;
          }
        });
    },
    [effectiveDeviceStoreEnv],
  );


  /**
   * Reloads `GET /vault` (plan §2.6, ADR 0003 §8). After the session/account fence every response goes through ONE
   * table keyed on `vault_key_id`; `issuedKey` is the current key when the request was sent:
   *   0. A NEWER GET outcome was already applied -> apply nothing, return it (BE3-7, BE5-2).
   *   1. 404 -> 1a lock, wipe, purge (BE5-1); 1b the current key differs from `issuedKey` and is not retired: lock,
   *      no purge, ONE follow-up GET under it. The follow-up's own 404 is never 1b again (BE7-1): current still the
   *      key it was sent under, null or retired -> 1a; moved to another non-retired key -> lock only, no purge, no GET.
   *   2. Present, key == current -> apply with version = max(live, fresh), even across a local transition (BE6-1).
   *   3. Present, key retired -> stale by key: apply nothing, return the live current metadata (BE4-1).
   *   4. Present, key new -> genuine replacement: retire current, purge, lock, install.
   * Rows 1a and 4 purge USER-scoped device keys (`purgeDeviceKeysOnRevoked`); a key-scoped compare-and-delete is
   * deferred to T18 (CF-T18-KEYSCOPED-PURGE).
   * Other errors: supersession check, then rethrow. Local notifications never suppress or reorder a GET response.
   */
  const loadVaultMeta = useCallback(async (opts?: { resetKeyId?: string | null; followUp?: boolean }): Promise<VaultState | null> => {
    // `resetKeyId` is set only by this provider's own follow-up GET after it observed that vault's reset, so a
    // `404` that cannot name its vault is attributed to that observed reset and not to an unseen later one.
    // `followUp` marks that same internal GET: its 404 never takes row 1b again (exactly ONE follow-up).
    const followUpResetKeyId = opts?.resetKeyId ?? null;
    const isFollowUp = opts?.followUp === true;
    const requestSessionEpoch = vaultMetaSessionEpochRef.current;
    const requestSeq = ++vaultMetaRequestSeqRef.current;
    const issuedKey = currentVaultKeyIdRef.current;
    const requestUserId = currentUserIdRef.current ?? previousUserIdRef.current ?? null;
    // Session/user fences: a response from another session or account never has any effect.
    const isForeignResponse = () => {
      const liveUserId = currentUserIdRef.current ?? previousUserIdRef.current ?? null;
      return (
        vaultMetaSessionEpochRef.current !== requestSessionEpoch ||
        sessionStatus === 'signed_out' ||
        (requestUserId !== null && liveUserId !== requestUserId)
      );
    };
    // Live metadata, but only when it belongs to the vault that is current now: a replaced vault's metadata must never
    // be handed back as if it described its replacement.
    const currentLiveMeta = (): VaultState | null => {
      const live = liveVaultMetaRef.current;
      return live && live.vault_key_id === currentVaultKeyIdRef.current ? live : null;
    };
    // Ordering fence: only a NEWER request whose outcome was already applied supersedes this response. The
    // superseding outcome is returned so callers see the authoritative state rather than a bare `null`
    // (which would be indistinguishable from `vault_absent`, BE3-9).
    const supersedingOutcome = (): { meta: VaultState | null } | null => {
      const applied = vaultMetaAppliedRef.current;
      if (applied && applied.sessionEpoch === requestSessionEpoch && applied.seq > requestSeq) {
        // BE5-2: a local same-key update that landed after the saved outcome is newer than it; never hand back the older
        // version (the live metadata only differs from the outcome for the same key, otherwise the outcome stands).
        const live = liveVaultMetaRef.current;
        const meta =
          applied.meta && live && live.vault_key_id === applied.meta.vault_key_id && live.version > applied.meta.version
            ? live
            : applied.meta;
        return { meta };
      }
      return null;
    };
    try {
      const fresh = await fetchVault();
      if (isForeignResponse()) {
        return null;
      }
      const superseded = supersedingOutcome();
      if (superseded) {
        return superseded.meta;
      }
      if (retiredVaultKeyIdsRef.current.has(fresh.vault_key_id)) {
        // Row 3: a replaced or reset key is stale by key. Apply nothing and report the live current metadata (BE4-1).
        return currentLiveMeta();
      }
      const liveUserId = currentUserIdRef.current ?? previousUserIdRef.current ?? null;
      const prevKeyId = currentVaultKeyIdRef.current;
      // BE4-5: never lower the current same-key metadata version below a newer authoritative outcome (a local
      // update that landed while this response was in flight). Captured in-flight mutation snapshots are untouched.
      const liveMeta = liveVaultMetaRef.current;
      const applied: VaultState =
        liveMeta && liveMeta.vault_key_id === fresh.vault_key_id && liveMeta.version > fresh.version
          ? liveMeta
          : fresh;
      vaultMetaAppliedRef.current = { seq: requestSeq, sessionEpoch: requestSessionEpoch, meta: applied };
      if (prevKeyId && fresh.vault_key_id !== prevKeyId) {
        // Row 4: the previous vault is replaced: its reset id is historical now and must not be markable (BE4-3).
        retiredVaultKeyIdsRef.current.add(prevKeyId);
        retireObservedResets();
        currentVaultKeyIdRef.current = fresh.vault_key_id;
        resetPurgedVaultKeyIdRef.current = null;
        resetPurgeInFlightVaultKeyIdRef.current = null;
        setVaultMeta(applied);
        queryClient.setQueryData(VAULT_META_QUERY_KEY_PREFIX, applied);
        void purgeDeviceKeysOnRevoked(liveUserId, effectiveDeviceStoreEnv);
        void lock({ broadcast: true, reason: 'vault_key_id_changed' });
        return applied;
      }
      if (prevKeyId !== fresh.vault_key_id) {
        // A vault became current after an observed reset: that transition is over, retire its ids (BE4-3).
        retireObservedResets();
      }
      currentVaultKeyIdRef.current = fresh.vault_key_id;
      if (
        resetPurgedVaultKeyIdRef.current !== null &&
        resetPurgedVaultKeyIdRef.current !== fresh.vault_key_id
      ) {
        resetPurgedVaultKeyIdRef.current = null;
      }
      setVaultMeta(applied);
      queryClient.setQueryData(VAULT_META_QUERY_KEY_PREFIX, applied);
      return applied;
    } catch (err) {
      if (isForeignResponse()) {
        return null;
      }
      if (
        err instanceof ProblemError &&
        (err.problem.status === 404 || err.problem.code === 'vault_absent')
      ) {
        // Row 0, then row 1 (BE5-1): a local/broadcast transition never proves a 404 stale, so only an already-applied
        // newer GET outcome may supersede it; otherwise it fails closed.
        const superseded = supersedingOutcome();
        if (superseded) {
          // A newer request already delivered authoritative state (present or absent); apply nothing from the older 404.
          return superseded.meta;
        }
        const prevKeyId = currentVaultKeyIdRef.current;
        if (prevKeyId !== null && prevKeyId !== issuedKey && !retiredVaultKeyIdsRef.current.has(prevKeyId)) {
          // Row 1b: `prevKeyId` became current after this request was sent (the purge is user-scoped and would wipe its
          // device keys on ambiguous evidence). Lock, purge nothing, and let ONE follow-up GET (sent under `prevKeyId`,
          // so never ambiguous) decide. A follow-up response is never itself ambiguous (advisor-dec-038a, BE7-1): if the
          // key moved again while it was held, lock only; the new key's own GET or broadcast decides about it.
          void lock({ broadcast: true, reason: 'vault_absent' });
          if (!isFollowUp) {
            void loadVaultMeta({ resetKeyId: prevKeyId, followUp: true }).catch(() => undefined);
          }
          return null;
        }
        const liveUserId = currentUserIdRef.current ?? previousUserIdRef.current ?? null;
        vaultMetaAppliedRef.current = { seq: requestSeq, sessionEpoch: requestSessionEpoch, meta: null };
        // BE2-9: never borrow an old purge receipt as the identity of an unnamed 404.
        const transitionKeyId = prevKeyId ?? followUpResetKeyId;
        rememberObservedReset(transitionKeyId);
        currentVaultKeyIdRef.current = null;
        setVaultMeta(null);
        queryClient.removeQueries({ queryKey: VAULT_META_QUERY_KEY_PREFIX });
        runIdempotentResetPurge(liveUserId, transitionKeyId);
        void lock({ broadcast: true, reason: 'vault_absent' });
        return null;
      }
      const supersededFailure = supersedingOutcome();
      if (supersededFailure) {
        // A failed older request is moot once a newer one has produced authoritative state.
        return supersededFailure.meta;
      }
      throw err;
    }
  }, [
    effectiveDeviceStoreEnv,
    lock,
    queryClient,
    rememberObservedReset,
    retireObservedResets,
    runIdempotentResetPurge,
    sessionStatus,
    setVaultMeta,
  ]);

  const reloadVaultMeta = useCallback(() => loadVaultMeta(), [loadVaultMeta]);

  const notifyVaultChanged = useCallback(
    (payload: { vault_key_id: string; version: number | null }) => {
      if (payload.version === null) {
        const resetKeyId =
          (typeof payload.vault_key_id === 'string' && payload.vault_key_id.length > 0
            ? payload.vault_key_id
            : currentVaultKeyIdRef.current) ?? null;
        if (resetKeyId) {
          rememberObservedReset(resetKeyId);
          retiredVaultKeyIdsRef.current.add(resetKeyId);
          resetPurgedVaultKeyIdRef.current = resetKeyId;
        }
        currentVaultKeyIdRef.current = null;
        setVaultMeta(null);
        queryClient.removeQueries({ queryKey: VAULT_META_QUERY_KEY_PREFIX });
      } else {
        if (
          resetPurgedVaultKeyIdRef.current !== null &&
          resetPurgedVaultKeyIdRef.current !== payload.vault_key_id
        ) {
          resetPurgedVaultKeyIdRef.current = null;
        }
        if (currentVaultKeyIdRef.current !== payload.vault_key_id) {
          // Another key becomes current: the previous key is retired (BE4-1) and the previous reset ids are
          // historical (BE4-3).
          if (currentVaultKeyIdRef.current) retiredVaultKeyIdsRef.current.add(currentVaultKeyIdRef.current);
          retireObservedResets();
        }
        currentVaultKeyIdRef.current = payload.vault_key_id;
        const prev = liveVaultMetaRef.current;
        if (prev && prev.vault_key_id === payload.vault_key_id) {
          // BE4-5: a notification never lowers the current same-key version.
          setVaultMeta({ ...prev, version: Math.max(prev.version, payload.version) });
        }
      }
      postVaultBroadcast(
        {
          type: 'vault_changed',
          vault_key_id: payload.vault_key_id,
          version: payload.version,
        },
        providerSenderIdRef.current,
      );
    },
    [queryClient, rememberObservedReset, retireObservedResets, setVaultMeta],
  );

  const notifySettingsChanged = useCallback(
    (payload: { auto_lock_minutes: number }) => {
      settingsSyncSeqRef.current += 1;
      const normalized = normalizeAutoLockMinutes(payload.auto_lock_minutes);
      autoLockMinutesRef.current = normalized;
      setAutoLockMinutesOverride(normalized);
      postVaultBroadcast(
        {
          type: 'settings_changed',
          auto_lock_minutes: normalized,
        },
        providerSenderIdRef.current,
      );
    },
    [],
  );

  const recordActivity = useCallback((at?: number) => {
    if (wakeVerifyingCountRef.current > 0) {
      // Do not overwrite pre-wake idle watermark while wake verification is pending
      return;
    }
    const now = typeof at === 'number' && Number.isFinite(at) ? at : Date.now();
    if (now < lastActivityAtRef.current - CLOCK_ROLLBACK_TOLERANCE_MS) {
      // System clock rolled back by > 1 minute -> do not overwrite lastActivityAt; evaluation will lock.
      return;
    }
    if (now > lastActivityAtRef.current) {
      lastActivityAtRef.current = now;
      setLastActivityAt(now);
    }
    if (now - lastBroadcastedActivityAtRef.current >= ACTIVITY_BROADCAST_THROTTLE_MS) {
      lastBroadcastedActivityAtRef.current = now;
      postVaultBroadcast({ type: 'activity', at: now }, providerSenderIdRef.current);
    }
  }, []);

  /**
   * Executes a state-changing CryptoClient call with `inFlight` tracking, `activeOperation` sub-state,
   * and `unlockBaseline` capture/verification for unlock/createVault transitions (ADR 0003 §8.4).
   */
  const runStateChangingOp = useCallback(
    async <T,>(
      opKind: VaultActiveOperation,
      baselineMode: 'none' | 'capture_fresh' | 'require_existing',
      opGeneration: number,
      invoke: (client: CryptoClient, injectBeforePost?: () => Promise<void>) => Promise<T>,
    ): Promise<T> => {
      const client = getClient();
      setLastErrorCode(null);
      inFlightStateOpCountRef.current += 1;
      setInFlightCount((c) => c + 1);
      if (opKind) {
        activeOperationRef.current = opKind;
        setActiveOperation(opKind);
      }

      const requiresUnlockBaseline = baselineMode !== 'none';
      const existingBaseline =
        baselineMode === 'require_existing' ? unlockBaselineRef.current : null;

      let capturedBaseline: LockEpochMarker | null = existingBaseline;
      let verifyDeadlineTimer: number | null = null;
      const clearVerifyDeadlineTimer = () => {
        if (verifyDeadlineTimer !== null && typeof window !== 'undefined') {
          window.clearTimeout(verifyDeadlineTimer);
          verifyDeadlineTimer = null;
        }
      };

      // BE3-1: only the operation that still owns the client's generation may destroy key material on failure. Once
      // the generation moved on, the Worker was already locked by whoever bumped it and a replacement session
      // (G+1) may now hold live keys that this obsolete wrapper must never lock.
      const lockIfOwner = async () => {
        if (client.getGeneration() === opGeneration) {
          await lockLocalOnly();
        }
      };

      const prepareBaseline = async () => {
        if (!requiresUnlockBaseline) return;
        // Invalidate any in-flight wake verification only once the operation is admitted (BE2-6)
        wakeVerificationSeqRef.current += 1;
        wakeVerifyingCountRef.current = 0;
        wakePreIdleAtRef.current = null;
        setWakeVerifyingCount(0);
        baselineVerifiedRef.current = false;
        setBaselineVerified(false);
        notifyStoreListeners();
        if (baselineMode === 'require_existing') {
          if (!existingBaseline) {
            // BE2-6: confirmRecovery / resumeRecovery must NEVER recapture a fresh baseline when missing; fail closed
            await lockIfOwner();
            throw new CryptoClientError(
              'STALE_GENERATION',
              'Missing recovery lockEpoch baseline; failing closed',
            );
          }
          // Verify the baseline captured at recovery start has not changed before continuing (`resumeRecovery` / `confirmRecovery`)
          const preCheck = await verifyUnlockBaseline(existingBaseline, envWithBroadcast);
          if (preCheck.persistedMarker) {
            updateTabKnownLockEpoch(preCheck.persistedMarker.lockEpoch);
          }
          if (!preCheck.matches || client.getGeneration() !== opGeneration) {
            await lockIfOwner();
            throw new CryptoClientError(
              'STALE_GENERATION',
              'Authoritative lockEpoch changed during recovery; failing closed',
            );
          }
          capturedBaseline = existingBaseline;
          return;
        }

        // baselineMode === 'capture_fresh':
        // If beginOp() already captured an intent-start baseline for this opGeneration (BE2-1), reuse and verify it!
        const intentBaselinePromise = intentBaselinesRef.current.get(opGeneration);
        intentBaselinesRef.current.delete(opGeneration);
        if (intentBaselinePromise) {
          const intentBaseline = await intentBaselinePromise;
          if (!intentBaseline || client.getGeneration() !== opGeneration) {
            await lockIfOwner();
            throw new CryptoClientError(
              'STALE_GENERATION',
              'Failed to capture intent-start lockEpoch baseline; failing closed',
            );
          }
          const preCheck = await verifyUnlockBaseline(intentBaseline, envWithBroadcast);
          if (preCheck.persistedMarker) {
            updateTabKnownLockEpoch(preCheck.persistedMarker.lockEpoch);
          }
          if (!preCheck.matches || client.getGeneration() !== opGeneration) {
            await lockIfOwner();
            throw new CryptoClientError(
              'STALE_GENERATION',
              'Authoritative lockEpoch changed after unlock intent started; failing closed',
            );
          }
          capturedBaseline = intentBaseline;
          return;
        }

        const baseline = await captureUnlockBaseline(
          tabKnownLockEpochRef.current,
          envWithBroadcast,
        );
        if (!baseline || client.getGeneration() !== opGeneration) {
          // Fail closed if IndexedDB or Web Locks is unreadable/blocked during unlock baseline capture
          await lockIfOwner();
          throw new CryptoClientError(
            'STALE_GENERATION',
            'Failed to capture authoritative lockEpoch baseline; failing closed',
          );
        }
        capturedBaseline = baseline;
        updateTabKnownLockEpoch(baseline.lockEpoch);
      };

      try {
        const result = await invoke(client, prepareBaseline);

        if (requiresUnlockBaseline) {
          // BE2-7: Bound post-unlock Web Lock / IDB baseline verification with the 5s fail-closed deadline
          // so a stalled verification never retains the unwrapped VK in Worker memory indefinitely.
          let verifyTimedOut = false;
          let resolveVerifyTimeout!: (val: 'timeout') => void;
          const verifyTimeoutPromise = new Promise<'timeout'>((resolve) => {
            resolveVerifyTimeout = resolve;
          });
          if (typeof window !== 'undefined') {
            verifyDeadlineTimer = window.setTimeout(() => {
              verifyTimedOut = true;
              resolveVerifyTimeout('timeout');
            }, WAKE_ME_REFRESH_DEADLINE_MS);
          }
          const verificationOrTimeout = await Promise.race([
            verifyUnlockBaseline(capturedBaseline, envWithBroadcast),
            verifyTimeoutPromise,
          ]);
          clearVerifyDeadlineTimer();
          if (
            verifyTimedOut ||
            verificationOrTimeout === 'timeout' ||
            !verificationOrTimeout.matches ||
            client.getGeneration() !== opGeneration ||
            !capturedBaseline
          ) {
            if (
              verificationOrTimeout !== 'timeout' &&
              verificationOrTimeout.persistedMarker
            ) {
              updateTabKnownLockEpoch(verificationOrTimeout.persistedMarker.lockEpoch);
            }
            await lockIfOwner();
            throw new CryptoClientError(
              'STALE_GENERATION',
              'Authoritative lockEpoch changed or timed out during unlock; failing closed',
            );
          }
          if (verificationOrTimeout.persistedMarker) {
            updateTabKnownLockEpoch(verificationOrTimeout.persistedMarker.lockEpoch);
          }
          // Invalidate any wake verification started before this unlock baseline finished verifying
          wakeVerificationSeqRef.current += 1;
          wakeVerifyingCountRef.current = 0;
          wakePreIdleAtRef.current = null;
          unlockBaselineRef.current = capturedBaseline;
          baselineVerifiedRef.current = true;
          setWakeVerifyingCount(0);
          setUnlockBaseline(capturedBaseline);
          setBaselineVerified(true);
          notifyStoreListeners();
          const unlockedAt = Date.now();
          lastActivityAtRef.current = Math.max(lastActivityAtRef.current, unlockedAt);
          setLastActivityAt(lastActivityAtRef.current);
          lastBroadcastedActivityAtRef.current = unlockedAt;
          postVaultBroadcast({ type: 'activity', at: lastActivityAtRef.current }, providerSenderIdRef.current);
        }
        setGeneration(client.getGeneration());
        setEpoch(client.getEpoch());
        return result;
      } catch (err) {
        clearVerifyDeadlineTimer();
        const classified = classifyCryptoError(err);
        if (classified.code) {
          setLastErrorCode(classified.code);
        }
        setGeneration(client.getGeneration());
        setEpoch(client.getEpoch());
        throw err;
      } finally {
        clearVerifyDeadlineTimer();
        inFlightStateOpCountRef.current = Math.max(0, inFlightStateOpCountRef.current - 1);
        setInFlightCount((c) => Math.max(0, c - 1));
        if (activeOperationRef.current === opKind) {
          activeOperationRef.current = null;
        }
        setActiveOperation((current) => (current === opKind ? null : current));
        notifyStoreListeners();
      }
    },
    [envWithBroadcast, getClient, lockLocalOnly, notifyStoreListeners, updateTabKnownLockEpoch],
  );

  const createVaultOp = useCallback(
    (params: CreateVaultClientParams): Promise<CreateVaultResult> => {
      return runStateChangingOp(
        'onboarding',
        'capture_fresh',
        params.opGeneration,
        (client, prepareBaseline) =>
          client.createVault({
            ...params,
            beforePostMessage: async () => {
              await prepareBaseline?.();
              await params.beforePostMessage?.();
            },
          }),
      );
    },
    [runStateChangingOp],
  );

  const unlockPassphraseOp = useCallback(
    (params: UnlockPassphraseClientParams): Promise<{ unlocked: true }> => {
      return runStateChangingOp(
        'unlocking',
        'capture_fresh',
        params.opGeneration,
        (client, prepareBaseline) =>
          client.unlockPassphrase({
            ...params,
            beforePostMessage: async () => {
              await prepareBaseline?.();
              await params.beforePostMessage?.();
            },
          }),
      );
    },
    [runStateChangingOp],
  );

  const unlockRecoveryOp = useCallback(
    (
      params: UnlockRecoveryClientParams,
    ): Promise<DeriveRecoveryLookupResult & { recovering?: boolean }> => {
      return runStateChangingOp(
        'unlocking',
        'capture_fresh',
        params.opGeneration,
        (client, prepareBaseline) =>
          client.unlockRecovery({
            ...params,
            beforePostMessage: async () => {
              await prepareBaseline?.();
              await params.beforePostMessage?.();
            },
          }),
      );
    },
    [runStateChangingOp],
  );

  const resumeRecoveryOp = useCallback(
    (params: ResumeRecoveryClientParams): Promise<ResumeRecoveryResult> => {
      return runStateChangingOp(
        'unlocking',
        'require_existing',
        params.opGeneration,
        async (client, prepareBaseline) => {
          // Verify the recovery baseline BEFORE acquiring the CryptoClient single-flight slot so a fail-closed
          // lockLocalOnly() on baseline mismatch never leaves client.stateSlot held when the caller retries (BE1-6).
          await prepareBaseline?.();
          return client.resumeRecovery({
            ...params,
            beforePostMessage: params.beforePostMessage,
          });
        },
      );
    },
    [runStateChangingOp],
  );

  const confirmRecoveryOp = useCallback(
    (params: ConfirmRecoveryClientParams): Promise<ConfirmRecoveryResult> => {
      return runStateChangingOp(
        'rewrapping',
        'require_existing',
        params.opGeneration,
        async (client, prepareBaseline) => {
          await prepareBaseline?.();
          return client.confirmRecovery({
            ...params,
            beforePostMessage: params.beforePostMessage,
          });
        },
      );
    },
    [runStateChangingOp],
  );

  const unlockPrfOp = useCallback(
    (params: UnlockPrfClientParams): Promise<{ unlocked: true }> => {
      return runStateChangingOp(
        'unlocking',
        'capture_fresh',
        params.opGeneration,
        (client, prepareBaseline) =>
          client.unlockPrf({
            ...params,
            beforePostMessage: async () => {
              await prepareBaseline?.();
              await params.beforePostMessage?.();
            },
          }),
      );
    },
    [runStateChangingOp],
  );

  const unlockDevKeyOp = useCallback(
    (params: UnlockDevKeyClientParams): Promise<{ unlocked: true }> => {
      return runStateChangingOp(
        'unlocking',
        'capture_fresh',
        params.opGeneration,
        (client, prepareBaseline) =>
          client.unlockDevKey({
            ...params,
            beforePostMessage: async () => {
              await prepareBaseline?.();
              await params.beforePostMessage?.();
            },
          }),
      );
    },
    [runStateChangingOp],
  );

  const rewrapOp = useCallback(
    (params: RewrapClientParams): Promise<RewrapResult> => {
      return runStateChangingOp('rewrapping', 'none', params.opGeneration, (client) =>
        client.rewrap(params),
      );
    },
    [runStateChangingOp],
  );

  // Logout or user switch: clear VK/plaintext + vault caches immediately; NEVER touch DevKey records (Task 15A #4).
  useEffect(() => {
    const nextUserId = me?.user.id ?? null;
    const prevUserId = previousUserIdRef.current;

    if (sessionStatus === 'signed_out') {
      if (
        prevUserId !== null ||
        workerStateRef.current !== 'locked' ||
        vaultMeta !== null
      ) {
        vaultMetaSessionEpochRef.current += 1;
        settingsSyncSeqRef.current += 1;
        vaultMetaRequestSeqRef.current += 1;
        previousUserIdRef.current = null;
        currentVaultKeyIdRef.current = null;
        resetPurgedVaultKeyIdRef.current = null;
        resetPurgeInFlightVaultKeyIdRef.current = null;
        observedResetKeyIdsRef.current.clear();
        retiredVaultKeyIdsRef.current.clear();
        setVaultMeta(null);
        queryClient.removeQueries({ queryKey: VAULT_META_QUERY_KEY_PREFIX });
        void lock({ broadcast: true, reason: 'signed_out' });
      }
      return;
    }

    if (nextUserId && prevUserId && nextUserId !== prevUserId) {
      // Account switch in the same tab: wipe VK/plaintext + vault metadata immediately
      vaultMetaSessionEpochRef.current += 1;
      settingsSyncSeqRef.current += 1;
      vaultMetaRequestSeqRef.current += 1;
      previousUserIdRef.current = nextUserId;
      currentVaultKeyIdRef.current = null;
      resetPurgedVaultKeyIdRef.current = null;
      resetPurgeInFlightVaultKeyIdRef.current = null;
      observedResetKeyIdsRef.current.clear();
      retiredVaultKeyIdsRef.current.clear();
      setVaultMeta(null);
      queryClient.removeQueries({ queryKey: VAULT_META_QUERY_KEY_PREFIX });
      void lock({ broadcast: true, reason: 'user_changed' });
      return;
    }

    if (nextUserId) {
      previousUserIdRef.current = nextUserId;
    }
  }, [lock, me?.user.id, queryClient, sessionStatus, setVaultMeta, vaultMeta]);

  // Subscribe to BroadcastChannel('sabk.vault') for `lock`, `vault_changed`, `activity`, and `settings_changed` (Task 15A #5 & Task 15B #1).
  useEffect(() => {
    return subscribeVaultBroadcast((message: VaultBroadcastMessage, origin, senderId) => {
      if (origin === 'local' && senderId === providerSenderIdRef.current) return;

      if (message.type === 'lock') {
        updateTabKnownLockEpoch(message.lockEpoch);
        void lockLocalOnly();
        return;
      }

      if (message.type === 'activity') {
        // Never allow remote activity broadcasts to erase the pre-wake idle watermark while wake verification is pending
        if (wakeVerifyingCountRef.current > 0) {
          return;
        }
        if (message.at > lastActivityAtRef.current) {
          lastActivityAtRef.current = message.at;
          setLastActivityAt(message.at);
        }
        return;
      }

      if (message.type === 'settings_changed') {
        const hintMinutes = normalizeAutoLockMinutes(message.auto_lock_minutes);
        const currentMinutes = autoLockMinutesRef.current;
        // Never relax a positive auto-lock policy to Never (0) or a longer timeout before authoritative Me confirms it;
        // apply stricter (shorter positive) hints immediately as an optimistic guard, then reconcile from fetchMe().
        if (hintMinutes > 0 && (currentMinutes === 0 || hintMinutes < currentMinutes)) {
          autoLockMinutesRef.current = hintMinutes;
          setAutoLockMinutesOverride(hintMinutes);
        }
        const syncSeq = ++settingsSyncSeqRef.current;
        const syncGen = getClient().getGeneration();
        const syncSessionEpoch = vaultMetaSessionEpochRef.current;
        void fetchMe()
          .then((freshMe) => {
            if (
              settingsSyncSeqRef.current !== syncSeq ||
              getClient().getGeneration() !== syncGen ||
              vaultMetaSessionEpochRef.current !== syncSessionEpoch
            ) {
              return;
            }
            const authoritative = normalizeAutoLockMinutes(freshMe.settings.auto_lock_minutes);
            autoLockMinutesRef.current = authoritative;
            setAutoLockMinutesOverride(authoritative);
            void refetchMe().catch(() => undefined);
          })
          .catch(() => {
            // Failed refresh must not relax a positive policy to Never; keep current positive policy intact.
            void refetchMe().catch(() => undefined);
          });
        return;
      }

      if (message.type === 'vault_changed') {
        const knownKeyId = currentVaultKeyIdRef.current;
        if (
          message.version === null ||
          (knownKeyId !== null && message.vault_key_id !== knownKeyId)
        ) {
          if (message.version === null) {
            const incomingKeyId =
              typeof message.vault_key_id === 'string' && message.vault_key_id.length > 0
                ? message.vault_key_id
                : null;
            const transitionKeyId = incomingKeyId ?? knownKeyId ?? null;
            if (incomingKeyId) retiredVaultKeyIdsRef.current.add(incomingKeyId);
            if (knownKeyId) retiredVaultKeyIdsRef.current.add(knownKeyId);
            rememberObservedReset(transitionKeyId);
            currentVaultKeyIdRef.current = null;
            setVaultMeta(null);
            queryClient.removeQueries({ queryKey: VAULT_META_QUERY_KEY_PREFIX });
            runIdempotentResetPurge(
              currentUserIdRef.current ?? previousUserIdRef.current,
              transitionKeyId,
            );
            void lock({ broadcast: true, reason: 'vault_reset_broadcast' });
            void refetchMe().catch(() => undefined);
            void loadVaultMeta({ resetKeyId: transitionKeyId }).catch(() => undefined);
            return;
          }
          // Replacement by another key: the previous key is retired (BE4-1) and its reset id is historical (BE4-3).
          if (knownKeyId) retiredVaultKeyIdsRef.current.add(knownKeyId);
          retireObservedResets();
          resetPurgedVaultKeyIdRef.current = null;
          resetPurgeInFlightVaultKeyIdRef.current = null;
          currentVaultKeyIdRef.current = message.vault_key_id;
          setVaultMeta(null);
          queryClient.removeQueries({ queryKey: VAULT_META_QUERY_KEY_PREFIX });
          void purgeDeviceKeysOnRevoked(
            currentUserIdRef.current ?? previousUserIdRef.current,
            effectiveDeviceStoreEnv,
          );
          void lock({ broadcast: true, reason: 'vault_key_id_changed_broadcast' });
          void loadVaultMeta().catch(() => undefined);
          return;
        }
        if (knownKeyId === null && !retiredVaultKeyIdsRef.current.has(message.vault_key_id)) {
          // Learn another tab's new key so a held older 404 is treated as row 1b.
          retireObservedResets();
          currentVaultKeyIdRef.current = message.vault_key_id;
        }
        void loadVaultMeta().catch(() => undefined);
      }
    });
  }, [
    effectiveDeviceStoreEnv,
    getClient,
    lock,
    lockLocalOnly,
    me?.user.id,
    queryClient,
    refetchMe,
    loadVaultMeta,
    rememberObservedReset,
    retireObservedResets,
    runIdempotentResetPurge,
    setVaultMeta,
    updateTabKnownLockEpoch,
  ]);

  // Shared multi-tab auto-lock timer & user activity listeners (plan §2.6, Task 15B #1).
  useEffect(() => {
    if (autoLockTimerRef.current !== null) {
      window.clearTimeout(autoLockTimerRef.current);
      autoLockTimerRef.current = null;
    }

    const isProtectedSessionActive =
      (workerState === 'unlocked' && baselineVerified) || workerState === 'recovering';
    if (!isProtectedSessionActive) {
      setMinutesLeft(undefined);
      return;
    }

    // When `auto_lock_minutes === 0` ("Never"), do not start any timer and do not run periodic checks.
    if (autoLockMinutes === 0) {
      setMinutesLeft(undefined);
      return;
    }

    let cancelled = false;
    const scheduleCheck = () => {
      const stillActive =
        (workerStateRef.current === 'unlocked' && baselineVerifiedRef.current) ||
        workerStateRef.current === 'recovering';
      if (cancelled || !stillActive) return;
      const currentMinutes = autoLockMinutesRef.current;
      if (currentMinutes === 0) {
        setMinutesLeft(undefined);
        return;
      }
      const now = Date.now();
      const evaluation = evaluateAutoLockAt({
        now,
        lastActivityAt: lastActivityAtRef.current,
        autoLockMinutes: currentMinutes,
      });
      if (evaluation.shouldLock) {
        setMinutesLeft(undefined);
        void lock({ broadcast: true, reason: evaluation.reason });
        return;
      }
      setMinutesLeft(evaluation.minutesLeft);
      const remainingMs = evaluation.remainingMs ?? currentMinutes * 60_000;
      // Wake up at either the exact deadline or the next minute boundary to update `minutesLeft`
      const nextMinuteTickMs = (evaluation.remainingMs ?? 60_000) % 60_000 || 60_000;
      const delayMs = Math.max(50, Math.min(remainingMs, nextMinuteTickMs));
      autoLockTimerRef.current = window.setTimeout(scheduleCheck, delayMs);
    };

    scheduleCheck();

    return () => {
      cancelled = true;
      if (autoLockTimerRef.current !== null) {
        window.clearTimeout(autoLockTimerRef.current);
        autoLockTimerRef.current = null;
      }
    };
  }, [autoLockMinutes, baselineVerified, lastActivityAt, lock, workerState]);

  // User interaction activity listeners while unlocked (throttled broadcast to sibling tabs).
  useEffect(() => {
    const isProtectedSessionActive =
      (workerState === 'unlocked' && baselineVerified) || workerState === 'recovering';
    if (typeof window === 'undefined' || !isProtectedSessionActive) return;

    const onUserActivity = () => {
      const stillActive =
        (workerStateRef.current === 'unlocked' && baselineVerifiedRef.current) ||
        workerStateRef.current === 'recovering';
      if (!stillActive) return;
      const now = Date.now();
      if (now < lastActivityAtRef.current - CLOCK_ROLLBACK_TOLERANCE_MS) {
        void lock({ broadcast: true, reason: 'clock_rollback' });
        return;
      }
      recordActivity(now);
    };
    window.addEventListener('pointerdown', onUserActivity, { passive: true });
    window.addEventListener('keydown', onUserActivity, { passive: true });
    window.addEventListener('wheel', onUserActivity, { passive: true });
    window.addEventListener('touchstart', onUserActivity, { passive: true });

    return () => {
      window.removeEventListener('pointerdown', onUserActivity);
      window.removeEventListener('keydown', onUserActivity);
      window.removeEventListener('wheel', onUserActivity);
      window.removeEventListener('touchstart', onUserActivity);
    };
  }, [baselineVerified, lock, recordActivity, workerState]);

  // Wake / resume / visibilitychange / pageshow / focus / popstate fail-closed check (ADR 0003 §8.4, Task 15A #3/#6, Task 15B #1/#3/#5).
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    let wakeInFlight: {
      promise: Promise<void>;
      opGeneration: number;
      sessionEpoch: number;
      wakeSeq: number;
    } | null = null;

    const verifyOnWake = (): Promise<void> => {
      const initialWorkerState = workerStateRef.current;
      if (initialWorkerState !== 'unlocked' && initialWorkerState !== 'recovering') {
        return Promise.resolve();
      }
      if (initialWorkerState === 'unlocked' && !baselineVerifiedRef.current && wakeVerifyingCountRef.current === 0) {
        // Initial post-unlock verification is still in flight; runStateChangingOp handles it
        return Promise.resolve();
      }

      // Preserve the earliest pre-wake idle watermark across overlapping wake triggers
      const wakeNow = Date.now();
      if (wakeVerifyingCountRef.current === 0 || wakePreIdleAtRef.current === null) {
        wakePreIdleAtRef.current = lastActivityAtRef.current;
      }
      const preWakeLastActivityAt = wakePreIdleAtRef.current;

      // Immediate synchronous clock-rollback and known auto-lock check (do not trust throttled timers)
      const knownEvaluation = evaluateAutoLockAt({
        now: wakeNow,
        lastActivityAt: preWakeLastActivityAt,
        autoLockMinutes: autoLockMinutesRef.current,
      });
      if (knownEvaluation.shouldLock) {
        void lock({ broadcast: true, reason: knownEvaluation.reason });
        return Promise.resolve();
      }

      const client = getClient();
      const wakeOpGeneration = client.getGeneration();
      const wakeSessionEpoch = vaultMetaSessionEpochRef.current;

      // BE2-5: Coalesce burst wake events ONLY when they belong to the exact same active generation,
      // session epoch, and current wake sequence; never reuse an obsolete wake promise from an earlier session.
      if (
        wakeInFlight &&
        wakeInFlight.opGeneration === wakeOpGeneration &&
        wakeInFlight.sessionEpoch === wakeSessionEpoch &&
        wakeInFlight.wakeSeq === wakeVerificationSeqRef.current
      ) {
        return wakeInFlight.promise;
      }

      const wakeSeq = ++wakeVerificationSeqRef.current;

      const runWake = async () => {
        let deadlineTimer: number | null = null;
        const clearDeadlineTimer = () => {
          if (deadlineTimer !== null) {
            window.clearTimeout(deadlineTimer);
            deadlineTimer = null;
          }
        };

        try {
          // VS-R7-1: Gate plaintext access synchronously on wake (before any async await or next paint):
          // 1. Update ref-backed gate state and notify useSyncExternalStore subscribers.
          // 2. Synchronously purge decrypted entry body cache (`['vault', 'body', ...]`), clear `[data-vault-secret]`
          //    inputs and `[data-vault-decrypted]` nodes, and run registered secret form resetters so no decrypted
          //    plaintext remains in the DOM even on a heavy page.
          // 3. Flush state updates synchronously via flushSync when outside render.
          wakeVerifyingCountRef.current += 1;
          if (initialWorkerState === 'unlocked') {
            baselineVerifiedRef.current = false;
          }
          clearPlaintextAndFormsSync();
          notifyStoreListeners();
          try {
            flushSync(() => {
              setWakeVerifyingCount(wakeVerifyingCountRef.current);
              if (initialWorkerState === 'unlocked') {
                setBaselineVerified(false);
              }
            });
          } catch {
            setWakeVerifyingCount(wakeVerifyingCountRef.current);
            if (initialWorkerState === 'unlocked') {
              setBaselineVerified(false);
            }
          }
          // BE2-2: Use a standard Promise constructor (never Promise.withResolvers) inside the fail-closed try/finally
          // so older Safari/Chrome runtimes or any setup error always enter catch/finally and lock fail-closed.
          let timedOut = false;
          let resolveTimeout!: (val: 'timeout') => void;
          const timeoutPromise = new Promise<'timeout'>((resolve) => {
            resolveTimeout = resolve;
          });
          deadlineTimer = window.setTimeout(() => {
            timedOut = true;
            if (
              wakeVerificationSeqRef.current === wakeSeq &&
              client.getGeneration() === wakeOpGeneration &&
              (workerStateRef.current === 'unlocked' || workerStateRef.current === 'recovering')
            ) {
              void lock({ broadcast: true, reason: 'wake_me_deadline_exceeded' });
            }
            resolveTimeout('timeout');
          }, WAKE_ME_REFRESH_DEADLINE_MS);
        // 2. Authoritative `lockEpoch` check in IndexedDB under Web Lock `'sabk.vault.lock'`
        if (initialWorkerState === 'unlocked' || initialWorkerState === 'recovering') {
          const baseline = unlockBaselineRef.current;
          const baselineOrTimeout = await Promise.race([
            verifyUnlockBaseline(baseline, envWithBroadcast),
            timeoutPromise,
          ]);
          if (
            timedOut ||
            baselineOrTimeout === 'timeout' ||
            wakeVerificationSeqRef.current !== wakeSeq ||
            client.getGeneration() !== wakeOpGeneration ||
            vaultMetaSessionEpochRef.current !== wakeSessionEpoch
          ) {
            return;
          }
          if (baselineOrTimeout.persistedMarker) {
            updateTabKnownLockEpoch(baselineOrTimeout.persistedMarker.lockEpoch);
          }
          if (!baselineOrTimeout.matches) {
            void lockLocalOnly();
            return;
          }
        }

        // 3. Authoritative `GET /auth/me` refresh on wake while unlocked or recovering (5s fail-closed deadline; never trust stale `0`)
        if (workerStateRef.current !== 'unlocked' && workerStateRef.current !== 'recovering') {
          return;
        }

        const freshMeOrTimeout = await Promise.race([fetchMe(), timeoutPromise]);
        if (
          timedOut ||
          freshMeOrTimeout === 'timeout' ||
          !freshMeOrTimeout ||
          wakeVerificationSeqRef.current !== wakeSeq ||
          client.getGeneration() !== wakeOpGeneration ||
          vaultMetaSessionEpochRef.current !== wakeSessionEpoch
        ) {
          if (
            (timedOut || !freshMeOrTimeout) &&
            client.getGeneration() === wakeOpGeneration &&
            (workerStateRef.current === 'unlocked' || workerStateRef.current === 'recovering')
          ) {
            void lock({ broadcast: true, reason: 'wake_me_deadline_exceeded' });
          }
          return;
        }

        const freshMe = freshMeOrTimeout;
        settingsSyncSeqRef.current += 1;
        const freshMinutes = normalizeAutoLockMinutes(freshMe.settings.auto_lock_minutes);
        autoLockMinutesRef.current = freshMinutes;
        setAutoLockMinutesOverride(freshMinutes);
        void refetchMe().catch(() => undefined);

        if (freshMe.vault.status !== 'present') {
          void purgeDeviceKeysOnRevoked(freshMe.user.id, effectiveDeviceStoreEnv);
          void lock({ broadcast: true, reason: 'vault_absent_on_wake' });
          return;
        }

        const afterMeEval = evaluateAutoLockAt({
          now: Date.now(),
          lastActivityAt: preWakeLastActivityAt,
          autoLockMinutes: freshMinutes,
        });
        if (afterMeEval.shouldLock) {
          void lock({ broadcast: true, reason: afterMeEval.reason });
          return;
        }

        // Only restore unlocked application access if generation and wake sequence are still current
        if (
          wakeVerificationSeqRef.current === wakeSeq &&
          client.getGeneration() === wakeOpGeneration &&
          vaultMetaSessionEpochRef.current === wakeSessionEpoch &&
          (workerStateRef.current === 'unlocked' || workerStateRef.current === 'recovering') &&
          unlockBaselineRef.current !== null
        ) {
          baselineVerifiedRef.current = true;
          setBaselineVerified(true);
          setMinutesLeft(afterMeEval.minutesLeft);
          notifyStoreListeners();
          const postWakeNow = Date.now();
          if (postWakeNow > lastActivityAtRef.current) {
            lastActivityAtRef.current = postWakeNow;
            setLastActivityAt(postWakeNow);
          }
        }
      } catch {
        // `401` (including `session_invalid`) or network failure on wake -> fail closed, lock immediately
        if (
          client.getGeneration() === wakeOpGeneration &&
          (workerStateRef.current === 'unlocked' || workerStateRef.current === 'recovering')
        ) {
          void lock({ broadcast: true, reason: 'wake_me_failed' });
        }
      } finally {
        clearDeadlineTimer();
        if (wakeVerificationSeqRef.current === wakeSeq) {
          wakeVerifyingCountRef.current = 0;
          wakePreIdleAtRef.current = null;
          setWakeVerifyingCount(0);
          notifyStoreListeners();
        }
      }
      };

      const entry = {
        promise: Promise.resolve(),
        opGeneration: wakeOpGeneration,
        sessionEpoch: wakeSessionEpoch,
        wakeSeq,
      };
      const p = runWake().finally(() => {
        if (wakeInFlight === entry) {
          wakeInFlight = null;
        }
      });
      entry.promise = p;
      wakeInFlight = entry;
      return p;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void verifyOnWake();
      }
    };

    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && workerStateRef.current === 'locked') {
        clearPlaintextAndFormsSync();
      }
      void verifyOnWake();
    };

    const onFocusOrResume = () => {
      void verifyOnWake();
    };

    const onPopState = () => {
      // History Back after lock must never revive or show cached plaintext (Task 15A #3).
      if (workerStateRef.current !== 'unlocked') {
        clearPlaintextAndFormsSync();
      } else {
        void verifyOnWake();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', onFocusOrResume);
    window.addEventListener('resume', onFocusOrResume);
    window.addEventListener('popstate', onPopState);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', onFocusOrResume);
      window.removeEventListener('resume', onFocusOrResume);
      window.removeEventListener('popstate', onPopState);
    };
  }, [
    clearPlaintextAndFormsSync,
    effectiveDeviceStoreEnv,
    envWithBroadcast,
    getClient,
    lock,
    lockLocalOnly,
    notifyStoreListeners,
    refetchMe,
    updateTabKnownLockEpoch,
  ]);

  // Keyboard shortcut `L` to lock immediately (ignored inside inputs/textareas/contenteditable and with modifiers, Task 15A #3).
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.key !== 'l' && event.key !== 'L') return;
      if (isEditableElement(event.target)) return;
      if (
        typeof document !== 'undefined' &&
        isEditableElement(document.activeElement)
      ) {
        return;
      }
      if (me?.vault.status !== 'present' && workerStateRef.current === 'locked') {
        return;
      }
      event.preventDefault();
      void lockNow();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [lockNow, me?.vault.status]);

  // Terminate Worker on provider unmount
  useEffect(() => {
    return () => {
      clientRef.current?.terminate();
      clientRef.current = null;
    };
  }, []);

  const serverVaultStatus: 'absent' | 'present' =
    me?.vault.status === 'present' ? 'present' : 'absent';
  const serverVaultStatusRef = useRef<'absent' | 'present'>(serverVaultStatus);
  serverVaultStatusRef.current = serverVaultStatus;

  const state: VaultStateMachineMode = useMemo(
    () =>
      deriveVaultStateMachineMode({
        serverVaultStatus,
        workerState,
        activeOperation,
        baselineVerified,
        wakeVerifying: wakeVerifyingCount > 0,
      }),
    [serverVaultStatus, workerState, activeOperation, baselineVerified, wakeVerifyingCount],
  );

  const inFlight = inFlightCount > 0;
  const isRecovering = workerState === 'recovering';

  const value = useMemo<VaultContextValue>(
    () => ({
      state,
      workerState,
      serverVaultStatus,
      generation,
      epoch,
      inFlight,
      activeOperation,
      lastErrorCode,
      isRecovering,
      vaultMeta,
      tabKnownLockEpoch,
      unlockBaseline,
      autoLockMinutes,
      lastActivityAt,
      minutesLeft,
      getClient,
      captureOpGeneration,
      beginOp,
      lock,
      lockNow,
      registerSecretFormReset,
      notifyVaultChanged,
      notifySettingsChanged,
      recordActivity,
      reloadVaultMeta,
      markResetPurged,
      setActiveOperation,
      clearError,
      createVault: createVaultOp,
      unlockPassphrase: unlockPassphraseOp,
      unlockRecovery: unlockRecoveryOp,
      resumeRecovery: resumeRecoveryOp,
      confirmRecovery: confirmRecoveryOp,
      unlockPrf: unlockPrfOp,
      unlockDevKey: unlockDevKeyOp,
      rewrap: rewrapOp,
    }),
    [
      state,
      workerState,
      serverVaultStatus,
      generation,
      epoch,
      inFlight,
      activeOperation,
      lastErrorCode,
      isRecovering,
      vaultMeta,
      tabKnownLockEpoch,
      unlockBaseline,
      autoLockMinutes,
      lastActivityAt,
      minutesLeft,
      getClient,
      captureOpGeneration,
      beginOp,
      lock,
      lockNow,
      registerSecretFormReset,
      notifyVaultChanged,
      notifySettingsChanged,
      recordActivity,
      reloadVaultMeta,
      markResetPurged,
      clearError,
      createVaultOp,
      unlockPassphraseOp,
      unlockRecoveryOp,
      resumeRecoveryOp,
      confirmRecoveryOp,
      unlockPrfOp,
      unlockDevKeyOp,
      rewrapOp,
    ],
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const isLoopback =
      window.location?.hostname === '127.0.0.1' ||
      window.location?.hostname === 'localhost';
    if (process.env.NODE_ENV === 'production' && !isLoopback) return;
    const win = window as unknown as {
      __engramVaultTestBridge?: VaultContextValue;
      __engramQueryClient?: typeof queryClient;
    };
    // Expose live ref-derived getters on the test bridge so synchronous wake/lock transitions
    // are observable immediately on heavy pages before React's post-commit effect runs (VS-R7-1),
    // while React context consumers re-render via state updates.
    const bridge = Object.create(value) as VaultContextValue;
    Object.defineProperties(bridge, {
      state: {
        enumerable: true,
        get: () =>
          deriveVaultStateMachineMode({
            serverVaultStatus: serverVaultStatusRef.current,
            workerState: workerStateRef.current,
            activeOperation: activeOperationRef.current,
            baselineVerified: baselineVerifiedRef.current,
            wakeVerifying: wakeVerifyingCountRef.current > 0,
          }),
      },
      workerState: {
        enumerable: true,
        get: () => workerStateRef.current,
      },
      unlockBaseline: {
        enumerable: true,
        get: () => unlockBaselineRef.current,
      },
      tabKnownLockEpoch: {
        enumerable: true,
        get: () => tabKnownLockEpochRef.current,
      },
    });
    win.__engramVaultTestBridge = bridge;
    win.__engramQueryClient = queryClient;
    return () => {
      if (win.__engramVaultTestBridge === bridge) {
        delete win.__engramVaultTestBridge;
      }
    };
  }, [queryClient, value]);
  const [testConsumer, setTestConsumer] = useState<{
    host: HTMLElement;
    entryId: string;
    rowCount: number;
    onReady: (api: VaultTestConsumerApi) => void;
  } | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const isLoopback =
      window.location?.hostname === '127.0.0.1' ||
      window.location?.hostname === 'localhost';
    if (process.env.NODE_ENV === 'production' && !isLoopback) return;
    const win = window as unknown as {
      __engramMountVaultTestConsumer?: (
        host: HTMLElement,
        options: { entryId: string; rowCount: number },
      ) => Promise<VaultTestConsumerApi>;
    };
    const mount = (host: HTMLElement, options: { entryId: string; rowCount: number }) =>
      new Promise<VaultTestConsumerApi>((resolve) => {
        setTestConsumer({ host, entryId: options.entryId, rowCount: options.rowCount, onReady: resolve });
      });
    win.__engramMountVaultTestConsumer = mount;
    return () => {
      if (win.__engramMountVaultTestConsumer === mount) {
        delete win.__engramMountVaultTestConsumer;
      }
    };
  }, []);

  const subscribeStore = useCallback((listener: () => void) => {
    storeListenersRef.current.add(listener);
    return () => {
      storeListenersRef.current.delete(listener);
    };
  }, []);

  const getLiveStateSnapshot = useCallback(
    (): VaultStateMachineMode =>
      deriveVaultStateMachineMode({
        serverVaultStatus: serverVaultStatusRef.current,
        workerState: workerStateRef.current,
        activeOperation: activeOperationRef.current,
        baselineVerified: baselineVerifiedRef.current,
        wakeVerifying: wakeVerifyingCountRef.current > 0,
      }),
    [],
  );

  const storeValue = useMemo(
    () => ({
      value,
      subscribe: subscribeStore,
      getStateSnapshot: getLiveStateSnapshot,
    }),
    [getLiveStateSnapshot, subscribeStore, value],
  );

  return (
    <VaultContext.Provider value={storeValue}>
      {children}
      {testConsumer
        ? createPortal(
            <Suspense fallback={null}>
              <VaultTestConsumer
                entryId={testConsumer.entryId}
                rowCount={testConsumer.rowCount}
                onReady={testConsumer.onReady}
              />
            </Suspense>,
            testConsumer.host,
          )
        : null}
    </VaultContext.Provider>
  );
}

const noopSubscribe = () => () => {};
const defaultLockedSnapshot = (): VaultStateMachineMode => 'locked';

export function useVault(): VaultContextValue {
  const store = useContext(VaultContext);
  const liveState = useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getStateSnapshot : defaultLockedSnapshot,
    store ? store.getStateSnapshot : defaultLockedSnapshot,
  );
  if (!store) {
    throw new Error('useVault must be used within a VaultProvider');
  }
  return useMemo(
    () => (store.value.state === liveState ? store.value : { ...store.value, state: liveState }),
    [liveState, store.value],
  );
}

/** Optional hook for components that may render outside `VaultProvider` (e.g. standalone unit tests). */
export function useOptionalVault(): VaultContextValue | null {
  const store = useContext(VaultContext);
  const liveState = useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getStateSnapshot : defaultLockedSnapshot,
    store ? store.getStateSnapshot : defaultLockedSnapshot,
  );
  return useMemo(() => {
    if (!store) return null;
    return store.value.state === liveState ? store.value : { ...store.value, state: liveState };
  }, [liveState, store]);
}
