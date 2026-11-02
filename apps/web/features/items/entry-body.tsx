'use client';

import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  entryBodyLoadLimiter,
  type ConcurrencyLimiter,
} from '@/features/entries/concurrency-limiter';
import {
  classifyEntryOpenError,
  loadRealEntryBody,
  type EntryOpenErrorKind,
} from '@/features/entries/real-body-loader';
import { useOptionalVault, vaultBodyQueryKey } from '@/features/vault/vault-provider';
import type { CryptoClient } from '@/lib/crypto/client';
import { cn } from '@/lib/cn';

/** What a loader may use to turn stored data into the body text. `opGeneration` is captured before the first `await`. */
export interface EntryBodyLoadContext {
  client: CryptoClient;
  opGeneration: number;
  version?: number;
  itemId?: string;
  vaultKeyId?: string | null;
  isCurrent?: () => boolean;
  signal?: AbortSignal;
  queryClient?: QueryClient;
  onResolvedVersion?: (resolvedVersion: number) => void;
}

/**
 * Produces one entry's decrypted body. The Entries API is P04, so the loader is the seam: the P03 preview pages pass the
 * public demo loader, tests pass a loader that opens fixture ciphertext through the crypto client, and P04 passes the
 * real fetch + `client.openEntry` (`loadRealEntryBody`).
 */
export type EntryBodyLoader = (entryId: string, ctx: EntryBodyLoadContext) => Promise<string>;

export interface UseEntryBodyOptions {
  readonly enabled?: boolean;
  readonly itemId?: string;
  readonly limiter?: ConcurrencyLimiter;
}

export interface UseEntryBodyResult {
  readonly unlocked: boolean;
  readonly body: string | undefined;
  readonly pending: boolean;
  readonly activeLoading: boolean;
  readonly failed: boolean;
  readonly oldKey: boolean;
  readonly decryptFailed: boolean;
  readonly errorKind: EntryOpenErrorKind | null;
  readonly resolvedVersion: number | undefined;
  readonly refetch: () => Promise<unknown>;
}

/** The mask shown wherever a body would be. It never depends on the body, so it cannot leak its length or kind. */
export const LOCK_MASK_TEXT = '🔒 ••••••';

class VersionHandoffSignal extends Error {
  readonly discoveredVersion: number;

  constructor(discoveredVersion: number) {
    super('version_handoff');
    this.name = 'VersionHandoffSignal';
    this.discoveredVersion = discoveredVersion;
  }
}

function isVersionHandoffSignal(error: unknown): error is VersionHandoffSignal {
  return error instanceof VersionHandoffSignal;
}

type VersionHandoffListener = (discoveredVersion: number) => void;

const versionHandoffBus = new WeakMap<
  QueryClient,
  Map<string, Set<VersionHandoffListener>>
>();

function getHandoffChannelKey(entryId: string, fromVersion: number): string {
  return `${entryId}:${fromVersion}`;
}

function subscribeVersionHandoff(
  queryClient: QueryClient,
  entryId: string,
  fromVersion: number | undefined,
  listener: VersionHandoffListener,
): () => void {
  if (fromVersion === undefined) {
    return () => {};
  }
  let byChannel = versionHandoffBus.get(queryClient);
  if (!byChannel) {
    byChannel = new Map();
    versionHandoffBus.set(queryClient, byChannel);
  }
  const channelKey = getHandoffChannelKey(entryId, fromVersion);
  let listeners = byChannel.get(channelKey);
  if (!listeners) {
    listeners = new Set();
    byChannel.set(channelKey, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      byChannel.delete(channelKey);
    }
  };
}

function publishVersionHandoff(
  queryClient: QueryClient,
  entryId: string,
  fromVersion: number,
  toVersion: number,
): void {
  const byChannel = versionHandoffBus.get(queryClient);
  if (!byChannel) return;
  const listeners = byChannel.get(getHandoffChannelKey(entryId, fromVersion));
  if (!listeners) return;
  for (const listener of [...listeners]) {
    listener(toVersion);
  }
}

type SlotActivityListener = () => void;

