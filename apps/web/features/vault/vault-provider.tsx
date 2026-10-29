'use client';

import { ProblemError } from '@engram/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useSession } from '@/features/auth/session-provider';
import {
  postVaultBroadcast,
  subscribeVaultBroadcast,
  type VaultBroadcastMessage,
} from '@/features/vault/broadcast';
import {
  captureUnlockBaseline,
  recordLockEpochEvent,
  verifyUnlockBaseline,
  type LockEpochEnvironment,
  type LockEpochMarker,
} from '@/features/vault/lock-epoch';
import { fetchVault, type VaultState } from '@/lib/api/vault';
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
  /** Reloads `GET /vault` from the server and reconciles `vault_key_id` (locks immediately on 404 or `vault_key_id` mismatch). */
  reloadVaultMeta: () => Promise<VaultState | null>;
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

const VaultContext = createContext<VaultContextValue | null>(null);

export interface VaultProviderProps {
  children: ReactNode;
  /** Optional custom Worker factory (used in unit tests with `createWorkerShim`; defaults to real `worker.ts`). */
  createWorker?: () => CryptoWorkerPort;
  /** Optional custom IndexedDB / Web Locks environment for unit tests. */
  lockEpochEnv?: LockEpochEnvironment;
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
      'input[type="password"], input[data-vault-secret], textarea[data-vault-secret]',
    );
    inputs.forEach((el) => {
      el.value = '';
    });
  } catch {
    // Ignore DOM traversal errors
  }
}

export function deriveVaultStateMachineMode(input: {
  serverVaultStatus: 'absent' | 'present';
  workerState: VaultClientState;
  activeOperation: VaultActiveOperation;
}): VaultStateMachineMode {
  const { serverVaultStatus, workerState, activeOperation } = input;

  // Worker error or recovering state is authoritative over sub-states
  if (workerState === 'error') return 'error';
  if (workerState === 'recovering') return 'recovering';

  if (workerState === 'unlocked') {
    if (activeOperation === 'rewrapping') return 'rewrapping';
    if (activeOperation === 'resetting') return 'resetting';
    return 'unlocked';
  }

  // workerState === 'locked'
  if (serverVaultStatus === 'absent') {
    if (activeOperation === 'onboarding') return 'onboarding';
    return 'no_vault';
  }

  // serverVaultStatus === 'present' && workerState === 'locked'
  if (activeOperation === 'unlocking') return 'unlocking';
  if (activeOperation === 'resetting') return 'resetting';
  return 'locked';
}

