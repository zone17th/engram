export type UserChangedListener = (prevUserId: string, nextUserId: string) => void;

const listeners = new Set<UserChangedListener>();
// Last committed authenticated user id in memory only (never in storage).
// Survives terminal auth loss (session_invalid / expired / revoked) and explicit logout
// so user replacement is detected even when the predecessor session has already been cleared (IP15-BE4-2, advisor-dec-199).
let lastCommittedUserId: string | null = null;

export function subscribeUserChanged(cb: UserChangedListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function notifyUserChanged(prevUserId: string, nextUserId: string): void {
  if (!prevUserId || !nextUserId || prevUserId === nextUserId) {
    if (nextUserId) {
      lastCommittedUserId = nextUserId;
    }
    return;
  }
  lastCommittedUserId = nextUserId;
  for (const listener of [...listeners]) {
    try {
      listener(prevUserId, nextUserId);
    } catch {
      // Never let a listener exception abort a successful login/signup/OAuth flow (IP15-FE4-4).
    }
  }
}

export function commitAuthenticatedUser(nextUserId: string): void {
  if (!nextUserId) {
    return;
  }
  const prevUserId = lastCommittedUserId;
  lastCommittedUserId = nextUserId;
  if (prevUserId !== null && prevUserId !== nextUserId) {
    for (const listener of [...listeners]) {
      try {
        listener(prevUserId, nextUserId);
      } catch {
        // Never let a listener exception abort a successful login/signup/OAuth flow (IP15-FE4-4).
      }
    }
  }
}

export const __testing = {
  getLastCommittedUserId(): string | null {
    return lastCommittedUserId;
  },
  resetCommittedUserForTests(): void {
    lastCommittedUserId = null;
  },
};
