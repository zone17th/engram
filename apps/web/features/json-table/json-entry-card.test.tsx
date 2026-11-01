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
import * as entriesModule from '@/features/entries';
import {
  assertVaultSecretElementAttributes,
  clearAllUnconfirmedSaves,
  resetEntryBodyLoadLimiterForTests,
  type EditorPlaintextHolder,
} from '@/features/entries';
import { assertNoPlaintextAttrs } from '@/features/entries/test-utils/assert-no-plaintext-attrs';
import { ItemDetailPage } from '@/features/items/item-detail-page';
import { JsonEntryCard } from '@/features/json-table';
import {
  VAULT_BODY_QUERY_KEY_PREFIX,
  VaultProvider,
  resetVaultBroadcastForTests,
  useVault,
  type LockEpochEnvironment,
  type VaultContextValue,
} from '@/features/vault';
import type { Me } from '@/lib/api/auth';
import type {
  Entry,
  EntryCreateRequest,
  EntryMeta,
  EntryUpdateRequest,
  ItemSummary,
  Tag,
} from '@/lib/api/content';
import type { CreateVaultResult } from '@/lib/crypto/client';
import { KEK_BYTES, type DeriveKekFn, type ValidatedKdfParams } from '@/lib/crypto/kdf';
import type { Sodium } from '@/lib/crypto/sodium';
import { createWorkerShim } from '@/lib/crypto/test/worker-shim';
import { areNonWhitespaceTokensIdentical, parseJsonStrict } from '@/lib/json';
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

const PASSPHRASE = 'task16-json-card-passphrase-1';
const KEY_ID = 'vk:7f3a91c4e0b2d8a1f5c309';
const ITEM_ID = '11111111-1111-4111-8111-111111111111';
const ENTRY_ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENTRY_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_A_ID = '33333333-3333-4333-8333-333333333333';

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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
  let marker = { epochIncarnation: 'inc-task16-1', lockEpoch: 1 };
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

