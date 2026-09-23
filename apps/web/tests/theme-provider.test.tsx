import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from '../components/theme-provider';

function Probe() {
  const { theme, resolved, toggle } = useTheme();
  return (
    <button type="button" onClick={toggle}>
      {theme}:{resolved}
    </button>
  );
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.lang = '';
  document.cookie = 'sabk_theme=; Max-Age=0; path=/';
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ThemeProvider', () => {
  it('hydrates the marketing theme from the preference cookie', async () => {
    document.cookie = 'sabk_theme=dark; path=/';
    render(
      <ThemeProvider initialLocale="en">
        <Probe />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button')).toHaveTextContent('dark:dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });

  it('keeps an explicitly selected system theme when a stale cookie exists', async () => {
    document.cookie = 'sabk_theme=dark; path=/';
    render(
      <ThemeProvider initialTheme="system" initialLocale="en">
        <Probe />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button')).toHaveTextContent('system:light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
  });

  it('preserves the marketing locale while applying the theme', async () => {
    render(
      <ThemeProvider initialLocale="vi">
        <Probe />
      </ThemeProvider>,
    );

    await waitFor(() => expect(document.documentElement.lang).toBe('vi'));
  });

  it('mặc định system và resolve light khi OS sáng', () => {
    render(
      <ThemeProvider initialTheme="system" initialLocale="en">
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('system:light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('áp dụng theme dark từ props', () => {
    render(
      <ThemeProvider initialTheme="dark" initialLocale="vi">
        <Probe />
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.lang).toBe('vi');
  });

  it('dùng theme hệ thống tối khi OS dark', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    render(
      <ThemeProvider initialTheme="system" initialLocale="en">
        <Probe />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button')).toHaveTextContent('system:dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });

  it('toggle đổi data-theme', async () => {
    render(
      <ThemeProvider initialTheme="light" initialLocale="en">
        <Probe />
      </ThemeProvider>,
    );
    await act(async () => {
      await userEvent.click(screen.getByRole('button'));
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