const activeSlotBus = new WeakMap<
  QueryClient,
  {
    readonly counts: Map<string, number>;
    readonly listeners: Map<string, Set<SlotActivityListener>>;
  }
>();

function getActiveSlotKey(entryId: string, version: number | undefined): string {
  return version !== undefined ? `${entryId}:${version}` : entryId;
}

function ensureActiveSlotBus(queryClient: QueryClient) {
  let state = activeSlotBus.get(queryClient);
  if (!state) {
    state = {
      counts: new Map(),
      listeners: new Map(),
    };
    activeSlotBus.set(queryClient, state);
  }
  return state;
}

function isEntrySlotActive(
  queryClient: QueryClient,
  entryId: string,
  version: number | undefined,
): boolean {
  const state = activeSlotBus.get(queryClient);
  if (!state) return false;
  return (state.counts.get(getActiveSlotKey(entryId, version)) ?? 0) > 0;
}

function markEntrySlotActive(
  queryClient: QueryClient,
  entryId: string,
  version: number | undefined,
  active: boolean,
): void {
  const state = ensureActiveSlotBus(queryClient);
  const key = getActiveSlotKey(entryId, version);
  const prev = state.counts.get(key) ?? 0;
  const next = active ? prev + 1 : Math.max(0, prev - 1);
  if (next === prev) return;
  if (next === 0) {
    state.counts.delete(key);
  } else {
    state.counts.set(key, next);
  }
  const channelListeners = state.listeners.get(key);
  if (!channelListeners) return;
  for (const listener of [...channelListeners]) {
    listener();
  }
}

function subscribeEntrySlotActive(
  queryClient: QueryClient,
  entryId: string,
  version: number | undefined,
  listener: SlotActivityListener,
): () => void {
  const state = ensureActiveSlotBus(queryClient);
  const key = getActiveSlotKey(entryId, version);
  let channelListeners = state.listeners.get(key);
  if (!channelListeners) {
    channelListeners = new Set();
    state.listeners.set(key, channelListeners);
  }
  channelListeners.add(listener);
  return () => {
    channelListeners.delete(listener);
    if (channelListeners.size === 0) {
      state.listeners.delete(key);
    }
  };
}
/**
 * Tracks whether a DOM element has entered the viewport via `IntersectionObserver` (plan Task 14 item 5).
 * Once an element intersects the viewport, `inView` stays `true` so scrolling back and forth does not
 * tear down or re-decrypt already-visible cards while the vault remains unlocked.
 * Falls back to `true` in environments without `IntersectionObserver`.
 */
