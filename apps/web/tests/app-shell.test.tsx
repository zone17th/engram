import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { DEMO_TAGS } from '../lib/demo-fixtures';
import enMessages from '../messages/en.json';
import viMessages from '../messages/vi.json';

function renderWithTheme(ui: ReactNode) {
  return render(
    <NextIntlClientProvider locale="vi" messages={viMessages}>
      <ThemeProvider>{ui}</ThemeProvider>
    </NextIntlClientProvider>,
  );
}

const WEB_ROOT = resolve(__dirname, '..');

// AppHeader shows Sign out by default (advisor-dec-186). The real button needs SessionProvider + VaultProvider; its
// behaviour is covered by the auth/vault suites, so here it is a stand-in that only proves where and how it renders.
vi.mock('../features/auth/route-guard', async () => {
  const { createElement } = await import('react');
  return {
    AppShellLogoutButton: ({ size = 'sm' }: { size?: 'sm' | 'md' }) =>
      createElement('button', { type: 'button', 'data-size': size }, 'Đăng xuất'),
  };
});

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

  // UIA-9/18 (advisor-dec-186): one header on every app route. The item page passes no showLogout flag.
  it('hiện Settings, theme và Đăng xuất cùng cỡ, theo thứ tự mockup, kể cả khi không truyền showLogout', () => {
    renderWithTheme(<AppHeader vault={{ state: 'locked' }} />);
    const settings = screen.getByRole('link', { name: 'Cài đặt' });
    const theme = screen.getByRole('button', { name: 'Đổi giao diện sáng/tối' });
    const signOut = screen.getByRole('button', { name: 'Đăng xuất' });
    expect(settings).toHaveClass('btn', 'btn-tertiary');
    expect(theme).toHaveClass('btn', 'btn-tertiary', 'btn-icon');
    expect(signOut).toHaveAttribute('data-size', 'md');
    expect(settings.compareDocumentPosition(theme) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(theme.compareDocumentPosition(signOut) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('showLogout={false} chỉ để render ngoài SessionProvider', () => {
    renderWithTheme(<AppHeader vault={{ state: 'locked' }} showLogout={false} />);
    expect(screen.queryByRole('button', { name: 'Đăng xuất' })).not.toBeInTheDocument();
  });
});

describe('Rail', () => {
  it('liệt kê tag kèm số lượng', () => {
    render(<Rail tags={DEMO_TAGS} semanticAvailable={false} />);
    expect(screen.getByText(DEMO_TAGS[0].name)).toBeInTheDocument();
    expect(screen.getByText(String(DEMO_TAGS[0].count))).toBeInTheDocument();
  });

  // SPEC §7 (sơ đồ omnibox): toggle semantic_suggest **ẩn** khi
  // semantic_available = false. Không render disabled — disabled vẫn là một lời
  // quảng cáo tính năng chưa có.
  it('ẩn hẳn toggle Gần nghĩa khi semantic không khả dụng', () => {
    render(<Rail tags={DEMO_TAGS} semanticAvailable={false} />);
    expect(screen.queryByRole('switch', { name: /Gần nghĩa/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Gần nghĩa/)).not.toBeInTheDocument();
  });

  it('hiện toggle Gần nghĩa khi semantic khả dụng', () => {
    render(<Rail tags={DEMO_TAGS} semanticAvailable />);
    const sw = screen.getByRole('switch', { name: /Gần nghĩa/ });
    expect(sw).not.toHaveAttribute('aria-disabled');
    expect(sw).toHaveAttribute('aria-checked', 'false');
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
    render(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <PreviewNotice />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/dữ liệu mẫu/i);
    expect(screen.getByRole('status')).toHaveTextContent(/thay đổi không được lưu/i);
  });

  // UIA-1: the en shell must not show the Vietnamese notice.
  it('uses the en copy under the en locale', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PreviewNotice />
      </NextIntlClientProvider>,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/^Preview/);
    expect(status).toHaveTextContent(/sample data/i);
    expect(status).toHaveTextContent(/read-only: changes are not saved/i);
    expect(status).not.toHaveTextContent(/dữ liệu mẫu/i);
  });
});

describe('App shell routes', () => {
  it('có đủ route canonical cho detail và settings preview', () => {
    expect(existsSync(resolve(WEB_ROOT, 'app', 'app', 'items', '[id]', 'page.tsx'))).toBe(true);
    expect(existsSync(resolve(WEB_ROOT, 'app', 'app', 'settings', 'page.tsx'))).toBe(true);
  });
});
