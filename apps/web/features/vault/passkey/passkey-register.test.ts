import { describe, expect, it, vi } from 'vitest';
import { decodeBase64UrlStrict, encodeBase64Url } from '@/lib/crypto/b64url';
import type { ReauthGrant } from '@/lib/api/auth';
import type { VaultPasskeyItem } from '@/lib/api/vault';
import {
  GRANT_MIN_REMAINING_MS,
  MAX_IN_PROGRESS_WAITS,
  MAX_NETWORK_REPLAYS,
  runPasskeyRegistration,
  type PasskeyGrantPort,
  type PasskeyRegisterDeps,
} from './register-flow';
import {
  CREATION_ATTESTATION_OBJECT,
  CREATION_CLIENT_DATA_JSON,
  NEW_CREDENTIAL_ID,
  NOW,
  PRF_OUTPUT,
  REGISTER_CHALLENGE,
  REGISTER_SALT,
  domError,
  fakeAssertion,
  fakeCredential,
  filled,
  isAllZero,
  makeGrant,
  problem,
  prfEvalFirst,
  registerOptionsResponse,
  type FakePrfOutput,
} from './test-helpers';

const SAVED: VaultPasskeyItem = {
  id: '0d8b6a1e-52f4-4b8d-9d0a-3f6c7b2e1a90',
  name: 'Work laptop',
  aaguid: null,
  created_at: new Date(NOW).toISOString(),
};

interface HarnessOptions {
  createPrf?: FakePrfOutput | null;
  getPrf?: FakePrfOutput | null;
  createError?: unknown;
  getError?: unknown;
  grant?: ReauthGrant;
  renewed?: ReauthGrant | null;
  renewError?: unknown;
  wrapError?: unknown;
  registerBehaviour?: Array<'ok' | Error>;
  generation?: number;
  declaredSalt?: Uint8Array;
}

function makeHarness(opts: HarnessOptions = {}) {
  const log: string[] = [];
  const state = { generation: opts.generation ?? 5, now: NOW };
  const created = fakeCredential({
    rawId: NEW_CREDENTIAL_ID,
    prf: opts.createPrf === undefined ? { enabled: true, first: PRF_OUTPUT } : opts.createPrf,
  });
  const assertion = fakeAssertion({
    rawId: NEW_CREDENTIAL_ID,
    prf: opts.getPrf === undefined ? { enabled: true, first: PRF_OUTPUT } : opts.getPrf,
  });

  const wrapped: { pwk: Uint8Array; opGeneration: number; bytes: number[] }[] = [];
  const client = {
    captureGeneration: vi.fn(() => {
      log.push('captureGeneration');
      return state.generation;
    }),
    getGeneration: vi.fn(() => state.generation),
    wrapForPasskey: vi.fn(async (params: { pwk: Uint8Array | ArrayBuffer; opGeneration: number }) => {
      log.push('wrapForPasskey');
      const pwk = params.pwk as Uint8Array;
      wrapped.push({ pwk, opGeneration: params.opGeneration, bytes: Array.from(pwk) });
      if (opts.wrapError) throw opts.wrapError;
      return { vk_wrap: 'VK-WRAP-OPAQUE' };
    }),
  };

  const grant = opts.grant ?? makeGrant('grant-token-1', 5 * 60_000);
  const grants = {
    acquire: vi.fn(async () => {
      log.push('grant.acquire');
      return grant;
    }),
    renewInPlace: vi.fn(async () => {
      log.push('grant.renew');
      if (opts.renewError) throw opts.renewError;
      return opts.renewed === undefined ? makeGrant('grant-token-2', 5 * 60_000) : opts.renewed;
    }),
  } satisfies PasskeyGrantPort;

  const posts: { body: string; idempotencyKey: string; reauthToken: string }[] = [];
  const behaviour = [...(opts.registerBehaviour ?? ['ok'])];
  const api = {
    fetchRegisterOptions: vi.fn(async () => {
      log.push('options');
      return registerOptionsResponse({ declaredSalt: opts.declaredSalt });
    }),
    registerPasskey: vi.fn(async (body: string, o: { idempotencyKey: string; reauthToken: string }) => {
      log.push('post');
      posts.push({ body, ...o });
      const next = behaviour.length > 1 ? behaviour.shift() : behaviour[0];
      if (next instanceof Error) throw next;
      return SAVED;
    }),
  };

  const credentials = {
    create: vi.fn(async (options?: CredentialCreationOptions) => {
      log.push('create');
      void options;
      if (opts.createError) throw opts.createError;
      return created.credential as Credential;
    }),
    get: vi.fn(async (options?: CredentialRequestOptions) => {
      log.push('get');
      void options;
      if (opts.getError) throw opts.getError;
      return assertion.credential as Credential;
    }),
  };

  const sleep = vi.fn(async (ms: number) => {
    log.push(`sleep:${ms}`);
  });
  const createIdempotencyKey = vi.fn(() => 'idem-0123456789abcdef');

  const deps: PasskeyRegisterDeps = {
    client,
    grants,
    api,
    credentials,
    createIdempotencyKey,
    now: () => state.now,
    sleep,
  };
  return { deps, log, state, client, grants, api, credentials, posts, wrapped, created, assertion, sleep, createIdempotencyKey };
}

