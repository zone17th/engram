import { describe, expect, it, vi } from 'vitest';
import type { VaultState } from '@/lib/api/vault';
import type { UnlockPrfClientParams } from '@/lib/crypto/client';
import { encodeBase64Url } from '@/lib/crypto/b64url';
import { runPasskeyUnlock, type PasskeyUnlockDeps } from './unlock-flow';
import {
  CRED_A,
  CRED_B,
  PRF_OUTPUT,
  UNLOCK_CHALLENGE,
  domError,
  fakeCredential,
  filled,
  isAllZero,
  prfEvalByCredential,
  problem,
  unlockOptionsResponse,
  type FakePrfOutput,
} from './test-helpers';

const META = { private_keys_wrapped: 'PRIV-WRAP-OPAQUE' } as unknown as VaultState;

interface UnlockHarnessOptions {
  /** Credential id the authenticator answers with. */
  usedId?: Uint8Array;
  prf?: FakePrfOutput | null;
  getError?: unknown;
  optionsError?: unknown;
  meta?: VaultState | null;
  unlockError?: unknown;
  busy?: boolean;
  generation?: number;
  declaredSaltForB?: Uint8Array;
}

function makeUnlockHarness(opts: UnlockHarnessOptions = {}) {
  const log: string[] = [];
  const state = { generation: opts.generation ?? 3 };
  const assertion = fakeCredential({
    rawId: opts.usedId ?? CRED_A.id,
    prf: opts.prf === undefined ? { enabled: true, first: PRF_OUTPUT } : opts.prf,
  });

  const client = {
    captureGeneration: vi.fn(() => {
      log.push('captureGeneration');
      return state.generation;
    }),
    getGeneration: vi.fn(() => state.generation),
  };
  const api = {
    fetchUnlockOptions: vi.fn(async () => {
      log.push('options');
      if (opts.optionsError) throw opts.optionsError;
      return unlockOptionsResponse({ declaredSaltForB: opts.declaredSaltForB });
    }),
  };
  const loadVaultMeta = vi.fn(async () => {
    log.push('meta');
    return opts.meta === undefined ? META : opts.meta;
  });
  const unlocked: { params: UnlockPrfClientParams; bytes: number[] }[] = [];
  const unlockPrf = vi.fn(async (params: UnlockPrfClientParams) => {
    log.push('unlockPrf');
    unlocked.push({ params, bytes: Array.from(params.pwk as Uint8Array) });
    if (opts.unlockError) throw opts.unlockError;
    return { unlocked: true as const };
  });
  const credentials = {
    get: vi.fn(async (options?: CredentialRequestOptions) => {
      log.push('get');
      void options;
      if (opts.getError) throw opts.getError;
      return assertion.credential as Credential;
    }),
  };
  const isBusy = vi.fn(() => opts.busy === true);

  const deps: PasskeyUnlockDeps = { client, api, loadVaultMeta, unlockPrf, credentials, isBusy };
  return { deps, log, state, client, api, loadVaultMeta, unlockPrf, credentials, unlocked, assertion, isBusy };
}