export function useEntryInViewport(
  target: HTMLElement | null,
  options?: { readonly disabled?: boolean; readonly rootMargin?: string },
): boolean {
  const disabled = options?.disabled === true;
  const rootMargin = options?.rootMargin ?? '100px';
  const [inView, setInView] = useState<boolean>(() => {
    if (disabled) return true;
    return typeof IntersectionObserver === 'undefined';
  });

  useEffect(() => {
    if (disabled) {
      setInView(true);
      return;
    }
    if (inView) {
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    if (!target) {
      return;
    }
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!active) return;
        for (const entry of entries) {
          if (entry.isIntersecting || entry.intersectionRatio > 0) {
            setInView(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin },
    );
    observer.observe(target);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [target, disabled, inView, rootMargin]);

  return disabled || inView;
}

/**
 * Decrypted body for one entry, or `undefined` while the vault is not unlocked.
 *
 * - The text lives ONLY in the TanStack Query cache under `vaultBodyQueryKey(entryId, version)` (or
 *   `vaultBodyQueryKey(entryId)` for P03 call sites that omit `version`); the provider removes that
 *   namespace synchronously on every lock, logout, user switch and reset.
 * - The query is enabled only while `useVault().state === 'unlocked'` AND `options.enabled !== false`
 *   (viewport gate), and the returned body is additionally gated on the live unlocked state, so a
 *   locked frame can never render a stale body even for one commit.
 * - Loads are bounded by a 4-slot concurrency limiter (`entryBodyLoadLimiter`, Task 14 item 4).
 * - A result that finishes after a lock (generation moved) is discarded instead of cached.
 */
export function useEntryBody(
  entryId: string,
  version: number | undefined,
  load: EntryBodyLoader,
  options?: UseEntryBodyOptions,
): UseEntryBodyResult;
export function useEntryBody(
  entryId: string,
  load: EntryBodyLoader,
  options?: UseEntryBodyOptions,
): UseEntryBodyResult;
export function useEntryBody(
  entryId: string,
  versionOrLoad: number | undefined | EntryBodyLoader,
  loadOrOptions?: EntryBodyLoader | UseEntryBodyOptions,
  maybeOptions?: UseEntryBodyOptions,
): UseEntryBodyResult {
  const isLegacyCall = typeof versionOrLoad === 'function';
  const initialVersion: number | undefined = isLegacyCall ? undefined : versionOrLoad;
  const load: EntryBodyLoader = isLegacyCall
    ? versionOrLoad
    : (loadOrOptions as EntryBodyLoader);
  const options: UseEntryBodyOptions | undefined = isLegacyCall
    ? (loadOrOptions as UseEntryBodyOptions | undefined)
    : maybeOptions;

  const [resolvedVersionOverride, setResolvedVersionOverride] = useState<{
    readonly entryId: string;
    readonly fromVersion: number | undefined;
    readonly toVersion: number;
  } | null>(null);

  const effectiveVersion =
    resolvedVersionOverride &&
    resolvedVersionOverride.entryId === entryId &&
    resolvedVersionOverride.fromVersion === initialVersion
      ? resolvedVersionOverride.toVersion
      : initialVersion;

  const vault = useOptionalVault();
  const queryClient = useQueryClient();
  const unlocked = vault?.state === 'unlocked';

  const [slotActive, setSlotActive] = useState<boolean>(() =>
    unlocked ? isEntrySlotActive(queryClient, entryId, effectiveVersion) : false,
  );

  useEffect(() => {
    if (!unlocked) {
      setSlotActive(false);
      return;
    }
    setSlotActive(isEntrySlotActive(queryClient, entryId, effectiveVersion));
    return subscribeEntrySlotActive(queryClient, entryId, effectiveVersion, () => {
      setSlotActive(isEntrySlotActive(queryClient, entryId, effectiveVersion));
    });
  }, [unlocked, queryClient, entryId, effectiveVersion]);
  useEffect(() => {
    if (!unlocked || initialVersion === undefined) {
      return;
    }
    return subscribeVersionHandoff(
      queryClient,
      entryId,
      initialVersion,
      (discoveredVersion) => {
        setResolvedVersionOverride({
          entryId,
          fromVersion: initialVersion,
          toVersion: discoveredVersion,
        });
      },
    );
  }, [unlocked, queryClient, entryId, initialVersion]);
  const getClient = vault?.getClient;
  const captureOpGeneration = vault?.captureOpGeneration;
  const beginOp = vault?.beginOp;
  const reloadVaultMeta = vault?.reloadVaultMeta;
  const vaultKeyId = vault?.vaultMeta?.vault_key_id ?? null;
  const hasValidVaultKeyId = typeof vaultKeyId === 'string' && vaultKeyId.length > 0;
  const usesRealVaultMeta = load === loadRealEntryBody;
  const viewportEnabled = options?.enabled ?? true;

  const [metaReloadError, setMetaReloadError] = useState<unknown>(null);
  const metaReloadAttemptedGenRef = useRef<number | null>(null);
  const mountedRef = useRef<boolean>(true);
  const unlockedRef = useRef<boolean>(unlocked);
  unlockedRef.current = unlocked;
  const captureOpGenerationRef = useRef(captureOpGeneration);
  captureOpGenerationRef.current = captureOpGeneration;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!unlocked) {
      setMetaReloadError(null);
      metaReloadAttemptedGenRef.current = null;
      return;
    }
    if (hasValidVaultKeyId) {
      setMetaReloadError(null);
      return;
    }
    if (!usesRealVaultMeta || !viewportEnabled) {
      return;
    }
    const currentGen =
      typeof captureOpGeneration === 'function' ? captureOpGeneration() : -1;
    if (metaReloadAttemptedGenRef.current === currentGen) {
      return;
    }
    metaReloadAttemptedGenRef.current = currentGen;
    if (typeof reloadVaultMeta !== 'function') {
      setMetaReloadError(new Error('vault_meta_unavailable'));
      return;
    }
    // IP15-FE5-2: Record the single reloadVaultMeta() attempt outcome independent of effect cleanup
    // when reloadVaultMeta changes identity mid-flight: apply a failure unless the component unmounted,
    // the vault locked, or the opGeneration changed.
    const isAttemptStillRelevant = () => {
      if (!mountedRef.current || !unlockedRef.current) return false;
      const latestGen =
        typeof captureOpGenerationRef.current === 'function'
          ? captureOpGenerationRef.current()
          : -1;
      return latestGen === currentGen;
    };
    void (async () => {
      try {
        const reloaded = await reloadVaultMeta();
        if (!isAttemptStillRelevant()) return;
        const nextKeyId = reloaded?.vault_key_id;
        if (typeof nextKeyId !== 'string' || nextKeyId.length === 0) {
          setMetaReloadError(new Error('vault_meta_unavailable'));
        }
      } catch (err) {
        if (!isAttemptStillRelevant()) return;
        setMetaReloadError(err);
      }
    })();
  }, [
    captureOpGeneration,
    hasValidVaultKeyId,
    reloadVaultMeta,
    unlocked,
    usesRealVaultMeta,
    viewportEnabled,
  ]);

  const queryEnabled =
    unlocked && viewportEnabled && (!usesRealVaultMeta || hasValidVaultKeyId);
  const limiter = options?.limiter ?? entryBodyLoadLimiter;
  const itemId = options?.itemId;
  const queryKey =
    effectiveVersion !== undefined
      ? vaultBodyQueryKey(entryId, effectiveVersion)
      : vaultBodyQueryKey(entryId);

  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      if (!getClient || !captureOpGeneration) {
        throw new Error('vault_unavailable');
      }
      const started = beginOp ? beginOp() : null;
      const opGeneration = started ? started.opGeneration : captureOpGeneration();
      const client = started ? started.client : getClient();
      const isCurrent = () => {
        if (started && !started.isCurrent()) return false;
        return client.getGeneration() === opGeneration;
      };

      let discoveredVersion: number | undefined;

      const body = await limiter.run(
        async () => {
          markEntrySlotActive(queryClient, entryId, effectiveVersion, true);
          try {
            if (!isCurrent()) {
              throw new Error('vault_locked_during_load');
            }
            return await load(entryId, {
              client,
              opGeneration,
              version: effectiveVersion,
              itemId,
              vaultKeyId,
              isCurrent,
              signal,
              queryClient,
              onResolvedVersion: (nextVer: number) => {
                discoveredVersion = nextVer;
              },
            });
          } finally {
            markEntrySlotActive(queryClient, entryId, effectiveVersion, false);
          }
        },
        { signal },
      );

      if (!isCurrent()) {
        throw new Error('vault_locked_during_load');
      }

      if (
        discoveredVersion !== undefined &&
        effectiveVersion !== undefined &&
        discoveredVersion !== effectiveVersion
      ) {
        // IP14-BE1-2 / IP14-FE1-11 / IP14-BE2-2: Handoff to the authoritative version without resolving
        // plaintext under the obsolete version key, notify EVERY mounted observer of `(entryId, effectiveVersion)`,
        // and remove the obsolete exact key immediately.
        const obsoleteKey = vaultBodyQueryKey(entryId, effectiveVersion);
        queryClient.setQueryData(vaultBodyQueryKey(entryId, discoveredVersion), body);
        setResolvedVersionOverride({
          entryId,
          fromVersion: initialVersion,
          toVersion: discoveredVersion,
        });
        if (initialVersion !== undefined && initialVersion !== effectiveVersion) {
          publishVersionHandoff(queryClient, entryId, initialVersion, discoveredVersion);
        }
        publishVersionHandoff(queryClient, entryId, effectiveVersion, discoveredVersion);
        queueMicrotask(() => {
          queryClient.removeQueries({ queryKey: obsoleteKey, exact: true });
        });
        throw new VersionHandoffSignal(discoveredVersion);
      }

      return body;
    },
    enabled: queryEnabled,
    retry: false,
    staleTime: Infinity,
    // Keep decrypted text in memory only as long as a view needs it; locking clears it earlier regardless.
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const isHandoffError = query.status === 'error' && isVersionHandoffSignal(query.error);
  const metaReloadFailed =
    unlocked &&
    usesRealVaultMeta &&
    !hasValidVaultKeyId &&
    query.data === undefined &&
    metaReloadError !== null;
  const classifiedError =
    unlocked && query.status === 'error' && !isHandoffError
      ? classifyEntryOpenError(query.error)
      : metaReloadFailed
        ? classifyEntryOpenError(metaReloadError)
        : null;
  const oldKey = classifiedError?.kind === 'old_key';
  // IP14-FE1-14 / IP15-FE4-3: If an error occurs while the vault is currently unlocked (including a transient
  // stale_generation / vault_locked race or a failed reloadVaultMeta() when vaultKeyId is null), surface the
  // Retry card rather than leaving an endless loading skeleton.
  const failed = (unlocked && query.status === 'error' && !isHandoffError) || metaReloadFailed;
  const decryptFailed = classifiedError?.kind === 'decrypt_failed';

  const refetchRef = useRef(query.refetch);
  refetchRef.current = query.refetch;
  const reloadVaultMetaRef = useRef(reloadVaultMeta);
  reloadVaultMetaRef.current = reloadVaultMeta;
  const usesRealVaultMetaRef = useRef(usesRealVaultMeta);
  usesRealVaultMetaRef.current = usesRealVaultMeta;
  const hasValidVaultKeyIdRef = useRef(hasValidVaultKeyId);
  hasValidVaultKeyIdRef.current = hasValidVaultKeyId;

  const refetch = useCallback(async () => {
    if (usesRealVaultMetaRef.current && !hasValidVaultKeyIdRef.current) {
      const reloadFn = reloadVaultMetaRef.current;
      if (typeof reloadFn !== 'function') {
        setMetaReloadError(new Error('vault_meta_unavailable'));
        return undefined;
      }
      setMetaReloadError(null);
      try {
        const reloaded = await reloadFn();
        const nextKeyId = reloaded?.vault_key_id;
        if (typeof nextKeyId !== 'string' || nextKeyId.length === 0) {
          setMetaReloadError(new Error('vault_meta_unavailable'));
          return undefined;
        }
      } catch (err) {
        setMetaReloadError(err);
        return undefined;
      }
    }
    return refetchRef.current();
  }, []);

  const pending =
    unlocked &&
    !metaReloadFailed &&
    query.data === undefined &&
    (query.status === 'pending' || query.isFetching || isHandoffError);

  return {
    unlocked,
    body: unlocked ? query.data : undefined,
    pending,
    activeLoading: pending && (slotActive || isHandoffError),
    failed,
    oldKey,
    decryptFailed,
    errorKind: classifiedError?.kind ?? null,
    resolvedVersion: effectiveVersion,
    refetch,
  };
}

