'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useState } from 'react';
import { OfflineBanner } from '@/components/app-shell/offline-banner';
import { AuthStatus } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { useSession } from '@/features/auth/session-provider';
import { loginUrl } from '@/lib/auth/return-to';
import { isAuthRoute, keepAuthFormMountedWhileLoading, resolveGuardRedirect } from '@/features/auth/guard-redirect';
import { useOptionalVault } from '@/features/vault/vault-provider';
function AuthLoadingFrame({ label }: { label: string }) {
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-container items-center justify-center px-5">
      <AuthStatus tone="loading">{label}</AuthStatus>
    </div>
  );
}

function UnavailableFrame({
  title,
  body,
  retry,
  onRetry,
}: {
  title: string;
  body: string;
  retry: string;
  onRetry: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-[520px] flex-col items-center justify-center gap-4 px-5 text-center">
      <div className="card w-full border-error p-5">
        <AuthStatus tone="error" className="mb-3">
          <p className="m-0 mb-1 text-[14px] font-semibold">{title}</p>
          <p className="m-0 text-[13px] text-body">{body}</p>
        </AuthStatus>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {retry}
        </Button>
      </div>
    </div>
  );
}

/**
 * U18 `#auth-session-expired-midflow`: a 401 while working in the app (expired / revoked / invalid session). The session
 * provider has already cleared private caches and the vault locks on sign-out; this frame stays on screen (no silent
 * redirect) and names the reason, with one primary action back to login (returnTo = this page).
 */
function SessionExpiredFrame({ pathname }: { pathname: string }) {
  const t = useTranslations('states');
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-[520px] flex-col justify-center px-5">
      <div role="alert" data-testid="session-expired-midflow" className="card border-error p-5">
        <p className="m-0 mb-1 text-[14px] font-semibold text-body">{t('sessionExpiredTitle')}</p>
        <p className="m-0 mb-3 text-[13px] text-body">{t('sessionExpiredBody')}</p>
        <Link href={loginUrl(pathname)} data-testid="session-expired-cta" className="btn btn-primary btn-sm no-underline">
          {t('sessionExpiredCta')}
        </Link>
      </div>
    </div>
  );
}
function isMidflowSessionLoss(reason: string | null | undefined): boolean {
  return reason === 'expired' || reason === 'revoked' || reason === 'invalid';
}
function readOptionalReturnTo(): string | null {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const searchParams = useSearchParams();
    return searchParams?.get('returnTo') ?? null;
  } catch {
    if (typeof window !== 'undefined') {
      try {
        return new URLSearchParams(window.location.search).get('returnTo');
      } catch {
        return null;
      }
    }
    return null;
  }
}


export function RouteGuard({ children }: { children: ReactNode }) {
  const { status, me, refetchMe, lastSessionEndReason } = useSession();
  const vault = useOptionalVault();
  const vaultState = vault?.state;
  const pathname = usePathname() ?? '/app';
  const router = useRouter();
  const returnTo = readOptionalReturnTo();
  const t = useTranslations('auth.guard');
  // M-2: "mid-flow" means this page HAD a live session. A cold load with a dead cookie also ends with
  // reason expired/invalid from the very first /me call, but nothing was open: that keeps the normal redirect.
  const [hadSession, setHadSession] = useState(false);
  useEffect(() => {
    if (me) setHadSession(true);
  }, [me]);
  const midflowLoss = hadSession && isMidflowSessionLoss(lastSessionEndReason);

  useEffect(() => {
    if (status === 'signed_out' && !isAuthRoute(pathname) && midflowLoss) return;
    const next = resolveGuardRedirect({ status, pathname, me, vaultState, returnTo });
    if (next && next !== pathname) {
      router.replace(next);
    }
  }, [status, me, pathname, returnTo, router, vaultState, midflowLoss]);
  // `me` is still in hand when a session-epoch bump re-keys the query (password
  // replacement, silent refresh). Swapping the tree for the loading frame there
  // unmounts the page and drops transient state such as the account success
  // notice, so only block while there is nothing to render yet.
  if (status === 'loading' && !me && !keepAuthFormMountedWhileLoading(pathname)) {
    return <AuthLoadingFrame label={t('loading')} />;
  }

  const isPasswordRecoveryRoute =
    pathname === '/app/auth/forgot-password' || pathname === '/app/auth/reset-password';

  if (status === 'unavailable' && !isPasswordRecoveryRoute) {
    return (
      <UnavailableFrame
        title={t('unavailableTitle')}
        body={t('unavailableBody')}
        retry={t('retry')}
        onRetry={() => void refetchMe()}
      />
    );
  }

  if (status === 'signed_out' && !isAuthRoute(pathname)) {
    if (midflowLoss) {
      return <SessionExpiredFrame pathname={pathname} />;
    }
    return <AuthLoadingFrame label={t('loading')} />;
  }

  return (
    <>
      <OfflineBanner />
      {children}
      {status !== 'signed_out' && me && (
        <span className="sr-only" aria-hidden="true" data-testid="session-status">
          {status === 'loading'
            ? me.vault.status === 'present'
              ? 'authenticated_with_vault'
              : 'authenticated_without_vault'
            : status}
        </span>
      )}
    </>
  );
}

/**
 * `size` is presentation only (UIA-9): the app header passes `md` so Sign out matches Settings and the theme toggle;
 * other callers keep the previous `sm` default.
 */
export function AppShellLogoutButton({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const { signOut } = useSession();
  const vault = useOptionalVault();
  const t = useTranslations('auth.common');
  return (
    <Button
      variant="tertiary"
      size={size}
      className={size === 'md' ? 'min-h-11' : undefined}
      onClick={() => {
        void vault?.lock({ broadcast: true, reason: 'logout' });
        void signOut();
      }}
    >
      {t('logout')}
    </Button>
  );
}
