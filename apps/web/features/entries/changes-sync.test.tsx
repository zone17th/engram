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
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/components/theme-provider';
import { UndoToastProvider } from '@/components/ui/undo-toast';
import { SessionProvider, useSession } from '@/features/auth/session-provider';
import {
  clearAllUnconfirmedSaves,
  resetEntryBodyLoadLimiterForTests,
  type EditorPlaintextHolder,
} from '@/features/entries';
import {
  ContentChangesSync,
  __testing as changesSyncTesting,
  applyEntryChangesBatch,
  clearAllChangesSyncState,
  computeChangesSince,
  dedupEntryChanges,
  isEntryRemotelyDeleted,
  subscribeRemoteTombstones,
  useEntryRemotelyDeleted,
} from '@/features/entries/changes-sync';
import { assertNoPlaintextAttrs } from '@/features/entries/test-utils/assert-no-plaintext-attrs';
import { ItemDetailPage } from '@/features/items/item-detail-page';
import { contentQueryKeys } from '@/features/items/query-keys';
import { __testing as textEntryCardTesting } from '@/features/items/text-entry-card';
import { __testing as jsonTableTesting } from '@/features/json-table';
import {
  VaultProvider,
  resetVaultBroadcastForTests,
  useVault,
  vaultBodyQueryKey,
  type LockEpochEnvironment,
  type VaultContextValue,
} from '@/features/vault';
import type { Me } from '@/lib/api/auth';
import type {
  Entry,
  EntryChange,
  EntryChangesPage,
  EntryCreateRequest,
  EntryMeta,
  EntryMetaList,
  EntryUpdateRequest,
  ItemSummary,
  Tag,
} from '@/lib/api/content';
import { commitAuthenticatedUser, __testing as userChangedTesting } from '@/lib/auth/user-changed';
import type { CreateVaultResult } from '@/lib/crypto/client';
import { KEK_BYTES, type DeriveKekFn, type ValidatedKdfParams } from '@/lib/crypto/kdf';
import type { Sodium } from '@/lib/crypto/sodium';
import { createWorkerShim } from '@/lib/crypto/test/worker-shim';
import en from '@/messages/en.json';
import viMessages from '@/messages/vi.json';

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  redirect: vi.fn((target: string) => {
    throw new Error(`NEXT_REDIRECT:${target}`);
  }),
  pathname: '/app/items/11111111-1111-4111-8111-111111111111',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: routerMocks.push,
    replace: routerMocks.replace,
  }),
  usePathname: () => routerMocks.pathname,
  useSearchParams: () => new URLSearchParams(),
  redirect: routerMocks.redirect,
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

const PASSPHRASE = 'task20-changes-sync-passphrase-1';
const KEY_ID_1 = 'vk:7f3a91c4e0b2d8a1f5c309';
const KEY_ID_2 = 'vk:99887766554433221100aa';
const ITEM_ID = '11111111-1111-4111-8111-111111111111';
const ENTRY_ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENTRY_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENTRY_ID_3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_A_ID = '33333333-3333-4333-8333-333333333333';
const USER_B_ID = '44444444-4444-4444-8444-444444444444';

function createDeferred<T = void>(): PromiseWithResolvers<T> {
  return Promise.withResolvers<T>();
}

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
  let marker = { epochIncarnation: 'inc-task20-1', lockEpoch: 1 };
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