describe('T19 bullet 2 - unlock with passkey (evalByCredential)', () => {
  it('captures opGeneration synchronously before POST /vault/unlock/passkey/options and get(), and hands it to unlockPrf', async () => {
    const h = makeUnlockHarness({ generation: 21 });
    const pending = runPasskeyUnlock(h.deps);
    expect(h.log).toEqual(['captureGeneration', 'options']);
    const outcome = await pending;
    expect(outcome).toEqual({ ok: true });
    expect(h.log.indexOf('captureGeneration')).toBeLessThan(h.log.indexOf('options'));
    expect(h.log.indexOf('options')).toBeLessThan(h.log.indexOf('get'));
    expect(h.client.captureGeneration).toHaveBeenCalledTimes(1);
    expect(h.unlocked[0]?.params.opGeneration).toBe(21);
  });

  it('two credentials never mix salts: evalByCredential maps each id to its own salt and no shared eval is sent', async () => {
    const h = makeUnlockHarness();
    await runPasskeyUnlock(h.deps);
    const request = h.credentials.get.mock.calls[0]?.[0]?.publicKey as PublicKeyCredentialRequestOptions;
    const { salts, hasEval } = prfEvalByCredential(request.extensions);
    expect(hasEval).toBe(false);
    expect(Object.keys(salts).sort()).toEqual([encodeBase64Url(CRED_A.id), encodeBase64Url(CRED_B.id)].sort());
    expect(salts[encodeBase64Url(CRED_A.id)]).toEqual(Array.from(CRED_A.salt));
    expect(salts[encodeBase64Url(CRED_B.id)]).toEqual(Array.from(CRED_B.salt));
    expect(salts[encodeBase64Url(CRED_A.id)]).not.toEqual(salts[encodeBase64Url(CRED_B.id)]);
    expect(request.userVerification).toBe('required');
    expect(Array.from(new Uint8Array(request.challenge as ArrayBuffer))).toEqual(Array.from(UNLOCK_CHALLENGE));
    expect(request.allowCredentials).toHaveLength(2);
  });

  it.each([
    ['A', CRED_A.id, CRED_A.wrap],
    ['B', CRED_B.id, CRED_B.wrap],
  ])('the credential the assertion used (%s) selects its own vk_wrap, with the PWK and private keys', async (_name, usedId, wrap) => {
    const h = makeUnlockHarness({ usedId });
    const outcome = await runPasskeyUnlock(h.deps);
    expect(outcome).toEqual({ ok: true });
    expect(h.unlocked).toHaveLength(1);
    expect(h.unlocked[0]?.params.vkWrap).toBe(wrap);
    expect(h.unlocked[0]?.params.privateKeysWrapped).toBe('PRIV-WRAP-OPAQUE');
    expect(h.unlocked[0]?.bytes).toEqual(Array.from(PRF_OUTPUT));
  });

  it('refuses options whose evalByCredential salt differs from the credential salt, before any prompt', async () => {
    const h = makeUnlockHarness({ declaredSaltForB: filled(32, 0x55) });
    const outcome = await runPasskeyUnlock(h.deps);
    expect(outcome).toEqual({ ok: false, error: 'unlock_failed' });
    expect(h.credentials.get).not.toHaveBeenCalled();
  });

  it('PKW-R1-4: an assertion from a credential not in the options is unlock_failed, wipes the PRF buffer and never reaches the Worker', async () => {
    const h = makeUnlockHarness({ usedId: filled(16, 0xcc) });
    const outcome = await runPasskeyUnlock(h.deps);
    expect(outcome).toEqual({ ok: false, error: 'unlock_failed' });
    expect(isAllZero(h.assertion.prfSource!)).toBe(true);
    expect(h.unlockPrf).not.toHaveBeenCalled();
  });

  it('CLIENT_BUSY: refuses before any network call or prompt while another unlock is in flight', async () => {
    const h = makeUnlockHarness({ busy: true });
    const outcome = await runPasskeyUnlock(h.deps);
    expect(outcome).toEqual({ ok: false, error: 'busy' });
    expect(h.api.fetchUnlockOptions).not.toHaveBeenCalled();
    expect(h.credentials.get).not.toHaveBeenCalled();
  });

  it('CLIENT_BUSY from the Worker slot is busy (never a wrong-key error) and the PWK copy is wiped', async () => {
    const h = makeUnlockHarness({ unlockError: { code: 'CLIENT_BUSY' } });
    const outcome = await runPasskeyUnlock(h.deps);
    expect(outcome).toEqual({ ok: false, error: 'busy' });
    expect(isAllZero(h.unlocked[0]!.params.pwk as Uint8Array)).toBe(true);
  });

  it('VAULT_RECOVERING asks the user to lock() first to switch flows', async () => {
    const h = makeUnlockHarness({ unlockError: { code: 'VAULT_RECOVERING' } });
    expect(await runPasskeyUnlock(h.deps)).toEqual({ ok: false, error: 'recovering' });
  });

  it('a Worker STALE_GENERATION is stale (silent), not unlock_failed', async () => {
    const h = makeUnlockHarness({ unlockError: { code: 'STALE_GENERATION' } });
    expect(await runPasskeyUnlock(h.deps)).toEqual({ ok: false, error: 'stale' });
  });

  it('PKW-R1-4, PKW-R1-5: lock/logout during the authenticator prompt wipes the PRF buffer and hands nothing to the Worker', async () => {
    const h = makeUnlockHarness();
    h.credentials.get.mockImplementationOnce(async () => {
      h.state.generation += 1;
      return h.assertion.credential as Credential;
    });
    expect(await runPasskeyUnlock(h.deps)).toEqual({ ok: false, error: 'stale' });
    expect(isAllZero(h.assertion.prfSource!)).toBe(true);
    expect(h.unlockPrf).not.toHaveBeenCalled();
  });

  it('wipes the PWK copy and the browser PRF buffer after a successful unlock', async () => {
    const h = makeUnlockHarness();
    await runPasskeyUnlock(h.deps);
    expect(isAllZero(h.unlocked[0]!.params.pwk as Uint8Array)).toBe(true);
    expect(isAllZero(h.assertion.prfSource!)).toBe(true);
  });
});

