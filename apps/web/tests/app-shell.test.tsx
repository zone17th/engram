import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AppHeader } from '../components/app-shell/app-header';
import { EmptyState } from '../components/app-shell/empty-state';
import { Omnibox } from '../components/app-shell/omnibox';
import { PreviewNotice } from '../components/app-shell/preview-notice';
import { Rail } from '../components/app-shell/rail';
import { ThemeProvider } from '../components/theme-provider';
import { UndoToastProvider } from '../components/ui/undo-toast';
import { contentQueryKeys } from '../features/items/query-keys';
import type { Tag } from '../lib/api/content';
import viMessages from '../messages/vi.json';

function renderWithTheme(ui: ReactNode) {
  return render(
    <NextIntlClientProvider locale="vi" messages={viMessages}>
      <ThemeProvider>{ui}</ThemeProvider>
    </NextIntlClientProvider>,
  );
}

const WEB_ROOT = resolve(__dirname, '..');

describe('AppHeader', () => {
  it('luôn hiện chữ engram viết thường', () => {
    renderWithTheme(<AppHeader vault={{ state: 'open', minutesLeft: 15 }} />);
    expect(screen.getByText('engram')).toBeInTheDocument();
    expect(screen.queryByText('Engram')).not.toBeInTheDocument();
  });

  it('phản ánh trạng thái vault được truyền vào', () => {
    const { rerender } = renderWithTheme(<AppHeader vault={{ state: 'open', minutesLeft: 15 }} />);
    expect(screen.getByText(/15 phút/)).toBeInTheDocument();

    rerender(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <ThemeProvider>
          <AppHeader vault={{ state: 'locked' }} />
        </ThemeProvider>
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(/Vault đang khoá/)).toBeInTheDocument();
  });

  it('đưa tới settings và có nút đổi theme', () => {
    renderWithTheme(<AppHeader vault={{ state: 'locked' }} />);
    expect(screen.getByRole('link', { name: 'Cài đặt' })).toHaveAttribute('href', '/app/settings');
    expect(screen.getByRole('button', { name: 'Đổi giao diện sáng/tối' })).toBeInTheDocument();
  });
});

describe('Rail', () => {
  const SAMPLE_TAGS: Tag[] = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      display: 'nhà',
      item_count: 12,
      last_used_at: '2026-11-01T00:00:00Z',
      created_at: '2026-11-01T00:00:00Z',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      display: 'ops',
      item_count: 7,
      last_used_at: '2026-11-01T00:00:00Z',
      created_at: '2026-11-01T00:00:00Z',
    },
  ];

  function renderRailWithTags(ui: ReactNode, tags: Tag[] = SAMPLE_TAGS) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(contentQueryKeys.tags({ sort: 'recent' }), {
      items: tags,
      next_cursor: null,
    });
    return render(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <QueryClientProvider client={queryClient}>
          <UndoToastProvider>{ui}</UndoToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
  }

  it('liệt kê tag kèm số lượng và không còn danh sách Gần đây hay công tắc Gần nghĩa demo', () => {
    renderRailWithTags(<Rail />);
    expect(screen.getByRole('navigation', { name: 'Bộ lọc tag' })).toBeInTheDocument();
    expect(screen.getByText('#nhà')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /Gần nghĩa/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Gần đây')).not.toBeInTheDocument();
  });

  it('chọn và bỏ lọc tag theo ID', () => {
    const onSelectTag = vi.fn();
    const { rerender } = renderRailWithTags(
      <Rail selectedTagId={null} onSelectTag={onSelectTag} />,
    );
    fireEvent.click(screen.getByTestId(`rail-tag-filter-${SAMPLE_TAGS[0].id}`));
    expect(onSelectTag).toHaveBeenCalledWith(SAMPLE_TAGS[0].id);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(contentQueryKeys.tags({ sort: 'recent' }), {
      items: SAMPLE_TAGS,
      next_cursor: null,
    });
    rerender(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <QueryClientProvider client={queryClient}>
          <UndoToastProvider>
            <Rail selectedTagId={SAMPLE_TAGS[0].id} onSelectTag={onSelectTag} />
          </UndoToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    const clearBtn = screen.getByTestId('rail-clear-filter');
    fireEvent.click(clearBtn);
    expect(onSelectTag).toHaveBeenLastCalledWith(null);
  });
});