describe('T19 bullet 1 - register flow (plan 2.5 steps 1-6)', () => {
  it('captures opGeneration synchronously before the grant, options POST and create()', async () => {
    const h = makeHarness({ generation: 9 });
    const pending = runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    // Nothing has been awaited yet: the capture must already have happened, and nothing else before it.
    expect(h.log[0]).toBe('captureGeneration');
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    expect(h.log.indexOf('captureGeneration')).toBeLessThan(h.log.indexOf('grant.acquire'));
    expect(h.log.indexOf('grant.acquire')).toBeLessThan(h.log.indexOf('options'));
    expect(h.log.indexOf('options')).toBeLessThan(h.log.indexOf('create'));
    expect(h.client.captureGeneration).toHaveBeenCalledTimes(1);
    expect(h.wrapped[0]?.opGeneration).toBe(9);
  });

  it('takes the grant first: nothing else runs before it resolves, and a cancelled grant stops the flow', async () => {
    const h = makeHarness();
    h.grants.acquire.mockImplementationOnce(async () => {
      h.log.push('grant.acquire');
      throw new Error('reauth_cancelled');
    });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: false, error: 'reauth_cancelled', orphan: false });
    expect(h.log).toEqual(['captureGeneration', 'grant.acquire']);
  });

  it('decodes the server creation options: salt as prf.eval.first, UV required, base64url fields as bytes', async () => {
    const h = makeHarness();
    await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    const publicKey = h.credentials.create.mock.calls[0]?.[0]?.publicKey as PublicKeyCredentialCreationOptions;
    expect(Array.from(new Uint8Array(publicKey.challenge as ArrayBuffer))).toEqual(Array.from(REGISTER_CHALLENGE));
    expect(Array.from(new Uint8Array(publicKey.user.id as ArrayBuffer))).toEqual(Array.from(filled(16, 0x01)));
    expect(Array.from(new Uint8Array(publicKey.excludeCredentials?.[0]?.id as ArrayBuffer))).toEqual(
      Array.from(filled(16, 0x03)),
    );
    expect(publicKey.authenticatorSelection?.userVerification).toBe('required');
    expect(prfEvalFirst(publicKey.extensions)).toEqual(Array.from(REGISTER_SALT));
  });

  it('rejects creation options whose PRF salt differs from prf_salt before any authenticator prompt', async () => {
    const h = makeHarness({ declaredSalt: filled(32, 0x99) });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: false, error: 'register_failed', orphan: false });
    expect(h.credentials.create).not.toHaveBeenCalled();
  });

  it('wrapForPasskey receives the PWK as bytes, the POST carries the wrap, salt, challenge id, attestation and trimmed name', async () => {
    const h = makeHarness();
    const outcome = await runPasskeyRegistration(h.deps, { name: '  Work laptop  ' });
    expect(outcome).toEqual({ ok: true, passkey: SAVED });
    expect(h.wrapped[0]?.bytes).toEqual(Array.from(PRF_OUTPUT));
    expect(h.posts).toHaveLength(1);
    const post = h.posts[0]!;
    expect(post.reauthToken).toBe('grant-token-1');
    expect(post.idempotencyKey).toBe('idem-0123456789abcdef');
    const body = JSON.parse(post.body) as Record<string, unknown>;
    expect(body).toEqual({
      challenge_id: '6f1c2a5e-0b1d-4c63-9d2e-1b7f3a9c4e10',
      attestation: {
        client_data_json: encodeBase64Url(filled(10, 0x31)),
        attestation_object: encodeBase64Url(filled(12, 0x41)),
      },
      prf_salt: encodeBase64Url(REGISTER_SALT),
      vk_wrap: 'VK-WRAP-OPAQUE',
      name: 'Work laptop',
    });
    expect(decodeBase64UrlStrict(body.prf_salt as string, 32)).toHaveLength(32);
  });

  it('wipes the PWK copy and the browser PRF buffer, on success and when the Worker rejects', async () => {
    const ok = makeHarness();
    await runPasskeyRegistration(ok.deps, { name: 'Work laptop' });
    expect(isAllZero(ok.wrapped[0]!.pwk)).toBe(true);
    expect(isAllZero(ok.created.prfSource!)).toBe(true);

    const failing = makeHarness({ wrapError: { code: 'VAULT_LOCKED' } });
    const outcome = await runPasskeyRegistration(failing.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: false, error: 'register_failed', orphan: true });
    expect(isAllZero(failing.wrapped[0]!.pwk)).toBe(true);
    expect(failing.posts).toHaveLength(0);
  });

  it('PKW-R1-3, PKW-R1-5: a stale generation during create() or the follow-up get() wipes the PRF buffer: no wrap, no POST', async () => {
    const atCreate = makeHarness();
    atCreate.credentials.create.mockImplementationOnce(async () => {
      atCreate.state.generation += 1;
      return atCreate.created.credential as Credential;
    });
    expect(await runPasskeyRegistration(atCreate.deps, { name: 'Work laptop' })).toEqual({
      ok: false,
      error: 'stale',
      orphan: true,
    });
    expect(isAllZero(atCreate.created.prfSource!)).toBe(true);
    expect(atCreate.client.wrapForPasskey).not.toHaveBeenCalled();
    expect(atCreate.posts).toHaveLength(0);

    const atGet = makeHarness({ createPrf: { enabled: true }, getPrf: { enabled: true, first: PRF_OUTPUT } });
    atGet.credentials.get.mockImplementationOnce(async () => {
      atGet.state.generation += 1;
      return atGet.assertion.credential as Credential;
    });
    expect(await runPasskeyRegistration(atGet.deps, { name: 'Work laptop' })).toEqual({
      ok: false,
      error: 'stale',
      orphan: true,
    });
    expect(isAllZero(atGet.assertion.prfSource!)).toBe(true);
    expect(atGet.client.wrapForPasskey).not.toHaveBeenCalled();
    expect(atGet.posts).toHaveLength(0);
  });

  it('PKW-R1-6: a lock during the grant or options await stops before create() and leaves no local credential', async () => {
    const atGrant = makeHarness();
    atGrant.grants.acquire.mockImplementationOnce(async () => {
      atGrant.state.generation += 1;
      return makeGrant('g1', 5 * 60_000);
    });
    expect(await runPasskeyRegistration(atGrant.deps, { name: 'Work laptop' })).toEqual({
      ok: false,
      error: 'stale',
      orphan: false,
    });
    expect(atGrant.api.fetchRegisterOptions).not.toHaveBeenCalled();
    expect(atGrant.credentials.create).not.toHaveBeenCalled();

    const atOptions = makeHarness();
    atOptions.api.fetchRegisterOptions.mockImplementationOnce(async () => {
      atOptions.state.generation += 1;
      return registerOptionsResponse();
    });
    expect(await runPasskeyRegistration(atOptions.deps, { name: 'Work laptop' })).toEqual({
      ok: false,
      error: 'stale',
      orphan: false,
    });
    expect(atOptions.credentials.create).not.toHaveBeenCalled();
    expect(atOptions.posts).toHaveLength(0);
  });

  it('PKW-R1-9: a lock while the POST is in flight returns stale (orphan: false when the server saved it)', async () => {
    const saved = makeHarness();
    saved.api.registerPasskey.mockImplementationOnce(async (body, o) => {
      saved.posts.push({ body, ...o });
      saved.state.generation += 1;
      return SAVED;
    });
    expect(await runPasskeyRegistration(saved.deps, { name: 'Work laptop' })).toEqual({
      ok: false,
      error: 'stale',
      orphan: false,
    });

    const rejected = makeHarness();
    rejected.api.registerPasskey.mockImplementationOnce(async () => {
      rejected.state.generation += 1;
      throw problem(400, 'passkey_challenge_invalid');
    });
    expect(await runPasskeyRegistration(rejected.deps, { name: 'Work laptop' })).toEqual({
      ok: false,
      error: 'stale',
      orphan: true,
    });
  });

  it('a Worker STALE_GENERATION is reported as stale, not as a register failure', async () => {
    const h = makeHarness({ wrapError: { code: 'STALE_GENERATION' } });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toMatchObject({ ok: false, error: 'stale' });
    expect(h.posts).toHaveLength(0);
  });
});

