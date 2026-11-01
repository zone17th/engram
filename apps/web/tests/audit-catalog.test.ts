import { describe, expect, it } from 'vitest';
import {
  AUDIT_EVENTS,
  eventMessageKey,
  grantStillValid,
  metaFieldKey,
  metaProviderKey,
  metaReasonKey,
  noticeKindKey,
  resultMessageKey,
  sanitizeAuditMeta,
} from '@/lib/auth/audit-catalog';
import en from '../messages/en.json';
import vi from '../messages/vi.json';

describe('audit catalog', () => {
  it('maps known events and unknown leftovers to i18n keys', () => {
    expect(eventMessageKey('auth.signup')).toBe('audit.events.auth_signup');
    expect(eventMessageKey('auth.login.success')).toBe('audit.events.auth_login_success');
    expect(eventMessageKey('not.a.real.event')).toBe('audit.events.unknown');
    expect(AUDIT_EVENTS).toContain('auth.reauth');
    expect(AUDIT_EVENTS).toContain('auth.password.reset');
    expect(eventMessageKey('auth.password.reset')).toBe('audit.events.auth_password_reset');
  });

  it('labels every vault service audit event instead of the generic fallback', () => {
    const vaultEvents = [
      'vault.create',
      'vault.rewrap',
      'vault.recover',
      'vault.reset',
      'recovery_key.consume',
      'recovery_key.regenerate',
      'recovery_key.rotate',
      'passkey.register',
      'passkey.revoke',
    ];
    for (const event of vaultEvents) {
      const key = eventMessageKey(event);
      expect(key).toBe(`audit.events.${event.replace(/\./g, '_')}`);
      const leaf = key.replace('audit.events.', '');
      expect((en.settings.audit.events as Record<string, string>)[leaf]).toBeTruthy();
      expect((vi.settings.audit.events as Record<string, string>)[leaf]).toBeTruthy();
    }
  });

  it('maps notice kinds and results', () => {
    expect(noticeKindKey('security')).toBe('notifications.kinds.security');
    expect(noticeKindKey('email')).toBe('notifications.kinds.unknown');
    expect(resultMessageKey('success')).toBe('audit.results.success');
    expect(resultMessageKey('failure')).toBe('audit.results.failure');
    expect(resultMessageKey('other')).toBe('audit.results.success');
  });

  it('strips nested or unknown meta instead of rendering raw objects', () => {
    const meta = sanitizeAuditMeta({
      provider: 'google',
      reason: 'reuse',
      fields: ['locale', 'theme', 'password_hash', { nested: 'secret' } as unknown as string],
      count: 2,
    });
    expect(meta).toEqual({
      provider: 'google',
      reason: 'reuse',
      fields: ['locale', 'theme'],
      count: 2,
    });
    expect(sanitizeAuditMeta({ provider: 'ldap', reason: 'hacked', fields: ['email'] })).toEqual({
      fields: [],
    });
  });

  it('builds meta i18n keys only for sanitized enum values', () => {
    expect(metaProviderKey('github')).toBe('audit.providers.github');
    expect(metaReasonKey('last_method')).toBe('audit.reasons.last_method');
    expect(metaFieldKey('semantic_suggest')).toBe('audit.fields.semantic_suggest');
  });

  it('treats grant expiry as exclusive of now', () => {
    const now = Date.parse('2026-09-16T01:00:00.000Z');
    expect(grantStillValid('2026-09-16T01:00:01.000Z', now)).toBe(true);
    expect(grantStillValid('2026-09-16T01:00:00.000Z', now)).toBe(false);
    expect(grantStillValid(undefined, now)).toBe(false);
    expect(grantStillValid('not-a-date', now)).toBe(false);
  });
});
