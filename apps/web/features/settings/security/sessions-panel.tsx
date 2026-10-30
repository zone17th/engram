'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { AuthStatus } from '@/components/ui/field';
import { listAudit, listNotifications, listSessions, markNotificationRead, revokeSession } from '@/lib/api/auth';
import {
  eventMessageKey,
  metaFieldKey,
  metaProviderKey,
  metaReasonKey,
  noticeKindKey,
  resultMessageKey,
  sanitizeAuditMeta,
} from '@/lib/auth/audit-catalog';
import { useSession } from '@/features/auth/session-provider';
import { VaultSecurityPanel } from '@/features/settings/security/vault/vault-security-panel';
import { PasskeySecurityCard } from '@/features/settings/security/passkey-card';

function formatRelative(iso: string, locale: string): string {
  try {
    const date = new Date(iso);
    const diff = Date.now() - date.getTime();
    const hours = Math.floor(diff / 3_600_000);
    if (hours < 1) return locale === 'vi' ? 'vừa xong' : 'just now';
    if (hours < 48) return locale === 'vi' ? `${hours} giờ trước` : `${hours}h ago`;
    return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-US').format(date);
  } catch {
    return iso;
  }
}

export function SessionsPanel({ onOpenRevokeDialog }: { onOpenRevokeDialog: () => void }) {
  const t = useTranslations('settings');
  const { me, sessionEpoch, signOut } = useSession();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [mutationErrorId, setMutationErrorId] = useState<string | null>(null);

  const sessions = useQuery({
    queryKey: ['auth', 'sessions', sessionEpoch],
    queryFn: () => listSessions(),
    enabled: !!me,
  });

  const revokeOne = async (id: string, current: boolean) => {
    if (pendingId) return;
    setMutationErrorId(null);
    setPendingId(id);
    try {
      await revokeSession(id);
      if (current) {
        await signOut('revoked');
        return;
      }
      const result = await sessions.refetch();
      if (result.isError) throw result.error ?? new Error('session_refetch_failed');
    } catch {
      setMutationErrorId(id);
    } finally {
      setPendingId(null);
    }
  };

  const others = sessions.data?.items.filter((session) => !session.current) ?? [];

  return (
    <div className="card mb-3 p-5">
      <div className="mb-4 flex items-center gap-4">
        <div className="text-[15px] font-semibold">{t('security.sessionsTitle')}</div>
        <Button variant="tertiary" size="sm" className="ml-auto" onClick={onOpenRevokeDialog} disabled={others.length === 0}>
          {t('security.revokeOthers')}
        </Button>
      </div>

      {sessions.isLoading && <AuthStatus tone="loading">{t('common.loading')}</AuthStatus>}
      {sessions.isError && <AuthStatus tone="error">{t('errors.generic')}</AuthStatus>}
      {sessions.data && others.length === 0 && (
        <p className="mb-3 text-[13px] text-muted">{t('security.sessionsEmpty')}</p>
      )}

      <div className="flex flex-col gap-2 text-[13px]">
        {sessions.data?.items.map((session) => (
          <div key={session.id} className="flex flex-wrap items-center gap-3">
            <span className={`mono ${session.current ? 'text-success' : 'text-muted'}`}>●</span>
            <span className="min-w-0 flex-1 break-words">
              {session.device_label ?? session.user_agent ?? t('security.unknownDevice')}
            </span>
            <span className="text-muted">{formatRelative(session.last_seen_at, me?.settings.locale ?? 'en')}</span>
            {session.current ? (
              <span className="text-muted">{t('security.currentSession')}</span>
            ) : (
              <Button
                variant="tertiary"
                size="sm"
                disabled={pendingId === session.id}
                onClick={() => void revokeOne(session.id, false)}
              >
                {t('security.revoke')}
              </Button>
            )}
            {mutationErrorId === session.id && (
              <AuthStatus tone="error" className="basis-full">
                {t('errors.generic')}
              </AuthStatus>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function AuditFeedPanel() {
  const t = useTranslations('settings');
  const { me, sessionEpoch } = useSession();
  const query = useInfiniteQuery({
    queryKey: ['auth', 'audit', sessionEpoch],
    queryFn: ({ pageParam }) => listAudit(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!me,
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="card mb-3 p-5">
      <div className="mb-4 min-w-0">
        <div className="mb-1 text-[15px] font-semibold">{t('security.auditTitle')}</div>
        <p className="m-0 text-[13px] text-muted">{t('security.auditBody')}</p>
      </div>
      {query.isLoading && <AuthStatus tone="loading">{t('common.loading')}</AuthStatus>}
      {query.isError && <AuthStatus tone="error">{t('errors.generic')}</AuthStatus>}
      {query.isSuccess && items.length === 0 && <p className="text-[13px] text-muted">{t('common.empty')}</p>}
      <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[13px]">
        {items.map((item) => {
          const meta = sanitizeAuditMeta(item.meta);
          const extras = [
            meta.provider ? t(metaProviderKey(meta.provider)) : null,
            meta.reason ? t(metaReasonKey(meta.reason)) : null,
            ...meta.fields.map((field) => t(metaFieldKey(field))),
          ].filter(Boolean);
          return (
            <li key={item.id} className="flex items-start gap-2 border-b border-line pb-2 last:border-0">
              <span className="min-w-0 flex-1 text-body">
                {t(eventMessageKey(item.event))}
                <span className="ml-2 text-muted">{t(resultMessageKey(item.result))}</span>
                {extras.length > 0 && <span className="ml-2 text-muted">{extras.join(' · ')}</span>}
              </span>
              <span className="text-muted">{item.created_at.slice(0, 10)}</span>
            </li>
          );
        })}
      </ul>
      {query.hasNextPage && (
        <Button
          variant="tertiary"
          size="sm"
          className="mt-3"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t('common.loadMore')}
        </Button>
      )}
    </div>
  );
}

export function NotificationFeedPanel() {
  const t = useTranslations('settings');
  const { me, sessionEpoch } = useSession();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [mutationErrorId, setMutationErrorId] = useState<string | null>(null);
  const query = useInfiniteQuery({
    queryKey: ['auth', 'notifications', sessionEpoch],
    queryFn: ({ pageParam }) => listNotifications(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!me,
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  const markRead = async (id: string) => {
    if (pendingId) return;
    setMutationErrorId(null);
    setPendingId(id);
    try {
      await markNotificationRead(id);
      const result = await query.refetch();
      if (result.isError) throw result.error ?? new Error('notification_refetch_failed');
    } catch {
      setMutationErrorId(id);
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="card mb-3 p-5">
      <div className="mb-4 min-w-0">
        <div className="mb-1 text-[15px] font-semibold">{t('security.notificationsTitle')}</div>
        <p className="m-0 text-[13px] text-muted">{t('security.notificationsBody')}</p>
      </div>
      {query.isLoading && <AuthStatus tone="loading">{t('common.loading')}</AuthStatus>}
      {query.isError && <AuthStatus tone="error">{t('errors.generic')}</AuthStatus>}
      {query.isSuccess && items.length === 0 && (
        <p className="text-[13px] text-muted">{t('notifications.empty')}</p>
      )}
      <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[13px]">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-start gap-2 border-b border-line pb-2 last:border-0">
            <span className="min-w-0 flex-1 text-body">
              {t(noticeKindKey(item.kind))}
              {!item.read_at && (
                <Button
                  variant="tertiary"
                  size="sm"
                  className="ml-2"
                  disabled={pendingId === item.id}
                  onClick={() => void markRead(item.id)}
                >
                  {t('notifications.markRead')}
                </Button>
              )}
            </span>
            <span className="text-muted">{item.created_at.slice(0, 10)}</span>
            {mutationErrorId === item.id && (
              <AuthStatus tone="error" className="basis-full">
                {t('errors.generic')}
              </AuthStatus>
            )}
          </li>
        ))}
      </ul>
      {query.hasNextPage && (
        <Button
          variant="tertiary"
          size="sm"
          className="mt-3"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t('common.loadMore')}
        </Button>
      )}
    </div>
  );
}

export function SecuritySection({ onOpenRevokeDialog }: { onOpenRevokeDialog: () => void }) {
  const t = useTranslations('settings');

  return (
    <section id="baomat" aria-labelledby="security-heading">
      <h2 id="security-heading" className="t-title-md mb-1 text-ink">
        {t('security.heading')}
      </h2>
      <p className="t-body mb-6 text-muted">{t('security.subtitle')}</p>

      <VaultSecurityPanel
        onOpenRevokeSessionsDialog={onOpenRevokeDialog}
        passkeySlot={<PasskeySecurityCard />}
      />
      <SessionsPanel onOpenRevokeDialog={onOpenRevokeDialog} />
      <AuditFeedPanel />
      <NotificationFeedPanel />
    </section>
  );
}
