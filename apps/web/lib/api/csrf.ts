export const CSRF_COOKIE = 'sabk_csrf';

export function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const parts = document.cookie.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${CSRF_COOKIE}=`)) {
      return decodeURIComponent(trimmed.slice(CSRF_COOKIE.length + 1));
    }
  }
  return null;
}
