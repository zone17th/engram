import type { ProblemDetails } from '@engram/shared-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ENTRY_MAX_PLAINTEXT_BYTES,
  EntrySealError,
  VAULT_SECRET_INPUT_PROPS,
  assertVaultSecretElementAttributes,
  computePlaintextLenBucket,
  createConcurrencyLimiter,
  createRealEntryBodyLoader,
  entryBodyLoadLimiter,
  mutateSealedEntryCreate,
  mutateSealedEntryImportJson,
  mutateSealedEntryUpdate,
  resetEntryBodyLoadLimiterForTests,
  sealEntryImportJson,
  sealEntryUpdate,
  sealNewEntry,
  toEntryCreateVariables,
  toEntryImportJsonVariables,
  toEntryUpdateVariables,
  useCreateEntryMutation,
  useUpdateEntryMutation,
  type SealedEntryCreateVariables,
  type SealedEntryUpdatePayload,
  type SealedEntryUpdateVariables,
  type SealedNewEntryPayload,
} from '@/features/entries';
import { assertNoPlaintextAttrs } from '@/features/entries/test-utils/assert-no-plaintext-attrs';
import {
  EntryBody,
  LOCK_MASK_TEXT,
  type EntryBodyLoader,
} from '@/features/items/entry-body';
import { contentQueryKeys } from '@/features/items/query-keys';
import {
  SessionProvider,
  useSession,
} from '@/features/auth/session-provider';
import {
  VAULT_BODY_QUERY_KEY_PREFIX,
  VaultProvider,
  resetVaultBroadcastForTests,
  useVault,
  vaultBodyQueryKey,
  type LockEpochEnvironment,
  type VaultContextValue,
} from '@/features/vault';
import type { Me } from '@/lib/api/auth';
import * as contentApi from '@/lib/api/content';
import type { Entry, EntryMeta, EntryMetaList } from '@/lib/api/content';
import {
  CryptoClientError,
  CryptoWorkerError,
  type CreateVaultResult,
  type CryptoClient,
} from '@/lib/crypto/client';
import { KEK_BYTES, type DeriveKekFn, type ValidatedKdfParams } from '@/lib/crypto/kdf';
import type { Sodium } from '@/lib/crypto/sodium';
import { createWorkerShim } from '@/lib/crypto/test/worker-shim';
import en from '@/messages/en.json';
import viMessages from '@/messages/vi.json';

const PASSPHRASE = 'task14-real-entry-passphrase-1';
const KEY_ID = 'vk:7f3a91c4e0b2d8a1f5c309';
const OLD_KEY_ID = 'vk:0000000000000000000000';
const ITEM_ID = '11111111-1111-4111-8111-111111111111';
const ENTRY_ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENTRY_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const USER_A_ID = '33333333-3333-4333-8333-333333333333';
const USER_B_ID = '44444444-4444-4444-8444-444444444444';

const fastTestDeriveKek: DeriveKekFn = (
  sodium: Sodium,
  passphrase: Uint8Array,
  params: ValidatedKdfParams,
): Uint8Array => {
  const input = new Uint8Array(passphrase.byteLength + params.saltBytes.byteLength + 8);
  input.set(passphrase, 0);
  input.set(params.saltBytes, passphrase.byteLength);
  const view = new DataView(
    input.buffer,
    input.byteOffset + passphrase.byteLength + params.saltBytes.byteLength,
    8,
  );
  view.setUint32(0, params.ops, true);
  view.setUint32(4, params.mem, true);
  return sodium.crypto_generichash(KEK_BYTES, input, null, 'uint8array');
};

function makeSimpleLockEpochEnv(): LockEpochEnvironment {
  let marker = { epochIncarnation: 'inc-task14-1', lockEpoch: 1 };
  const fakeIdb = {
    open() {
      const req: Record<string, unknown> = {
        result: {
          objectStoreNames: {
            contains: () => true,
          },
          transaction() {
            let pending = 0;
            const tx: Record<string, unknown> = {
              objectStore() {
                const scheduleComplete = () => {
                  if (pending === 0) {
                    queueMicrotask(() => {
                      if (pending === 0 && typeof tx.oncomplete === 'function') {
                        tx.oncomplete();
                      }
                    });
                  }
                };
                return {
                  get() {
                    pending += 1;
                    const getReq: Record<string, unknown> = { result: marker };
                    queueMicrotask(() => {
                      pending -= 1;
                      if (typeof getReq.onsuccess === 'function') getReq.onsuccess();
                      scheduleComplete();
                    });
                    return getReq;
                  },
                  put(val: typeof marker) {
                    pending += 1;
                    marker = val;
                    const putReq: Record<string, unknown> = { result: undefined };
                    queueMicrotask(() => {
                      pending -= 1;
                      if (typeof putReq.onsuccess === 'function') putReq.onsuccess();
                      scheduleComplete();
                    });
                    return putReq;
                  },
                  delete() {
                    pending += 1;
                    const delReq: Record<string, unknown> = { result: undefined };
                    queueMicrotask(() => {
                      pending -= 1;
                      if (typeof delReq.onsuccess === 'function') delReq.onsuccess();
                      scheduleComplete();
                    });
                    return delReq;
                  },
                };
              },
            };
            return tx;
          },
          close() {},
        },
      };
      queueMicrotask(() => {
        if (typeof req.onsuccess === 'function') req.onsuccess();
      });
      return req;
    },
  } as unknown as IDBFactory;

  return {
    idbFactory: fakeIdb,
    locksManager: {
      request: async (_name: string, _opts: unknown, cb: () => Promise<unknown>) => cb(),
    } as unknown as LockManager,
  };
}

function makeMe(userId = USER_A_ID, vaultStatus: 'present' | 'absent' = 'present'): Me {
  return {
    user: {
      id: userId,
      email: `${userId}@example.test`,
      email_verified: true,
      created_at: '2026-11-01T00:00:00Z',
    },
    settings: { locale: 'en', theme: 'light', auto_lock_minutes: 15, semantic_suggest: false },
    identities: [{ provider: 'password', linked_at: '2026-11-01T00:00:00Z' }],
    features: {
      semantic_available: false,
      email_verification_required: false,
      oauth_providers: [],
      oauth_reauth_providers: [],
      password_enrollment_available: false,
      captcha_site_key: null,
    },
    vault: { status: vaultStatus },
  };
}

