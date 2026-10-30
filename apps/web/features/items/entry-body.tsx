'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useOptionalVault, vaultBodyQueryKey } from '@/features/vault/vault-provider';
import type { CryptoClient } from '@/lib/crypto/client';
import { cn } from '@/lib/cn';

/** What a loader may use to turn stored data into the body text. `opGeneration` is captured before the first `await`. */
export interface EntryBodyLoadContext {
  client: CryptoClient;
  opGeneration: number;
}

/**
 * Produces one entry's decrypted body. The Entries API is P04, so the loader is the seam: the P03 preview pages pass the
 * public demo loader, tests pass a loader that opens fixture ciphertext through the crypto client, and P04 will pass the
 * real fetch + `client.openEntry`.
 */
export type EntryBodyLoader = (entryId: string, ctx: EntryBodyLoadContext) => Promise<string>;

/** The mask shown wherever a body would be. It never depends on the body, so it cannot leak its length or kind. */
export const LOCK_MASK_TEXT = '🔒 ••••••';

/**
 * Decrypted body for one entry, or `undefined` while the vault is not unlocked.
 *
 * - The text lives ONLY in the TanStack Query cache under `vaultBodyQueryKey(entryId)`; the provider removes that
 *   namespace synchronously on every lock, logout, user switch and reset.
 * - The query is enabled only while `useVault().state === 'unlocked'`, and the returned body is additionally gated on
 *   the same live state, so a locked frame can never render a stale body even for one commit.
 * - A result that finishes after a lock (generation moved) is discarded instead of cached.
 */
export function useEntryBody(
  entryId: string,
  load: EntryBodyLoader,
): { unlocked: boolean; body: string | undefined; pending: boolean; failed: boolean } {
  const vault = useOptionalVault();
  const unlocked = vault?.state === 'unlocked';
  const getClient = vault?.getClient;
  const captureOpGeneration = vault?.captureOpGeneration;

  const query = useQuery({
    queryKey: vaultBodyQueryKey(entryId),
    queryFn: async () => {
      if (!getClient || !captureOpGeneration) throw new Error('vault_unavailable');
      const opGeneration = captureOpGeneration();
      const client = getClient();
      const body = await load(entryId, { client, opGeneration });
      if (client.getGeneration() !== opGeneration) throw new Error('vault_locked_during_load');
      return body;
    },
    enabled: unlocked,
    retry: false,
    staleTime: Infinity,
    // Keep decrypted text in memory only as long as a view needs it; locking clears it earlier regardless.
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  return {
    unlocked,
    body: unlocked ? query.data : undefined,
    pending: unlocked && query.data === undefined && query.status === 'pending',
    failed: unlocked && query.status === 'error',
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
 * One entry body. Locked (or unlocking, recovering, error, no provider): `LockMask`. Unlocked: the decrypted text,
 * rendered only as a React text node (never an attribute, never `dataset`, never `innerHTML`).
 */
export function EntryBody({
  entryId,
  load,
  variant = 'full',
  kind = 'text',
  className,
}: {
  entryId: string;
  load: EntryBodyLoader;
  variant?: 'summary' | 'full';
  kind?: 'text' | 'json';
  className?: string;
}) {
  const t = useTranslations('vault.locked');
  const { unlocked, body, pending, failed } = useEntryBody(entryId, load);

  if (!unlocked) return <LockMask className={className} />;
  if (failed) {
    return (
      <p className={cn('t-caption m-0 text-muted', className)} role="alert" data-testid="entry-body-error">
        {t('bodyError')}
      </p>
    );
  }
  if (pending || body === undefined) {
    return (
      <p className={cn('t-caption m-0 text-muted', className)} role="status" data-testid="entry-body-loading">
        {t('bodyLoading')}
      </p>
    );
  }
  if (kind === 'json' && variant === 'full') {
    return (
      <pre className={cn('json-raw overflow-x-auto rounded-md', className)} data-testid="entry-body">
        {body}
      </pre>
    );
  }
  return (
    <p
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
