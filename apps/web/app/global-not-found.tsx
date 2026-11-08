import type { Metadata } from 'next';
import { fontVariables } from '@/app/fonts';
import { PublicNotFound } from '@/components/states/public-not-found';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';
import '@/app/globals.css';

export const metadata: Metadata = {
  title: 'engram',
  robots: { index: false, follow: false },
};

const pick = (states: typeof enMessages.states) => ({
  title: states.notFoundTitle,
  body: states.pageNotFoundBody,
  home: states.backHome,
});

/**
 * Branded 404 for every URL no route matches (`/x`, `/vi/x`, `/foo.php`): the public site's U18 `#err-not-found` (F2).
 * Static on purpose (W-1): no `headers()`/`cookies()`/params, so Next prerenders it into `_not-found.html` and
 * `postbuild-csp-manifest.mjs` hashes its inline scripts for the 404 CSP. Statically bilingual (vi + en, R6-H1): see
 * `components/states/public-not-found.tsx`.
 */
export default function GlobalNotFound() {
  return (
    <html lang="vi" data-theme="light" className={fontVariables}>
      <body className="bg-canvas font-sans text-body antialiased">
        <PublicNotFound copy={{ en: pick(enMessages.states), vi: pick(viMessages.states) }} />
      </body>
    </html>
  );
}