function makeVaultGetResponse(created: CreateVaultResult, keyId = KEY_ID, version = 1) {
  return {
    vault_key_id: keyId,
    version,
    kdf: created.kdf,
    vault_key_wrapped_by_kek: created.vault_key_wrapped_by_kek,
    x25519_public: created.x25519_public,
    ed25519_public: created.ed25519_public,
    private_keys_wrapped: created.private_keys_wrapped,
    recovery_keys_remaining: 10,
    passkeys: [],
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function problemResponse(
  code: ProblemDetails['code'],
  status: number,
  extra?: Partial<ProblemDetails>,
) {
  return new Response(
    JSON.stringify({
      type: `https://engram.zone17.click/problems/${code}`,
      title: code,
      status,
      code,
      ...extra,
    }),
    {
      status,
      headers: { 'content-type': 'application/problem+json' },
    },
  );
}

function makeEntryMeta(overrides: Partial<EntryMeta> = {}): EntryMeta {
  return {
    id: ENTRY_ID_1,
    item_id: ITEM_ID,
    type: 'text',
    position: 0,
    version: 1,
    plaintext_len_bucket: 256,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Deeply scans QueryCache and MutationCache (`getAll()` variables, context, data, error of
 * both succeeded and failed mutations) for any occurrence of the given sentinel strings.
 */
function findCacheSentinelLeaks(
  qc: QueryClient,
  sentinels: readonly string[],
): string[] {
  const leaks: string[] = [];

  for (const query of qc.getQueryCache().getAll()) {
    const serializedKey = JSON.stringify(query.queryKey);
    const serializedData = JSON.stringify(query.state.data ?? null);
    const serializedError =
      query.state.error instanceof Error
        ? `${query.state.error.message} ${JSON.stringify(query.state.error)}`
        : JSON.stringify(query.state.error ?? null);

    for (const sentinel of sentinels) {
      if (serializedKey.includes(sentinel)) {
        leaks.push(`QueryCache key ${serializedKey} contains ${sentinel}`);
      }
      if (serializedData.includes(sentinel)) {
        leaks.push(`QueryCache data for ${serializedKey} contains ${sentinel}`);
      }
      if (serializedError.includes(sentinel)) {
        leaks.push(`QueryCache error for ${serializedKey} contains ${sentinel}`);
      }
    }
  }

  for (const mutation of qc.getMutationCache().getAll()) {
    const state = mutation.state;
    const fields: ReadonlyArray<readonly [string, unknown]> = [
      ['variables', state.variables],
      ['context', state.context],
      ['data', state.data],
      [
        'error',
        state.error instanceof Error
          ? { message: state.error.message, stack: state.error.stack, raw: state.error }
          : state.error,
      ],
    ];
    for (const [fieldName, value] of fields) {
      const serialized = JSON.stringify(value ?? null);
      for (const sentinel of sentinels) {
        if (serialized.includes(sentinel)) {
          leaks.push(`MutationCache (${state.status}).${fieldName} contains ${sentinel}`);
        }
      }
    }
  }

  return leaks;
}

function bodyQueriesWithData(qc: QueryClient): unknown[] {
  return qc
    .getQueryCache()
    .findAll({ queryKey: VAULT_BODY_QUERY_KEY_PREFIX })
    .filter((query) => query.state.data !== undefined)
    .map((query) => query.queryKey);
}

describe('P04-T14 Real entry body (seal/open, loader, mutations, concurrency)', () => {
  const shims: Array<{ close: () => void }> = [];
  const queryClients: QueryClient[] = [];

  beforeEach(() => {
    document.cookie = 'sabk_csrf=test-csrf-token';
    resetVaultBroadcastForTests();
    resetEntryBodyLoadLimiterForTests();
  });

  afterEach(() => {
    cleanup();
    for (const qc of queryClients.splice(0)) {
      qc.clear();
    }
    for (const shim of shims.splice(0)) shim.close();
    resetVaultBroadcastForTests();
    resetEntryBodyLoadLimiterForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  interface TestSessionControls {
    signOut: (reason?: 'revoked' | 'expired' | 'invalid' | 'logout') => Promise<void>;
    refetchMe: () => Promise<void>;
  }

  interface ProviderHarness {
    qc: QueryClient;
    vault: () => VaultContextValue;
    session: () => TestSessionControls;
    created: CreateVaultResult;
    unlock: (keyId?: string) => Promise<void>;
    lock: () => Promise<void>;
    workerCalls: Array<{ type: string; id: number }>;
    setRouteHandler: (
      handler: (
        url: string,
        init?: RequestInit,
      ) => Promise<Response | null> | Response | null,
    ) => void;
    setCurrentMe: (me: Me | null) => void;
    setSessionEnded: (ended: boolean) => void;
    setVaultAbsent: (absent: boolean) => void;
  }

  async function mountUnlockedHarness(
    ui?: (ctx: { qc: QueryClient }) => ReactNode,
    locale: 'en' | 'vi' = 'en',
  ): Promise<ProviderHarness> {
    let vaultCtx!: VaultContextValue;
    let sessionCtx!: TestSessionControls;
    function Probe() {
      vaultCtx = useVault();
      sessionCtx = useSession();
      return <output data-testid="vault-state-probe">{vaultCtx.state}</output>;
    }

    let createdVault: CreateVaultResult | null = null;
    let activeKeyId = KEY_ID;
    let currentMe: Me | null = makeMe(USER_A_ID, 'present');
    let sessionEnded = false;
    let vaultAbsent = false;
    let customRouteHandler:
      | ((url: string, init?: RequestInit) => Promise<Response | null> | Response | null)
      | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (customRouteHandler) {
        const custom = await customRouteHandler(url, init);
        if (custom) return custom;
      }
      if (url.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (url.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (url.endsWith('/auth/me')) {
        if (sessionEnded || !currentMe) {
          return problemResponse('unauthenticated', 401);
        }
        return jsonResponse(currentMe);
      }
      if (url.endsWith('/auth/logout')) {
        sessionEnded = true;
        currentMe = null;
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/vault')) {
        if (vaultAbsent || !createdVault) {
          return problemResponse('vault_absent', 404);
        }
        return jsonResponse(makeVaultGetResponse(createdVault, activeKeyId, 1));
      }
      return jsonResponse({});
    });

    const workerCalls: Array<{ type: string; id: number }> = [];
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    queryClients.push(qc);

    render(
      <NextIntlClientProvider locale={locale} messages={locale === 'vi' ? viMessages : en}>
        <QueryClientProvider client={qc}>
          <SessionProvider>
            <VaultProvider
              createWorker={() => {
                const shim = createWorkerShim({
                  deriveKek: fastTestDeriveKek,
                });
                shims.push(shim);
                const origPostMessage = shim.port.postMessage.bind(shim.port);
                shim.port.postMessage = (message, transfer) => {
                  workerCalls.push({ type: message.type, id: message.id });
                  return origPostMessage(message, transfer);
                };
                return shim.port;
              }}
              lockEpochEnv={makeSimpleLockEpochEnv()}
            >
              <Probe />
              {ui ? ui({ qc }) : null}
            </VaultProvider>
          </SessionProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('vault-state-probe')).toHaveTextContent('locked'),
    );

    const createOp = vaultCtx.beginOp();
    await act(async () => {
      createdVault = await vaultCtx.createVault({
        passphrase: PASSPHRASE,
        opGeneration: createOp.opGeneration,
      });
    });
    await waitFor(() => expect(vaultCtx.state).toBe('unlocked'));

    await act(async () => {
      await vaultCtx.reloadVaultMeta();
    });
    await waitFor(() => expect(vaultCtx.vaultMeta?.vault_key_id).toBe(KEY_ID));

    const unlock = async (keyId = KEY_ID) => {
      activeKeyId = keyId;
      vaultAbsent = false;
      const op = vaultCtx.beginOp();
      await act(async () => {
        await vaultCtx.unlockPassphrase({
          passphrase: PASSPHRASE,
          kdf: createdVault!.kdf,
          vaultKeyWrappedByKek: createdVault!.vault_key_wrapped_by_kek,
          privateKeysWrapped: createdVault!.private_keys_wrapped,
          opGeneration: op.opGeneration,
        });
        await vaultCtx.reloadVaultMeta();
      });
      await waitFor(() => expect(vaultCtx.state).toBe('unlocked'));
    };

    const lock = async () => {
      await act(async () => {
        await vaultCtx.lockNow();
      });
      await waitFor(() => expect(vaultCtx.state).toBe('locked'));
    };

    return {
      qc,
      vault: () => vaultCtx,
      session: () => sessionCtx,
      created: createdVault!,
      unlock,
      lock,
      workerCalls,
      setRouteHandler: (fn) => {
        customRouteHandler = fn;
      },
      setCurrentMe: (nextMe) => {
        currentMe = nextMe;
        sessionEnded = nextMe === null;
      },
      setSessionEnded: (ended) => {
        sessionEnded = ended;
        if (ended) {
          currentMe = null;
        }
      },
      setVaultAbsent: (absent) => {
        vaultAbsent = absent;
      },
    };
  }

  describe('1. sealNewEntry & sealEntryUpdate: round-trip, byte limits, bucket math, no plaintext retained', () => {
    it('computes plaintext_len_bucket = ceil(bytes/256)*256 and rejects <= 0 or > 262144', () => {
      expect(computePlaintextLenBucket(1)).toBe(256);
      expect(computePlaintextLenBucket(255)).toBe(256);
      expect(computePlaintextLenBucket(256)).toBe(256);
      expect(computePlaintextLenBucket(257)).toBe(512);
      expect(computePlaintextLenBucket(512)).toBe(512);
      expect(computePlaintextLenBucket(262_143)).toBe(262_144);
      expect(computePlaintextLenBucket(262_144)).toBe(262_144);

      expect(() => computePlaintextLenBucket(0)).toThrowError(EntrySealError);
      expect(() => computePlaintextLenBucket(-5)).toThrowError(EntrySealError);
      expect(() => computePlaintextLenBucket(262_145)).toThrowError(EntrySealError);
    });

    it('rejects 0 B and 262145 B BEFORE calling the Worker, and accepts 262144 B', async () => {
      const h = await mountUnlockedHarness();
      h.workerCalls.length = 0;

      // 0 B rejected before Worker call
      await expect(
        sealNewEntry({
          text: '',
          itemId: ITEM_ID,
          vault: h.vault(),
        }),
      ).rejects.toMatchObject({
        name: 'EntrySealError',
        code: 'ENTRY_EMPTY',
        byteLength: 0,
      });
      expect(h.workerCalls.filter((c) => c.type === 'sealEntry')).toHaveLength(0);

      // 262145 B rejected before Worker call
      const overLimitText = 'a'.repeat(ENTRY_MAX_PLAINTEXT_BYTES + 1);
      await expect(
        sealNewEntry({
          text: overLimitText,
          itemId: ITEM_ID,
          vault: h.vault(),
        }),
      ).rejects.toMatchObject({
        name: 'EntrySealError',
        code: 'ENTRY_TOO_LARGE',
        byteLength: 262_145,
      });
      expect(h.workerCalls.filter((c) => c.type === 'sealEntry')).toHaveLength(0);

      // Same pre-seal rejection on sealEntryUpdate
      await expect(
        sealEntryUpdate({
          entryId: ENTRY_ID_1,
          text: overLimitText,
          vault: h.vault(),
        }),
      ).rejects.toMatchObject({
        name: 'EntrySealError',
        code: 'ENTRY_TOO_LARGE',
        byteLength: 262_145,
      });
      expect(h.workerCalls.filter((c) => c.type === 'sealEntry')).toHaveLength(0);

      // 262144 B succeeds and calls Worker exactly once
      const exactMaxText = 'b'.repeat(ENTRY_MAX_PLAINTEXT_BYTES);
      const sealedMax = await sealNewEntry({
        text: exactMaxText,
        itemId: ITEM_ID,
        vault: h.vault(),
      });
      expect(h.workerCalls.filter((c) => c.type === 'sealEntry')).toHaveLength(1);
      expect(sealedMax.plaintextLenBucket).toBe(262_144);
      expect(sealedMax.requestBody.plaintext_len_bucket).toBe(262_144);

      const openedMax = await h.vault().getClient().openEntry({
        entryId: sealedMax.entryId,
        envelope: sealedMax.envelope,
        ciphertext: sealedMax.ciphertext,
        opGeneration: h.vault().captureOpGeneration(),
      });
      expect(openedMax.plaintext.length).toBe(ENTRY_MAX_PLAINTEXT_BYTES);
      expect(openedMax.plaintext).toBe(exactMaxText);
    }, 30_000);

    it('round-trips exact text (emoji, Vietnamese diacritics, CRLF) and never retains plaintext on the returned object', async () => {
      const h = await mountUnlockedHarness();
      const complexSentinel =
        'SENTINEL-VN-EMOJI-CRLF: Cà phê sữa đá 🇻🇳 🔐\r\nDòng 2: mật khẩu router 100%\r\nDòng 3: giữ nguyên CRLF\r\n';

      const created = await sealNewEntry({
        text: complexSentinel,
        itemId: ITEM_ID,
        vault: h.vault(),
      });

      // Verify returned object does not contain the plaintext anywhere
      const serializedCreated = JSON.stringify(created);
      expect(serializedCreated).not.toContain('SENTINEL-VN-EMOJI-CRLF');
      expect(serializedCreated).not.toContain('Cà phê sữa đá');
      expect('text' in created).toBe(false);
      expect('plaintext' in created).toBe(false);
      expect(created.serializedBody).toBe(JSON.stringify(created.requestBody));

      // Round-trip open via realEntryBodyLoader
      const loader = createRealEntryBodyLoader({
        fetchEntry: async (id) => ({
          ...makeEntryMeta({
            id,
            item_id: ITEM_ID,
            version: 1,
            plaintext_len_bucket: created.plaintextLenBucket,
          }),
          envelope: created.envelope,
          ciphertext: created.ciphertext,
        }),
      });

      const op = h.vault().beginOp();
      const decrypted = await loader(created.entryId, {
        client: op.client,
        opGeneration: op.opGeneration,
        vaultKeyId: h.vault().vaultMeta?.vault_key_id,
        isCurrent: op.isCurrent,
      });
      expect(decrypted).toBe(complexSentinel);

      // Update with same entryId -> fresh nonce, round-trips updated text
      const updatedSentinel = 'SENTINEL-UPDATED-CRLF: Bản cập nhật lần 2 🚀\r\nGiữ nguyên dòng 2';
      const updated = await sealEntryUpdate({
        entryId: created.entryId,
        text: updatedSentinel,
        vault: h.vault(),
        itemId: ITEM_ID,
        version: 1,
      });

      expect(updated.entryId).toBe(created.entryId);
      expect(updated.envelope.nonce).not.toBe(created.envelope.nonce);
      expect(JSON.stringify(updated)).not.toContain('SENTINEL-UPDATED-CRLF');

      const imported = await sealEntryImportJson({
        text: '{"sentinel":"SENTINEL-IMPORT-JSON-1"}',
        itemId: ITEM_ID,
        source: 'file',
        vault: h.vault(),
      });
      expect(imported.requestBody.type).toBe('json');
      expect(imported.requestBody.source).toBe('file');
      expect(JSON.stringify(imported)).not.toContain('SENTINEL-IMPORT-JSON-1');
    }, 30_000);

    it('maps Worker sealEntry errors (STALE_GENERATION, VAULT_LOCKED, ENVELOPE_INVALID, SEAL_FAILED) to EntrySealError and enforces the serializedBody byte-identity guard (IP14-FE1-13, IP14-FE2-2, IP14-BE2-1)', async () => {
      const h = await mountUnlockedHarness();
      const staleOp = h.vault().beginOp();
      await h.lock();

      // 1) A pre-lock captured op whose generation was bumped by lock() throws CryptoClientError('STALE_GENERATION')
      // in client.sealEntry (assertGenerationOrWipe), which maps to EntrySealError('STALE_GENERATION') (IP14-FE2-2 / IP14-BE2-1).
      await expect(
        sealNewEntry({
          text: 'SENTINEL-STALE-SEAL-ATTEMPT',
          itemId: ITEM_ID,
          vault: {
            vaultMeta: { vault_key_id: KEY_ID },
            beginOp: () => staleOp,
          },
        }),
      ).rejects.toMatchObject({
        name: 'EntrySealError',
        code: 'STALE_GENERATION',
      });

      // 2) A current-generation locked/recovering client call maps to EntrySealError('VAULT_LOCKED').
      const makeStubVault = (errToThrow: unknown) => ({
        vaultMeta: { vault_key_id: KEY_ID },
        beginOp: () => ({
          opGeneration: 7,
          isCurrent: () => true,
          client: {
            getState: () => 'unlocked',
            getGeneration: () => 7,
            sealEntry: async () => {
              throw errToThrow;
            },
          } as unknown as CryptoClient,
        }),
      });

      await expect(
        sealNewEntry({
          text: 'SENTINEL-LOCKED-CLIENT-ATTEMPT',
          itemId: ITEM_ID,
          vault: makeStubVault(new CryptoClientError('VAULT_LOCKED', 'Vault is locked')),
        }),
      ).rejects.toMatchObject({
        name: 'EntrySealError',
        code: 'VAULT_LOCKED',
      });

      await expect(
        sealNewEntry({
          text: 'SENTINEL-RECOVERING-CLIENT-ATTEMPT',
          itemId: ITEM_ID,
          vault: makeStubVault(new CryptoClientError('VAULT_RECOVERING', 'Vault is recovering')),
        }),
      ).rejects.toMatchObject({
        name: 'EntrySealError',
        code: 'VAULT_LOCKED',
      });

      // 3) ENVELOPE_INVALID maps to EntrySealError('ENTRY_ID_INVALID').
      await expect(
        sealNewEntry({
          text: 'SENTINEL-ENVELOPE-INVALID-ATTEMPT',
          itemId: ITEM_ID,
          vault: makeStubVault(new CryptoWorkerError('ENVELOPE_INVALID', 'Invalid envelope')),
        }),
      ).rejects.toMatchObject({
        name: 'EntrySealError',
        code: 'ENTRY_ID_INVALID',
      });

      // 4) Other crypto / unexpected errors map to EntrySealError('SEAL_FAILED').
      await expect(
        sealNewEntry({
          text: 'SENTINEL-SEAL-FAILED-ATTEMPT',
          itemId: ITEM_ID,
          vault: makeStubVault(new CryptoWorkerError('WORKER_INTERNAL_ERROR', 'Worker failure')),
        }),
      ).rejects.toMatchObject({
        name: 'EntrySealError',
        code: 'SEAL_FAILED',
      });

      // 5) serializedBody mismatch guard in executeWithOpLifetimeSignal & contentMutate rejects before issuing any network request,
      //    and valid sealed mutations forward serializedBody to the transport so fetch init.body === sealed.serializedBody
      //    on first send AND on replay (IP14-FE2-2, FU9, F-2, advisor-dec-212).
      await h.unlock();
      let contentRequests = 0;
      const seenRequestBodies: string[] = [];
      h.setRouteHandler((url, init) => {
        if (url.endsWith(`/items/${ITEM_ID}/entries`) && init?.method === 'POST') {
          contentRequests += 1;
          seenRequestBodies.push(String(init.body ?? ''));
          if (contentRequests === 1) {
            return problemResponse('dependency_unavailable', 503, { retry_after: 0 });
          }
          return jsonResponse(makeEntryMeta({ id: ENTRY_ID_2, version: 1 }), 201);
        }
        if (url.endsWith(`/entries/${ENTRY_ID_2}`) && init?.method === 'PUT') {
          contentRequests += 1;
          seenRequestBodies.push(String(init.body ?? ''));
          return jsonResponse(makeEntryMeta({ id: ENTRY_ID_2, version: 2 }), 200);
        }
        if (url.endsWith(`/items/${ITEM_ID}/entries/import-json`) && init?.method === 'POST') {
          contentRequests += 1;
          seenRequestBodies.push(String(init.body ?? ''));
          return jsonResponse(makeEntryMeta({ id: ENTRY_ID_2, type: 'json', version: 1 }), 201);
        }
        return null;
      });

      const validSealed = await sealNewEntry({
        text: 'SENTINEL-SERIALIZED-GUARD',
        itemId: ITEM_ID,
        entryId: ENTRY_ID_2,
        vault: h.vault(),
      });
      const tamperedVars: SealedEntryCreateVariables = {
        ...toEntryCreateVariables(validSealed),
        serializedBody: `${validSealed.serializedBody} `,
      };
      await expect(mutateSealedEntryCreate(h.qc, tamperedVars)).rejects.toThrow(
        /Sealed requestBody was mutated after initial serialization/,
      );
      expect(contentRequests).toBe(0);

      // Mutating a crafted requestBody object between seal and send while keeping validSealed.serializedBody
      // is rejected before any fetch call.
      const reSealedForTamper = await sealNewEntry({
        text: 'SENTINEL-SERIALIZED-GUARD-2',
        itemId: ITEM_ID,
        entryId: ENTRY_ID_2,
        vault: h.vault(),
      });
      const mutatedBodyVars: SealedEntryCreateVariables = {
        ...toEntryCreateVariables(reSealedForTamper),
        requestBody: {
          ...reSealedForTamper.requestBody,
          ciphertext: 'MUTATED_AFTER_SEAL',
        },
      };
      await expect(mutateSealedEntryCreate(h.qc, mutatedBodyVars)).rejects.toThrow(
        /Sealed requestBody was mutated after initial serialization/,
      );
      expect(contentRequests).toBe(0);

      // Valid sealed payloads forward serializedBody into entryCreate / entryUpdate / entryImportJson -> contentMutate,
      // sending exact sealed bytes on first send and 503 replay
      const reSealedValid = await sealNewEntry({
        text: 'SENTINEL-SERIALIZED-FORWARD',
        itemId: ITEM_ID,
        entryId: ENTRY_ID_2,
        vault: h.vault(),
      });
      const sealedUpdateValid = await sealEntryUpdate({
        entryId: ENTRY_ID_2,
        text: 'SENTINEL-SERIALIZED-UPDATE-FORWARD',
        itemId: ITEM_ID,
        version: 1,
        vault: h.vault(),
      });
      const sealedImportValid = await sealEntryImportJson({
        text: '{"k":"v"}',
        itemId: ITEM_ID,
        entryId: ENTRY_ID_2,
        source: 'paste',
        vault: h.vault(),
      });
      const entryCreateSpy = vi.spyOn(contentApi, 'entryCreate');
      const entryUpdateSpy = vi.spyOn(contentApi, 'entryUpdate');
      const entryImportSpy = vi.spyOn(contentApi, 'entryImportJson');
      try {
        await mutateSealedEntryCreate(h.qc, toEntryCreateVariables(reSealedValid));
        expect(entryCreateSpy).toHaveBeenCalledWith(
          ITEM_ID,
          reSealedValid.requestBody,
          expect.objectContaining({
            idempotencyKey: reSealedValid.idempotencyKey,
            serializedBody: reSealedValid.serializedBody,
          }),
        );

        await mutateSealedEntryUpdate(h.qc, toEntryUpdateVariables(sealedUpdateValid, 1));
        expect(entryUpdateSpy).toHaveBeenCalledWith(
          ENTRY_ID_2,
          sealedUpdateValid.requestBody,
          expect.objectContaining({
            idempotencyKey: sealedUpdateValid.idempotencyKey,
            ifMatch: 1,
            serializedBody: sealedUpdateValid.serializedBody,
          }),
        );

        await mutateSealedEntryImportJson(h.qc, toEntryImportJsonVariables(sealedImportValid));
        expect(entryImportSpy).toHaveBeenCalledWith(
          ITEM_ID,
          sealedImportValid.requestBody,
          expect.objectContaining({
            idempotencyKey: sealedImportValid.idempotencyKey,
            serializedBody: sealedImportValid.serializedBody,
          }),
        );
      } finally {
        entryCreateSpy.mockRestore();
        entryUpdateSpy.mockRestore();
        entryImportSpy.mockRestore();
      }
      expect(contentRequests).toBe(4);
      expect(seenRequestBodies).toEqual([
        reSealedValid.serializedBody,
        reSealedValid.serializedBody,
        sealedUpdateValid.serializedBody,
        sealedImportValid.serializedBody,
      ]);
    }, 30_000);

    it('unsubscribes the seal-time reset listener once a sealed mutation settles (IP14-FE2-5)', async () => {
      const h = await mountUnlockedHarness();
      const activeResetters = new Set<() => void>();
      const origRegister = h.vault().registerSecretFormReset.bind(h.vault());

      const trackingVault = {
        ...h.vault(),
        registerSecretFormReset: (fn: () => void) => {
          activeResetters.add(fn);
          const unsubOrig = origRegister(fn);
          return () => {
            activeResetters.delete(fn);
            unsubOrig();
          };
        },
      };

      h.setRouteHandler((url, init) => {
        if (url.endsWith(`/items/${ITEM_ID}/entries`) && init?.method === 'POST') {
          return jsonResponse(makeEntryMeta({ id: ENTRY_ID_2, version: 1 }), 201);
        }
        return null;
      });

      for (let i = 0; i < 5; i += 1) {
        const sealed = await sealNewEntry({
          text: `SENTINEL-FE2-5-RESET-CLEANUP-${i}`,
          itemId: ITEM_ID,
          entryId: ENTRY_ID_2,
          vault: trackingVault,
        });
        expect(activeResetters.size).toBe(1);
        await mutateSealedEntryCreate(h.qc, toEntryCreateVariables(sealed));
        expect(activeResetters.size).toBe(0);
      }
    }, 30_000);

    it.each([
      ['sealNewEntry', 'lock'],
      ['sealNewEntry', 'lock_and_unlock'],
      ['sealEntryUpdate', 'lock'],
      ['sealEntryUpdate', 'lock_and_unlock'],
      ['sealEntryImportJson', 'lock'],
      ['sealEntryImportJson', 'lock_and_unlock'],
    ] as const)(
      'IP15-BE4-3 / FE4-2: %s with held reloadVaultMeta during %s rejects STALE_GENERATION before getText or Worker sealEntry and disposes reset listener',
      async (helperName, transition) => {
        const h = await mountUnlockedHarness();
        const { promise: reloadEntered, resolve: notifyReloadEntered } =
          Promise.withResolvers<void>();
        const { promise: reloadGate, resolve: releaseReload } = Promise.withResolvers<void>();

        let beginOpCount = 0;
        let getTextCalls = 0;
        const activeResetters = new Set<() => void>();
        const holder = { value: `SENTINEL-RELOAD-RACE-${helperName}-${transition}` };

        const invokeHelper = (vaultCtx: Parameters<typeof sealNewEntry>[0]['vault']) => {
          if (helperName === 'sealNewEntry') {
            return sealNewEntry({
              itemId: ITEM_ID,
              entryId: ENTRY_ID_2,
              getText: () => {
                getTextCalls += 1;
                return holder.value;
              },
              vault: vaultCtx,
            });
          }
          if (helperName === 'sealEntryUpdate') {
            return sealEntryUpdate({
              entryId: ENTRY_ID_1,
              itemId: ITEM_ID,
              version: 1,
              getText: () => {
                getTextCalls += 1;
                return holder.value;
              },
              vault: vaultCtx,
            });
          }
          return sealEntryImportJson({
            itemId: ITEM_ID,
            entryId: ENTRY_ID_2,
            source: 'paste',
            getText: () => {
              getTextCalls += 1;
              return holder.value;
            },
            vault: vaultCtx,
          });
        };

        const initialVault = h.vault();
        const origRegister = initialVault.registerSecretFormReset.bind(initialVault);
        const unsubHolderWipe = origRegister(() => {
          holder.value = '';
        });

        const nullMetaVault: Parameters<typeof sealNewEntry>[0]['vault'] = {
          get state() {
            return h.vault().state;
          },
          vaultMeta: null,
          beginOp: () => {
            beginOpCount += 1;
            return h.vault().beginOp();
          },
          registerSecretFormReset: (fn: () => void) => {
            activeResetters.add(fn);
            const unsub = h.vault().registerSecretFormReset(fn);
            return () => {
              activeResetters.delete(fn);
              unsub();
            };
          },
          reloadVaultMeta: async () => {
            notifyReloadEntered();
            await reloadGate;
            return { vault_key_id: KEY_ID };
          },
        };

        const workerSealsBefore = h.workerCalls.filter((c) => c.type === 'sealEntry').length;
        const sealPromise = invokeHelper(nullMetaVault);
        // Prevent unhandled rejection before the assertion awaits sealPromise
        void sealPromise.catch(() => undefined);

        await reloadEntered;
        // Prove initial opGeneration and reset listener were captured synchronously BEFORE awaiting reloadVaultMeta
        expect(beginOpCount).toBe(1);
        expect(activeResetters.size).toBe(1);
        expect(getTextCalls).toBe(0);

        await h.lock();
        expect(holder.value).toBe('');
        if (transition === 'lock_and_unlock') {
          await h.unlock();
        }

        releaseReload();

        await expect(sealPromise).rejects.toMatchObject({
          name: 'EntrySealError',
          code: 'STALE_GENERATION',
        });
        expect(getTextCalls).toBe(0);
        expect(h.workerCalls.filter((c) => c.type === 'sealEntry').length).toBe(workerSealsBefore);
        expect(activeResetters.size).toBe(0);
        unsubHolderWipe();
      },
      30_000,
    );

    it.each(['sealNewEntry', 'sealEntryUpdate', 'sealEntryImportJson'] as const)(
      'IP15-FE4-2: %s rejects VAULT_KEY_MISSING with zero getText and zero Worker sealEntry when reloadVaultMeta resolves null or an invalid key id',
      async (helperName) => {
        const h = await mountUnlockedHarness();
        let getTextCalls = 0;
        const workerSealsBefore = h.workerCalls.filter((c) => c.type === 'sealEntry').length;

        const invokeWithReloadResult = (
          reloadedMeta: { readonly vault_key_id: string } | null,
        ) => {
          const stubVault: Parameters<typeof sealNewEntry>[0]['vault'] = {
            state: 'unlocked',
            vaultMeta: null,
            beginOp: () => h.vault().beginOp(),
            registerSecretFormReset: (fn) => h.vault().registerSecretFormReset(fn),
            reloadVaultMeta: async () => reloadedMeta,
          };
          if (helperName === 'sealNewEntry') {
            return sealNewEntry({
              itemId: ITEM_ID,
              entryId: ENTRY_ID_2,
              getText: () => {
                getTextCalls += 1;
                return 'SENTINEL-SHOULD-NOT-BE-READ';
              },
              vault: stubVault,
            });
          }
          if (helperName === 'sealEntryUpdate') {
            return sealEntryUpdate({
              entryId: ENTRY_ID_1,
              itemId: ITEM_ID,
              version: 1,
              getText: () => {
                getTextCalls += 1;
                return 'SENTINEL-SHOULD-NOT-BE-READ';
              },
              vault: stubVault,
            });
          }
          return sealEntryImportJson({
            itemId: ITEM_ID,
            entryId: ENTRY_ID_2,
            source: 'file',
            getText: () => {
              getTextCalls += 1;
              return '{"sentinel":"SHOULD-NOT-BE-READ"}';
            },
            vault: stubVault,
          });
        };

        await expect(invokeWithReloadResult(null)).rejects.toMatchObject({
          name: 'EntrySealError',
          code: 'VAULT_KEY_MISSING',
        });
        await expect(
          invokeWithReloadResult({ vault_key_id: 'invalid-key-id-format' }),
        ).rejects.toMatchObject({
          name: 'EntrySealError',
          code: 'VAULT_KEY_MISSING',
        });
        expect(getTextCalls).toBe(0);
        expect(h.workerCalls.filter((c) => c.type === 'sealEntry').length).toBe(workerSealsBefore);
      },
      30_000,
    );

  });

  describe('2. key_id mismatch vs AEAD decrypt failure + Retry + identity auth + version reconciliation', () => {
    it('key_id mismatch renders old-key state and NEVER calls Worker openEntry; malformed envelope maps to decrypt_failed (IP14-FE1-9, IP14-FE1-10)', async () => {
      let mode: 'old_key' | 'malformed' = 'old_key';
      let sealedPayload: SealedNewEntryPayload | null = null;
      const loader = createRealEntryBodyLoader();

      const h = await mountUnlockedHarness(
        () => (
          <EntryBody
            entryId={ENTRY_ID_1}
            version={1}
            itemId={ITEM_ID}
            load={loader}
            lazy={false}
          />
        ),
        'vi',
      );

      const sealed = await sealNewEntry({
        text: 'SENTINEL-OLD-KEY-BODY',
        itemId: ITEM_ID,
        entryId: ENTRY_ID_1,
        vault: h.vault(),
      });
      sealedPayload = sealed;

      h.setRouteHandler((url) => {
        if (url.endsWith(`/entries/${ENTRY_ID_1}`) && sealedPayload) {
          if (mode === 'malformed') {
            return jsonResponse({
              ...makeEntryMeta({ id: ENTRY_ID_1, version: 1 }),
              envelope: {
                ...sealedPayload.envelope,
                key_id: 'not-a-valid-key-id',
              },
              ciphertext: sealedPayload.ciphertext,
            });
          }
          const entryResp: Entry = {
            ...makeEntryMeta({ id: ENTRY_ID_1, version: 1 }),
            envelope: {
              ...sealedPayload.envelope,
              key_id: OLD_KEY_ID,
            },
            ciphertext: sealedPayload.ciphertext,
          };
          return jsonResponse(entryResp);
        }
        return null;
      });

      h.workerCalls.length = 0;
      await act(async () => {
        await h.qc.resetQueries({ queryKey: vaultBodyQueryKey(ENTRY_ID_1, 1) });
      });

      await waitFor(() =>
        expect(screen.getByTestId('entry-body-old-key')).toBeInTheDocument(),
      );
      expect(screen.getByTestId('entry-body-old-key')).toHaveTextContent(
        /Entry này mã hoá bằng khoá cũ/i,
      );
      expect(screen.getByTestId('entry-body-old-key')).not.toHaveTextContent(
        'entry_key_mismatch',
      );

      // Direct loader assertion as well:
      await expect(
        loader(ENTRY_ID_1, {
          client: h.vault().getClient(),
          opGeneration: h.vault().captureOpGeneration(),
          vaultKeyId: h.vault().vaultMeta?.vault_key_id,
        }),
      ).rejects.toMatchObject({
        name: 'EntryBodyOpenError',
        kind: 'old_key',
        envelopeKeyId: OLD_KEY_ID,
        expectedKeyId: KEY_ID,
      });

      // Worker openEntry was NEVER called!
      expect(h.workerCalls.filter((c) => c.type === 'openEntry')).toHaveLength(0);

      // IP14-FE1-10: Missing/malformed envelope.key_id throws decrypt_failed (retryable), not old_key
      mode = 'malformed';
      await expect(
        loader(ENTRY_ID_1, {
          client: h.vault().getClient(),
          opGeneration: h.vault().captureOpGeneration(),
          vaultKeyId: h.vault().vaultMeta?.vault_key_id,
        }),
      ).rejects.toMatchObject({
        name: 'EntryBodyOpenError',
        kind: 'decrypt_failed',
      });
    }, 30_000);

    it('rejects entry.id !== requestedEntryId when entry B is served for entry A (IP14-BE1-1)', async () => {
      let sealedEntryB: SealedNewEntryPayload | null = null;
      const loader = createRealEntryBodyLoader();

      const h = await mountUnlockedHarness(() => (
        <EntryBody
          entryId={ENTRY_ID_1}
          version={1}
          itemId={ITEM_ID}
          load={loader}
          lazy={false}
        />
      ));

      // Seal entry B with a valid current vault key
      sealedEntryB = await sealNewEntry({
        text: 'SENTINEL-FOREIGN-ENTRY-B-PAYLOAD-404',
        itemId: ITEM_ID,
        entryId: ENTRY_ID_2,
        vault: h.vault(),
      });

      // Compromised server returns entry B when entry A (ENTRY_ID_1) is requested
      h.setRouteHandler((url) => {
        if (url.endsWith(`/entries/${ENTRY_ID_1}`) && sealedEntryB) {
          return jsonResponse({
            ...makeEntryMeta({ id: ENTRY_ID_2, item_id: ITEM_ID, version: 1 }),
            envelope: sealedEntryB.envelope,
            ciphertext: sealedEntryB.ciphertext,
          } satisfies Entry);
        }
        return null;
      });

      await act(async () => {
        await h.qc.resetQueries({ queryKey: vaultBodyQueryKey(ENTRY_ID_1, 1) });
      });

      await waitFor(() =>
        expect(screen.getByTestId('entry-body-error')).toBeInTheDocument(),
      );
      expect(screen.queryByTestId('entry-body')).toBeNull();
      expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBeUndefined();
      expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_2, 1))).toBeUndefined();
      expect(bodyQueriesWithData(h.qc)).toEqual([]);
      expect(
        findCacheSentinelLeaks(h.qc, ['SENTINEL-FOREIGN-ENTRY-B-PAYLOAD-404']),
      ).toEqual([]);
      expect(document.body.textContent).not.toContain(
        'SENTINEL-FOREIGN-ENTRY-B-PAYLOAD-404',
      );
    }, 30_000);

    it('renders old-key card, branches error copy (decrypt vs network vs not_found), restores focus on Retry, and does not steal focus when the user moves away (IP14-FE1-5, IP14-FE2-3, IP14-BE2-3)', async () => {
      let currentMode: 'old_key' | 'corrupt_aead' | 'network_err' | 'not_found_err' | 'valid' =
        'old_key';
      let validSealedPayload: SealedNewEntryPayload | null = null;
      let oldKeyFetches = 0;
      let holdRetryGate: Promise<void> | null = null;
      let notifyRetryEntered: (() => void) | null = null;
      const loader = createRealEntryBodyLoader();

      const h = await mountUnlockedHarness(
        () => (
          <div>
            <EntryBody
              entryId={ENTRY_ID_1}
              version={1}
              itemId={ITEM_ID}
              load={loader}
              lazy={false}
            />
            <button type="button" data-testid="other-focus-target">
              Other control
            </button>
            <div data-testid="non-focusable-chrome">Blank page chrome</div>
          </div>
        ),
        'vi',
      );

      const validSealed = await sealNewEntry({
        text: 'SENTINEL-RECOVERED-AFTER-RETRY-77',
        itemId: ITEM_ID,
        entryId: ENTRY_ID_1,
        vault: h.vault(),
      });
      validSealedPayload = validSealed;

      h.setRouteHandler(async (url) => {
        if (url.endsWith(`/entries/${ENTRY_ID_1}`) && validSealedPayload) {
          notifyRetryEntered?.();
          if (holdRetryGate) {
            await holdRetryGate;
          }
          if (currentMode === 'old_key') {
            oldKeyFetches += 1;
            return jsonResponse({
              ...makeEntryMeta({ id: ENTRY_ID_1, version: 1 }),
              envelope: { ...validSealedPayload.envelope, key_id: OLD_KEY_ID },
              ciphertext: validSealedPayload.ciphertext,
            } satisfies Entry);
          }
          if (currentMode === 'network_err') {
            throw new TypeError('Failed to fetch');
          }
          if (currentMode === 'not_found_err') {
            return problemResponse('not_found', 404);
          }
          if (currentMode === 'corrupt_aead') {
            // Tamper with ciphertext so AEAD tag verification fails in Worker
            const badCiphertext =
              validSealedPayload.ciphertext.slice(0, -4) +
              (validSealedPayload.ciphertext.endsWith('AAAA') ? 'BBBB' : 'AAAA');
            return jsonResponse({
              ...makeEntryMeta({ id: ENTRY_ID_1, version: 1 }),
              envelope: validSealedPayload.envelope,
              ciphertext: badCiphertext,
            } satisfies Entry);
          }
          return jsonResponse({
            ...makeEntryMeta({ id: ENTRY_ID_1, version: 1 }),
            envelope: validSealedPayload.envelope,
            ciphertext: validSealedPayload.ciphertext,
          } satisfies Entry);
        }
        return null;
      });

      // 1. Trigger refetch in old_key mode
      h.workerCalls.length = 0;
      await act(async () => {
        await h.qc.resetQueries({ queryKey: vaultBodyQueryKey(ENTRY_ID_1, 1) });
      });

      await waitFor(() => expect(oldKeyFetches).toBeGreaterThan(0));
      await waitFor(() =>
        expect(screen.getByTestId('entry-body-old-key')).toBeInTheDocument(),
      );
      expect(screen.getByTestId('entry-body-old-key')).toHaveTextContent(
        /Entry này mã hoá bằng khoá cũ/i,
      );
      expect(h.workerCalls.filter((c) => c.type === 'openEntry')).toHaveLength(0);
      assertNoPlaintextAttrs(document.body, ['SENTINEL-RECOVERED-AFTER-RETRY-77']);

      // 2. Switch to network_err mode -> network copy
      currentMode = 'network_err';
      await act(async () => {
        await h.qc.resetQueries({ queryKey: vaultBodyQueryKey(ENTRY_ID_1, 1) });
      });
      await waitFor(() =>
        expect(screen.getByTestId('entry-body-error')).toHaveTextContent(
          /Không tải được entry này/i,
        ),
      );

      // 3. Switch to not_found_err mode -> not_found copy
      currentMode = 'not_found_err';
      await act(async () => {
        await h.qc.resetQueries({ queryKey: vaultBodyQueryKey(ENTRY_ID_1, 1) });
      });
      await waitFor(() =>
        expect(screen.getByTestId('entry-body-error')).toHaveTextContent(
          /Entry không còn khả dụng/i,
        ),
      );

      // 4. Switch to corrupt_aead mode -> decrypt-failed card with Retry button and aria-describedby
      currentMode = 'corrupt_aead';
      await act(async () => {
        await h.qc.resetQueries({ queryKey: vaultBodyQueryKey(ENTRY_ID_1, 1) });
      });

      await waitFor(() =>
        expect(screen.getByTestId('entry-body-error')).toHaveTextContent(
          /Không giải mã được/i,
        ),
      );
      const errorContainer = screen.getByTestId('entry-body-error');
      const retryBtn = screen.getByTestId('entry-body-retry');
      expect(retryBtn).toHaveTextContent('Thử lại');
      const describedById = retryBtn.getAttribute('aria-describedby');
      expect(describedById).toBeTruthy();
      expect(document.getElementById(describedById!)?.textContent).toMatch(
        /Không giải mã được entry này/i,
      );
      assertNoPlaintextAttrs(document.body, ['SENTINEL-RECOVERED-AFTER-RETRY-77']);

      // 5. Hold a failing retry: verify container identity is preserved, aria-busy="true", button disabled,
      // and focus returns to the Retry button when the retry fails again (IP14-FE1-5, IP14-FE2-3).
      const failGate = Promise.withResolvers<void>();
      const failEntered = Promise.withResolvers<void>();
      holdRetryGate = failGate.promise;
      notifyRetryEntered = failEntered.resolve;

      retryBtn.focus();
      expect(document.activeElement).toBe(retryBtn);
      await act(async () => {
        fireEvent.click(retryBtn);
        await failEntered.promise;
      });
      expect(screen.getByTestId('entry-body-error')).toBe(errorContainer);
      expect(errorContainer).toHaveAttribute('aria-busy', 'true');
      expect(retryBtn).toBeDisabled();
      expect(document.activeElement).toBe(errorContainer);

      await act(async () => {
        failGate.resolve();
      });
      holdRetryGate = null;
      notifyRetryEntered = null;

      await waitFor(() => expect(retryBtn).not.toBeDisabled());
      expect(errorContainer).not.toHaveAttribute('aria-busy');
      await waitFor(() => expect(document.activeElement).toBe(retryBtn));

      // 6. Hold another failing retry, move user focus to another control before it settles -> focus is NOT stolen (IP14-BE2-3).
      const movedFailGate = Promise.withResolvers<void>();
      const movedFailEntered = Promise.withResolvers<void>();
      holdRetryGate = movedFailGate.promise;
      notifyRetryEntered = movedFailEntered.resolve;

      const otherControl = screen.getByTestId('other-focus-target');
      retryBtn.focus();
      await act(async () => {
        fireEvent.click(retryBtn);
        await movedFailEntered.promise;
      });
      act(() => {
        otherControl.focus();
      });
      expect(document.activeElement).toBe(otherControl);

      await act(async () => {
        movedFailGate.resolve();
      });
      holdRetryGate = null;
      notifyRetryEntered = null;
      await waitFor(() => expect(retryBtn).not.toBeDisabled());
      expect(document.activeElement).toBe(otherControl);

      // 6b. Hold another failing retry, click non-focusable page chrome (focus moves to document.body / activeElement outside card) ->
      // focus is NOT stolen when the retry settles (IP14-FE3-2).
      const nonFocusFailGate = Promise.withResolvers<void>();
      const nonFocusFailEntered = Promise.withResolvers<void>();
      holdRetryGate = nonFocusFailGate.promise;
      notifyRetryEntered = nonFocusFailEntered.resolve;

      const blankChrome = screen.getByTestId('non-focusable-chrome');
      retryBtn.focus();
      await act(async () => {
        fireEvent.click(retryBtn);
        await nonFocusFailEntered.promise;
      });
      expect(document.activeElement).toBe(errorContainer);
      act(() => {
        fireEvent.pointerDown(blankChrome);
        fireEvent.mouseDown(blankChrome);
        errorContainer.blur();
        fireEvent.mouseUp(blankChrome);
        fireEvent.click(blankChrome);
      });
      expect(document.activeElement).toBe(document.body);

      await act(async () => {
        nonFocusFailGate.resolve();
      });
      holdRetryGate = null;
      notifyRetryEntered = null;
      await waitFor(() => expect(retryBtn).not.toBeDisabled());
      expect(document.activeElement).toBe(document.body);

      // 7. Hold a succeeding retry, move user focus to another control before it settles -> focus is NOT stolen (IP14-BE2-3).
      currentMode = 'valid';
      const movedSuccessGate = Promise.withResolvers<void>();
      const movedSuccessEntered = Promise.withResolvers<void>();
      holdRetryGate = movedSuccessGate.promise;
      notifyRetryEntered = movedSuccessEntered.resolve;

      retryBtn.focus();
      await act(async () => {
        fireEvent.click(retryBtn);
        await movedSuccessEntered.promise;
      });
      act(() => {
        otherControl.focus();
      });
      expect(document.activeElement).toBe(otherControl);

      await act(async () => {
        movedSuccessGate.resolve();
      });
      holdRetryGate = null;
      notifyRetryEntered = null;

      await waitFor(() =>
        expect(screen.getByTestId('entry-body')).toHaveTextContent(
          'SENTINEL-RECOVERED-AFTER-RETRY-77',
        ),
      );
      expect(document.activeElement).toBe(otherControl);

      // 8. Reset back to corrupt_aead, then click Retry with a valid response without moving focus away ->
      // newly mounted entry-body receives focus (IP14-FE2-3)!
      currentMode = 'corrupt_aead';
      await act(async () => {
        await h.qc.resetQueries({ queryKey: vaultBodyQueryKey(ENTRY_ID_1, 1) });
      });
      await waitFor(() =>
        expect(screen.getByTestId('entry-body-retry')).toBeInTheDocument(),
      );

      currentMode = 'valid';
      const retryBtnFinal = screen.getByTestId('entry-body-retry');
      retryBtnFinal.focus();
      await act(async () => {
        fireEvent.click(retryBtnFinal);
      });

      await waitFor(() =>
        expect(screen.getByTestId('entry-body')).toHaveTextContent(
          'SENTINEL-RECOVERED-AFTER-RETRY-77',
        ),
      );
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByTestId('entry-body')),
      );
      expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBe(
        'SENTINEL-RECOVERED-AFTER-RETRY-77',
      );
      assertNoPlaintextAttrs(document.body, ['SENTINEL-RECOVERED-AFTER-RETRY-77']);
    }, 30_000);
    it('when GET /entries/{id} returns a newer version than list metadata, hands off to v3 across all co-mounted observers, leaves v1 empty/removed, and remounting with stale v1 metadata does not reuse a cached v1 body (IP14-BE1-2, IP14-FE1-11, IP14-BE2-2)', async () => {
      const loader = createRealEntryBodyLoader();
      let serverSealedPayload: SealedNewEntryPayload | null = null;
      let getEntryCallCount = 0;
      let holdFirstGet: Promise<void> | null = null;
      let notifyFirstGetEntered: (() => void) | null = null;
      let setShowThirdConsumer!: (show: boolean) => void;

      function VersionHandoffHarness() {
        const [showThird, setShowThird] = useState(false);
        setShowThirdConsumer = setShowThird;
        return (
          <div>
            <div data-testid="primary-card">
              <EntryBody
                entryId={ENTRY_ID_1}
                version={1}
                itemId={ITEM_ID}
                load={loader}
                lazy={false}
              />
            </div>
            <div data-testid="co-mounted-card">
              <EntryBody
                entryId={ENTRY_ID_1}
                version={1}
                itemId={ITEM_ID}
                load={loader}
                lazy={false}
              />
            </div>
            {showThird ? (
              <div data-testid="remounted-stale-card">
                <EntryBody
                  entryId={ENTRY_ID_1}
                  version={1}
                  itemId={ITEM_ID}
                  load={loader}
                  lazy={false}
                />
              </div>
            ) : null}
          </div>
        );
      }

      const h = await mountUnlockedHarness(() => <VersionHandoffHarness />);

      const serverSealed = await sealNewEntry({
        text: 'SENTINEL-VERSION-3-BODY',
        itemId: ITEM_ID,
        entryId: ENTRY_ID_1,
        vault: h.vault(),
      });
      serverSealedPayload = serverSealed;

      const invalidateSpy = vi.spyOn(h.qc, 'invalidateQueries');

      h.setRouteHandler(async (url) => {
        if (url.endsWith(`/entries/${ENTRY_ID_1}`) && serverSealedPayload) {
          getEntryCallCount += 1;
          notifyFirstGetEntered?.();
          if (holdFirstGet) {
            await holdFirstGet;
          }
          return jsonResponse({
            ...makeEntryMeta({ id: ENTRY_ID_1, item_id: ITEM_ID, version: 3 }),
            envelope: serverSealedPayload.envelope,
            ciphertext: serverSealedPayload.ciphertext,
          } satisfies Entry);
        }
        return null;
      });

      const firstGetGate = Promise.withResolvers<void>();
      const firstGetEntered = Promise.withResolvers<void>();
      holdFirstGet = firstGetGate.promise;
      notifyFirstGetEntered = firstGetEntered.resolve;

      getEntryCallCount = 0;
      act(() => {
        void h.qc.resetQueries({ queryKey: vaultBodyQueryKey(ENTRY_ID_1, 1) });
      });
      await act(async () => {
        await firstGetEntered.promise;
      });
      // Release the single shared v3 response while both co-mounted v1 observers are waiting (IP14-BE2-2)
      await act(async () => {
        firstGetGate.resolve();
      });
      holdFirstGet = null;
      notifyFirstGetEntered = null;

      await waitFor(() => {
        const renderedBodies = screen.getAllByTestId('entry-body');
        expect(renderedBodies).toHaveLength(2);
        expect(renderedBodies[0]).toHaveTextContent('SENTINEL-VERSION-3-BODY');
        expect(renderedBodies[1]).toHaveTextContent('SENTINEL-VERSION-3-BODY');
      });
      expect(getEntryCallCount).toBe(1);
      // Authoritative v3 key holds the decrypted body:
      expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 3))).toBe(
        'SENTINEL-VERSION-3-BODY',
      );
      // Obsolete v1 key must have NO data and NO query entry in QueryCache:
      await waitFor(() => {
        expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBeUndefined();
        expect(
          h.qc.getQueryCache().find({ queryKey: vaultBodyQueryKey(ENTRY_ID_1, 1), exact: true }),
        ).toBeUndefined();
      });
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          queryKey: contentQueryKeys.entries(ITEM_ID),
        }),
      );

      // Remount a third consumer with stale v1 metadata: because v1 is absent from cache, it must
      // execute the loader (which again hands off to v3) rather than silently reusing a stale v1 cache entry.
      const callsBeforeRemount = getEntryCallCount;
      await act(async () => {
        setShowThirdConsumer(true);
      });
      await waitFor(() => expect(getEntryCallCount).toBe(callsBeforeRemount + 1));
      await waitFor(() => {
        expect(screen.getAllByTestId('entry-body')).toHaveLength(3);
        expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBeUndefined();
      });

      // Locking wipes every body version
      await h.lock();
      expect(bodyQueriesWithData(h.qc)).toEqual([]);

      // Envelope and ciphertext are never cached separately in QueryCache
      expect(
        findCacheSentinelLeaks(h.qc, [serverSealed.ciphertext, serverSealed.envelope.nonce]),
      ).toEqual([]);
    }, 30_000);

    it('surfaces the error card with a working Retry when a load fails with stale_generation / vault_locked while the vault remains unlocked (IP14-FE1-14)', async () => {
      let failWithStale = true;
      const loader: EntryBodyLoader = async () => {
        if (failWithStale) {
          throw new CryptoClientError(
            'STALE_GENERATION',
            'Transient stale generation while vault remains unlocked',
          );
        }
        return 'SENTINEL-RECOVERED-FROM-STALE-GEN-88';
      };

      await mountUnlockedHarness(() => (
        <EntryBody
          entryId={ENTRY_ID_1}
          version={1}
          itemId={ITEM_ID}
          load={loader}
          lazy={false}
        />
      ));

      await waitFor(() =>
        expect(screen.getByTestId('entry-body-error')).toBeInTheDocument(),
      );
      const retryBtn = screen.getByTestId('entry-body-retry');
      expect(retryBtn).toBeInTheDocument();

      failWithStale = false;
      await act(async () => {
        fireEvent.click(retryBtn);
      });

      await waitFor(() =>
        expect(screen.getByTestId('entry-body')).toHaveTextContent(
          'SENTINEL-RECOVERED-FROM-STALE-GEN-88',
        ),
      );
    }, 30_000);
  });

  describe('3. Lock during decrypt & save version rotation', () => {
    it('lock during decrypt -> nothing cached under vaultBodyQueryKey and nothing rendered', async () => {
      const { promise: fetchGate, resolve: releaseFetch } = Promise.withResolvers<void>();
      const { promise: fetchSettled, resolve: notifyFetchSettled } =
        Promise.withResolvers<void>();
      let fetchStarted = false;
      let sealedPayload: SealedNewEntryPayload | null = null;
      const loader = createRealEntryBodyLoader();

      const h = await mountUnlockedHarness(() => (
        <EntryBody
          entryId={ENTRY_ID_1}
          version={1}
          itemId={ITEM_ID}
          load={loader}
          lazy={false}
        />
      ));

      const sealed = await sealNewEntry({
        text: 'SENTINEL-LOCK-DURING-DECRYPT-551',
        itemId: ITEM_ID,
        entryId: ENTRY_ID_1,
        vault: h.vault(),
      });
      sealedPayload = sealed;

      h.setRouteHandler(async (url) => {
        if (url.endsWith(`/entries/${ENTRY_ID_1}`) && sealedPayload) {
          fetchStarted = true;
          await fetchGate;
          queueMicrotask(notifyFetchSettled);
          return jsonResponse({
            ...makeEntryMeta({ id: ENTRY_ID_1, version: 1 }),
            envelope: sealedPayload.envelope,
            ciphertext: sealedPayload.ciphertext,
          } satisfies Entry);
        }
        return null;
      });

      await act(async () => {
        void h.qc.resetQueries({ queryKey: vaultBodyQueryKey(ENTRY_ID_1, 1) });
      });

      await waitFor(() => expect(fetchStarted).toBe(true));

      // Lock while GET /entries/{id} + openEntry is in flight
      await h.lock();
      expect(screen.getByTestId('entry-body-locked')).toHaveTextContent(LOCK_MASK_TEXT);

      // Release response after lock and wait for query to settle without wall-clock sleeps (IP14-FE1-9)
      await act(async () => {
        releaseFetch();
        await fetchSettled;
      });
      await waitFor(() => {
        expect(h.qc.isFetching()).toBe(0);
      });

      expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBeUndefined();
      expect(bodyQueriesWithData(h.qc)).toEqual([]);
      expect(findCacheSentinelLeaks(h.qc, ['SENTINEL-LOCK-DURING-DECRYPT-551'])).toEqual([]);
      expect(document.body.textContent).not.toContain('SENTINEL-LOCK-DURING-DECRYPT-551');
      assertNoPlaintextAttrs(document.body, ['SENTINEL-LOCK-DURING-DECRYPT-551'], {
        locked: true,
      });
    }, 30_000);
    it('after a save: no body key of the old version remains; the new body enters the cache ONLY via the loader when reactively enabled (IP14-BE1-7)', async () => {
      const V1_TEXT = 'SENTINEL-SAVE-V1-OLD-BODY';
      const V2_TEXT = 'SENTINEL-SAVE-V2-NEW-BODY';
      let currentServerVersion = 1;
      let currentServerSealed!: SealedNewEntryPayload;
      let setV2ViewportEnabled!: (enabled: boolean) => void;

      const loader = createRealEntryBodyLoader();
      let triggerUpdate!: (sealed: SealedEntryUpdatePayload) => Promise<EntryMeta>;

      function SaveTestHarness() {
        const [version, setVersion] = useState(1);
        const [v2ViewportEnabled, setV2ViewportEnabledState] = useState(false);
        setV2ViewportEnabled = setV2ViewportEnabledState;

        const updateMutation = useUpdateEntryMutation({
          onCurrentSuccess: (meta) => {
            setVersion(meta.version);
          },
        });
        triggerUpdate = (sealed) =>
          updateMutation.mutateAsync(
            toEntryUpdateVariables(sealed, version, { itemId: ITEM_ID }),
          );

        return (
          <EntryBody
            entryId={ENTRY_ID_1}
            version={version}
            itemId={ITEM_ID}
            load={loader}
            enabled={version === 1 || v2ViewportEnabled}
            lazy={false}
          />
        );
      }

      const h = await mountUnlockedHarness(() => <SaveTestHarness />);
      h.qc.setQueryData<EntryMetaList>(contentQueryKeys.entries(ITEM_ID), {
        items: [makeEntryMeta({ id: ENTRY_ID_1, item_id: ITEM_ID, version: 1 })],
        next_cursor: null,
      });

      currentServerSealed = await sealNewEntry({
        text: V1_TEXT,
        itemId: ITEM_ID,
        entryId: ENTRY_ID_1,
        vault: h.vault(),
      });

      h.setRouteHandler((url, init) => {
        if (url.endsWith(`/entries/${ENTRY_ID_1}`) && (!init?.method || init.method === 'GET')) {
          return jsonResponse({
            ...makeEntryMeta({ id: ENTRY_ID_1, item_id: ITEM_ID, version: currentServerVersion }),
            envelope: currentServerSealed.envelope,
            ciphertext: currentServerSealed.ciphertext,
          } satisfies Entry);
        }
        if (url.endsWith(`/entries/${ENTRY_ID_1}`) && init?.method === 'PUT') {
          currentServerVersion = 2;
          return jsonResponse(
            makeEntryMeta({ id: ENTRY_ID_1, item_id: ITEM_ID, version: 2 }),
          );
        }
        return null;
      });

      await act(async () => {
        await h.qc.resetQueries({ queryKey: vaultBodyQueryKey(ENTRY_ID_1, 1) });
      });
      await waitFor(() => expect(screen.getByTestId('entry-body')).toHaveTextContent(V1_TEXT));
      expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBe(V1_TEXT);

      // Seal V2 update and commit PUT while V2 loader is still gated off (`v2ViewportEnabled = false`)
      const sealedV2 = await sealEntryUpdate({
        entryId: ENTRY_ID_1,
        text: V2_TEXT,
        vault: h.vault(),
        itemId: ITEM_ID,
        version: 1,
      });
      currentServerSealed = {
        ...currentServerSealed,
        envelope: sealedV2.envelope,
        ciphertext: sealedV2.ciphertext,
      };

      await act(async () => {
        await triggerUpdate(sealedV2);
      });

      // Immediately after save (before loader runs for v2):
      // 1) Old version key (v1) is gone
      expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBeUndefined();
      // 2) New version key (v2) was NOT populated by the mutation callback
      expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 2))).toBeUndefined();
      expect(bodyQueriesWithData(h.qc)).toEqual([]);
      // 3) Metadata list has version 2
      const metaList = h.qc.getQueryData<EntryMetaList>(contentQueryKeys.entries(ITEM_ID));
      expect(metaList?.items[0]?.version).toBe(2);
      // 4) MutationCache has zero plaintext leaks
      expect(findCacheSentinelLeaks(h.qc, [V1_TEXT, V2_TEXT])).toEqual([]);

      // Now reactively enable the consumer for v2 -> new body enters cache ONLY via the loader (IP14-BE1-7)
      await act(async () => {
        setV2ViewportEnabled(true);
      });
      await waitFor(() =>
        expect(screen.getByTestId('entry-body')).toHaveTextContent(V2_TEXT),
      );
      expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 2))).toBe(V2_TEXT);
    }, 30_000);
  });
  describe('4. P4BE2-1 (mandatory): hold 200 response of POST and PUT, then lock / logout / user switch / vault reset, then release', () => {
    it.each([
      ['POST /items/{id}/entries', 'POST', 'lock'],
      ['POST /items/{id}/entries', 'POST', 'logout'],
      ['POST /items/{id}/entries', 'POST', 'user_switch'],
      ['POST /items/{id}/entries', 'POST', 'vault_reset'],
      ['PUT /entries/{id}', 'PUT', 'lock'],
      ['PUT /entries/{id}', 'PUT', 'logout'],
      ['PUT /entries/{id}', 'PUT', 'user_switch'],
      ['PUT /entries/{id}', 'PUT', 'vault_reset'],
      ['PUT /entries/{id} (failed 500)', 'PUT_FAIL', 'lock'],
    ] as const)(
      '%s + %s during %s while response held -> zero sentinel in QueryCache, MutationCache, editor state, and DOM',
      async (_label, opType, transitionKind) => {
        const SENTINEL = `SENTINEL-P4BE2-1-${opType}-${transitionKind}-SECRET-9001`;
        const { promise: responseGate, resolve: releaseResponse } = Promise.withResolvers<void>();
        const { promise: requestEntered, resolve: notifyRequestEntered } =
          Promise.withResolvers<void>();

        let editorDraftState = '';
        let committedBannerState = '';
        let invokeMutation!: () => Promise<void>;

        function EditorHarness() {
          const vault = useVault();
          const [draft, setDraft] = useState(SENTINEL);
          const [committedText, setCommittedText] = useState('');
          editorDraftState = draft;
          committedBannerState = committedText;

          useEffect(() => {
            return vault.registerSecretFormReset(() => {
              setDraft('');
              setCommittedText('');
            });
          }, [vault]);

          const createMut = useCreateEntryMutation({
            onCurrentSuccess: (meta) => {
              setCommittedText(`committed-${meta.version}`);
            },
            onCurrentError: () => {
              setCommittedText('error-whilst-current');
            },
          });

          const updateMut = useUpdateEntryMutation({
            onCurrentSuccess: (meta) => {
              setCommittedText(`committed-${meta.version}`);
            },
            onCurrentError: () => {
              setCommittedText('error-whilst-current');
            },
          });

          invokeMutation = async () => {
            if (opType === 'POST') {
              const sealed = await sealNewEntry({
                text: draft,
                itemId: ITEM_ID,
                entryId: ENTRY_ID_2,
                vault,
              });
              await createMut
                .mutateAsync(toEntryCreateVariables(sealed))
                .catch(() => undefined);
            } else {
              const sealed = await sealEntryUpdate({
                entryId: ENTRY_ID_1,
                text: draft,
                vault,
                itemId: ITEM_ID,
                version: 1,
              });
              await updateMut
                .mutateAsync(toEntryUpdateVariables(sealed, 1, { itemId: ITEM_ID }))
                .catch(() => undefined);
            }
          };

          return (
            <div data-testid="editor-surface">
              <textarea
                data-testid="secret-editor-input"
                {...VAULT_SECRET_INPUT_PROPS}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <output data-testid="committed-status">{committedText}</output>
            </div>
          );
        }

        const h = await mountUnlockedHarness(() => <EditorHarness />);

        // Seed initial entry metadata + initial v1 decrypted body in cache to verify it is also wiped
        h.qc.setQueryData<EntryMetaList>(contentQueryKeys.entries(ITEM_ID), {
          items: [makeEntryMeta({ id: ENTRY_ID_1, item_id: ITEM_ID, version: 1 })],
          next_cursor: null,
        });
        h.qc.setQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1), SENTINEL);

        h.setRouteHandler(async (url, init) => {
          if (
            (opType === 'POST' &&
              url.endsWith(`/items/${ITEM_ID}/entries`) &&
              init?.method === 'POST') ||
            ((opType === 'PUT' || opType === 'PUT_FAIL') &&
              url.endsWith(`/entries/${ENTRY_ID_1}`) &&
              init?.method === 'PUT')
          ) {
            notifyRequestEntered();
            await responseGate;
            if (opType === 'PUT_FAIL') {
              return problemResponse('internal_error', 500);
            }
            return jsonResponse(
              makeEntryMeta({
                id: opType === 'POST' ? ENTRY_ID_2 : ENTRY_ID_1,
                item_id: ITEM_ID,
                version: opType === 'POST' ? 1 : 2,
              }),
              opType === 'POST' ? 201 : 200,
            );
          }
          return null;
        });

        // Verify secret input attributes before starting
        assertVaultSecretElementAttributes(document.body);

        // Start mutation and wait until request is held in flight at the server
        let mutationDonePromise!: Promise<void>;
        act(() => {
          mutationDonePromise = invokeMutation();
        });
        await act(async () => {
          await requestEntered;
        });

        // Perform the lock / logout / user switch / vault reset transition while the 200/500 is held
        if (transitionKind === 'lock') {
          await h.lock();
        } else if (transitionKind === 'logout') {
          h.setSessionEnded(true);
          await act(async () => {
            await h.session().signOut('logout');
          });
          await waitFor(() => expect(h.vault().state).not.toBe('unlocked'));
          expect(['locked', 'no_vault']).toContain(h.vault().state);
          expect(h.vault().getClient().getState()).toBe('locked');
        } else if (transitionKind === 'user_switch') {
          h.setCurrentMe(makeMe(USER_B_ID, 'present'));
          await act(async () => {
            await h.session().refetchMe();
          });
          await waitFor(() => expect(h.vault().state).toBe('locked'));
        } else if (transitionKind === 'vault_reset') {
          h.setVaultAbsent(true);
          await act(async () => {
            h.vault().notifyVaultChanged({ vault_key_id: KEY_ID, version: null });
            await h.vault().reloadVaultMeta();
          });
          await waitFor(() => expect(h.vault().state).not.toBe('unlocked'));
        }

        // Now release the held HTTP response and wait for all callbacks to settle (IP14-FE1-9)
        await act(async () => {
          releaseResponse();
          await mutationDonePromise;
        });
        await waitFor(() => {
          const mutations = h.qc.getMutationCache().getAll();
          expect(mutations.length).toBeGreaterThan(0);
          expect(
            mutations.every(
              (m) => m.state.status === 'success' || m.state.status === 'error',
            ),
          ).toBe(true);
        });

        // 1. Scan QueryCache and MutationCache (variables, context, data, error of succeeded AND failed mutations)
        expect(findCacheSentinelLeaks(h.qc, [SENTINEL])).toEqual([]);

        // 2. Verify no vaultBodyQueryKey entry exists with data
        expect(bodyQueriesWithData(h.qc)).toEqual([]);
        expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBeUndefined();
        expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 2))).toBeUndefined();
        expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_2, 1))).toBeUndefined();

        // 3. Stale response must NOT have modified ['content', 'entries', itemId] list or version (IP14-FE1-6)
        const entriesAfter = h.qc.getQueryData<EntryMetaList>(
          contentQueryKeys.entries(ITEM_ID),
        );
        expect(entriesAfter?.items).toHaveLength(1);
        expect(entriesAfter?.items[0]?.id).toBe(ENTRY_ID_1);
        expect(entriesAfter?.items[0]?.version).toBe(1);
        expect(entriesAfter?.items.some((item) => item.id === ENTRY_ID_2)).toBe(false);
        expect(committedBannerState).toBe('');

        // 4. Editor React state and DOM input value were wiped on lock/logout/user switch/reset
        expect(editorDraftState).toBe('');
        const textarea = screen.getByTestId<HTMLTextAreaElement>('secret-editor-input');
        expect(textarea.value).toBe('');
        expect(document.body.textContent).not.toContain(SENTINEL);
        expect(document.body.innerHTML).not.toContain(SENTINEL);
        assertNoPlaintextAttrs(document.body, [SENTINEL], { locked: true });
      },
      30_000,
    );

    it('seal -> lock -> mutate issues zero content requests (IP14-BE1-3)', async () => {
      let contentWriteCalls = 0;
      let runCreateHook!: (vars: SealedEntryCreateVariables) => Promise<unknown>;
      let runUpdateHook!: (vars: SealedEntryUpdateVariables) => Promise<unknown>;

      function StaleMutateHarness() {
        const createMut = useCreateEntryMutation();
        const updateMut = useUpdateEntryMutation();
        runCreateHook = (vars) => createMut.mutateAsync(vars);
        runUpdateHook = (vars) => updateMut.mutateAsync(vars);
        return null;
      }

      const h = await mountUnlockedHarness(() => <StaleMutateHarness />);
      h.setRouteHandler((url, init) => {
        if (
          (url.endsWith(`/items/${ITEM_ID}/entries`) && init?.method === 'POST') ||
          (url.endsWith(`/entries/${ENTRY_ID_1}`) && init?.method === 'PUT')
        ) {
          contentWriteCalls += 1;
          return jsonResponse(makeEntryMeta({ id: ENTRY_ID_1, version: 2 }));
        }
        return null;
      });

      const sealedCreate = await sealNewEntry({
        text: 'SENTINEL-SEAL-THEN-LOCK-CREATE',
        itemId: ITEM_ID,
        entryId: ENTRY_ID_2,
        vault: h.vault(),
      });
      const sealedUpdate = await sealEntryUpdate({
        entryId: ENTRY_ID_1,
        text: 'SENTINEL-SEAL-THEN-LOCK-UPDATE',
        vault: h.vault(),
        itemId: ITEM_ID,
        version: 1,
      });
      const createVariables = toEntryCreateVariables(sealedCreate);
      const updateVariables = toEntryUpdateVariables(sealedUpdate, 1, { itemId: ITEM_ID });

      // Lock BEFORE invoking mutate
      await h.lock();

      await expect(runCreateHook(createVariables)).rejects.toMatchObject({
        name: 'EntrySealError',
        code: 'STALE_GENERATION',
      });
      await expect(runUpdateHook(updateVariables)).rejects.toMatchObject({
        name: 'EntrySealError',
        code: 'STALE_GENERATION',
      });
      await expect(mutateSealedEntryCreate(h.qc, createVariables)).rejects.toMatchObject({
        name: 'EntrySealError',
        code: 'STALE_GENERATION',
      });
      await expect(mutateSealedEntryUpdate(h.qc, updateVariables)).rejects.toMatchObject({
        name: 'EntrySealError',
        code: 'STALE_GENERATION',
      });

      expect(contentWriteCalls).toBe(0);
    }, 30_000);

    it('lock during a retry wait aborts the sleeping retry and issues no further content send (IP14-BE1-3)', async () => {
      let contentWriteAttempts = 0;
      const { promise: firstAttemptSeen, resolve: notifyFirstAttempt } =
        Promise.withResolvers<void>();
      let runUpdateHook!: (vars: SealedEntryUpdateVariables) => Promise<EntryMeta>;
      function RetryLockHarness() {
        const updateMut = useUpdateEntryMutation();
        runUpdateHook = (vars) => updateMut.mutateAsync(vars);
        return null;
      }

      const h = await mountUnlockedHarness(() => <RetryLockHarness />);
      h.setRouteHandler((url, init) => {
        if (url.endsWith(`/entries/${ENTRY_ID_1}`) && init?.method === 'PUT') {
          contentWriteAttempts += 1;
          if (contentWriteAttempts === 1) {
            notifyFirstAttempt();
            // Return retryable 503 dependency_unavailable (contentMutate waits 1000ms on signal)
            return problemResponse('dependency_unavailable', 503);
          }
          return jsonResponse(makeEntryMeta({ id: ENTRY_ID_1, version: 2 }));
        }
        return null;
      });

      const sealedUpdate = await sealEntryUpdate({
        entryId: ENTRY_ID_1,
        text: 'SENTINEL-RETRY-ABORT-ON-LOCK',
        vault: h.vault(),
        itemId: ITEM_ID,
        version: 1,
      });
      const vars = toEntryUpdateVariables(sealedUpdate, 1, { itemId: ITEM_ID });

      let mutPromise!: Promise<EntryMeta>;
      act(() => {
        mutPromise = runUpdateHook(vars);
        mutPromise.catch(() => undefined);
      });

      await act(async () => {
        await firstAttemptSeen;
      });
      expect(contentWriteAttempts).toBe(1);

      // Lock while contentMutate is sleeping in its 1s retry wait
      await h.lock();

      await expect(mutPromise).rejects.toBeDefined();
      // Wait past any retry window and verify no second attempt was ever sent
      expect(contentWriteAttempts).toBe(1);
      expect(findCacheSentinelLeaks(h.qc, ['SENTINEL-RETRY-ABORT-ON-LOCK'])).toEqual([]);
    }, 30_000);
  });

  describe('5. Lazy viewport decrypt & max 4 concurrent GET /entries/{id} for 200-entry item', () => {
    it('does not call the loader while out of viewport (IntersectionObserver), and decrypts once intersecting', async () => {
      const observedElements = new Map<Element, IntersectionObserverCallback>();

      class MockIntersectionObserver implements IntersectionObserver {
        readonly root: Element | Document | null = null;
        readonly rootMargin: string = '0px';
        readonly thresholds: ReadonlyArray<number> = [0];
        private readonly cb: IntersectionObserverCallback;

        constructor(cb: IntersectionObserverCallback) {
          this.cb = cb;
        }
        observe(el: Element): void {
          observedElements.set(el, this.cb);
        }
        unobserve(el: Element): void {
          observedElements.delete(el);
        }
        disconnect(): void {}
        takeRecords(): IntersectionObserverEntry[] {
          return [];
        }
      }

      vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

      const loadCalls: string[] = [];
      const loader: EntryBodyLoader = async (entryId) => {
        loadCalls.push(entryId);
        return `SENTINEL-LAZY-BODY-${entryId}`;
      };

      await mountUnlockedHarness(() => (
        <EntryBody entryId={ENTRY_ID_1} version={1} load={loader} lazy={true} />
      ));

      // Out of viewport -> loader not called, inert placeholder shown (no role="status", IP14-FE1-14)
      const loadingEl = screen.getByTestId('entry-body-loading');
      expect(loadingEl).toBeInTheDocument();
      expect(loadingEl).not.toHaveAttribute('role', 'status');
      expect(loadingEl).toHaveAttribute('aria-hidden', 'true');
      expect(loadCalls).toEqual([]);
      expect(observedElements.size).toBe(1);
      await act(async () => {
        for (const [el, cb] of observedElements.entries()) {
          cb(
            [
              {
                target: el,
                isIntersecting: true,
                intersectionRatio: 1,
              } as unknown as IntersectionObserverEntry,
            ],
            {} as IntersectionObserver,
          );
        }
      });

      await waitFor(() =>
        expect(screen.getByTestId('entry-body')).toHaveTextContent(
          `SENTINEL-LAZY-BODY-${ENTRY_ID_1}`,
        ),
      );
      expect(loadCalls).toEqual([ENTRY_ID_1]);
    }, 30_000);

    it('distinguishes active slot-holding cards (role="status") from enabled cards queued behind the limiter (inert skeleton) (IP14-FE1-14)', async () => {
      const cardIds = Array.from({ length: 5 }, (_, i) => {
        const hex = (i + 1).toString(16).padStart(12, '0');
        return `00000000-0000-4000-8500-${hex}`;
      });
      const gates = new Map<string, PromiseWithResolvers<void>>();
      for (const id of cardIds) {
        gates.set(id, Promise.withResolvers<void>());
      }
      const startedIds: string[] = [];

      const heldLoader: EntryBodyLoader = async (entryId) => {
        startedIds.push(entryId);
        const gate = gates.get(entryId);
        if (gate) {
          await gate.promise;
        }
        return `SENTINEL-WAITING-VS-ACTIVE-${entryId}`;
      };

      try {
        await mountUnlockedHarness(() => (
          <div data-testid="waiting-vs-active-cards">
            {cardIds.map((id, idx) => (
              <div key={id} data-testid={`waiting-vs-active-card-${idx + 1}`}>
                <EntryBody entryId={id} version={1} load={heldLoader} lazy={false} />
              </div>
            ))}
          </div>
        ));

        await waitFor(() => expect(entryBodyLoadLimiter.activeCount()).toBe(4));
        expect(entryBodyLoadLimiter.pendingCount()).toBe(1);
        expect(startedIds).toEqual(cardIds.slice(0, 4));

        const cardsContainer = screen.getByTestId('waiting-vs-active-cards');
        const allLoadingNodes = within(cardsContainer).getAllByTestId('entry-body-loading');
        expect(allLoadingNodes).toHaveLength(5);

        const statusNodes = within(cardsContainer).getAllByRole('status');
        expect(statusNodes).toHaveLength(4);

        for (let i = 0; i < 4; i += 1) {
          const cardLoading = screen
            .getByTestId(`waiting-vs-active-card-${i + 1}`)
            .querySelector('[data-testid="entry-body-loading"]');
          expect(cardLoading).toHaveAttribute('role', 'status');
          expect(cardLoading).not.toHaveAttribute('aria-hidden');
        }

        const fifthCardLoading = screen
          .getByTestId('waiting-vs-active-card-5')
          .querySelector('[data-testid="entry-body-loading"]');
        expect(fifthCardLoading).not.toHaveAttribute('role', 'status');
        expect(fifthCardLoading).toHaveAttribute('aria-hidden', 'true');

        // Release the 1st card -> 5th card acquires a slot and transitions to role="status"
        await act(async () => {
          gates.get(cardIds[0]!)!.resolve();
        });

        await waitFor(() => expect(startedIds).toContain(cardIds[4]));
        await waitFor(() => {
          const fifthNow = screen
            .getByTestId('waiting-vs-active-card-5')
            .querySelector('[data-testid="entry-body-loading"]');
          expect(fifthNow).toHaveAttribute('role', 'status');
          expect(fifthNow).not.toHaveAttribute('aria-hidden');
          expect(within(cardsContainer).getAllByRole('status')).toHaveLength(4);
        });

        // Release remaining gates -> all 5 cards render their decrypted bodies
        await act(async () => {
          for (const gate of gates.values()) {
            gate.resolve();
          }
        });
        await waitFor(() => expect(screen.getAllByTestId('entry-body')).toHaveLength(5));
      } finally {
        for (const gate of gates.values()) {
          gate.resolve();
        }
      }
    }, 30_000);

    it('scrolling a 200-entry item to the end never exceeds 4 concurrent GET /entries/{id} requests through real EntryBody + shared limiter + real loader (IP14-FE1-2, IP14-BE1-8, IP14-BE1-9)', async () => {
      const ENTRY_COUNT = 200;
      const entryIds = Array.from({ length: ENTRY_COUNT }, (_, i) => {
        const hex = (i + 1).toString(16).padStart(12, '0');
        return `00000000-0000-4000-8000-${hex}`;
      });

      let inFlightFetches = 0;
      let peakConcurrentFetches = 0;
      let totalCompletedFetches = 0;
      const pendingGates: Array<() => void> = [];

      const sealedByEntryId = new Map<
        string,
        { envelope: SealedNewEntryPayload['envelope']; ciphertext: string }
      >();

      const mockFetchEntry = vi.fn(
        async (entryId: string, opts?: { readonly signal?: AbortSignal }): Promise<Entry> => {
          inFlightFetches += 1;
          if (inFlightFetches > peakConcurrentFetches) {
            peakConcurrentFetches = inFlightFetches;
          }
          const { promise, resolve } = Promise.withResolvers<void>();
          pendingGates.push(resolve);
          if (opts?.signal) {
            opts.signal.addEventListener('abort', () => resolve(), { once: true });
          }
          try {
            await promise;
          } finally {
            inFlightFetches -= 1;
            totalCompletedFetches += 1;
          }
          const sealed = sealedByEntryId.get(entryId);
          if (!sealed) {
            throw new Error(`Missing sealed fixture for ${entryId}`);
          }
          return {
            ...makeEntryMeta({ id: entryId, item_id: ITEM_ID, version: 1 }),
            envelope: sealed.envelope,
            ciphertext: sealed.ciphertext,
          };
        },
      );

      const realLoader = createRealEntryBodyLoader({ fetchEntry: mockFetchEntry });
      let setAllInView!: (visible: boolean) => void;

      function TwoHundredCardsHarness() {
        const [allInView, setAllInViewState] = useState(false);
        setAllInView = setAllInViewState;
        return (
          <div data-testid="two-hundred-list">
            {entryIds.map((id) => (
              <EntryBody
                key={id}
                entryId={id}
                version={1}
                itemId={ITEM_ID}
                load={realLoader}
                enabled={allInView}
                lazy={false}
              />
            ))}
          </div>
        );
      }

      const h = await mountUnlockedHarness(() => <TwoHundredCardsHarness />);

      // Seal all 200 entries with real Worker AEAD so every card exercises GET + real Worker openEntry
      for (let i = 0; i < entryIds.length; i += 1) {
        const id = entryIds[i]!;
        const res = await h.vault().getClient().sealEntry({
          entryId: id,
          keyId: KEY_ID,
          plaintext: `SENTINEL-200-BODY-${i + 1}`,
          opGeneration: h.vault().captureOpGeneration(),
        });
        sealedByEntryId.set(id, { envelope: res.envelope, ciphertext: res.ciphertext });
      }

      // Enable all 200 cards simultaneously (simulating fast scroll to the end of a 200-entry item)
      await act(async () => {
        setAllInView(true);
      });

      // Wait for the first 4-card wave to enter fetchEntry
      await waitFor(() => {
        expect(pendingGates.length).toBe(4);
      });
      expect(inFlightFetches).toBe(4);
      expect(peakConcurrentFetches).toBe(4);
      expect(entryBodyLoadLimiter.activeCount()).toBe(4);
      expect(entryBodyLoadLimiter.pendingCount()).toBe(196);

      // Drain waves using observable waitFor conditions rather than fixed microtask counts
      while (totalCompletedFetches < ENTRY_COUNT) {
        await waitFor(() => {
          expect(pendingGates.length).toBeGreaterThan(0);
        });
        expect(inFlightFetches).toBeLessThanOrEqual(4);
        expect(entryBodyLoadLimiter.activeCount()).toBeLessThanOrEqual(4);
        const batch = pendingGates.splice(0, pendingGates.length);
        expect(batch.length).toBeLessThanOrEqual(4);
        await act(async () => {
          for (const release of batch) {
            release();
          }
        });
      }

      await waitFor(() => {
        expect(screen.getAllByTestId('entry-body')).toHaveLength(ENTRY_COUNT);
      });
      expect(totalCompletedFetches).toBe(ENTRY_COUNT);
      expect(peakConcurrentFetches).toBe(4);
      expect(inFlightFetches).toBe(0);
      expect(entryBodyLoadLimiter.activeCount()).toBe(0);
      expect(entryBodyLoadLimiter.pendingCount()).toBe(0);
      expect(screen.getByText('SENTINEL-200-BODY-1')).toBeInTheDocument();
      expect(screen.getByText('SENTINEL-200-BODY-200')).toBeInTheDocument();
    }, 60_000);

    it('releases limiter slots cleanly when queued/in-flight EntryBody cards reject or unmount, ending at active=0 and pending=0 (IP14-FE1-2, IP14-BE1-9)', async () => {
      const ids = Array.from({ length: 12 }, (_, i) => {
        const hex = (i + 1).toString(16).padStart(12, '0');
        return `00000000-0000-4000-9000-${hex}`;
      });
      const gates = new Map<string, () => void>();
      const sealedMap = new Map<
        string,
        { envelope: SealedNewEntryPayload['envelope']; ciphertext: string }
      >();

      const fetchEntry = vi.fn(
        async (entryId: string, opts?: { readonly signal?: AbortSignal }): Promise<Entry> => {
          const { promise, resolve } = Promise.withResolvers<void>();
          gates.set(entryId, resolve);
          opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
          await promise;
          if (entryId === ids[1] || entryId === ids[5]) {
            throw new TypeError('Simulated network failure');
          }
          const sealed = sealedMap.get(entryId)!;
          return {
            ...makeEntryMeta({ id: entryId, item_id: ITEM_ID, version: 1 }),
            envelope: sealed.envelope,
            ciphertext: sealed.ciphertext,
          };
        },
      );

      const realLoader = createRealEntryBodyLoader({ fetchEntry });
      let setMountedIds!: (nextIds: string[]) => void;

      function UnmountAndRejectHarness() {
        const [mountedIds, setMountedIdsState] = useState<string[]>([]);
        setMountedIds = setMountedIdsState;
        return (
          <div>
            {mountedIds.map((id) => (
              <EntryBody
                key={id}
                entryId={id}
                version={1}
                itemId={ITEM_ID}
                load={realLoader}
                lazy={false}
              />
            ))}
          </div>
        );
      }

      const h = await mountUnlockedHarness(() => <UnmountAndRejectHarness />);
      for (const id of ids) {
        const res = await h.vault().getClient().sealEntry({
          entryId: id,
          keyId: KEY_ID,
          plaintext: `SENTINEL-UNMOUNT-TEST-${id}`,
          opGeneration: h.vault().captureOpGeneration(),
        });
        sealedMap.set(id, { envelope: res.envelope, ciphertext: res.ciphertext });
      }

      // Mount all 12 cards -> 4 active, 8 pending
      await act(async () => {
        setMountedIds(ids);
      });
      await waitFor(() => expect(entryBodyLoadLimiter.activeCount()).toBe(4));
      expect(entryBodyLoadLimiter.pendingCount()).toBe(8);

      // Unmount 3 queued cards (ids[8..10]) and cancel their queries -> pending count drops from 8 to 5 immediately (IP14-FE2-6)
      await act(async () => {
        setMountedIds(ids.filter((_, idx) => idx < 8 || idx === 11));
        for (const removedId of [ids[8]!, ids[9]!, ids[10]!]) {
          void h.qc.cancelQueries({ queryKey: vaultBodyQueryKey(removedId, 1) });
        }
      });
      expect(entryBodyLoadLimiter.pendingCount()).toBe(5);

      // Release all gates as waves progress (including the 2 rejecting tasks)
      await waitFor(
        async () => {
          for (const [, release] of gates.entries()) {
            release();
          }
          expect(entryBodyLoadLimiter.activeCount()).toBe(0);
          expect(entryBodyLoadLimiter.pendingCount()).toBe(0);
        },
        { timeout: 10_000 },
      );

      // Cancelled queued cards (ids[8..10]) must NEVER have invoked fetchEntry (IP14-FE2-6)
      const calledIds = fetchEntry.mock.calls.map((call) => call[0]);
      expect(calledIds).not.toContain(ids[8]);
      expect(calledIds).not.toContain(ids[9]);
      expect(calledIds).not.toContain(ids[10]);
      expect(calledIds).toContain(ids[11]);

      expect(entryBodyLoadLimiter.activeCount()).toBe(0);
      expect(entryBodyLoadLimiter.pendingCount()).toBe(0);
      expect(screen.getAllByTestId('entry-body-error')).toHaveLength(2);
      expect(screen.getAllByTestId('entry-body')).toHaveLength(7);
    }, 30_000);

    it('queues and completes >4 concurrent loads when Promise.withResolvers is absent (IP14-BE1-4, IP14-FE1-3, IP14-FE2-6)', async () => {
      const promiseCtor: { withResolvers?: unknown } = Promise;
      const originalWithResolvers = promiseCtor.withResolvers;
      const limiter = createConcurrencyLimiter(4);
      const gates: Array<() => void> = [];
      let inFlight = 0;
      let peak = 0;

      try {
        promiseCtor.withResolvers = undefined;

        const tasks = Array.from({ length: 10 }, (_, idx) =>
          limiter.run(async () => {
            inFlight += 1;
            if (inFlight > peak) peak = inFlight;
            await new Promise<void>((res) => {
              gates.push(res);
            });
            inFlight -= 1;
            return `done-${idx}`;
          }),
        );

        await waitFor(() => expect(gates.length).toBe(4));
        expect(limiter.activeCount()).toBe(4);
        expect(limiter.pendingCount()).toBe(6);

        let drainIterations = 0;
        while (limiter.activeCount() > 0 || limiter.pendingCount() > 0) {
          drainIterations += 1;
          if (drainIterations > 25) {
            throw new Error('Limiter drain loop exceeded maximum iterations');
          }
          await waitFor(() => expect(gates.length).toBeGreaterThan(0));
          const batch = gates.splice(0, gates.length);
          for (const release of batch) release();
          await new Promise<void>((res) => setTimeout(res, 0));
        }

        const results = await Promise.all(tasks);
        expect(results).toHaveLength(10);
        expect(peak).toBe(4);
        expect(limiter.activeCount()).toBe(0);
        expect(limiter.pendingCount()).toBe(0);
      } finally {
        promiseCtor.withResolvers = originalWithResolvers;
      }
    });

    it('fences pre-reset in-flight tasks and rejects queued waiters on reset() so late releases never corrupt post-reset activeCount (IP14-FE1-8, IP14-BE3-1, IP14-FE3-1)', async () => {
      const limiter = createConcurrencyLimiter(1);
      const gate1 = Promise.withResolvers<void>();
      const gate1Entered = Promise.withResolvers<void>();
      const gate3 = Promise.withResolvers<void>();
      const gate3Entered = Promise.withResolvers<void>();

      try {
        // Task 1 acquires the single slot and holds it
        const task1 = limiter.run(async () => {
          gate1Entered.resolve();
          await gate1.promise;
          return 'task1';
        });
        await gate1Entered.promise;
        expect(limiter.activeCount()).toBe(1);

        // Task 2 queues behind Task 1
        let task2Ran = false;
        const task2 = limiter.run(async () => {
          task2Ran = true;
          return 'task2';
        });
        expect(limiter.pendingCount()).toBe(1);

        // Reset while Task 1 is active and Task 2 is queued -> Task 2 rejects immediately, active resets to 0
        limiter.reset();
        expect(limiter.activeCount()).toBe(0);
        expect(limiter.pendingCount()).toBe(0);
        await expect(task2).rejects.toMatchObject({ name: 'AbortError' });
        expect(task2Ran).toBe(false);

        // Start post-reset Task 3, which acquires the single slot in the new generation
        const task3 = limiter.run(async () => {
          gate3Entered.resolve();
          await gate3.promise;
          return 'task3';
        });
        await gate3Entered.promise;
        expect(limiter.activeCount()).toBe(1);

        // Now pre-reset Task 1 finishes: its late release() must be ignored and NOT decrement Task 3's active slot!
        gate1.resolve();
        await expect(task1).resolves.toBe('task1');
        expect(limiter.activeCount()).toBe(1);

        gate3.resolve();
        await expect(task3).resolves.toBe('task3');
        expect(limiter.activeCount()).toBe(0);
        expect(limiter.pendingCount()).toBe(0);
      } finally {
        gate1.resolve();
        gate3.resolve();
      }
    });

    it('fences a waiter that was granted right before reset() (before its acquisition .then samples generation or its task body runs) so it rejects with AbortError, never runs its body, and its stale release does not decrement a post-reset holder (IP14-FE1-8, IP14-BE3-1, IP14-FE3-1, IP14-BE4-2, IP14-FE4-2)', async () => {
      const limiter = createConcurrencyLimiter(1);
      const gate3 = Promise.withResolvers<void>();
      const gate3Entered = Promise.withResolvers<void>();
      const gate4 = Promise.withResolvers<void>();
      const gate5 = Promise.withResolvers<void>();
      const gate5Entered = Promise.withResolvers<void>();
      const resetDone = Promise.withResolvers<void>();

      try {
        // Task 3 acquires the single slot in generation 0 and holds it
        const task3 = limiter.run(async () => {
          gate3Entered.resolve();
          await gate3.promise;
          return 'task3';
        });
        await gate3Entered.promise;
        expect(limiter.activeCount()).toBe(1);

        // Task 4 queues behind Task 3
        let task4Ran = false;
        const task4 = limiter.run(async () => {
          task4Ran = true;
          await gate4.promise;
          return 'task4';
        });
        expect(limiter.pendingCount()).toBe(1);

        // Deterministic microtask ordering using deferred promises (`Promise.withResolvers`)
        // to position `limiter.reset()` strictly AFTER `waiter4.grant()` (so Task 4 is popped
        // and granted in generation 0) AND strictly BEFORE `promise4.then(...)` in `acquire()`
        // runs (so reverting grant-time generation capture `grantedGeneration = resetGeneration`
        // to sample `resetGeneration` inside `promise.then(() => resetGeneration)`, at `run()`
        // start, or at `release()` time makes this test FAIL):
        //   Microtask M1 (`gate3.promise` reaction inside `task3` body): resumes `task3` body
        //     -> returns `'task3'`, resolving `task3`'s inner task promise and queueing M3
        //     (`await task()` continuation in `limiter.run`).
        //   Microtask M2 (`afterBodyResume.promise` reaction): runs right after M1 (when M3 is
        //     already at the head of the microtask queue) and resolves `afterGrantBeforeSample`,
        //     queueing M4 immediately behind M3 — BEFORE M3 runs `release(0)` -> `waiter4.grant()`.
        //   Microtask M3 (`await task()` continuation in `limiter.run` for `task3`): runs
        //     `finally { release(0) }` -> `pump()` -> `waiter4.grant()`, which captures
        //     `grantedGeneration = resetGeneration` (0) and calls `resolve()`, queueing M5
        //     (`promise4.then(() => grantedGeneration)`) AFTER M4!
        //   Microtask M4 (`afterGrantBeforeSample.promise` reaction): observes
        //     `pendingCount() === 0` and `activeCount() === 1` (proving `waiter4.grant()`
        //     already ran in M3), then calls `limiter.reset()` (bumping `resetGeneration` to 1)
        //     and starts `task5` (acquiring the single slot in generation 1) BEFORE M5
        //     (`promise4.then(...)`) or Task 4's `await acquire` continuation can execute!
        let pendingAtReset = -1;
        let activeBeforeReset = -1;
        let task5!: Promise<string>;
        const afterBodyResume = Promise.withResolvers<void>();
        const afterGrantBeforeSample = Promise.withResolvers<void>();

        void afterBodyResume.promise.then(() => {
          afterGrantBeforeSample.resolve();
        });
        void afterGrantBeforeSample.promise.then(() => {
          pendingAtReset = limiter.pendingCount();
          activeBeforeReset = limiter.activeCount();
          limiter.reset();
          task5 = limiter.run(async () => {
            gate5Entered.resolve();
            await gate5.promise;
            return 'task5';
          });
          resetDone.resolve();
        });

        gate3.resolve();
        afterBodyResume.resolve();
        await expect(task3).resolves.toBe('task3');
        await resetDone.promise;

        // Confirm Task 4 was already popped and granted before reset() ran
        expect(pendingAtReset).toBe(0);
        expect(activeBeforeReset).toBe(1);

        // Task 4 must reject with AbortError without ever invoking its task body.
        // If grant-time generation capture in `concurrency-limiter.ts` were reverted to sample
        // `resetGeneration` inside `promise.then(() => resetGeneration)`, M5 would read the
        // post-reset generation `1`, `slotGeneration !== resetGeneration` (1 !== 1) would be
        // false, Task 4's body would run (`task4Ran === true`), `gate4.resolve()` below would
        // let Task 4 resolve instead of rejecting, and its `release(1)` would decrement Task 5's
        // active slot (`activeCount()` would drop from 1 to 0).
        // Resolve `gate4` before awaiting `task4` so a broken implementation fails the
        // rejection/body/activeCount assertions immediately instead of hanging on `gate4.promise`.
        gate4.resolve();
        await expect(task4).rejects.toMatchObject({ name: 'AbortError' });
        expect(task4Ran).toBe(false);

        // Post-reset Task 5's active slot must NOT have been decremented by Task 4's stale release
        await gate5Entered.promise;
        expect(limiter.activeCount()).toBe(1);

        gate5.resolve();
        await expect(task5).resolves.toBe('task5');
        expect(limiter.activeCount()).toBe(0);
        expect(limiter.pendingCount()).toBe(0);
      } finally {
        gate3.resolve();
        gate4.resolve();
        gate5.resolve();
      }
    });
  });
});
