import { describe, expect, it } from 'vitest';
import { ERROR_CODES, PROBLEM_BASE, isProblemDetails } from './problem';

describe('problem', () => {
  it('giữ đúng namespace type URI của spec', () => {
    expect(PROBLEM_BASE).toBe('https://key.zone17th.click/problems/');
  });

  it('nhận diện body problem hợp lệ', () => {
    expect(
      isProblemDetails({
        type: `${PROBLEM_BASE}dependency_unavailable`,
        title: 'Phụ thuộc chưa sẵn sàng',
        status: 503,
        code: 'dependency_unavailable',
      }),
    ).toBe(true);
  });

  it('từ chối object thiếu code', () => {
    expect(isProblemDetails({ type: PROBLEM_BASE, title: 'x', status: 500 })).toBe(false);
  });

  it('liệt kê đủ code P01 dùng', () => {
    expect(ERROR_CODES).toContain('dependency_unavailable');
    expect(ERROR_CODES).toContain('invalid_request');
    expect(ERROR_CODES).toContain('internal_error');
    expect(ERROR_CODES).toContain('not_found');
  });
});
