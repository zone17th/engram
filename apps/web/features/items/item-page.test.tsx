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
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ItemPage from '@/app/app/items/[id]/page';
import { ThemeProvider } from '@/components/theme-provider';
import { UndoToastProvider } from '@/components/ui/undo-toast';
import { SessionProvider, useSession } from '@/features/auth/session-provider';
import * as entriesModule from '@/features/entries';
import {
  assertVaultSecretElementAttributes,
  clearAllUnconfirmedSaves,
  getUnconfirmedSavesSnapshot,
  resetEntryBodyLoadLimiterForTests,
} from '@/features/entries';
import { assertNoPlaintextAttrs } from '@/features/entries/test-utils/assert-no-plaintext-attrs';
import { ItemDetailPage } from '@/features/items/item-detail-page';
import { TextEntryCard, type EditorPlaintextHolder } from '@/features/items/text-entry-card';
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
  ItemUpdateRequest,
  Tag,
} from '@/lib/api/content';
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

const PASSPHRASE = 'task15-item-page-passphrase-1';
const KEY_ID = 'vk:7f3a91c4e0b2d8a1f5c309';
const ITEM_ID = '11111111-1111-4111-8111-111111111111';
const ENTRY_ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENTRY_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENTRY_ID_3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_A_ID = '33333333-3333-4333-8333-333333333333';
const USER_B_ID = '44444444-4444-4444-8444-444444444444';

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
  let marker = { epochIncarnation: 'inc-task15-1', lockEpoch: 1 };
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
    name: 'wifi',
    hint: 'home router',
    tags: [
      { id: 'tag-1', display: 'nhà' },
      { id: 'tag-2', display: 'office' },
    ],
    entry_count: 1,
    version: 1,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    last_used_at: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

function getRenderedEntryCardIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-entry-card]'))
    .map((el) => el.getAttribute('data-entry-card'))
    .filter((id): id is string => id !== null);
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
      ['context', state.context],
      ['data', state.data],
      ['error', state.error],
    ];
    for (const [fieldName, value] of fields) {
      const serialized = JSON.stringify(value ?? null);
      for (const sentinel of sentinels) {
        if (serialized.includes(sentinel)) {
          leaks.push(`MutationCache.${fieldName} contains ${sentinel}`);
        }
      }
    }
  }

  return leaks;
}