describe('EmptyState', () => {
  it('hiện tiêu đề, mô tả và hành động', () => {
    render(<EmptyState title="Chưa có gì ở đây" body="Lưu mục đầu tiên." action={{ label: 'Thử lại', onAction: () => {} }} />);
    expect(screen.getByRole('heading', { name: 'Chưa có gì ở đây' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeInTheDocument();
  });
});

describe('Omnibox', () => {
  it('focus bằng Ctrl K và lọc dữ liệu mẫu cục bộ', async () => {
    render(<Omnibox />);
    const input = screen.getByRole('combobox', { name: 'Tìm hoặc lưu' });

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: 'ca phe' } });
    expect(await screen.findByRole('option', { name: /Cà phê sữa đá tỉ lệ 1:2/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Cà phê sữa đá tỉ lệ 1:2/ })).toHaveAttribute(
      'href',
      '/app/items/d1',
    );
  });

  it('hỗ trợ Cmd K và Escape đóng gợi ý', () => {
    render(<Omnibox />);
    const input = screen.getByRole('combobox', { name: 'Tìm hoặc lưu' });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: 'ghi' } });
    expect(screen.getByRole('listbox', { name: 'Gợi ý' })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Gợi ý' })).not.toBeInTheDocument();
  });

  it('xoá lựa chọn và aria-activedescendant khi mất focus hoặc đóng danh sách', () => {
    render(<Omnibox />);
    const input = screen.getByRole('combobox', { name: 'Tìm hoặc lưu' });

    fireEvent.change(input, { target: { value: 'ghi' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant');

    fireEvent.blur(input, { relatedTarget: document.body });
    expect(input).not.toHaveAttribute('aria-activedescendant');
    expect(screen.queryByRole('listbox', { name: 'Gợi ý' })).not.toBeInTheDocument();

    const enter = createEvent.keyDown(input, { key: 'Enter' });
    fireEvent(input, enter);
    expect(enter.defaultPrevented).toBe(false);
  });

  it('xoá lựa chọn khi mở một mục từ danh sách', () => {
    render(<Omnibox />);
    const input = screen.getByRole('combobox', { name: 'Tìm hoặc lưu' });

    fireEvent.change(input, { target: { value: 'ghi' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const item = screen.getByRole('option', { name: /Ghi chú họp thứ Ba/ });
    const click = createEvent.click(item);
    click.preventDefault();
    fireEvent(item, click);

    expect(input).not.toHaveAttribute('aria-activedescendant');
    expect(screen.queryByRole('listbox', { name: 'Gợi ý' })).not.toBeInTheDocument();
  });

  it('hiển thị phím tắt Ctrl K ở ô tìm kiếm thu gọn', () => {
    render(<Omnibox compact />);
    expect(screen.getByText('Ctrl K')).toBeInTheDocument();
    expect(screen.queryByText('/')).not.toBeInTheDocument();
  });
});

describe('PreviewNotice', () => {
  it('nói rõ bản xem trước chỉ đọc và dùng dữ liệu mẫu', () => {
    render(<PreviewNotice />);
    expect(screen.getByRole('status')).toHaveTextContent(/dữ liệu mẫu/i);
    expect(screen.getByRole('status')).toHaveTextContent(/thay đổi không được lưu/i);
  });
});

describe('App shell routes', () => {
  it('có đủ route canonical cho detail và settings preview', () => {
    expect(existsSync(resolve(WEB_ROOT, 'app', 'app', 'items', '[id]', 'page.tsx'))).toBe(true);
    expect(existsSync(resolve(WEB_ROOT, 'app', 'app', 'settings', 'page.tsx'))).toBe(true);
  });
});
