import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

export default createMiddleware(routing);

export const config = {
  // Loại trừ /api (proxy sang Go), /app (segment tĩnh, không prefix locale),
  // asset của Next và file tĩnh. Nếu middleware chạm /api, cookie path và
  // rewrite sẽ vênh nhau.
  matcher: ['/((?!api|app|_next|_vercel|.*\\..*).*)'],
};
