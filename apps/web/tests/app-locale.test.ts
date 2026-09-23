import { describe, expect, it } from 'vitest';
import { parseAcceptLanguage, resolveInitialLocale, resolveInitialTheme } from '@/lib/preferences/cookies';

describe('resolveInitialLocale', () => {
  it('prefers Me locale over cookie and Accept-Language', () => {
    expect(
      resolveInitialLocale({ meLocale: 'vi', cookieLocale: 'en', acceptLanguage: 'en-US,en;q=0.9' }),
    ).toBe('vi');
  });

  it('falls back to cookie then Accept-Language q weights', () => {
    expect(resolveInitialLocale({ cookieLocale: 'vi', acceptLanguage: 'en-US,en;q=0' })).toBe('vi');
    expect(resolveInitialLocale({ acceptLanguage: 'en-US,en;q=0.9,vi;q=0.8' })).toBe('en');
  });

  it('defaults to en', () => {
    expect(resolveInitialLocale({})).toBe('en');
  });
});

describe('resolveInitialTheme', () => {
  it('prefers Me theme then cookie', () => {
    expect(resolveInitialTheme({ meTheme: 'dark', cookieTheme: 'light' })).toBe('dark');
    expect(resolveInitialTheme({ cookieTheme: 'system' })).toBe('system');
  });
});

describe('parseAcceptLanguage', () => {
  it('selects the highest supported q value', () => {
    expect(parseAcceptLanguage('en;q=0.1,vi;q=1')).toBe('vi');
    expect(parseAcceptLanguage('vi;q=0.4,en;q=0.7')).toBe('en');
  });

  it('keeps header order when q values tie', () => {
    expect(parseAcceptLanguage('vi;q=0.8,en;q=0.8')).toBe('vi');
    expect(parseAcceptLanguage('en-US;q=0.8,vi-VN;q=0.8')).toBe('en');
  });

  it('skips zero, malformed, and out-of-range q values', () => {
    expect(parseAcceptLanguage('en;q=0, vi')).toBe('vi');
    expect(parseAcceptLanguage('en;q=invalid, vi;q=0.5')).toBe('vi');
    expect(parseAcceptLanguage('en;q=1.1, vi;q=0.5')).toBe('vi');
    expect(parseAcceptLanguage('en;q=-0.1, vi;q=0.5')).toBe('vi');
  });

  it('accepts supported language tags without accepting bogus shapes', () => {
    expect(parseAcceptLanguage('vi-VN;q=1, en-US;q=0.5')).toBe('vi');
    expect(parseAcceptLanguage('vi-Latn-VN;q=1, en-US;q=0.5')).toBe('vi');
    expect(parseAcceptLanguage('english;q=1, en-US;q=0.5')).toBe('en');
    expect(parseAcceptLanguage('en-foo;q=1, vi-VN;q=0.5')).toBe('vi');
    expect(parseAcceptLanguage('en_US;q=1, vi-VN;q=0.5')).toBe('vi');
  });
});
