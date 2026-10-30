import { ProblemError } from '@engram/shared-types';
import { revokePasskey } from '@/lib/api/vault';
import { isAmbiguousServerFailure } from './ambiguous';

export const REVOKE_RETRY_DELAY_MS = 1_000;

export type PasskeyRevokeOutcome =
  /** The server confirmed the DELETE (204) or a retry of this client's own DELETE found the id already gone. */
  | { status: 'revoked'; viaRetry: boolean }
  /** 404 for an id this client never tried to revoke: the list was stale. Reload it, do not claim success. */
  | { status: 'not_found' };

export interface PasskeyRevokeDeps {
  revoke?: (id: string, reauthToken: string) => Promise<void>;
  /** Reloads the passkey list after a confirmed revoke (and after `not_found`). */
  reloadList: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Remembers ids whose DELETE was sent but not answered. A later `404 passkey_not_found` for such an id is this
 * client's own earlier DELETE having committed (plan §2.5 "Thu hồi", ADR 0003 §5), not an error. Keep one tracker per
 * list view (e.g. in a ref) so a manual retry after a reload of the dialog still recognises the id.
 */
export function createRevokeTracker(): Set<string> {
  return new Set<string>();
}

function isPasskeyNotFound(err: unknown): boolean {
  return err instanceof ProblemError && err.problem.code === 'passkey_not_found';
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `DELETE /vault/passkeys/{id}` with one automatic retry when the outcome is unknown: no HTTP response, or a server /
 * gateway failure that may have been produced after the commit (500 from a failed COMMIT, 502, 504; see
 * `isAmbiguousServerFailure`). The id is tracked so that a later `404 passkey_not_found` for it counts as revoked,
 * including after a manual retry. The grant (`vault.passkey_revoke`) is taken by the caller when the flow starts.
 * Definite API errors (auth, domain, 4xx) propagate unchanged and are never tracked.
 */
export async function revokePasskeyIdempotent(
  deps: PasskeyRevokeDeps,
  tracker: Set<string>,
  id: string,
  reauthToken: string,
): Promise<PasskeyRevokeOutcome> {
  const send = deps.revoke ?? ((i: string, t: string) => revokePasskey(i, t));
  const sleep = deps.sleep ?? defaultSleep;

  const attempt = async (viaRetry: boolean): Promise<PasskeyRevokeOutcome | { unconfirmed: unknown }> => {
    try {
      await send(id, reauthToken);
      tracker.delete(id);
      return { status: 'revoked', viaRetry };
    } catch (err) {
      if (isPasskeyNotFound(err)) {
        const own = tracker.has(id);
        tracker.delete(id);
        return own ? { status: 'revoked', viaRetry: true } : { status: 'not_found' };
      }
      if (err instanceof ProblemError && !isAmbiguousServerFailure(err.problem)) throw err;
      // No HTTP answer, or one that proves nothing: the DELETE may have committed.
      tracker.add(id);
      return { unconfirmed: err };
    }
  };

  let outcome = await attempt(false);
  if ('unconfirmed' in outcome) {
    await sleep(REVOKE_RETRY_DELAY_MS);
    outcome = await attempt(true);
    if ('unconfirmed' in outcome) {
      throw outcome.unconfirmed instanceof ProblemError
        ? outcome.unconfirmed
        : new Error('Passkey revoke could not be confirmed');
    }
  }
  await deps.reloadList();
  return outcome;
}
