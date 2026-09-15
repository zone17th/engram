import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BadgeType } from '../components/ui/badge-type';
import { Button } from '../components/ui/button';
import { Chip } from '../components/ui/chip';
import { Kbd } from '../components/ui/kbd';
import { Panel } from '../components/ui/panel';
import { Segmented } from '../components/ui/segmented';
import { Switch } from '../components/ui/switch';
import { VaultPill } from '../components/ui/vault-pill';

describe('Button', () => {
  it('mặc định là primary theo class của mockup', () => {
    render(<Button>Lưu</Button>);
    const btn = screen.getByRole('button', { name: 'Lưu' });
    expect(btn.className).toContain('btn');
    expect(btn.className).toContain('btn-primary');
  });

  it.each([
    ['secondary', 'btn-secondary'],
    ['tertiary', 'btn-tertiary'],
    ['ai', 'btn-ai'],
    ['danger', 'btn-danger'],
  ] as const)('variant %s dùng class %s', (variant, cls) => {
    render(<Button variant={variant}>x</Button>);
    expect(screen.getByRole('button').className).toContain(cls);
  });

  it('size sm thêm btn-sm', () => {
    render(<Button size="sm">x</Button>);
    expect(screen.getByRole('button').className).toContain('btn-sm');
  });

  it('cho phép nối thêm className', () => {
    render(<Button className="w-full">x</Button>);
    expect(screen.getByRole('button').className).toContain('w-full');
  });
});

describe('Chip', () => {
  it('hiện số lượng khi có count', () => {
    render(<Chip count={12}>ghi-chú</Chip>);
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('đánh dấu selected bằng aria-pressed', () => {
    render(<Chip selected>ghi-chú</Chip>);
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('BadgeType', () => {
  it.each([
    ['text', 'badge-text'],
    ['json', 'badge-json'],
  ] as const)('kind %s dùng class %s', (kind, cls) => {
    render(<BadgeType kind={kind} />);
    const el = screen.getByText(kind.toUpperCase());
    expect(el.className).toContain('badge-type');
    expect(el.className).toContain(cls);
  });
});

describe('Panel', () => {
  it('tone agent dùng panel-agent', () => {
    render(<Panel tone="agent">nội dung</Panel>);
    expect(screen.getByText('nội dung').className).toContain('panel-agent');
  });
});

describe('Kbd', () => {
  it('render trong thẻ kbd với class kbd', () => {
    const { container } = render(<Kbd>Ctrl K</Kbd>);
    const el = container.querySelector('kbd');
    expect(el?.className).toContain('kbd');
  });
});

describe('Switch', () => {
  it('có role switch và phát onCheckedChange', async () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onChange} label="Gần nghĩa" />);
    const el = screen.getByRole('switch', { name: /Gần nghĩa/ });
    expect(el).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(el);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('disabled thì không phát sự kiện và nêu lý do qua aria-describedby', async () => {
    const onChange = vi.fn();
    render(
      <Switch checked={false} onCheckedChange={onChange} label="Gần nghĩa" disabled hint="Chưa bật ở bản này" />,
    );
    const el = screen.getByRole('switch');
    await userEvent.click(el);
    expect(onChange).not.toHaveBeenCalled();
    expect(el).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Chưa bật ở bản này')).toBeInTheDocument();
  });
});

describe('Segmented', () => {
  it('đánh dấu tab đang chọn và đổi khi click', async () => {
    const onChange = vi.fn();
    render(
      <Segmented
        value="tbl"
        onChange={onChange}
        options={[
          { value: 'tbl', label: 'Bảng' },
          { value: 'raw', label: 'Thô' },
        ]}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Bảng' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('tab', { name: 'Thô' }));
    expect(onChange).toHaveBeenCalledWith('raw');
  });
});

describe('VaultPill', () => {
  it('trạng thái mở hiện thời gian còn lại', () => {
    render(<VaultPill state="open" minutesLeft={15} />);
    expect(screen.getByText(/15 phút/)).toBeInTheDocument();
  });

  it('trạng thái khoá không hiện thời gian', () => {
    render(<VaultPill state="locked" />);
    expect(screen.queryByText(/phút/)).not.toBeInTheDocument();
  });
});
