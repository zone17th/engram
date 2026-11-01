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
  const getClient = vault?.getClient;
  const captureOpGeneration = vault?.captureOpGeneration;
  const beginOp = vault?.beginOp;
  const vaultKeyId = vault?.vaultMeta?.vault_key_id ?? null;

  const viewportEnabled = options?.enabled ?? true;
  const queryEnabled = unlocked && viewportEnabled;
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
          if (!isCurrent()) {
            throw new Error('vault_locked_during_load');
          }
          return load(entryId, {
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
        // IP14-BE1-2 / IP14-FE1-11: Handoff to the authoritative version without resolving
        // plaintext under the obsolete version key, and remove the obsolete exact key immediately.
        const obsoleteKey = vaultBodyQueryKey(entryId, effectiveVersion);
        queryClient.setQueryData(vaultBodyQueryKey(entryId, discoveredVersion), body);
        setResolvedVersionOverride({
          entryId,
          fromVersion: initialVersion,
          toVersion: discoveredVersion,
        });
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
  const classifiedError =
    unlocked && query.status === 'error' && !isHandoffError
      ? classifyEntryOpenError(query.error)
      : null;
  const oldKey = classifiedError?.kind === 'old_key';
  // IP14-FE1-14: If an error occurs while the vault is currently unlocked (including a transient
  // stale_generation / vault_locked race), surface the Retry card rather than leaving a dead-end placeholder.
  const failed = unlocked && query.status === 'error' && !isHandoffError;
  const decryptFailed = classifiedError?.kind === 'decrypt_failed';

  const refetchRef = useRef(query.refetch);
  refetchRef.current = query.refetch;
  const refetch = useCallback(() => refetchRef.current(), []);

  return {
    unlocked,
    body: unlocked ? query.data : undefined,
    pending:
      unlocked &&
      query.data === undefined &&
      (query.status === 'pending' || query.isFetching || isHandoffError),
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
  const shouldRestoreFocusRef = useRef(false);

  const inViewport = useEntryInViewport(hostEl, {
    disabled: !lazy || enabled !== undefined,
  });
  const effectiveEnabled = enabled ?? inViewport;

  const { unlocked, body, pending, failed, oldKey, decryptFailed, errorKind, refetch } =
    useEntryBody(entryId, version, load, {
      enabled: effectiveEnabled,
      itemId,
      limiter,
    });

  useEffect(() => {
    if (!unlocked) {
      setRetryingFromError(false);
      shouldRestoreFocusRef.current = false;
      return;
    }
    if (errorKind && !oldKey) {
      setLastErrorKind(errorKind);
    }
    if (!pending && retryingFromError) {
      setRetryingFromError(false);
      if (shouldRestoreFocusRef.current) {
        shouldRestoreFocusRef.current = false;
        queueMicrotask(() => {
          if (failed && retryBtnRef.current) {
            retryBtnRef.current.focus();
          } else if (hostEl) {
            hostEl.focus();
          }
        });
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

  if (!effectiveEnabled) {
    // IP14-FE1-14: Off-screen / waiting cards render an inert skeleton (no role="status")
    // so a 200-entry item does not create 200 live regions announcing work that has not started.
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
        ref={setHostEl}
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
      ref={setHostEl}
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