describe('T19 bullet 2 - §5.10 error keys', () => {
  it('404 passkey_not_found -> none_registered (the button is hidden), no prompt', async () => {
    const h = makeUnlockHarness({ optionsError: problem(404, 'passkey_not_found') });
    expect(await runPasskeyUnlock(h.deps)).toEqual({ ok: false, error: 'none_registered' });
    expect(h.credentials.get).not.toHaveBeenCalled();
    expect(h.loadVaultMeta).not.toHaveBeenCalled();
  });

  it.each([
    [problem(500, 'internal'), 'a server error'],
    [problem(429, 'rate_limited', 30), 'rate limiting'],
    [new TypeError('Failed to fetch'), 'a network failure'],
  ])('%s while fetching options (%s) -> unlock_failed', async (optionsError) => {
    const h = makeUnlockHarness({ optionsError });
    expect(await runPasskeyUnlock(h.deps)).toEqual({ ok: false, error: 'unlock_failed' });
  });

  it('cancelling the prompt -> unlock_cancelled; any other get() error -> unlock_failed', async () => {
    const cancelled = makeUnlockHarness({ getError: domError('NotAllowedError') });
    expect(await runPasskeyUnlock(cancelled.deps)).toEqual({ ok: false, error: 'unlock_cancelled' });
    const failed = makeUnlockHarness({ getError: domError('SecurityError') });
    expect(await runPasskeyUnlock(failed.deps)).toEqual({ ok: false, error: 'unlock_failed' });
    expect(cancelled.unlockPrf).not.toHaveBeenCalled();
  });

  it('get() without PRF results (or a wrong-length output) -> unlock_prf_missing', async () => {
    for (const prf of [{ enabled: true }, null, { enabled: true, first: filled(16, 1) }] as const) {
      const h = makeUnlockHarness({ prf });
      expect(await runPasskeyUnlock(h.deps)).toEqual({ ok: false, error: 'unlock_prf_missing' });
      expect(h.unlockPrf).not.toHaveBeenCalled();
    }
  });

  it('a wrap that fails to open (AEAD) -> unlock_failed', async () => {
    const h = makeUnlockHarness({ unlockError: { code: 'AEAD_DECRYPT_FAILED' } });
    expect(await runPasskeyUnlock(h.deps)).toEqual({ ok: false, error: 'unlock_failed' });
  });

  it('a missing vault (GET /vault gone) -> unlock_failed without a prompt', async () => {
    const h = makeUnlockHarness({ meta: null });
    expect(await runPasskeyUnlock(h.deps)).toEqual({ ok: false, error: 'unlock_failed' });
    expect(h.credentials.get).not.toHaveBeenCalled();
  });
});
