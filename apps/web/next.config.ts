import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    // Dev đi qua MỘT origin: browser gọi /api/... trên localhost:3000,
    // Next chuyển tiếp sang Go. Nhờ vậy cookie path /api, credentials và CSP
    // không xung đột, và không phải cấu hình CORS/CSRF cho dev (P01 §UI và route).
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_UPSTREAM ?? 'http://127.0.0.1:8080'}/api/:path*`,
      },
    ];
  },
  async headers() {
    // Nguồn: SPEC §10.2. `wasm-unsafe-eval` là bắt buộc để libsodium-wrappers-sumo
    // chạy trong Web Worker ở P03; không thêm origin ngoài nào khác vì font đã
    // self-host qua next/font và CSS đã build sẵn.
    //
    // EXCEPTION P01 — 'unsafe-inline' ở script-src và style-src:
    // Next nhúng script inline (`self.__next_f.push(...)` chở RSC payload) vào
    // chính HTML tĩnh. Cách đúng là nonce sinh trong middleware theo từng
    // request, nhưng nonce ép Next render dynamic, còn landing phải là SSG để
    // đạt TTFB < 200 ms. Bỏ 'unsafe-inline' mà chưa có nonce = trang trắng,
    // không phải CSP chặt hơn. P06 chốt cách render landing rồi đóng exception.
    const csp = [
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
    ].join('; ');

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
