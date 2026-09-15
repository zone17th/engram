import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from '../components/theme-provider';

function Probe() {
  const { theme, toggle } = useTheme();
  return (
    <button type="button" onClick={toggle}>
      {theme}
    </button>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ThemeProvider', () => {
  it('mặc định light khi chưa có lựa chọn nào', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('đọc lại lựa chọn đã lưu', () => {
    localStorage.setItem('engram.theme', 'dark');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('dùng theme hệ thống khi chưa có lựa chọn lưu', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    expect(screen.getByRole('button')).toHaveTextContent('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('không vỡ khi trình duyệt chặn localStorage', async () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('light');

    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button')).toHaveTextContent('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('giữ hydration ổn định trước khi áp dụng theme đã lưu', async () => {
    const browserWindow = window;
    vi.stubGlobal('window', undefined);
    const serverMarkup = renderToString(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    vi.stubGlobal('window', browserWindow);

    expect(serverMarkup).toContain('>light</button>');
    localStorage.setItem('engram.theme', 'dark');

    const container = document.createElement('div');
    container.innerHTML = serverMarkup;
    document.body.appendChild(container);
    const recoverableErrors: unknown[] = [];

    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(
        container,
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
        { onRecoverableError: (error) => recoverableErrors.push(error) },
      );
    });

    expect(recoverableErrors).toEqual([]);
    expect(container.querySelector('button')).toHaveTextContent('dark');
    await act(async () => {
      root?.unmount();
    });
    container.remove();
  });

  it('toggle đổi data-theme và lưu lại', async () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await act(async () => {
      await userEvent.click(screen.getByRole('button'));
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('engram.theme')).toBe('dark');
  });
});
