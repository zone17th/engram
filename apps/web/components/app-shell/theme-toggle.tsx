'use client';

import { useTranslations } from 'next-intl';
import { useTheme } from '@/components/theme-provider';

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  let toggleLabel = 'Đổi giao diện sáng/tối';
  let titleLabel = theme === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối';
  try {
    const t = useTranslations('auth.theme');
    toggleLabel = t('toggle');
    titleLabel = theme === 'dark' ? t('switchToLight') : t('switchToDark');
  } catch {
    // Fallback for standalone unit tests without NextIntlClientProvider.
  }
  return (
    <button
      type="button"
      className="btn btn-tertiary !px-3"
      onClick={toggle}
      aria-label={toggleLabel}
      title={titleLabel}
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}