export function VaultProvider({
  children,
  createWorker,
  lockEpochEnv,
}: VaultProviderProps) {
  const queryClient = useQueryClient();
  const { me, status: sessionStatus } = useSession();

  const [workerState, setWorkerState] = useState<VaultClientState>('locked');
  const [generation, setGeneration] = useState<number>(0);
  const [epoch, setEpoch] = useState<number>(-1);
  const [inFlightCount, setInFlightCount] = useState<number>(0);
  const [activeOperation, setActiveOperation] = useState<VaultActiveOperation>(null);
  const [lastErrorCode, setLastErrorCode] = useState<CryptoClientErrorCode | null>(null);
  const [vaultMeta, setVaultMeta] = useState<VaultState | null>(null);
  const [tabKnownLockEpoch, setTabKnownLockEpoch] = useState<number>(0);
  const [unlockBaseline, setUnlockBaseline] = useState<LockEpochMarker | null>(null);

  const clientRef = useRef<CryptoClient | null>(null);
  const workerStateRef = useRef<VaultClientState>('locked');
  const tabKnownLockEpochRef = useRef<number>(0);
  const unlockBaselineRef = useRef<LockEpochMarker | null>(null);
  const currentVaultKeyIdRef = useRef<string | null>(null);
  const previousUserIdRef = useRef<string | null>(null);
  const secretFormResettersRef = useRef<Set<() => void>>(new Set());

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
        createWorker,
        onStateChange: (nextState, nextGen) => {
          workerStateRef.current = nextState;
          setWorkerState(nextState);
          setGeneration(nextGen);
          setEpoch(instance.getEpoch());
          if (nextState === 'locked' || nextState === 'error') {
            unlockBaselineRef.current = null;
            setUnlockBaseline(null);
            setActiveOperation(null);
            clearPlaintextAndFormsSync();
          }
        },
      });
      clientRef.current = instance;
    }
    return clientRef.current;
  }, [clearPlaintextAndFormsSync, createWorker]);

  const envWithBroadcast = useMemo<LockEpochEnvironment>(
    () => ({
      ...lockEpochEnv,
      onBroadcastLock: (nextLockEpoch: number) => {
        updateTabKnownLockEpoch(nextLockEpoch);
        lockEpochEnv?.onBroadcastLock?.(nextLockEpoch);
        postVaultBroadcast({ type: 'lock', lockEpoch: nextLockEpoch });
      },
    }),
    [lockEpochEnv, updateTabKnownLockEpoch],
  );

  /**
   * Local lock execution (used when receiving a remote `lock` broadcast or wake fail-closed):
   * synchronously clears cache + forms and invokes `client.lock()` without re-writing `lockEpoch`.
   */
  const lockLocalOnly = useCallback((): Promise<LockResult> => {
    unlockBaselineRef.current = null;
    setUnlockBaseline(null);
    setActiveOperation(null);
    clearPlaintextAndFormsSync();
    const client = getClient();
    const lockPromise = client.lock();
    setGeneration(client.getGeneration());
    setEpoch(client.getEpoch());
    return lockPromise;
  }, [clearPlaintextAndFormsSync, getClient]);

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

      if (shouldBroadcast) {
        // Immediate wake notification before acquiring the Web Lock (ADR 0003 §8.3)
        postVaultBroadcast({
          type: 'lock',
          lockEpoch: tabKnownLockEpochRef.current + 1,
        });
        void recordLockEpochEvent(tabKnownLockEpochRef.current, envWithBroadcast).then(
          (res) => {
            updateTabKnownLockEpoch(res.lockEpoch);
          },
        );
      }

      return lockPromise;
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
    return {
      opGeneration,
      client,
      isCurrent: () => client.getGeneration() === opGeneration,
    };
  }, [getClient]);

  const clearError = useCallback(() => {
    setLastErrorCode(null);
  }, []);

  /**
   * Reloads `GET /vault` from the server.
   * Per plan §2.6 and ADR 0003 §8:
   * - If `404 vault_absent` or `vault_key_id` differs from the tab's known `vault_key_id`, locks immediately.
   * - If `vault_key_id` matches and `version` increased, updates `vaultMeta` for future operations without
   *   overwriting any in-flight mutation's captured `If-Match`.
   */
  const reloadVaultMeta = useCallback(async (): Promise<VaultState | null> => {
    try {
      const fresh = await fetchVault();
      const prevKeyId = currentVaultKeyIdRef.current;
      if (prevKeyId && fresh.vault_key_id !== prevKeyId) {
        currentVaultKeyIdRef.current = fresh.vault_key_id;
        setVaultMeta(fresh);
        queryClient.setQueryData(VAULT_META_QUERY_KEY_PREFIX, fresh);
        void lock({ broadcast: false, reason: 'vault_key_id_changed' });
        return fresh;
      }
      currentVaultKeyIdRef.current = fresh.vault_key_id;
      setVaultMeta(fresh);
      queryClient.setQueryData(VAULT_META_QUERY_KEY_PREFIX, fresh);
      return fresh;
    } catch (err) {
      if (
        err instanceof ProblemError &&
        (err.problem.status === 404 || err.problem.code === 'vault_absent')
      ) {
        currentVaultKeyIdRef.current = null;
        setVaultMeta(null);
        queryClient.removeQueries({ queryKey: VAULT_META_QUERY_KEY_PREFIX });
        void lock({ broadcast: false, reason: 'vault_absent' });
        return null;
      }
      throw err;
    }
  }, [lock, queryClient]);

  const notifyVaultChanged = useCallback(
    (payload: { vault_key_id: string; version: number | null }) => {
      if (payload.version === null) {
        currentVaultKeyIdRef.current = null;
        setVaultMeta(null);
        queryClient.removeQueries({ queryKey: VAULT_META_QUERY_KEY_PREFIX });
      } else {
        currentVaultKeyIdRef.current = payload.vault_key_id;
        setVaultMeta((prev) =>
          prev && prev.vault_key_id === payload.vault_key_id
            ? { ...prev, version: payload.version ?? prev.version }
            : prev,
        );
      }
      postVaultBroadcast({
        type: 'vault_changed',
        vault_key_id: payload.vault_key_id,
        version: payload.version,
      });
    },
    [queryClient],
  );

  /**
   * Executes a state-changing CryptoClient call with `inFlight` tracking, `activeOperation` sub-state,
   * and `unlockBaseline` capture/verification for unlock/createVault transitions (ADR 0003 §8.4).
   */
  const runStateChangingOp = useCallback(
    async <T,>(
      opKind: VaultActiveOperation,
      requiresUnlockBaseline: boolean,
      opGeneration: number,
      invoke: (client: CryptoClient, injectBeforePost?: () => Promise<void>) => Promise<T>,
    ): Promise<T> => {
      const client = getClient();
      setLastErrorCode(null);
      setInFlightCount((c) => c + 1);
      if (opKind) {
        setActiveOperation(opKind);
      }

      let capturedBaseline: LockEpochMarker | null = null;
      const prepareBaseline = async () => {
        if (!requiresUnlockBaseline) return;
        const baseline = await captureUnlockBaseline(
          tabKnownLockEpochRef.current,
          envWithBroadcast,
        );
        if (!baseline) {
          // Fail closed if IndexedDB or Web Locks is unreadable/blocked during unlock baseline capture
          void lock({ broadcast: false, reason: 'baseline_unreadable' });
          throw new CryptoClientError(
            'STALE_GENERATION',
            'Failed to capture authoritative lockEpoch baseline; failing closed',
          );
        }
        capturedBaseline = baseline;
        unlockBaselineRef.current = baseline;
        updateTabKnownLockEpoch(baseline.lockEpoch);
      };

      try {
        const result = await invoke(client, prepareBaseline);

        if (requiresUnlockBaseline) {
          const verification = await verifyUnlockBaseline(capturedBaseline, envWithBroadcast);
          if (verification.persistedMarker) {
            updateTabKnownLockEpoch(verification.persistedMarker.lockEpoch);
          }
          if (!verification.matches || client.getGeneration() !== opGeneration) {
            void lock({ broadcast: false, reason: 'baseline_mismatch_after_unlock' });
            throw new CryptoClientError(
              'STALE_GENERATION',
              'Authoritative lockEpoch changed during unlock; failing closed',
            );
          }
          unlockBaselineRef.current = capturedBaseline;
          setUnlockBaseline(capturedBaseline);
        }

        setGeneration(client.getGeneration());
        setEpoch(client.getEpoch());
        return result;
      } catch (err) {
        const classified = classifyCryptoError(err);
        if (classified.code) {
          setLastErrorCode(classified.code);
        }
        setGeneration(client.getGeneration());
        setEpoch(client.getEpoch());
        throw err;
      } finally {
        setInFlightCount((c) => Math.max(0, c - 1));
        setActiveOperation((current) => (current === opKind ? null : current));
      }
    },
    [envWithBroadcast, getClient, lock, updateTabKnownLockEpoch],
  );

  const createVaultOp = useCallback(
    (params: CreateVaultClientParams): Promise<CreateVaultResult> => {
      return runStateChangingOp(
        'onboarding',
        true,
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
        true,
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
        false,
        params.opGeneration,
        (client) => client.unlockRecovery(params),
      );
    },
    [runStateChangingOp],
  );

  const resumeRecoveryOp = useCallback(
    (params: ResumeRecoveryClientParams): Promise<ResumeRecoveryResult> => {
      return runStateChangingOp('unlocking', false, params.opGeneration, (client) =>
        client.resumeRecovery(params),
      );
    },
    [runStateChangingOp],
  );

  const confirmRecoveryOp = useCallback(
    (params: ConfirmRecoveryClientParams): Promise<ConfirmRecoveryResult> => {
      return runStateChangingOp(
        'rewrapping',
        true,
        params.opGeneration,
        (client, prepareBaseline) =>
          client.confirmRecovery({
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

  const unlockPrfOp = useCallback(
    (params: UnlockPrfClientParams): Promise<{ unlocked: true }> => {
      return runStateChangingOp(
        'unlocking',
        true,
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
        true,
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
      return runStateChangingOp('rewrapping', false, params.opGeneration, (client) =>
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
        previousUserIdRef.current = null;
        currentVaultKeyIdRef.current = null;
        setVaultMeta(null);
        queryClient.removeQueries({ queryKey: VAULT_META_QUERY_KEY_PREFIX });
        void lock({ broadcast: true, reason: 'signed_out' });
      }
      return;
    }

    if (nextUserId && prevUserId && nextUserId !== prevUserId) {
      // Account switch in the same tab: wipe VK/plaintext + vault metadata immediately
      previousUserIdRef.current = nextUserId;
      currentVaultKeyIdRef.current = null;
      setVaultMeta(null);
      queryClient.removeQueries({ queryKey: VAULT_META_QUERY_KEY_PREFIX });
      void lock({ broadcast: true, reason: 'user_changed' });
      return;
    }

    if (nextUserId) {
      previousUserIdRef.current = nextUserId;
    }
  }, [lock, me?.user.id, queryClient, sessionStatus, vaultMeta]);

  // Subscribe to BroadcastChannel('sabk.vault') for `lock` and `vault_changed` (Task 15A #5).
  useEffect(() => {
    return subscribeVaultBroadcast((message: VaultBroadcastMessage, origin) => {
      if (origin === 'local') return;

      if (message.type === 'lock') {
        updateTabKnownLockEpoch(message.lockEpoch);
        void lockLocalOnly();
        return;
      }

      if (message.type === 'vault_changed') {
        const knownKeyId = currentVaultKeyIdRef.current;
        if (
          message.version === null ||
          (knownKeyId !== null && message.vault_key_id !== knownKeyId)
        ) {
          currentVaultKeyIdRef.current =
            message.version === null ? null : message.vault_key_id;
          setVaultMeta(null);
          queryClient.removeQueries({ queryKey: VAULT_META_QUERY_KEY_PREFIX });
          void lockLocalOnly();
          void reloadVaultMeta().catch(() => undefined);
          return;
        }
        void reloadVaultMeta().catch(() => undefined);
      }
    });
  }, [lockLocalOnly, queryClient, reloadVaultMeta, updateTabKnownLockEpoch]);

  // Wake / resume / visibilitychange / pageshow / focus / popstate fail-closed check (ADR 0003 §8.4, Task 15A #3 & #6).
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const verifyLockEpochOnWake = async () => {
      if (
        workerStateRef.current !== 'unlocked' &&
        workerStateRef.current !== 'recovering'
      ) {
        return;
      }
      const baseline = unlockBaselineRef.current;
      const result = await verifyUnlockBaseline(baseline, envWithBroadcast);
      if (result.persistedMarker) {
        updateTabKnownLockEpoch(result.persistedMarker.lockEpoch);
      }
      if (!result.matches) {
        void lockLocalOnly();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void verifyLockEpochOnWake();
      }
    };

    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && workerStateRef.current === 'locked') {
        clearPlaintextAndFormsSync();
      }
      void verifyLockEpochOnWake();
    };

    const onFocusOrResume = () => {
      void verifyLockEpochOnWake();
    };

    const onPopState = () => {
      // History Back after lock must never revive or show cached plaintext (Task 15A #3).
      if (workerStateRef.current !== 'unlocked') {
        clearPlaintextAndFormsSync();
      } else {
        void verifyLockEpochOnWake();
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
  }, [clearPlaintextAndFormsSync, envWithBroadcast, lockLocalOnly, updateTabKnownLockEpoch]);

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

  const state: VaultStateMachineMode = useMemo(
    () =>
      deriveVaultStateMachineMode({
        serverVaultStatus,
        workerState,
        activeOperation,
      }),
    [serverVaultStatus, workerState, activeOperation],
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
      getClient,
      captureOpGeneration,
      beginOp,
      lock,
      lockNow,
      registerSecretFormReset,
      notifyVaultChanged,
      reloadVaultMeta,
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
      getClient,
      captureOpGeneration,
      beginOp,
      lock,
      lockNow,
      registerSecretFormReset,
      notifyVaultChanged,
      reloadVaultMeta,
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
    if (typeof window === 'undefined' || process.env.NODE_ENV === 'production') return;
    const win = window as unknown as {
      __engramVaultTestBridge?: VaultContextValue;
      __engramQueryClient?: typeof queryClient;
    };
    win.__engramVaultTestBridge = value;
    win.__engramQueryClient = queryClient;
    return () => {
      if (win.__engramVaultTestBridge === value) {
        delete win.__engramVaultTestBridge;
      }
    };
  }, [queryClient, value]);

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) {
    throw new Error('useVault must be used within a VaultProvider');
  }
  return ctx;
}

/** Optional hook for components that may render outside `VaultProvider` (e.g. standalone unit tests). */
export function useOptionalVault(): VaultContextValue | null {
  return useContext(VaultContext);
}
