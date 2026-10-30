import { describe, expect, it, vi } from 'vitest';
import { createRevokeTracker, revokePasskeyIdempotent, type PasskeyRevokeDeps } from './revoke';
import { problem } from './test-helpers';

const ID = '0d8b6a1e-52f4-4b8d-9d0a-3f6c7b2e1a90';

function makeDeps(sends: Array<'ok' | Error>) {
  const queue = [...sends];
  const send = vi.fn(async (id: string, token: string) => {
    void id;
    void token;
    const next = queue.shift();
    if (next instanceof Error) throw next;
  });
  const reloadList = vi.fn(async () => {});
  const sleep = vi.fn(async (ms: number) => {
    void ms;
  });
  const deps: PasskeyRevokeDeps = { revoke: send, reloadList, sleep };
  return { deps, send, reloadList, sleep };
}

describe('T19 bullet 3 - revoke (plan 2.5 "Thu hoi")', () => {
  it('a confirmed DELETE is revoked and the list is reloaded once', async () => {
    const h = makeDeps(['ok']);
    const outcome = await revokePasskeyIdempotent(h.deps, createRevokeTracker(), ID, 'grant-1');
    expect(outcome).toEqual({ status: 'revoked', viaRetry: false });
    expect(h.send).toHaveBeenCalledWith(ID, 'grant-1');
    expect(h.reloadList).toHaveBeenCalledTimes(1);
  });

  it('a retry that gets 404 passkey_not_found for the id this client just revoked counts as revoked, then the list reloads', async () => {
    const h = makeDeps([new TypeError('Failed to fetch'), problem(404, 'passkey_not_found')]);
    const outcome = await revokePasskeyIdempotent(h.deps, createRevokeTracker(), ID, 'grant-1');
    expect(outcome).toEqual({ status: 'revoked', viaRetry: true });
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.sleep).toHaveBeenCalledTimes(1);
    expect(h.reloadList).toHaveBeenCalledTimes(1);
  });

  it('a lost response followed by a successful retry is revoked', async () => {
    const h = makeDeps([new TypeError('Failed to fetch'), 'ok']);
    expect(await revokePasskeyIdempotent(h.deps, createRevokeTracker(), ID, 'grant-1')).toEqual({
      status: 'revoked',
      viaRetry: true,
    });
  });

  it('a 404 for an id this client never tried to revoke is not_found (stale list), still reloading the list', async () => {
    const h = makeDeps([problem(404, 'passkey_not_found')]);
    const outcome = await revokePasskeyIdempotent(h.deps, createRevokeTracker(), ID, 'grant-1');
    expect(outcome).toEqual({ status: 'not_found' });
    expect(h.reloadList).toHaveBeenCalledTimes(1);
  });

  it('the tracker survives an unconfirmed call: a later manual retry that gets 404 is recognised as revoked', async () => {
    const tracker = createRevokeTracker();
    const first = makeDeps([new TypeError('offline'), new TypeError('offline')]);
    await expect(revokePasskeyIdempotent(first.deps, tracker, ID, 'grant-1')).rejects.toThrow();
    expect(first.reloadList).not.toHaveBeenCalled();

    const second = makeDeps([problem(404, 'passkey_not_found')]);
    expect(await revokePasskeyIdempotent(second.deps, tracker, ID, 'grant-1')).toEqual({
      status: 'revoked',
      viaRetry: true,
    });
  });

  it('another API error (e.g. an expired grant) propagates and does not reload or retry', async () => {
    const h = makeDeps([problem(403, 'reauth_required'), 'ok']);
    await expect(revokePasskeyIdempotent(h.deps, createRevokeTracker(), ID, 'grant-1')).rejects.toMatchObject({
      problem: { code: 'reauth_required' },
    });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.reloadList).not.toHaveBeenCalled();
  });

  it('a 404 with a different code is not mistaken for an already-revoked passkey', async () => {
    const tracker = createRevokeTracker();
    const h = makeDeps([new TypeError('offline'), problem(404, 'vault_absent')]);
    await expect(revokePasskeyIdempotent(h.deps, tracker, ID, 'grant-1')).rejects.toMatchObject({
      problem: { code: 'vault_absent' },
    });
  });
});
