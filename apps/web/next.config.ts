import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';
import {
  HSTS_HEADER_VALUE,
  PERMISSIONS_POLICY_HEADER_VALUE,
  STATIC_DOTTED_CSP_HEADER_VALUE,
  STATIC_DOTTED_PATH_SOURCE,
} from './lib/csp/manifest';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Keep the raw origin available when NextURL normalizes loopback addresses.
  skipMiddlewareUrlNormalize: true,
  async rewrites() {
    // Dev đi qua MỘT origin: browser gọi /api/... trên localhost:3000,
    // Next chuyển tiếp sang Go (kèm X-Forwarded-For). API chỉ tin header đó
    // khi peer nằm trong AUTH_TRUSTED_PROXY_CIDRS (dev mặc định: loopback +
    // dải private). Cookie path /api, credentials và CSP không xung đột;
    // không cấu hình CORS/CSRF cho origin khác (P01 §UI và route).
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_UPSTREAM ?? 'http://127.0.0.1:8080'}/api/:path*`,
      },
    ];
  },
  async headers() {
    // Nguồn: SPEC §10.2 & P06 Task 8 (FE-R1-09, OQ-P06-4, advisor-dec-P06-024).
    // Các route không có dấu chấm đi qua `middleware.ts` (Node runtime): `/app/*`
    // nhận nonce mỗi request, còn trang marketing/SSG nhận danh sách `sha256-`.
    // Các đường dẫn có dấu chấm ngoài `_next`/`api`/`_vercel` (ví dụ `/foo.php`,
    // `/vi/x.y`) bị matcher của middleware bỏ qua nên nhận CSP tĩnh fail-closed
    // từ `headers()` với tập nguồn hoàn toàn rời nhau (disjoint).
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Strict-Transport-Security', value: HSTS_HEADER_VALUE },
          { key: 'Permissions-Policy', value: PERMISSIONS_POLICY_HEADER_VALUE },
        ],
      },
      {
        source: '/app/auth/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Strict-Transport-Security', value: HSTS_HEADER_VALUE },
          { key: 'Permissions-Policy', value: PERMISSIONS_POLICY_HEADER_VALUE },
        ],
      },
      {
        source: '/app/auth/reset-password',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Strict-Transport-Security', value: HSTS_HEADER_VALUE },
          { key: 'Permissions-Policy', value: PERMISSIONS_POLICY_HEADER_VALUE },
        ],
      },
      {
        source: STATIC_DOTTED_PATH_SOURCE,
        headers: [
          { key: 'Content-Security-Policy', value: STATIC_DOTTED_CSP_HEADER_VALUE },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