describe('P04-T15 Item page U11-U12 (text), real data, sequential PATCH, reorder, EOL, conflicts, security', () => {
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
    sealTextForEntry: (entryId: string, plaintext: string, version?: number, position?: number) => Promise<Entry>;
    overrideRoute: (
      handler: ((url: string, init?: RequestInit) => Promise<Response | null> | Response | null) | null,
    ) => void;
  }

  interface Harness {
    container: HTMLElement;
    qc: QueryClient;
    vault: () => VaultContextValue;
    server: ServerSimulator;
    signOutSession: () => Promise<void>;
    loginSession: (email: string, password: string) => Promise<void>;
    unlock: () => Promise<void>;
    lock: () => Promise<void>;
    setCurrentMe: (me: Me) => void;
    rerenderPage: (node?: ReactNode) => void;
  }

  async function setupItemPageHarness(options?: {
    locale?: 'en' | 'vi';
    initialItem?: ItemSummary;
    initialPlaintexts?: Array<{ id: string; text: string; position?: number; version?: number }>;
    itemNotFound?: boolean;
    lazyCards?: boolean;
  }): Promise<Harness> {
    const locale = options?.locale ?? 'vi';
    const lazyCards = options?.lazyCards ?? false;
    let vaultCtx!: VaultContextValue;
    let signOutFn!: () => Promise<void>;
    let loginFn!: (args: { email: string; password: string }) => Promise<unknown>;
    function Probe() {
      vaultCtx = useVault();
      const sess = useSession();
      signOutFn = () => sess.signOut();
      loginFn = (args) => sess.login(args);
      return <output data-testid="vault-state-probe">{vaultCtx.state}</output>;
    }

    let createdVault: CreateVaultResult | null = null;
    let currentMe = makeMe(USER_A_ID, 'present');
    let routeOverride:
      | ((url: string, init?: RequestInit) => Promise<Response | null> | Response | null)
      | null = null;

    const serverItem: ItemSummary = options?.initialItem ?? makeItemSummary();
    const entriesMap = new Map<string, Entry & { deleted?: boolean; deletedPosition?: number }>();
    const catalogTags: Tag[] = [
      {
        id: 'tag-1',
        display: 'nhà',
        item_count: 2,
        created_at: '2026-11-01T00:00:00Z',
        last_used_at: '2026-11-01T00:00:00Z',
      },
      {
        id: 'tag-2',
        display: 'office',
        item_count: 1,
        created_at: '2026-11-01T00:00:00Z',
        last_used_at: '2026-11-01T00:00:00Z',
      },
      {
        id: 'tag-3',
        display: 'mạng-nhà',
        item_count: 6,
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

      // GET / PATCH / DELETE /items/{id}
      if (pathname === `/api/v1/items/${ITEM_ID}`) {
        if (options?.itemNotFound) {
          return problemResponse('not_found', 404);
        }
        if (method === 'GET') {
          return jsonResponse({
            ...serverItem,
            entry_count: liveEntryMetas().length,
          });
        }
        if (method === 'PATCH') {
          const ifMatch = headers['if-match'];
          if (!ifMatch) return problemResponse('precondition_required', 428);
          const expectedTag = `"${serverItem.version}"`;
          if (ifMatch !== expectedTag) {
            return problemResponse('version_mismatch', 412, {
              current_version: serverItem.version,
            });
          }
          const body = JSON.parse(rawBody) as ItemUpdateRequest;
          if (body.name !== undefined) serverItem.name = body.name;
          if (body.hint !== undefined) serverItem.hint = body.hint;
          serverItem.version += 1;
          return jsonResponse({ ...serverItem });
        }
        if (method === 'DELETE') {
          return new Response(null, { status: 204 });
        }
      }

      if (pathname === `/api/v1/items/${ITEM_ID}/restore` && method === 'POST') {
        return jsonResponse({ ...serverItem });
      }

      // Tags
      if (pathname === '/api/v1/tags') {
        if (method === 'GET') {
          const q = (pathUrl.searchParams.get('q') ?? '').toLowerCase();
          const filtered = q
            ? catalogTags.filter((t) => t.display.toLowerCase().startsWith(q))
            : catalogTags;
          return jsonResponse({ items: filtered, next_cursor: null });
        }
        if (method === 'POST') {
          const { display } = JSON.parse(rawBody) as { display: string };
          const existing = catalogTags.find(
            (t) => t.display.toLowerCase() === display.toLowerCase(),
          );
          if (existing) return jsonResponse(existing, 200);
          const createdTag: Tag = {
            id: `tag-${catalogTags.length + 1}`,
            display,
            item_count: 0,
            created_at: '2026-11-01T00:00:00Z',
            last_used_at: '2026-11-01T00:00:00Z',
          };
          catalogTags.push(createdTag);
          return jsonResponse(createdTag, 201);
        }
      }

      if (pathname === `/api/v1/items/${ITEM_ID}/tags` && method === 'POST') {
        const { tag_ids } = JSON.parse(rawBody) as { tag_ids: string[] };
        for (const tid of tag_ids) {
          if (serverItem.tags.some((t) => t.id === tid)) continue;
          if (serverItem.tags.length >= 20) {
            return problemResponse('item_tag_limit', 409);
          }
          const found = catalogTags.find((t) => t.id === tid) ?? {
            id: tid,
            display: tid,
          };
          serverItem.tags = [...serverItem.tags, { id: found.id, display: found.display }];
        }
        return jsonResponse({ ...serverItem });
      }

      const tagRemoveMatch = /^\/api\/v1\/items\/([^/]+)\/tags\/([^/]+)$/.exec(pathname);
      if (tagRemoveMatch && method === 'DELETE') {
        const tagId = decodeURIComponent(tagRemoveMatch[2]);
        serverItem.tags = serverItem.tags.filter((t) => t.id !== tagId);
        return jsonResponse({ ...serverItem });
      }

      // Entries list & create
      if (pathname === `/api/v1/items/${ITEM_ID}/entries`) {
        if (method === 'GET') {
          return jsonResponse({
            items: liveEntryMetas(),
            next_cursor: null,
          });
        }
        if (method === 'POST') {
          if (liveEntryMetas().length >= 200) {
            return problemResponse('item_entry_limit', 409);
          }
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

      // Reorder
      if (pathname === `/api/v1/items/${ITEM_ID}/entries/reorder` && method === 'PATCH') {
        const { entry_ids } = JSON.parse(rawBody) as { entry_ids: string[] };
        const liveIds = liveEntryMetas().map((e) => e.id);
        if (
          entry_ids.length !== liveIds.length ||
          new Set(entry_ids).size !== liveIds.length ||
          entry_ids.some((id) => !entriesMap.get(id) || entriesMap.get(id)?.deleted)
        ) {
          return problemResponse('reorder_mismatch', 409);
        }
        const out: Array<{ id: string; position: number }> = [];
        entry_ids.forEach((id, idx) => {
          const rec = entriesMap.get(id)!;
          rec.position = idx;
          out.push({ id, position: idx });
        });
        return jsonResponse({ entries: out });
      }

      // Single entry GET / PUT / DELETE / restore
      const entryRestoreMatch = /^\/api\/v1\/entries\/([^/]+)\/restore$/.exec(pathname);
      if (entryRestoreMatch && method === 'POST') {
        const eid = decodeURIComponent(entryRestoreMatch[1]);
        const rec = entriesMap.get(eid);
        if (!rec) return problemResponse('not_found', 404);
        const targetPos = rec.deletedPosition ?? rec.position;
        // Shift live rows >= targetPos if collision (advisor-dec-160)
        const liveAtPos = Array.from(entriesMap.values()).some(
          (e) => !e.deleted && e.id !== eid && e.position === targetPos,
        );
        if (liveAtPos) {
          for (const e of entriesMap.values()) {
            if (!e.deleted && e.id !== eid && e.position >= targetPos) {
              e.position += 1;
            }
          }
        }
        rec.deleted = false;
        rec.position = targetPos;
        serverItem.entry_count = liveEntryMetas().length;
        return jsonResponse(toEntryMeta(rec), 200);
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
    // First mount without ItemDetailPage so we can create & unlock the vault and seal initial entries
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

    await act(async () => {
      await vaultCtx.reloadVaultMeta();
    });
    await waitFor(() => expect(vaultCtx.vaultMeta?.vault_key_id).toBe(KEY_ID));

    const sealTextForEntry = async (
      entryId: string,
      plaintext: string,
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
        type: 'text',
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

    const initialEntries = options?.initialPlaintexts ?? [
      { id: ENTRY_ID_1, text: 'SSID: Zone17th-5G\nPass: tr4m-Ngh1n-C4y-S0', position: 0, version: 1 },
    ];
    for (let i = 0; i < initialEntries.length; i++) {
      const spec = initialEntries[i];
      await sealTextForEntry(spec.id, spec.text, spec.version ?? 1, spec.position ?? i);
    }

    // Clear setup requests before mounting the actual ItemDetailPage
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
      container: rendered.container,
      qc,
      vault: () => vaultCtx,
      server: {
        item: serverItem,
        entries: entriesMap,
        catalogTags,
        requests: requestLog,
        sealTextForEntry,
        overrideRoute: (fn) => {
          routeOverride = fn;
        },
      },
      unlock,
      lock,
      signOutSession: async () => {
        await act(async () => {
          await signOutFn();
        });
      },
      loginSession: async (email, password) => {
        await act(async () => {
          await loginFn({ email, password });
        });
      },
      setCurrentMe: (nextMe) => {
        currentMe = nextMe;
      },
      rerenderPage: (node) => {
        rendered.rerender(
          buildTree(node !== undefined ? node : <ItemDetailPage itemId={ITEM_ID} lazyCards={lazyCards} />),
        );
      },
    };
  }

  it('redirects /app/items/[id] to /app when NEXT_PUBLIC_CONTENT_ENABLED is off (vi.stubEnv)', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTENT_ENABLED', 'false');
    await expect(
      ItemPage({ params: Promise.resolve({ id: ITEM_ID }) }),
    ).rejects.toThrow('NEXT_REDIRECT:/app');
    expect(routerMocks.redirect).toHaveBeenCalledWith('/app');
  });

  it('renders 404 not-found state when item does not exist', async () => {
    await setupItemPageHarness({ itemNotFound: true });
    await waitFor(() => {
      expect(screen.getByTestId('item-not-found')).toBeInTheDocument();
    });
    expect(screen.getByText(viMessages.content.item.notFoundTitle)).toBeInTheDocument();
    expect(screen.getByTestId('item-not-found-back')).toHaveAttribute('href', '/app');
  });

  it('renders content.privacy notice in the item header and in the tag popover, and hides + JSON / Import JSON in Milestone A', async () => {
    await setupItemPageHarness();
    await waitFor(() => {
      expect(screen.getByTestId('item-privacy-note')).toHaveTextContent(
        viMessages.content.privacy.notice,
      );
    });
    expect(screen.getByTestId('item-hint-server-readable')).toHaveTextContent(
      viMessages.content.privacy.hintServerReadable,
    );

    // Open tag popover and verify privacy notice there too
    fireEvent.click(screen.getByTestId('tag-add-chip'));
    await waitFor(() => {
      expect(screen.getByTestId('tag-privacy-note')).toHaveTextContent(
        viMessages.content.privacy.notice,
      );
    });

    // + Text exists, + JSON / table and Import JSON are hidden until Milestone C
    expect(screen.getByTestId('btn-add-text')).toBeInTheDocument();
    expect(screen.queryByText(/JSON \/ bảng|JSON \/ table/i)).toBeNull();
    expect(screen.queryByText(/Import JSON/i)).toBeNull();
  });

  it('renders javascript:alert(1) and URLs as plain text with NO <a> links and NO innerHTML, and shows no entry title or edit date on cards (Q19)', async () => {
    const xssAndUrlText = 'javascript:alert(1) https://engram.zone17.click/secret?token=123 <img src=x onerror=alert(1)>';
    const h = await setupItemPageHarness({
      initialPlaintexts: [{ id: ENTRY_ID_1, text: xssAndUrlText }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent(xssAndUrlText);
    });

    const card = screen.getByTestId(`entry-card-${ENTRY_ID_1}`);
    expect(card.querySelectorAll('a')).toHaveLength(0);
    expect(card.querySelectorAll('img')).toHaveLength(0);
    expect(card).not.toHaveTextContent('2026-11-01');
    assertNoPlaintextAttrs(h.container, ['javascript:alert(1)', 'token=123']);
  });

  it('edit -> save -> reload shows the new text', async () => {
    const h = await setupItemPageHarness({
      initialPlaintexts: [{ id: ENTRY_ID_1, text: 'Initial secret note' }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Initial secret note');
    });

    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const textarea = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`) as HTMLTextAreaElement;
    assertVaultSecretElementAttributes(h.container);

    fireEvent.change(textarea, { target: { value: 'Updated secret note v2' } });
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Updated secret note v2');
    });

    // IP15-FE1-5: Save success restores focus to the card's Edit button after the editor unmounts
    expect(document.activeElement).toBe(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    // Simulate reload by clearing body cache and re-fetching
    act(() => {
      h.qc.removeQueries({ queryKey: VAULT_BODY_QUERY_KEY_PREFIX });
      void h.qc.invalidateQueries();
    });

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Updated secret note v2');
    });
  });

  it('opening and saving an unedited CRLF entry sends NO PUT request; editing one char in a CRLF entry preserves CRLF outside the edit', async () => {
    const crlfOriginal = 'line1\r\nline2\r\nline3';
    const h = await setupItemPageHarness({
      initialPlaintexts: [{ id: ENTRY_ID_1, text: crlfOriginal }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toBeInTheDocument();
    });

    // 1. Open editor -> textarea normalizes to LF in DOM -> click Save without editing -> NO PUT
    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    expect(screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(screen.queryByTestId(`entry-edit-textarea-${ENTRY_ID_1}`)).toBeNull();
    });
    const putRequestsAfterNoOp = h.server.requests.filter((r) => r.method === 'PUT');
    expect(putRequestsAfterNoOp).toHaveLength(0);

    // 2. Re-open editor -> edit one character -> Save -> PUT sent -> decrypt saved ciphertext and verify CRLF preserved
    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const textarea = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`);
    fireEvent.change(textarea, { target: { value: 'line1\nline2X\nline3' } });
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    });

    const savedOnServer = h.server.entries.get(ENTRY_ID_1)!;
    const op = h.vault().beginOp();
    const decrypted = await op.client.openEntry({
      entryId: ENTRY_ID_1,
      envelope: savedOnServer.envelope,
      ciphertext: savedOnServer.ciphertext,
      opGeneration: op.opGeneration,
    });
    expect(decrypted.plaintext).toBe('line1\r\nline2X\r\nline3');
  });

  it('clicking Save twice before the first PUT finishes sends only ONE PUT and never triggers a self-412', async () => {
    const h = await setupItemPageHarness({
      initialPlaintexts: [{ id: ENTRY_ID_1, text: 'Original body' }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Original body');
    });

    const { promise: putGate, resolve: releasePut } = createDeferred();

    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && init?.method === 'PUT') {
        await putGate;
      }
      return null;
    });

    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const textarea = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`);
    fireEvent.change(textarea, { target: { value: 'Double save test' } });

    const saveBtn = screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`);
    fireEvent.click(saveBtn);
    // Immediate second click + Ctrl+S while first is in flight
    fireEvent.click(saveBtn);
    fireEvent.keyDown(textarea, { key: 's', ctrlKey: true });

    await waitFor(() => {
      expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    });
    expect(saveBtn).toBeDisabled();

    releasePut();

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Double save test');
    });
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    expect(screen.queryByTestId(`entry-conflict-412-${ENTRY_ID_1}`)).toBeNull();
  });

  it('IP15-BE1-3: typing a newer edit while a PUT is in flight keeps the editor open on 2xx and the next PUT uses the returned version', async () => {
    const h = await setupItemPageHarness({
      initialPlaintexts: [{ id: ENTRY_ID_1, text: 'Initial v1 content', version: 1 }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Initial v1 content');
    });

    const { promise: putAGate, resolve: releasePutA } = createDeferred();
    let putCount = 0;

    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && init?.method === 'PUT') {
        putCount += 1;
        if (putCount === 1) {
          await putAGate;
        }
      }
      return null;
    });

    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const textarea = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`) as HTMLTextAreaElement;

    // Type draft A and submit PUT A (held in flight)
    fireEvent.change(textarea, { target: { value: 'Draft A submitted' } });
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    });

    // Type draft B while PUT A is still in flight
    fireEvent.change(textarea, { target: { value: 'Draft B typed while A in flight' } });

    // Release PUT A (commits v2 on server)
    releasePutA();

    // Editor remains open with Draft B preserved and Save button re-enabled
    await waitFor(() => {
      expect(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`)).not.toBeDisabled();
    });
    expect(screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`)).toHaveValue(
      'Draft B typed while A in flight',
    );

    // Click Save for Draft B -> sends PUT #2 with If-Match: "2" (new version from PUT A) and closes editor on 2xx
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(screen.queryByTestId(`entry-edit-textarea-${ENTRY_ID_1}`)).toBeNull();
      expect(screen.getByTestId('entry-body')).toHaveTextContent(
        'Draft B typed while A in flight',
      );
    });

    const puts = h.server.requests.filter((r) => r.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[0].headers['if-match']).toBe('"1"');
    expect(puts[1].headers['if-match']).toBe('"2"');
  });

  it('412 on entry PUT keeps draft; Copy mine copies draft; Keep mine writes with the new version and fresh nonce; Load latest drops draft after inline confirm', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: writeTextMock },
    });

    const h = await setupItemPageHarness({
      initialPlaintexts: [{ id: ENTRY_ID_1, text: 'Version 1 text', version: 1 }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Version 1 text');
    });

    // Enter edit mode while local knows version 1
    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const textarea = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'My local draft text' } });

    // Another device updates the entry on the server to version 2
    await h.server.sealTextForEntry(ENTRY_ID_1, 'Remote device version 2 text', 2, 0);

    // Click Save -> server returns 412 with current_version: 2
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(screen.getByTestId(`entry-conflict-412-${ENTRY_ID_1}`)).toBeInTheDocument();
    });
    // Draft is preserved in textarea
    expect(textarea.value).toBe('My local draft text');

    // 1. Copy mine copies the draft to clipboard
    fireEvent.click(screen.getByTestId(`entry-conflict-copy-mine-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('My local draft text');
    });

    // 2. Keep mine re-seals with fresh nonce and sends PUT with If-Match: "2"
    fireEvent.click(screen.getByTestId(`entry-conflict-keep-mine-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('My local draft text');
    });
    const putReqs = h.server.requests.filter((r) => r.method === 'PUT');
    expect(putReqs).toHaveLength(2);
    expect(putReqs[0].headers['if-match']).toBe('"1"');
    expect(putReqs[1].headers['if-match']).toBe('"2"');
    expect(putReqs[1].headers['idempotency-key']).not.toBe(putReqs[0].headers['idempotency-key']);

    // 3. Test "Load latest" (Tải bản mới) -> inline confirm -> drops draft and loads server version
    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const textarea2 = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`) as HTMLTextAreaElement;
    fireEvent.change(textarea2, { target: { value: 'Draft to discard' } });

    // Server advances to version 4
    await h.server.sealTextForEntry(ENTRY_ID_1, 'Server version 4 text', 4, 0);

    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(screen.getByTestId(`entry-conflict-412-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId(`entry-conflict-load-latest-${ENTRY_ID_1}`));
    expect(screen.getByTestId(`entry-conflict-reload-confirm-${ENTRY_ID_1}`)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`entry-conflict-reload-confirm-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Server version 4 text');
    });
  });

  it('IP15-BE1-1 / FE1-2: lock and unlock during Keep mine fallback GET does not seal, PUT, or restore the pre-lock draft; Ctrl+S during 412 sends nothing', async () => {
    const PRE_LOCK_DRAFT = 'PRE-LOCK-KEEP-MINE-DRAFT-SENTINEL-8812';
    const h = await setupItemPageHarness({
      initialPlaintexts: [{ id: ENTRY_ID_1, text: 'Initial v1 body', version: 1 }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Initial v1 body');
    });

    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const textarea = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: PRE_LOCK_DRAFT } });

    // Server advances to version 2, and we return a 412 WITHOUT current_version so Keep mine must run fallback GET /entries/{id}
    await h.server.sealTextForEntry(ENTRY_ID_1, 'Remote v2 body', 2, 0);

    const { promise: getGate, resolve: releaseGet } = createDeferred();
    const { promise: fallbackGetEntered, resolve: notifyFallbackGetEntered } = createDeferred();
    let holdFallbackGet = false;

    h.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && method === 'PUT') {
        return problemResponse('version_mismatch', 412);
      }
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && method === 'GET' && holdFallbackGet) {
        notifyFallbackGetEntered();
        await getGate;
      }
      return null;
    });

    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(screen.getByTestId(`entry-conflict-412-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    // Stage 1 (race negative control): Click Keep mine while holding the fallback GET /entries/{id}
    holdFallbackGet = true;
    const sealSpy = vi.spyOn(h.vault().getClient(), 'sealEntry');
    const sealUpdateSpy = vi.spyOn(entriesModule, 'sealEntryUpdate');
    const putsBeforeKeepMine = h.server.requests.filter((r) => r.method === 'PUT').length;

    fireEvent.click(screen.getByTestId(`entry-conflict-keep-mine-${ENTRY_ID_1}`));
    await fallbackGetEntered;

    // Lock while the fallback GET is still held in flight -> reset callback synchronously wipes textarea and draft
    await h.lock();
    expect(screen.queryByTestId(`entry-edit-textarea-${ENTRY_ID_1}`)).toBeNull();
    expect(h.container.textContent).not.toContain(PRE_LOCK_DRAFT);
    assertNoPlaintextAttrs(h.container, [PRE_LOCK_DRAFT], { locked: true });
    expect(findCacheSentinelLeaks(h.qc, [PRE_LOCK_DRAFT])).toEqual([]);

    await h.unlock();

    holdFallbackGet = false;
    sealSpy.mockClear();
    sealUpdateSpy.mockClear();
    releaseGet();

    // Wait for the unlocked view to settle on the remote v2 body
    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Remote v2 body');
    });

    // Zero seal, zero PUT after the fallback GET released, and pre-lock draft is nowhere in DOM or caches
    expect(sealSpy).not.toHaveBeenCalled();
    expect(sealUpdateSpy).not.toHaveBeenCalled();
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(putsBeforeKeepMine);
    expect(screen.queryByTestId(`entry-edit-textarea-${ENTRY_ID_1}`)).toBeNull();
    expect(h.container.textContent).not.toContain(PRE_LOCK_DRAFT);
    assertNoPlaintextAttrs(h.container, [PRE_LOCK_DRAFT], { locked: true });
    expect(findCacheSentinelLeaks(h.qc, [PRE_LOCK_DRAFT])).toEqual([]);

    // Stage 2 (keyboard guard): Re-open editor, hit 412 conflict, and verify Save button is disabled and Ctrl+S sends nothing
    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const textareaAfter = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`) as HTMLTextAreaElement;
    fireEvent.change(textareaAfter, { target: { value: 'Post-unlock conflict draft' } });
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(screen.getByTestId(`entry-conflict-412-${ENTRY_ID_1}`)).toBeInTheDocument();
    });
    const putsBeforeCtrlS = h.server.requests.filter((r) => r.method === 'PUT').length;
    expect(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`)).toBeDisabled();
    fireEvent.keyDown(textareaAfter, { key: 's', ctrlKey: true });
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(putsBeforeCtrlS);

    // Verify the resettable editorPlaintextHolderRef itself is synchronously cleared to empty strings while fallback GET is held (IP15-BE2-1)
    const holderRef: { current: EditorPlaintextHolder } = {
      current: { originalSource: '', draftValue: '' },
    };
    const entryMeta = Array.from(h.server.entries.values())[0];
    h.rerenderPage(
      <TextEntryCard
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
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Remote v2 body');
    });
    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const holderTextarea = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`);
    fireEvent.change(holderTextarea, { target: { value: PRE_LOCK_DRAFT } });
    expect(holderRef.current.draftValue).toBe(PRE_LOCK_DRAFT);
    expect(holderRef.current.originalSource).toBe('Remote v2 body');

    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(screen.getByTestId(`entry-conflict-412-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const { promise: getGate2, resolve: releaseGet2 } = createDeferred();
    const { promise: fallbackGet2Entered, resolve: notifyFallbackGet2Entered } = createDeferred();
    h.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && method === 'GET') {
        notifyFallbackGet2Entered();
        await getGate2;
      }
      return null;
    });

    sealSpy.mockClear();
    sealUpdateSpy.mockClear();
    fireEvent.click(screen.getByTestId(`entry-conflict-keep-mine-${ENTRY_ID_1}`));
    await fallbackGet2Entered;

    // Lock while GET is still unresolved -> holderRef.current is synchronously wiped to empty strings
    await h.lock();
    expect(holderRef.current).toEqual({ originalSource: '', draftValue: '' });

    await h.unlock();
    expect(holderRef.current).toEqual({ originalSource: '', draftValue: '' });
    releaseGet2();
    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Remote v2 body');
    });
    expect(sealSpy).not.toHaveBeenCalled();
    expect(sealUpdateSpy).not.toHaveBeenCalled();
  });

  it('IP15-BE1-1 / BE1-7 / FE1-6: entry_nonce_reused ends with localized error and draft kept (exactly one PUT and one seal), and after lock/generation change no continuation holds or uses the draft plaintext', async () => {
    const NONCE_DRAFT_1 = 'NONCE-REUSED-DRAFT-ALPHA-7711';
    const NONCE_DRAFT_2 = 'NONCE-REUSED-DRAFT-BETA-7722';
    const h = await setupItemPageHarness({
      initialPlaintexts: [{ id: ENTRY_ID_1, text: 'Initial body for nonce test', version: 1 }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Initial body for nonce test');
    });

    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && init?.method === 'PUT') {
        return problemResponse('entry_nonce_reused', 400);
      }
      return null;
    });

    const sealSpy = vi.spyOn(h.vault().getClient(), 'sealEntry');
    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const textarea = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: NONCE_DRAFT_1 } });

    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    // 1. Unlocked 400 entry_nonce_reused: exactly ONE seal and ONE PUT, localized error shown, draft kept in editor
    await waitFor(() => {
      expect(screen.getByTestId(`entry-save-error-${ENTRY_ID_1}`)).toHaveTextContent(
        viMessages.content.errors.entry_nonce_reused,
      );
    });
    expect(sealSpy).toHaveBeenCalledTimes(1);
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    expect(textarea.value).toBe(NONCE_DRAFT_1);

    // 2. Defer the 400 entry_nonce_reused response across a lock -> unlock (generation change):
    // when the response arrives after unlock, no continuation holds or reseals the pre-lock draft
    const { promise: nonceGate, resolve: releaseNonceResponse } = createDeferred();
    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && init?.method === 'PUT') {
        await nonceGate;
        return problemResponse('entry_nonce_reused', 400);
      }
      return null;
    });

    fireEvent.change(textarea, { target: { value: NONCE_DRAFT_2 } });
    sealSpy.mockClear();
    const putsBeforeSecondSave = h.server.requests.filter((r) => r.method === 'PUT').length;

    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(
        putsBeforeSecondSave + 1,
      );
    });
    expect(sealSpy).toHaveBeenCalledTimes(1);

    // Lock and unlock while the PUT is in flight -> generation changes and editor resets
    await h.lock();
    await h.unlock();

    sealSpy.mockClear();
    const putsBeforeRelease = h.server.requests.filter((r) => r.method === 'PUT').length;
    releaseNonceResponse();

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Initial body for nonce test');
    });

    expect(sealSpy).not.toHaveBeenCalled();
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(putsBeforeRelease);
    expect(h.container.textContent).not.toContain(NONCE_DRAFT_1);
    expect(h.container.textContent).not.toContain(NONCE_DRAFT_2);
    assertNoPlaintextAttrs(h.container, [NONCE_DRAFT_1, NONCE_DRAFT_2]);
    expect(findCacheSentinelLeaks(h.qc, [NONCE_DRAFT_1, NONCE_DRAFT_2])).toEqual([]);
  });

  it('editing name, Tab, editing hint, blur in one network round sends two ordered PATCHes using the returned version (no 412) and final item has both; renaming to another item name works; PATCH 412 keeps typed value', async () => {
    const h = await setupItemPageHarness();

    await waitFor(() => {
      expect(screen.getByTestId('item-name-input')).toHaveValue('wifi');
    });

    const { promise: firstPatchGate, resolve: releaseFirstPatch } = createDeferred();
    let patchCount = 0;

    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith(`/items/${ITEM_ID}`) && init?.method === 'PATCH') {
        patchCount += 1;
        if (patchCount === 1) {
          await firstPatchGate;
        }
      }
      return null;
    });

    const nameInput = screen.getByTestId('item-name-input');
    const hintInput = screen.getByTestId('item-hint-input');

    // Type duplicate item name (allowed, not unique) and blur (Tab) -> enqueues PATCH #1
    fireEvent.change(nameInput, { target: { value: 'duplicate-existing-item-name' } });
    fireEvent.blur(nameInput);

    // Immediately edit hint and blur while PATCH #1 is still in flight -> enqueues PATCH #2
    fireEvent.change(hintInput, { target: { value: 'updated hint value' } });
    fireEvent.blur(hintInput);

    // Only PATCH #1 should have been sent so far
    await waitFor(() => {
      expect(
        h.server.requests.filter((r) => r.method === 'PATCH' && r.url.endsWith(`/items/${ITEM_ID}`)),
      ).toHaveLength(1);
    });

    // Release PATCH #1 -> PATCH #2 now runs with If-Match: "2" (version returned by PATCH #1)
    releaseFirstPatch();

    await waitFor(() => {
      expect(
        h.server.requests.filter((r) => r.method === 'PATCH' && r.url.endsWith(`/items/${ITEM_ID}`)),
      ).toHaveLength(2);
    });

    const itemPatches = h.server.requests.filter(
      (r) => r.method === 'PATCH' && r.url.endsWith(`/items/${ITEM_ID}`),
    );
    expect(itemPatches[0].headers['if-match']).toBe('"1"');
    expect(JSON.parse(itemPatches[0].rawBody)).toEqual({
      name: 'duplicate-existing-item-name',
    });
    expect(itemPatches[1].headers['if-match']).toBe('"2"');
    expect(JSON.parse(itemPatches[1].rawBody)).toEqual({
      hint: 'updated hint value',
    });

    expect(h.server.item.name).toBe('duplicate-existing-item-name');
    expect(h.server.item.hint).toBe('updated hint value');
    expect(h.server.item.version).toBe(3);
    expect(screen.queryByTestId('item-header-conflict-412')).toBeNull();

    // Now simulate remote edit bumping serverItem.version to 4, then local PATCH name -> 412 keeps typed value
    h.server.item.version = 4;
    h.server.item.name = 'remote-name-v4';

    // 1. Item 412 "Keep mine": overwrites using the latest server version (4 -> 5)
    fireEvent.change(nameInput, { target: { value: 'my-conflicting-typed-name' } });
    fireEvent.blur(nameInput);

    await waitFor(() => {
      expect(screen.getByTestId('item-header-conflict-412')).toBeInTheDocument();
    });
    expect(nameInput).toHaveValue('my-conflicting-typed-name');

    fireEvent.click(screen.getByTestId('item-conflict-keep-mine'));

    await waitFor(() => {
      expect(screen.queryByTestId('item-header-conflict-412')).toBeNull();
      expect(h.server.item.version).toBe(5);
      expect(h.server.item.name).toBe('my-conflicting-typed-name');
    });

    // 2. Item 412 "Load latest": discards typed value and loads the latest server name/hint (version 6)
    h.server.item.version = 6;
    h.server.item.name = 'remote-latest-name-v6';
    h.server.item.hint = 'remote-latest-hint-v6';

    fireEvent.change(nameInput, { target: { value: 'local-discarded-name' } });
    fireEvent.blur(nameInput);

    await waitFor(() => {
      expect(screen.getByTestId('item-header-conflict-412')).toBeInTheDocument();
    });
    expect(nameInput).toHaveValue('local-discarded-name');

    fireEvent.click(screen.getByTestId('item-conflict-load-latest'));

    await waitFor(() => {
      expect(screen.queryByTestId('item-header-conflict-412')).toBeNull();
      expect(nameInput).toHaveValue('remote-latest-name-v6');
      expect(hintInput).toHaveValue('remote-latest-hint-v6');
    });
  });

  it('IP15-BE1-4: stops draining item PATCH queue on an uncertain outcome, retains exact If-Match/body/Idempotency-Key for Retry, and then sends queued hint using the confirmed version', async () => {
    const h = await setupItemPageHarness();

    await waitFor(() => {
      expect(screen.getByTestId('item-name-input')).toHaveValue('wifi');
    });

    // Simulate a committed name PATCH on the server whose responses are all lost (network drop),
    // while a hint PATCH is already queued behind it.
    let dropNamePatchResponses = true;
    let committedNameIdempotencyKey: string | null = null;
    let committedNameSnapshot: ItemSummary | null = null;

    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith(`/items/${ITEM_ID}`) && init?.method === 'PATCH') {
        const rawBody = typeof init.body === 'string' ? init.body : '';
        const parsed = JSON.parse(rawBody) as ItemUpdateRequest;
        const headersObj =
          init.headers instanceof Headers
            ? Object.fromEntries(init.headers.entries())
            : (init.headers as Record<string, string> | undefined) ?? {};
        const idemKey =
          headersObj['Idempotency-Key'] ?? headersObj['idempotency-key'] ?? '';

        if (parsed.name !== undefined) {
          if (!committedNameSnapshot) {
            // Server commits the name update on first attempt (version 1 -> 2), then response is lost
            committedNameIdempotencyKey = idemKey;
            h.server.item.name = parsed.name;
            h.server.item.version = 2;
            committedNameSnapshot = { ...h.server.item };
          }
          if (dropNamePatchResponses) {
            throw new TypeError('Failed to fetch');
          }
          // Idempotent replay with the same key returns the stored response without re-checking If-Match
          if (idemKey === committedNameIdempotencyKey && committedNameSnapshot) {
            return jsonResponse(committedNameSnapshot, 200);
          }
        }
      }
      return null;
    });

    const nameInput = screen.getByTestId('item-name-input');
    const hintInput = screen.getByTestId('item-hint-input');

    // Enqueue name PATCH #1 and hint PATCH #2 in one round
    fireEvent.change(nameInput, { target: { value: 'wifi-committed-uncertain' } });
    fireEvent.blur(nameInput);
    fireEvent.change(hintInput, { target: { value: 'hint-queued-after-uncertain' } });
    fireEvent.blur(hintInput);

    // Wait for shared auto-retries to exhaust and the uncertain Retry box to appear
    await waitFor(() => {
      expect(screen.getByTestId('item-patch-uncertain-retry-box')).toBeInTheDocument();
    });

    // Verify the queued hint PATCH was NOT sent while name outcome was uncertain (no self-412!)
    const patchesBeforeRetry = h.server.requests.filter(
      (r) => r.method === 'PATCH' && r.url.endsWith(`/items/${ITEM_ID}`),
    );
    expect(patchesBeforeRetry.length).toBeGreaterThanOrEqual(1);
    for (const req of patchesBeforeRetry) {
      expect(JSON.parse(req.rawBody)).toEqual({ name: 'wifi-committed-uncertain' });
      expect(req.headers['if-match']).toBe('"1"');
      expect(req.headers['idempotency-key']).toBe(committedNameIdempotencyKey);
    }
    expect(screen.queryByTestId('item-header-conflict-412')).toBeNull();

    // Now allow network responses through and click Retry
    dropNamePatchResponses = false;
    fireEvent.click(screen.getByTestId('item-patch-retry-btn'));

    // Retry replays the exact name PATCH (same Idempotency-Key, If-Match: "1", body), receives v2,
    // and then drains the queued hint PATCH using If-Match: "2"
    await waitFor(() => {
      expect(screen.queryByTestId('item-patch-uncertain-retry-box')).toBeNull();
      expect(h.server.item.version).toBe(3);
    });

    const allPatches = h.server.requests.filter(
      (r) => r.method === 'PATCH' && r.url.endsWith(`/items/${ITEM_ID}`),
    );
    const replayedNamePatch = allPatches[allPatches.length - 2];
    const drainedHintPatch = allPatches[allPatches.length - 1];

    expect(replayedNamePatch.headers['idempotency-key']).toBe(committedNameIdempotencyKey);
    expect(replayedNamePatch.headers['if-match']).toBe('"1"');
    expect(JSON.parse(replayedNamePatch.rawBody)).toEqual({
      name: 'wifi-committed-uncertain',
    });

    expect(drainedHintPatch.headers['if-match']).toBe('"2"');
    expect(JSON.parse(drainedHintPatch.rawBody)).toEqual({
      hint: 'hint-queued-after-uncertain',
    });
    expect(h.server.item.name).toBe('wifi-committed-uncertain');
    expect(h.server.item.hint).toBe('hint-queued-after-uncertain');
    expect(screen.queryByTestId('item-header-conflict-412')).toBeNull();
  });

  it('Move up x3 fast sends exactly ONE reorder request after 400 ms; reorder then leave within 400 ms still sends the request immediately', async () => {
    const h = await setupItemPageHarness({
      initialPlaintexts: [
        { id: ENTRY_ID_1, text: 'Entry 1', position: 0 },
        { id: ENTRY_ID_2, text: 'Entry 2', position: 1 },
        { id: ENTRY_ID_3, text: 'Entry 3', position: 2 },
        { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', text: 'Entry 4', position: 3 },
      ],
    });

    const ENTRY_ID_4 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

    await waitFor(() => {
      expect(screen.getByTestId(`entry-card-${ENTRY_ID_4}`)).toBeInTheDocument();
    });

    vi.useFakeTimers();
    try {
      // Move ENTRY_ID_4 up 3 times fast (< 400 ms between moves)
      for (let i = 0; i < 3; i++) {
        fireEvent.click(screen.getByTestId(`entry-menu-trigger-${ENTRY_ID_4}`));
        fireEvent.click(screen.getByTestId(`entry-menu-up-${ENTRY_ID_4}`));
        await act(async () => {
          vi.advanceTimersByTime(100);
        });
      }

      // Live region announced position 1/4
      expect(screen.getByTestId('item-page-live-region')).toHaveTextContent(
        'Đã chuyển lên vị trí 1/4',
      );

      // Before 400 ms idle: 0 reorder requests sent
      expect(
        h.server.requests.filter((r) => r.url.endsWith('/entries/reorder')),
      ).toHaveLength(0);

      // Advance past 400 ms idle -> exactly ONE reorder request with full permutation
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() => {
      expect(
        h.server.requests.filter((r) => r.url.endsWith('/entries/reorder')),
      ).toHaveLength(1);
    });
    const firstReorder = JSON.parse(
      h.server.requests.find((r) => r.url.endsWith('/entries/reorder'))!.rawBody,
    ) as { entry_ids: string[] };
    expect(firstReorder.entry_ids).toEqual([
      ENTRY_ID_4,
      ENTRY_ID_1,
      ENTRY_ID_2,
      ENTRY_ID_3,
    ]);

    // Now move ENTRY_ID_3 up once and unmount (leave page) within 400 ms -> request is flushed immediately
    fireEvent.click(screen.getByTestId(`entry-menu-trigger-${ENTRY_ID_3}`));
    fireEvent.click(screen.getByTestId(`entry-menu-up-${ENTRY_ID_3}`));

    // Unmount page before 400 ms timer fires
    h.rerenderPage(<div data-testid="left-page">Left page</div>);

    await waitFor(() => {
      expect(
        h.server.requests.filter((r) => r.url.endsWith('/entries/reorder')),
      ).toHaveLength(2);
    });
    const secondReorder = JSON.parse(
      h.server.requests.filter((r) => r.url.endsWith('/entries/reorder'))[1].rawBody,
    ) as { entry_ids: string[] };
    expect(secondReorder.entry_ids).toEqual([
      ENTRY_ID_4,
      ENTRY_ID_1,
      ENTRY_ID_3,
      ENTRY_ID_2,
    ]);
  });

  it('IP15-BE1-6 / FE1-3 / FE1-4: single-flights overlapping reorder PATCHes and flushes pending debounce on visibilitychange (hidden), pagehide, and vault lock', async () => {
    const h = await setupItemPageHarness({
      initialPlaintexts: [
        { id: ENTRY_ID_1, text: 'Entry 1', position: 0 },
        { id: ENTRY_ID_2, text: 'Entry 2', position: 1 },
        { id: ENTRY_ID_3, text: 'Entry 3', position: 2 },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`entry-card-${ENTRY_ID_3}`)).toBeInTheDocument();
    });

    // Part 1: Single-flight reorder when a second move occurs >400 ms while the first PATCH is held
    const { promise: firstReorderGate, resolve: releaseFirstReorder } = createDeferred();
    let activeReorderInFlight = 0;
    let maxConcurrentReorders = 0;
    let reorderCallCount = 0;

    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith('/entries/reorder') && init?.method === 'PATCH') {
        reorderCallCount += 1;
        activeReorderInFlight += 1;
        maxConcurrentReorders = Math.max(maxConcurrentReorders, activeReorderInFlight);
        try {
          if (reorderCallCount === 1) {
            await firstReorderGate;
          }
          return null;
        } finally {
          activeReorderInFlight -= 1;
        }
      }
      return null;
    });

    vi.useFakeTimers();
    try {
      // Move 1: ENTRY_ID_3 up -> [1, 3, 2], debounce 400 ms -> fires PATCH #1 (held)
      fireEvent.click(screen.getByTestId(`entry-menu-trigger-${ENTRY_ID_3}`));
      fireEvent.click(screen.getByTestId(`entry-menu-up-${ENTRY_ID_3}`));
      await act(async () => {
        vi.advanceTimersByTime(450);
      });
      expect(reorderCallCount).toBe(1);

      // Move 2 while PATCH #1 is still in flight: ENTRY_ID_3 up again -> [3, 1, 2], advance 450 ms
      fireEvent.click(screen.getByTestId(`entry-menu-trigger-${ENTRY_ID_3}`));
      fireEvent.click(screen.getByTestId(`entry-menu-up-${ENTRY_ID_3}`));
      await act(async () => {
        vi.advanceTimersByTime(450);
      });

      // Because PATCH #1 is in flight, PATCH #2 must NOT have been sent concurrently
      expect(reorderCallCount).toBe(1);
      expect(maxConcurrentReorders).toBe(1);
    } finally {
      vi.useRealTimers();
    }

    // Release PATCH #1 -> finally immediately flushes PATCH #2 with the latest intent [3, 1, 2]
    releaseFirstReorder();

    await waitFor(() => {
      expect(reorderCallCount).toBe(2);
    });
    expect(maxConcurrentReorders).toBe(1);

    const reorderReqs = h.server.requests.filter((r) => r.url.endsWith('/entries/reorder'));
    expect(JSON.parse(reorderReqs[0].rawBody)).toEqual({
      entry_ids: [ENTRY_ID_1, ENTRY_ID_3, ENTRY_ID_2],
    });
    expect(JSON.parse(reorderReqs[1].rawBody)).toEqual({
      entry_ids: [ENTRY_ID_3, ENTRY_ID_1, ENTRY_ID_2],
    });
    const cardsAfterOverlap = getRenderedEntryCardIds(h.container);
    expect(cardsAfterOverlap).toEqual([ENTRY_ID_3, ENTRY_ID_1, ENTRY_ID_2]);

    // Part 2: Flush immediately on visibilitychange (hidden) before 400 ms debounce expires
    fireEvent.click(screen.getByTestId(`entry-menu-trigger-${ENTRY_ID_2}`));
    fireEvent.click(screen.getByTestId(`entry-menu-up-${ENTRY_ID_2}`));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    fireEvent(document, new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    await waitFor(() => {
      expect(reorderCallCount).toBe(3);
    });

    // Part 3: Flush immediately on pagehide before 400 ms debounce expires
    fireEvent.click(screen.getByTestId(`entry-menu-trigger-${ENTRY_ID_2}`));
    fireEvent.click(screen.getByTestId(`entry-menu-up-${ENTRY_ID_2}`));
    fireEvent(window, new Event('pagehide'));

    await waitFor(() => {
      expect(reorderCallCount).toBe(4);
    });

    // Part 4: Flush immediately on vault lock before 400 ms debounce expires
    fireEvent.click(screen.getByTestId(`entry-menu-trigger-${ENTRY_ID_1}`));
    fireEvent.click(screen.getByTestId(`entry-menu-up-${ENTRY_ID_1}`));
    await h.lock();

    await waitFor(() => {
      expect(reorderCallCount).toBe(5);
    });
  });

  it('disables + Tag chip at 20 tags with tooltip, and disables + Text at 200 entries', async () => {
    const twentyTags = Array.from({ length: 20 }, (_, i) => ({
      id: `tag-${i + 1}`,
      display: `t${i + 1}`,
    }));
    const h = await setupItemPageHarness({
      initialItem: makeItemSummary({ tags: twentyTags, entry_count: 200 }),
      initialPlaintexts: [],
    });

    // Populate 200 entries metadata on server
    for (let i = 0; i < 200; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      h.server.entries.set(id, {
        id,
        item_id: ITEM_ID,
        type: 'text',
        position: i,
        version: 1,
        plaintext_len_bucket: 256,
        envelope: {
          v: 1,
          alg: 'xchacha20poly1305-ietf',
          key_id: KEY_ID,
          nonce: 'AAAAAAAAAAAAAAAAAAAAAAAA',
          ct_enc: 'utf8',
        },
        ciphertext: 'BBBBBBBBBBBBBBBBBBBBBBBB',
        created_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-01T00:00:00Z',
      });
    }
    await act(async () => {
      await h.qc.invalidateQueries();
    });

    await waitFor(() => {
      const addTagChip = screen.getByTestId('tag-add-chip');
      expect(addTagChip).toBeDisabled();
      expect(addTagChip).toHaveAttribute('title', viMessages.content.item.tagLimitTooltip);
    });

    await waitFor(() => {
      const addTextBtn = screen.getByTestId('btn-add-text');
      expect(addTextBtn).toBeDisabled();
    });

    // Also verifies batch rendering: only 20 cards rendered initially out of 200, then load more reveals the next 20-card batch (40, then 60)
    expect(h.container.querySelectorAll('[data-entry-card]')).toHaveLength(20);
    const loadMoreBtn = screen.getByTestId('entries-load-more-btn');
    fireEvent.click(loadMoreBtn);
    await waitFor(() => {
      expect(h.container.querySelectorAll('[data-entry-card]')).toHaveLength(40);
    });
    fireEvent.click(screen.getByTestId('entries-load-more-btn'));
    await waitFor(() => {
      expect(h.container.querySelectorAll('[data-entry-card]')).toHaveLength(60);
    });
  });

  it('delete entry -> focuses next card -> Undo -> restores entry back at the same position and focuses restored card', async () => {
    const h = await setupItemPageHarness({
      initialPlaintexts: [
        { id: ENTRY_ID_1, text: 'First card', position: 0 },
        { id: ENTRY_ID_2, text: 'Second card', position: 1 },
        { id: ENTRY_ID_3, text: 'Third card', position: 2 },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`entry-card-${ENTRY_ID_1}`)).toBeInTheDocument();
      expect(screen.getByTestId(`entry-card-${ENTRY_ID_2}`)).toBeInTheDocument();
      expect(screen.getByTestId(`entry-card-${ENTRY_ID_3}`)).toBeInTheDocument();
    });

    // Delete the middle card (ENTRY_ID_2 at index 1)
    fireEvent.click(screen.getByTestId(`entry-menu-trigger-${ENTRY_ID_2}`));
    fireEvent.click(screen.getByTestId(`entry-menu-delete-${ENTRY_ID_2}`));

    await waitFor(() => {
      expect(screen.queryByTestId(`entry-card-${ENTRY_ID_2}`)).toBeNull();
    });

    // Focus moved to next card (ENTRY_ID_3)
    await waitFor(() => {
      const card3 = screen.getByTestId(`entry-card-${ENTRY_ID_3}`);
      expect(card3.contains(document.activeElement)).toBe(true);
    });


    // Click Undo on the Undo toast while holding the restore response, then verify restored position and post-commit focus (IP15-FE1-5)
    const undoBtn = await screen.findByRole('button', { name: /Hoàn tác/i });
    const { promise: restoreGate, resolve: releaseRestore } = createDeferred();
    const { promise: restoreEntered, resolve: notifyRestoreEntered } = createDeferred();
    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith(`/entries/${ENTRY_ID_2}/restore`) && init?.method === 'POST') {
        notifyRestoreEntered();
        await restoreGate;
      }
      return null;
    });
    fireEvent.click(undoBtn);
    await restoreEntered;
    releaseRestore();
    // ENTRY_ID_2 is back at position #2 (index 1, between ENTRY_ID_1 and ENTRY_ID_3)
    await waitFor(() => {
      expect(screen.getByTestId(`entry-card-${ENTRY_ID_2}`)).toBeInTheDocument();
    });

    const cardsAfterUndo = getRenderedEntryCardIds(h.container);
    expect(cardsAfterUndo).toEqual([ENTRY_ID_1, ENTRY_ID_2, ENTRY_ID_3]);
    // Focus moved back to restored card (ENTRY_ID_2)
    await waitFor(() => {
      const card2 = screen.getByTestId(`entry-card-${ENTRY_ID_2}`);
      expect(card2.contains(document.activeElement)).toBe(true);
    });
  });

  it('passes assert-no-plaintext-attrs while unlocked, after lock, and after a failed save; locking while editing clears textarea, draft, and caches, and shows draftClearedOnLock after unlock', async () => {
    const SENTINEL_BODY = 'SENTINEL-BODY-PLAIN-99182';
    const SENTINEL_DRAFT = 'SENTINEL-UNSAVED-DRAFT-77412';

    const h = await setupItemPageHarness({
      initialPlaintexts: [{ id: ENTRY_ID_1, text: SENTINEL_BODY }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent(SENTINEL_BODY);
    });

    // 1. Unlocked view: no sentinel in any DOM attribute
    assertNoPlaintextAttrs(h.container, [SENTINEL_BODY]);

    // 2. Open editor, type draft, fail save (network error) -> check assert-no-plaintext-attrs and MutationCache
    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && init?.method === 'PUT') {
        throw new TypeError('Failed to fetch');
      }
      return null;
    });

    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const textarea = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: SENTINEL_DRAFT } });
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(screen.getByTestId(`entry-save-retry-box-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    // After failed save: no sentinel in DOM attributes or caches
    assertNoPlaintextAttrs(h.container, [SENTINEL_BODY, SENTINEL_DRAFT]);
    expect(findCacheSentinelLeaks(h.qc, [SENTINEL_DRAFT])).toEqual([]);

    // 3. Lock while editing with unsaved draft -> textarea cleared & closed, zero sentinel in DOM, QueryCache, MutationCache
    await h.lock();

    expect(screen.queryByTestId(`entry-edit-textarea-${ENTRY_ID_1}`)).toBeNull();
    expect(h.container.textContent).not.toContain(SENTINEL_BODY);
    expect(h.container.textContent).not.toContain(SENTINEL_DRAFT);
    assertNoPlaintextAttrs(h.container, [SENTINEL_BODY, SENTINEL_DRAFT], { locked: true });
    expect(h.qc.getQueriesData({ queryKey: VAULT_BODY_QUERY_KEY_PREFIX })).toEqual([]);
    expect(findCacheSentinelLeaks(h.qc, [SENTINEL_BODY, SENTINEL_DRAFT])).toEqual([]);

    // 4. Unlock again -> shows "Bản nháp chưa lưu đã bị xoá khi khoá vault"
    await h.unlock();
    await waitFor(() => {
      expect(screen.getByTestId('draft-cleared-on-lock-banner')).toHaveTextContent(
        viMessages.content.entry.draftClearedOnLock,
      );
    });
  }, 30_000);

  it('Esc on clean editor closes immediately; Esc on dirty editor shows inline "Bỏ thay đổi?" confirm; mixed EOL shows conversion warning before saving; Retry resends exact same bytes and Idempotency-Key', async () => {
    const mixedEolText = 'line1\r\nline2\nline3';
    const h = await setupItemPageHarness({
      initialPlaintexts: [{ id: ENTRY_ID_1, text: mixedEolText }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toBeInTheDocument();
    });

    // 1. Clean Esc closes immediately without confirmation prompt
    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const textarea = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`);
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(screen.queryByTestId(`entry-edit-textarea-${ENTRY_ID_1}`)).toBeNull();
    expect(screen.queryByTestId(`entry-discard-confirm-${ENTRY_ID_1}`)).toBeNull();

    // 2. Dirty Esc shows inline "Bỏ thay đổi?" prompt; Keep editing keeps editor open; Discard closes it
    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const textarea2 = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`);
    fireEvent.change(textarea2, { target: { value: 'line1\nline2-edited\nline3' } });
    fireEvent.keyDown(textarea2, { key: 'Escape' });

    expect(screen.getByTestId(`entry-discard-confirm-${ENTRY_ID_1}`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`entry-keep-editing-btn-${ENTRY_ID_1}`));
    expect(screen.queryByTestId(`entry-discard-confirm-${ENTRY_ID_1}`)).toBeNull();
    expect(screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`)).toBeInTheDocument();

    // 3. Mixed EOL warning before save
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    expect(screen.getByTestId(`entry-mixed-eol-warning-${ENTRY_ID_1}`)).toBeInTheDocument();
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);

    // 4. Fail PUT on first attempt, then click Retry -> resends exact same bytes & Idempotency-Key
    let failPut = true;
    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && init?.method === 'PUT' && failPut) {
        return problemResponse('dependency_unavailable', 503);
      }
      return null;
    });

    fireEvent.click(screen.getByTestId(`entry-confirm-mixed-eol-save-${ENTRY_ID_1}`));

    await waitFor(
      () => {
        expect(screen.getByTestId(`entry-save-retry-box-${ENTRY_ID_1}`)).toBeInTheDocument();
      },
      { timeout: 5_000 },
    );

    const failedPuts = h.server.requests.filter((r) => r.method === 'PUT');
    expect(failedPuts.length).toBeGreaterThanOrEqual(1);
    const firstIdempotencyKey = failedPuts[0].headers['idempotency-key'];
    const firstRawBody = failedPuts[0].rawBody;

    failPut = false;
    fireEvent.click(screen.getByTestId(`entry-retry-save-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('line2-edited');
    });

    const allPuts = h.server.requests.filter((r) => r.method === 'PUT');
    const lastPut = allPuts[allPuts.length - 1];
    expect(lastPut.headers['idempotency-key']).toBe(firstIdempotencyKey);
    expect(lastPut.rawBody).toBe(firstRawBody);
  }, 30_000);

  it('tag chips: suggests via GET /tags?q=, attaches via POST /tags + POST /items/{id}/tags, and removes via DELETE /items/{id}/tags/{tag_id}', async () => {
    const h = await setupItemPageHarness();

    await waitFor(() => {
      expect(screen.getByTestId('item-tag-chip-nhà')).toBeInTheDocument();
    });

    expect(screen.getByTestId('item-tags')).toHaveAttribute('role', 'group');
    // Open tag popover and type prefix "mạng"
    fireEvent.click(screen.getByTestId('tag-add-chip'));
    const tagInput = screen.getByTestId('tag-suggest-input');
    fireEvent.change(tagInput, { target: { value: 'mạng' } });

    await waitFor(() => {
      expect(
        h.server.requests.some((r) => r.method === 'GET' && r.url.includes('/api/v1/tags?q=m%E1%BA%A1ng')),
      ).toBe(true);
      expect(screen.getByTestId('tag-suggest-option-mạng-nhà')).toBeInTheDocument();
    });

    // IP15-FE1-7: ArrowDown/Home/End + Enter selects the highlighted suggestion via aria-activedescendant
    expect(tagInput).toHaveAttribute('aria-activedescendant', 'tag-suggest-opt-tag-3');
    fireEvent.keyDown(tagInput, { key: 'ArrowDown' });
    expect(tagInput).toHaveAttribute('aria-activedescendant', 'tag-suggest-opt-create');
    fireEvent.keyDown(tagInput, { key: 'Home' });
    expect(tagInput).toHaveAttribute('aria-activedescendant', 'tag-suggest-opt-tag-3');

    // Create and attach a brand new tag "mạng-mới" via Enter / Add button
    fireEvent.change(tagInput, { target: { value: 'mạng-mới' } });
    fireEvent.click(screen.getByTestId('tag-attach-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('item-tag-chip-mạng-mới')).toBeInTheDocument();
    });
    expect(
      h.server.requests.some((r) => r.method === 'POST' && r.url.endsWith('/api/v1/tags')),
    ).toBe(true);
    expect(
      h.server.requests.some(
        (r) => r.method === 'POST' && r.url.endsWith(`/api/v1/items/${ITEM_ID}/tags`),
      ),
    ).toBe(true);

    // Remove tag "office" via × button
    fireEvent.click(screen.getByTestId('item-tag-remove-office'));
    await waitFor(() => {
      expect(screen.queryByTestId('item-tag-chip-office')).toBeNull();
    });
    expect(
      h.server.requests.some(
        (r) => r.method === 'DELETE' && r.url.endsWith(`/api/v1/items/${ITEM_ID}/tags/tag-2`),
      ),
    ).toBe(true);
  });

  it('IP15-BE1-5: delayed tag response carrying an older version does not lower latestVersionRef or overwrite newer committed name/hint', async () => {
    const h = await setupItemPageHarness();

    await waitFor(() => {
      expect(screen.getByTestId('item-name-input')).toHaveValue('wifi');
    });

    const { promise: tagGate, resolve: releaseTagResponse } = createDeferred();
    let capturedStaleTagSummary: ItemSummary | null = null;

    h.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/items/${ITEM_ID}/tags/tag-2`) && method === 'DELETE') {
        // Snapshot stale item summary at version 1 before the name PATCH commits
        capturedStaleTagSummary = {
          ...h.server.item,
          version: 1,
          name: 'wifi',
          tags: h.server.item.tags.filter((t) => t.id !== 'tag-2'),
        };
        h.server.item.tags = capturedStaleTagSummary.tags;
        await tagGate;
        return jsonResponse(capturedStaleTagSummary, 200);
      }
      return null;
    });

    // 1. Trigger tag removal (held in flight with snapshot at version 1)
    fireEvent.click(screen.getByTestId('item-tag-remove-office'));
    await waitFor(() => {
      expect(capturedStaleTagSummary).not.toBeNull();
    });

    // 2. Complete a name PATCH while the tag response is still in flight -> advances item to version 2
    const nameInput = screen.getByTestId('item-name-input');
    fireEvent.change(nameInput, { target: { value: 'wifi-v2-committed' } });
    fireEvent.blur(nameInput);

    await waitFor(() => {
      expect(h.server.item.version).toBe(2);
      expect(h.server.item.name).toBe('wifi-v2-committed');
    });

    // 3. Release the delayed tag response carrying version 1 and old name 'wifi'
    releaseTagResponse();

    await waitFor(() => {
      expect(screen.queryByTestId('item-tag-chip-office')).toBeNull();
    });

    // Committed name 'wifi-v2-committed' is preserved in the input and cache
    expect(screen.getByTestId('item-name-input')).toHaveValue('wifi-v2-committed');

    // 4. Now edit and blur hint -> must send If-Match: "2" (not "1"!) and succeed without 412
    const hintInput = screen.getByTestId('item-hint-input');
    fireEvent.change(hintInput, { target: { value: 'hint-after-stale-tag-response' } });
    fireEvent.blur(hintInput);

    await waitFor(() => {
      expect(h.server.item.version).toBe(3);
      expect(h.server.item.hint).toBe('hint-after-stale-tag-response');
    });

    const patches = h.server.requests.filter(
      (r) => r.method === 'PATCH' && r.url.endsWith(`/items/${ITEM_ID}`),
    );
    expect(patches).toHaveLength(2);
    expect(patches[0].headers['if-match']).toBe('"1"');
    expect(patches[1].headers['if-match']).toBe('"2"');
    expect(screen.queryByTestId('item-header-conflict-412')).toBeNull();
  });

  it('409 reorder_mismatch refetches list and re-applies the last move once if both entries still exist, or shows "Danh sách đã đổi ở thiết bị khác" if an entry was removed', async () => {
    const h = await setupItemPageHarness({
      initialPlaintexts: [
        { id: ENTRY_ID_1, text: 'Entry 1', position: 0 },
        { id: ENTRY_ID_2, text: 'Entry 2', position: 1 },
        { id: ENTRY_ID_3, text: 'Entry 3', position: 2 },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`entry-card-${ENTRY_ID_3}`)).toBeInTheDocument();
    });

    // Case 1: 409 on first reorder, both entries still exist -> refetches and re-applies once
    let reorderAttempt = 0;
    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith('/entries/reorder') && init?.method === 'PATCH') {
        reorderAttempt += 1;
        if (reorderAttempt === 1) {
          return problemResponse('reorder_mismatch', 409);
        }
      }
      return null;
    });

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId(`entry-menu-trigger-${ENTRY_ID_3}`));
      fireEvent.click(screen.getByTestId(`entry-menu-up-${ENTRY_ID_3}`));
      await act(async () => {
        vi.advanceTimersByTime(450);
      });
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() => {
      expect(reorderAttempt).toBe(2);
    });
    expect(screen.queryByTestId('reorder-mismatch-banner')).toBeNull();

    // Case 2: 409 on reorder and one of the moved entries no longer exists on server -> shows "Danh sách đã đổi ở thiết bị khác"
    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith('/entries/reorder') && init?.method === 'PATCH') {
        // Delete ENTRY_ID_3 on server before refetch happens
        const e3 = h.server.entries.get(ENTRY_ID_3);
        if (e3) e3.deleted = true;
        return problemResponse('reorder_mismatch', 409);
      }
      return null;
    });

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId(`entry-menu-trigger-${ENTRY_ID_3}`));
      fireEvent.click(screen.getByTestId(`entry-menu-up-${ENTRY_ID_3}`));
      await act(async () => {
        vi.advanceTimersByTime(450);
      });
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() => {
      expect(screen.getByTestId('reorder-mismatch-banner')).toHaveTextContent(
        viMessages.content.item.reorderMismatchNotice,
      );
    });
  });

  it('session_invalid on uncertain entry PUT drops draft without replay, records saveUnconfirmed across terminal error until same-user re-login, and clears on explicit logout or user switch through real SessionProvider (advisor-dec-120, IP15-BE1-8, FE1-9)', async () => {
    const h = await setupItemPageHarness({
      initialPlaintexts: [{ id: ENTRY_ID_1, text: 'Secret for User A' }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Secret for User A');
    });

    let failPutWithSessionInvalid = true;
    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && init?.method === 'PUT' && failPutWithSessionInvalid) {
        return problemResponse('session_invalid', 401);
      }
      return null;
    });

    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const textarea = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`);
    fireEvent.change(textarea, { target: { value: 'Uncertain draft before session_invalid' } });
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    // 1. Terminal session_invalid boundary: editor closes, draft dropped, and record survives signed_out(reason='invalid')
    // so when User A re-logs in, the saveUnconfirmed banner is shown
    await waitFor(() => {
      expect(getUnconfirmedSavesSnapshot()).toHaveLength(1);
      expect(getUnconfirmedSavesSnapshot()[0].userId).toBe(USER_A_ID);
    });

    // Re-login as User A via real SessionProvider.login
    h.setCurrentMe(makeMe(USER_A_ID, 'present'));
    await h.loginSession('a@example.test', 'pw');
    await waitFor(() => {
      expect(screen.getByTestId('entry-save-unconfirmed-banner')).toHaveTextContent('wifi');
    });

    // 2. Navigate away from the item page (unmount ItemDetailPage) and call explicit SessionProvider.signOut()
    // -> clears the unconfirmed-save store even when no item page is mounted
    h.rerenderPage(<div data-testid="away-from-item-page">Away</div>);
    await h.signOutSession();
    expect(getUnconfirmedSavesSnapshot()).toEqual([]);

    // Wait for VaultProvider's async lock() on signed_out to settle before re-logging in
    await waitFor(() => {
      expect(h.vault().inFlight).toBe(false);
      expect(h.vault().state).toBe('no_vault');
    });

    // Re-login as User A and remount ItemDetailPage -> banner is gone because explicit logout cleared it
    await h.loginSession('a@example.test', 'pw');
    await waitFor(() => {
      expect(h.vault().state).toBe('locked');
      expect(h.vault().inFlight).toBe(false);
    });
    h.rerenderPage();
    expect(screen.queryByTestId('entry-save-unconfirmed-banner')).toBeNull();

    // 3. Trigger another session_invalid for User A, then log in as User B via real SessionProvider.login
    await h.unlock();
    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Secret for User A');
    });
    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const textarea2 = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`);
    fireEvent.change(textarea2, { target: { value: 'Second uncertain draft for User A' } });
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(getUnconfirmedSavesSnapshot()).toHaveLength(1);
    });

    failPutWithSessionInvalid = false;
    h.setCurrentMe(makeMe(USER_B_ID, 'present'));
    await h.loginSession('b@example.test', 'pw');

    await waitFor(() => {
      expect(getUnconfirmedSavesSnapshot()).toEqual([]);
      expect(screen.queryByTestId('entry-save-unconfirmed-banner')).toBeNull();
    });
  });

  it('"+ Văn bản" creates a new text entry via sealNewEntry + POST /items/{id}/entries and renders it in position order', async () => {
    const h = await setupItemPageHarness({
      initialPlaintexts: [{ id: ENTRY_ID_1, text: 'First entry', position: 0 }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('First entry');
    });

    // IP15-FE1-8: locking with an empty, just-opened composer does NOT report draftClearedOnLock after unlock
    fireEvent.click(screen.getByTestId('btn-add-text'));
    expect(screen.getByTestId('new-entry-textarea')).toHaveValue('');
    await h.lock();
    await h.unlock();
    expect(screen.queryByTestId('draft-cleared-on-lock-banner')).toBeNull();

    fireEvent.click(screen.getByTestId('btn-add-text'));
    const newTextarea = screen.getByTestId('new-entry-textarea');
    assertVaultSecretElementAttributes(h.container);

    fireEvent.change(newTextarea, { target: { value: 'Brand new second entry' } });
    fireEvent.click(screen.getByTestId('new-entry-save-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('new-text-entry-composer')).toBeNull();
      const bodies = screen.getAllByTestId('entry-body');
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toHaveTextContent('First entry');
      expect(bodies[1]).toHaveTextContent('Brand new second entry');
    });
    assertNoPlaintextAttrs(h.container, ['First entry', 'Brand new second entry']);
    expect(findCacheSentinelLeaks(h.qc, ['Brand new second entry'])).toEqual([]);
  });

  it('advisor-dec-186 (UIA-3 + UIA-21): localizes breadcrumb, header, and locked-banner short copy in both en and vi with zero hardcoded Vietnamese UI strings in en locale', async () => {
    const h = await setupItemPageHarness({
      locale: 'en',
      initialItem: makeItemSummary({
        name: 'office-router',
        hint: 'floor 2',
        tags: [{ id: 'tag-2', display: 'office' }],
      }),
      initialPlaintexts: [{ id: ENTRY_ID_1, text: 'Plaintext in English only', position: 0 }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('item-name-input')).toHaveValue('office-router');
    });

    // Breadcrumb uses English accessible name and link text
    const breadcrumb = screen.getByRole('navigation', {
      name: en.content.item.breadcrumbLabel,
    });
    expect(breadcrumb).toHaveTextContent(en.content.item.allItems);
    expect(screen.getByTestId('btn-add-text')).toHaveTextContent(en.content.item.addTextCta);
    expect(screen.getByTestId('btn-delete-item')).toHaveTextContent(en.content.item.deleteItemCta);
    expect(screen.getByTestId('item-shortcuts-panel')).toHaveTextContent(
      en.content.item.shortcutsTitle,
    );

    // Lock the vault to render LockedBanner -> check .locked-banner class and <640px short copy in en
    await h.lock();
    const banner = screen.getByTestId('vault-locked-banner');
    expect(banner).toHaveClass('locked-banner');
    expect(screen.getByTestId('vault-locked-banner-body-short')).toHaveTextContent(
      en.content.item.lockedBannerBodyShort,
    );
    expect(screen.getByTestId('vault-locked-banner-body-full')).toHaveTextContent(
      en.vault.locked.bannerBody,
    );

    // Verify no Vietnamese diacritics appear anywhere in the rendered item page under English locale (excluding ×/÷ symbols)
    const mainEl = h.container.querySelector('main')!;
    expect(mainEl.textContent).not.toMatch(/[À-ÖØ-öø-ỹ]/);
    expect(banner.textContent).not.toMatch(/[À-ÖØ-öø-ỹ]/);
  });

  it('IP15-BE1-9: text card maps errorKind to distinct network, not_found, and decrypt_failed i18n states with Retry', async () => {
    const h = await setupItemPageHarness({
      initialPlaintexts: [{ id: ENTRY_ID_1, text: 'Recovered body text', position: 0 }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Recovered body text');
    });

    // 1. Network error on GET /entries/{id} -> shows networkFailedTitle + networkFailedBody
    let mode: 'network' | 'not_found' | 'malformed' | 'ok' = 'network';
    h.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && method === 'GET') {
        if (mode === 'network') {
          throw new TypeError('Failed to fetch');
        }
        if (mode === 'not_found') {
          return problemResponse('not_found', 404);
        }
        if (mode === 'malformed') {
          const existing = h.server.entries.get(ENTRY_ID_1)!;
          return jsonResponse({
            ...existing,
            ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          });
        }
      }
      return null;
    });

    await act(async () => {
      await h.lock();
      await h.unlock();
    });
    await waitFor(() => {
      const errBox = screen.getByTestId('entry-body-error');
      expect(errBox).toHaveTextContent(viMessages.content.entry.networkFailedTitle);
      expect(errBox).toHaveTextContent(viMessages.content.entry.networkFailedBody);
      expect(errBox).not.toHaveTextContent(viMessages.content.entry.decryptFailedTitle);
    });

    // 2. Retry into 404 not_found -> shows notFoundTitle + notFoundBody
    mode = 'not_found';
    fireEvent.click(screen.getByTestId('entry-body-retry'));

    await waitFor(() => {
      const errBox = screen.getByTestId('entry-body-error');
      expect(errBox).toHaveTextContent(viMessages.content.entry.notFoundTitle);
      expect(errBox).toHaveTextContent(viMessages.content.entry.notFoundBody);
    });

    // 3. Retry into malformed authenticated ciphertext -> shows decryptFailedTitle + decryptFailedBody
    mode = 'malformed';
    fireEvent.click(screen.getByTestId('entry-body-retry'));

    await waitFor(() => {
      const errBox = screen.getByTestId('entry-body-error');
      expect(errBox).toHaveTextContent(viMessages.content.entry.decryptFailedTitle);
      expect(errBox).toHaveTextContent(viMessages.content.entry.decryptFailedBody);
    });

    // 4. Retry into OK -> recovers plaintext body
    mode = 'ok';
    fireEvent.click(screen.getByTestId('entry-body-retry'));

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Recovered body text');
    });
  });

  it('IP15-BE1-10: renders localized error + Retry (not empty state) when GET item entries fails, disables + Text and reorder until metadata succeeds, then renders cards in order on Retry', async () => {
    const h = await setupItemPageHarness({
      initialPlaintexts: [
        { id: ENTRY_ID_2, text: 'Second entry at pos 1', position: 1 },
        { id: ENTRY_ID_1, text: 'First entry at pos 0', position: 0 },
      ],
    });

    let failEntriesList = true;
    h.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes(`/items/${ITEM_ID}/entries`) && method === 'GET' && failEntriesList) {
        return problemResponse('dependency_unavailable', 503);
      }
      return null;
    });

    // Force entries query to re-run from scratch and fail while item query succeeds
    act(() => {
      h.qc.removeQueries({ queryKey: ['content', 'entries', ITEM_ID] });
      h.rerenderPage();
    });

    await waitFor(() => {
      expect(screen.getByTestId('item-entries-load-error')).toBeInTheDocument();
    });

    const errCard = screen.getByTestId('item-entries-load-error');
    expect(errCard).toHaveTextContent(viMessages.content.item.loadErrorTitle);
    expect(errCard).toHaveTextContent(viMessages.content.errors.dependency_unavailable);
    expect(screen.queryByTestId('item-entries-empty')).toBeNull();
    expect(screen.getByTestId('btn-add-text')).toBeDisabled();

    // Click Retry -> entries list succeeds and renders cards in position order; + Text is enabled
    failEntriesList = false;
    fireEvent.click(screen.getByTestId('item-entries-retry-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('item-entries-load-error')).toBeNull();
      expect(getRenderedEntryCardIds(h.container)).toEqual([ENTRY_ID_1, ENTRY_ID_2]);
    });
    expect(screen.getByTestId('btn-add-text')).not.toBeDisabled();
  });

  it('IP15-FE1-4: 404 on entry PUT keeps draft and "Save as new entry" creates a new entry via POST /items/{id}/entries; desktop drag-and-drop reorders cards', async () => {
    const h = await setupItemPageHarness({
      initialPlaintexts: [
        { id: ENTRY_ID_1, text: 'Entry 1 body', position: 0 },
        { id: ENTRY_ID_2, text: 'Entry 2 body', position: 1 },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`entry-card-${ENTRY_ID_1}`)).toBeInTheDocument();
      expect(screen.getByTestId(`entry-card-${ENTRY_ID_2}`)).toBeInTheDocument();
    });

    // Part 1: Desktop drag-and-drop reorder (drag ENTRY_ID_1 at index 0 onto ENTRY_ID_2 at index 1)
    vi.useFakeTimers();
    try {
      const dragHandle1 = screen.getByTestId(`entry-drag-handle-${ENTRY_ID_1}`);
      const targetCard2 = screen.getByTestId(`entry-card-${ENTRY_ID_2}`);

      fireEvent.dragStart(dragHandle1);
      fireEvent.dragOver(targetCard2);
      fireEvent.drop(targetCard2);
      fireEvent.dragEnd(dragHandle1);

      // Immediate optimistic order: [ENTRY_ID_2, ENTRY_ID_1]
      const cardsAfterDrop = getRenderedEntryCardIds(h.container);
      expect(cardsAfterDrop).toEqual([ENTRY_ID_2, ENTRY_ID_1]);

      await act(async () => {
        vi.advanceTimersByTime(450);
      });
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() => {
      expect(
        h.server.requests.filter((r) => r.url.endsWith('/entries/reorder')),
      ).toHaveLength(1);
    });
    const dragReorderBody = JSON.parse(
      h.server.requests.find((r) => r.url.endsWith('/entries/reorder'))!.rawBody,
    ) as { entry_ids: string[] };
    expect(dragReorderBody.entry_ids).toEqual([ENTRY_ID_2, ENTRY_ID_1]);

    // Part 2: 404 on entry PUT -> deletedRemotely banner -> "Save as new entry" creates a new entry
    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const textarea = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Draft rescued via Save as new entry' } });

    // Remote device deletes ENTRY_ID_1 on server while editing
    const rec1 = h.server.entries.get(ENTRY_ID_1)!;
    rec1.deleted = true;

    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(screen.getByTestId(`entry-deleted-remotely-${ENTRY_ID_1}`)).toBeInTheDocument();
    });
    expect(textarea).toHaveValue('Draft rescued via Save as new entry');
    expect(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`)).toBeDisabled();

    // Click "Save as new entry" -> seals and POSTs to /items/{id}/entries
    fireEvent.click(screen.getByTestId(`entry-save-as-new-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(
        h.server.requests.some(
          (r) => r.method === 'POST' && r.url.endsWith(`/items/${ITEM_ID}/entries`),
        ),
      ).toBe(true);
      expect(screen.getAllByTestId('entry-body')).toHaveLength(2);
    });

    const bodiesText = screen.getAllByTestId('entry-body').map((el) => el.textContent);
    expect(bodiesText).toContain('Draft rescued via Save as new entry');
  });
});
