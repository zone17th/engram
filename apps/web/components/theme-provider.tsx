'use client';

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import type { Theme } from '@/lib/api/auth';
import { parseThemeCookie, setPreferenceCookies, themeToDataAttribute } from '@/lib/preferences/cookies';

type ResolvedTheme = 'light' | 'dark';

type ThemeContextValue = {
  theme: Theme;
  resolved: ResolvedTheme;
  setTheme: (next: Theme) => void;
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === 'light' || theme === 'dark') return theme;
  if (typeof window === 'undefined') return 'light';
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function readThemeCookie(): Theme | null {
  if (typeof document === 'undefined') return null;
  const raw = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('sabk_theme='))
    ?.slice('sabk_theme='.length);
  if (!raw) return null;
  try {
    return parseThemeCookie(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

export function ThemeProvider({
  children,
  initialTheme,
  initialLocale = 'en',
}: {
  children: ReactNode;
  initialTheme?: Theme;
  initialLocale?: 'en' | 'vi';
}) {
  const hasServerTheme = initialTheme !== undefined;
  const startingTheme = initialTheme ?? 'system';
  const [theme, setThemeState] = useState<Theme>(startingTheme);
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    startingTheme === 'system' ? 'light' : (startingTheme as ResolvedTheme),
  );
  const [locale] = useState(initialLocale);

  useEffect(() => {
    const cookieTheme = readThemeCookie();
    if (!hasServerTheme && theme === 'system' && cookieTheme && cookieTheme !== 'system') {
      setThemeState(cookieTheme);
      setResolved(cookieTheme);
      return;
    }
    setResolved(resolveTheme(theme));
  }, [hasServerTheme, theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.lang = locale;
  }, [resolved, locale]);

  useEffect(() => {
    if (theme !== 'system') return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setResolved(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback(
    (next: Theme) => {
      setThemeState(next);
      setPreferenceCookies(locale, next);
      setResolved(themeToDataAttribute(next));
    },
    [locale],
  );

  const toggle = useCallback(() => {
    setTheme(resolved === 'dark' ? 'light' : 'dark');
  }, [resolved, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme, toggle }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme phải nằm trong ThemeProvider');
  return ctx;
}
