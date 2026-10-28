import { describe, expect, it } from 'vitest';
import { loginUrl, sanitizeReturnTo } from '@/lib/auth/return-to';

describe('sanitizeReturnTo', () => {
  it('allows internal /app paths', () => {
    expect(sanitizeReturnTo('/app/settings')).toBe('/app/settings');
    expect(sanitizeReturnTo('/app/onboarding')).toBe('/app/onboarding');
  });

  it('rejects open redirects', () => {
    expect(sanitizeReturnTo('//evil.test')).toBe('/app');
    expect(sanitizeReturnTo('https://evil.test')).toBe('/app');
    expect(sanitizeReturnTo('/\\evil.test')).toBe('/app');
    expect(sanitizeReturnTo('/app//evil')).toBe('/app');
  });

  it('strips fragments but keeps query on allowlisted paths', () => {
    expect(sanitizeReturnTo('/app/settings#token=secret')).toBe('/app/settings');
  });
});

describe('loginUrl', () => {
  it('encodes returnTo safely', () => {
    expect(loginUrl('/app/settings')).toBe('/app/auth/login?returnTo=%2Fapp%2Fsettings');
  });
});
