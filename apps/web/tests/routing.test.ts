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
import { CryptoBenchClient } from '../app/dev/crypto-bench/bench-client';
import { CryptoHarnessClient } from '../app/dev/crypto-bench/harness-client';
import { withRequestOrigin } from '../i18n/internal-rewrite';
import { routing } from '../i18n/routing';
import middleware, { config as middlewareConfig } from '../middleware';
const WEB = resolve(__dirname, '..');

describe('cấu trúc route (P01-A3)', () => {
  it('app riêng tư nằm ở segment tĩnh /app, không dưới [locale]', () => {
    expect(existsSync(resolve(WEB, 'app/app/page.tsx'))).toBe(true);
    expect(existsSync(resolve(WEB, 'app/(marketing)/[locale]/app'))).toBe(false);
  });

  it('middleware i18n không chạm /api và /app', () => {
    intlCalls.length = 0;
    const pattern = new RegExp(`^${middlewareConfig.matcher[0]}$`);

    // `/api`, `/_next` và file tĩnh bị loại ngay ở matcher nên không đi qua middleware/i18n
    expect(pattern.test('/api/v1/me')).toBe(false);
    expect(pattern.test('/api/v1/export.json')).toBe(false);
    expect(pattern.test('/_next/static/chunks/main.js')).toBe(false);
    expect(pattern.test('/favicon.ico')).toBe(false);
    expect(pattern.test('/missing.png')).toBe(false);
    expect(pattern.test('/foo.php')).toBe(true);
    // `/app/*` khớp matcher để nhận CSP nonce nhưng hoàn toàn bỏ qua intlMiddleware
    expect(pattern.test('/app/settings')).toBe(true);
    const makeReq = (pathname: string) =>
      ({
        url: `http://localhost:3040${pathname}`,
        headers: new Headers(),
        nextUrl: new URL(`http://localhost:3040${pathname}`),
      }) as unknown as Parameters<typeof middleware>[0];

    const appRes = middleware(makeReq('/app/settings'));
    expect(intlCalls).toEqual([]);
    expect(appRes.headers.get('Content-Security-Policy')).toContain("'nonce-");
    expect(appRes.headers.get('x-middleware-rewrite')).toBeNull();
    expect(appRes.headers.get('location')).toBeNull();
    expect(appRes.headers.get('set-cookie')).toBeNull();
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

  it('V-2: /app/<không-có-route> vẫn đi nhánh /app (CSP nonce, không qua intl) như mọi trang /app khác', () => {
    intlCalls.length = 0;
    const makeReq = (pathname: string) =>
      ({
        url: `http://localhost:3040${pathname}`,
        headers: new Headers(),
        nextUrl: new URL(`http://localhost:3040${pathname}`),
      }) as unknown as Parameters<typeof middleware>[0];
    const known = middleware(makeReq('/app/settings'));
    const unknown = middleware(makeReq('/app/zzz-nothing'));
    expect(intlCalls).toEqual([]);
    expect(unknown.headers.get('Content-Security-Policy')).toContain("'nonce-");
    const scriptSrc = /script-src ([^;]*)/.exec(unknown.headers.get('Content-Security-Policy') ?? '')?.[1] ?? '';
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(unknown.headers.get('x-middleware-rewrite')).toBeNull();
    expect(unknown.headers.get('location')).toBeNull();
    // same policy shape as a real /app route, only the per-request nonce differs
    const strip = (csp: string | null) => (csp ?? '').replace(/'nonce-[^']+'/g, "'nonce-X'");
    expect(strip(unknown.headers.get('Content-Security-Policy'))).toBe(
      strip(known.headers.get('Content-Security-Policy')),
    );
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

  it('dev-only /dev/crypto-bench bypasses next-intl only for the exact pathname (query string allowed, near-misses rejected) when NODE_ENV !== production (FE1-29)', () => {
    intlCalls.length = 0;
    const makeReq = (pathWithOptionalQuery: string) =>
      ({
        url: `http://localhost:3040${pathWithOptionalQuery}`,
        nextUrl: new URL(`http://localhost:3040${pathWithOptionalQuery}`),
      }) as unknown as Parameters<typeof middleware>[0];

    try {
      // Non-production exact /dev/crypto-bench bypasses next-intl
      const devBenchRes = middleware(makeReq('/dev/crypto-bench'));
      expect(devBenchRes.headers.get('x-middleware-rewrite')).toBeNull();
      expect(intlCalls).toEqual([]);

      // Query string on the exact pathname (/dev/crypto-bench?x=1 and ?mode=harness) ALSO bypasses next-intl
      // because request.nextUrl.pathname excludes searchParams, allowing harness mode on the same route.
      const devBenchQueryRes = middleware(makeReq('/dev/crypto-bench?x=1'));
      expect(devBenchQueryRes.headers.get('x-middleware-rewrite')).toBeNull();
      const devBenchHarnessRes = middleware(makeReq('/dev/crypto-bench?mode=harness'));
      expect(devBenchHarnessRes.headers.get('x-middleware-rewrite')).toBeNull();
      expect(intlCalls).toEqual([]);

      // Near-miss pathnames (/dev/crypto-bench/x, /dev/crypto-benchmark) and other paths do NOT bypass
      // (proving exact === rather than startsWith)
      const devBenchSubpathRes = middleware(makeReq('/dev/crypto-bench/x'));
      expect(devBenchSubpathRes.headers.get('x-middleware-rewrite')).toBe(
        'http://localhost:3040/en/dev/crypto-bench/x',
      );
      const devBenchmarkPrefixRes = middleware(makeReq('/dev/crypto-benchmark'));
      expect(devBenchmarkPrefixRes.headers.get('x-middleware-rewrite')).toBe(
        'http://localhost:3040/en/dev/crypto-benchmark',
      );
      const devOtherRes = middleware(makeReq('/dev/other'));
      expect(devOtherRes.headers.get('x-middleware-rewrite')).toBe(
        'http://localhost:3040/en/dev/other',
      );
      const rootRes = middleware(makeReq('/'));
      expect(rootRes.headers.get('x-middleware-rewrite')).toBe('http://localhost:3040/en');
      expect(intlCalls).toEqual([
        '/dev/crypto-bench/x',
        '/dev/crypto-benchmark',
        '/dev/other',
        '/',
      ]);

      // Production /dev/crypto-bench and /dev/crypto-bench?x=1 go through next-intl as before
      vi.stubEnv('NODE_ENV', 'production');
      const prodBenchRes = middleware(makeReq('/dev/crypto-bench'));
      expect(prodBenchRes.headers.get('x-middleware-rewrite')).toBe(
        'http://localhost:3040/en/dev/crypto-bench',
      );
      const prodBenchQueryRes = middleware(makeReq('/dev/crypto-bench?x=1'));
      expect(prodBenchQueryRes.headers.get('x-middleware-rewrite')).toBe(
        'http://localhost:3040/en/dev/crypto-bench',
      );
      expect(intlCalls).toEqual([
        '/dev/crypto-bench/x',
        '/dev/crypto-benchmark',
        '/dev/other',
        '/',
        '/dev/crypto-bench',
        '/dev/crypto-bench',
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('/dev/crypto-bench page calls notFound() when NODE_ENV === production and supports both object and Promise searchParams for ?mode=harness in dev (advisor-dec-013, FE1-10, FE2-11f)', async () => {
    const defaultRendered = CryptoBenchPage() as {
      props: { children: { props: { children: { type: unknown } } } };
    };
    expect(defaultRendered.props.children.props.children.type).toBe(CryptoBenchClient);

    const harnessRendered = (await CryptoBenchPage({ searchParams: { mode: 'harness' } })) as {
      props: { children: { props: { children: { type: unknown } } } };
    };
    expect(harnessRendered.props.children.props.children.type).toBe(CryptoHarnessClient);

    const promiseHarnessRendered = (await CryptoBenchPage({
      searchParams: Promise.resolve({ mode: 'harness' }),
    })) as {
      props: { children: { props: { children: { type: unknown } } } };
    };
    expect(promiseHarnessRendered.props.children.props.children.type).toBe(CryptoHarnessClient);

    const promiseDefaultRendered = (await CryptoBenchPage({
      searchParams: Promise.resolve({ mode: 'bench' }),
    })) as {
      props: { children: { props: { children: { type: unknown } } } };
    };
    expect(promiseDefaultRendered.props.children.props.children.type).toBe(CryptoBenchClient);

    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => CryptoBenchPage()).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
      expect(() => CryptoBenchPage({ searchParams: { mode: 'harness' } })).toThrow(
        /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/,
      );
      expect(() =>
        CryptoBenchPage({ searchParams: Promise.resolve({ mode: 'harness' }) }),
      ).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
