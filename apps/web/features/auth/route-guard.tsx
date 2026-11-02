'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect } from 'react';
import { AuthStatus } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { useSession } from '@/features/auth/session-provider';
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

export function RouteGuard({ children }: { children: ReactNode }) {
  const { status, me, refetchMe } = useSession();
  const vault = useOptionalVault();
  const vaultState = vault?.state;
  const pathname = usePathname() ?? '/app';
  const router = useRouter();
  const t = useTranslations('auth.guard');

  useEffect(() => {
    const next = resolveGuardRedirect({ status, pathname, me, vaultState });
    if (next && next !== pathname) {
      router.replace(next);
    }
  }, [status, me, pathname, router, vaultState]);
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
    return <AuthLoadingFrame label={t('loading')} />;
  }

  return (
    <>
      {children}
      {status !== 'signed_out' && me && (
        <span className="sr-only" data-testid="session-status">
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
      onClick={() => {
        void vault?.lock({ broadcast: true, reason: 'logout' });
        void signOut();
      }}
    >
      {t('logout')}
    </Button>
  );
}