describe('T19 bullet 1 - credential naming', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['x'.repeat(65), 'too_long'],
    ['bad\u0007name', 'forbidden_chars'],
    ['line\nbreak', 'forbidden_chars'],
    ['evil\u202Eexe', 'forbidden_chars'],
    ['iso\u2067late', 'forbidden_chars'],
  ])('rejects %j client-side (%s) before the grant, options POST or create()', async (name, reason) => {
    const h = makeHarness();
    const outcome = await runPasskeyRegistration(h.deps, { name });
    expect(outcome).toEqual({ ok: false, error: 'name_invalid', orphan: false, nameReason: reason });
    expect(h.grants.acquire).not.toHaveBeenCalled();
    expect(h.api.fetchRegisterOptions).not.toHaveBeenCalled();
    expect(h.credentials.create).not.toHaveBeenCalled();
  });

  it('counts runes, not UTF-16 units: 64 astral characters are accepted, 65 are not', async () => {
    const ok = makeHarness();
    expect((await runPasskeyRegistration(ok.deps, { name: '\u{1F511}'.repeat(64) })).ok).toBe(true);
    const tooLong = makeHarness();
    expect(await runPasskeyRegistration(tooLong.deps, { name: '\u{1F511}'.repeat(65) })).toMatchObject({
      error: 'name_invalid',
      nameReason: 'too_long',
    });
  });
});

