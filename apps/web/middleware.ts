import { NextResponse, type NextRequest } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { withRequestOrigin } from './i18n/internal-rewrite';
import { routing } from './i18n/routing';
import {
  CSP_NONCE_HEADER,
  buildCspForPathname,
  isAppRoute,
} from './lib/csp/manifest';

const intlMiddleware = createMiddleware(routing);

export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (process.env.NODE_ENV !== 'production' && pathname === '/dev/crypto-bench') {
    return NextResponse.next();
  }

  // `/app/*` is unprefixed and dynamic: skip `intlMiddleware` (NF-05: no locale
  // mutation in middleware) and emit a per-request CSP nonce.
  if (isAppRoute(pathname)) {
    const { csp, nonce } = buildCspForPathname(pathname);
    const requestHeaders = new Headers(request.headers ?? undefined);
    if (nonce) {
      requestHeaders.set(CSP_NONCE_HEADER, nonce);
    }
    requestHeaders.set('Content-Security-Policy', csp);
    const response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
    response.headers.set('Content-Security-Policy', csp);
    return response;
  }

  const response = intlMiddleware(request);
  // An origin change makes Next proxy back through middleware, looping /en -> /.
  for (const header of ['x-middleware-rewrite', 'location']) {
    const target = response.headers.get(header);
    if (target) {
      response.headers.set(header, withRequestOrigin(target, request.url, request.nextUrl.origin));
    }
  }
  const { csp } = buildCspForPathname(pathname);
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  runtime: 'nodejs',
  // Bao gồm cả `/app/*` (để phát CSP nonce mà không chạy `intlMiddleware`) và các
  // đường dẫn có dấu chấm không phải asset tĩnh (ví dụ `/foo.php`, `/vi/x.y` để
  // trang 404 nhận hash CSP của not-found shell — advisor-dec-P06-028). Loại trừ
  // `/api`, `/_next`, `/_vercel` và các phần mở rộng file tĩnh.
  matcher: [
    '/((?!api|_next|_vercel|.*\\.(?:ico|png|jpe?g|webp|svg|gif|txt|xml|json|webmanifest|js|mjs|css|map|wasm|woff2?|ttf|pdf)$).*)',
  ],
};
