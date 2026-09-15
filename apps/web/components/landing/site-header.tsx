'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Logo } from '@/components/landing/logo';
import { useTheme } from '@/components/theme-provider';

/**
 * Nav pill của landing — chép rhythm từ mockups/landing.html.
 * Theme toggle dùng ThemeProvider (Task 11); CTA mở /app (preview UI).
 */
export function SiteHeader() {
  const t = useTranslations('nav');
  const { theme, toggle } = useTheme();
  const locale = useLocale();

  return (
    <div className="max-w-container mx-auto px-5 pt-5">
      <nav
        className="flex items-center gap-4 rounded-pill border border-line bg-canvas px-5 py-3"
        aria-label="Primary"
      >
        <a href={locale === 'en' ? '/' : `/${locale}`} className="no-underline">
          <Logo />
        </a>
        <div className="ml-4 hidden items-center gap-1 md:flex">
          <a
            href="#cachdung"
            className="no-underline !text-body rounded-md px-3 py-2 text-[15px] hover:bg-surface"
          >
            {t('how')}
          </a>
          <a
            href="#riengtu"
            className="no-underline !text-body rounded-md px-3 py-2 text-[15px] hover:bg-surface"
          >
            {t('privacy')}
          </a>
          <a
            href="#khoiphuc"
            className="no-underline !text-body rounded-md px-3 py-2 text-[15px] hover:bg-surface"
          >
            {t('recovery')}
          </a>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="btn btn-tertiary !px-3"
            onClick={toggle}
            aria-label={locale === 'vi' ? 'Đổi giao diện sáng/tối' : 'Toggle light/dark theme'}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <Link href="/app" className="btn btn-primary no-underline">
            {t('openApp')}
          </Link>
        </div>
      </nav>
    </div>
  );
}
