'use client';

import { useLocale } from 'next-intl';
import { useEffect } from 'react';
import { useSession } from '@/features/auth/session-provider';
import { setPreferenceCookies } from '@/lib/preferences/cookies';
import { useTheme } from '@/components/theme-provider';

/** Đồng bộ locale/theme từ Me sau auth — Me thắng cookie cũ. */
export function LocaleThemeSync() {
  const { me } = useSession();
  const { setTheme } = useTheme();
  const locale = useLocale();

  useEffect(() => {
    if (!me) return;
    setTheme(me.settings.theme);
    setPreferenceCookies(me.settings.locale, me.settings.theme);
  }, [me, setTheme]);

  useEffect(() => {
    document.documentElement.lang = me?.settings.locale ?? locale;
  }, [locale, me]);

  return null;
}
