import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { JsonTable } from '../components/landing/json-table';

const data = { keyword: 'ca-phe', body: { ratio: '1:2', steps: ['pha phin', 'cho đá'] } };

describe('JsonTable', () => {
  it('hiện khoá và giá trị ở chế độ bảng', () => {
    render(<JsonTable data={data} />);
    expect(screen.getByText('keyword')).toBeInTheDocument();
    expect(screen.getByText('ca-phe')).toBeInTheDocument();
  });

  it('lồng object thành hàng con', () => {
    render(<JsonTable data={data} />);
    expect(screen.getByText('ratio')).toBeInTheDocument();
    expect(screen.getByText('1:2')).toBeInTheDocument();
  });

  it('chuyển sang JSON thô bằng segmented', async () => {
    render(<JsonTable data={data} />);
    await userEvent.click(screen.getByRole('tab', { name: /thô/i }));
    expect(screen.getByRole('code')).toHaveTextContent('"keyword": "ca-phe"');
  });

  it('hiện mảng dưới dạng chỉ số', () => {
    render(<JsonTable data={data} />);
    expect(screen.getByText('steps')).toBeInTheDocument();
    expect(screen.getByText('pha phin')).toBeInTheDocument();
  });
});
