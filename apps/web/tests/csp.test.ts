import fs from 'node:fs';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const intlCalls: string[] = [];
const mockCookies = new Map<string, string>();
const mockHeaders = new Map<string, string>();

vi.mock('next-intl/middleware', () => ({
  default: () => (req: { url: string; nextUrl: { pathname: string; origin: string } }) => {
    intlCalls.push(req.nextUrl.pathname);
    return new Response(null, {
      headers: {
        'x-middleware-rewrite': `${req.nextUrl.origin}/en${
          req.nextUrl.pathname === '/' ? '' : req.nextUrl.pathname
        }`,
      },
    });
  },
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = mockCookies.get(name);
      return value !== undefined ? { name, value } : undefined;
    },
  }),
  headers: async () => ({
    get: (name: string) => mockHeaders.get(name.toLowerCase()) ?? null,
  }),
}));

import { resolveAppLocale } from '../i18n/app-locale';
import {
  HSTS_HEADER_VALUE,
  PERMISSIONS_POLICY_HEADER_VALUE,
  resetCspManifestCacheForTests,
} from '../lib/csp/manifest';
import middleware, { config as middlewareConfig } from '../middleware';
import nextConfig from '../next.config';

const SAMPLE_ROOT_HASH = "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='";
const SAMPLE_VI_PRIVACY_HASH = "'sha256-LCa0a2j/xo/5m0U8HTBBNBNCLXBkg7+g+YpeiGJm564='";

const SAMPLE_MANIFEST_JSON = JSON.stringify({
  version: 1,
  routes: {
    '/': [SAMPLE_ROOT_HASH],
    '/en': [SAMPLE_ROOT_HASH],
    '/vi': [SAMPLE_ROOT_HASH],
    '/privacy': [SAMPLE_VI_PRIVACY_HASH],
    '/vi/privacy': [SAMPLE_VI_PRIVACY_HASH],
  },
});

