import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = resolve(__dirname, '..');

describe('cấu trúc route (P01-A3)', () => {
  it('app riêng tư nằm ở segment tĩnh /app, không dưới [locale]', () => {
    expect(existsSync(resolve(WEB, 'app/app/page.tsx'))).toBe(true);
    expect(existsSync(resolve(WEB, 'app/(marketing)/[locale]/app'))).toBe(false);
  });

  it('middleware i18n không chạm /api và /app', () => {
    const mw = readFileSync(resolve(WEB, 'middleware.ts'), 'utf8');
    expect(mw).toContain('?!api|app');
  });

  it('next.config proxy /api sang upstream Go', () => {
    const config = readFileSync(resolve(WEB, 'next.config.ts'), 'utf8');
    expect(config).toContain("source: '/api/:path*'");
    expect(config).toContain('API_UPSTREAM');
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
    expect(layout).toContain('<html lang={APP_LOCALE}');
    expect(layout).toContain('locale={APP_LOCALE}');
    expect(layout).not.toContain('locale="vi"');
  });
});
