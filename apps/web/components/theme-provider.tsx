'use client';

import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'engram.theme';

const ThemeContext = createContext<{ theme: Theme; toggle: () => void } | null>(null);

function initialTheme(): Theme {
  // SSR và lần render đầu phía client phải cùng giá trị; preference đọc sau hydration.
  return 'light';
}

function readStoredTheme(): Theme | null {
  if (typeof window === 'undefined') return null;

  try {
    const saved = window.localStorage?.getItem?.(STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : null;
  } catch {
    // Storage có thể không dùng được ở chế độ riêng tư hoặc khi origin bị chặn.
    return null;
  }
}

function resolveClientTheme(): Theme {
  const saved = readStoredTheme();
  if (saved) return saved;

  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function persistTheme(theme: Theme) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage?.setItem?.(STORAGE_KEY, theme);
  } catch {
    // Vẫn đổi giao diện được khi trình duyệt từ chối lưu bền vững.
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    setTheme(resolveClientTheme());
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === 'light' ? 'dark' : 'light';
      persistTheme(next);
      return next;
    });
  }, []);

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme phải nằm trong ThemeProvider');
  return ctx;
}