function makeItemSummary(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: ITEM_ID,
    name: 'postgres-prod',
    hint: 'production db config',
    tags: [{ id: 'tag-1', display: 'db' }],
    entry_count: 1,
    version: 1,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    last_used_at: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

function findCacheSentinelLeaks(
  qc: QueryClient,
  sentinels: readonly string[],
): string[] {
  const leaks: string[] = [];

  for (const query of qc.getQueryCache().getAll()) {
    const isPermittedVaultBodyCache =
      Array.isArray(query.queryKey) &&
      query.queryKey[0] === VAULT_BODY_QUERY_KEY_PREFIX[0] &&
      query.queryKey[1] === VAULT_BODY_QUERY_KEY_PREFIX[1];
    const serializedKey = JSON.stringify(query.queryKey);
    const serializedData = JSON.stringify(query.state.data ?? null);
    for (const sentinel of sentinels) {
      if (serializedKey.includes(sentinel)) {
        leaks.push(`QueryCache key ${serializedKey} contains ${sentinel}`);
      }
      if (!isPermittedVaultBodyCache && serializedData.includes(sentinel)) {
        leaks.push(`QueryCache data for ${serializedKey} contains ${sentinel}`);
      }
    }
  }

  for (const mutation of qc.getMutationCache().getAll()) {
    const state = mutation.state;
    const fields: ReadonlyArray<readonly [string, unknown]> = [
      ['variables', state.variables],
      ['data', state.data],
      ['context', state.context],
      ['error', state.error],
    ];
    for (const [name, val] of fields) {
      const serialized = JSON.stringify(val ?? null);
      for (const sentinel of sentinels) {
        if (serialized.includes(sentinel)) {
          leaks.push(`MutationCache ${name} contains ${sentinel}`);
        }
      }
    }
  }

  return leaks;
}

describe('P04-T16 JSON card U13 (table / raw / edit, lossless byte splice, ARIA treegrid, security invariants)', () => {
  const shims: Array<{ close: () => void }> = [];

  beforeEach(() => {
    document.cookie = 'sabk_csrf=test-csrf-token';
    routerMocks.push.mockReset();
    routerMocks.replace.mockReset();
    routerMocks.redirect.mockClear();
    resetVaultBroadcastForTests();
    resetEntryBodyLoadLimiterForTests();
    clearAllUnconfirmedSaves();
  });

  afterEach(() => {
    cleanup();
    for (const shim of shims.splice(0)) shim.close();
    resetVaultBroadcastForTests();
    resetEntryBodyLoadLimiterForTests();
    clearAllUnconfirmedSaves();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  interface ServerSimulator {
    item: ItemSummary;
    entries: Map<string, Entry & { deleted?: boolean; deletedPosition?: number }>;
    catalogTags: Tag[];
    requests: Array<{
      method: string;
      url: string;
      headers: Record<string, string>;
      rawBody: string;
    }>;
    sealJsonForEntry: (
      entryId: string,
      plaintext: string,
      version?: number,
      position?: number,
    ) => Promise<Entry>;
    openServerEntryPlaintext: (entryId: string) => Promise<string>;
    overrideRoute: (
      handler: ((url: string, init?: RequestInit) => Promise<Response | null> | Response | null) | null,
    ) => void;
  }

  interface Harness {
    container: HTMLElement;
    qc: QueryClient;
    vault: () => VaultContextValue;
    server: ServerSimulator;
    unlock: () => Promise<void>;
    lock: () => Promise<void>;
    rerenderPage: (node?: ReactNode) => void;
  }

  async function setupJsonCardHarness(options?: {
    locale?: 'en' | 'vi';
    initialItem?: ItemSummary;
    initialEntries?: Array<{
      id: string;
      text: string;
      type?: 'json' | 'text';
      position?: number;
      version?: number;
    }>;
    lazyCards?: boolean;
    skipInitialReloadVaultMeta?: boolean;
  }): Promise<Harness> {
    const locale = options?.locale ?? 'vi';
    const lazyCards = options?.lazyCards ?? false;
    let vaultCtx!: VaultContextValue;
    function Probe() {
      vaultCtx = useVault();
      useSession();
      return <output data-testid="vault-state-probe">{vaultCtx.state}</output>;
    }

    let createdVault: CreateVaultResult | null = null;
    const currentMe = makeMe(USER_A_ID, 'present');
    let routeOverride:
      | ((url: string, init?: RequestInit) => Promise<Response | null> | Response | null)
      | null = null;

    const serverItem: ItemSummary = options?.initialItem ?? makeItemSummary();
    const entriesMap = new Map<string, Entry & { deleted?: boolean; deletedPosition?: number }>();
    const catalogTags: Tag[] = [
      {
        id: 'tag-1',
        display: 'db',
        item_count: 1,
        created_at: '2026-11-01T00:00:00Z',
        last_used_at: '2026-11-01T00:00:00Z',
      },
    ];
    const requestLog: ServerSimulator['requests'] = [];

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

    type ServerEntryRecord = Entry & { deleted?: boolean; deletedPosition?: number };

    const toEntryMeta = (rec: ServerEntryRecord): EntryMeta => ({
      id: rec.id,
      item_id: rec.item_id,
      type: rec.type,
      position: rec.position,
      version: rec.version,
      plaintext_len_bucket: rec.plaintext_len_bucket,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
    });

    const toEntryPayload = (rec: ServerEntryRecord): Entry => ({
      ...toEntryMeta(rec),
      envelope: rec.envelope,
      ciphertext: rec.ciphertext,
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

      requestLog.push({ method, url, headers, rawBody });

      if (routeOverride) {
        const custom = await routeOverride(url, init);
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
      if (url.endsWith('/auth/login')) return jsonResponse(currentMe);
      if (url.endsWith('/vault')) {
        if (!createdVault) return problemResponse('vault_absent', 404);
        return jsonResponse(makeVaultGetResponse(createdVault, KEY_ID, 1));
      }

      const pathUrl = new URL(url, 'http://localhost');
      const pathname = pathUrl.pathname;

      if (pathname === `/api/v1/items/${ITEM_ID}`) {
        if (method === 'GET') {
          return jsonResponse({
            ...serverItem,
            entry_count: liveEntryMetas().length,
          });
        }
      }

      if (pathname === '/api/v1/tags' && method === 'GET') {
        return jsonResponse({ items: catalogTags, next_cursor: null });
      }

      if (pathname === `/api/v1/items/${ITEM_ID}/entries`) {
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
          serverItem.entry_count = liveEntryMetas().length;
          return jsonResponse(toEntryMeta(newEntry), 201);
        }
      }

      const singleEntryMatch = /^\/api\/v1\/entries\/([^/]+)$/.exec(pathname);
      if (singleEntryMatch) {
        const eid = decodeURIComponent(singleEntryMatch[1]);
        const rec = entriesMap.get(eid);
        if (!rec || rec.deleted) {
          return problemResponse('not_found', 404);
        }
        if (method === 'GET') {
          return jsonResponse(toEntryPayload(rec), 200);
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
          if (req.envelope.nonce === rec.envelope.nonce) {
            return problemResponse('entry_nonce_reused', 400);
          }
          rec.envelope = req.envelope;
          rec.ciphertext = req.ciphertext;
          rec.plaintext_len_bucket = req.plaintext_len_bucket;
          rec.version += 1;
          return jsonResponse(toEntryMeta(rec), 200);
        }
        if (method === 'DELETE') {
          rec.deleted = true;
          rec.deletedPosition = rec.position;
          serverItem.entry_count = liveEntryMetas().length;
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
                    const shim = createWorkerShim({
                      deriveKek: fastTestDeriveKek,
                    });
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
    });
    await waitFor(() => expect(vaultCtx.state).toBe('unlocked'));

    if (!options?.skipInitialReloadVaultMeta) {
      await act(async () => {
        await vaultCtx.reloadVaultMeta();
      });
      await waitFor(() => expect(vaultCtx.vaultMeta?.vault_key_id).toBe(KEY_ID));
    }

    const sealEntryWithType = async (
      entryId: string,
      plaintext: string,
      type: 'json' | 'text' = 'json',
      version = 1,
      position = entriesMap.size,
    ): Promise<Entry> => {
      const op = vaultCtx.beginOp();
      const sealed = await op.client.sealEntry({
        entryId,
        keyId: KEY_ID,
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
      serverItem.entry_count = liveEntryMetas().length;
      return entryObj;
    };

    const openServerEntryPlaintext = async (entryId: string): Promise<string> => {
      const rec = entriesMap.get(entryId);
      if (!rec) throw new Error(`Entry ${entryId} not found in server simulator`);
      const op = vaultCtx.beginOp();
      const opened = await op.client.openEntry({
        entryId: rec.id,
        envelope: rec.envelope,
        ciphertext: rec.ciphertext,
        opGeneration: op.opGeneration,
      });
      return opened.plaintext;
    };

    const initialEntries = options?.initialEntries ?? [
      {
        id: ENTRY_ID_1,
        text: '{\n  "service": "postgres-prod",\n  "port": 5432,\n  "big_id": 9007199254740993,\n  "tls": true,\n  "replica": null\n}',
        type: 'json',
        position: 0,
        version: 1,
      },
    ];
    for (let i = 0; i < initialEntries.length; i++) {
      const spec = initialEntries[i]!;
      await sealEntryWithType(
        spec.id,
        spec.text,
        spec.type ?? 'json',
        spec.version ?? 1,
        spec.position ?? i,
      );
    }

    requestLog.splice(0);

    rendered.rerender(
      buildTree(<ItemDetailPage itemId={ITEM_ID} lazyCards={lazyCards} />),
    );

    const unlock = async () => {
      const op = vaultCtx.beginOp();
      await act(async () => {
        await vaultCtx.unlockPassphrase({
          passphrase: PASSPHRASE,
          kdf: createdVault!.kdf,
          vaultKeyWrappedByKek: createdVault!.vault_key_wrapped_by_kek,
          privateKeysWrapped: createdVault!.private_keys_wrapped,
          opGeneration: op.opGeneration,
        });
        if (!options?.skipInitialReloadVaultMeta) {
          await vaultCtx.reloadVaultMeta();
        }
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
      container: rendered.container,
      qc,
      vault: () => vaultCtx,
      server: {
        item: serverItem,
        entries: entriesMap,
        catalogTags,
        requests: requestLog,
        sealJsonForEntry: (entryId, plaintext, version, position) =>
          sealEntryWithType(entryId, plaintext, 'json', version, position),
        openServerEntryPlaintext,
        overrideRoute: (fn) => {
          routeOverride = fn;
        },
      },
      unlock,
      lock,
      rerenderPage: (node) => {
        rendered.rerender(
          buildTree(node !== undefined ? node : <ItemDetailPage itemId={ITEM_ID} lazyCards={lazyCards} />),
        );
      },
    };
  }

  it('renders 5 table shapes (object, array-of-objects with <=20 cols + +N fields overflow + duplicate-key row fallback, primitive array, array-of-arrays, root primitive) with ARIA treegrid and lazy chevron expansion', async () => {
    // 22 distinct keys on row 0 to trigger 20-column cap + "+2 trường" overflow column, plus row 1 with duplicate keys ("a":1, "a":2) to trigger duplicate-fallback
    const keys22 = Array.from({ length: 22 }, (_, i) => `"k${i + 1}": ${i + 1}`).join(', ');
    const complexJson = `{
  "dup": "first",
  "dup": "second",
  "big": 9007199254740993,
  "users": [
    { ${keys22} },
    { "k1": 100, "k1": 200, "k2": 300 }
  ],
  "tags": ["primary", "replica"],
  "matrix": [[10, 20], [30, 40]],
  "nested": { "secretNestedKey": "NESTED_LAZY_VALUE_991" }
}`;

    await setupJsonCardHarness({
      initialEntries: [
        { id: ENTRY_ID_1, text: complexJson, type: 'json', position: 0 },
        { id: ENTRY_ID_2, text: '"ROOT_PRIMITIVE_STRING_VALUE"', type: 'json', position: 1 },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_2}`)).toBeInTheDocument();
    });

    const card1 = screen.getByTestId(`entry-card-${ENTRY_ID_1}`);
    const card2 = screen.getByTestId(`entry-card-${ENTRY_ID_2}`);

    // ARIA treegrid role on root table, row/gridcell roles, aria-level
    const treegrid1 = within(card1).getByRole('treegrid');
    expect(treegrid1).toBeInTheDocument();

    // Duplicate key disambiguation in object table: (#1) ⁽¹⁾ and (#2) ⁽²⁾
    expect(within(card1).getByTestId('json-dup-occ-root.k0')).toHaveTextContent('(#1) ⁽¹⁾');
    expect(within(card1).getByTestId('json-dup-occ-root.k1')).toHaveTextContent('(#2) ⁽²⁾');

    // Exact 64-bit integer lexeme 9007199254740993 rendered without Number() rounding
    expect(within(card1).getByTestId('json-cell-btn-root.p2')).toHaveTextContent('9007199254740993');

    // Lazy chevron: before clicking toggle on "nested", NESTED_LAZY_VALUE_991 is NOT in the DOM
    expect(card1.textContent).not.toContain('NESTED_LAZY_VALUE_991');
    const nestedToggle = within(card1).getByTestId('json-toggle-root.p6');
    expect(nestedToggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(nestedToggle);
    expect(nestedToggle).toHaveAttribute('aria-expanded', 'true');
    expect(card1.textContent).toContain('NESTED_LAZY_VALUE_991');

    // Expand array-of-objects ("users" at root.p3) -> 20 columns + "+2 trường" overflow column + duplicate-key row fallback on row 2
    fireEvent.click(within(card1).getByTestId('json-toggle-root.p3'));
    expect(within(card1).getByTestId('json-extra-col-header-root.p3')).toHaveTextContent('+2');
    expect(within(card1).getByText(viMessages.content.json.duplicateRowBadge)).toBeInTheDocument();

    // Expand "+2 trường" overflow cell on row 1 -> reveals k21 and k22
    const extraToggle = within(card1).getByTestId('json-extra-toggle-root.p3.e0.extra');
    expect(card1.textContent).not.toContain('k21');
    fireEvent.click(extraToggle);
    expect(card1.textContent).toContain('k21');
    expect(card1.textContent).toContain('k22');

    // Expand primitive array ("tags" at root.p4) and array-of-arrays ("matrix" at root.p5)
    fireEvent.click(within(card1).getByTestId('json-toggle-root.p4'));
    expect(card1.textContent).toContain('primary');
    fireEvent.click(within(card1).getByTestId('json-toggle-root.p5'));
    expect(within(card1).getByTestId('json-toggle-root.p5.e0')).toHaveTextContent('[2]');

    // Root primitive table on card 2
    expect(within(card2).getByTestId('json-cell-btn-root')).toHaveTextContent(
      'ROOT_PRIMITIVE_STRING_VALUE',
    );
  });

  it('paginates containers with >50 rows (50 rows/page) without mounting >50 rows at once and switches pages cleanly', async () => {
    const items65 = Array.from({ length: 65 }, (_, i) => `"item_${i + 1}"`).join(', ');
    const json65 = `[${items65}]`;

    const h = await setupJsonCardHarness({
      initialEntries: [{ id: ENTRY_ID_1, text: json65, type: 'json', position: 0 }],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`json-pagination-root`)).toBeInTheDocument();
    });

    const card = screen.getByTestId(`entry-card-${ENTRY_ID_1}`);
    expect(within(card).getByTestId('json-page-indicator-root')).toHaveTextContent('1 / 2');
    expect(card.textContent).toContain('item_1');
    expect(card.textContent).toContain('item_50');
    expect(card.textContent).not.toContain('item_51');

    // Click Next page -> shows rows 51..65
    fireEvent.click(within(card).getByTestId('json-page-next-root'));
    expect(within(card).getByTestId('json-page-indicator-root')).toHaveTextContent('2 / 2');
    expect(card.textContent).toContain('item_51');
    expect(card.textContent).toContain('item_65');
    expect(card.textContent).not.toContain('item_1');
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
  });

  it('edits cell inline, preserves surrounding bytes + CRLF + duplicate keys + 9007199254740993 on Save, and sends NO PUT on no-op commit (preserving \\u00e9 and \\/)', async () => {
    // Original JSON has CRLF line endings, custom spacing, escaped \u00e9 and \/, duplicate keys, and 9007199254740993
    const originalJson =
      '{\r\n  "cafe": "caf\\u00e9 \\/ bar",\r\n  "target": "old_val",\r\n  "dup": 1,\r\n  "dup": 2,\r\n  "big": 9007199254740993\r\n}';

    const h = await setupJsonCardHarness({
      initialEntries: [{ id: ENTRY_ID_1, text: originalJson, type: 'json', position: 0 }],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const card = screen.getByTestId(`entry-card-${ENTRY_ID_1}`);

    // 1. Open cell editor on "cafe" (root.p0) displaying "café / bar" and commit WITHOUT changing value -> no-op, no splice, no Save footer, no PUT
    fireEvent.click(within(card).getByTestId('json-cell-btn-root.p0'));
    const input0 = within(card).getByTestId('json-cell-input-root.p0') as HTMLInputElement;
    expect(input0.value).toBe('café / bar');
    assertVaultSecretElementAttributes(card);

    fireEvent.keyDown(input0, { key: 'Enter' });
    // Because value did not change, setValue returned changed: false -> card is not dirty
    expect(within(card).queryByTestId(`entry-save-btn-${ENTRY_ID_1}`)).toBeNull();

    // 2. Open cell editor on "target" (root.p1), change "old_val" -> "new_val", commit with Enter, then click Save
    fireEvent.click(within(card).getByTestId('json-cell-btn-root.p1'));
    const input1 = within(card).getByTestId('json-cell-input-root.p1') as HTMLInputElement;
    fireEvent.change(input1, { target: { value: 'new_val' } });
    fireEvent.keyDown(input1, { key: 'Enter' });

    const saveBtn = within(card).getByTestId(`entry-save-btn-${ENTRY_ID_1}`);
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    });

    // Verify the sealed & saved plaintext on the server has the exact byte splice and preserved \u00e9, \/, CRLF, duplicate keys, and 9007199254740993
    const savedPlaintext = await h.server.openServerEntryPlaintext(ENTRY_ID_1);
    expect(savedPlaintext).toBe(
      '{\r\n  "cafe": "caf\\u00e9 \\/ bar",\r\n  "target": "new_val",\r\n  "dup": 1,\r\n  "dup": 2,\r\n  "big": 9007199254740993\r\n}',
    );
  });

  it('supports cell type conversion (string "42" -> number 42 -> null), Add field, Remove field, Add row, Remove row, and missing cell (—) initialization', async () => {
    const initialJson = '{\n  "count": "42",\n  "list": [\n    { "a": "1", "b": "2" },\n    { "a": "3" }\n  ]\n}';
    const h = await setupJsonCardHarness({
      initialEntries: [{ id: ENTRY_ID_1, text: initialJson, type: 'json', position: 0 }],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const card = screen.getByTestId(`entry-card-${ENTRY_ID_1}`);

    // 1. Convert string "42" (root.p0) to number 42 via type select
    fireEvent.click(within(card).getByTestId('json-cell-btn-root.p0'));
    const typeSelect = within(card).getByTestId('json-type-select-root.p0');
    fireEvent.change(typeSelect, { target: { value: 'number' } });

    // Cell is now unquoted number 42
    expect(within(card).getByTestId('json-cell-btn-root.p0').querySelector('.v-num')).toHaveTextContent('42');

    // 2. Add field "addedKey" of type true to root object
    fireEvent.click(within(card).getByTestId('json-open-add-field-root'));
    const newKeyInput = within(card).getByTestId('json-new-key-input-root');
    const newTypeSelect = within(card).getByTestId('json-new-type-select-root');
    assertVaultSecretElementAttributes(card);

    // Duplicate key error check: typing "count" shows inline error and keeps form open
    fireEvent.change(newKeyInput, { target: { value: 'count' } });
    fireEvent.click(within(card).getByTestId('json-confirm-add-field-root'));
    expect(within(card).getByTestId('json-add-field-error-root')).toHaveTextContent(
      viMessages.content.json.editErrorKeyExists,
    );

    // Valid new key "enabled" with type "true"
    fireEvent.change(newKeyInput, { target: { value: 'enabled' } });
    fireEvent.change(newTypeSelect, { target: { value: 'true' } });
    fireEvent.click(within(card).getByTestId('json-confirm-add-field-root'));
    expect(within(card).getByTestId('json-cell-btn-root.p2')).toHaveTextContent('true');

    // 3. Expand "list" (root.p1) and click missing cell "—" on row 2 col 2 (root.p1.e1.c1) to initialize field "b": ""
    fireEvent.click(within(card).getByTestId('json-toggle-root.p1'));
    const missingCellBtn = within(card).getByTestId('json-missing-cell-root.p1.e1.c1');
    fireEvent.click(missingCellBtn);
    // Missing cell is now an initialized primitive string cell
    expect(within(card).getByTestId('json-cell-btn-root.p1.e1.c1')).toBeInTheDocument();

    // 4. Add row to "list" array and remove row
    fireEvent.click(within(card).getByTestId('json-add-row-root.p1'));
    expect(within(card).getByTestId('json-remove-row-root.p1-2')).toBeInTheDocument();
    fireEvent.click(within(card).getByTestId('json-remove-row-root.p1-2'));
    expect(within(card).queryByTestId('json-remove-row-root.p1-2')).toBeNull();

    // Save and verify resulting JSON on server
    fireEvent.click(within(card).getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    });

    const saved = await h.server.openServerEntryPlaintext(ENTRY_ID_1);
    const parsedSaved = parseJsonStrict(saved);
    expect(parsedSaved.ok).toBe(true);
    expect(saved).toContain('"count": 42');
    expect(saved).toContain('"enabled": true');
    expect(saved).toContain('"b": ""');
  });

  it('marks cells with lone surrogate (\\ud800) or carriage return (\\r) as read-only in Table view with explanation note and allows editing in Raw JSON', async () => {
    const jsonWithReadOnly = '{\n  "surrogate": "bad\\ud800char",\n  "cr_line": "line1\\rline2",\n  "normal": "editable"\n}';
    await setupJsonCardHarness({
      initialEntries: [{ id: ENTRY_ID_1, text: jsonWithReadOnly, type: 'json', position: 0 }],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const card = screen.getByTestId(`entry-card-${ENTRY_ID_1}`);
    const ro0 = within(card).getByTestId('json-readonly-cell-root.p0');
    const ro1 = within(card).getByTestId('json-readonly-cell-root.p1');
    expect(ro0).toHaveAttribute('aria-readonly', 'true');
    expect(ro1).toHaveAttribute('aria-readonly', 'true');
    expect(within(card).getByTestId(`json-readonly-note-${ENTRY_ID_1}`)).toHaveTextContent(
      viMessages.content.json.cellReadOnly,
    );
    // Clicking read-only cell does not open an input
    fireEvent.click(ro0);
    expect(within(card).queryByTestId('json-cell-input-root.p0')).toBeNull();
  });

  it('validates Raw JSON on typing pause, shows line/col error box, jumps to error offset on "Đi tới lỗi", blocks switching to Table while invalid, and formats with 2-space indent preserving token stream', async () => {
    const initialJson = '{"alpha":1,"big":9007199254740993,"nested":{"k":"v"}}';
    await setupJsonCardHarness({
      initialEntries: [{ id: ENTRY_ID_1, text: initialJson, type: 'json', position: 0 }],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const card = screen.getByTestId(`entry-card-${ENTRY_ID_1}`);

    // Switch to Raw JSON tab
    fireEvent.click(within(card).getByTestId(`json-tab-raw-${ENTRY_ID_1}`));
    const rawTextarea = within(card).getByTestId(
      `json-raw-textarea-${ENTRY_ID_1}`,
    ) as HTMLTextAreaElement;
    assertVaultSecretElementAttributes(card);

    // 1. Format button pretty-prints with 2-space indent and preserves non-whitespace tokens (including 9007199254740993)
    fireEvent.click(within(card).getByTestId(`json-raw-format-btn-${ENTRY_ID_1}`));
    expect(rawTextarea.value).toBe(
      '{\n  "alpha": 1,\n  "big": 9007199254740993,\n  "nested": {\n    "k": "v"\n  }\n}',
    );
    expect(areNonWhitespaceTokensIdentical(initialJson, rawTextarea.value)).toBe(true);

    // 2. Type invalid JSON with astral emoji before the syntax error -> verify line/col error box and "Đi tới lỗi" UTF-16 selection
    const invalidWithAstral = '{\n  "emoji": "🚀🎉",\n  "broken": \n}';
    fireEvent.change(rawTextarea, { target: { value: invalidWithAstral } });
    fireEvent.blur(rawTextarea);

    const errBox = await within(card).findByTestId(`json-raw-error-${ENTRY_ID_1}`);
    expect(errBox).toHaveAttribute('role', 'alert');
    expect(errBox).toHaveTextContent('4');

    // Save and Format buttons are disabled while JSON is invalid
    expect(within(card).getByTestId(`json-raw-save-btn-${ENTRY_ID_1}`)).toBeDisabled();
    expect(within(card).getByTestId(`json-raw-format-btn-${ENTRY_ID_1}`)).toBeDisabled();

    // Clicking "Đi tới lỗi" focuses the textarea and places selectionRange at the exact UTF-16 offset
    const gotoBtn = within(card).getByTestId(`json-raw-goto-btn-${ENTRY_ID_1}`);
    fireEvent.click(gotoBtn);
    expect(document.activeElement).toBe(rawTextarea);
    expect(rawTextarea.selectionStart).toBe(invalidWithAstral.lastIndexOf('}'));

    // 3. Attempting to switch to Table tab while Raw JSON is invalid keeps Raw tab active and shows switchBlockedInvalidError
    fireEvent.click(within(card).getByTestId(`json-tab-table-${ENTRY_ID_1}`));
    expect(within(card).getByTestId(`json-tab-raw-${ENTRY_ID_1}`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(card).getByTestId(`json-switch-blocked-msg-${ENTRY_ID_1}`)).toHaveTextContent(
      viMessages.content.json.switchBlockedInvalidError,
    );

    // 4. Fix syntax error -> error clears, switch to Table succeeds and displays updated value
    const fixedJson = '{\n  "emoji": "🚀🎉",\n  "broken": "fixed_now"\n}';
    fireEvent.change(rawTextarea, { target: { value: fixedJson } });
    await waitFor(() => {
      expect(within(card).queryByTestId(`json-raw-error-${ENTRY_ID_1}`)).toBeNull();
    });

    fireEvent.click(within(card).getByTestId(`json-tab-table-${ENTRY_ID_1}`));
    expect(within(card).getByTestId(`json-tab-table-${ENTRY_ID_1}`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(card).getByTestId('json-cell-btn-root.p1')).toHaveTextContent('fixed_now');
  });

  it('blocks Save and Format when Raw JSON exceeds 256 KiB (262,144 UTF-8 bytes) and refuses Format when nesting depth > 10', async () => {
    await setupJsonCardHarness({
      initialEntries: [{ id: ENTRY_ID_1, text: '{"a":"small"}', type: 'json', position: 0 }],
    });
    await waitFor(() => {
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const card = screen.getByTestId(`entry-card-${ENTRY_ID_1}`);
    fireEvent.click(within(card).getByTestId(`json-tab-raw-${ENTRY_ID_1}`));
    const rawTextarea = within(card).getByTestId(
      `json-raw-textarea-${ENTRY_ID_1}`,
    ) as HTMLTextAreaElement;

    // 1. Over 256 KiB (262,144 bytes) -> shows over-cap alert and disables Save & Format
    const hugeString = 'x'.repeat(262_200);
    fireEvent.change(rawTextarea, { target: { value: `{"a":"${hugeString}"}` } });

    await waitFor(() => {
      expect(within(card).getByTestId(`json-raw-error-${ENTRY_ID_1}`)).toHaveTextContent(
        viMessages.content.json.rawOverCap,
      );
    });
    expect(within(card).getByTestId(`json-raw-save-btn-${ENTRY_ID_1}`)).toBeDisabled();
    expect(within(card).getByTestId(`entry-save-btn-${ENTRY_ID_1}`)).toBeDisabled();

    // 2. Nesting depth = 15 (> JSON_FORMAT_MAX_DEPTH = 10) -> valid JSON (<= 1000 parse depth), so Format button is enabled, but clicking Format refuses with formatRefusedDepth
    const depth15Json = '['.repeat(15) + '1' + ']'.repeat(15);
    fireEvent.change(rawTextarea, { target: { value: depth15Json } });
    fireEvent.blur(rawTextarea);

    const formatBtn = within(card).getByTestId(`json-raw-format-btn-${ENTRY_ID_1}`);
    expect(formatBtn).not.toBeDisabled();
    fireEvent.click(formatBtn);

    expect(within(card).getByTestId(`json-format-msg-${ENTRY_ID_1}`)).toBeInTheDocument();
    expect(rawTextarea.value).toBe(depth15Json);
  });

  it('warns before normalizing mixed EOL in Raw JSON on Save, and preserves CRLF without warning when opening Raw JSON and clicking Save without edits', async () => {
    // 1. CRLF no-op round-trip: open Raw JSON on CRLF document, do not edit, click Cancel/Table -> zero PUTs
    const crlfJson = '{\r\n  "k": "v1"\r\n}';
    const h = await setupJsonCardHarness({
      initialEntries: [{ id: ENTRY_ID_1, text: crlfJson, type: 'json', position: 0 }],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const card = screen.getByTestId(`entry-card-${ENTRY_ID_1}`);
    fireEvent.click(within(card).getByTestId(`json-tab-raw-${ENTRY_ID_1}`));
    // Click Save without any edits -> no-op returns to Table view without sending PUT
    fireEvent.click(within(card).getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);

    // 2. Mixed EOL document (\r\n and \n): editing in Raw JSON and clicking Save shows mixedEolWarning confirmation before sealing
    const mixedEolJson = '{\r\n  "a": 1,\n  "b": 2\r\n}';
    await h.server.sealJsonForEntry(ENTRY_ID_1, mixedEolJson, 2, 0);
    await h.lock();
    await h.unlock();

    await waitFor(() => {
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const cardAfter = screen.getByTestId(`entry-card-${ENTRY_ID_1}`);
    fireEvent.click(within(cardAfter).getByTestId(`json-tab-raw-${ENTRY_ID_1}`));
    // Banner in raw editor warns about mixed EOL
    expect(within(cardAfter).getByTestId(`json-eol-warning-${ENTRY_ID_1}`)).toBeInTheDocument();

    const rawTa = within(cardAfter).getByTestId(`json-raw-textarea-${ENTRY_ID_1}`);
    fireEvent.change(rawTa, { target: { value: '{\n  "a": 10,\n  "b": 2\n}' } });

    // First Save click opens confirmation prompt instead of sending PUT immediately
    fireEvent.click(within(cardAfter).getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    expect(
      within(cardAfter).getByTestId(`entry-mixed-eol-warning-${ENTRY_ID_1}`),
    ).toBeInTheDocument();
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);

    // Confirming mixed EOL normalization seals and sends PUT with majority CRLF
    fireEvent.click(within(cardAfter).getByTestId(`entry-confirm-mixed-eol-save-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    });
    const saved = await h.server.openServerEntryPlaintext(ENTRY_ID_1);
    expect(saved).toBe('{\r\n  "a": 10,\r\n  "b": 2\r\n}');
  });

  it('"+ JSON / bảng" composer creates a new JSON entry with Empty object {} or Empty array [] preset, and lazy-loads vault.reloadVaultMeta() when vaultMeta is initially null (advisor-dec-200)', async () => {
    // Start with skipInitialReloadVaultMeta: true so vault.vaultMeta is null (simulating onboarding step 3 skip per advisor-dec-200)
    const h = await setupJsonCardHarness({
      initialEntries: [],
      skipInitialReloadVaultMeta: true,
    });

    await waitFor(() => {
      expect(screen.getByTestId('btn-add-json')).toBeInTheDocument();
    });
    expect(h.vault().vaultMeta).toBeNull();

    const reloadSpy = vi.spyOn(h.vault(), 'reloadVaultMeta');

    // Click "+ JSON / bảng"
    fireEvent.click(screen.getByTestId('btn-add-json'));
    const composer = screen.getByTestId('new-json-entry-composer');
    expect(composer).toBeInTheDocument();

    // Switch preset to Empty array [] then back to Empty object {} and add a field
    fireEvent.click(within(composer).getByTestId('new-json-preset-array'));
    expect(composer.textContent).toContain(viMessages.content.json.emptyArray);

    fireEvent.click(within(composer).getByTestId('new-json-preset-object'));
    expect(composer.textContent).toContain(viMessages.content.json.emptyObject);

    fireEvent.click(within(composer).getByTestId('json-open-add-field-root'));
    fireEvent.change(within(composer).getByTestId('json-new-key-input-root'), {
      target: { value: 'host' },
    });
    fireEvent.change(within(composer).getByTestId('json-new-type-select-root'), {
      target: { value: 'string' },
    });
    fireEvent.click(within(composer).getByTestId('json-confirm-add-field-root'));

    // Click Save -> calls vault.reloadVaultMeta() because vaultMeta was null, then seals and POSTs type: 'json'
    fireEvent.click(within(composer).getByTestId('new-json-save-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('new-json-entry-composer')).toBeNull();
      expect(
        h.server.requests.some(
          (r) => r.method === 'POST' && r.url.endsWith(`/items/${ITEM_ID}/entries`),
        ),
      ).toBe(true);
    });

    expect(reloadSpy).toHaveBeenCalled();
    const postReq = h.server.requests.find(
      (r) => r.method === 'POST' && r.url.endsWith(`/items/${ITEM_ID}/entries`),
    )!;
    const postBody = JSON.parse(postReq.rawBody) as EntryCreateRequest;
    expect(postBody.type).toBe('json');
    expect(postReq.rawBody).not.toContain('host');
  });

  it('wipes active cell editor and raw draft on vault lock, leaves zero plaintext in DOM/QueryCache/MutationCache, and does not seal/PUT after lock during 412 Keep mine fallback GET (IP15-BE1-1, BE2-1)', async () => {
    const SECRET_SENTINEL = 'JSON_SECRET_SENTINEL_994411';
    const DRAFT_SENTINEL = 'JSON_DRAFT_KEEP_MINE_SENTINEL_772200';

    const h = await setupJsonCardHarness({
      initialEntries: [
        {
          id: ENTRY_ID_1,
          text: `{"secretKey":"${SECRET_SENTINEL}"}`,
          type: 'json',
          position: 0,
          version: 1,
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const holderRef: { current: EditorPlaintextHolder } = {
      current: { originalSource: '', draftValue: '', submittedCandidateSource: '', tableSource: '' },
    };
    const entryMeta = Array.from(h.server.entries.values())[0]!;
    h.rerenderPage(
      <JsonEntryCard
        entry={entryMeta}
        itemId={ITEM_ID}
        index={0}
        total={1}
        canReorder={false}
        lazy={false}
        onMoveUp={() => {}}
        onMoveDown={() => {}}
        onDelete={() => {}}
        editorPlaintextHolderRef={holderRef}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('json-cell-btn-root.p0')).toHaveTextContent(SECRET_SENTINEL);
    });
    assertNoPlaintextAttrs(h.container, [SECRET_SENTINEL]);

    // Edit cell to DRAFT_SENTINEL
    fireEvent.click(screen.getByTestId('json-cell-btn-root.p0'));
    const cellInput = screen.getByTestId('json-cell-input-root.p0');
    fireEvent.change(cellInput, { target: { value: DRAFT_SENTINEL } });
    fireEvent.keyDown(cellInput, { key: 'Enter' });

    expect(holderRef.current.tableSource).toContain(DRAFT_SENTINEL);

    // Return 412 without current_version so Keep mine must run fallback GET /entries/{id}
    await h.server.sealJsonForEntry(ENTRY_ID_1, '{"secretKey":"REMOTE_V2_VALUE"}', 2, 0);
    const { promise: getGate, resolve: releaseGet } = createDeferred();
    const { promise: getEntered, resolve: notifyGetEntered } = createDeferred();
    let holdFallbackGet = false;

    h.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && method === 'PUT') {
        return problemResponse('version_mismatch', 412);
      }
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && method === 'GET' && holdFallbackGet) {
        notifyGetEntered();
        await getGate;
      }
      return null;
    });

    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(screen.getByTestId(`entry-conflict-box-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    holdFallbackGet = true;
    const sealSpy = vi.spyOn(h.vault().getClient(), 'sealEntry');
    const sealUpdateSpy = vi.spyOn(entriesModule, 'sealEntryUpdate');
    const putsBefore = h.server.requests.filter((r) => r.method === 'PUT').length;

    fireEvent.click(screen.getByTestId(`entry-conflict-keep-mine-${ENTRY_ID_1}`));
    await getEntered;

    // Lock vault while fallback GET is held -> holderRef is synchronously cleared and DOM shows LockMask
    await h.lock();
    expect(holderRef.current).toEqual({
      originalSource: '',
      draftValue: '',
      submittedCandidateSource: '',
      tableSource: '',
    });
    expect(h.container.textContent).not.toContain(SECRET_SENTINEL);
    expect(h.container.textContent).not.toContain(DRAFT_SENTINEL);
    assertNoPlaintextAttrs(h.container, [SECRET_SENTINEL, DRAFT_SENTINEL], { locked: true });
    expect(findCacheSentinelLeaks(h.qc, [SECRET_SENTINEL, DRAFT_SENTINEL])).toEqual([]);

    // Unlock and release fallback GET -> stale continuation must NOT seal or PUT
    await h.unlock();
    holdFallbackGet = false;
    sealSpy.mockClear();
    sealUpdateSpy.mockClear();
    releaseGet();

    await waitFor(() => {
      expect(screen.getByTestId('json-cell-btn-root.p0')).toHaveTextContent('REMOTE_V2_VALUE');
    });
    expect(sealSpy).not.toHaveBeenCalled();
    expect(sealUpdateSpy).not.toHaveBeenCalled();
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(putsBefore);
  });

  it('handles 5xx/network failure with Retry (same sealed bytes + same Idempotency-Key), single-flight double-click Save (only 1 PUT, no 412), 412 Keep mine / Load latest / Copy mine, and Shift+Enter multiline string editing', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: writeTextMock },
    });

    const h = await setupJsonCardHarness({
      initialEntries: [
        {
          id: ENTRY_ID_1,
          text: '{\n  "notes": "line1\\nline2",\n  "status": "v1"\n}',
          type: 'json',
          position: 0,
          version: 1,
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const card = screen.getByTestId(`entry-card-${ENTRY_ID_1}`);

    // 1. Multiline string cell ("notes" at root.p0) opens a <textarea>; Shift+Enter does NOT commit, Enter commits
    fireEvent.click(within(card).getByTestId('json-cell-btn-root.p0'));
    const multilineTa = within(card).getByTestId(
      'json-cell-input-root.p0',
    ) as HTMLTextAreaElement;
    expect(multilineTa.tagName.toUpperCase()).toBe('TEXTAREA');
    fireEvent.keyDown(multilineTa, { key: 'Enter', shiftKey: true });
    expect(within(card).getByTestId('json-cell-input-root.p0')).toBeInTheDocument();

    fireEvent.change(multilineTa, { target: { value: 'line1\nline2\nline3' } });
    fireEvent.keyDown(multilineTa, { key: 'Enter' });
    expect(within(card).queryByTestId('json-cell-input-root.p0')).toBeNull();

    // 2. First PUT fails with 503 dependency_unavailable -> offers Retry; clicking Retry re-sends exact same ciphertext and Idempotency-Key
    let failPut503 = true;
    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && init?.method === 'PUT' && failPut503) {
        return problemResponse('dependency_unavailable', 503);
      }
      return null;
    });

    // Double-click Save while first PUT is in flight -> only 1 PUT request (single-flight guard)
    const saveBtn = within(card).getByTestId(`entry-save-btn-${ENTRY_ID_1}`);
    fireEvent.click(saveBtn);
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(within(card).getByTestId(`entry-save-retry-box-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const failedPuts = h.server.requests.filter((r) => r.method === 'PUT');
    expect(failedPuts.length).toBeGreaterThanOrEqual(1);
    const firstIdemKey = failedPuts[0]!.headers['idempotency-key'];
    const firstRawBody = failedPuts[0]!.rawBody;

    failPut503 = false;
    fireEvent.click(within(card).getByTestId(`entry-retry-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(within(card).queryByTestId(`entry-save-retry-box-${ENTRY_ID_1}`)).toBeNull();
    });
    const allPuts = h.server.requests.filter((r) => r.method === 'PUT');
    const retryPut = allPuts[allPuts.length - 1]!;
    expect(retryPut.headers['idempotency-key']).toBe(firstIdemKey);
    expect(retryPut.rawBody).toBe(firstRawBody);

    // 3. 412 conflict on next edit -> Copy mine copies draft, Keep mine re-seals with fresh nonce and new version
    fireEvent.click(within(card).getByTestId('json-cell-btn-root.p1'));
    const statusInput = within(card).getByTestId('json-cell-input-root.p1');
    fireEvent.change(statusInput, { target: { value: 'local_v3_draft' } });
    fireEvent.keyDown(statusInput, { key: 'Enter' });

    // Server advances to version 3 concurrently
    await h.server.sealJsonForEntry(
      ENTRY_ID_1,
      '{\n  "notes": "remote",\n  "status": "remote_v3"\n}',
      3,
      0,
    );

    fireEvent.click(within(card).getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(within(card).getByTestId(`entry-conflict-box-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    fireEvent.click(within(card).getByTestId(`entry-conflict-copy-mine-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalled();
    });
    expect(writeTextMock.mock.calls[0]?.[0]).toContain('local_v3_draft');

    fireEvent.click(within(card).getByTestId(`entry-conflict-keep-mine-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(within(card).queryByTestId(`entry-conflict-box-${ENTRY_ID_1}`)).toBeNull();
    });
    const finalPuts = h.server.requests.filter((r) => r.method === 'PUT');
    expect(finalPuts[finalPuts.length - 1]!.headers['if-match']).toBe('"3"');
  });
});