describe('T19 bullet 4 - PRF matrix at registration', () => {
  it('PRF output directly at create(): results.first is used, no get()', async () => {
    const h = makeHarness({ createPrf: { enabled: true, first: PRF_OUTPUT } });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome.ok).toBe(true);
    expect(h.credentials.get).not.toHaveBeenCalled();
    expect(h.wrapped[0]?.bytes).toEqual(Array.from(PRF_OUTPUT));
  });

  it('only prf.enabled at create(), then get() with UV required, the salt, a client-made challenge and the same opGeneration', async () => {
    const getOutput = filled(32, 0x77);
    const h = makeHarness({
      generation: 12,
      createPrf: { enabled: true },
      getPrf: { enabled: true, first: getOutput },
    });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome.ok).toBe(true);
    expect(h.credentials.get).toHaveBeenCalledTimes(1);
    const request = h.credentials.get.mock.calls[0]?.[0]?.publicKey as PublicKeyCredentialRequestOptions;
    expect(request.userVerification).toBe('required');
    expect(Array.from(new Uint8Array(request.allowCredentials?.[0]?.id as ArrayBuffer))).toEqual(
      Array.from(NEW_CREDENTIAL_ID),
    );
    expect(prfEvalFirst(request.extensions)).toEqual(Array.from(REGISTER_SALT));
    const challenge = new Uint8Array(request.challenge as ArrayBuffer);
    expect(challenge).toHaveLength(32);
    expect(Array.from(challenge)).not.toEqual(Array.from(REGISTER_CHALLENGE));
    expect(h.wrapped[0]?.bytes).toEqual(Array.from(getOutput));
    expect(h.wrapped[0]?.opGeneration).toBe(12);
    expect(h.client.captureGeneration).toHaveBeenCalledTimes(1);
    // PKW-R1-20: the assertion has no attestationObject; the POST carries the create() attestation.
    expect(h.posts).toHaveLength(1);
    expect(JSON.parse(h.posts[0]!.body).attestation).toEqual({
      client_data_json: encodeBase64Url(CREATION_CLIENT_DATA_JSON),
      attestation_object: encodeBase64Url(CREATION_ATTESTATION_OBJECT),
    });
    expect(isAllZero(h.assertion.prfSource!)).toBe(true);
  });

  it('two follow-up get() challenges are fresh random values', async () => {
    const first = makeHarness({ createPrf: { enabled: true } });
    const second = makeHarness({ createPrf: { enabled: true } });
    await runPasskeyRegistration(first.deps, { name: 'a' });
    await runPasskeyRegistration(second.deps, { name: 'b' });
    const c1 = (first.credentials.get.mock.calls[0]?.[0]?.publicKey as PublicKeyCredentialRequestOptions)
      .challenge as ArrayBuffer;
    const c2 = (second.credentials.get.mock.calls[0]?.[0]?.publicKey as PublicKeyCredentialRequestOptions)
      .challenge as ArrayBuffer;
    expect(Array.from(new Uint8Array(c1))).not.toEqual(Array.from(new Uint8Array(c2)));
  });

  it('unsupported (prf.enabled !== true, or no prf entry): passkey.prf_unsupported, nothing sent to the server', async () => {
    for (const createPrf of [{ enabled: false }, { enabled: undefined }, null] as const) {
      const h = makeHarness({ createPrf });
      const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
      expect(outcome).toEqual({ ok: false, error: 'prf_unsupported', orphan: true });
      expect(h.credentials.get).not.toHaveBeenCalled();
      expect(h.client.wrapForPasskey).not.toHaveBeenCalled();
      expect(h.posts).toHaveLength(0);
    }
  });

  it('unsupported even when results.first is present but enabled is not true, and the PRF buffer is wiped', async () => {
    const h = makeHarness({ createPrf: { enabled: false, first: PRF_OUTPUT } });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toMatchObject({ ok: false, error: 'prf_unsupported' });
    expect(isAllZero(h.created.prfSource!)).toBe(true);
    expect(h.client.wrapForPasskey).not.toHaveBeenCalled();
  });

  it('cancel at create(): passkey.register_cancelled, no orphan, no get()', async () => {
    const h = makeHarness({ createError: domError('NotAllowedError') });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: false, error: 'register_cancelled', orphan: false });
    expect(h.credentials.get).not.toHaveBeenCalled();
    expect(h.posts).toHaveLength(0);
  });

  it('a create() failure that is not a cancel (e.g. excluded credential) is register_failed without orphan', async () => {
    const h = makeHarness({ createError: domError('InvalidStateError') });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: false, error: 'register_failed', orphan: false });
  });

  it('PKW-R1-24: cancel at the follow-up get() is passkey.register_cancelled with orphan: true; other get() errors stay register_failed', async () => {
    const cancelled = makeHarness({ createPrf: { enabled: true }, getError: domError('NotAllowedError') });
    expect(await runPasskeyRegistration(cancelled.deps, { name: 'Work laptop' })).toEqual({
      ok: false,
      error: 'register_cancelled',
      orphan: true,
    });
    expect(cancelled.client.wrapForPasskey).not.toHaveBeenCalled();
    expect(cancelled.posts).toHaveLength(0);

    const failed = makeHarness({ createPrf: { enabled: true }, getError: domError('SecurityError') });
    expect(await runPasskeyRegistration(failed.deps, { name: 'Work laptop' })).toEqual({
      ok: false,
      error: 'register_failed',
      orphan: true,
    });
  });

  it('get() without results.first: register error, orphan, no wrap, no POST', async () => {
    const h = makeHarness({ createPrf: { enabled: true }, getPrf: { enabled: true } });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: false, error: 'register_failed', orphan: true });
    expect(h.client.wrapForPasskey).not.toHaveBeenCalled();
    expect(h.posts).toHaveLength(0);
  });

  it('a PRF output that is not 32 bytes is never wrapped', async () => {
    // 16 bytes at create(): malformed, must not reach the Worker.
    const h = makeHarness({ createPrf: { enabled: true, first: filled(16, 0x01) } });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toMatchObject({ ok: false, error: 'register_failed' });
    expect(h.client.wrapForPasskey).not.toHaveBeenCalled();
  });

  it('grant near expiry before POST: password user re-authenticates in place, then the POST succeeds with the new grant', async () => {
    const h = makeHarness({
      grant: makeGrant('grant-near-expiry', GRANT_MIN_REMAINING_MS - 1_000),
      renewed: makeGrant('grant-renewed', 5 * 60_000),
    });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome.ok).toBe(true);
    expect(h.grants.renewInPlace).toHaveBeenCalledTimes(1);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.reauthToken).toBe('grant-renewed');
    expect(h.log.indexOf('grant.renew')).toBeLessThan(h.log.indexOf('post'));
    expect(h.log.indexOf('wrapForPasskey')).toBeLessThan(h.log.indexOf('grant.renew'));
  });

  it('grant near expiry before POST: OAuth-only user is told to restart, nothing is POSTed', async () => {
    const h = makeHarness({ grant: makeGrant('grant-near-expiry', 10_000), renewed: null });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: false, error: 'reauth_restart_required', orphan: true });
    expect(h.posts).toHaveLength(0);
  });

  it('a grant with exactly 60 s left is used as is; one with 59.9 s is renewed', async () => {
    const boundary = makeHarness({ grant: makeGrant('exact', GRANT_MIN_REMAINING_MS) });
    await runPasskeyRegistration(boundary.deps, { name: 'Work laptop' });
    expect(boundary.grants.renewInPlace).not.toHaveBeenCalled();
    expect(boundary.posts[0]?.reauthToken).toBe('exact');

    const below = makeHarness({ grant: makeGrant('below', GRANT_MIN_REMAINING_MS - 100) });
    await runPasskeyRegistration(below.deps, { name: 'Work laptop' });
    expect(below.grants.renewInPlace).toHaveBeenCalledTimes(1);
  });

  it('cancelling the in-place re-auth stops before the POST', async () => {
    const h = makeHarness({
      grant: makeGrant('grant-near-expiry', 5_000),
      renewError: new Error('reauth_cancelled'),
    });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: false, error: 'reauth_cancelled', orphan: true });
    expect(h.posts).toHaveLength(0);
  });

  it('PKW-R1-7, PKW-R1-8: a lock during the in-place grant renewal aborts before the POST and returns stale', async () => {
    const h = makeHarness({ grant: makeGrant('grant-near-expiry', 5_000) });
    h.grants.renewInPlace.mockImplementationOnce(async () => {
      h.log.push('grant.renew');
      h.state.generation += 1;
      return makeGrant('grant-renewed', 5 * 60_000);
    });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: false, error: 'stale', orphan: true });
    expect(h.posts).toHaveLength(0);
  });

  it('PKW-R1-10: a renewed grant must also have >= 60 s remaining; 59 s is refused before the POST, 60 s is accepted', async () => {
    const tooShort = makeHarness({
      grant: makeGrant('grant-near-expiry', 5_000),
      renewed: makeGrant('renewed-short', 59_000),
    });
    expect(await runPasskeyRegistration(tooShort.deps, { name: 'Work laptop' })).toEqual({
      ok: false,
      error: 'reauth_restart_required',
      orphan: true,
    });
    expect(tooShort.posts).toHaveLength(0);

    const exact = makeHarness({
      grant: makeGrant('grant-near-expiry', 5_000),
      renewed: makeGrant('renewed-60', GRANT_MIN_REMAINING_MS),
    });
    expect((await runPasskeyRegistration(exact.deps, { name: 'Work laptop' })).ok).toBe(true);
    expect(exact.posts[0]?.reauthToken).toBe('renewed-60');
  });
});

