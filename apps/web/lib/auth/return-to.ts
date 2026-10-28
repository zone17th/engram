/** Chỉ path nội bộ allowlist — không //, URL đầy đủ, encoded bypass hay query tùy ý. */
export function sanitizeReturnTo(raw: string | null | undefined, fallback = '/app'): string {
  if (!raw || typeof raw !== 'string') return fallback;
  let path = raw.trim();
  if (!path.startsWith('/')) return fallback;
  if (path.startsWith('//') || path.startsWith('/\\')) return fallback;
  if (/^\/\w+:/i.test(path)) return fallback;
  try {
    path = decodeURIComponent(path);
  } catch {
    return fallback;
  }
  if (path.startsWith('//') || path.startsWith('/\\')) return fallback;
  if (/^\/\w+:/i.test(path)) return fallback;
  if (path.includes('//')) return fallback;
  const base = path.split(/[?#]/, 1)[0] ?? path;
  if (base !== '/app' && !base.startsWith('/app/')) return fallback;
  return path.split('#', 1)[0] ?? path;
}

export function loginUrl(returnTo?: string): string {
  const safe = sanitizeReturnTo(returnTo, '/app');
  if (safe === '/app') return '/app/auth/login';
  return `/app/auth/login?returnTo=${encodeURIComponent(safe)}`;
}
