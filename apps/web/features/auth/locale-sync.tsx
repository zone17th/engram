'use client';

import { useLocale } from 'next-intl';
import { useEffect, useRef } from 'react';
import { useSession } from '@/features/auth/session-provider';
import { patchSettings } from '@/lib/api/auth';
import { LOCALE_COOKIE, parseLocaleCookie, setPreferenceCookies } from '@/lib/preferences/cookies';
import { useTheme } from '@/components/theme-provider';

function readBrowserLocaleCookie() {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${LOCALE_COOKIE}=`)) {
      return parseLocaleCookie(decodeURIComponent(trimmed.slice(LOCALE_COOKIE.length + 1)));
    }
  }
  return null;
}

/** Đồng bộ locale/theme từ Me sau auth — Me thắng cookie cũ; đổi ngôn ngữ trên cùng phiên cập nhật tài khoản (F-02). */
export function LocaleThemeSync() {
  const { me, refetchMe } = useSession();
  const { setTheme } = useTheme();
  const locale = (useLocale() === 'vi' ? 'vi' : 'en') as 'en' | 'vi';
  const syncedMeRef = useRef<unknown>(null);
  const lastUiLocaleRef = useRef<'en' | 'vi'>(locale);

  useEffect(() => {
    if (!me) {
      syncedMeRef.current = null;
      lastUiLocaleRef.current = locale;
      return;
    }

    if (syncedMeRef.current !== me) {
      syncedMeRef.current = me;
      lastUiLocaleRef.current = locale;
      setTheme(me.settings.theme);
      setPreferenceCookies(me.settings.locale, me.settings.theme);
      return;
    }

    const cookieLocale = readBrowserLocaleCookie();
    if (locale !== lastUiLocaleRef.current && cookieLocale === locale && locale !== me.settings.locale) {
      lastUiLocaleRef.current = locale;
      setPreferenceCookies(locale, me.settings.theme);
      void patchSettings({ locale })
        .then(() => refetchMe?.())
        .catch(() => {
          // Keep cookie preference if settings patch fails offline.
        });
      return;
    }

    lastUiLocaleRef.current = locale;
    setTheme(me.settings.theme);
    setPreferenceCookies(me.settings.locale, me.settings.theme);
  }, [locale, me, refetchMe, setTheme]);

  useEffect(() => {
    document.documentElement.lang = me?.settings.locale ?? locale;
  }, [locale, me]);

  return null;
}
