import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeroDemo } from '../components/landing/hero-demo';
import enMessages from '../messages/en.json';
import viMessages from '../messages/vi.json';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('demo không được gọi mạng'))));
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

function renderHero(locale: 'en' | 'vi' = 'vi') {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? enMessages : viMessages}>
      <HeroDemo autoType={false} />
    </NextIntlClientProvider>,
  );
}

describe('HeroDemo', () => {
  // autoType={false} ở các ca tương tác: nếu để bật, chuỗi tự gõ chạy song song
  // với userEvent.type và làm test nhấp nháy.
  it('lọc kết quả khi gõ không dấu', async () => {
    renderHero();
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'ca phe');

    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText(/Cà phê sữa đá/)).toBeInTheDocument();
  });

  it('điều hướng bằng bàn phím và chọn bằng Enter (P01-A6)', async () => {
    renderHero();
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'ghi');
    await userEvent.keyboard('{ArrowDown}');

    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id);

    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('status')).toHaveTextContent(/Ghi chú họp thứ Ba/);
  });

  it('Escape đóng danh sách', async () => {
    renderHero();
    await userEvent.type(screen.getByRole('combobox'), 'ghi');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-activedescendant');
  });

  it('Ctrl/Cmd K đưa focus vào demo và dừng chuỗi tự gõ', async () => {
    vi.useFakeTimers();
    render(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <HeroDemo />
      </NextIntlClientProvider>,
    );
    const input = screen.getByRole('combobox') as HTMLInputElement;

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-expanded', 'true');

    input.blur();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(input).toHaveFocus();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(input.value).toBe('');

    vi.useRealTimers();
  });

  it('dừng chuỗi tự gõ khi người dùng chạm vào input', async () => {
    vi.useFakeTimers();
    render(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <HeroDemo />
      </NextIntlClientProvider>,
    );
    const input = screen.getByRole('combobox') as HTMLInputElement;
    fireEvent.pointerDown(input);
    input.focus();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(input.value).toBe('');

    vi.useRealTimers();
  });

  it('đóng listbox khi không có kết quả và xoá active descendant sau khi chọn', async () => {
    renderHero();
    const input = screen.getByRole('combobox');

    await userEvent.type(input, 'khong co ket qua');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-activedescendant');

    await userEvent.clear(input);
    await userEvent.type(input, 'ghi');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });

  it('không gọi mạng dù gõ gì đi nữa (P01-A5)', async () => {
    renderHero();
    await userEvent.type(screen.getByRole('combobox'), 'mật khẩu ngân hàng của tôi');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('nói rõ đây là dữ liệu mẫu và không claim đã mã hoá', () => {
    renderHero();
    expect(screen.getByText(/Dữ liệu mẫu/)).toBeInTheDocument();
    expect(screen.queryByText(/mã hoá|encrypted/i)).not.toBeInTheDocument();
  });

  it('tự gõ khi không bật reduced motion', async () => {
    vi.useFakeTimers();
    render(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <HeroDemo />
      </NextIntlClientProvider>,
    );
    const input = screen.getByRole('combobox') as HTMLInputElement;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(input.value).toBe('ca phe');
    vi.useRealTimers();
  });

  it('không tự gõ khi người dùng bật reduced motion (P01-A6)', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.useFakeTimers();
    render(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <HeroDemo />
      </NextIntlClientProvider>,
    );
    const input = screen.getByRole('combobox') as HTMLInputElement;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(input.value).toBe('');
    vi.useRealTimers();
  });

  it('dịch nhãn combobox và nội dung preview theo locale', async () => {
    renderHero('en');
    const input = screen.getByRole('combobox');

    expect(input).toHaveAccessibleName('Search sample notes');
    expect(input).toHaveAttribute('placeholder', 'Type a keyword…');
    expect(screen.getByRole('note')).toHaveTextContent('Sample data — type freely, nothing is sent anywhere.');

    await userEvent.type(input, 'ghi');
    expect(screen.getByRole('listbox')).toHaveAccessibleName('Sample results');

    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByRole('status')).toHaveTextContent('Selected Ghi chú họp thứ Ba');
  });
});