function makeRequest(pathname: string, headersInit?: Record<string, string>): NextRequest {
  const url = `https://engram.zone17.click${pathname}`;
  return {
    url,
    headers: new Headers(headersInit),
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

function matchesSource(source: string, pathname: string): boolean {
  if (source === '/:path*') return true;
  if (source === '/app/auth/:path*') return pathname.startsWith('/app/auth/');
  return source === pathname;
}

async function effectiveStaticHeadersFor(pathname: string): Promise<Map<string, string>> {
  const effective = new Map<string, string>();
  for (const rule of await (nextConfig.headers?.() ?? Promise.resolve([]))) {
    if (!matchesSource(rule.source, pathname)) continue;
    for (const header of rule.headers) effective.set(header.key, header.value);
  }
  return effective;
}

function getScriptSrcDirective(csp: string): string {
  const directive = csp
    .split('; ')
    .find((part) => part.startsWith('script-src '));
  expect(directive, `missing script-src in CSP: ${csp}`).toBeDefined();
  return directive!;
}

describe('CSP single emitter & production script-src hardening (SPEC §10.2, P06 Task 8)', () => {
  beforeEach(() => {
    intlCalls.length = 0;
    mockCookies.clear();
    mockHeaders.clear();
    resetCspManifestCacheForTests();
    vi.stubEnv('NODE_ENV', 'production');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetCspManifestCacheForTests();
  });

  it('removes Content-Security-Policy from next.config.ts headers() so middleware is the single CSP emitter', async () => {
    const rules = await (nextConfig.headers?.() ?? Promise.resolve([]));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const keys = rule.headers.map((h) => h.key.toLowerCase());
      expect(keys).not.toContain('content-security-policy');
    }
  });

  it('declares Node.js runtime and a matcher that includes /app/* while excluding /api, /_next, and static files', () => {
    expect(middlewareConfig.runtime).toBe('nodejs');
    expect(middlewareConfig.matcher).toEqual(['/((?!api|_next|_vercel|.*\\..*).*)']);

    const pattern = new RegExp(`^${middlewareConfig.matcher[0]}$`);
    expect(pattern.test('/')).toBe(true);
    expect(pattern.test('/vi')).toBe(true);
    expect(pattern.test('/vi/privacy')).toBe(true);
    expect(pattern.test('/app')).toBe(true);
    expect(pattern.test('/app/unlock')).toBe(true);
    expect(pattern.test('/app/settings')).toBe(true);
    expect(pattern.test('/app/auth/login')).toBe(true);
    expect(pattern.test('/app/auth/reset-password')).toBe(true);

    expect(pattern.test('/api/v1/auth/me')).toBe(false);
    expect(pattern.test('/_next/static/chunks/main.js')).toBe(false);
    expect(pattern.test('/_vercel/insights')).toBe(false);
    expect(pattern.test('/favicon.ico')).toBe(false);
    expect(pattern.test('/.well-known/csp-hashes.json')).toBe(false);
    expect(pattern.test('/.well-known/build-manifest.json')).toBe(false);
  });

  it('emits per-request nonce CSP on /app/* without unsafe-inline or unsafe-eval and without calling intlMiddleware', () => {
    const res1 = middleware(makeRequest('/app/unlock'));
    const res2 = middleware(makeRequest('/app/unlock'));
    expect(intlCalls).toEqual([]);

    const csp1 = res1.headers.get('Content-Security-Policy') ?? '';
    const csp2 = res2.headers.get('Content-Security-Policy') ?? '';
    expect(csp1).toContain("default-src 'self'");
    expect(csp1).toContain("'wasm-unsafe-eval'");
    expect(csp1).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp1).toContain("frame-ancestors 'none'");
    expect(csp1).toContain("object-src 'none'");
    expect(csp1).toContain("worker-src 'self' blob:");

    const scriptSrc1 = getScriptSrcDirective(csp1);
    const scriptSrc2 = getScriptSrcDirective(csp2);
    expect(scriptSrc1).not.toContain("'unsafe-inline'");
    expect(scriptSrc1).not.toContain("'unsafe-eval'");
    expect(scriptSrc1).not.toContain('challenges.cloudflare.com');

    const nonceMatch1 = scriptSrc1.match(/'nonce-([A-Za-z0-9+/=]+)'/);
    const nonceMatch2 = scriptSrc2.match(/'nonce-([A-Za-z0-9+/=]+)'/);
    expect(nonceMatch1).not.toBeNull();
    expect(nonceMatch2).not.toBeNull();
    expect(nonceMatch1![1]).not.toBe(nonceMatch2![1]);
    expect(Buffer.from(nonceMatch1![1], 'base64').length).toBe(16);

    // Forwards x-nonce and Content-Security-Policy to downstream Next server rendering
    expect(res1.headers.get('x-middleware-request-x-nonce')).toBe(nonceMatch1![1]);
    expect(res1.headers.get('x-middleware-request-content-security-policy')).toBe(csp1);
  });

  it('adds Turnstile origin only on /app/auth/* except /app/auth/reset-password, and restricts blob: to worker-src', () => {
    const loginCsp = middleware(makeRequest('/app/auth/login')).headers.get('Content-Security-Policy') ?? '';
    const forgotCsp =
      middleware(makeRequest('/app/auth/forgot-password')).headers.get('Content-Security-Policy') ?? '';
    const resetCsp =
      middleware(makeRequest('/app/auth/reset-password')).headers.get('Content-Security-Policy') ?? '';

    for (const authCsp of [loginCsp, forgotCsp]) {
      const scriptSrc = getScriptSrcDirective(authCsp);
      expect(scriptSrc).not.toContain("'unsafe-inline'");
      expect(scriptSrc).not.toContain("'unsafe-eval'");
      expect(scriptSrc).toContain("'wasm-unsafe-eval'");
      expect(scriptSrc).toContain('https://challenges.cloudflare.com');
      expect(authCsp).toContain("connect-src 'self' https://challenges.cloudflare.com");
      expect(authCsp).toContain('frame-src https://challenges.cloudflare.com');
    }

    const resetScriptSrc = getScriptSrcDirective(resetCsp);
    expect(resetScriptSrc).not.toContain("'unsafe-inline'");
    expect(resetScriptSrc).not.toContain("'unsafe-eval'");
    expect(resetScriptSrc).toContain("'wasm-unsafe-eval'");
    expect(resetCsp).not.toContain('challenges.cloudflare.com');
    expect(resetCsp).toContain("connect-src 'self'");

    for (const policy of [loginCsp, resetCsp]) {
      const directives = policy.split('; ');
      const blobDirectives = directives.filter((d) => d.includes('blob:'));
      expect(blobDirectives).toEqual(["worker-src 'self' blob:"]);
      expect(policy).not.toContain('fonts.gstatic.com');
      expect(policy).not.toContain('cdn.tailwindcss.com');
    }
  });

  it('reads public/.well-known/csp-hashes.json from disk once, caches it module-globally without fetch, and emits sha256 CSP on marketing routes', () => {
    const expectedPath = path.join(process.cwd(), 'public/.well-known/csp-hashes.json');
    const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(SAMPLE_MANIFEST_JSON);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const rootRes = middleware(makeRequest('/'));
    const viPrivacyRes = middleware(makeRequest('/vi/privacy'));

    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledWith(expectedPath, 'utf8');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(intlCalls).toEqual(['/', '/vi/privacy']);

    const rootCsp = rootRes.headers.get('Content-Security-Policy') ?? '';
    const viPrivacyCsp = viPrivacyRes.headers.get('Content-Security-Policy') ?? '';

    expect(rootCsp).toBe(
      [
        "default-src 'self'",
        `script-src 'self' ${SAMPLE_ROOT_HASH}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "worker-src 'self' blob:",
      ].join('; '),
    );
    expect(viPrivacyCsp).toContain(`script-src 'self' ${SAMPLE_VI_PRIVACY_HASH}`);

    for (const policy of [rootCsp, viPrivacyCsp]) {
      const scriptSrc = getScriptSrcDirective(policy);
      expect(scriptSrc).not.toContain("'unsafe-inline'");
      expect(scriptSrc).not.toContain("'unsafe-eval'");
      expect(scriptSrc).not.toMatch(/'nonce-/);
    }
  });

  it('fails closed to script-src self and logs console.error once when csp-hashes.json is missing or route is absent', () => {
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res1 = middleware(makeRequest('/'));
    const res2 = middleware(makeRequest('/vi/privacy'));

    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    for (const res of [res1, res2]) {
      const csp = res.headers.get('Content-Security-Policy') ?? '';
      const scriptSrc = getScriptSrcDirective(csp);
      expect(scriptSrc).toBe("script-src 'self'");
      expect(scriptSrc).not.toContain("'unsafe-inline'");
      expect(scriptSrc).not.toContain("'unsafe-eval'");
    }

    // Also test missing route entry inside a valid manifest
    resetCspManifestCacheForTests();
    readSpy.mockReturnValue(SAMPLE_MANIFEST_JSON);
    errorSpy.mockClear();

    const unmapped1 = middleware(makeRequest('/unknown-route'));
    const unmapped2 = middleware(makeRequest('/another-unmapped'));
    expect(getScriptSrcDirective(unmapped1.headers.get('Content-Security-Policy') ?? '')).toBe(
      "script-src 'self'",
    );
    expect(getScriptSrcDirective(unmapped2.headers.get('Content-Security-Policy') ?? '')).toBe(
      "script-src 'self'",
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves /app/* locale behavior (NF-05: sabk_locale=en still resolves to en without middleware interference)', async () => {
    const req = makeRequest('/app/settings', {
      cookie: 'sabk_locale=en',
      'accept-language': 'vi-VN,vi;q=0.9',
    });
    const res = middleware(req);

    expect(intlCalls).toEqual([]);
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();

    mockCookies.set('sabk_locale', 'en');
    mockHeaders.set('accept-language', 'vi-VN,vi;q=0.9');
    expect(await resolveAppLocale()).toBe('en');
  });
});

describe('security headers & poweredByHeader in next.config.ts', () => {
  it('disables X-Powered-By header via poweredByHeader: false', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it('sets HSTS, Permissions-Policy, Referrer-Policy, X-Content-Type-Options, X-Frame-Options, and Cache-Control across route rules', async () => {
    const rules = await (nextConfig.headers?.() ?? Promise.resolve([]));
    const catchAllIndex = rules.findIndex((h) => h.source === '/:path*');
    const authIndex = rules.findIndex((h) => h.source === '/app/auth/:path*');
    const resetIndex = rules.findIndex((h) => h.source === '/app/auth/reset-password');
    expect(catchAllIndex).toBeGreaterThanOrEqual(0);
    expect(authIndex).toBeGreaterThan(catchAllIndex);
    expect(resetIndex).toBeGreaterThan(authIndex);

    const rootHeaders = await effectiveStaticHeadersFor('/');
    expect(rootHeaders.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(rootHeaders.get('X-Content-Type-Options')).toBe('nosniff');
    expect(rootHeaders.get('X-Frame-Options')).toBe('DENY');
    expect(rootHeaders.get('Strict-Transport-Security')).toBe(HSTS_HEADER_VALUE);
    expect(rootHeaders.get('Permissions-Policy')).toBe(PERMISSIONS_POLICY_HEADER_VALUE);

    const loginHeaders = await effectiveStaticHeadersFor('/app/auth/login');
    expect(loginHeaders.get('Referrer-Policy')).toBe('no-referrer');
    expect(loginHeaders.get('X-Content-Type-Options')).toBe('nosniff');
    expect(loginHeaders.get('X-Frame-Options')).toBe('DENY');
    expect(loginHeaders.get('Strict-Transport-Security')).toBe(HSTS_HEADER_VALUE);
    expect(loginHeaders.get('Permissions-Policy')).toBe(PERMISSIONS_POLICY_HEADER_VALUE);

    const resetHeaders = await effectiveStaticHeadersFor('/app/auth/reset-password');
    expect(resetHeaders.get('Referrer-Policy')).toBe('no-referrer');
    expect(resetHeaders.get('Cache-Control')).toBe('no-store');
    expect(resetHeaders.get('X-Content-Type-Options')).toBe('nosniff');
    expect(resetHeaders.get('X-Frame-Options')).toBe('DENY');
    expect(resetHeaders.get('Strict-Transport-Security')).toBe(HSTS_HEADER_VALUE);
    expect(resetHeaders.get('Permissions-Policy')).toBe(PERMISSIONS_POLICY_HEADER_VALUE);
  });
});
