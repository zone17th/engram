import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

async function cspFor(path: string): Promise<string> {
  const headers = await (nextConfig.headers?.() ?? Promise.resolve([]));
  const entry = headers.find((h) => h.source === '/:path*');
  expect(entry, 'next.config phải khai báo headers cho /:path*').toBeDefined();
  const csp = entry!.headers.find((h) => h.key === 'Content-Security-Policy');
  expect(csp, `thiếu CSP cho ${path}`).toBeDefined();
  return csp!.value;
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
});

describe('header bảo mật khác', () => {
  it('đặt Referrer-Policy và X-Content-Type-Options', async () => {
    const headers = await (nextConfig.headers?.() ?? Promise.resolve([]));
    const values = headers.flatMap((h) => h.headers).map((h) => h.key);
    expect(values).toContain('Referrer-Policy');
    expect(values).toContain('X-Content-Type-Options');
  });
});
