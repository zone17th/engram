import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const intlCalls: string[] = [];

vi.mock('next-intl/middleware', () => ({
  default: () => (req: { url: string; nextUrl: { pathname: string; origin: string } }) => {
    intlCalls.push(req.nextUrl.pathname);
    return new Response(null, {
      headers: {
        'x-middleware-rewrite': `http://localhost:3040/en${req.nextUrl.pathname === '/' ? '' : req.nextUrl.pathname}`,
      },
    });
  },
}));

import CryptoBenchPage from '../app/dev/crypto-bench/page';
import { withRequestOrigin } from '../i18n/internal-rewrite';
import { routing } from '../i18n/routing';
import middleware from '../middleware';
const WEB = resolve(__dirname, '..');

describe('cấu trúc route (P01-A3)', () => {
  it('app riêng tư nằm ở segment tĩnh /app, không dưới [locale]', () => {
    expect(existsSync(resolve(WEB, 'app/app/page.tsx'))).toBe(true);
    expect(existsSync(resolve(WEB, 'app/(marketing)/[locale]/app'))).toBe(false);
  });

  it('middleware i18n không chạm /api và /app', () => {
    const mw = readFileSync(resolve(WEB, 'middleware.ts'), 'utf8');
    expect(mw).toContain('?!api|app');
  });

  it('giữ origin của rewrite và redirect khi Next chuẩn hoá loopback', () => {
    expect(withRequestOrigin('http://localhost:3100/en?q=test', 'http://127.0.0.1:3100/', 'http://localhost:3100'))
      .toBe('http://127.0.0.1:3100/en?q=test');
    expect(withRequestOrigin('http://localhost:3100/', 'http://127.0.0.1:3100/en', 'http://localhost:3100'))
      .toBe('http://127.0.0.1:3100/');
    expect(withRequestOrigin('https://example.com/vi', 'https://example.com/', 'https://example.com'))
      .toBe('https://example.com/vi');
    expect(withRequestOrigin('https://other.example/vi', 'https://example.com/', 'https://example.com'))
      .toBe('https://other.example/vi');
  });

  it('không tự động đổi locale theo cookie hoặc Accept-Language', () => {
    expect(routing.localeDetection).toBe(false);
  });

  it('next.config proxy /api sang upstream Go', () => {
    const config = readFileSync(resolve(WEB, 'next.config.ts'), 'utf8');
    expect(config).toContain("source: '/api/:path*'");
    expect(config).toContain('API_UPSTREAM');
  });

  it('layout /app đặt noindex', () => {
    const layout = readFileSync(resolve(WEB, 'app/app/layout.tsx'), 'utf8');
    expect(layout).toMatch(/robots:\s*\{[^}]*index:\s*false/);
  });

  // Hai root layout song song: không được có app/layout.tsx, và mỗi root layout
  // phải tự render <html> với lang đúng nguồn (locale của route / APP_LOCALE).
  it('không có root layout chung ở app/layout.tsx', () => {
    expect(existsSync(resolve(WEB, 'app/layout.tsx'))).toBe(false);
    expect(existsSync(resolve(WEB, 'app/global-error.tsx'))).toBe(true);
  });

  it('lang của marketing bám theo locale, không hardcode', () => {
    const layout = readFileSync(resolve(WEB, 'app/(marketing)/[locale]/layout.tsx'), 'utf8');
    expect(layout).toContain('<html lang={locale}');
    expect(layout).not.toContain('lang="en"');
  });

  it('lang của /app khớp locale truyền cho NextIntlClientProvider', () => {
    const layout = readFileSync(resolve(WEB, 'app/app/layout.tsx'), 'utf8');
    expect(layout).toContain('<html lang={locale}');
    expect(layout).toContain('locale={locale}');
    expect(layout).toContain('resolveAppLocale');
    expect(layout).not.toContain('APP_LOCALE');
  });

  it('dev-only /dev/crypto-bench bypasses next-intl only when NODE_ENV !== production while production and other paths go through next-intl', () => {
    intlCalls.length = 0;
    const makeReq = (pathname: string) =>
      ({
        url: `http://localhost:3040${pathname}`,
        nextUrl: new URL(`http://localhost:3040${pathname}`),
      }) as unknown as Parameters<typeof middleware>[0];

    try {
      // Non-production exact /dev/crypto-bench bypasses next-intl
      const devBenchRes = middleware(makeReq('/dev/crypto-bench'));
      expect(devBenchRes.headers.get('x-middleware-rewrite')).toBeNull();
      expect(intlCalls).toEqual([]);

      // Non-production other /dev/* and / still go through next-intl
      const devOtherRes = middleware(makeReq('/dev/other'));
      expect(devOtherRes.headers.get('x-middleware-rewrite')).toBe(
        'http://localhost:3040/en/dev/other',
      );
      const rootRes = middleware(makeReq('/'));
      expect(rootRes.headers.get('x-middleware-rewrite')).toBe('http://localhost:3040/en');
      expect(intlCalls).toEqual(['/dev/other', '/']);

      // Production /dev/crypto-bench goes through next-intl as before
      vi.stubEnv('NODE_ENV', 'production');
      const prodBenchRes = middleware(makeReq('/dev/crypto-bench'));
      expect(prodBenchRes.headers.get('x-middleware-rewrite')).toBe(
        'http://localhost:3040/en/dev/crypto-bench',
      );
      expect(intlCalls).toEqual(['/dev/other', '/', '/dev/crypto-bench']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('/dev/crypto-bench page calls notFound() when NODE_ENV === production (advisor-dec-013)', () => {
    expect(() => CryptoBenchPage()).not.toThrow();

    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => CryptoBenchPage()).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
