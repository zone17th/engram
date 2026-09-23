import type { Me } from '@/lib/api/auth';
import { loginUrl } from '@/lib/auth/return-to';

export type GuardSessionStatus =
  | 'loading'
  | 'signed_out'
  | 'authenticated_without_vault'
  | 'authenticated_with_vault'
  | 'unavailable';

const AUTH_PREFIX = '/app/auth';
const SETTINGS_PREFIX = '/app/settings';
const ONBOARDING = '/app/onboarding';

export function isAuthRoute(path: string): boolean {
  return path === AUTH_PREFIX || path.startsWith(`${AUTH_PREFIX}/`);
}

/** Login/signup stay reachable while signed out; other /app/auth/* routes require a session. */
export function isPublicAuthRoute(path: string): boolean {
  return path === `${AUTH_PREFIX}/login` || path === `${AUTH_PREFIX}/signup`;
}

/** Keep fragment-token and public auth forms mounted so hash can be read and scrubbed. */
export function keepAuthFormMountedWhileLoading(path: string): boolean {
  return (
    isPublicAuthRoute(path) ||
    path === `${AUTH_PREFIX}/verify-email` ||
    path === `${AUTH_PREFIX}/password-enroll`
  );
}

export function isSettingsRoute(path: string): boolean {
  return path === SETTINGS_PREFIX || path.startsWith(`${SETTINGS_PREFIX}/`);
}

export function isOnboardingRoute(path: string): boolean {
  return path === ONBOARDING;
}

export function needsEmailVerify(me: Me): boolean {
  return me.features.email_verification_required && !me.user.email_verified;
}

export function resolveGuardRedirect(input: {
  status: GuardSessionStatus;
  pathname: string;
  me: Me | null;
}): string | null {
  const { status, pathname, me } = input;
  if (status === 'loading' || status === 'unavailable') return null;

  const auth = isAuthRoute(pathname);
  const settings = isSettingsRoute(pathname);
  const onboarding = isOnboardingRoute(pathname);
  const callback = pathname.startsWith(`${AUTH_PREFIX}/callback/`);
  const reauth = pathname === `${AUTH_PREFIX}/reauth`;
  const verify = pathname === `${AUTH_PREFIX}/verify-email`;
  const enroll = pathname === `${AUTH_PREFIX}/password-enroll`;

  if (status === 'signed_out') {
    if (isPublicAuthRoute(pathname)) return null;
    return loginUrl(pathname);
  }

  if (!me) return null;

  if (needsEmailVerify(me)) {
    const allowed = settings || verify || callback || enroll || reauth;
    return allowed ? null : '/app/auth/verify-email';
  }

  if (status === 'authenticated_without_vault') {
    const allowed = settings || onboarding || callback || reauth || verify || enroll;
    return allowed ? null : '/app/onboarding';
  }

  if (onboarding) return '/app';
  if (auth && !reauth && !callback && !verify && !enroll) return '/app';
  return null;
}
