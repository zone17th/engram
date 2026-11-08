'use client';

import Link from 'next/link';
import { useEffect, useSyncExternalStore } from 'react';
import { Card } from '@/components/ui/card';
import { ThemeProvider } from '@/components/theme-provider';

export type PublicNotFoundCopy = { title: string; body: string; home: string };
export type PublicNotFoundLocale = 'en' | 'vi';

/** `/vi` and `/vi/...` are Vietnamese, everything else (incl. unprefixed `/x`, `/foo.php`) is English. */
export function localeFromPathname(pathname: string | null | undefined): PublicNotFoundLocale {
  if (!pathname) return 'en';
  return pathname === '/vi' || pathname.startsWith('/vi/') ? 'vi' : 'en';
}

const noopSubscribe = () => () => {};
const readLocale = (): PublicNotFoundLocale => localeFromPathname(window.location.pathname);
const serverLocale = (): PublicNotFoundLocale => 'en';

/**
 * U18 `#err-not-found` for the public site (F2 / W-1). Rendered by `app/global-not-found.tsx`, which Next prerenders ONCE at
 * build time into the static `_not-found` shell, so its inline scripts are covered by the postbuild CSP hash manifest
 * (a request-time render would carry unhashed inline scripts and be blocked by the hash CSP). Because the shell is static it
 * cannot know the request locale on the server: it renders English, and the client switches to Vietnamese after hydration
 * when the URL is `/vi` or `/vi/...` (React keeps the server snapshot during hydration, so there is no mismatch).
 */
export function PublicNotFound({ copy }: { copy: Record<PublicNotFoundLocale, PublicNotFoundCopy> }) {
  const locale = useSyncExternalStore(noopSubscribe, readLocale, serverLocale);
  const text = copy[locale];
  const homeHref = locale === 'vi' ? '/vi' : '/';
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return (
    <ThemeProvider initialLocale={locale}>
      <main id="main-content" className="mx-auto max-w-container px-5 py-16">
        <Card className="flex flex-col items-start gap-3 p-8" data-testid="err-not-found">
          <h1 className="t-title-md m-0">{text.title}</h1>
          <p className="m-0 text-body" data-testid="err-not-found-body">
            {text.body}
          </p>
          <Link href={homeHref} className="btn btn-secondary no-underline" data-testid="err-not-found-home">
            {text.home}
          </Link>
        </Card>
      </main>
    </ThemeProvider>
  );
}
