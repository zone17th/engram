import type { paths } from './api';
import { type ProblemDetails, isProblemDetails } from './problem';

/** Tiền tố duy nhất. Luôn tương đối: dev proxy /api sang Go trên cùng origin. */
const API_PREFIX = '/api/v1';

export type HealthResponse = paths['/healthz']['get']['responses']['200']['content']['application/json'];
export type ReadyResponse = paths['/readyz']['get']['responses']['200']['content']['application/json'];

/**
 * Chặn mọi path có thể thoát khỏi origin. `//host` và `/\host` đều bị browser
 * hiểu là scheme-relative URL; URL tuyệt đối thì khỏi nói. Chỉ cho phép đường
 * bắt đầu bằng đúng một `/`.
 */
function assertRelativePath(path: string): void {
  const escapes = path.startsWith('//') || path.startsWith('/\\');
  if (!path.startsWith('/') || escapes) {
    throw new Error(`apiFetch chỉ nhận đường tương đối bắt đầu bằng "/": ${path}`);
  }
}

/** Lỗi mang nguyên body RFC 9457 để UI hiển thị đúng title/code. */
export class ProblemError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.title);
    this.name = 'ProblemError';
  }
}

function mergeHeaders(headersInit: HeadersInit | undefined): Headers {
  const headers = new Headers(headersInit);
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  return headers;
}

function mediaType(contentType: string): string {
  return contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function isJsonContentType(contentType: string): boolean {
  const type = mediaType(contentType);
  return type === 'application/json' || type.endsWith('+json');
}

/**
 * apiFetch là cổng duy nhất ra API.
 * `credentials: 'same-origin'` là chủ ý: cookie `sabk_session` có path `/api`
 * và chỉ hợp lệ trên chính origin này.
 *
 * Thứ tự spread là một phần của contract: `...init` đứng TRƯỚC, `credentials`
 * đứng SAU. Nếu ngược lại, một caller truyền `{ credentials: 'include' }` sẽ
 * âm thầm mở gateway policy ra cross-origin. Caller được đổi method/body/signal,
 * không được đổi credentials.
 * Response thành công không có body (204, 205 hoặc HEAD) resolve `undefined`; gọi
 * với `T = void` cho các operation không trả body.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  assertRelativePath(path);
  const res = await fetch(`${API_PREFIX}${path}`, {
    ...init,
    headers: mergeHeaders(init?.headers),
    credentials: 'same-origin',
  });

  const contentType = res.headers.get('content-type') ?? '';
  const method = init?.method?.toUpperCase();
  const hasNoBody = res.body === null || res.status === 204 || res.status === 205 || method === 'HEAD';

  if (mediaType(contentType) === 'application/problem+json' && !hasNoBody) {
    const body: unknown = await res.json();
    if (isProblemDetails(body)) throw new ProblemError(body);
    throw new Error(`Lỗi không rõ định dạng (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    throw new Error(`Yêu cầu thất bại (HTTP ${res.status}).`);
  }
  if (hasNoBody) return undefined as T;
  if (isJsonContentType(contentType) || contentType === '') return (await res.json()) as T;
  return (await res.text()) as T;
}
