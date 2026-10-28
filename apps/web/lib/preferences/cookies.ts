import type { components } from '@engram/shared-types';

type Locale = components['schemas']['Locale'];
type Theme = components['schemas']['Theme'];

export const LOCALE_COOKIE = 'sabk_locale';
export const THEME_COOKIE = 'sabk_theme';

const LOCALES: Locale[] = ['en', 'vi'];
const THEMES: Theme[] = ['system', 'light', 'dark'];
const SUPPORTED_LANGUAGE_TAG = /^(en|vi)(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|\d{3}))?$/i;
const QUALITY_VALUE = /^(?:0(?:\.[0-9]{1,3})?|1(?:\.0{1,3})?)$/;

export function parseLocaleCookie(value: string | undefined): Locale | null {
  if (value === 'en' || value === 'vi') return value;
  return null;
}

export function parseThemeCookie(value: string | undefined): Theme | null {
  if (value === 'system' || value === 'light' || value === 'dark') return value;
  return null;
}

export function parseAcceptLanguage(header: string | null | undefined): Locale {
  if (!header) return 'en';

  let selected: Locale = 'en';
  let selectedQuality = -1;
  for (const part of header.split(',')) {
    const segments = part.split(';');
    const locale = parseSupportedLanguageTag(segments[0].trim());
    if (!locale) continue;
    const quality = parseQuality(segments.slice(1));
    if (quality === null || quality <= 0 || quality <= selectedQuality) continue;
    selected = locale;
    selectedQuality = quality;
  }
  return selectedQuality < 0 ? 'en' : selected;
}

function parseSupportedLanguageTag(tag: string): Locale | null {
  if (!SUPPORTED_LANGUAGE_TAG.test(tag)) return null;
  return tag.slice(0, 2).toLowerCase() === 'vi' ? 'vi' : 'en';
}

function parseQuality(parameters: string[]): number | null {
  let quality = 1;
  let seen = false;
  for (const parameter of parameters) {
    const trimmed = parameter.trim();
    const equals = trimmed.indexOf('=');
    const name = (equals < 0 ? trimmed : trimmed.slice(0, equals)).trim().toLowerCase();
    if (name !== 'q') continue;
    if (seen || equals < 0) return null;
    const value = trimmed.slice(equals + 1).trim();
    if (!QUALITY_VALUE.test(value)) return null;
    quality = Number(value);
    seen = true;
  }
  return quality;
}

export function resolveInitialLocale(opts: {
  meLocale?: Locale | null;
  cookieLocale?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  if (opts.meLocale && LOCALES.includes(opts.meLocale)) return opts.meLocale;
  const fromCookie = parseLocaleCookie(opts.cookieLocale ?? undefined);
  if (fromCookie) return fromCookie;
  return parseAcceptLanguage(opts.acceptLanguage);
}

export function resolveInitialTheme(opts: {
  meTheme?: Theme | null;
  cookieTheme?: string | null;
}): Theme {
  if (opts.meTheme && THEMES.includes(opts.meTheme)) return opts.meTheme;
  const fromCookie = parseThemeCookie(opts.cookieTheme ?? undefined);
  if (fromCookie) return fromCookie;
  return 'system';
}

export function themeToDataAttribute(theme: Theme): 'light' | 'dark' {
  if (theme === 'light') return 'light';
  if (theme === 'dark') return 'dark';
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

export function setPreferenceCookies(locale: Locale, theme: Theme): void {
  if (typeof document === 'undefined') return;
  const maxAge = 60 * 60 * 24 * 365;
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${maxAge}; SameSite=Lax`;
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=${maxAge}; SameSite=Lax`;
}
