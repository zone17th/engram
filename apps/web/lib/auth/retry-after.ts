/** Định dạng số giây thành đồng hồ mm:ss. */
export function formatRetryClock(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}

export function normalizeRetryAfter(seconds: number | undefined, fallback = 60): number {
  if (!Number.isFinite(seconds) || seconds === undefined || seconds < 1) return fallback;
  return Math.floor(seconds);
}

export function retryAfterFromHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (!Number.isFinite(seconds) || seconds < 1) return undefined;
  return seconds;
}