function makeVaultGetResponse(created: CreateVaultResult, keyId = KEY_ID_1, version = 1) {
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

function makeItemSummary(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: ITEM_ID,
    name: 'wifi-sync',
    hint: 'router sync test',
    tags: [{ id: 'tag-1', display: 'nhà' }],
    entry_count: 1,
    version: 1,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    last_used_at: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

function makeEntryChange(overrides: Partial<EntryChange> & { id: string }): EntryChange {
  return {
    id: overrides.id,
    item_id: overrides.item_id ?? ITEM_ID,
    type: overrides.type ?? 'text',
    position: overrides.position ?? 0,
    version: overrides.version ?? 1,
    plaintext_len_bucket: overrides.plaintext_len_bucket ?? 256,
    created_at: overrides.created_at ?? '2026-11-01T10:00:00Z',
    updated_at: overrides.updated_at ?? '2026-11-01T10:00:00Z',
    deleted_at: overrides.deleted_at ?? null,
  };
}

describe('P04-T20 changes-sync: multi-device feed, overlap dedup, tombstones, vault reset & kept-mounted card wipe', () => {
  const shims: Array<{ close: () => void }> = [];
  const originalVisibilityStateDescriptor = Object.getOwnPropertyDescriptor(
    document,
    'visibilityState',
  );

  beforeEach(() => {
    document.cookie = 'sabk_csrf=test-csrf-token';
    window.localStorage.clear();
    window.sessionStorage.clear();
    routerMocks.push.mockReset();
    routerMocks.replace.mockReset();
    routerMocks.redirect.mockClear();
    resetVaultBroadcastForTests();
    resetEntryBodyLoadLimiterForTests();
    clearAllUnconfirmedSaves();
    clearAllChangesSyncState();
    changesSyncTesting.resetAllForTests();
    userChangedTesting.resetCommittedUserForTests();
    textEntryCardTesting.setEditorPlaintextHolderForTests(null);
    jsonTableTesting.setJsonEditorPlaintextHolderForTests(null);
  });

  afterEach(() => {
    cleanup();
    for (const shim of shims.splice(0)) shim.close();
    resetVaultBroadcastForTests();
    resetEntryBodyLoadLimiterForTests();
    clearAllUnconfirmedSaves();
    clearAllChangesSyncState();
    changesSyncTesting.resetAllForTests();
    userChangedTesting.resetCommittedUserForTests();
    textEntryCardTesting.setEditorPlaintextHolderForTests(null);
    jsonTableTesting.setJsonEditorPlaintextHolderForTests(null);
    vi.restoreAllMocks();
    if (originalVisibilityStateDescriptor) {
      Object.defineProperty(document, 'visibilityState', originalVisibilityStateDescriptor);
    } else {
      Reflect.deleteProperty(document, 'visibilityState');
    }
  });

  interface SyncHarnessOptions {
    readonly locale?: 'en' | 'vi';
    readonly initialUnlocked?: boolean;
    readonly initialEntries?: Array<{
      readonly id: string;
      readonly text: string;
      readonly type?: 'text' | 'json';
      readonly version?: number;
      readonly position?: number;
    }>;
    readonly renderItemPage?: boolean;
  }

  async function setupSyncHarness(options: SyncHarnessOptions = {}) {
    const locale = options.locale ?? 'vi';
    const initialUnlocked = options.initialUnlocked ?? true;
    const renderItemPage = options.renderItemPage ?? false;

    let vaultCtx!: VaultContextValue;
    let signOutFn!: () => Promise<void>;
    let loginFn!: (args: { email: string; password: string }) => Promise<unknown>;
    let refetchMeFn!: () => Promise<void>;

    function Probe() {
      vaultCtx = useVault();
      const sess = useSession();
      signOutFn = () => sess.signOut();
      loginFn = (args) => sess.login(args);
      refetchMeFn = () => sess.refetchMe();
      return <output data-testid="vault-state-probe">{vaultCtx.state}</output>;
    }

    let createdVault: CreateVaultResult | null = null;
    let activeVaultKeyId: string | null = KEY_ID_1;
    let currentMe: Me | null = makeMe(USER_A_ID, 'present');

    const serverItem: ItemSummary = makeItemSummary();
    const entriesMap = new Map<string, Entry & { deleted?: boolean }>();
    const catalogTags: Tag[] = [
      {
        id: 'tag-1',
        display: 'nhà',
        item_count: 1,
        created_at: '2026-11-01T00:00:00Z',
        last_used_at: '2026-11-01T00:00:00Z',
      },
    ];

    const requestLog: Array<{
      method: string;
      url: string;
      pathname: string;
      searchParams: URLSearchParams;
      headers: Record<string, string>;
      rawBody: string;
    }> = [];

    let changesHandler: (
      params: URLSearchParams,
      callIndex: number,
    ) => Promise<Response> | Response = (params) => {
      const since = params.get('since');
      if (!since) {
        return jsonResponse({
          changes: [],
          next_cursor: null,
          watermark: '2026-11-01T12:00:00.123456789Z',
        } satisfies EntryChangesPage);
      }
      return jsonResponse({
        changes: [],
        next_cursor: null,
        watermark: '2026-11-01T12:05:00.987654321Z',
      } satisfies EntryChangesPage);
    };
    let changesCallCount = 0;

    let routeOverride:
      | ((url: string, init?: RequestInit) => Promise<Response | null> | Response | null)
      | null = null;

    const extractHeaders = (init?: RequestInit): Record<string, string> => {
      const out: Record<string, string> = {};
      if (!init?.headers) return out;
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          out[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) {
          out[k.toLowerCase()] = v;
        }
      } else {
        for (const [k, v] of Object.entries(init.headers)) {
          if (typeof v === 'string') out[k.toLowerCase()] = v;
        }
      }
      return out;
    };

    const toEntryMeta = (rec: Entry): EntryMeta => ({
      id: rec.id,
      item_id: rec.item_id,
      type: rec.type,
      position: rec.position,
      version: rec.version,
      plaintext_len_bucket: rec.plaintext_len_bucket,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
    });

    const liveEntryMetas = (): EntryMeta[] =>
      Array.from(entriesMap.values())
        .filter((e) => !e.deleted)
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
        .map(toEntryMeta);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = extractHeaders(init);
      const rawBody = typeof init?.body === 'string' ? init.body : '';
      const parsedUrl = new URL(url, 'http://localhost');

      requestLog.push({
        method,
        url,
        pathname: parsedUrl.pathname,
        searchParams: parsedUrl.searchParams,
        headers,
        rawBody,
      });

      if (routeOverride) {
        const custom = await routeOverride(url, init);
        if (custom) return custom;
      }

      if (parsedUrl.pathname.endsWith('/auth/csrf')) {
        return new Response(null, { status: 204 });
      }
      if (parsedUrl.pathname.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (parsedUrl.pathname.endsWith('/auth/me')) {
        if (!currentMe) return problemResponse('session_invalid', 401);
        return jsonResponse(currentMe);
      }
      if (parsedUrl.pathname.endsWith('/auth/logout')) {
        currentMe = null;
        return new Response(null, { status: 204 });
      }
      if (parsedUrl.pathname.endsWith('/auth/login')) {
        return jsonResponse(currentMe ?? makeMe(USER_A_ID, 'present'));
      }
      if (parsedUrl.pathname.endsWith('/vault')) {
        if (!createdVault || !activeVaultKeyId || currentMe?.vault.status !== 'present') {
          return problemResponse('vault_absent', 404);
        }
        return jsonResponse(makeVaultGetResponse(createdVault, activeVaultKeyId, 1));
      }

      if (parsedUrl.pathname === '/api/v1/entries/changes' && method === 'GET') {
        const idx = changesCallCount++;
        return changesHandler(parsedUrl.searchParams, idx);
      }

      if (parsedUrl.pathname === '/api/v1/items' && method === 'GET') {
        return jsonResponse({
          items: [{ ...serverItem, entry_count: liveEntryMetas().length }],
          next_cursor: null,
        });
      }

      if (parsedUrl.pathname === `/api/v1/items/${ITEM_ID}` && method === 'GET') {
        return jsonResponse({
          ...serverItem,
          entry_count: liveEntryMetas().length,
        });
      }

      if (parsedUrl.pathname === '/api/v1/tags' && method === 'GET') {
        return jsonResponse({
          items: catalogTags,
          next_cursor: null,
        });
      }

      if (parsedUrl.pathname === `/api/v1/items/${ITEM_ID}/entries`) {
        if (method === 'GET') {
          return jsonResponse({
            items: liveEntryMetas(),
            next_cursor: null,
          });
        }
        if (method === 'POST') {
          const req = JSON.parse(rawBody) as EntryCreateRequest;
          const allPositions = Array.from(entriesMap.values()).map((e) => e.position);
          const nextPos = allPositions.length > 0 ? Math.max(...allPositions) + 1 : 0;
          const newEntry: Entry = {
            id: req.id,
            item_id: ITEM_ID,
            type: req.type,
            position: nextPos,
            version: 1,
            plaintext_len_bucket: req.plaintext_len_bucket,
            envelope: req.envelope,
            ciphertext: req.ciphertext,
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T00:00:00Z',
          };
          entriesMap.set(newEntry.id, newEntry);
          return jsonResponse(toEntryMeta(newEntry), 201);
        }
      }

      const singleEntryMatch = /^\/api\/v1\/entries\/([^/]+)$/.exec(parsedUrl.pathname);
      if (singleEntryMatch) {
        const eid = decodeURIComponent(singleEntryMatch[1]!);
        const rec = entriesMap.get(eid);
        if (!rec || rec.deleted) {
          return problemResponse('not_found', 404);
        }
        if (method === 'GET') {
          const { deleted: _deleted, ...clean } = rec;
          void _deleted;
          return jsonResponse(clean, 200);
        }
        if (method === 'PUT') {
          const ifMatch = headers['if-match'];
          if (!ifMatch) return problemResponse('precondition_required', 428);
          if (ifMatch !== `"${rec.version}"`) {
            return problemResponse('version_mismatch', 412, {
              current_version: rec.version,
            });
          }
          const req = JSON.parse(rawBody) as EntryUpdateRequest;
          rec.envelope = req.envelope;
          rec.ciphertext = req.ciphertext;
          rec.plaintext_len_bucket = req.plaintext_len_bucket;
          rec.version += 1;
          return jsonResponse(toEntryMeta(rec), 200);
        }
        if (method === 'DELETE') {
          rec.deleted = true;
          return new Response(null, { status: 204 });
        }
      }

      return jsonResponse({});
    });

    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    const buildTree = (child?: ReactNode) => (
      <NextIntlClientProvider locale={locale} messages={locale === 'vi' ? viMessages : en}>
        <ThemeProvider initialTheme="light" initialLocale={locale}>
          <QueryClientProvider client={qc}>
            <UndoToastProvider>
              <SessionProvider>
                <VaultProvider
                  createWorker={() => {
                    const shim = createWorkerShim({ deriveKek: fastTestDeriveKek });
                    shims.push(shim);
                    return shim.port;
                  }}
                  lockEpochEnv={makeSimpleLockEpochEnv()}
                >
                  <Probe />
                  {child}
                </VaultProvider>
              </SessionProvider>
            </UndoToastProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </NextIntlClientProvider>
    );

    const rendered = render(buildTree(null));
    await waitFor(() =>
      expect(screen.getByTestId('vault-state-probe')).toHaveTextContent('locked'),
    );

    const createOp = vaultCtx.beginOp();
    await act(async () => {
      createdVault = await vaultCtx.createVault({
        passphrase: PASSPHRASE,
        opGeneration: createOp.opGeneration,
      });
      await vaultCtx.reloadVaultMeta();
    });
    await waitFor(() => expect(vaultCtx.state).toBe('unlocked'));

    const sealForEntry = async (
      entryId: string,
      plaintext: string,
      type: 'text' | 'json' = 'text',
      version = 1,
      position = entriesMap.size,
    ): Promise<Entry> => {
      const op = vaultCtx.beginOp();
      const sealed = await op.client.sealEntry({
        entryId,
        keyId: activeVaultKeyId ?? KEY_ID_1,
        plaintext,
        opGeneration: op.opGeneration,
      });
      const bytes = new TextEncoder().encode(plaintext).byteLength;
      const bucket = Math.max(256, Math.ceil(bytes / 256) * 256);
      const entryObj: Entry = {
        id: entryId,
        item_id: ITEM_ID,
        type,
        position,
        version,
        plaintext_len_bucket: bucket,
        envelope: sealed.envelope,
        ciphertext: sealed.ciphertext,
        created_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-01T00:00:00Z',
      };
      entriesMap.set(entryId, entryObj);
      return entryObj;
    };

    for (let i = 0; i < (options.initialEntries ?? []).length; i += 1) {
      const spec = options.initialEntries![i]!;
      await sealForEntry(
        spec.id,
        spec.text,
        spec.type ?? 'text',
        spec.version ?? 1,
        spec.position ?? i,
      );
    }

    if (!initialUnlocked) {
      await act(async () => {
        await vaultCtx.lockNow();
      });
      await waitFor(() => expect(vaultCtx.state).toBe('locked'));
    }

    requestLog.splice(0);
    changesCallCount = 0;

    rendered.rerender(
      buildTree(
        <>
          <ContentChangesSync />
          {renderItemPage ? <ItemDetailPage itemId={ITEM_ID} lazyCards={false} /> : null}
        </>,
      ),
    );

    if (initialUnlocked) {
      // Wait for initial bootstrap feed call on mount
      await waitFor(() => {
        expect(
          requestLog.some((r) => r.pathname === '/api/v1/entries/changes'),
        ).toBe(true);
      });
    }

    return {
      container: rendered.container,
      qc,
      vault: () => vaultCtx,
      entriesMap,
      requests: requestLog,
      sealForEntry,
      setChangesHandler: (
        fn: (params: URLSearchParams, callIndex: number) => Promise<Response> | Response,
      ) => {
        changesHandler = fn;
      },
      overrideRoute: (
        fn: ((url: string, init?: RequestInit) => Promise<Response | null> | Response | null) | null,
      ) => {
        routeOverride = fn;
      },
      setActiveVaultKeyId: (nextKeyId: string | null) => {
        activeVaultKeyId = nextKeyId;
      },
      setCurrentMe: (nextMe: Me | null) => {
        currentMe = nextMe;
      },
      lock: async () => {
        await act(async () => {
          await vaultCtx.lockNow();
        });
        await waitFor(() => expect(vaultCtx.state).toBe('locked'));
      },
      unlock: async () => {
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
      },
      signOutSession: async () => {
        await act(async () => {
          await signOutFn();
        });
      },
      loginSession: async (email: string, password: string) => {
        await act(async () => {
          await loginFn({ email, password });
        });
      },
      refetchMeSession: async () => {
        await act(async () => {
          await refetchMeFn();
        });
      },
    };
  }

  it('computes since = watermark - 120 s in RFC3339Nano preserving sub-millisecond precision', () => {
    expect(computeChangesSince('2026-11-01T12:05:00.123456789Z')).toBe(
      '2026-11-01T12:03:00.123456789Z',
    );
    expect(computeChangesSince('2026-11-01T12:02:00Z')).toBe('2026-11-01T12:00:00Z');
    expect(computeChangesSince(null)).toBeUndefined();
    expect(computeChangesSince('')).toBeUndefined();
    expect(computeChangesSince('not-a-timestamp')).toBeUndefined();
  });

  it('triggers canonical refetch on wake (focus, online, visibilitychange) even when feed returns empty, and coalesces overlapping wake bursts into one cycle', async () => {
    const h = await setupSyncHarness({ initialUnlocked: true });
    const invalidateSpy = vi.spyOn(h.qc, 'invalidateQueries');

    // Clear initial bootstrap logs
    h.requests.splice(0);
    invalidateSpy.mockClear();

    const pageGate = createDeferred<void>();
    let changesCallsDuringBurst = 0;
    h.setChangesHandler(async () => {
      changesCallsDuringBurst += 1;
      await pageGate.promise;
      return jsonResponse({
        changes: [],
        next_cursor: null,
        watermark: '2026-11-01T12:10:00.000000001Z',
      } satisfies EntryChangesPage);
    });

    // Fire focus, online, and visibilitychange -> visible in the same synchronous burst + while in flight
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Wait until the single coalesced cycle enters the feed fetch, then fire another focus while in flight
    await waitFor(() => {
      expect(changesCallsDuringBurst).toBe(1);
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    pageGate.resolve();

    await waitFor(() => {
      expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBe(
        '2026-11-01T12:10:00.000000001Z',
      );
    });

    // Overlapping wakes coalesced into exactly 1 feed request
    expect(changesCallsDuringBurst).toBe(1);

    // Canonical sources were invalidated regardless of empty feed
    const invalidatedPrefixes = invalidateSpy.mock.calls.map((call) => {
      const firstArg = call[0];
      return firstArg && typeof firstArg === 'object' && 'queryKey' in firstArg
        ? firstArg.queryKey
        : undefined;
    });
    expect(invalidatedPrefixes).toContainEqual(['content', 'entries']);
    expect(invalidatedPrefixes).toContainEqual(['content', 'item']);
    expect(invalidatedPrefixes).toContainEqual(['content', 'items']);
    expect(invalidatedPrefixes).toContainEqual(['content', 'tags']);
  });

  it('reads all feed pages before storing the new watermark, keeps old watermark on second-page error, and passes since = watermark - 120 s on the next call', async () => {
    const h = await setupSyncHarness({ initialUnlocked: true });
    const initialWatermark = '2026-11-01T12:00:00.123456789Z';
    expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBe(initialWatermark);

    // Seed cached entry metadata + decrypted body for ENTRY_ID_1 v1
    h.qc.setQueryData<EntryMetaList>(contentQueryKeys.entries(ITEM_ID), {
      items: [
        {
          id: ENTRY_ID_1,
          item_id: ITEM_ID,
          type: 'text',
          position: 0,
          version: 1,
          plaintext_len_bucket: 256,
          created_at: '2026-11-01T10:00:00Z',
          updated_at: '2026-11-01T10:00:00Z',
        },
      ],
      next_cursor: null,
    });
    h.qc.setQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1), 'v1-cached-plaintext');

    // Case 1: Page 1 returns next_cursor='cur-page-2' and new watermark, Page 2 errors (500) -> old watermark kept!
    const seenParamsCase1: Array<{ since: string | null; cursor: string | null }> = [];
    h.setChangesHandler((params) => {
      seenParamsCase1.push({
        since: params.get('since'),
        cursor: params.get('cursor'),
      });
      if (!params.get('cursor')) {
        return jsonResponse({
          changes: [
            makeEntryChange({
              id: ENTRY_ID_1,
              version: 2,
              updated_at: '2026-11-01T12:01:00Z',
            }),
          ],
          next_cursor: 'cur-page-2',
          watermark: '2026-11-01T12:20:00.000000000Z',
        } satisfies EntryChangesPage);
      }
      return problemResponse('internal_error', 500);
    });

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => {
      expect(seenParamsCase1).toHaveLength(2);
    });
    expect(seenParamsCase1[0]).toEqual({
      since: '2026-11-01T11:58:00.123456789Z',
      cursor: null,
    });
    expect(seenParamsCase1[1]).toEqual({
      since: '2026-11-01T11:58:00.123456789Z',
      cursor: 'cur-page-2',
    });
    // Because page 2 failed, the watermark MUST still be the old initialWatermark
    expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBe(initialWatermark);
    // And partial page 1 changes were not committed before all pages succeeded
    expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBe('v1-cached-plaintext');

    // Case 2: Next wake re-reads from the old watermark - 120 s and succeeds across 2 pages;
    // verify watermark is still old while page 2 is in flight, and updated only after page 2 resolves.
    const page2Gate = createDeferred<void>();
    const seenParamsCase2: Array<{ since: string | null; cursor: string | null }> = [];
    let watermarkWhilePage2InFlight: string | null = null;

    h.setChangesHandler(async (params) => {
      seenParamsCase2.push({
        since: params.get('since'),
        cursor: params.get('cursor'),
      });
      if (!params.get('cursor')) {
        return jsonResponse({
          changes: [
            makeEntryChange({
              id: ENTRY_ID_1,
              version: 2,
              updated_at: '2026-11-01T12:01:00Z',
            }),
          ],
          next_cursor: 'cur-page-2-ok',
          watermark: '2026-11-01T12:30:00.555555555Z',
        } satisfies EntryChangesPage);
      }
      watermarkWhilePage2InFlight = changesSyncTesting.getWatermarkForUser(USER_A_ID);
      await page2Gate.promise;
      return jsonResponse({
        changes: [
          makeEntryChange({
            id: ENTRY_ID_2,
            version: 1,
             deleted_at: '2026-11-01T12:02:00Z',
            updated_at: '2026-11-01T12:02:00Z',
          }),
        ],
        next_cursor: null,
        watermark: '2026-11-01T12:30:00.555555555Z',
      } satisfies EntryChangesPage);
    });

    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => {
      expect(seenParamsCase2).toHaveLength(2);
    });
    // Watermark was NOT stored before page 2 completed
    expect(watermarkWhilePage2InFlight).toBe(initialWatermark);
    // And the request used the old watermark - 120s
    expect(seenParamsCase2[0]!.since).toBe('2026-11-01T11:58:00.123456789Z');

    page2Gate.resolve();

    await waitFor(() => {
      expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBe(
        '2026-11-01T12:30:00.555555555Z',
      );
    });

    // Older v1 body for ENTRY_ID_1 was dropped, and ENTRY_ID_2 tombstone was published
    expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBeUndefined();
    expect(isEntryRemotelyDeleted(ENTRY_ID_2)).toBe(true);
  });

  it('deduplicates by (id, updated_at), applies tombstones (removes from entries cache + body keys + publishes id), drops older version body keys, and drops watermark on 410 changes_window_expired', async () => {
    const h = await setupSyncHarness({ initialUnlocked: true });

    // Unit check for dedupEntryChanges
    const changeA = makeEntryChange({ id: ENTRY_ID_1, version: 2, updated_at: '2026-11-01T12:01:00Z' });
    const changeADup = makeEntryChange({ id: ENTRY_ID_1, version: 2, updated_at: '2026-11-01T12:01:00Z' });
    const changeANewer = makeEntryChange({ id: ENTRY_ID_1, version: 3, updated_at: '2026-11-01T12:02:00Z' });
    expect(dedupEntryChanges([changeA, changeADup, changeANewer])).toEqual([changeA, changeANewer]);

    // Seed entries metadata cache with ENTRY_ID_1 (v1), ENTRY_ID_2 (v2), ENTRY_ID_3 (v5)
    h.qc.setQueryData<EntryMetaList>(contentQueryKeys.entries(ITEM_ID), {
      items: [
        {
          id: ENTRY_ID_1,
          item_id: ITEM_ID,
          type: 'text',
          position: 0,
          version: 1,
          plaintext_len_bucket: 256,
          created_at: '2026-11-01T10:00:00Z',
          updated_at: '2026-11-01T10:00:00Z',
        },
        {
          id: ENTRY_ID_2,
          item_id: ITEM_ID,
          type: 'text',
          position: 1,
          version: 2,
          plaintext_len_bucket: 256,
          created_at: '2026-11-01T10:00:00Z',
          updated_at: '2026-11-01T10:00:00Z',
        },
        {
          id: ENTRY_ID_3,
          item_id: ITEM_ID,
          type: 'text',
          position: 2,
          version: 5,
          plaintext_len_bucket: 256,
          created_at: '2026-11-01T10:00:00Z',
          updated_at: '2026-11-01T10:00:00Z',
        },
      ],
      next_cursor: null,
    });

    // Seed body keys:
    // ENTRY_ID_1 has v1 and v2 bodies (tombstone should remove ALL versions)
    // ENTRY_ID_2 has v1 and v2 bodies; feed reports v3 -> v1 and v2 removed, v3 (if already present) kept
    // ENTRY_ID_3 has v5 body; feed reports v5 (not newer) -> v5 kept
    h.qc.setQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1), 'body-1-v1');
    h.qc.setQueryData(vaultBodyQueryKey(ENTRY_ID_1, 2), 'body-1-v2');
    h.qc.setQueryData(vaultBodyQueryKey(ENTRY_ID_2, 1), 'body-2-v1');
    h.qc.setQueryData(vaultBodyQueryKey(ENTRY_ID_2, 2), 'body-2-v2');
    h.qc.setQueryData(vaultBodyQueryKey(ENTRY_ID_2, 3), 'body-2-v3-fresh');
    h.qc.setQueryData(vaultBodyQueryKey(ENTRY_ID_3, 5), 'body-3-v5');

    const tombstoneNotifications: boolean[] = [];
    const unsub = subscribeRemoteTombstones(() => {
      tombstoneNotifications.push(isEntryRemotelyDeleted(ENTRY_ID_1));
    });

    applyEntryChangesBatch(h.qc, [
      // Duplicate tombstone rows for ENTRY_ID_1
      makeEntryChange({
        id: ENTRY_ID_1,
        item_id: ITEM_ID,
        version: 2,
        updated_at: '2026-11-01T12:03:00Z',
        deleted_at: '2026-11-01T12:03:00Z',
      }),
      makeEntryChange({
        id: ENTRY_ID_1,
        item_id: ITEM_ID,
        version: 2,
        updated_at: '2026-11-01T12:03:00Z',
        deleted_at: '2026-11-01T12:03:00Z',
      }),
      // Newer version for ENTRY_ID_2 (v3 > cached v2)
      makeEntryChange({
        id: ENTRY_ID_2,
        item_id: ITEM_ID,
        version: 3,
        updated_at: '2026-11-01T12:04:00Z',
        deleted_at: null,
      }),
      // Same version for ENTRY_ID_3 (v5 == cached v5)
      makeEntryChange({
        id: ENTRY_ID_3,
        item_id: ITEM_ID,
        version: 5,
        updated_at: '2026-11-01T10:00:00Z',
        deleted_at: null,
      }),
    ]);

    unsub();

    // ENTRY_ID_1 removed from entries metadata cache, all its body keys removed, and published once to tombstone store
    const afterList = h.qc.getQueryData<EntryMetaList>(contentQueryKeys.entries(ITEM_ID));
    expect(afterList?.items.map((e) => e.id)).toEqual([ENTRY_ID_2, ENTRY_ID_3]);
    expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBeUndefined();
    expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 2))).toBeUndefined();
    expect(isEntryRemotelyDeleted(ENTRY_ID_1)).toBe(true);
    expect(tombstoneNotifications).toEqual([true]);

    // ENTRY_ID_2 older body versions (1, 2) removed; current v3 kept
    expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_2, 1))).toBeUndefined();
    expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_2, 2))).toBeUndefined();
    expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_2, 3))).toBe('body-2-v3-fresh');

    // ENTRY_ID_3 v5 untouched
    expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_3, 5))).toBe('body-3-v5');

    // Now test 410 changes_window_expired on wake: drops watermark and relies on canonical refetch
    expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).not.toBeNull();
    h.setChangesHandler(() => problemResponse('changes_window_expired', 410));

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => {
      expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBeNull();
    });
  });

  it('does not call the changes feed when the vault is locked, and writes nothing to localStorage or sessionStorage', async () => {
    const h = await setupSyncHarness({ initialUnlocked: false });

    // No bootstrap feed call while locked
    expect(h.requests.filter((r) => r.pathname === '/api/v1/entries/changes')).toHaveLength(0);

    // Trigger wake while locked -> canonical queries invalidated, reloadVaultMeta called, but 0 feed calls
    const invalidateSpy = vi.spyOn(h.qc, 'invalidateQueries');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['content', 'entries'] });
    });
    expect(h.requests.filter((r) => r.pathname === '/api/v1/entries/changes')).toHaveLength(0);

    // Unlock -> bootstrap feed call runs, still 0 keys in localStorage / sessionStorage
    await h.unlock();
    await waitFor(() => {
      expect(
        h.requests.filter((r) => r.pathname === '/api/v1/entries/changes').length,
      ).toBeGreaterThan(0);
    });

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('removes ["content","entries"] cache and clears watermark + tombstones while keeping items/tags on vault_key_id change or vault absent, and clears on logout and user switch', async () => {
    const h = await setupSyncHarness({ initialUnlocked: true });

    const populateCachesAndSyncState = () => {
      h.qc.setQueryData(contentQueryKeys.items({ sort: 'recent' }), {
        items: [makeItemSummary()],
        next_cursor: null,
      });
      h.qc.setQueryData(contentQueryKeys.item(ITEM_ID), makeItemSummary());
      h.qc.setQueryData(contentQueryKeys.tags(), {
        items: [{ id: 'tag-1', display: 'nhà', item_count: 1, created_at: '', last_used_at: '' }],
        next_cursor: null,
      });
      h.qc.setQueryData<EntryMetaList>(contentQueryKeys.entries(ITEM_ID), {
        items: [
          {
            id: ENTRY_ID_1,
            item_id: ITEM_ID,
            type: 'text',
            position: 0,
            version: 1,
            plaintext_len_bucket: 256,
            created_at: '2026-11-01T10:00:00Z',
            updated_at: '2026-11-01T10:00:00Z',
          },
        ],
        next_cursor: null,
      });
      changesSyncTesting.setWatermarkForUser(USER_A_ID, '2026-11-01T13:00:00Z');
      changesSyncTesting.publishRemoteTombstonesForTests([ENTRY_ID_2]);
    };

    // 1. vault_key_id changes on server -> wake reloads vault meta -> entries cache removed, items/tags kept, watermark + tombstones cleared
    populateCachesAndSyncState();
    expect(h.qc.getQueryData(contentQueryKeys.entries(ITEM_ID))).toBeDefined();
    expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBe('2026-11-01T13:00:00Z');
    expect(isEntryRemotelyDeleted(ENTRY_ID_2)).toBe(true);

    h.setActiveVaultKeyId(KEY_ID_2);
    await act(async () => {
      await h.vault().reloadVaultMeta();
    });

    await waitFor(() => {
      expect(h.qc.getQueryData(contentQueryKeys.entries(ITEM_ID))).toBeUndefined();
    });
    expect(h.qc.getQueryData(contentQueryKeys.items({ sort: 'recent' }))).toBeDefined();
    expect(h.qc.getQueryData(contentQueryKeys.item(ITEM_ID))).toBeDefined();
    expect(h.qc.getQueryData(contentQueryKeys.tags())).toBeDefined();
    expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBeNull();
    expect(isEntryRemotelyDeleted(ENTRY_ID_2)).toBe(false);

    // 2. Vault becomes absent (404 on reloadVaultMeta / wake) -> entries cache removed, items/tags kept, watermark + tombstones cleared
    await h.unlock();
    populateCachesAndSyncState();
    h.setActiveVaultKeyId(null);
    h.setCurrentMe(makeMe(USER_A_ID, 'absent'));

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => {
      expect(h.vault().state).toBe('no_vault');
      expect(h.qc.getQueryData(contentQueryKeys.entries(ITEM_ID))).toBeUndefined();
    });
    expect(h.qc.getQueryData(contentQueryKeys.items({ sort: 'recent' }))).toBeDefined();
    expect(h.qc.getQueryData(contentQueryKeys.item(ITEM_ID))).toBeDefined();
    expect(h.qc.getQueryData(contentQueryKeys.tags())).toBeDefined();
    expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBeNull();
    expect(isEntryRemotelyDeleted(ENTRY_ID_2)).toBe(false);

    // 3. User switch (commitAuthenticatedUser A -> B) clears watermark + tombstones immediately
    commitAuthenticatedUser(USER_A_ID);
    changesSyncTesting.setWatermarkForUser(USER_A_ID, '2026-11-01T14:00:00Z');
    changesSyncTesting.publishRemoteTombstonesForTests([ENTRY_ID_1]);
    expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBe('2026-11-01T14:00:00Z');
    expect(isEntryRemotelyDeleted(ENTRY_ID_1)).toBe(true);

    act(() => {
      commitAuthenticatedUser(USER_B_ID);
    });
    expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBeNull();
    expect(changesSyncTesting.getWatermarkForUser(USER_B_ID)).toBeNull();
    expect(isEntryRemotelyDeleted(ENTRY_ID_1)).toBe(false);

    // 4. Logout clears watermark + tombstones immediately
    changesSyncTesting.setWatermarkForUser(USER_B_ID, '2026-11-01T15:00:00Z');
    changesSyncTesting.publishRemoteTombstonesForTests([ENTRY_ID_3]);
    await h.signOutSession();
    expect(changesSyncTesting.getWatermarkForUser(USER_B_ID)).toBeNull();
    expect(isEntryRemotelyDeleted(ENTRY_ID_3)).toBe(false);
  });

  it('advisor-dec-211: keeps an open edited card (text and JSON) mounted with its draft and deletedRemotely banner when a remote tombstone removes it from the list, while an unedited card disappears, and wipes the kept-mounted card draft on lock, logout, and user switch', async () => {
    const TEXT_DRAFT_SENTINEL = 'KEPT_MOUNTED_TEXT_SECRET_DRAFT_9001';
    const JSON_DRAFT_SENTINEL = 'KEPT_MOUNTED_JSON_SECRET_DRAFT_9002';

    const textHolderRef: { current: EditorPlaintextHolder } = {
      current: {
        originalSource: '',
        draftValue: '',
        submittedCandidateSource: '',
      },
    };
    const jsonHolderRef: { current: EditorPlaintextHolder } = {
      current: {
        originalSource: '',
        draftValue: '',
        submittedCandidateSource: '',
        tableSource: '',
      },
    };
    textEntryCardTesting.setEditorPlaintextHolderForTests(textHolderRef);
    jsonTableTesting.setJsonEditorPlaintextHolderForTests(jsonHolderRef);

    const h = await setupSyncHarness({
      initialUnlocked: true,
      renderItemPage: true,
      initialEntries: [
        { id: ENTRY_ID_1, text: 'Edited text entry body', type: 'text', position: 0, version: 1 },
        { id: ENTRY_ID_2, text: 'Unedited text entry body', type: 'text', position: 1, version: 1 },
        { id: ENTRY_ID_3, text: '{"key":"initial_json"}', type: 'json', position: 2, version: 1 },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`entry-card-${ENTRY_ID_1}`)).toBeInTheDocument();
      expect(screen.getByTestId(`entry-card-${ENTRY_ID_2}`)).toBeInTheDocument();
      expect(screen.getByTestId(`entry-card-${ENTRY_ID_3}`)).toBeInTheDocument();
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_3}`)).toBeInTheDocument();
    });

    // Start editing ENTRY_ID_1 (text card) and type a secret draft
    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const textarea1 = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`) as HTMLTextAreaElement;
    fireEvent.change(textarea1, { target: { value: TEXT_DRAFT_SENTINEL } });
    expect(textHolderRef.current.draftValue).toBe(TEXT_DRAFT_SENTINEL);

    // Edit a cell in ENTRY_ID_3 (JSON card) so it is dirty
    const jsonCard = screen.getByTestId(`entry-card-${ENTRY_ID_3}`);
    fireEvent.click(within(jsonCard).getByTestId('json-cell-btn-root.p0'));
    const jsonInput = within(jsonCard).getByTestId('json-cell-input-root.p0');
    fireEvent.change(jsonInput, { target: { value: JSON_DRAFT_SENTINEL } });
    fireEvent.keyDown(jsonInput, { key: 'Enter' });
    expect(jsonHolderRef.current.tableSource).toContain(JSON_DRAFT_SENTINEL);

    // Remote device deletes ALL THREE entries (ENTRY_ID_1, ENTRY_ID_2, ENTRY_ID_3)
    h.entriesMap.get(ENTRY_ID_1)!.deleted = true;
    h.entriesMap.get(ENTRY_ID_2)!.deleted = true;
    h.entriesMap.get(ENTRY_ID_3)!.deleted = true;

    h.setChangesHandler(() =>
      jsonResponse({
        changes: [
          makeEntryChange({
            id: ENTRY_ID_1,
            item_id: ITEM_ID,
            version: 1,
            updated_at: '2026-11-01T12:10:00Z',
            deleted_at: '2026-11-01T12:10:00Z',
          }),
          makeEntryChange({
            id: ENTRY_ID_2,
            item_id: ITEM_ID,
            version: 1,
            updated_at: '2026-11-01T12:10:00Z',
            deleted_at: '2026-11-01T12:10:00Z',
          }),
          makeEntryChange({
            id: ENTRY_ID_3,
            item_id: ITEM_ID,
            type: 'json',
            version: 1,
            updated_at: '2026-11-01T12:10:00Z',
            deleted_at: '2026-11-01T12:10:00Z',
          }),
        ],
        next_cursor: null,
        watermark: '2026-11-01T12:11:00Z',
      } satisfies EntryChangesPage),
    );

    // Trigger wake -> feed + refetch remove all 3 from ['content','entries',ITEM_ID]
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => {
      // Unedited card ENTRY_ID_2 disappears
      expect(screen.queryByTestId(`entry-card-${ENTRY_ID_2}`)).toBeNull();
      // Edited cards ENTRY_ID_1 and ENTRY_ID_3 stay mounted and show their deletedRemotely banners + "Save as new entry"
      expect(screen.getByTestId(`entry-deleted-remotely-${ENTRY_ID_1}`)).toBeInTheDocument();
      expect(screen.getByTestId(`entry-save-as-new-${ENTRY_ID_1}`)).toBeEnabled();
      expect(screen.getByTestId(`entry-deleted-remotely-${ENTRY_ID_3}`)).toBeInTheDocument();
      expect(screen.getByTestId(`entry-save-as-new-${ENTRY_ID_3}`)).toBeEnabled();
    });

    // Drafts are preserved in the kept-mounted cards and no plaintext leaks into DOM attributes
    expect(textarea1.value).toBe(TEXT_DRAFT_SENTINEL);
    assertNoPlaintextAttrs(h.container, [TEXT_DRAFT_SENTINEL, JSON_DRAFT_SENTINEL]);

    // 1. Lock the vault -> kept-mounted cards MUST wipe their drafts synchronously and unmount
    await h.lock();

    expect(textHolderRef.current).toEqual({
      originalSource: '',
      draftValue: '',
      submittedCandidateSource: '',
    });
    expect(jsonHolderRef.current).toEqual({
      originalSource: '',
      draftValue: '',
      submittedCandidateSource: '',
      tableSource: '',
    });
    expect(h.container.textContent).not.toContain(TEXT_DRAFT_SENTINEL);
    expect(h.container.textContent).not.toContain(JSON_DRAFT_SENTINEL);
    await waitFor(() => {
      expect(screen.queryByTestId(`entry-card-${ENTRY_ID_1}`)).toBeNull();
      expect(screen.queryByTestId(`entry-card-${ENTRY_ID_3}`)).toBeNull();
    });

    // 2. Re-seed ENTRY_ID_1, unlock, edit, remotely delete (kept-mounted), then test explicit logout wipe
    h.entriesMap.get(ENTRY_ID_1)!.deleted = false;
    await h.unlock();
    await act(async () => {
      await h.qc.invalidateQueries({ queryKey: contentQueryKeys.entries(ITEM_ID) });
    });
    await waitFor(() => {
      expect(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const LOGOUT_DRAFT_SENTINEL = 'KEPT_MOUNTED_LOGOUT_SECRET_9003';
    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    fireEvent.change(screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`), {
      target: { value: LOGOUT_DRAFT_SENTINEL },
    });
    h.entriesMap.get(ENTRY_ID_1)!.deleted = true;
    act(() => {
      applyEntryChangesBatch(h.qc, [
        makeEntryChange({
          id: ENTRY_ID_1,
          item_id: ITEM_ID,
          version: 1,
          updated_at: '2026-11-01T12:20:00Z',
          deleted_at: '2026-11-01T12:20:00Z',
        }),
      ]);
    });
    await waitFor(() => {
      expect(screen.getByTestId(`entry-deleted-remotely-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    await h.signOutSession();
    expect(textHolderRef.current).toEqual({
      originalSource: '',
      draftValue: '',
      submittedCandidateSource: '',
    });
    expect(h.container.textContent).not.toContain(LOGOUT_DRAFT_SENTINEL);

    // 3. Re-login as User A, unlock, edit, remotely delete (kept-mounted), then switch to User B -> draft wiped
    h.entriesMap.get(ENTRY_ID_1)!.deleted = false;
    h.setCurrentMe(makeMe(USER_A_ID, 'present'));
    await h.loginSession('a@example.test', 'pw');
    await h.unlock();
    await act(async () => {
      await h.qc.invalidateQueries({ queryKey: contentQueryKeys.entries(ITEM_ID) });
    });
    await waitFor(() => {
      expect(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const SWITCH_DRAFT_SENTINEL = 'KEPT_MOUNTED_USER_SWITCH_SECRET_9004';
    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    fireEvent.change(screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`), {
      target: { value: SWITCH_DRAFT_SENTINEL },
    });
    h.entriesMap.get(ENTRY_ID_1)!.deleted = true;
    act(() => {
      applyEntryChangesBatch(h.qc, [
        makeEntryChange({
          id: ENTRY_ID_1,
          item_id: ITEM_ID,
          version: 1,
          updated_at: '2026-11-01T12:25:00Z',
          deleted_at: '2026-11-01T12:25:00Z',
        }),
      ]);
    });
    await waitFor(() => {
      expect(screen.getByTestId(`entry-deleted-remotely-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    h.setCurrentMe(makeMe(USER_B_ID, 'present'));
    await h.loginSession('b@example.test', 'pw');

    await waitFor(() => {
      expect(textHolderRef.current).toEqual({
        originalSource: '',
        draftValue: '',
        submittedCandidateSource: '',
      });
    });
    expect(h.container.textContent).not.toContain(SWITCH_DRAFT_SENTINEL);
    expect(isEntryRemotelyDeleted(ENTRY_ID_1)).toBe(false);
  });

  it('exposes useEntryRemotelyDeleted via useSyncExternalStore and updates subscribers on publish and lock', async () => {
    function Consumer({ entryId }: { readonly entryId: string }) {
      const deleted = useEntryRemotelyDeleted(entryId);
      return <output data-testid="remotely-deleted-flag">{String(deleted)}</output>;
    }

    render(<Consumer entryId={ENTRY_ID_1} />);
    expect(screen.getByTestId('remotely-deleted-flag')).toHaveTextContent('false');

    act(() => {
      changesSyncTesting.publishRemoteTombstonesForTests([ENTRY_ID_1]);
    });
    expect(screen.getByTestId('remotely-deleted-flag')).toHaveTextContent('true');

    act(() => {
      clearAllChangesSyncState();
    });
    expect(screen.getByTestId('remotely-deleted-flag')).toHaveTextContent('false');
  });
});
