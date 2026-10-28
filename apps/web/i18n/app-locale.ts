import { cookies, headers } from 'next/headers';
import type { components } from '@engram/shared-types';
import {
  LOCALE_COOKIE,
  parseLocaleCookie,
  parseAcceptLanguage,
  resolveInitialLocale,
} from '@/lib/preferences/cookies';

export type AppLocale = components['schemas']['Locale'];

/** Locale render lần đầu của /app: cookie preference → Accept-Language → en. */
export async function resolveAppLocale(meLocale?: AppLocale | null): Promise<AppLocale> {
  const cookieStore = await cookies();
  const headerStore = await headers();
  return resolveInitialLocale({
    meLocale: meLocale ?? null,
    cookieLocale: cookieStore.get(LOCALE_COOKIE)?.value ?? null,
    acceptLanguage: headerStore.get('accept-language'),
  });
}

export { parseLocaleCookie, parseAcceptLanguage, LOCALE_COOKIE };
