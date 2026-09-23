/** Namespace type URI theo RFC 9457 — phải khớp httpx.ProblemBase bên Go. */
export const PROBLEM_BASE = 'https://key.zone17th.click/problems/' as const;

/** Danh sách code lỗi ổn định. Thêm code mới ở cả Go lẫn đây trong cùng một PR. */
export const ERROR_CODES = [
  'invalid_request',
  'dependency_unavailable',
  'internal_error',
  'not_found',
  'unauthenticated',
  'access_expired',
  'session_invalid',
  'invalid_credentials',
  'csrf_invalid',
  'forbidden',
  'reauth_required',
  'reauth_invalid',
  'reauth_unsupported_provider',
  'rate_limited',
  'captcha_required',
  'email_not_verified',
  'email_taken',
  'identity_conflict',
  'identity_last_method',
  'oauth_state_invalid',
  'oauth_provider_error',
  'verification_invalid',
  'password_weak',
  'semantic_unavailable',
  'mail_delivery_unavailable',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const SESSION_INVALID_REASONS = ['revoked', 'expired', 'invalid'] as const;
export type SessionInvalidReason = (typeof SESSION_INVALID_REASONS)[number];

/** Body lỗi duy nhất của API. Không có envelope nào khác (SPEC §5.5). */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  /** Request ID, không phải URL — URL có thể chứa từ khoá riêng tư. */
  instance?: string;
  code: string;
  /** Giây nguyên dương; khớp header Retry-After khi 429. */
  retry_after?: number;
  /** Chỉ khi code = session_invalid; token lạ dùng invalid. */
  reason?: SessionInvalidReason;
  captcha_required?: boolean;
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
