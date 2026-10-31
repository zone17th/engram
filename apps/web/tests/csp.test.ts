import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

async function headerRules() {
  return await (nextConfig.headers?.() ?? Promise.resolve([]));
}

function matchesSource(source: string, path: string): boolean {
  if (source === '/:path*') return true;
  if (source === '/app/auth/:path*') return path.startsWith('/app/auth/');
  return source === path;
}

async function effectiveHeadersFor(path: string): Promise<Map<string, string>> {
  const effective = new Map<string, string>();
  for (const rule of await headerRules()) {
    if (!matchesSource(rule.source, path)) continue;
    for (const header of rule.headers) effective.set(header.key, header.value);
  }
  return effective;
}

async function cspFor(path: string): Promise<string> {
  const csp = (await effectiveHeadersFor(path)).get('Content-Security-Policy');
  expect(csp, `thiếu CSP hiệu lực cho ${path}`).toBeDefined();
  return csp!;
}

describe('CSP (SPEC §10.2 + exception P01)', () => {
  it('khoá default-src về self', async () => {
    expect(await cspFor('/')).toContain("default-src 'self'");
  });

  it('cho phép wasm-unsafe-eval để libsodium chạy trong worker', async () => {
    expect(await cspFor('/')).toContain("'wasm-unsafe-eval'");
  });

  /**
   * Test này KHOÁ exception lại thay vì lờ đi: nếu ai đó bỏ 'unsafe-inline'
   * mà chưa dựng nonce, test đỏ và họ biết là landing sẽ hỏng hydration, chứ
   * không phải "siết CSP thành công". Khi P06 dựng nonce xong thì đổi test này
   * sang `not.toContain("'unsafe-inline'")` + `toMatch(/'nonce-/)`.
   */
  it('exception P01: script-src và style-src còn unsafe-inline, chưa có nonce', async () => {
    const csp = await cspFor('/');
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).not.toMatch(/'nonce-/);
  });

  it('exception chỉ nới inline, không nới origin ngoài', async () => {
    const csp = await cspFor('/');
    expect(csp).not.toContain("'unsafe-eval'; ");
    expect(csp).not.toMatch(/script-src[^;]*https?:\/\//);
  });

  it('chặn nhúng iframe và object', async () => {
    const csp = await cspFor('/');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('connect-src chỉ self — không cho gọi origin khác', async () => {
    const csp = await cspFor('/');
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/connect-src[^;]*https?:\/\//);
  });

  it('không cho phép font/style từ CDN ngoài', async () => {
    const csp = await cspFor('/');
    expect(csp).not.toContain('fonts.gstatic.com');
    expect(csp).not.toContain('cdn.tailwindcss.com');
  });

  it('pin chính xác từng byte chuỗi CSP chuẩn (gồm worker-src self blob: cho Turbopack theo advisor-dec-014) và chỉ cho phép blob: trong worker-src', async () => {
    const csp = await cspFor('/');
    const authCsp = await cspFor('/app/auth/login');

    expect(csp).toBe(
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
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
    expect(authCsp).toBe(
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://challenges.cloudflare.com",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self' https://challenges.cloudflare.com",
        "frame-src https://challenges.cloudflare.com",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "worker-src 'self' blob:",
      ].join('; '),
    );

    for (const policy of [csp, authCsp]) {
      const directives = policy.split('; ');
      const blobDirectives = directives.filter((d) => d.includes('blob:'));
      expect(blobDirectives).toEqual(["worker-src 'self' blob:"]);
    }
  });
});

describe('header bảo mật khác', () => {
  it('auth dùng policy cụ thể sau khi áp dụng catch-all', async () => {
    const headers = await headerRules();
    const catchAllIndex = headers.findIndex((h) => h.source === '/:path*');
    const authIndex = headers.findIndex((h) => h.source === '/app/auth/:path*');
    expect(catchAllIndex).toBeGreaterThanOrEqual(0);
    expect(authIndex).toBeGreaterThan(catchAllIndex);

    const csp = await cspFor('/app/auth/login');
    expect(csp).toContain('https://challenges.cloudflare.com');
    expect((await effectiveHeadersFor('/app/auth/login')).get('Referrer-Policy')).toBe('no-referrer');
    expect((await effectiveHeadersFor('/app/auth/login')).get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('đặt baseline Referrer-Policy cho các route khác', async () => {
    const headers = await effectiveHeadersFor('/');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});
