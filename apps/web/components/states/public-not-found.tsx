import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { ThemeProvider } from '@/components/theme-provider';

export type PublicNotFoundCopy = { title: string; body: string; home: string };

/**
 * U18 `#err-not-found` for the public site (F2 / W-1 / R6-H1). Rendered by `app/global-not-found.tsx`, which Next prerenders ONCE
 * at build time into the static `_not-found` shell, so its inline scripts are covered by the postbuild CSP hash manifest
 * (a request-time render would carry unhashed inline scripts and be blocked by the hash CSP).
 *
 * The static shell cannot know the request locale, so it is statically bilingual (advisor-dec-P06-050): Vietnamese first,
 * then an English `lang="en"` line, exactly like `mockups/states.html#err-not-found`. Both strings come from `messages/{vi,en}.json`
 * at build time. No client locale swap, no `window.location`, no flash: a Vietnamese or English visitor, with or without JS,
 * sees both languages in the first paint. Server component; only `ThemeProvider` (dark mode from cookie/system) is client.
 */
export function PublicNotFound({ copy }: { copy: { vi: PublicNotFoundCopy; en: PublicNotFoundCopy } }) {
  const { vi, en } = copy;
  return (
    <ThemeProvider initialLocale="vi">
      <main id="main-content" className="mx-auto max-w-container px-5 py-16">
        <Card className="flex flex-col items-start gap-3 p-8" data-testid="err-not-found">
          <h1 className="t-title-md m-0" data-testid="err-not-found-title">
            {vi.title} ·{' '}
            <span lang="en" className="font-normal text-muted">
              {en.title}
            </span>
          </h1>
          <div className="flex flex-col gap-1" data-testid="err-not-found-body">
            <p className="m-0 text-body">{vi.body}</p>
            <p className="m-0 text-[13px] text-muted" lang="en">
              {en.body}
            </p>
          </div>
          <Link href="/" className="btn btn-secondary no-underline" data-testid="err-not-found-home">
            {vi.home} · <span lang="en">{en.home}</span>
          </Link>
        </Card>
      </main>
    </ThemeProvider>
  );
}
