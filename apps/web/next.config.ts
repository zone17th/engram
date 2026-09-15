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
};

export default withNextIntl(nextConfig);
