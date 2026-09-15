import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeroDemo } from '../components/landing/hero-demo';

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

describe('HeroDemo', () => {
  // autoType={false} ở các ca tương tác: nếu để bật, chuỗi tự gõ chạy song song
  // với userEvent.type và làm test nhấp nháy.
  it('lọc kết quả khi gõ không dấu', async () => {
    render(<HeroDemo autoType={false} />);
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'ca phe');

    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText(/Cà phê sữa đá/)).toBeInTheDocument();
  });

  it('điều hướng bằng bàn phím và chọn bằng Enter (P01-A6)', async () => {
    render(<HeroDemo autoType={false} />);
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
    render(<HeroDemo autoType={false} />);
    await userEvent.type(screen.getByRole('combobox'), 'ghi');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('không gọi mạng dù gõ gì đi nữa (P01-A5)', async () => {
    render(<HeroDemo autoType={false} />);
    await userEvent.type(screen.getByRole('combobox'), 'mật khẩu ngân hàng của tôi');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('nói rõ đây là dữ liệu mẫu và không claim đã mã hoá', () => {
    render(<HeroDemo autoType={false} />);
    expect(screen.getByText(/Dữ liệu mẫu/)).toBeInTheDocument();
    expect(screen.queryByText(/mã hoá|encrypted/i)).not.toBeInTheDocument();
  });

  it('tự gõ khi không bật reduced motion', async () => {
    vi.useFakeTimers();
    render(<HeroDemo />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    await vi.advanceTimersByTimeAsync(5000);
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
    render(<HeroDemo />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    await vi.advanceTimersByTimeAsync(5000);
    expect(input.value).toBe('');
    vi.useRealTimers();
  });
});