/** `🔒 ••••••` block (mockups `.lock-veil`). No plaintext, no `data-*` carrying content. */
export function LockMask({ className, testId = 'entry-body-locked' }: { className?: string; testId?: string }) {
  const t = useTranslations('vault.locked');
  return (
    <div className={cn('lock-veil', className)} data-testid={testId} data-vault-body="locked">
      <span aria-hidden="true">{LOCK_MASK_TEXT}</span>
      <span className="sr-only">{t('maskLabel')}</span>
    </div>
  );
}

/**
 * One entry body.
 * - Locked (or unlocking, recovering, error, no provider): `LockMask`.
 * - Unlocked + not yet in viewport: lightweight placeholder (`entry-body-loading`) with `IntersectionObserver`
 *   that enables `useEntryBody` once scrolled into view (plan Task 14 item 5).
 * - Unlocked + `oldKey`: warning state (`entry-body-old-key`) without Retry, Worker `openEntry` never called.
 * - Unlocked + `decryptFailed` / `failed`: error state (`entry-body-error`) with a working Retry button (`entry-body-retry`).
 * - Unlocked + decrypted: rendered only as a React text node (never an attribute, never `dataset`, never `innerHTML`).
 */
export function EntryBody({
  entryId,
  version,
  itemId,
  load,
  enabled,
  lazy = true,
  limiter,
  variant = 'full',
  kind = 'text',
  className,
}: {
  entryId: string;
  version?: number;
  itemId?: string;
  load: EntryBodyLoader;
  enabled?: boolean;
  lazy?: boolean;
  limiter?: ConcurrencyLimiter;
  variant?: 'summary' | 'full';
  kind?: 'text' | 'json';
  className?: string;
}) {
  const tEntry = useTranslations('content.entry');
  const titleId = useId();
  const [hostEl, setHostEl] = useState<HTMLElement | null>(null);
  const [retryingFromError, setRetryingFromError] = useState(false);
  const [lastErrorKind, setLastErrorKind] = useState<EntryOpenErrorKind | null>(null);
  const errorContainerRef = useRef<HTMLDivElement | null>(null);
  const retryBtnRef = useRef<HTMLButtonElement | null>(null);
  const bodyNodeRef = useRef<HTMLElement | null>(null);
  const shouldRestoreFocusRef = useRef(false);
  const pointerClickedOutsideCardRef = useRef(false);

  const inViewport = useEntryInViewport(hostEl, {
    disabled: !lazy || enabled !== undefined,
  });
  const effectiveEnabled = enabled ?? inViewport;

  const {
    unlocked,
    body,
    pending,
    activeLoading,
    failed,
    oldKey,
    decryptFailed,
    errorKind,
    refetch,
  } = useEntryBody(entryId, version, load, {
    enabled: effectiveEnabled,
    itemId,
    limiter,
  });

  useEffect(() => {
    if (!retryingFromError || !pending || typeof document === 'undefined') {
      return;
    }
    const onPointerDownCapture = (e: Event) => {
      const target = e.target;
      if (
        target instanceof Node &&
        errorContainerRef.current &&
        !errorContainerRef.current.contains(target)
      ) {
        pointerClickedOutsideCardRef.current = true;
        shouldRestoreFocusRef.current = false;
      }
    };
    document.addEventListener('pointerdown', onPointerDownCapture, true);
    document.addEventListener('mousedown', onPointerDownCapture, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDownCapture, true);
      document.removeEventListener('mousedown', onPointerDownCapture, true);
    };
  }, [retryingFromError, pending]);

  useEffect(() => {
    if (!unlocked) {
      setRetryingFromError(false);
      shouldRestoreFocusRef.current = false;
      pointerClickedOutsideCardRef.current = false;
      return;
    }
    if (errorKind && !oldKey) {
      setLastErrorKind(errorKind);
    }
    if (!pending && retryingFromError) {
      setRetryingFromError(false);
      const hadPointerOutside = pointerClickedOutsideCardRef.current;
      pointerClickedOutsideCardRef.current = false;
      if (shouldRestoreFocusRef.current && !hadPointerOutside) {
        shouldRestoreFocusRef.current = false;
        const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
        const canRestoreFocus =
          activeEl === document.body ||
          (errorContainerRef.current !== null && errorContainerRef.current.contains(activeEl)) ||
          (bodyNodeRef.current !== null && bodyNodeRef.current.contains(activeEl)) ||
          (hostEl !== null && hostEl.contains(activeEl));
        if (canRestoreFocus) {
          if (failed && retryBtnRef.current) {
            retryBtnRef.current.focus();
          } else if (bodyNodeRef.current) {
            bodyNodeRef.current.focus();
          } else if (hostEl) {
            hostEl.focus();
          }
        }
      } else {
        shouldRestoreFocusRef.current = false;
      }
    }
  }, [unlocked, pending, failed, oldKey, errorKind, retryingFromError, hostEl]);

  if (!unlocked) return <LockMask className={className} />;

  if (oldKey) {
    return (
      <div
        ref={setHostEl}
        className={cn(
          'rounded-md border border-line bg-surface p-3 flex flex-col gap-1',
          className,
        )}
        role="alert"
        data-testid="entry-body-old-key"
      >
        <span className="badge-type badge-json self-start">{tEntry('oldKeyBadge')}</span>
        <p className="m-0 text-[14px] font-semibold text-body">{tEntry('oldKeyTitle')}</p>
        <p className="m-0 text-[13px] text-muted">{tEntry('oldKeyBody')}</p>
      </div>
    );
  }

  if (failed || (retryingFromError && pending)) {
    const activeKind = errorKind ?? lastErrorKind ?? (decryptFailed ? 'decrypt_failed' : 'other');
    const errorTitle =
      activeKind === 'decrypt_failed'
        ? tEntry('decryptFailedTitle')
        : activeKind === 'network'
          ? tEntry('networkFailedTitle')
          : activeKind === 'not_found'
            ? tEntry('notFoundTitle')
            : tEntry('loadFailedTitle');
    const errorBody =
      activeKind === 'decrypt_failed'
        ? tEntry('decryptFailedBody')
        : activeKind === 'network'
          ? tEntry('networkFailedBody')
          : activeKind === 'not_found'
            ? tEntry('notFoundBody')
            : tEntry('loadFailedBody');

    return (
      <div
        ref={(node) => {
          errorContainerRef.current = node;
          setHostEl(node);
        }}
        tabIndex={-1}
        aria-busy={retryingFromError && pending ? 'true' : undefined}
        onBlur={(e) => {
          if (!shouldRestoreFocusRef.current) return;
          const nextTarget = e.relatedTarget;
          if (nextTarget instanceof Node && !e.currentTarget.contains(nextTarget)) {
            shouldRestoreFocusRef.current = false;
          }
        }}
        className={cn('flex flex-wrap items-center justify-between gap-2', className)}
        role="alert"
        data-testid="entry-body-error"
      >
        <div className="min-w-0">
          <p id={titleId} className="t-caption m-0 font-semibold text-body">
            {errorTitle}
          </p>
          <p className="t-caption m-0 text-muted">
            {retryingFromError && pending ? tEntry('loading') : errorBody}
          </p>
        </div>
        <button
          ref={retryBtnRef}
          type="button"
          disabled={retryingFromError && pending}
          aria-describedby={titleId}
          className="btn btn-secondary btn-sm shrink-0"
          data-testid="entry-body-retry"
          onClick={() => {
            pointerClickedOutsideCardRef.current = false;
            shouldRestoreFocusRef.current = true;
            setRetryingFromError(true);
            errorContainerRef.current?.focus();
            void refetch();
          }}
        >
          {tEntry('retry')}
        </button>
      </div>
    );
  }

  if (!effectiveEnabled || ((pending || body === undefined) && !activeLoading)) {
    // IP14-FE1-14: Off-screen cards and enabled cards queued behind the concurrency limiter
    // (not yet holding a slot) render an inert skeleton (no role="status") so only cards
    // actively holding a slot announce loading.
    return (
      <p
        ref={setHostEl}
        aria-hidden="true"
        className={cn('t-caption m-0 text-muted', className)}
        data-testid="entry-body-loading"
      >
        {tEntry('loading')}
      </p>
    );
  }

  if (pending || body === undefined) {
    return (
      <p
        ref={setHostEl}
        className={cn('t-caption m-0 text-muted', className)}
        role="status"
        data-testid="entry-body-loading"
      >
        {tEntry('loading')}
      </p>
    );
  }

  if (kind === 'json' && variant === 'full') {
    return (
      <pre
        ref={(node) => {
          bodyNodeRef.current = node;
          setHostEl(node);
        }}
        tabIndex={-1}
        className={cn('json-raw overflow-x-auto rounded-md', className)}
        data-testid="entry-body"
      >
        {body}
      </pre>
    );
  }

  return (
    <p
      ref={(node) => {
        bodyNodeRef.current = node;
        setHostEl(node);
      }}
      tabIndex={-1}
      className={cn(
        variant === 'summary' ? 't-legal text-muted' : 'm-0 text-[15px] leading-relaxed text-body',
        className,
      )}
      data-testid="entry-body"
    >
      {body}
    </p>
  );
}
