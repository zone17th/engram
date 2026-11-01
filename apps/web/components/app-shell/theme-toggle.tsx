'use client';

import { useTranslations } from 'next-intl';
import { useTheme } from '@/components/theme-provider';

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const t = useTranslations('auth.theme');
  const toggleLabel = t('toggle');
  const titleLabel = theme === 'dark' ? t('switchToLight') : t('switchToDark');
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
