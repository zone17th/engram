import type { ProblemDetails } from '@engram/shared-types';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
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
  hasActiveContentEntriesQuery,
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
import { postSessionBroadcast } from '@/lib/auth/broadcast';
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
const KEY_ID_3 = 'vk:11223344556677889900bb';
const KEY_ID_4 = 'vk:55667788990011223344dd';
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
    readonly observeEntriesQuery?: boolean;
  }

  function ActiveEntriesQueryObserver({ itemId }: { readonly itemId: string }) {
    useQuery({
      queryKey: contentQueryKeys.entries(itemId),
      queryFn: async () => {
        const res = await fetch(`/api/v1/items/${itemId}/entries`);
        return (await res.json()) as EntryMetaList;
      },
      retry: false,
    });
    return null;
  }

  async function setupSyncHarness(options: SyncHarnessOptions = {}) {
    const locale = options.locale ?? 'vi';
    const initialUnlocked = options.initialUnlocked ?? true;
    const renderItemPage = options.renderItemPage ?? false;
    const initialObserveEntries = options.observeEntriesQuery ?? true;

    let vaultCtx!: VaultContextValue;
    let signOutFn!: () => Promise<void>;
    let loginFn!: (args: { email: string; password: string }) => Promise<unknown>;
    let refetchMeFn!: () => Promise<void>;
    let sessionStatusVal = 'loading';

    function Probe() {
      vaultCtx = useVault();
      const sess = useSession();
      sessionStatusVal = sess.status;
      signOutFn = () => sess.signOut();
      loginFn = (args) => sess.login(args);
      refetchMeFn = () => sess.refetchMe();
      return (
        <>
          <output data-testid="vault-state-probe">{vaultCtx.state}</output>
          <output data-testid="session-status-probe">{sess.status}</output>
        </>
      );
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
    await waitFor(() => {
      expect(screen.getByTestId('vault-state-probe')).toHaveTextContent('locked');
      expect(screen.getByTestId('session-status-probe')).toHaveTextContent(
        'authenticated_with_vault',
      );
    });

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

    let currentObserveEntries = initialObserveEntries;
    const renderCurrentTree = () => {
      rendered.rerender(
        buildTree(
          <>
            <ContentChangesSync />
            {renderItemPage ? (
              <ItemDetailPage itemId={ITEM_ID} lazyCards={false} />
            ) : currentObserveEntries ? (
              <ActiveEntriesQueryObserver itemId={ITEM_ID} />
            ) : null}
          </>,
        ),
      );
    };

    renderCurrentTree();

    if (renderItemPage || currentObserveEntries) {
      await waitFor(() => {
        expect(hasActiveContentEntriesQuery(qc)).toBe(true);
      });
    }

    return {
      container: rendered.container,
      qc,
      vault: () => vaultCtx,
      sessionStatus: () => sessionStatusVal,
      entriesMap,
      requests: requestLog,
      setObserveEntriesQuery: async (observe: boolean) => {
        currentObserveEntries = observe;
        act(() => {
          renderCurrentTree();
        });
        await waitFor(() => {
          expect(hasActiveContentEntriesQuery(qc)).toBe(observe);
        });
      },
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

  interface WakeProbeHarness {
    readonly requests: ReadonlyArray<{ readonly pathname: string }>;
    readonly vault: () => VaultContextValue;
  }

  async function dispatchFocusWakeAndWaitForMeRefresh(
    h: WakeProbeHarness,
  ): Promise<void> {
    const meCountBefore = h.requests.filter((r) => r.pathname.endsWith('/auth/me')).length;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    if (h.vault().state === 'unlocked') {
      await waitFor(() => {
        expect(
          h.requests.filter((r) => r.pathname.endsWith('/auth/me')).length,
        ).toBeGreaterThan(meCountBefore);
        expect(h.vault().state).not.toBe('unlocking');
      });
    }
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

  it('does not call the changes feed on mount or on wake when no entries query is active, and calls the feed on wake when an entries query is active and vault unlocked (F1)', async () => {
    const h = await setupSyncHarness({
      initialUnlocked: true,
      observeEntriesQuery: false,
      renderItemPage: false,
    });

    // 1. No feed call on mount even when authenticated and vault unlocked
    expect(h.requests.filter((r) => r.pathname === '/api/v1/entries/changes')).toHaveLength(0);
    expect(hasActiveContentEntriesQuery(h.qc)).toBe(false);

    // 2. Wake while unlocked with NO active entries query (e.g. /app list, settings, unlock, onboarding)
    //    -> 0 feed calls and 0 reloadVaultMeta calls from ContentChangesSync
    h.requests.splice(0);
    await dispatchFocusWakeAndWaitForMeRefresh(h);
    expect(h.requests.filter((r) => r.pathname === '/api/v1/entries/changes')).toHaveLength(0);
    expect(h.requests.filter((r) => r.pathname.endsWith('/vault'))).toHaveLength(0);

    // 3. Mount an active ['content','entries',ITEM_ID] observer -> still no feed call on observer mount alone
    await h.setObserveEntriesQuery(true);
    expect(h.requests.filter((r) => r.pathname === '/api/v1/entries/changes')).toHaveLength(0);

    // 4. Wake while unlocked AND entries query is active -> calls the changes feed and stores watermark
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => {
      expect(h.requests.filter((r) => r.pathname === '/api/v1/entries/changes')).toHaveLength(1);
      expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBe(
        '2026-11-01T12:00:00.123456789Z',
      );
    });
  });

  it('triggers canonical refetch on wake (focus, online, visibilitychange) even when feed returns empty, coalesces synchronous wake bursts, and queues at most one trailing cycle for wakes arriving mid-cycle', async () => {
    const h = await setupSyncHarness({ initialUnlocked: true, observeEntriesQuery: true });
    const invalidateSpy = vi.spyOn(h.qc, 'invalidateQueries');

    h.requests.splice(0);
    invalidateSpy.mockClear();
    const cycle1Gate = createDeferred<void>();
    const cycle2Gate = createDeferred<void>();
    let changesCalls = 0;
    h.setChangesHandler(async () => {
      changesCalls += 1;
      if (changesCalls === 1) {
        await cycle1Gate.promise;
        return jsonResponse({
          changes: [],
          next_cursor: null,
          watermark: '2026-11-01T12:10:00.000000001Z',
        } satisfies EntryChangesPage);
      }
      await cycle2Gate.promise;
      return jsonResponse({
        changes: [],
        next_cursor: null,
        watermark: '2026-11-01T12:15:00.000000002Z',
      } satisfies EntryChangesPage);
    });

    // 1. Fire focus, online, and visibilitychange -> visible in the same synchronous burst
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Wait until the single coalesced cycle enters the feed fetch (synchronous burst coalesced to 1)
    await waitFor(() => {
      expect(changesCalls).toBe(1);
    });

    // Canonical sources were invalidated with refetchType: 'active' regardless of empty feed
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['content', 'entries'],
      refetchType: 'active',
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['content', 'item'],
      refetchType: 'active',
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['content', 'items'],
      refetchType: 'active',
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['content', 'tags'],
      refetchType: 'active',
    });

    // 2. While cycle 1 is in flight, fire a burst of 3 more wakes -> queues at most ONE trailing cycle
    invalidateSpy.mockClear();
    act(() => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Still only 1 in-flight feed call while cycle 1 is held
    expect(changesCalls).toBe(1);

    // Release cycle 1 -> watermark 1 commits and the single trailing cycle (cycle 2) starts automatically
    cycle1Gate.resolve();
    await waitFor(() => {
      expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBe(
        '2026-11-01T12:10:00.000000001Z',
      );
      expect(changesCalls).toBe(2);
    });

    // Trailing cycle also refetches canonical sources
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['content', 'entries'],
      refetchType: 'active',
    });

    cycle2Gate.resolve();
    await waitFor(() => {
      expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBe(
        '2026-11-01T12:15:00.000000002Z',
      );
    });
    // No 3rd cycle ran from the burst of 3 mid-cycle wakes
    expect(changesCalls).toBe(2);
  });

  it('reads all feed pages before storing the new watermark, keeps old watermark on second-page error, and passes since = watermark - 120 s on the next call', async () => {
    const h = await setupSyncHarness({ initialUnlocked: true, observeEntriesQuery: true });
    const initialWatermark = '2026-11-01T12:00:00.123456789Z';

    // Bootstrap initial watermark via first wake on the open item page
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => {
      expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBe(initialWatermark);
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

    // Dispatch 'online' wake so VaultProvider.verifyOnWake (which listens to focus/visibilitychange/pageshow/resume/popstate
    // and synchronously purges ['vault', 'body']) does not wipe the body key before the feed cycle runs (G1).
    await act(async () => {
      window.dispatchEvent(new Event('online'));
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

  it('preserves the old watermark and applies no partial batch when MAX_CHANGES_PAGES_PER_CYCLE is exhausted with next_cursor pending, and commits normally when the terminal page lands exactly at the cap', async () => {
    const h = await setupSyncHarness({ initialUnlocked: true, observeEntriesQuery: true });
    const initialWatermark = '2026-11-01T12:00:00.123456789Z';
    changesSyncTesting.setWatermarkForUser(USER_A_ID, initialWatermark);
    changesSyncTesting.setMaxChangesPagesPerCycleForTests(3);

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
    h.qc.setQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1), 'cap-test-v1-body');

    // 1. Cap reached (3 pages) with next_cursor still non-null on the 3rd page -> old watermark kept, no cache/store mutations
    let capExhaustedCalls = 0;
    h.setChangesHandler(() => {
      capExhaustedCalls += 1;
      return jsonResponse({
        changes: [
          makeEntryChange({
            id: ENTRY_ID_1,
            version: 2,
            updated_at: `2026-11-01T12:0${capExhaustedCalls}:00Z`,
          }),
          makeEntryChange({
            id: ENTRY_ID_2,
            version: 1,
            deleted_at: `2026-11-01T12:0${capExhaustedCalls}:00Z`,
            updated_at: `2026-11-01T12:0${capExhaustedCalls}:00Z`,
          }),
        ],
        next_cursor: `cursor-after-page-${capExhaustedCalls}`,
        watermark: '2026-11-01T12:40:00.000000000Z',
      } satisfies EntryChangesPage);
    });

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => {
      expect(capExhaustedCalls).toBe(3);
    });
    expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBe(initialWatermark);
    expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBe('cap-test-v1-body');
    expect(isEntryRemotelyDeleted(ENTRY_ID_2)).toBe(false);

    // 2. Terminal page (next_cursor: null) reached on the exact 3rd page (at the cap) -> commits watermark & batch normally
    let exactCapCalls = 0;
    h.setChangesHandler(() => {
      exactCapCalls += 1;
      const isLastAllowedPage = exactCapCalls === 3;
      return jsonResponse({
        changes: [
          makeEntryChange({
            id: isLastAllowedPage ? ENTRY_ID_2 : ENTRY_ID_1,
            version: isLastAllowedPage ? 1 : 2,
            deleted_at: isLastAllowedPage ? '2026-11-01T12:03:00Z' : null,
            updated_at: `2026-11-01T12:0${exactCapCalls}:00Z`,
          }),
        ],
        next_cursor: isLastAllowedPage ? null : `cursor-exact-${exactCapCalls}`,
        watermark: '2026-11-01T12:45:00.999999999Z',
      } satisfies EntryChangesPage);
    });

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => {
      expect(exactCapCalls).toBe(3);
      expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBe(
        '2026-11-01T12:45:00.999999999Z',
      );
    });
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


    // Delete -> restore in one accumulated batch follows the LAST observation in (updated_at, id) order:
    // [tombstone(E, t1), live(E, t2)] -> isEntryRemotelyDeleted(E) === false (also clears a previously published tombstone)
    expect(isEntryRemotelyDeleted(ENTRY_ID_1)).toBe(true);
    applyEntryChangesBatch(h.qc, [
      makeEntryChange({
        id: ENTRY_ID_1,
        item_id: ITEM_ID,
        version: 3,
        updated_at: '2026-11-01T12:05:00Z',
        deleted_at: '2026-11-01T12:05:00Z',
      }),
      makeEntryChange({
        id: ENTRY_ID_1,
        item_id: ITEM_ID,
        version: 4,
        updated_at: '2026-11-01T12:06:00Z',
        deleted_at: null,
      }),
    ]);
    expect(isEntryRemotelyDeleted(ENTRY_ID_1)).toBe(false);

    // Reverse order [live(E, t1), tombstone(E, t2)] -> later tombstone wins (isEntryRemotelyDeleted(E) === true)
    applyEntryChangesBatch(h.qc, [
      makeEntryChange({
        id: ENTRY_ID_1,
        item_id: ITEM_ID,
        version: 4,
        updated_at: '2026-11-01T12:06:00Z',
        deleted_at: null,
      }),
      makeEntryChange({
        id: ENTRY_ID_1,
        item_id: ITEM_ID,
        version: 5,
        updated_at: '2026-11-01T12:07:00Z',
        deleted_at: '2026-11-01T12:07:00Z',
      }),
    ]);
    expect(isEntryRemotelyDeleted(ENTRY_ID_1)).toBe(true);
    // Now test 410 changes_window_expired on wake: asserts the 410 request happened with since = watermark - 120s,
    // drops the watermark to null, and the next wake bootstraps with no `since` parameter (T3c / FER1-5c).
    changesSyncTesting.setWatermarkForUser(USER_A_ID, '2026-11-01T12:00:00.123456789Z');
    expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).not.toBeNull();
    const seen410SinceParams: Array<string | null> = [];
    h.setChangesHandler((params) => {
      seen410SinceParams.push(params.get('since'));
      return problemResponse('changes_window_expired', 410);
    });

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => {
      expect(seen410SinceParams).toEqual(['2026-11-01T11:58:00.123456789Z']);
      expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBeNull();
    });

    const seenBootstrapSinceParams: Array<string | null> = [];
    h.setChangesHandler((params) => {
      seenBootstrapSinceParams.push(params.get('since'));
      return jsonResponse({
        changes: [],
        next_cursor: null,
        watermark: '2026-11-01T12:30:00.000000000Z',
      } satisfies EntryChangesPage);
    });

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => {
      expect(seenBootstrapSinceParams).toEqual([null]);
      expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBe(
        '2026-11-01T12:30:00.000000000Z',
      );
    });
  });

  it('does not call the changes feed when the vault is locked, and writes no changes-sync state to localStorage or sessionStorage', async () => {
    const h = await setupSyncHarness({ initialUnlocked: false, observeEntriesQuery: true });

    // Clear the sabk.vault.lockEpoch wake notification written by lockNow() in harness setup
    window.localStorage.clear();
    window.sessionStorage.clear();

    // No feed call on mount while locked
    expect(h.requests.filter((r) => r.pathname === '/api/v1/entries/changes')).toHaveLength(0);

    // Trigger wake while locked -> active canonical queries invalidated, but 0 feed calls and 0 reloadVaultMeta calls
    const invalidateSpy = vi.spyOn(h.qc, 'invalidateQueries');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['content', 'entries'],
        refetchType: 'active',
      });
    });
    expect(h.requests.filter((r) => r.pathname === '/api/v1/entries/changes')).toHaveLength(0);
    expect(h.requests.filter((r) => r.pathname.endsWith('/vault'))).toHaveLength(0);

    // Unlock and trigger wake -> feed call runs, still 0 keys in localStorage / sessionStorage
    await h.unlock();
    expect(h.requests.filter((r) => r.pathname === '/api/v1/entries/changes')).toHaveLength(0);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => {
      expect(
        h.requests.filter((r) => r.pathname === '/api/v1/entries/changes').length,
      ).toBeGreaterThan(0);
    });

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('fences in-flight feed cycles across lock -> re-unlock so a stale pre-lock response cannot mutate caches, tombstones, or watermark', async () => {
    const h = await setupSyncHarness({ initialUnlocked: true, observeEntriesQuery: true });
    const initialWatermark = '2026-11-01T12:00:00.123456789Z';
    changesSyncTesting.setWatermarkForUser(USER_A_ID, initialWatermark);

    const heldFeedPage = createDeferred<Response>();
    let feedRequestStarted = false;
    h.setChangesHandler(() => {
      feedRequestStarted = true;
      return heldFeedPage.promise;
    });

    // Start a wake cycle and hold its feed page in flight
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => {
      expect(feedRequestStarted).toBe(true);
    });

    // Lock and re-unlock the same user/vault while the pre-lock feed page is still pending
    await h.lock();
    await h.unlock();

    // Repopulate live metadata and decrypted body in the new unlock interval
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
    h.qc.setQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1), 'fresh-reunlocked-body');

    // Release the stale pre-lock feed page with a tombstone for ENTRY_ID_1 and a newer watermark
    await act(async () => {
      heldFeedPage.resolve(
        jsonResponse({
          changes: [
            makeEntryChange({
              id: ENTRY_ID_1,
              item_id: ITEM_ID,
              version: 2,
              updated_at: '2026-11-01T12:05:00Z',
              deleted_at: '2026-11-01T12:05:00Z',
            }),
          ],
          next_cursor: null,
          watermark: '2026-11-01T12:50:00.000000000Z',
        } satisfies EntryChangesPage),
      );
      await Promise.resolve();
    });

    // The stale pre-lock cycle MUST NOT evict the new unlock interval's metadata/body, publish tombstones, or advance watermark
    expect(
      h.qc.getQueryData<EntryMetaList>(contentQueryKeys.entries(ITEM_ID))?.items.map((e) => e.id),
    ).toEqual([ENTRY_ID_1]);
    expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBe('fresh-reunlocked-body');
    expect(isEntryRemotelyDeleted(ENTRY_ID_1)).toBe(false);
    expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBe(initialWatermark);
  });

  it('fences wake reloadVaultMeta() continuation so a delayed foreign-session null from User A does not purge User B caches or sync state', async () => {
    const h = await setupSyncHarness({ initialUnlocked: true, observeEntriesQuery: true });

    const heldUserAVaultGet = createDeferred<Response>();
    let userAVaultGetIntercepted = false;
    h.overrideRoute((url, init) => {
      const parsed = new URL(url, 'http://localhost');
      const method = (init?.method ?? 'GET').toUpperCase();
      if (parsed.pathname.endsWith('/vault') && method === 'GET' && !userAVaultGetIntercepted) {
        userAVaultGetIntercepted = true;
        return heldUserAVaultGet.promise;
      }
      return null;
    });

    // Trigger wake for User A so reloadVaultMeta() issues GET /vault and blocks on heldUserAVaultGet
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => {
      expect(userAVaultGetIntercepted).toBe(true);
    });

    // Switch session to User B and unlock User B's vault
    h.overrideRoute(null);
    h.setCurrentMe(makeMe(USER_B_ID, 'present'));
    await h.loginSession('b@example.test', 'pw');
    await waitFor(() => {
      expect(h.sessionStatus()).toBe('authenticated_with_vault');
    });
    await h.unlock();

    // Seed User B's entries metadata, decrypted body, watermark, and tombstone state
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
    h.qc.setQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1), 'user-b-decrypted-body');
    changesSyncTesting.setWatermarkForUser(USER_B_ID, '2026-11-01T16:00:00Z');
    changesSyncTesting.publishRemoteTombstonesForTests([ENTRY_ID_2]);

    // Release User A's stale GET /vault response (VaultProvider returns null because the response is foreign to User B)
    await act(async () => {
      heldUserAVaultGet.resolve(problemResponse('vault_absent', 404));
      await Promise.resolve();
    });

    // User B's entries cache, decrypted body, watermark, and tombstones MUST remain untouched
    expect(
      h.qc.getQueryData<EntryMetaList>(contentQueryKeys.entries(ITEM_ID))?.items.map((e) => e.id),
    ).toEqual([ENTRY_ID_1]);
    expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBe('user-b-decrypted-body');
    expect(changesSyncTesting.getWatermarkForUser(USER_B_ID)).toBe('2026-11-01T16:00:00Z');
    expect(isEntryRemotelyDeleted(ENTRY_ID_2)).toBe(true);
  });

  interface ResetTestHarness {
    readonly qc: QueryClient;
  }

  function seedResetCachesAndSyncState(h: ResetTestHarness, userId = USER_A_ID) {
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
    h.qc.setQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1), 'stale-plaintext-before-reset');
    changesSyncTesting.setWatermarkForUser(userId, '2026-11-01T13:00:00Z');
    changesSyncTesting.publishRemoteTombstonesForTests([ENTRY_ID_2]);
  }

  function assertItemsAndTagsKeptAndSyncStateCleared(h: ResetTestHarness, userId = USER_A_ID) {
    expect(h.qc.getQueryData(contentQueryKeys.items({ sort: 'recent' }))).toBeDefined();
    expect(h.qc.getQueryData(contentQueryKeys.item(ITEM_ID))).toBeDefined();
    expect(h.qc.getQueryData(contentQueryKeys.tags())).toBeDefined();
    expect(changesSyncTesting.getWatermarkForUser(userId)).toBeNull();
    expect(isEntryRemotelyDeleted(ENTRY_ID_2)).toBe(false);
  }

  it('T1a: purges ["content","entries"] and ["vault","body"] to undefined and clears watermark + tombstones while keeping items/tags on vault_key_id change with an inactive observer', async () => {
    const h = await setupSyncHarness({ initialUnlocked: true, observeEntriesQuery: false });
    seedResetCachesAndSyncState(h);
    expect(h.qc.getQueryData(contentQueryKeys.entries(ITEM_ID))).toBeDefined();
    expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBe('2026-11-01T13:00:00Z');
    expect(isEntryRemotelyDeleted(ENTRY_ID_2)).toBe(true);

    h.setActiveVaultKeyId(KEY_ID_2);
    await act(async () => {
      await h.vault().reloadVaultMeta();
    });

    await waitFor(() => {
      expect(h.qc.getQueryData(contentQueryKeys.entries(ITEM_ID))).toBeUndefined();
      expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBeUndefined();
    });
    assertItemsAndTagsKeptAndSyncStateCleared(h);
  });

  it('T1b: proves ["content","entries"] and ["vault","body"] are purged BEFORE the canonical entries refetch resolves on vault_key_id change with an active observer (FER1-3b)', async () => {
    const h = await setupSyncHarness({
      initialUnlocked: true,
      observeEntriesQuery: true,
      initialEntries: [{ id: ENTRY_ID_1, text: 'stale-plaintext-before-reset', version: 1 }],
    });
    seedResetCachesAndSyncState(h);
    expect(
      h.qc.getQueryData<EntryMetaList>(contentQueryKeys.entries(ITEM_ID))?.items.map((e) => e.id),
    ).toEqual([ENTRY_ID_1]);

    // Hold the canonical GET /api/v1/items/{id}/entries refetch so we can observe the cache state
    // after reloadVaultMeta() detects the key change but BEFORE the entries refetch resolves.
    const heldEntriesRefetch = createDeferred<Response>();
    let entriesRefetchIntercepted = false;
    h.overrideRoute((url, init) => {
      const parsed = new URL(url, 'http://localhost');
      const method = (init?.method ?? 'GET').toUpperCase();
      if (parsed.pathname === `/api/v1/items/${ITEM_ID}/entries` && method === 'GET') {
        entriesRefetchIntercepted = true;
        return heldEntriesRefetch.promise;
      }
      return null;
    });

    h.setActiveVaultKeyId(KEY_ID_2);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    // While the entries refetch is still held in flight, reloadVaultMeta() has resolved with KEY_ID_2
    // and purgeEntriesCacheOnVaultReset MUST have already evicted the old ENTRY_ID_1 metadata and body.
    await waitFor(() => {
      expect(entriesRefetchIntercepted).toBe(true);
      expect(h.qc.getQueryData(contentQueryKeys.entries(ITEM_ID))).toBeUndefined();
      expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBeUndefined();
      expect(h.qc.getQueryCache().findAll({ queryKey: ['vault', 'body'] })).toHaveLength(0);
    });
    assertItemsAndTagsKeptAndSyncStateCleared(h);

    // Release the held refetch -> settles cleanly
    h.entriesMap.delete(ENTRY_ID_1);
    await act(async () => {
      heldEntriesRefetch.resolve(jsonResponse({ items: [], next_cursor: null }));
    });
    await waitFor(() => {
      expect(
        h.qc.getQueryData<EntryMetaList>(contentQueryKeys.entries(ITEM_ID))?.items ?? [],
      ).toEqual([]);
    });
  });

  it('T1c: purges ["content","entries"] and ["vault","body"] to undefined and clears watermark + tombstones while keeping items/tags when vault becomes absent (404) with an inactive observer', async () => {
    const h = await setupSyncHarness({ initialUnlocked: true, observeEntriesQuery: false });
    seedResetCachesAndSyncState(h);
    h.setActiveVaultKeyId(null);

    await act(async () => {
      await h.vault().reloadVaultMeta();
    });

    await waitFor(() => {
      expect(h.qc.getQueryData(contentQueryKeys.entries(ITEM_ID))).toBeUndefined();
      expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBeUndefined();
    });
    assertItemsAndTagsKeptAndSyncStateCleared(h);
  });

  it('T1d: purges ["content","entries"] and ["vault","body"] with 0 body queries and no stale DOM plaintext when vault becomes absent on a focus wake with an active item page', async () => {
    const STALE_DOM_SENTINEL = 'STALE_PLAINTEXT_BEFORE_ABSENT_WAKE_9101';
    const h = await setupSyncHarness({
      initialUnlocked: true,
      renderItemPage: true,
      initialEntries: [{ id: ENTRY_ID_1, text: STALE_DOM_SENTINEL, type: 'text', version: 1 }],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`entry-card-${ENTRY_ID_1}`)).toBeInTheDocument();
      expect(document.body.textContent ?? '').toContain(STALE_DOM_SENTINEL);
    });

    seedResetCachesAndSyncState(h);
    expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBe('2026-11-01T13:00:00Z');

    // Hold the canonical entries refetch during the focus wake so we prove the purge clears ENTRY_ID_1
    // metadata before the empty server response arrives, then release to verify final convergence.
    const heldEntriesRefetch = createDeferred<Response>();
    let entriesRefetchIntercepted = false;
    h.overrideRoute((url, init) => {
      const parsed = new URL(url, 'http://localhost');
      const method = (init?.method ?? 'GET').toUpperCase();
      if (parsed.pathname === `/api/v1/items/${ITEM_ID}/entries` && method === 'GET') {
        entriesRefetchIntercepted = true;
        return heldEntriesRefetch.promise;
      }
      return null;
    });

    h.setActiveVaultKeyId(null);
    h.setCurrentMe(makeMe(USER_A_ID, 'absent'));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => {
      expect(['locked', 'no_vault']).toContain(h.vault().state);
      expect(entriesRefetchIntercepted).toBe(true);
      expect(h.qc.getQueryData(contentQueryKeys.entries(ITEM_ID))).toBeUndefined();
      expect(h.qc.getQueryCache().findAll({ queryKey: ['vault', 'body'] })).toHaveLength(0);
      expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBeUndefined();
      expect(document.body.textContent ?? '').not.toContain(STALE_DOM_SENTINEL);
    });
    assertItemsAndTagsKeptAndSyncStateCleared(h);

    h.entriesMap.delete(ENTRY_ID_1);
    await act(async () => {
      heldEntriesRefetch.resolve(jsonResponse({ items: [], next_cursor: null }));
    });
    await waitFor(() => {
      expect(
        h.qc.getQueryData<EntryMetaList>(contentQueryKeys.entries(ITEM_ID))?.items ?? [],
      ).toEqual([]);
    });
  });

  it('T1e: purges ["content","entries"] and ["vault","body"] when a fresh replacement vault key appears after an intermediate null/absent transition', async () => {
    const h = await setupSyncHarness({ initialUnlocked: true, observeEntriesQuery: false });

    // Transition KEY_ID_1 -> null (absent)
    h.setActiveVaultKeyId(null);
    h.setCurrentMe(makeMe(USER_A_ID, 'absent'));
    await act(async () => {
      await h.vault().reloadVaultMeta();
    });
    await h.refetchMeSession();

    // Re-seed stale cache while vaultMeta is null, then install fresh replacement KEY_ID_2 (null -> KEY_ID_2)
    seedResetCachesAndSyncState(h);
    expect(h.qc.getQueryData(contentQueryKeys.entries(ITEM_ID))).toBeDefined();

    h.setCurrentMe(makeMe(USER_A_ID, 'present'));
    h.setActiveVaultKeyId(KEY_ID_2);
    await h.refetchMeSession();
    await act(async () => {
      await h.vault().reloadVaultMeta();
    });

    await waitFor(() => {
      expect(h.qc.getQueryData(contentQueryKeys.entries(ITEM_ID))).toBeUndefined();
      expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBeUndefined();
    });
    assertItemsAndTagsKeptAndSyncStateCleared(h);
  });

  it('T1f: clears watermark and remote tombstones immediately on user switch', async () => {
    await setupSyncHarness({ initialUnlocked: true, observeEntriesQuery: false });

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
  });

  it('T1g: clears watermark and remote tombstones immediately on logout', async () => {
    const h = await setupSyncHarness({ initialUnlocked: true, observeEntriesQuery: false });

    changesSyncTesting.setWatermarkForUser(USER_A_ID, '2026-11-01T15:00:00Z');
    changesSyncTesting.publishRemoteTombstonesForTests([ENTRY_ID_3]);
    expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBe('2026-11-01T15:00:00Z');
    expect(isEntryRemotelyDeleted(ENTRY_ID_3)).toBe(true);

    await h.signOutSession();
    expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBeNull();
    expect(isEntryRemotelyDeleted(ENTRY_ID_3)).toBe(false);
  });

  it('T2: preserves remembered vault_key_id across observed transient loading/unavailable session states so recovery with a replacement key purges seeded entries and bodies (FER1-4 / BER1-6)', async () => {
    const h = await setupSyncHarness({ initialUnlocked: true, observeEntriesQuery: false });

    // Establish KEY_ID_3 as the current live key, then transition to null/absent so vaultMeta is null
    // and the ONLY record of KEY_ID_3 is lastSeenVaultByUserRef.current.lastNonNullVaultKeyId.
    h.setActiveVaultKeyId(KEY_ID_3);
    await act(async () => {
      await h.vault().reloadVaultMeta();
    });
    h.setActiveVaultKeyId(null);
    await act(async () => {
      await h.vault().reloadVaultMeta();
    });
    expect(h.vault().vaultMeta).toBeNull();

    // 1. Hold /auth/me response and trigger a remote session_changed broadcast -> sessionEpoch increments
    //    with no cached me data for the new epoch, driving sessionStatus to 'loading'.
    const heldLoadingMe = createDeferred<Response>();
    h.overrideRoute((url) => {
      const parsed = new URL(url, 'http://localhost');
      if (parsed.pathname.endsWith('/auth/me')) {
        return heldLoadingMe.promise;
      }
      return null;
    });

    await act(async () => {
      postSessionBroadcast({ type: 'session_changed' });
      // Clear the carried me cache for the new epoch so meQuery is in loading state
      h.qc.removeQueries({ queryKey: ['auth', 'me'] });
      void h.refetchMeSession();
    });

    // Deterministically observe sessionStatus === 'loading' while /auth/me is held
    await waitFor(() => {
      expect(h.sessionStatus()).toBe('loading');
      expect(screen.getByTestId('session-status-probe')).toHaveTextContent('loading');
    });

    // Resolve with a 500 error so meQuery enters isError and sessionStatus is observed as 'unavailable'
    await act(async () => {
      heldLoadingMe.resolve(problemResponse('internal_error', 500));
    });
    await waitFor(() => {
      expect(h.sessionStatus()).toBe('unavailable');
      expect(screen.getByTestId('session-status-probe')).toHaveTextContent('unavailable');
    });
    // 2. Recover with the same user (USER_A_ID) and a brand-new replacement vault key KEY_ID_4 while entries/bodies are seeded.
    //    If the f4beb96 preservation branch were reverted (clearing lastSeenVaultByUserRef on non-authenticated status),
    //    recovery would enter the first-observation (!prev) branch with serverVaultStatus === 'present' and FAIL to purge.
    h.overrideRoute(null);
    h.setCurrentMe(makeMe(USER_A_ID, 'present'));
    h.setActiveVaultKeyId(KEY_ID_4);
    seedResetCachesAndSyncState(h);
    expect(h.qc.getQueryData(contentQueryKeys.entries(ITEM_ID))).toBeDefined();
    expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBe(
      'stale-plaintext-before-reset',
    );

    await h.refetchMeSession();
    await waitFor(() => {
      expect(h.sessionStatus()).toBe('authenticated_with_vault');
    });
    await act(async () => {
      await h.vault().reloadVaultMeta();
    });

    await waitFor(() => {
      expect(h.qc.getQueryData(contentQueryKeys.entries(ITEM_ID))).toBeUndefined();
      expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBeUndefined();
    });
    assertItemsAndTagsKeptAndSyncStateCleared(h);
  });

  it('T3a/T3b: clears the remote-tombstone store on a real vault lock (lockNow) while preserving ["content","entries"] metadata and the feed watermark across a plain lock and re-unlock (FER1-5a,b)', async () => {
    const h = await setupSyncHarness({ initialUnlocked: true, observeEntriesQuery: false });

    function TombstoneProbe({ entryId }: { readonly entryId: string }) {
      const deleted = useEntryRemotelyDeleted(entryId);
      return <output data-testid="lock-tombstone-probe">{String(deleted)}</output>;
    }
    const probeView = render(<TombstoneProbe entryId={ENTRY_ID_1} />);
    expect(screen.getByTestId('lock-tombstone-probe')).toHaveTextContent('false');

    // Seed ['content','entries'] metadata, watermark, and a published remote tombstone
    seedResetCachesAndSyncState(h);
    act(() => {
      changesSyncTesting.publishRemoteTombstonesForTests([ENTRY_ID_1]);
    });
    expect(screen.getByTestId('lock-tombstone-probe')).toHaveTextContent('true');
    expect(isEntryRemotelyDeleted(ENTRY_ID_1)).toBe(true);
    expect(
      h.qc.getQueryData<EntryMetaList>(contentQueryKeys.entries(ITEM_ID))?.items.map((e) => e.id),
    ).toEqual([ENTRY_ID_1]);
    expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBe('2026-11-01T13:00:00Z');

    // Trigger a real vault lock via lockNow() (NOT clearAllChangesSyncState directly)
    await h.lock();

    // T3a: real lock clears the remote-tombstone store and updates useEntryRemotelyDeleted subscribers,
    //      and decrypted body cache is cleared by P03 lock.
    await waitFor(() => {
      expect(isEntryRemotelyDeleted(ENTRY_ID_1)).toBe(false);
      expect(isEntryRemotelyDeleted(ENTRY_ID_2)).toBe(false);
      expect(screen.getByTestId('lock-tombstone-probe')).toHaveTextContent('false');
    });
    expect(h.qc.getQueryData(vaultBodyQueryKey(ENTRY_ID_1, 1))).toBeUndefined();

    // T3b: a plain lock does NOT purge ['content','entries'] metadata or drop the user's watermark,
    //      and re-unlocking the same vault key preserves them too.
    expect(
      h.qc.getQueryData<EntryMetaList>(contentQueryKeys.entries(ITEM_ID))?.items.map((e) => e.id),
    ).toEqual([ENTRY_ID_1]);
    expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBe('2026-11-01T13:00:00Z');

    await h.unlock();
    expect(
      h.qc.getQueryData<EntryMetaList>(contentQueryKeys.entries(ITEM_ID))?.items.map((e) => e.id),
    ).toEqual([ENTRY_ID_1]);
    expect(changesSyncTesting.getWatermarkForUser(USER_A_ID)).toBe('2026-11-01T13:00:00Z');

    probeView.unmount();
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

    // Remote device deletes ALL THREE entries (ENTRY_ID_1, ENTRY_ID_2, ENTRY_ID_3).
    // Wait for VaultProvider.verifyOnWake to restore unlocked state before inspecting cards.
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

    // Trigger reconnect wake ('online') -> ContentChangesSync runs feed + canonical refetch while
    // keeping the open tab's active editors intact so advisor-dec-211 keeps dirty cards mounted.
    await act(async () => {
      window.dispatchEvent(new Event('online'));
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

  it('exposes useEntryRemotelyDeleted via useSyncExternalStore and updates subscribers on publish and clearAllChangesSyncState', async () => {
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
