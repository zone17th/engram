import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppHeader } from '../components/app-shell/app-header';
import { EmptyState } from '../components/app-shell/empty-state';
import { Rail } from '../components/app-shell/rail';
import { DEMO_TAGS } from '../lib/demo-fixtures';

describe('AppHeader', () => {
  it('luôn hiện chữ engram viết thường', () => {
    render(<AppHeader vault={{ state: 'open', minutesLeft: 15 }} />);
    expect(screen.getByText('engram')).toBeInTheDocument();
    expect(screen.queryByText('Engram')).not.toBeInTheDocument();
  });

  it('phản ánh trạng thái vault được truyền vào', () => {
    const { rerender } = render(<AppHeader vault={{ state: 'open', minutesLeft: 15 }} />);
    expect(screen.getByText(/15 phút/)).toBeInTheDocument();

    rerender(<AppHeader vault={{ state: 'locked' }} />);
    expect(screen.getByText(/Vault đang khoá/)).toBeInTheDocument();
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
