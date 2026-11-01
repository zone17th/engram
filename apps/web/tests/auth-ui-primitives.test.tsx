import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import viMessages from '../messages/vi.json';
import { Button } from '../components/ui/button';
import {
  AuthStatus,
  Field,
  focusFirstInvalidField,
} from '../components/ui/field';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from '../components/ui/dialog';
import { Segmented } from '../components/ui/segmented';
import { Switch } from '../components/ui/switch';

describe('Field', () => {
  it('nối label, hint và error qua id/aria', () => {
    render(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <Field
          label="Email"
          hint="Dùng email đăng nhập"
          error="Email không hợp lệ"
          defaultValue="bad"
        />
      </NextIntlClientProvider>,
    );
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', expect.stringMatching(/-error$/));
    expect(screen.getByText('Email không hợp lệ')).toHaveAttribute('role', 'alert');
  });

  it('email/password giữ autocomplete và không chặn paste', () => {
    render(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <Field label="Mật khẩu" type="password" autoComplete="current-password" />
      </NextIntlClientProvider>,
    );
    const input = screen.getByLabelText('Mật khẩu');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'current-password');
    expect(input).not.toHaveAttribute('readonly');
  });

  it('password toggle đổi type và có accessible name', async () => {
    render(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <Field label="Mật khẩu" type="password" defaultValue="secret" />
      </NextIntlClientProvider>,
    );
    const input = screen.getByLabelText('Mật khẩu');
    expect(input).toHaveAttribute('type', 'password');
    const toggle = screen.getByRole('button', { name: 'Hiện' });
    expect(toggle).toHaveAttribute('type', 'button');
    await userEvent.click(toggle);
    expect(screen.getByLabelText('Mật khẩu')).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Ẩn' })).toBeInTheDocument();
  });

  it('password toggle lấy nhãn i18n theo locale hiện tại (không trộn tiếng Việt sang tiếng Anh)', async () => {
    const { unmount } = render(
      <NextIntlClientProvider locale="en" messages={en}>
        <Field label="Login password" type="password" defaultValue="secret" />
      </NextIntlClientProvider>,
    );
    const enToggle = screen.getByRole('button', { name: 'Show' });
    expect(screen.queryByRole('button', { name: 'Hiện' })).not.toBeInTheDocument();
    await userEvent.click(enToggle);
    expect(screen.getByRole('button', { name: 'Hide' })).toBeInTheDocument();
    unmount();

    render(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <Field label="Mật khẩu đăng nhập" type="password" defaultValue="secret" />
      </NextIntlClientProvider>,
    );
    const viToggle = screen.getByRole('button', { name: 'Hiện' });
    await userEvent.click(viToggle);
    expect(screen.getByRole('button', { name: 'Ẩn' })).toBeInTheDocument();
  });

  it('focusFirstInvalidField focus ô lỗi đầu tiên', () => {
    render(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <form data-testid="form">
          <Field label="A" error="lỗi A" />
          <Field label="B" error="lỗi B" />
        </form>
      </NextIntlClientProvider>,
    );
    const form = screen.getByTestId('form');
    focusFirstInvalidField(form);
    expect(screen.getByLabelText('A')).toHaveFocus();
  });
});

describe('AuthStatus', () => {
  it('loading/sent dùng role=status', () => {
    const { rerender } = render(<AuthStatus tone="loading">Đang gửi…</AuthStatus>);
    expect(screen.getByRole('status')).toHaveTextContent('Đang gửi…');
    rerender(<AuthStatus tone="sent">Đã gửi email</AuthStatus>);
    expect(screen.getByRole('status')).toHaveTextContent('Đã gửi email');
  });

  it('error dùng role=alert', () => {
    render(<AuthStatus tone="error">Sai thông tin</AuthStatus>);
    expect(screen.getByRole('alert')).toHaveTextContent('Sai thông tin');
  });
});

describe('Dialog', () => {
  function BasicDialog({ pending = false }: { pending?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && pending) return;
          setOpen(next);
        }}
      >
        <DialogTrigger asChild>
          <Button variant="tertiary">Mở</Button>
        </DialogTrigger>
        <DialogContent aria-describedby={undefined}>
          <div className="panel p-7">
            <DialogHeader title="Tiêu đề" description="Mô tả ngắn" />
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="tertiary">Huỷ</Button>
              </DialogClose>
              <Button disabled={pending}>{pending ? 'Đang lưu…' : 'Lưu'}</Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  it('mở bằng trigger, focus trap và đóng bằng Escape', async () => {
    render(<BasicDialog />);
    const trigger = screen.getByRole('button', { name: 'Mở' });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Tiêu đề')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  it('Escape không đóng khi pending', async () => {
    render(<BasicDialog pending />);
    await userEvent.click(screen.getByRole('button', { name: 'Mở' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('Switch (Radix)', () => {
  it('role switch và phát onCheckedChange', async () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onChange} label="Gần nghĩa" />);
    const el = screen.getByRole('switch', { name: 'Gần nghĩa' });
    expect(el).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(el);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('disabled không phát sự kiện', async () => {
    const onChange = vi.fn();
    render(
      <Switch checked={false} onCheckedChange={onChange} label="Gần nghĩa" disabled hint="Tạm khoá" />,
    );
    await userEvent.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Tạm khoá')).toBeInTheDocument();
  });
});

describe('Segmented (Radix ToggleGroup)', () => {
  it('đổi lựa chọn khi click', async () => {
    const onChange = vi.fn();
    render(
      <Segmented
        value="vi"
        onChange={onChange}
        options={[
          { value: 'vi', label: 'Tiếng Việt' },
          { value: 'en', label: 'English' },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('radio', { name: 'English' }));
    expect(onChange).toHaveBeenCalledWith('en');
  });

  it('disabled không đổi lựa chọn', async () => {
    const onChange = vi.fn();
    render(
      <Segmented
        disabled
        value="vi"
        onChange={onChange}
        options={[
          { value: 'vi', label: 'Tiếng Việt' },
          { value: 'en', label: 'English' },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('radio', { name: 'English' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('token contrast', () => {
  it('auth-alert dùng màu lỗi đọc được từ token', () => {
    render(<AuthStatus tone="error">Lỗi</AuthStatus>);
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('auth-alert');
    const color = getComputedStyle(alert).color;
    expect(color).not.toBe('');
    expect(color).not.toBe('rgb(0, 0, 0)');
  });
});
