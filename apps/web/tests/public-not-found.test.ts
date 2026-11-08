import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { htmlRelativePathToRoutes, NOT_FOUND_ROUTE_KEY } from '../scripts/postbuild-csp-manifest.mjs';

const WEB = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(WEB, rel), 'utf8');

// W-1 (tester_visual visual-2): the branded public 404 must stay STATICALLY prerendered, otherwise its inline RSC scripts are
// not in the postbuild CSP hash manifest and the hash CSP blocks them (blank page, 9-12 violations in `next start`).
describe('public 404 stays static (W-1)', () => {
  it('global-not-found.tsx uses no request-time API', () => {
    // Strip comments: the file's own doc comment names the APIs it avoids.
    const src = read('app/global-not-found.tsx').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/next\/headers|cookies\(|headers\(|getLocale|getTranslations|next-intl\/server|searchParams|params/);
    expect(src).not.toMatch(/dynamic\s*=|revalidate\s*=/);
  });

  it('the public-site catch-all and per-locale not-found (dynamic render) are gone; the app catch-all stays', () => {
    expect(existsSync(resolve(WEB, 'app/(marketing)/[locale]/[...rest]'))).toBe(false);
    expect(existsSync(resolve(WEB, 'app/(marketing)/[locale]/not-found.tsx'))).toBe(false);
    expect(existsSync(resolve(WEB, 'app/app/[...rest]/page.tsx'))).toBe(true);
  });

  it('next.config enables experimental.globalNotFound', () => {
    expect(read('next.config.ts')).toMatch(/experimental:\s*\{\s*globalNotFound:\s*true\s*\}/);
  });

  it('the static not-found shell is hashed by the postbuild manifest under the 404 key', () => {
    expect(htmlRelativePathToRoutes('_not-found.html')).toEqual([NOT_FOUND_ROUTE_KEY]);
  });

  it('public-not-found is a static server component: no client locale swap (R6-H1, advisor-dec-P06-050)', () => {
    const src = read('components/states/public-not-found.tsx').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/['"]use client['"]/);
    expect(src).not.toMatch(/useSyncExternalStore|useEffect|useState|window\.|document\.|usePathname|localeFromPathname|location/);
  });

  it('global-not-found builds both locales from messages/{vi,en}.json at build time', () => {
    const src = read('app/global-not-found.tsx');
    expect(src).toMatch(/from '@\/messages\/en\.json'/);
    expect(src).toMatch(/from '@\/messages\/vi\.json'/);
    expect(src).toMatch(/<html lang="vi"/);
  });
});
