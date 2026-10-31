import { ProblemError } from '@engram/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completeRecovery,
  createIdempotencyKey,
  createVault,
  fetchPasskeyRegisterOptions,
  fetchPasskeysList,
  fetchPasskeyUnlockOptions,
  fetchRecoveryKeysStatus,
  fetchVault,
  formatVaultIfMatch,
  lookupRecoveryKey,
  regenerateRecoveryKeys,
  registerPasskey,
  renamePasskey,
  resetVault,
   revokePasskey,
  rewrapVault,
  rotateRecoveryKeys,
} from '@/lib/api/vault';

const SAMPLE_KEY_ID = 'vk:7f3a91c4e0b2d8a1f5c309';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('lib/api/vault', () => {
  beforeEach(() => {
    document.cookie = 'sabk_csrf=test-csrf-token';
    vi.stubGlobal('navigator', {
      ...navigator,
      locks: {
        request: async (_name: string, callback: () => Promise<unknown>) => callback(),
      },
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('formats strong If-Match tag "<vault_key_id>:<version>" and rejects malformed inputs', () => {
    expect(formatVaultIfMatch(SAMPLE_KEY_ID, 1)).toBe(`"${SAMPLE_KEY_ID}:1"`);
    expect(formatVaultIfMatch(SAMPLE_KEY_ID, 42)).toBe(`"${SAMPLE_KEY_ID}:42"`);
    expect(() => formatVaultIfMatch('invalid', 1)).toThrow(/Invalid vault_key_id/);
    expect(() => formatVaultIfMatch(SAMPLE_KEY_ID, 0)).toThrow(/Invalid vault version/);
    expect(() => formatVaultIfMatch(SAMPLE_KEY_ID, -1)).toThrow(/Invalid vault version/);
  });

  it('generates UUID v4 idempotency keys matching [A-Za-z0-9_-]{16,128}', () => {
    const key1 = createIdempotencyKey();
    const key2 = createIdempotencyKey();
    expect(key1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(key1).not.toBe(key2);
  });

  it('calls GET /vault and GET /vault/recovery-keys and GET /vault/passkeys with session and CSRF', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          vault_key_id: SAMPLE_KEY_ID,
          version: 1,
          kdf: { alg: 'argon2id13', ops: 3, mem: 67108864, parallelism: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA' },
          vault_key_wrapped_by_kek: 'wrapK',
          x25519_public: 'xpub',
          ed25519_public: 'epub',
          private_keys_wrapped: 'wrapP',
          recovery_keys_remaining: 10,
          passkeys: [],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ remaining: 9, slots: 10, empty_slots: [3] }))
      .mockResolvedValueOnce(jsonResponse({ items: [] }));

    const vault = await fetchVault();
    expect(vault.vault_key_id).toBe(SAMPLE_KEY_ID);

    const rkStatus = await fetchRecoveryKeysStatus();
    expect(rkStatus.empty_slots).toEqual([3]);

    const passkeys = await fetchPasskeysList();
    expect(passkeys.items).toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/vault');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/vault/recovery-keys');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/v1/vault/passkeys');
  });

  it('sends Idempotency-Key, If-Match, and X-Reauth-Token on vault mutations and no body on DELETE /vault', async () => {
    const fetchMock = vi.mocked(fetch);
    const ifMatch = formatVaultIfMatch(SAMPLE_KEY_ID, 2);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ vault_key_id: SAMPLE_KEY_ID, version: 1 }, 201))
      .mockResolvedValueOnce(jsonResponse({ version: 3 }, 200))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ recovery_key_id: 'rk-uuid', wrap: 'wrapR' }, 200))
      .mockResolvedValueOnce(jsonResponse({ version: 4 }, 200))
      .mockResolvedValueOnce(jsonResponse({ remaining: 10, version: 5 }, 200))
      .mockResolvedValueOnce(jsonResponse({ remaining: 10, version: 6 }, 200))
      .mockResolvedValueOnce(
        jsonResponse({
          challenge_id: 'ch-1',
          public_key: { rp: { name: 'engram' }, user: { id: 'u', name: 'u', displayName: 'u' }, challenge: 'c', pubKeyCredParams: [] },
          prf_salt: 'salt',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { id: 'pk-1', name: 'Key 1', aaguid: null, created_at: '2026-10-29T00:00:00Z' },
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { id: 'pk-1', name: 'Renamed', aaguid: null, created_at: '2026-10-29T00:00:00Z' },
          200,
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        jsonResponse({
          public_key: { challenge: 'c', allowCredentials: [] },
          credentials: [],
        }),
      );

    await createVault('{"raw":true}', { idempotencyKey: 'idem-create-123456' });
    const createCall = fetchMock.mock.calls[0];
    const createHeaders = new Headers(createCall?.[1]?.headers);
    expect(createCall?.[0]).toBe('/api/v1/vault');
    expect(createCall?.[1]?.method).toBe('POST');
    expect(createCall?.[1]?.body).toBe('{"raw":true}');
    expect(createHeaders.get('Idempotency-Key')).toBe('idem-create-123456');

    await rewrapVault(
      {
        kdf: { alg: 'argon2id13', ops: 3, mem: 67108864, parallelism: 1, salt: 'BBBBBBBBBBBBBBBBBBBBBB' },
        vault_key_wrapped_by_kek: 'wrapK2',
      },
      { idempotencyKey: 'idem-rewrap-123456', ifMatch, reauthToken: 'grant-rewrap' },
    );
    const rewrapHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(rewrapHeaders.get('If-Match')).toBe(ifMatch);
    expect(rewrapHeaders.get('Idempotency-Key')).toBe('idem-rewrap-123456');
    expect(rewrapHeaders.get('X-Reauth-Token')).toBe('grant-rewrap');

    await resetVault({
      idempotencyKey: 'idem-reset-123456',
      ifMatch,
      reauthToken: 'grant-reset',
    });
    const resetInit = fetchMock.mock.calls[2]?.[1];
    const resetHeaders = new Headers(resetInit?.headers);
    expect(resetInit?.method).toBe('DELETE');
    expect(resetInit?.body).toBeNull();
    expect(resetHeaders.get('If-Match')).toBe(ifMatch);
    expect(resetHeaders.get('Idempotency-Key')).toBe('idem-reset-123456');
    expect(resetHeaders.get('X-Reauth-Token')).toBe('grant-reset');

    await lookupRecoveryKey({ lookup_hash: 'hash1' });
    await completeRecovery(
      {
        recovery_key_id: 'rk-uuid',
        kdf: { alg: 'argon2id13', ops: 3, mem: 67108864, parallelism: 1, salt: 'CCCCCCCCCCCCCCCCCCCCCC' },
        vault_key_wrapped_by_kek: 'wrapK3',
      },
      { idempotencyKey: 'idem-recover-12345', ifMatch, reauthToken: 'grant-recover' },
    );
    await regenerateRecoveryKeys(
      { recovery_keys: [{ slot: 1, lookup_hash: 'h', wrap: 'w' }] },
      { idempotencyKey: 'idem-regen-123456', ifMatch, reauthToken: 'grant-regen' },
    );
    await rotateRecoveryKeys(
      { recovery_keys: [{ slot: 1, lookup_hash: 'h', wrap: 'w' }] },
      { idempotencyKey: 'idem-rotate-12345', ifMatch, reauthToken: 'grant-rotate' },
    );
    await fetchPasskeyRegisterOptions();
    await registerPasskey(
      {
        challenge_id: 'ch-1',
        attestation: { client_data_json: 'cd', attestation_object: 'ao' },
        prf_salt: 'salt',
        vk_wrap: 'vkw',
        name: 'Key 1',
      },
      { idempotencyKey: 'idem-pk-12345678', reauthToken: 'grant-pk' },
    );
    await renamePasskey('pk-1', { name: 'Renamed' });
    await revokePasskey('pk-1', 'grant-pk-revoke');
    await fetchPasskeyUnlockOptions();

    expect(fetchMock).toHaveBeenCalledTimes(12);
  });

  it('surfaces ProblemError on 404 vault_absent or 412 version_mismatch', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: 'https://engram.zone17.click/problems/version_mismatch',
          title: 'Version mismatch',
          status: 412,
          code: 'version_mismatch',
          current_version: 7,
        }),
        { status: 412, headers: { 'content-type': 'application/problem+json' } },
      ),
    );

    await expect(fetchVault()).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ProblemError &&
        err.problem.code === 'version_mismatch' &&
        err.problem.current_version === 7
      );
    });
  });
});
