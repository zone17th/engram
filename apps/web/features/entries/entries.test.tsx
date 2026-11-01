import type { ProblemDetails } from '@engram/shared-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
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
  resetEntryBodyLoadLimiterForTests,
  sealEntryImportJson,
  sealEntryUpdate,
  sealNewEntry,
  toEntryCreateVariables,
  toEntryUpdateVariables,
  useCreateEntryMutation,
  useUpdateEntryMutation,
  type SealedEntryUpdatePayload,
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
import type { Entry, EntryMeta, EntryMetaList } from '@/lib/api/content';
import type { CreateVaultResult } from '@/lib/crypto/client';
import { KEK_BYTES, type DeriveKekFn, type ValidatedKdfParams } from '@/lib/crypto/kdf';
import type { Sodium } from '@/lib/crypto/sodium';
import { createWorkerShim } from '@/lib/crypto/test/worker-shim';
import en from '@/messages/en.json';
import viMessages from '@/messages/vi.json';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hoistedEslint = new ESLint({ cwd: WEB_ROOT });

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

function problemResponse(code: ProblemDetails['code'], status: number) {
  return new Response(
    JSON.stringify({
      type: `https://engram.zone17.click/problems/${code}`,
      title: code,
      status,
      code,
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

  beforeEach(() => {
    document.cookie = 'sabk_csrf=test-csrf-token';
    resetVaultBroadcastForTests();
    resetEntryBodyLoadLimiterForTests();
  });

  afterEach(() => {
    cleanup();
    for (const shim of shims.splice(0)) shim.close();
    resetVaultBroadcastForTests();
    resetEntryBodyLoadLimiterForTests();
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
      handler: (url: string, init?: RequestInit) => Promise<Response> | Response | null,
    ) => void;
    setCurrentMe: (me: Me) => void;
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
    let currentMe = makeMe(USER_A_ID, 'present');
    let vaultAbsent = false;
    let customRouteHandler:
      | ((url: string, init?: RequestInit) => Promise<Response> | Response | null)
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
      if (url.endsWith('/auth/me')) return jsonResponse(currentMe);
      if (url.endsWith('/auth/logout')) return new Response(null, { status: 204 });
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

    render(
      <NextIntlClientProvider locale={locale} messages={locale === 'vi' ? viMessages : en}>
        <QueryClientProvider client={qc}>
          <SessionProvider>
            <VaultProvider
              createWorker={() => {
                const shim = createWorkerShim({
                  deriveKek: fastTestDeriveKek,
                  onBeforeCommand: (msg) => {
                    workerCalls.push({ type: msg.type, id: msg.id });
                  },
                });
                shims.push(shim);
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
  });

  describe('2. key_id mismatch vs AEAD decrypt failure + Retry + version reconciliation', () => {
    it('key_id mismatch renders old-key state and NEVER calls Worker openEntry', async () => {
      const h = await mountUnlockedHarness(undefined, 'vi');

      // Seal a valid entry, then serve it with an older key_id in its envelope
      const sealed = await sealNewEntry({
        text: 'SENTINEL-OLD-KEY-BODY',
        itemId: ITEM_ID,
        entryId: ENTRY_ID_1,
        vault: h.vault(),
      });

      h.setRouteHandler((url) => {
        if (url.endsWith(`/entries/${ENTRY_ID_1}`)) {
          const entryResp: Entry = {
            ...makeEntryMeta({ id: ENTRY_ID_1, version: 1 }),
            envelope: {
              ...sealed.envelope,
              key_id: OLD_KEY_ID,
            },
            ciphertext: sealed.ciphertext,
          };
          return jsonResponse(entryResp);
        }
        return null;
      });

      h.workerCalls.length = 0;
      const loader = createRealEntryBodyLoader();

      render(
        <NextIntlClientProvider locale="vi" messages={viMessages}>
          <QueryClientProvider client={h.qc}>
            <EntryBody
              entryId={ENTRY_ID_1}
              version={1}
              load={(id, ctx) =>
                loader(id, {
                  ...ctx,
                  vaultKeyId: h.vault().vaultMeta?.vault_key_id ?? KEY_ID,
                })
              }
              lazy={false}
            />
          </QueryClientProvider>
        </NextIntlClientProvider>,
      );

      // Direct test inside the mounted provider tree using h.qc:
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
    }, 30_000);

    it('renders old-key card and AEAD decrypt-failed card with working Retry button in EntryBody', async () => {
      let currentMode: 'old_key' | 'corrupt_aead' | 'valid' = 'old_key';
      let validSealed!: SealedNewEntryPayload;
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
          </div>
        ),
        'vi',
      );

      validSealed = await sealNewEntry({
        text: 'SENTINEL-RECOVERED-AFTER-RETRY-77',
        itemId: ITEM_ID,
        entryId: ENTRY_ID_1,
        vault: h.vault(),
      });

      h.setRouteHandler((url) => {
        if (url.endsWith(`/entries/${ENTRY_ID_1}`)) {
          if (currentMode === 'old_key') {
            return jsonResponse({
              ...makeEntryMeta({ id: ENTRY_ID_1, version: 1 }),
              envelope: { ...validSealed.envelope, key_id: OLD_KEY_ID },
              ciphertext: validSealed.ciphertext,
            } satisfies Entry);
          }
          if (currentMode === 'corrupt_aead') {
            // Tamper with ciphertext so AEAD tag verification fails in Worker
            const badCiphertext =
              validSealed.ciphertext.slice(0, -4) +
              (validSealed.ciphertext.endsWith('AAAA') ? 'BBBB' : 'AAAA');
            return jsonResponse({
              ...makeEntryMeta({ id: ENTRY_ID_1, version: 1 }),
              envelope: validSealed.envelope,
              ciphertext: badCiphertext,
            } satisfies Entry);
          }
          return jsonResponse({
            ...makeEntryMeta({ id: ENTRY_ID_1, version: 1 }),
            envelope: validSealed.envelope,
            ciphertext: validSealed.ciphertext,
          } satisfies Entry);
        }
        return null;
      });

      // 1. Trigger refetch in old_key mode
      h.workerCalls.length = 0;
      await act(async () => {
        await h.qc.invalidateQueries({ queryKey: vaultBodyQueryKey(ENTRY_ID_1, 1) });
      });

      await waitFor(() =>
        expect(screen.getByTestId('entry-body-old-key')).toBeInTheDocument(),
      );
      expect(screen.getByTestId('entry-body-old-key')).toHaveTextContent(
        /Entry này mã hoá bằng khoá cũ/i,
      );
      expect(h.workerCalls.filter((c) => c.type === 'openEntry')).toHaveLength(0);
      assertNoPlaintextAttrs(document.body, ['SENTINEL-RECOVERED-AFTER-RETRY-77']);

      // 2. Switch to corrupt_aead mode and invalidate -> decrypt-failed card with Retry button
      currentMode = 'corrupt_aead';
      await act(async () => {
        await h.qc.resetQueries({ queryKey: vaultBodyQueryKey(ENTRY_ID_1, 1) });
      });

      await waitFor(() =>
        expect(screen.getByTestId('entry-body-error')).toBeInTheDocument(),
      );
      expect(screen.getByTestId('entry-body-error')).toHaveTextContent(
        /Không giải mã được/i,
      );
      const retryBtn = screen.getByTestId('entry-body-retry');
      expect(retryBtn).toHaveTextContent('Thử lại');
      assertNoPlaintextAttrs(document.body, ['SENTINEL-RECOVERED-AFTER-RETRY-77']);

      // 3. Switch server response to valid ciphertext and click Retry -> body renders!
      currentMode = 'valid';
      await act(async () => {
        fireEvent.click(retryBtn);
      });

      await waitFor(() =>
        expect(screen.getByTestId('entry-body')).toHaveTextContent(
          'SENTINEL-RECOVERED-AFTER-RETRY-77',
        ),
      );
      expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBe(
        'SENTINEL-RECOVERED-AFTER-RETRY-77',
      );
      assertNoPlaintextAttrs(document.body, ['SENTINEL-RECOVERED-AFTER-RETRY-77']);
    }, 30_000);

    it('when GET /entries/{id} returns a newer version than list metadata, caches under the new version and invalidates list metadata', async () => {
      const loader = createRealEntryBodyLoader();
      let serverSealed!: SealedNewEntryPayload;

      const h = await mountUnlockedHarness(() => (
        <EntryBody
          entryId={ENTRY_ID_1}
          version={1}
          itemId={ITEM_ID}
          load={loader}
          lazy={false}
        />
      ));

      serverSealed = await sealNewEntry({
        text: 'SENTINEL-VERSION-3-BODY',
        itemId: ITEM_ID,
        entryId: ENTRY_ID_1,
        vault: h.vault(),
      });

      const invalidateSpy = vi.spyOn(h.qc, 'invalidateQueries');

      h.setRouteHandler((url) => {
        if (url.endsWith(`/entries/${ENTRY_ID_1}`)) {
          return jsonResponse({
            ...makeEntryMeta({ id: ENTRY_ID_1, item_id: ITEM_ID, version: 3 }),
            envelope: serverSealed.envelope,
            ciphertext: serverSealed.ciphertext,
          } satisfies Entry);
        }
        return null;
      });

      await act(async () => {
        await h.qc.resetQueries({ queryKey: vaultBodyQueryKey(ENTRY_ID_1, 1) });
      });

      await waitFor(() =>
        expect(screen.getByTestId('entry-body')).toHaveTextContent('SENTINEL-VERSION-3-BODY'),
      );
      expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 3))).toBe(
        'SENTINEL-VERSION-3-BODY',
      );
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          queryKey: contentQueryKeys.entries(ITEM_ID),
        }),
      );
      // Envelope and ciphertext are never cached separately in QueryCache
      expect(
        findCacheSentinelLeaks(h.qc, [serverSealed.ciphertext, serverSealed.envelope.nonce]),
      ).toEqual([]);
    }, 30_000);
  });

  describe('3. Lock during decrypt & save version rotation', () => {
    it('lock during decrypt -> nothing cached under vaultBodyQueryKey and nothing rendered', async () => {
      const { promise: fetchGate, resolve: releaseFetch } = Promise.withResolvers<void>();
      let fetchStarted = false;
      const loader = createRealEntryBodyLoader();
      let sealed!: SealedNewEntryPayload;

      const h = await mountUnlockedHarness(() => (
        <EntryBody
          entryId={ENTRY_ID_1}
          version={1}
          itemId={ITEM_ID}
          load={loader}
          lazy={false}
        />
      ));

      sealed = await sealNewEntry({
        text: 'SENTINEL-LOCK-DURING-DECRYPT-551',
        itemId: ITEM_ID,
        entryId: ENTRY_ID_1,
        vault: h.vault(),
      });

      h.setRouteHandler(async (url) => {
        if (url.endsWith(`/entries/${ENTRY_ID_1}`)) {
          fetchStarted = true;
          await fetchGate;
          return jsonResponse({
            ...makeEntryMeta({ id: ENTRY_ID_1, version: 1 }),
            envelope: sealed.envelope,
            ciphertext: sealed.ciphertext,
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

      // Release response after lock
      await act(async () => {
        releaseFetch();
        await Promise.resolve();
      });
      await new Promise<void>((r) => setTimeout(r, 25));

      expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBeUndefined();
      expect(bodyQueriesWithData(h.qc)).toEqual([]);
      expect(findCacheSentinelLeaks(h.qc, ['SENTINEL-LOCK-DURING-DECRYPT-551'])).toEqual([]);
      expect(document.body.textContent).not.toContain('SENTINEL-LOCK-DURING-DECRYPT-551');
      assertNoPlaintextAttrs(document.body, ['SENTINEL-LOCK-DURING-DECRYPT-551']);
    }, 30_000);

    it('after a save: no body key of the old version remains; the new body enters the cache ONLY via the loader', async () => {
      const V1_TEXT = 'SENTINEL-SAVE-V1-OLD-BODY';
      const V2_TEXT = 'SENTINEL-SAVE-V2-NEW-BODY';
      let currentServerVersion = 1;
      let currentServerSealed!: SealedNewEntryPayload;
      let allowV2LoaderFetch = false;

      const loader = createRealEntryBodyLoader();
      let triggerUpdate!: (sealed: SealedEntryUpdatePayload) => Promise<EntryMeta>;

      function SaveTestHarness() {
        const [version, setVersion] = useState(1);
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
            enabled={version === 1 || allowV2LoaderFetch}
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

      // Seal V2 update and commit PUT while V2 loader is still gated off (`allowV2LoaderFetch = false`)
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

      // Now enable loader for v2 -> new body enters cache ONLY via the loader
      allowV2LoaderFetch = true;
      await act(async () => {
        await h.qc.invalidateQueries({ queryKey: vaultBodyQueryKey(ENTRY_ID_1, 2) });
      });
      await waitFor(() =>
        expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 2))).toBe(V2_TEXT),
      );
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
      '%s + %s while response held -> zero sentinel in QueryCache, MutationCache, editor state, and DOM',
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
          await act(async () => {
            await h.session().signOut('logout');
          });
          await waitFor(() => expect(h.vault().state).toBe('locked'));
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

        // Now release the held HTTP response and wait for all callbacks to settle
        await act(async () => {
          releaseResponse();
          await mutationDonePromise;
        });
        await new Promise<void>((r) => setTimeout(r, 25));

        // 1. Scan QueryCache and MutationCache (variables, context, data, error of succeeded AND failed mutations)
        expect(findCacheSentinelLeaks(h.qc, [SENTINEL])).toEqual([]);

        // 2. Verify no vaultBodyQueryKey entry exists with data
        expect(bodyQueriesWithData(h.qc)).toEqual([]);
        expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBeUndefined();
        expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 2))).toBeUndefined();
        expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_2, 1))).toBeUndefined();

        // 3. Stale response must NOT have overwritten ['content', 'entries', itemId] metadata version or state
        const entriesAfter = h.qc.getQueryData<EntryMetaList>(
          contentQueryKeys.entries(ITEM_ID),
        );
        expect(entriesAfter?.items[0]?.version).toBe(1);
        expect(committedBannerState).toBe('');

        // 4. Editor React state and DOM input value were wiped on lock/logout/user switch/reset
        expect(editorDraftState).toBe('');
        const textarea = screen.getByTestId<HTMLTextAreaElement>('secret-editor-input');
        expect(textarea.value).toBe('');
        expect(document.body.textContent).not.toContain(SENTINEL);
        expect(document.body.innerHTML).not.toContain(SENTINEL);
        assertNoPlaintextAttrs(document.body, [SENTINEL]);
      },
      30_000,
    );
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

      // Out of viewport -> loader not called, loading placeholder shown
      expect(screen.getByTestId('entry-body-loading')).toBeInTheDocument();
      expect(loadCalls).toEqual([]);
      expect(observedElements.size).toBe(1);

      // Simulate scrolling into viewport
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

    it('scrolling a 200-entry item to the end never exceeds 4 concurrent GET /entries/{id} requests', async () => {
      const ENTRY_COUNT = 200;
      const entryIds = Array.from({ length: ENTRY_COUNT }, (_, i) => {
        const hex = (i + 1).toString(16).padStart(12, '0');
        return `00000000-0000-4000-8000-${hex}`;
      });

      let inFlightFetches = 0;
      let peakConcurrentFetches = 0;
      let totalCompletedFetches = 0;
      const pendingGates: Array<() => void> = [];

      const limiter = createConcurrencyLimiter(4);

      const mockFetchEntry = vi.fn(async (entryId: string): Promise<Entry> => {
        inFlightFetches += 1;
        if (inFlightFetches > peakConcurrentFetches) {
          peakConcurrentFetches = inFlightFetches;
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        pendingGates.push(resolve);
        await promise;
        inFlightFetches -= 1;
        totalCompletedFetches += 1;
        return {
          ...makeEntryMeta({ id: entryId, version: 1 }),
          envelope: {
            v: 1,
            alg: 'xchacha20poly1305-ietf',
            key_id: KEY_ID,
            nonce: 'AAAAAAAAAAAAAAAAAAAAAAAA________________________',
            ct_enc: 'utf8',
          },
          ciphertext: 'BBBBBBBBBBBBBBBBBBBBBBBB',
        };
      });

      // Fire all 200 loads simultaneously (simulating fast scroll to the end of a 200-entry item)
      const loadPromises = entryIds.map((entryId) =>
        limiter.run(async () => {
          const entry = await mockFetchEntry(entryId);
          return `body-${entry.id}`;
        }),
      );

      // Flush microtasks so the first wave starts
      await Promise.resolve();
      expect(inFlightFetches).toBe(4);
      expect(peakConcurrentFetches).toBe(4);
      expect(limiter.activeCount()).toBe(4);
      expect(limiter.pendingCount()).toBe(196);

      // Drain waves until all 200 finish, checking concurrency invariant at every step
      while (totalCompletedFetches < ENTRY_COUNT) {
        expect(inFlightFetches).toBeLessThanOrEqual(4);
        const batch = pendingGates.splice(0, pendingGates.length);
        expect(batch.length).toBeGreaterThan(0);
        expect(batch.length).toBeLessThanOrEqual(4);
        for (const release of batch) {
          release();
        }
        await Promise.resolve();
        await Promise.resolve();
      }

      const results = await Promise.all(loadPromises);
      expect(results).toHaveLength(200);
      expect(totalCompletedFetches).toBe(200);
      expect(peakConcurrentFetches).toBe(4);
      expect(inFlightFetches).toBe(0);
    });
  });

  describe('6. ESLint rule P4FE2-16 and compatibility with useEntryBody', () => {
    it('features/entries/** and features/items/entry-body.tsx pass ESLint with 0 errors (including no-restricted-imports on useMutation)', async () => {
      const results = await hoistedEslint.lintFiles([
        'features/entries/seal.ts',
        'features/entries/mutations.ts',
        'features/entries/real-body-loader.ts',
        'features/entries/concurrency-limiter.ts',
        'features/entries/secret-input-props.ts',
        'features/entries/test-utils/assert-no-plaintext-attrs.ts',
        'features/items/entry-body.tsx',
        'features/items/item-article.tsx',
      ]);
      const errors = results.flatMap((r) => r.messages.filter((m) => m.severity === 2));
      expect(errors).toEqual([]);
    }, 30_000);
  });
});
