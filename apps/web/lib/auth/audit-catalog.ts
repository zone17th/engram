import type { components } from '@engram/shared-types';

export const AUDIT_EVENTS = [
  'auth.signup',
  'auth.login.success',
  'auth.login.failure',
  'auth.logout',
  'auth.refresh.reuse',
  'auth.session.revoke',
  'auth.session.revoke_others',
  'auth.password.change',
  'auth.password.enroll',
  'auth.email.change_request',
  'auth.email.change_confirm',
  'auth.email.verify',
  'auth.identity.link',
  'auth.identity.unlink',
  'auth.settings.change',
  'auth.oauth.login',
  'auth.reauth',
  'auth.password.reset',
] as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[number];

export const NOTICE_KINDS = ['security'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

const PROVIDERS = new Set(['password', 'google', 'github']);
const REASONS = new Set(['reuse', 'invalid', 'expired', 'revoked', 'last_method', 'collision', 'unverified']);
const FIELDS = new Set(['locale', 'theme', 'auto_lock_minutes', 'semantic_suggest']);

export function eventMessageKey(event: string): string {
  if ((AUDIT_EVENTS as readonly string[]).includes(event)) {
    return `audit.events.${event.replace(/\./g, '_')}`;
  }
  return 'audit.events.unknown';
}

export function noticeKindKey(kind: string): string {
  if ((NOTICE_KINDS as readonly string[]).includes(kind)) {
    return `notifications.kinds.${kind}`;
  }
  return 'notifications.kinds.unknown';
}

export function resultMessageKey(result: string): string {
  return result === 'failure' ? 'audit.results.failure' : 'audit.results.success';
}

type AuditMeta = NonNullable<components['schemas']['AuditItem']['meta']>;

/** Chỉ lấy enum đã whitelist — không render HTML/raw object. */
export function sanitizeAuditMeta(meta: AuditMeta | undefined): {
  provider?: string;
  reason?: string;
  fields: string[];
  count?: number;
} {
  if (!meta || typeof meta !== 'object') return { fields: [] };
  const provider = typeof meta.provider === 'string' && PROVIDERS.has(meta.provider) ? meta.provider : undefined;
  const reason = typeof meta.reason === 'string' && REASONS.has(meta.reason) ? meta.reason : undefined;
  const fields = Array.isArray(meta.fields)
    ? meta.fields.filter((field): field is string => typeof field === 'string' && FIELDS.has(field))
    : [];
  const count = typeof meta.count === 'number' && Number.isFinite(meta.count) ? meta.count : undefined;
  return { provider, reason, fields, count };
}

export function metaProviderKey(provider: string): string {
  return `audit.providers.${provider}`;
}

export function metaReasonKey(reason: string): string {
  return `audit.reasons.${reason}`;
}

export function metaFieldKey(field: string): string {
  return `audit.fields.${field}`;
}

export function grantStillValid(expiresAt: string | undefined, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const exp = Date.parse(expiresAt);
  return Number.isFinite(exp) && exp > now;
}
