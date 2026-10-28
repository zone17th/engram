export const SESSION_LOCK_NAME = 'sabk.auth.session';

const SESSION_LOCK_TOKEN = Symbol('sabk.auth.session.lock');
export type SessionLockToken = typeof SESSION_LOCK_TOKEN;

export function hasWebLocks(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';
}

/** Chạy fn dưới Web Lock; không có Locks thì chạy trực tiếp (degraded). */
export async function withSessionLock<T>(fn: (lock: SessionLockToken) => Promise<T>): Promise<T> {
  const run = () => fn(SESSION_LOCK_TOKEN);
  if (!hasWebLocks()) return run();
  return navigator.locks.request(SESSION_LOCK_NAME, run);
}
