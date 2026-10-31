/**
 * Multi-tab shared auto-lock timer, activity throttle, clock-rollback guard, and wake/resume
 * `Me` deadline constants & helpers (plan §2.6, Task 15B, ADR 0003 §8).
 *
 * Rules:
 * 1. `auto_lock_minutes` defaults to `15`. When `auto_lock_minutes === 0` (`Never`), no timer runs
 *    and no idle deadline check triggers (except during the post-wake window while authoritative
 *    `GET /auth/me` is still in flight — never trust a cached `0` across wake).
 * 2. Tabs share `lastActivity` via `{ type: 'activity', at: number }` on `BroadcastChannel('sabk.vault')`
 *    (throttled so user input does not flood the channel). Each tab tracks
 *    `sharedLastActivityAt = max(localLastActivityAt, remoteActivityAt)`.
 * 3. Idle deadline: `sharedLastActivityAt + auto_lock_minutes * 60_000`. Lock fires ONLY when
 *    `now >= sharedLastActivityAt + auto_lock_minutes * 60_000`.
 * 4. Clock rollback: if `now < sharedLastActivityAt - 60_000` (system clock moved back by more than
 *    1 minute), lock immediately (fail closed).
 * 5. Wake / visibility / focus / pageshow / resume while unlocked:
 *    - Immediately compare `Date.now()` against `sharedLastActivityAt` (clock rollback and known
 *      `auto_lock_minutes > 0` deadline) without trusting throttled timers.
 *    - Immediately refresh authoritative `GET /auth/me` with a 5-second fail-closed deadline
 *      (`WAKE_ME_REFRESH_DEADLINE_MS = 5_000`); if `GET /auth/me` returns `401`, rejects, or fails
 *      to resolve within the deadline, lock immediately (fail closed) and never treat a failed read
 *      as `auto_lock_minutes = 0`.
 */

export const DEFAULT_AUTO_LOCK_MINUTES = 15 as const;
export const CLOCK_ROLLBACK_TOLERANCE_MS = 60_000 as const;
export const ACTIVITY_BROADCAST_THROTTLE_MS = 1_000 as const;
export const WAKE_ME_REFRESH_DEADLINE_MS = 5_000 as const;
export const MIN_POSITIVE_AUTO_LOCK_MINUTES = 5 as const;

export function normalizeAutoLockMinutes(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_AUTO_LOCK_MINUTES;
  }
  if (value === 0) return 0;
  return Math.floor(value);
}

export type AutoLockEvaluation =
  | { shouldLock: false; remainingMs: number | null; minutesLeft: number | undefined }
  | { shouldLock: true; reason: 'idle_timeout' | 'clock_rollback' };

/**
 * Evaluates whether the vault must lock at `now` given `lastActivityAt` and `autoLockMinutes`:
 * - Clock rollback (`now < lastActivityAt - 60_000`) -> lock immediately (`'clock_rollback'`).
 * - `autoLockMinutes === 0` (`Never`) -> never idle-locks (`remainingMs: null`, `minutesLeft: undefined`).
 * - `autoLockMinutes > 0` and `now - lastActivityAt >= autoLockMinutes * 60_000` -> lock (`'idle_timeout'`).
 * - Otherwise returns `remainingMs` until the deadline and `minutesLeft = Math.max(1, Math.ceil(remainingMs / 60_000))`.
 */
export function evaluateAutoLockAt(params: {
  now: number;
  lastActivityAt: number;
  autoLockMinutes: number;
}): AutoLockEvaluation {
  const { now, lastActivityAt, autoLockMinutes } = params;

  if (now < lastActivityAt - CLOCK_ROLLBACK_TOLERANCE_MS) {
    return { shouldLock: true, reason: 'clock_rollback' };
  }

  if (autoLockMinutes <= 0) {
    return { shouldLock: false, remainingMs: null, minutesLeft: undefined };
  }

  const timeoutMs = autoLockMinutes * 60_000;
  const elapsedMs = Math.max(0, now - lastActivityAt);
  if (elapsedMs >= timeoutMs) {
    return { shouldLock: true, reason: 'idle_timeout' };
  }

  const remainingMs = timeoutMs - elapsedMs;
  const minutesLeft = Math.max(1, Math.ceil(remainingMs / 60_000));
  return {
    shouldLock: false,
    remainingMs,
    minutesLeft,
  };
}
