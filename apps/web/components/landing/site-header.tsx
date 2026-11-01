'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Logo } from '@/components/landing/logo';
import { useTheme } from '@/components/theme-provider';

/**
 * Nav pill của landing — chép rhythm từ mockups/landing.html.
 * Theme toggle dùng ThemeProvider (Task 11). Hai CTA như mockup: "Đăng nhập" (ẩn dưới sm)
 * và "Tạo tài khoản", mở các trang auth thật (advisor-dec-186/187, audit UIA-5).
 * Ba link mục hiện từ `lg` (mockup: `md`): ở 768 pill không đủ chỗ cho cả link lẫn hai CTA
 * (RV-UI2-2). 390 và 1440 không đổi.
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
        <div className="ml-4 hidden items-center gap-1 lg:flex">
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
          <Link
            href="/app/auth/login"
            className="btn btn-tertiary no-underline !text-body hidden sm:inline-flex"
          >
            {t('signIn')}
          </Link>
          <Link href="/app/auth/signup" className="btn btn-primary no-underline">
            {t('signUp')}
          </Link>
        </div>
      </nav>
    </div>
  );
}