describe('T19 bullet 1 - POST failure and replay', () => {
  it('orphan notice: a definite POST rejection says the credential was not saved, with no replay', async () => {
    const h = makeHarness({ registerBehaviour: [problem(400, 'passkey_challenge_invalid')] });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: false, error: 'register_failed', orphan: true });
    expect(h.posts).toHaveLength(1);
  });

  it.each([
    [400, 'passkey_challenge_invalid'],
    [400, 'passkey_attestation_invalid'],
    [400, 'passkey_name_invalid'],
    [400, 'vault_wrap_invalid'],
    [400, 'invalid_request'],
    [401, 'reauth_required'],
    [401, 'reauth_invalid'],
    [403, 'reauth_unsupported_provider'],
    [404, 'vault_absent'],
    [409, 'passkey_exists'],
    [503, 'vault_mutations_disabled'],
    [429, 'rate_limited'],
  ])('PKW-R2-1: a first-submission %i %s rejection is definite (orphan notice, one POST)', async (status, code) => {
    const h = makeHarness({ registerBehaviour: [problem(status, code)] });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: false, error: 'register_failed', orphan: true });
    expect(h.posts).toHaveLength(1);
  });

  it('network loss replays the same request: same key, same body bytes, same grant token even after it expired; one key generated', async () => {
    const h = makeHarness();
    h.api.registerPasskey.mockImplementationOnce(async (body, o) => {
      h.log.push('post');
      h.posts.push({ body, ...o });
      // The grant expires while the response is lost; the replay must still use the original token.
      h.state.now = NOW + 10 * 60_000;
      throw new TypeError('Failed to fetch');
    });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: true, passkey: SAVED });
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]).toEqual(h.posts[0]);
    expect(h.createIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(h.grants.renewInPlace).not.toHaveBeenCalled();
    expect(h.sleep).toHaveBeenCalledTimes(1);
  });

  it('a replay that finds the first POST committed returns the stored 201: no orphan notice', async () => {
    const h = makeHarness({ registerBehaviour: [new TypeError('Failed to fetch'), 'ok'] });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: true, passkey: SAVED });
  });

  it('an ambiguous outcome that never resolves is network_unknown, never an orphan claim', async () => {
    const h = makeHarness({ registerBehaviour: [new TypeError('Failed to fetch')] });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: false, error: 'network_unknown', orphan: false });
    expect(h.posts).toHaveLength(1 + MAX_NETWORK_REPLAYS);
    expect(new Set(h.posts.map((p) => p.body)).size).toBe(1);
    expect(new Set(h.posts.map((p) => p.idempotencyKey)).size).toBe(1);
  });

  it('409 idempotency_in_progress waits Retry-After then replays the same request', async () => {
    const h = makeHarness({ registerBehaviour: [problem(409, 'idempotency_in_progress', 1), 'ok'] });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome.ok).toBe(true);
    expect(h.sleep).toHaveBeenCalledWith(1_000);
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]).toEqual(h.posts[0]);
  });

  it('a gateway 504 is treated as a lost response (replayed), unlike a definite 400', async () => {
    const h = makeHarness({ registerBehaviour: [problem(504, 'gateway_timeout'), 'ok'] });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome.ok).toBe(true);
    expect(h.posts).toHaveLength(2);
  });

  it('PKW-R1-1: a 500 internal_error is unproven; the replay finds the stored 201, no orphan notice', async () => {
    const h = makeHarness({ registerBehaviour: [problem(500, 'internal_error'), 'ok'] });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: true, passkey: SAVED });
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]).toEqual(h.posts[0]);
  });

  it('PKW-R1-1: a 500 that never resolves is network_unknown, never an orphan claim', async () => {
    const h = makeHarness({ registerBehaviour: [problem(500, 'internal_error')] });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: false, error: 'network_unknown', orphan: false });
    expect(h.posts).toHaveLength(1 + MAX_NETWORK_REPLAYS);
  });

  it('PKW-R2-1, PKW-R1-2: lost first response, then pre-lookup 400 invalid_request on replay is network_unknown (orphan: false, identical key/body/token)', async () => {
    const h = makeHarness({
      registerBehaviour: [new TypeError('Failed to fetch'), problem(400, 'invalid_request')],
    });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: false, error: 'network_unknown', orphan: false });
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]).toEqual(h.posts[0]);
  });

  it.each([
    [400, 'invalid_request'],
    [413, 'invalid_request'],
    [415, 'invalid_request'],
    [401, 'session_invalid'],
    [401, 'unauthenticated'],
    [401, 'access_expired'],
    [403, 'csrf_invalid'],
    [429, 'rate_limited'],
  ])('PKW-R2-1, PKW-R1-2: lost response, then a pre-lookup %i %s on the replay is unknown, not an orphan', async (status, code) => {
    const h = makeHarness({ registerBehaviour: [new TypeError('Failed to fetch'), problem(status, code)] });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: false, error: 'network_unknown', orphan: false });
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]).toEqual(h.posts[0]);
  });

  it.each([
    [400, 'passkey_challenge_invalid'],
    [400, 'passkey_attestation_invalid'],
    [400, 'passkey_name_invalid'],
    [400, 'vault_wrap_invalid'],
    [401, 'reauth_required'],
    [401, 'reauth_invalid'],
    [403, 'reauth_unsupported_provider'],
    [404, 'vault_absent'],
    [409, 'passkey_exists'],
    [409, 'idempotency_conflict'],
    [503, 'vault_mutations_disabled'],
  ])(
    'PKW-R3-1, PKW-R2-1, PKW-R1-2: lost response, then a post-lookup %i %s on the replay stays network_unknown (orphan: false, identical key/body/token; advisor-dec-057)',
    async (status, code) => {
      const h = makeHarness({ registerBehaviour: [problem(500, 'internal_error'), problem(status, code)] });
      const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
      expect(outcome).toEqual({ ok: false, error: 'network_unknown', orphan: false });
      expect(h.posts).toHaveLength(2);
      expect(h.posts[1]).toEqual(h.posts[0]);
    },
  );

  it('PKW-R3-1: lost response, then replay 401 reauth_invalid is network_unknown (orphan: false, identical key/body/token)', async () => {
    const h = makeHarness({
      registerBehaviour: [new TypeError('Failed to fetch'), problem(401, 'reauth_invalid')],
    });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: false, error: 'network_unknown', orphan: false });
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]).toEqual(h.posts[0]);
  });

  it('PKW-R3-1: lost response, then replay 503 (vault_mutations_disabled or dependency_unavailable) is network_unknown (orphan: false, identical key/body/token)', async () => {
    const killSwitch = makeHarness({
      registerBehaviour: [new TypeError('Failed to fetch'), problem(503, 'vault_mutations_disabled')],
    });
    expect(await runPasskeyRegistration(killSwitch.deps, { name: 'Work laptop' })).toEqual({
      ok: false,
      error: 'network_unknown',
      orphan: false,
    });
    expect(killSwitch.posts).toHaveLength(2);
    expect(killSwitch.posts[1]).toEqual(killSwitch.posts[0]);

    const depDown = makeHarness({
      registerBehaviour: [new TypeError('Failed to fetch'), problem(503, 'dependency_unavailable')],
    });
    expect(await runPasskeyRegistration(depDown.deps, { name: 'Work laptop' })).toEqual({
      ok: false,
      error: 'network_unknown',
      orphan: false,
    });
    expect(depDown.posts).toHaveLength(1 + MAX_NETWORK_REPLAYS);
    expect(new Set(depDown.posts.map((p) => p.idempotencyKey)).size).toBe(1);
    expect(new Set(depDown.posts.map((p) => p.body)).size).toBe(1);
    expect(new Set(depDown.posts.map((p) => p.reauthToken)).size).toBe(1);
  });

  it('PKW-R3-1: lost response, then replay 409 (passkey_exists, idempotency_conflict, or idempotency_in_progress exhaustion) is network_unknown (orphan: false, identical key/body/token)', async () => {
    for (const code of ['passkey_exists', 'idempotency_conflict'] as const) {
      const h = makeHarness({
        registerBehaviour: [new TypeError('Failed to fetch'), problem(409, code)],
      });
      expect(await runPasskeyRegistration(h.deps, { name: 'Work laptop' })).toEqual({
        ok: false,
        error: 'network_unknown',
        orphan: false,
      });
      expect(h.posts).toHaveLength(2);
      expect(h.posts[1]).toEqual(h.posts[0]);
    }

    const inProgressExhausted = makeHarness({
      registerBehaviour: [new TypeError('Failed to fetch'), problem(409, 'idempotency_in_progress', 1)],
    });
    expect(await runPasskeyRegistration(inProgressExhausted.deps, { name: 'Work laptop' })).toEqual({
      ok: false,
      error: 'network_unknown',
      orphan: false,
    });
    expect(inProgressExhausted.posts).toHaveLength(2 + MAX_IN_PROGRESS_WAITS);
    expect(new Set(inProgressExhausted.posts.map((p) => p.idempotencyKey)).size).toBe(1);
    expect(new Set(inProgressExhausted.posts.map((p) => p.body)).size).toBe(1);
    expect(new Set(inProgressExhausted.posts.map((p) => p.reauthToken)).size).toBe(1);
  });

  it('PKW-R3-1: lost response, then replay 400 (passkey_challenge_invalid) is network_unknown (orphan: false, identical key/body/token)', async () => {
    const h = makeHarness({
      registerBehaviour: [new TypeError('Failed to fetch'), problem(400, 'passkey_challenge_invalid')],
    });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: false, error: 'network_unknown', orphan: false });
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]).toEqual(h.posts[0]);
  });

  it('PKW-R3-1: lost response, then replay network failure is network_unknown (orphan: false, identical key/body/token)', async () => {
    const h = makeHarness({
      registerBehaviour: [new TypeError('Failed to fetch'), new TypeError('NetworkError when attempting to fetch resource.')],
    });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: false, error: 'network_unknown', orphan: false });
    expect(h.posts).toHaveLength(1 + MAX_NETWORK_REPLAYS);
    expect(new Set(h.posts.map((p) => p.idempotencyKey)).size).toBe(1);
    expect(new Set(h.posts.map((p) => p.body)).size).toBe(1);
    expect(new Set(h.posts.map((p) => p.reauthToken)).size).toBe(1);
  });
  it('PKW-R1-2: without any earlier unknown attempt a 401 session_invalid is a definite rejection', async () => {
    const h = makeHarness({ registerBehaviour: [problem(401, 'session_invalid')] });
    const outcome = await runPasskeyRegistration(h.deps, { name: 'Work laptop' });
    expect(outcome).toEqual({ ok: false, error: 'register_failed', orphan: true });
    expect(h.posts).toHaveLength(1);
  });
});
