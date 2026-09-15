/** Namespace type URI theo RFC 9457 — phải khớp httpx.ProblemBase bên Go. */
export const PROBLEM_BASE = 'https://key.zone17th.click/problems/' as const;

/** Danh sách code lỗi ổn định. Thêm code mới ở cả Go lẫn đây trong cùng một PR. */
export const ERROR_CODES = [
  'invalid_request',
  'dependency_unavailable',
  'internal_error',
  'not_found',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Body lỗi duy nhất của API. Không có envelope nào khác (SPEC §5.5). */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  /** Request ID, không phải URL — URL có thể chứa từ khoá riêng tư. */
  instance?: string;
  code: string;
}

export function isProblemDetails(value: unknown): value is ProblemDetails {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.type === 'string' &&
    typeof v.title === 'string' &&
    typeof v.status === 'number' &&
    typeof v.code === 'string'
  );
}
