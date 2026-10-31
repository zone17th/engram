import type { components } from '@engram/shared-types';
import { authFetch, authMutate, bootstrapCsrf, ensureCsrf } from '@/lib/api/auth-fetch';

export type Me = components['schemas']['Me'];
export type AuthConfig = components['schemas']['AuthConfig'];
export type ReauthAction = components['schemas']['ReauthAction'];
export type ReauthGrant = components['schemas']['ReauthGrant'];
export type OauthProvider = components['schemas']['OauthProvider'];
export type IdentityProvider = components['schemas']['IdentityProvider'];
export type OauthCallbackStatus = components['schemas']['OauthCallbackStatus'];
export type SessionList = components['schemas']['SessionList'];
export type SessionItem = components['schemas']['SessionItem'];
export type AuditList = components['schemas']['AuditList'];
export type NotificationList = components['schemas']['NotificationList'];
export type SettingsPatch = components['schemas']['SettingsPatch'];
export type Locale = components['schemas']['Locale'];
export type Theme = components['schemas']['Theme'];

export { bootstrapCsrf };

export function fetchAuthConfig(): Promise<AuthConfig> {
  return authFetch<AuthConfig>('/auth/config');
}

export function fetchMe(): Promise<Me> {
  return authFetch<Me>('/auth/me', { requireSession: true });
}

export async function signup(body: components['schemas']['SignupRequest']): Promise<Me> {
  await ensureCsrf();
  return authMutate<Me>('/auth/signup', { method: 'POST', json: body, requireSession: false });
}

export async function login(body: components['schemas']['LoginRequest']): Promise<Me> {
  await ensureCsrf();
  return authMutate<Me>('/auth/login', { method: 'POST', json: body, requireSession: false });
}

export function oauthComplete(): Promise<Me> {
  return authMutate<Me>('/auth/oauth/complete', { method: 'POST', json: {}, requireSession: false });
}

export function verifyEmailSend(): Promise<void> {
  return authMutate<void>('/auth/verify-email/send', { method: 'POST' });
}

export function verifyEmailConfirm(token: string): Promise<Me> {
  return authMutate<Me>('/auth/verify-email/confirm', {
    method: 'POST',
    json: { token },
  });
}

export function passwordEnrollSend(): Promise<void> {
  return authMutate<void>('/auth/password/enroll/send', { method: 'POST' });
}

export function changePassword(
  body: components['schemas']['PasswordChangeRequest'],
  reauthToken?: string,
): Promise<Me> {
  return authMutate<Me>('/me/password', {
    method: 'POST',
    json: body,
    reauthToken,
  });
}

export function changeEmail(newEmail: string, reauthToken: string): Promise<void> {
  return authMutate<void>('/me/email', {
    method: 'POST',
    json: { new_email: newEmail },
    reauthToken,
  });
}

export function patchSettings(patch: SettingsPatch): Promise<Me> {
  return authMutate<Me>('/me/settings', { method: 'PATCH', json: patch });
}

export function reauthPassword(action: ReauthAction, password: string): Promise<ReauthGrant> {
  return authMutate<ReauthGrant>('/auth/reauth', {
    method: 'POST',
    json: { action, password },
  });
}

export function reauthOauth(action: ReauthAction, provider: 'google'): Promise<ReauthGrant> {
  return authMutate<ReauthGrant>('/auth/reauth', {
    method: 'POST',
    json: { action, provider },
  });
}

export function oauthLinkStart(provider: OauthProvider, reauthToken: string): Promise<{ authorization_url: string }> {
  return authMutate<{ authorization_url: string }>(`/auth/oauth/${provider}/link`, {
    method: 'POST',
    reauthToken,
  });
}

export function oauthReauthStart(
  provider: OauthProvider,
  action: ReauthAction,
): Promise<{ authorization_url: string }> {
  return authMutate<{ authorization_url: string }>(`/auth/oauth/${provider}/reauth`, {
    method: 'POST',
    json: { action },
  });
}

export function unlinkIdentity(provider: components['schemas']['IdentityProvider'], reauthToken: string): Promise<void> {
  return authMutate<void>(`/auth/identities/${provider}`, {
    method: 'DELETE',
    reauthToken,
  });
}

export function listSessions(cursor?: string): Promise<SessionList> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return authFetch<SessionList>(`/auth/sessions${q}`, { requireSession: true });
}

export function revokeSession(id: string): Promise<void> {
  return authMutate<void>(`/auth/sessions/${id}`, { method: 'DELETE' });
}

export function revokeOtherSessions(reauthToken: string): Promise<{ revoked: number }> {
  return authMutate<{ revoked: number }>('/auth/sessions/revoke-others', {
    method: 'POST',
    reauthToken,
  });
}

export function listAudit(cursor?: string): Promise<AuditList> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return authFetch<AuditList>(`/auth/audit${q}`, { requireSession: true });
}

export function listNotifications(cursor?: string): Promise<NotificationList> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return authFetch<NotificationList>(`/me/notifications${q}`, { requireSession: true });
}

export function markNotificationRead(id: string): Promise<void> {
  return authMutate<void>(`/me/notifications/${id}`, {
    method: 'PATCH',
    json: { read: true },
  });
}

export function oauthLoginStartUrl(provider: OauthProvider): string {
  return `/api/v1/auth/oauth/${provider}/start`;
}
