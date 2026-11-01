import type { Me } from '@/lib/api/auth';
import { loginUrl, sanitizeReturnTo } from '@/lib/auth/return-to';

export type GuardSessionStatus =
  | 'loading'
  | 'signed_out'
  | 'authenticated_without_vault'
  | 'authenticated_with_vault'
  | 'unavailable';

export type GuardVaultState =
  | 'no_vault'
  | 'onboarding'
  | 'locked'
  | 'unlocking'
  | 'unlocked'
  | 'recovering'
  | 'rewrapping'
  | 'resetting'
  | 'error';

const AUTH_PREFIX = '/app/auth';
const SETTINGS_PREFIX = '/app/settings';
const ONBOARDING = '/app/onboarding';
const UNLOCK = '/app/unlock';
const UNLOCK_FORGOT = '/app/unlock/forgot';
const RECOVERY = '/app/recovery';

export function isAuthRoute(path: string): boolean {
  return path === AUTH_PREFIX || path.startsWith(`${AUTH_PREFIX}/`);
}

/** Login, signup, forgot-password, and reset-password stay reachable while signed out. */
export function isPublicAuthRoute(path: string): boolean {
  return (
    path === `${AUTH_PREFIX}/login` ||
    path === `${AUTH_PREFIX}/signup` ||
    path === `${AUTH_PREFIX}/forgot-password` ||
    path === `${AUTH_PREFIX}/reset-password`
  );
}

/** Keep fragment-token, public auth forms, and OAuth callback mounted so hash/status UI can render. */
export function keepAuthFormMountedWhileLoading(path: string): boolean {
  return (
    isPublicAuthRoute(path) ||
    path === `${AUTH_PREFIX}/verify-email` ||
    path === `${AUTH_PREFIX}/password-enroll` ||
    path.startsWith(`${AUTH_PREFIX}/callback/`)
  );
}

export function isSettingsRoute(path: string): boolean {
  return path === SETTINGS_PREFIX || path.startsWith(`${SETTINGS_PREFIX}/`);
}

export function isOnboardingRoute(path: string): boolean {
  return path === ONBOARDING;
}

export function isUnlockRoute(path: string): boolean {
  return path === UNLOCK;
}

export function isRecoveryOrForgotRoute(path: string): boolean {
  return (
    path === UNLOCK_FORGOT ||
    path.startsWith(`${UNLOCK_FORGOT}/`) ||
    path === RECOVERY ||
    path.startsWith(`${RECOVERY}/`)
  );
}

export function unlockUrl(returnTo?: string): string {
  const safe = sanitizeReturnTo(returnTo, '/app');
  if (
    safe === '/app' ||
    safe === UNLOCK ||
    safe === ONBOARDING ||
    isRecoveryOrForgotRoute(safe) ||
    isAuthRoute(safe)
  ) {
    return UNLOCK;
  }
  return `${UNLOCK}?returnTo=${encodeURIComponent(safe)}`;
}

export function needsEmailVerify(me: Me): boolean {
  return me.features.email_verification_required && !me.user.email_verified;
}

export function resolveGuardRedirect(input: {
  status: GuardSessionStatus;
  pathname: string;
  me: Me | null;
  vaultState?: GuardVaultState;
}): string | null {
  const { status, pathname, me, vaultState } = input;
  if (status === 'loading' || status === 'unavailable') return null;

  const auth = isAuthRoute(pathname);
  const settings = isSettingsRoute(pathname);
  const onboarding = isOnboardingRoute(pathname);
  const unlock = isUnlockRoute(pathname);
  const recoveryOrForgot = isRecoveryOrForgotRoute(pathname);
  const callback = pathname.startsWith(`${AUTH_PREFIX}/callback/`);
  const reauth = pathname === `${AUTH_PREFIX}/reauth`;
  const verify = pathname === `${AUTH_PREFIX}/verify-email`;
  const enroll = pathname === `${AUTH_PREFIX}/password-enroll`;
  const forgotPassword = pathname === `${AUTH_PREFIX}/forgot-password`;
  const resetPassword = pathname === `${AUTH_PREFIX}/reset-password`;

  if (status === 'signed_out') {
    // OAuth callback must stay reachable while signed out so cancel/error/conflict UI can render.
    if (isPublicAuthRoute(pathname) || pathname.startsWith(`${AUTH_PREFIX}/callback/`)) return null;
    return loginUrl(pathname);
  }

  if (!me) return null;

  if (needsEmailVerify(me)) {
    const allowed = settings || verify || callback || enroll || reauth || forgotPassword || resetPassword;
    return allowed ? null : '/app/auth/verify-email';
  }

  if (status === 'authenticated_without_vault') {
    const allowed = settings || onboarding || callback || reauth || verify || enroll || forgotPassword || resetPassword;
    return allowed ? null : '/app/onboarding';
  }

  // status === 'authenticated_with_vault' (me.vault.status === 'present')
  if (vaultState !== undefined) {
    const isVaultUnlocked = vaultState === 'unlocked' || vaultState === 'rewrapping';
    if (!isVaultUnlocked) {
      // U5 (advisor-dec-048, SPEC §7 U5 over plan 15A): a locked/unlocking/error vault still renders the item list and
      // item pages with masked bodies; every other app route keeps redirecting to unlock, and `recovering` is unchanged.
      const browseWhileLocked =
        (vaultState === 'locked' || vaultState === 'unlocking' || vaultState === 'error') &&
        (pathname === '/app' || pathname.startsWith('/app/items/'));
      const allowedWhileLocked =
        browseWhileLocked ||
        unlock ||
        recoveryOrForgot ||
        settings ||
        callback ||
        reauth ||
        verify ||
        enroll ||
        forgotPassword ||
        resetPassword;
      if (allowedWhileLocked) return null;
      return unlockUrl(pathname);
    }
    if (unlock) return '/app';
  }

  if (onboarding) return '/app';
  if (auth && !reauth && !callback && !verify && !enroll && !forgotPassword && !resetPassword) return '/app';
  return null;
}
