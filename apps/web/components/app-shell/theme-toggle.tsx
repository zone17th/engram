'use client';

import { useTheme } from '@/components/theme-provider';

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      type="button"
      className="btn btn-tertiary !px-3"
      onClick={toggle}
      aria-label="Đổi giao diện sáng/tối"
      title={theme === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}
