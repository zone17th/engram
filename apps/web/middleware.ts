import { NextResponse, type NextRequest } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { withRequestOrigin } from './i18n/internal-rewrite';
import { routing } from './i18n/routing';

const intlMiddleware = createMiddleware(routing);

export default function middleware(request: NextRequest) {
  if (process.env.NODE_ENV !== 'production' && request.nextUrl.pathname === '/dev/crypto-bench') {
    return NextResponse.next();
  }
  const response = intlMiddleware(request);
  // An origin change makes Next proxy back through middleware, looping /en -> /.
  for (const header of ['x-middleware-rewrite', 'location']) {
    const target = response.headers.get(header);
    if (target) {
      response.headers.set(header, withRequestOrigin(target, request.url, request.nextUrl.origin));
    }
  }
  return response;
}

export const config = {
  // Loại trừ /api (proxy sang Go), /app (segment tĩnh, không prefix locale),
  // asset của Next và file tĩnh. Nếu middleware chạm /api, cookie path và
  // rewrite sẽ vênh nhau.
  matcher: ['/((?!api|app|_next|_vercel|.*\\..*).*)'],
};
