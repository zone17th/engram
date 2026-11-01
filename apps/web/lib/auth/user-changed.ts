export type UserChangedListener = (prevUserId: string, nextUserId: string) => void;

const listeners = new Set<UserChangedListener>();

export function subscribeUserChanged(cb: UserChangedListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function notifyUserChanged(prevUserId: string, nextUserId: string): void {
  if (!prevUserId || !nextUserId || prevUserId === nextUserId) {
    return;
  }
  for (const listener of [...listeners]) {
    listener(prevUserId, nextUserId);
  }
}
