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
  recordUnconfirmedSave,
  resetEntryBodyLoadLimiterForTests,
  subscribeUnconfirmedSaves,
} from '@/features/entries';
import { __testing as unconfirmedSaveStoreTesting } from '@/features/entries/unconfirmed-save-store';
import { subscribeUserChanged, __testing as userChangedTesting } from '@/lib/auth/user-changed';
import { assertNoPlaintextAttrs } from '@/features/entries/test-utils/assert-no-plaintext-attrs';
import { ItemDetailPage } from '@/features/items/item-detail-page';
import {
  TextEntryCard,
  __testing as textEntryCardTesting,
  type EditorPlaintextHolder,
} from '@/features/items/text-entry-card';
import {
  VAULT_BODY_QUERY_KEY_PREFIX,
  VaultProvider,
  getKnownDeviceSessionUserId,
  resetVaultBroadcastForTests,
  useVault,
  vaultBodyQueryKey,
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

function flushMacrotask(): Promise<void> {
  const d = createDeferred();
  setTimeout(() => d.resolve(), 0);
  return d.promise;
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
  options?: { readonly locked?: boolean },
): string[] {
  const leaks: string[] = [];

  for (const query of qc.getQueryCache().getAll()) {
    const isPermittedVaultBodyCache =
      !options?.locked &&
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
  const originalVisibilityStateDescriptor = Object.getOwnPropertyDescriptor(
    document,
    'visibilityState',
  );

  beforeEach(() => {
    document.cookie = 'sabk_csrf=test-csrf-token';
    routerMocks.push.mockReset();
    routerMocks.replace.mockReset();
    routerMocks.redirect.mockClear();
    resetVaultBroadcastForTests();
    resetEntryBodyLoadLimiterForTests();
    clearAllUnconfirmedSaves();
    userChangedTesting.resetCommittedUserForTests();
    textEntryCardTesting.setEditorPlaintextHolderForTests(null);
  });

  afterEach(() => {
    cleanup();
    for (const shim of shims.splice(0)) shim.close();
    resetVaultBroadcastForTests();
    resetEntryBodyLoadLimiterForTests();
    clearAllUnconfirmedSaves();
    userChangedTesting.resetCommittedUserForTests();
    textEntryCardTesting.setEditorPlaintextHolderForTests(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalVisibilityStateDescriptor) {
      Object.defineProperty(document, 'visibilityState', originalVisibilityStateDescriptor);
    } else {
      Reflect.deleteProperty(document, 'visibilityState');
    }
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
    signupSession: (email: string, password: string) => Promise<void>;
    completeOAuthSession: () => Promise<void>;
    unlock: () => Promise<void>;
    unlockWithoutReload: () => Promise<void>;
    lock: () => Promise<void>;
    workerCalls: Array<{ type: string; id: number }>;
    setCurrentMe: (me: Me | null) => void;
    rerenderPage: (node?: ReactNode) => void;
  }

  async function setupItemPageHarness(options?: {
    locale?: 'en' | 'vi';
    initialItem?: ItemSummary;
    initialPlaintexts?: Array<{ id: string; text: string; position?: number; version?: number }>;
    itemNotFound?: boolean;
    lazyCards?: boolean;
    skipInitialVaultMetaReload?: boolean;
  }): Promise<Harness> {
    const locale = options?.locale ?? 'vi';
    const lazyCards = options?.lazyCards ?? false;
    let vaultCtx!: VaultContextValue;
    let signOutFn!: () => Promise<void>;
    let loginFn!: (args: { email: string; password: string }) => Promise<unknown>;
    let signupFn!: (args: { email: string; password: string }) => Promise<unknown>;
    let oauthCompleteFn!: () => Promise<unknown>;
    function Probe() {
      vaultCtx = useVault();
      const sess = useSession();
      signOutFn = () => sess.signOut();
      loginFn = (args) => sess.login(args);
      signupFn = (args) => sess.signup(args);
      oauthCompleteFn = () => sess.completeOAuthLogin();
      return <output data-testid="vault-state-probe">{vaultCtx.state}</output>;
    }

    let createdVault: CreateVaultResult | null = null;
    let currentMe: Me | null = makeMe(USER_A_ID, 'present');
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
      if (url.endsWith('/auth/me')) {
        if (!currentMe) {
          return problemResponse('session_invalid', 401);
        }
        return jsonResponse(currentMe);
      }
      if (url.endsWith('/auth/logout')) {
        currentMe = null;
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/auth/login')) return jsonResponse(currentMe ?? makeMe(USER_A_ID, 'present'));
      if (url.endsWith('/auth/signup')) return jsonResponse(currentMe ?? makeMe(USER_A_ID, 'present'));
      if (url.endsWith('/auth/oauth/complete')) return jsonResponse(currentMe ?? makeMe(USER_A_ID, 'present'));
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

    const workerCalls: Array<{ type: string; id: number }> = [];

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

    if (!options?.skipInitialVaultMetaReload) {
      await act(async () => {
        await vaultCtx.reloadVaultMeta();
      });
      await waitFor(() => expect(vaultCtx.vaultMeta?.vault_key_id).toBe(KEY_ID));
    }
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

    const unlockWithoutReload = async () => {
      const op = vaultCtx.beginOp();
      await act(async () => {
        await vaultCtx.unlockPassphrase({
          passphrase: PASSPHRASE,
          kdf: createdVault!.kdf,
          vaultKeyWrappedByKek: createdVault!.vault_key_wrapped_by_kek,
          privateKeysWrapped: createdVault!.private_keys_wrapped,
          opGeneration: op.opGeneration,
        });
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
      unlockWithoutReload,
      lock,
      workerCalls,
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
      signupSession: async (email, password) => {
        await act(async () => {
          await signupFn({ email, password });
        });
      },
      completeOAuthSession: async () => {
        await act(async () => {
          await oauthCompleteFn();
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

    // IP15-BE2-3: Hold PUT #3 (submitting 'Draft C' with If-Match: "3"), revert textarea back to 'Draft B typed while A in flight'
    // while PUT #3 is in flight, release PUT #3 (commits v4) -> editor stays open, Esc asks discard confirmation, and Save sends PUT #4 with If-Match: "4"
    const { promise: put3Gate, resolve: releasePut3 } = createDeferred();
    const { promise: put3Entered, resolve: notifyPut3Entered } = createDeferred();
    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && init?.method === 'PUT') {
        putCount += 1;
        if (putCount === 3) {
          notifyPut3Entered();
          await put3Gate;
        }
      }
      return null;
    });

    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const textarea3 = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`) as HTMLTextAreaElement;
    fireEvent.change(textarea3, { target: { value: 'Draft C submitted' } });
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    await put3Entered;

    // Revert back to the pre-save body while PUT #3 ('Draft C submitted') is still in flight
    fireEvent.change(textarea3, { target: { value: 'Draft B typed while A in flight' } });
    releasePut3();

    await waitFor(() => {
      expect(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`)).not.toBeDisabled();
    });

    // Escape before the second Save must recognize the reversion as dirty against 'Draft C submitted' and ask discard confirmation
    fireEvent.keyDown(textarea3, { key: 'Escape' });
    expect(screen.getByTestId(`entry-discard-confirm-${ENTRY_ID_1}`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`entry-keep-editing-btn-${ENTRY_ID_1}`));

    // Clicking Save sends PUT #4 with If-Match: "4" and restores 'Draft B typed while A in flight' on the server
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(screen.queryByTestId(`entry-edit-textarea-${ENTRY_ID_1}`)).toBeNull();
      expect(screen.getByTestId('entry-body')).toHaveTextContent(
        'Draft B typed while A in flight',
      );
    });
    const allPutsAfterReversion = h.server.requests.filter((r) => r.method === 'PUT');
    expect(allPutsAfterReversion).toHaveLength(4);
    expect(allPutsAfterReversion[2].headers['if-match']).toBe('"3"');
    expect(allPutsAfterReversion[3].headers['if-match']).toBe('"4"');
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

    // Verify the resettable plaintext holder is synchronously cleared to empty strings while fallback GET is held (IP15-BE2-1, FE3-7a)
    const holderRef: { current: EditorPlaintextHolder } = {
      current: { originalSource: '', draftValue: '' },
    };
    textEntryCardTesting.setEditorPlaintextHolderForTests(holderRef);
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
    expect(holderRef.current).toEqual({
      originalSource: '',
      draftValue: '',
      submittedCandidateSource: '',
    });

    await h.unlock();
    expect(holderRef.current).toEqual({
      originalSource: '',
      draftValue: '',
      submittedCandidateSource: '',
    });
    releaseGet2();
    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Remote v2 body');
    });
    expect(sealSpy).not.toHaveBeenCalled();
    expect(sealUpdateSpy).not.toHaveBeenCalled();

    // IP15-BE3-2: Unmount TextEntryCard while fallback GET is held in flight, keep VaultProvider mounted,
    // lock -> holder is synchronously empty BEFORE releasing the GET; then unlock + release -> zero seal/PUT/restore
    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const unmountTextarea = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`);
    fireEvent.change(unmountTextarea, { target: { value: PRE_LOCK_DRAFT } });
    expect(holderRef.current.draftValue).toBe(PRE_LOCK_DRAFT);
    expect(holderRef.current.originalSource).toBe('Remote v2 body');

    h.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && method === 'PUT') {
        return problemResponse('version_mismatch', 412);
      }
      return null;
    });
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(screen.getByTestId(`entry-conflict-412-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const { promise: getGateUnmount, resolve: releaseGetUnmount } = createDeferred();
    const { promise: fallbackGetUnmountEntered, resolve: notifyFallbackGetUnmountEntered } =
      createDeferred();
    const { promise: fallbackGetUnmountFinished, resolve: notifyFallbackGetUnmountFinished } =
      createDeferred();
    let holdUnmountGet = true;
    h.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && method === 'GET' && holdUnmountGet) {
        notifyFallbackGetUnmountEntered();
        await getGateUnmount;
        queueMicrotask(() => notifyFallbackGetUnmountFinished());
      }
      return null;
    });

    const putsBeforeUnmountKeepMine = h.server.requests.filter((r) => r.method === 'PUT').length;
    sealSpy.mockClear();
    sealUpdateSpy.mockClear();
    fireEvent.click(screen.getByTestId(`entry-conflict-keep-mine-${ENTRY_ID_1}`));
    await fallbackGetUnmountEntered;

    // Unmount TextEntryCard while retaining VaultProvider (before lock and before releasing GET)
    h.rerenderPage(<div data-testid="unmounted-during-keep-mine">Away</div>);
    expect(holderRef.current).toEqual({
      originalSource: '',
      draftValue: '',
      submittedCandidateSource: '',
    });

    // Lock while GET is still held -> holder remains empty BEFORE releasing the GET
    await h.lock();
    expect(holderRef.current).toEqual({
      originalSource: '',
      draftValue: '',
      submittedCandidateSource: '',
    });

    // Unlock and release the held GET -> zero seal, zero PUT, zero restore
    holdUnmountGet = false;
    await h.unlock();
    releaseGetUnmount();
    await fallbackGetUnmountFinished;
    await act(async () => {
      await flushMacrotask();
    });
    expect(holderRef.current).toEqual({
      originalSource: '',
      draftValue: '',
      submittedCandidateSource: '',
    });
    expect(sealSpy).not.toHaveBeenCalled();
    expect(sealUpdateSpy).not.toHaveBeenCalled();
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(
      putsBeforeUnmountKeepMine,
    );
    expect(h.container.textContent).not.toContain(PRE_LOCK_DRAFT);

    // Remount TextEntryCard for the remaining checks in this test
    textEntryCardTesting.setEditorPlaintextHolderForTests(null);
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
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Remote v2 body');
    });

    // IP15-FE3-6: Typing in the textarea while Keep mine fallback GET is in flight aborts Keep mine
    // back to the conflict banner instead of sealing text that was not confirmed at click
    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const revisionTextarea = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`);
    fireEvent.change(revisionTextarea, { target: { value: 'Confirmed at click draft' } });
    h.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && method === 'PUT') {
        return problemResponse('version_mismatch', 412);
      }
      return null;
    });
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(screen.getByTestId(`entry-conflict-412-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const { promise: getGateRev, resolve: releaseGetRev } = createDeferred();
    const { promise: getRevEntered, resolve: notifyGetRevEntered } = createDeferred();
    let holdGetRev = true;
    h.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && method === 'GET' && holdGetRev) {
        notifyGetRevEntered();
        await getGateRev;
      }
      return null;
    });

    const putsBeforeRevKeepMine = h.server.requests.filter((r) => r.method === 'PUT').length;
    sealSpy.mockClear();
    sealUpdateSpy.mockClear();
    fireEvent.click(screen.getByTestId(`entry-conflict-keep-mine-${ENTRY_ID_1}`));
    await getRevEntered;

    // Edit textarea while fallback GET is in flight -> bumps editorRevisionRef
    fireEvent.change(revisionTextarea, {
      target: { value: 'Edited during Keep mine fallback GET' },
    });
    holdGetRev = false;
    releaseGetRev();

    await waitFor(() => {
      expect(
        screen.getByTestId(`entry-conflict-keep-mine-${ENTRY_ID_1}`),
      ).not.toBeDisabled();
    });
    expect(screen.getByTestId(`entry-conflict-412-${ENTRY_ID_1}`)).toBeInTheDocument();
    expect(sealSpy).not.toHaveBeenCalled();
    expect(sealUpdateSpy).not.toHaveBeenCalled();
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(
      putsBeforeRevKeepMine,
    );
    // Discard the edited draft to return to clean view for BE2-4
    fireEvent.keyDown(revisionTextarea, { key: 'Escape' });
    fireEvent.click(screen.getByTestId(`entry-discard-btn-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Remote v2 body');
    });
    // IP15-BE2-4: Hold fallback GET A, lock/unlock, open a new editor and start deferred PUT B, then release A
    // -> stale A must NOT release B's single-flight guard; Save stays disabled, Ctrl+S sends no extra PUT, and only B settling releases the guard
    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const textareaGuard = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`);
    fireEvent.change(textareaGuard, { target: { value: 'Draft before held GET A' } });
    h.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && method === 'PUT') {
        return problemResponse('version_mismatch', 412);
      }
      return null;
    });
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(screen.getByTestId(`entry-conflict-412-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const { promise: getAGate, resolve: releaseGetA } = createDeferred();
    const { promise: getAEntered, resolve: notifyGetAEntered } = createDeferred();
    const { promise: getAResurned, resolve: notifyGetAReturned } = createDeferred();
    let getACompletedCount = 0;
    let holdGetA = true;
    h.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && method === 'GET' && holdGetA) {
        notifyGetAEntered();
        await getAGate;
        getACompletedCount += 1;
        queueMicrotask(() => notifyGetAReturned());
      }
      return null;
    });

    fireEvent.click(screen.getByTestId(`entry-conflict-keep-mine-${ENTRY_ID_1}`));
    await getAEntered;

    // Lock and unlock while GET A is still held
    holdGetA = false;
    await h.lock();
    await h.unlock();
    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Remote v2 body');
    });

    // Open a new editor and start deferred PUT B before releasing GET A
    const { promise: putBGate, resolve: releasePutB } = createDeferred();
    const { promise: putBEntered, resolve: notifyPutBEntered } = createDeferred();
    h.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && method === 'PUT') {
        notifyPutBEntered();
        await putBGate;
      }
      return null;
    });

    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const textareaB = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`);
    fireEvent.change(textareaB, { target: { value: 'New post-unlock draft B' } });
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    await putBEntered;

    const putsWhileBInFlight = h.server.requests.filter((r) => r.method === 'PUT').length;
    expect(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`)).toBeDisabled();

    // IP15-FE3-5: Release stale fallback GET A while PUT B is still in flight, wait for the route override
    // counter + several macrotask turns so A's continuation (fetch -> Response.json() -> entryGet -> catch/finally)
    // has genuinely finished, then assert Save is still disabled and Ctrl+S sends no extra PUT
    releaseGetA();
    await getAResurned;
    expect(getACompletedCount).toBe(1);
    await act(async () => {
      await flushMacrotask();
      await flushMacrotask();
      await flushMacrotask();
    });
    expect(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`)).toBeDisabled();
    fireEvent.keyDown(textareaB, { key: 's', ctrlKey: true });
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(putsWhileBInFlight);
    // Only B settling releases B's guard and commits 'New post-unlock draft B'
    releasePutB();
    await waitFor(() => {
      expect(screen.queryByTestId(`entry-edit-textarea-${ENTRY_ID_1}`)).toBeNull();
      expect(screen.getByTestId('entry-body')).toHaveTextContent('New post-unlock draft B');
    });
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(putsWhileBInFlight);
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

    // Part 2 (IP15-BE3-5): Flush immediately on visibilitychange (hidden) WITHOUT advancing the 400 ms debounce timer
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId(`entry-menu-trigger-${ENTRY_ID_2}`));
      fireEvent.click(screen.getByTestId(`entry-menu-up-${ENTRY_ID_2}`));
      // Pending debounce only -> no PATCH sent yet
      expect(reorderCallCount).toBe(2);

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });
      await act(async () => {
        fireEvent(document, new Event('visibilitychange'));
        await Promise.resolve();
      });
      expect(reorderCallCount).toBe(3);
      const reqsAfterVis = h.server.requests.filter((r) => r.url.endsWith('/entries/reorder'));
      expect(JSON.parse(reqsAfterVis[2].rawBody)).toEqual({
        entry_ids: [ENTRY_ID_3, ENTRY_ID_2, ENTRY_ID_1],
      });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
    } finally {
      vi.useRealTimers();
    }

    // Part 3 (IP15-BE3-5): Flush immediately on pagehide WITHOUT advancing the 400 ms debounce timer
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId(`entry-menu-trigger-${ENTRY_ID_2}`));
      fireEvent.click(screen.getByTestId(`entry-menu-up-${ENTRY_ID_2}`));
      expect(reorderCallCount).toBe(3);

      await act(async () => {
        fireEvent(window, new Event('pagehide'));
        await Promise.resolve();
      });
      expect(reorderCallCount).toBe(4);
      const reqsAfterPagehide = h.server.requests.filter((r) =>
        r.url.endsWith('/entries/reorder'),
      );
      expect(JSON.parse(reqsAfterPagehide[3].rawBody)).toEqual({
        entry_ids: [ENTRY_ID_2, ENTRY_ID_3, ENTRY_ID_1],
      });
    } finally {
      vi.useRealTimers();
    }

    // Part 4 (IP15-BE3-5): Flush immediately on vault lock WITHOUT advancing the 400 ms debounce timer
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId(`entry-menu-trigger-${ENTRY_ID_1}`));
      fireEvent.click(screen.getByTestId(`entry-menu-up-${ENTRY_ID_1}`));
      expect(reorderCallCount).toBe(4);

      await act(async () => {
        await h.vault().lockNow();
      });
      expect(reorderCallCount).toBe(5);
      const reqsAfterLock = h.server.requests.filter((r) => r.url.endsWith('/entries/reorder'));
      expect(JSON.parse(reqsAfterLock[4].rawBody)).toEqual({
        entry_ids: [ENTRY_ID_2, ENTRY_ID_1, ENTRY_ID_3],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('disables + Tag chip at 20 tags with tooltip, and disables + Text at 200 entries', async () => {
    const twentyTags = Array.from({ length: 20 }, (_, i) => ({
      id: `tag-${i + 1}`,
      display: `t${i + 1}`,
    }));
    let activeSentinelCallback: IntersectionObserverCallback | null = null;
    let observedSentinelTargets: Element[] = [];
    class MockSentinelIntersectionObserver implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin: string;
      readonly thresholds: ReadonlyArray<number> = [0];
      private readonly cb: IntersectionObserverCallback;

      constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
        this.cb = cb;
        this.rootMargin = opts?.rootMargin ?? '0px';
        activeSentinelCallback = cb;
      }

      observe(target: Element): void {
        observedSentinelTargets.push(target);
      }

      unobserve(target: Element): void {
        observedSentinelTargets = observedSentinelTargets.filter((t) => t !== target);
      }

      disconnect(): void {
        if (activeSentinelCallback === this.cb) {
          activeSentinelCallback = null;
        }
      }

      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    vi.stubGlobal('IntersectionObserver', MockSentinelIntersectionObserver);

    const h = await setupItemPageHarness({
      initialItem: makeItemSummary({ tags: twentyTags, entry_count: 200 }),
      initialPlaintexts: [],
    });

    // Populate 200 entries metadata on server
    const expectedIds = Array.from(
      { length: 200 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    for (let i = 0; i < 200; i++) {
      const id = expectedIds[i];
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

    // IP15-BE3-6: Drive the page's real batch sentinel IntersectionObserver:
    // 1. Initially 20 cards in position order; sentinel is observed
    const sentinel = screen.getByTestId('entries-batch-sentinel');
    expect(observedSentinelTargets).toContain(sentinel);
    expect(getRenderedEntryCardIds(h.container)).toEqual(expectedIds.slice(0, 20));

    const triggerSentinelObserver = (isIntersecting: boolean) => {
      const cb = activeSentinelCallback;
      expect(cb).not.toBeNull();
      const currentSentinel = screen.getByTestId('entries-batch-sentinel');
      const fakeEntry: IntersectionObserverEntry = {
        boundingClientRect: currentSentinel.getBoundingClientRect(),
        intersectionRatio: isIntersecting ? 1 : 0,
        intersectionRect: currentSentinel.getBoundingClientRect(),
        isIntersecting,
        rootBounds: null,
        target: currentSentinel,
        time: Date.now(),
      };
      cb!([fakeEntry], {} as IntersectionObserver);
    };

    // 2. Non-intersecting delivery -> stays at 20 cards
    act(() => {
      triggerSentinelObserver(false);
    });
    expect(getRenderedEntryCardIds(h.container)).toEqual(expectedIds.slice(0, 20));

    // 3. First intersecting delivery -> advances to 40 cards in position order
    act(() => {
      triggerSentinelObserver(true);
    });
    await waitFor(() => {
      expect(getRenderedEntryCardIds(h.container)).toEqual(expectedIds.slice(0, 40));
    });

    // 4. Second intersecting delivery -> advances to 60 cards in position order
    act(() => {
      triggerSentinelObserver(true);
    });
    await waitFor(() => {
      expect(getRenderedEntryCardIds(h.container)).toEqual(expectedIds.slice(0, 60));
    });

    // 5. Explicit load-more button also advances to 80 cards in position order
    fireEvent.click(screen.getByTestId('entries-load-more-btn'));
    await waitFor(() => {
      expect(getRenderedEntryCardIds(h.container)).toEqual(expectedIds.slice(0, 80));
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
    expect(
      h.qc
        .getQueriesData({ queryKey: VAULT_BODY_QUERY_KEY_PREFIX })
        .filter(([, data]) => data !== undefined),
    ).toEqual([]);
    expect(
      findCacheSentinelLeaks(h.qc, [SENTINEL_BODY, SENTINEL_DRAFT], { locked: true }),
    ).toEqual([]);

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

    // IP15-FE2-3 & FE1-7: With no exact match, highlight defaults to Create ('tag-suggest-opt-create');
    // Home/ArrowUp/ArrowDown navigate between suggestions and Create, and Enter on a highlighted suggestion attaches it
    expect(tagInput).toHaveAttribute('aria-activedescendant', 'tag-suggest-opt-create');
    fireEvent.keyDown(tagInput, { key: 'Home' });
    expect(tagInput).toHaveAttribute('aria-activedescendant', 'tag-suggest-opt-tag-3');
    fireEvent.keyDown(tagInput, { key: 'ArrowDown' });
    expect(tagInput).toHaveAttribute('aria-activedescendant', 'tag-suggest-opt-create');
    fireEvent.keyDown(tagInput, { key: 'ArrowUp' });
    expect(tagInput).toHaveAttribute('aria-activedescendant', 'tag-suggest-opt-tag-3');

    // Pressing Enter while an existing suggestion is highlighted attaches that suggestion
    fireEvent.keyDown(tagInput, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('item-tag-chip-mạng-nhà')).toBeInTheDocument();
    });

    // IP15-FE2-3: Re-open tag popover, have suggestion 'workout' in catalog, type 'work' (prefix, no exact match)
    // -> Enter defaults to Create option and sends POST /tags { display: 'work' }
    h.server.catalogTags.push({
      id: 'tag-workout',
      display: 'workout',
      item_count: 3,
      created_at: '2026-11-01T00:00:00Z',
      last_used_at: '2026-11-01T00:00:00Z',
    });
    fireEvent.click(screen.getByTestId('tag-add-chip'));
    const tagInput2 = screen.getByTestId('tag-suggest-input');
    fireEvent.change(tagInput2, { target: { value: 'work' } });
    await waitFor(() => {
      expect(screen.getByTestId('tag-suggest-option-workout')).toBeInTheDocument();
      expect(screen.getByTestId('tag-suggest-create-option')).toBeInTheDocument();
    });
    expect(tagInput2).toHaveAttribute('aria-activedescendant', 'tag-suggest-opt-create');
    fireEvent.keyDown(tagInput2, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('item-tag-chip-work')).toBeInTheDocument();
    });
    const tagCreateReqs = h.server.requests.filter(
      (r) => r.method === 'POST' && r.url.endsWith('/api/v1/tags'),
    );
    expect(tagCreateReqs).toHaveLength(1);
    expect(JSON.parse(tagCreateReqs[0].rawBody)).toEqual({ display: 'work' });
    expect(screen.queryByTestId('item-tag-chip-workout')).toBeNull();
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

    // IP15-BE2-6: Defer Load latest GET(v2), apply a newer summary(v3), release GET(v2) -> name/hint/cache stay at v3 and next PATCH uses If-Match: "3"
    h.server.item.version = 4;
    h.server.item.name = 'remote-v4-name';
    h.server.item.hint = 'remote-v4-hint';

    // Trigger 412 conflict on name edit (local has version 3, server has version 4)
    fireEvent.change(nameInput, { target: { value: 'local-conflict-attempt' } });
    fireEvent.blur(nameInput);
    await waitFor(() => {
      expect(screen.getByTestId('item-header-conflict-412')).toBeInTheDocument();
    });

    const { promise: loadLatestGate, resolve: releaseLoadLatest } = createDeferred();
    const { promise: loadLatestEntered, resolve: notifyLoadLatestEntered } = createDeferred();
    const staleFetchSummaryV4: ItemSummary = {
      ...h.server.item,
      version: 4,
      name: 'stale-fetch-v4-name',
      hint: 'stale-fetch-v4-hint',
    };

    h.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/items/${ITEM_ID}`) && method === 'GET') {
        notifyLoadLatestEntered();
        await loadLatestGate;
        return jsonResponse(staleFetchSummaryV4, 200);
      }
      return null;
    });

    // Click Load latest -> enters held GET(v4)
    fireEvent.click(screen.getByTestId('item-conflict-load-latest'));
    await loadLatestEntered;

    // While GET(v4) is held, a newer summary (version 5) is observed via tag mutation
    h.server.item.version = 5;
    h.server.item.name = 'authoritative-v5-name';
    h.server.item.hint = 'authoritative-v5-hint';
    fireEvent.click(screen.getByTestId('item-tag-remove-nhà'));
    await waitFor(() => {
      expect(screen.queryByTestId('item-tag-chip-nhà')).toBeNull();
    });

    // Release the older GET(v4) -> must NOT overwrite v5 name/hint or relabel v4 as v5
    h.server.overrideRoute(null);
    releaseLoadLatest();
    await waitFor(() => {
      expect(screen.queryByTestId('item-header-conflict-412')).toBeNull();
    });

    expect(screen.getByTestId('item-name-input')).toHaveValue('authoritative-v5-name');
    expect(screen.getByTestId('item-hint-input')).toHaveValue('authoritative-v5-hint');
    expect(h.qc.getQueryData<ItemSummary>(['content', 'item', ITEM_ID])?.name).toBe(
      'authoritative-v5-name',
    );
    expect(h.qc.getQueryData<ItemSummary>(['content', 'item', ITEM_ID])?.version).toBe(5);

    // Subsequent PATCH uses If-Match: "5" corresponding to the displayed v5 base
    fireEvent.change(nameInput, { target: { value: 'committed-v6-name' } });
    fireEvent.blur(nameInput);
    await waitFor(() => {
      expect(h.server.item.version).toBe(6);
      expect(h.server.item.name).toBe('committed-v6-name');
    });
    const allItemPatches = h.server.requests.filter(
      (r) => r.method === 'PATCH' && r.url.endsWith(`/items/${ITEM_ID}`),
    );
    expect(allItemPatches[allItemPatches.length - 1].headers['if-match']).toBe('"5"');

    // IP15-BE3-4: Held Load latest GET(v7) -> concurrent Keep mine hits 412 with current_version=8 (and NO v8 summary)
    // -> releasing GET(v7) must NOT synthesize a v8 ItemSummary from older fields, must NOT overwrite the typed Keep mine
    // inputs, and must NOT clear the newer unresolved v8 conflict.
    h.server.item.version = 7;
    h.server.item.name = 'remote-v7-name';
    h.server.item.hint = 'remote-v7-hint';

    fireEvent.change(nameInput, { target: { value: 'local-keep-mine-candidate' } });
    fireEvent.blur(nameInput);
    await waitFor(() => {
      expect(screen.getByTestId('item-header-conflict-412')).toBeInTheDocument();
    });

    const { promise: loadV7Gate, resolve: releaseLoadV7 } = createDeferred();
    const { promise: loadV7Entered, resolve: notifyLoadV7Entered } = createDeferred();
    const { promise: loadV7Finished, resolve: notifyLoadV7Finished } = createDeferred();
    // Hold the first GET(v7) AND make the automatic one-time retry also return v7 so we verify both:
    // (a) IP15-BE3-4: when even the one-time refetch returns a stale v7 snapshot (< observed v8 validator),
    //     the v8 conflict stays active, typed inputs are preserved, and cache is not fabricated at v8;
    // (b) IP15-FE4-5: stale Load latest announces and auto-refetches once (2 GET /items/{id} calls total),
    //     and when the server serves v8 on the auto-refetch, a single Load latest resolves the conflict cleanly.
    let returnStaleV7Count = 2;
    const fetchedV7Summary: ItemSummary = {
      ...h.server.item,
      version: 7,
      name: 'remote-v7-name',
      hint: 'remote-v7-hint',
    };

    let getCallsDuringStaleLoadLatest = 0;
    h.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/items/${ITEM_ID}`) && method === 'GET' && returnStaleV7Count > 0) {
        getCallsDuringStaleLoadLatest += 1;
        returnStaleV7Count -= 1;
        if (getCallsDuringStaleLoadLatest === 1) {
          notifyLoadV7Entered();
          await loadV7Gate;
        } else {
          queueMicrotask(() => notifyLoadV7Finished());
        }
        return jsonResponse(fetchedV7Summary, 200);
      }
      return null;
    });

    // Click Load latest and hold its first GET(v7)
    fireEvent.click(screen.getByTestId('item-conflict-load-latest'));
    await loadV7Entered;

    // While GET(v7) is pending, another device advances the server to v8; user clicks Keep mine -> PATCH returns 412 with current_version=8 (no v8 summary)
    h.server.item.version = 8;
    h.server.item.name = 'remote-v8-authoritative-name';
    h.server.item.hint = 'remote-v8-authoritative-hint';
    fireEvent.click(screen.getByTestId('item-conflict-keep-mine'));

    await waitFor(() => {
      const patchesAfterKeepMine = h.server.requests.filter(
        (r) => r.method === 'PATCH' && r.url.endsWith(`/items/${ITEM_ID}`),
      );
      expect(patchesAfterKeepMine[patchesAfterKeepMine.length - 1].headers['if-match']).toBe('"7"');
      expect(screen.getByTestId('item-header-conflict-412')).toBeInTheDocument();
    });

    // Release the held first GET(v7) -> stale Load latest announces to item-page-live-region and auto-refetches once (2nd GET)
    releaseLoadV7();
    await loadV7Finished;
    await act(async () => {
      await flushMacrotask();
    });

    // IP15-FE4-5: Verify it announced and refetched exactly once (1 initial GET + 1 auto-refetch = 2 GETs)
    expect(getCallsDuringStaleLoadLatest).toBe(2);
    expect(screen.getByTestId('item-page-live-region')).toHaveTextContent(
      viMessages.content.item.conflictBody,
    );

    // IP15-BE3-4: Because the auto-refetch also returned stale v7 (< v8), the v8 conflict remains active,
    // inputs keep the user's typed candidate, and cache is NOT fabricated with version 8 + older fields
    expect(screen.getByTestId('item-header-conflict-412')).toBeInTheDocument();
    expect(screen.getByTestId('item-name-input')).toHaveValue('local-keep-mine-candidate');
    const cachedAfterStaleRelease = h.qc.getQueryData<ItemSummary>(['content', 'item', ITEM_ID]);
    expect(cachedAfterStaleRelease?.version).toBe(7);
    expect(cachedAfterStaleRelease?.name).toBe('remote-v7-name');

    // IP15-FE4-5: Now verify that when a stale Load latest GET(v7) is followed by a server that serves v8 on the
    // one-time auto-refetch, a single Load latest click announces, refetches v8, and resolves the conflict without a second click.
    const { promise: loadV7Gate2, resolve: releaseLoadV7_2 } = createDeferred();
    const { promise: loadV7Entered2, resolve: notifyLoadV7Entered2 } = createDeferred();
    let interceptFirstGetOnly = true;
    h.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/items/${ITEM_ID}`) && method === 'GET' && interceptFirstGetOnly) {
        interceptFirstGetOnly = false;
        notifyLoadV7Entered2();
        await loadV7Gate2;
        return jsonResponse(fetchedV7Summary, 200);
      }
      return null;
    });

    const getsBeforeAutoResolve = h.server.requests.filter(
      (r) => r.method === 'GET' && r.url.endsWith(`/items/${ITEM_ID}`),
    ).length;
    fireEvent.click(screen.getByTestId('item-conflict-load-latest'));
    await loadV7Entered2;
    releaseLoadV7_2();

    await waitFor(() => {
      expect(screen.queryByTestId('item-header-conflict-412')).toBeNull();
      expect(screen.getByTestId('item-name-input')).toHaveValue('remote-v8-authoritative-name');
      expect(screen.getByTestId('item-hint-input')).toHaveValue('remote-v8-authoritative-hint');
    });
    const getsAfterAutoResolve = h.server.requests.filter(
      (r) => r.method === 'GET' && r.url.endsWith(`/items/${ITEM_ID}`),
    ).length;
    expect(getsAfterAutoResolve - getsBeforeAutoResolve).toBe(2);
    expect(h.qc.getQueryData<ItemSummary>(['content', 'item', ITEM_ID])?.version).toBe(8);
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

  it('session_invalid on uncertain entry PUT drops draft without replay, records saveUnconfirmed across terminal error until same-user re-login, and clears on explicit logout (advisor-dec-120, IP15-BE1-8, FE1-9)', async () => {
    const h = await setupItemPageHarness({
      initialPlaintexts: [{ id: ENTRY_ID_1, text: 'Secret for User A' }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Secret for User A');
    });

    let failPutWithSessionInvalid = true;
    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && init?.method === 'PUT' && failPutWithSessionInvalid) {
        h.setCurrentMe(null);
        return problemResponse('session_invalid', 401);
      }
      return null;
    });

    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    const textarea = screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`);
    fireEvent.change(textarea, { target: { value: 'Uncertain draft before session_invalid' } });
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    // 1. Terminal session_invalid boundary: editor closes, draft dropped, and record survives signed_out(reason='invalid')
    // even when /auth/me returns signed-out and knownDeviceSessionUserId pointer is null
    await waitFor(() => {
      expect(getUnconfirmedSavesSnapshot()).toHaveLength(1);
      expect(getUnconfirmedSavesSnapshot()[0].userId).toBe(USER_A_ID);
      expect(getKnownDeviceSessionUserId()).toBeNull();
    });

    // Re-login as User A via real SessionProvider.login: same-user re-login never notifies userChangedEvents and preserves record
    const userChangedEvents: Array<{ prev: string; next: string }> = [];
    const unsubUserChanged = subscribeUserChanged((prev, next) => {
      userChangedEvents.push({ prev, next });
    });
    try {
      h.setCurrentMe(makeMe(USER_A_ID, 'present'));
      await h.loginSession('a@example.test', 'pw');
      expect(userChangedEvents).toEqual([]);
      expect(unconfirmedSaveStoreTesting.peekUnconfirmedSavesForTests()).toHaveLength(1);
      await waitFor(() => {
        expect(screen.getByTestId('entry-save-unconfirmed-banner')).toHaveTextContent('wifi');
      });
    } finally {
      unsubUserChanged();
    }

    // 2. Navigate away from the item page (unmount ItemDetailPage) and call explicit SessionProvider.signOut()
    // -> clears the unconfirmed-save store even when no item page is mounted
    h.rerenderPage(<div data-testid="away-from-item-page">Away</div>);
    failPutWithSessionInvalid = false;
    await h.signOutSession();
    expect(getUnconfirmedSavesSnapshot()).toEqual([]);

    // Wait for VaultProvider's async lock() on signed_out to settle before re-logging in
    await waitFor(() => {
      expect(h.vault().inFlight).toBe(false);
      expect(h.vault().state).toBe('no_vault');
    });

    // Re-login as User A and remount ItemDetailPage -> banner is gone because explicit logout cleared it
    h.setCurrentMe(makeMe(USER_A_ID, 'present'));
    await h.loginSession('a@example.test', 'pw');
    await waitFor(() => {
      expect(h.vault().state).toBe('locked');
      expect(h.vault().inFlight).toBe(false);
    });
    h.rerenderPage();
    expect(screen.queryByTestId('entry-save-unconfirmed-banner')).toBeNull();
  });

  it('advisor-dec-199 / IP15-BE4-2 / FE4-6 (login): terminal session_invalid with /auth/me signed-out and pointer null followed by direct User B login away from detail route notifies subscriber and empties store before any detail mount', async () => {
    const h = await setupItemPageHarness({
      initialPlaintexts: [{ id: ENTRY_ID_1, text: 'Secret for User A' }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Secret for User A');
    });

    let failPutWithSessionInvalid = true;
    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && init?.method === 'PUT' && failPutWithSessionInvalid) {
        // Terminal auth loss: /auth/me now returns signed-out (401 session_invalid)
        h.setCurrentMe(null);
        return problemResponse('session_invalid', 401);
      }
      return null;
    });

    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    fireEvent.change(screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`), {
      target: { value: 'Uncertain draft before terminal session_invalid' },
    });
    // Unmount ItemDetailPage as the uncertain PUT hits terminal session_invalid so no detail route is mounted when B logs in
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(unconfirmedSaveStoreTesting.peekUnconfirmedSavesForTests()).toHaveLength(1);
      expect(unconfirmedSaveStoreTesting.peekUnconfirmedSavesForTests()[0].userId).toBe(USER_A_ID);
      expect(getKnownDeviceSessionUserId()).toBeNull();
    });

    h.rerenderPage(<div data-testid="away-for-terminal-null-login">Away</div>);
    failPutWithSessionInvalid = false;

    // Wait for VaultProvider's signed_out lock transition to settle with /auth/me returning signed-out and pointer null
    await waitFor(() => {
      expect(h.vault().inFlight).toBe(false);
      expect(h.vault().state).toBe('no_vault');
      expect(getKnownDeviceSessionUserId()).toBeNull();
    });
    expect(unconfirmedSaveStoreTesting.peekUnconfirmedSavesForTests()).toHaveLength(1);

    const userChangedEvents: Array<{ prev: string; next: string }> = [];
    const unsubUserChanged = subscribeUserChanged((prev, next) => {
      userChangedEvents.push({ prev, next });
    });
    // IP15-FE4-4: Register a throwing listener first to verify it never aborts login or prevents subsequent listeners from running
    const unsubThrowing = subscribeUserChanged(() => {
      throw new Error('listener boom');
    });
    let storeEmitCount = 0;
    const unsubStore = subscribeUnconfirmedSaves(() => {
      storeEmitCount += 1;
    });

    try {
      // Direct User B login from the settled terminal-null state (without restoring User A first)
      h.setCurrentMe(makeMe(USER_B_ID, 'present'));
      await h.loginSession('b@example.test', 'pw');

      expect(userChangedEvents).toEqual([{ prev: USER_A_ID, next: USER_B_ID }]);
      expect(storeEmitCount).toBe(1);
      expect(unconfirmedSaveStoreTesting.peekUnconfirmedSavesForTests()).toEqual([]);

      // Wait for VaultProvider to settle for B, then log User A back in and remount -> User A's prior notice does NOT return
      await waitFor(() => {
        expect(h.vault().inFlight).toBe(false);
      });
      h.setCurrentMe(makeMe(USER_A_ID, 'present'));
      await h.loginSession('a@example.test', 'pw');
      expect(userChangedEvents).toEqual([
        { prev: USER_A_ID, next: USER_B_ID },
        { prev: USER_B_ID, next: USER_A_ID },
      ]);
      expect(unconfirmedSaveStoreTesting.peekUnconfirmedSavesForTests()).toEqual([]);
      h.rerenderPage();
      expect(screen.queryByTestId('entry-save-unconfirmed-banner')).toBeNull();
    } finally {
      unsubThrowing();
      unsubUserChanged();
      unsubStore();
    }
  });

  it('advisor-dec-199 / IP15-BE4-2 / FE4-6 (signup & OAuth): terminal session_invalid with /auth/me signed-out and pointer null followed by direct User B signup or OAuth login away from detail route notifies subscriber and empties store before any detail mount', async () => {
    const h = await setupItemPageHarness({
      initialPlaintexts: [{ id: ENTRY_ID_1, text: 'Secret for User A' }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Secret for User A');
    });

    let failPutWithSessionInvalid = true;
    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && init?.method === 'PUT' && failPutWithSessionInvalid) {
        h.setCurrentMe(null);
        return problemResponse('session_invalid', 401);
      }
      return null;
    });

    // 1. Trigger real terminal session_invalid for User A -> /auth/me returns signed-out and pointer is null
    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    fireEvent.change(screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`), {
      target: { value: 'Draft before terminal session_invalid for signup switch' },
    });
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(unconfirmedSaveStoreTesting.peekUnconfirmedSavesForTests()).toHaveLength(1);
      expect(getKnownDeviceSessionUserId()).toBeNull();
    });

    h.rerenderPage(<div data-testid="away-for-terminal-null-signup-oauth">Away</div>);
    await waitFor(() => {
      expect(h.vault().inFlight).toBe(false);
      expect(h.vault().state).toBe('no_vault');
      expect(getKnownDeviceSessionUserId()).toBeNull();
    });

    const userChangedEvents: Array<{ prev: string; next: string }> = [];
    const unsubUserChanged = subscribeUserChanged((prev, next) => {
      userChangedEvents.push({ prev, next });
    });
    let storeEmitCount = 0;
    const unsubStore = subscribeUnconfirmedSaves(() => {
      storeEmitCount += 1;
    });

    try {
      // Direct User B signup from the settled terminal-null state -> notifies subscriber and empties store
      h.setCurrentMe(makeMe(USER_B_ID, 'present'));
      await h.signupSession('b-signup@example.test', 'pw');
      expect(userChangedEvents).toEqual([{ prev: USER_A_ID, next: USER_B_ID }]);
      expect(storeEmitCount).toBe(1);
      expect(unconfirmedSaveStoreTesting.peekUnconfirmedSavesForTests()).toEqual([]);

      // 2. Now User B has a record, and User B's session hits terminal session_invalid with /auth/me signed-out and pointer null
      await waitFor(() => {
        expect(h.vault().inFlight).toBe(false);
      });
      recordUnconfirmedSave({
        userId: USER_B_ID,
        itemId: ITEM_ID,
        itemName: 'wifi-b',
        source: 'entry',
      });
      expect(unconfirmedSaveStoreTesting.peekUnconfirmedSavesForTests()).toHaveLength(1);

      // Trigger real terminal session_invalid via ItemDetailPage PUT for User B
      h.rerenderPage();
      await h.unlock();
      await waitFor(() => {
        expect(screen.getByTestId('entry-body')).toHaveTextContent('Secret for User A');
      });
      fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
      fireEvent.change(screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`), {
        target: { value: 'Draft for B before terminal session_invalid' },
      });
      fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

      await waitFor(() => {
        expect(getKnownDeviceSessionUserId()).toBeNull();
      });
      h.rerenderPage(<div data-testid="away-for-terminal-null-oauth">Away</div>);
      failPutWithSessionInvalid = false;
      await waitFor(() => {
        expect(h.vault().inFlight).toBe(false);
        expect(h.vault().state).toBe('no_vault');
        expect(getKnownDeviceSessionUserId()).toBeNull();
      });
      expect(unconfirmedSaveStoreTesting.peekUnconfirmedSavesForTests()).toHaveLength(1);
      expect(unconfirmedSaveStoreTesting.peekUnconfirmedSavesForTests()[0].userId).toBe(USER_B_ID);

      const emitsBeforeOAuth = storeEmitCount;
      // Direct User A OAuth completion from the settled terminal-null state -> notifies subscriber and empties store
      h.setCurrentMe(makeMe(USER_A_ID, 'present'));
      await h.completeOAuthSession();
      expect(userChangedEvents).toEqual([
        { prev: USER_A_ID, next: USER_B_ID },
        { prev: USER_B_ID, next: USER_A_ID },
      ]);
      expect(storeEmitCount).toBeGreaterThan(emitsBeforeOAuth);
      expect(unconfirmedSaveStoreTesting.peekUnconfirmedSavesForTests()).toEqual([]);
    } finally {
      unsubUserChanged();
      unsubStore();
    }
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

    // advisor-dec-200: Onboarding step 3 skipped leaves vault.vaultMeta === null while vault.state === 'unlocked';
    // the first entry save via + Text composer and 404 Save as new entry must call vault.reloadVaultMeta() and succeed
    cleanup();
    const hOnboardingSkip = await setupItemPageHarness({
      initialPlaintexts: [],
      skipInitialVaultMetaReload: true,
    });
    expect(hOnboardingSkip.vault().state).toBe('unlocked');
    expect(hOnboardingSkip.vault().vaultMeta).toBeNull();

    await waitFor(() => {
      expect(screen.queryByTestId('item-loading')).toBeNull();
      expect(screen.getByTestId('btn-add-text')).toBeEnabled();
    });
    expect(hOnboardingSkip.vault().vaultMeta).toBeNull();
    expect(
      hOnboardingSkip.server.requests.filter((r) => r.method === 'GET' && r.url.endsWith('/vault')),
    ).toHaveLength(0);

    const reloadMetaSpy = vi.spyOn(hOnboardingSkip.vault(), 'reloadVaultMeta');
    fireEvent.click(screen.getByTestId('btn-add-text'));
    fireEvent.change(screen.getByTestId('new-entry-textarea'), {
      target: { value: 'First entry after onboarding step 3 skip' },
    });
    fireEvent.click(screen.getByTestId('new-entry-save-btn'));

    await waitFor(() => {
      expect(reloadMetaSpy).toHaveBeenCalledTimes(1);
      expect(hOnboardingSkip.vault().vaultMeta?.vault_key_id).toBe(KEY_ID);
      expect(screen.queryByTestId('new-text-entry-composer')).toBeNull();
      expect(screen.getByTestId('entry-body')).toHaveTextContent(
        'First entry after onboarding step 3 skip',
      );
    });
    const vaultReloadIndex = hOnboardingSkip.server.requests.findIndex(
      (r) => r.method === 'GET' && r.url.endsWith('/vault'),
    );
    const postOnboardingCreateIndex = hOnboardingSkip.server.requests.findIndex(
      (r) => r.method === 'POST' && r.url.endsWith(`/items/${ITEM_ID}/entries`),
    );
    expect(vaultReloadIndex).toBeGreaterThanOrEqual(0);
    expect(postOnboardingCreateIndex).toBeGreaterThan(vaultReloadIndex);
    expect(
      hOnboardingSkip.server.requests.filter(
        (r) => r.method === 'GET' && r.url.endsWith('/vault'),
      ),
    ).toHaveLength(1);
    expect(
      hOnboardingSkip.server.requests.filter(
        (r) => r.method === 'POST' && r.url.endsWith(`/items/${ITEM_ID}/entries`),
      ),
    ).toHaveLength(1);
  });

  it('IP15-FE4-2 / BE4-3: holding GET /vault (reloadVaultMeta) during save and locking (and locking + unlocking) cancels with STALE_GENERATION, zero seal, zero POST/PUT, empty holder and DOM, and no draft restoration; null/invalid key id rejects VAULT_KEY_MISSING with no write across + Text, regular Save, Keep mine, and 404 Save as new entry', async () => {
    const h = await setupItemPageHarness({
      initialPlaintexts: [],
      skipInitialVaultMetaReload: true,
    });

    await waitFor(() => {
      expect(screen.queryByTestId('item-loading')).toBeNull();
      expect(screen.getByTestId('btn-add-text')).toBeEnabled();
    });
    expect(h.vault().state).toBe('unlocked');
    expect(h.vault().vaultMeta).toBeNull();

    // 1a. + Text composer: hold GET /vault after Save starts, lock before releasing valid metadata ->
    // zero Worker sealEntry, zero POST, composer closed/wiped, no draft restoration after unlock.
    let holdVaultGet = true;
    let vaultGetEnteredGate = Promise.withResolvers<void>();
    let vaultGetReleaseGate = Promise.withResolvers<void>();
    let returnInvalidVaultKeyId = false;
    let returnVaultAbsent404 = false;

    h.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.endsWith('/vault')) {
        if (holdVaultGet) {
          vaultGetEnteredGate.resolve();
          await vaultGetReleaseGate.promise;
        }
        if (returnVaultAbsent404) {
          return problemResponse('vault_absent', 404);
        }
        if (returnInvalidVaultKeyId) {
          return jsonResponse({
            vault_key_id: 'invalid-key-id-format',
            version: 1,
          });
        }
      }
      return null;
    });

    const sealsBeforeComposerLock = h.workerCalls.filter((c) => c.type === 'sealEntry').length;
    fireEvent.click(screen.getByTestId('btn-add-text'));
    const composerTextarea1 = screen.getByTestId('new-entry-textarea') as HTMLTextAreaElement;
    fireEvent.change(composerTextarea1, {
      target: { value: 'SENTINEL-COMPOSER-HELD-RELOAD-LOCK-ONLY' },
    });
    fireEvent.click(screen.getByTestId('new-entry-save-btn'));

    await vaultGetEnteredGate.promise;
    await h.lock();
    expect(screen.queryByTestId('new-text-entry-composer')).toBeNull();
    expect(h.container.textContent).not.toContain('SENTINEL-COMPOSER-HELD-RELOAD-LOCK-ONLY');

    vaultGetReleaseGate.resolve();
    await flushMacrotask();
    await flushMacrotask();

    expect(h.workerCalls.filter((c) => c.type === 'sealEntry').length).toBe(
      sealsBeforeComposerLock,
    );
    expect(
      h.server.requests.filter(
        (r) => r.method === 'POST' && r.url.endsWith(`/items/${ITEM_ID}/entries`),
      ),
    ).toHaveLength(0);

    // 1b. + Text composer: hold GET /vault after Save starts, lock AND unlock before releasing valid metadata ->
    // STALE_GENERATION, zero Worker sealEntry, zero POST, empty DOM, no draft restoration.
    await h.unlockWithoutReload();
    expect(h.vault().state).toBe('unlocked');
    expect(h.vault().vaultMeta).toBeNull();
    expect(screen.getByTestId('draft-cleared-on-lock-banner')).toBeInTheDocument();

    vaultGetEnteredGate = Promise.withResolvers<void>();
    vaultGetReleaseGate = Promise.withResolvers<void>();
    const sealsBeforeComposerLockUnlock = h.workerCalls.filter(
      (c) => c.type === 'sealEntry',
    ).length;

    fireEvent.click(screen.getByTestId('btn-add-text'));
    const composerTextarea2 = screen.getByTestId('new-entry-textarea') as HTMLTextAreaElement;
    fireEvent.change(composerTextarea2, {
      target: { value: 'SENTINEL-COMPOSER-HELD-RELOAD-LOCK-UNLOCK' },
    });
    fireEvent.click(screen.getByTestId('new-entry-save-btn'));

    await vaultGetEnteredGate.promise;
    await h.lock();
    await h.unlockWithoutReload();
    expect(h.vault().state).toBe('unlocked');
    expect(screen.queryByTestId('new-text-entry-composer')).toBeNull();

    vaultGetReleaseGate.resolve();
    await waitFor(() => {
      expect(h.vault().vaultMeta?.vault_key_id).toBe(KEY_ID);
    });
    await flushMacrotask();
    await flushMacrotask();

    expect(h.workerCalls.filter((c) => c.type === 'sealEntry').length).toBe(
      sealsBeforeComposerLockUnlock,
    );
    expect(
      h.server.requests.filter(
        (r) => r.method === 'POST' && r.url.endsWith(`/items/${ITEM_ID}/entries`),
      ),
    ).toHaveLength(0);
    expect(h.container.textContent).not.toContain('SENTINEL-COMPOSER-HELD-RELOAD-LOCK-UNLOCK');
    assertNoPlaintextAttrs(h.container, [
      'SENTINEL-COMPOSER-HELD-RELOAD-LOCK-ONLY',
      'SENTINEL-COMPOSER-HELD-RELOAD-LOCK-UNLOCK',
    ]);

    // 1c. + Text composer with vaultMeta === null where reloadVaultMeta returns an invalid key_id ->
    // VAULT_KEY_MISSING, zero Worker sealEntry, zero POST.
    await h.signOutSession();
    await waitFor(() => {
      expect(h.vault().inFlight).toBe(false);
      expect(h.vault().state).toBe('no_vault');
    });
    h.setCurrentMe(makeMe(USER_A_ID, 'present'));
    await h.loginSession('a@example.test', 'pw');
    await waitFor(() => {
      expect(h.vault().state).toBe('locked');
      expect(h.vault().inFlight).toBe(false);
    });
    await h.unlockWithoutReload();
    expect(h.vault().vaultMeta).toBeNull();

    holdVaultGet = false;
    returnInvalidVaultKeyId = true;
    const sealsBeforeInvalidKey = h.workerCalls.filter((c) => c.type === 'sealEntry').length;

    fireEvent.click(screen.getByTestId('btn-add-text'));
    fireEvent.change(screen.getByTestId('new-entry-textarea'), {
      target: { value: 'Draft with invalid key_id on reload' },
    });
    fireEvent.click(screen.getByTestId('new-entry-save-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('new-entry-save-error')).toBeInTheDocument();
    });
    expect(h.workerCalls.filter((c) => c.type === 'sealEntry').length).toBe(
      sealsBeforeInvalidKey,
    );
    expect(
      h.server.requests.filter(
        (r) => r.method === 'POST' && r.url.endsWith(`/items/${ITEM_ID}/entries`),
      ),
    ).toHaveLength(0);

    // 1d. + Text composer with vaultMeta === null where reloadVaultMeta resolves null (404 vault_absent) ->
    // VAULT_KEY_MISSING / lock, zero Worker sealEntry, zero POST.
    await h.signOutSession();
    await waitFor(() => {
      expect(h.vault().inFlight).toBe(false);
    });
    h.setCurrentMe(makeMe(USER_A_ID, 'present'));
    await h.loginSession('a@example.test', 'pw');
    await waitFor(() => {
      expect(h.vault().state).toBe('locked');
      expect(h.vault().inFlight).toBe(false);
    });
    await h.unlockWithoutReload();
    expect(h.vault().vaultMeta).toBeNull();

    returnInvalidVaultKeyId = false;
    returnVaultAbsent404 = true;
    const sealsBeforeNullReload = h.workerCalls.filter((c) => c.type === 'sealEntry').length;

    fireEvent.click(screen.getByTestId('btn-add-text'));
    fireEvent.change(screen.getByTestId('new-entry-textarea'), {
      target: { value: 'Draft when reloadVaultMeta returns null' },
    });
    fireEvent.click(screen.getByTestId('new-entry-save-btn'));

    await waitFor(() => {
      expect(h.vault().state).toBe('locked');
    });
    expect(h.workerCalls.filter((c) => c.type === 'sealEntry').length).toBe(
      sealsBeforeNullReload,
    );
    expect(
      h.server.requests.filter(
        (r) => r.method === 'POST' && r.url.endsWith(`/items/${ITEM_ID}/entries`),
      ),
    ).toHaveLength(0);

    // 2. Card editing paths (regular Save, Keep mine, and 404 Save as new entry) with vaultMeta === null:
    // Mount fresh harness with 1 entry so we can test holder wipe + zero seal + happy-path reload across all 3 card save paths.
    cleanup();
    const holderProbeRef = {
      current: {
        originalSource: '',
        draftValue: '',
        submittedCandidateSource: '',
      },
    };
    textEntryCardTesting.setEditorPlaintextHolderForTests(holderProbeRef);

    const hCard = await setupItemPageHarness({
      initialPlaintexts: [{ id: ENTRY_ID_1, text: 'Initial card body v1', position: 0 }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Initial card body v1');
    });

    let holdCardVaultGet = false;
    let failCardVaultGet500 = false;
    let cardVaultGetEntered = Promise.withResolvers<void>();
    let cardVaultGetRelease = Promise.withResolvers<void>();

    hCard.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.endsWith('/vault')) {
        if (failCardVaultGet500) {
          return problemResponse('internal_error', 500);
        }
        if (holdCardVaultGet) {
          cardVaultGetEntered.resolve();
          await cardVaultGetRelease.promise;
        }
      }
      return null;
    });

    // Helper to reset vaultMeta to null while unlocked (signOut clears ['vault','meta'] and sets vaultMeta=null;
    // login + unlockWithoutReload with failCardVaultGet500=true leaves vaultMeta === null after useEntryBody's
    // single reload attempt fails; then seeding the body query cache makes the Edit button immediately available).
    const enterUnlockedWithNullVaultMetaAndCachedBody = async (
      cachedBody: string,
      version: number,
    ) => {
      failCardVaultGet500 = true;
      await hCard.signOutSession();
      await waitFor(() => {
        expect(hCard.vault().inFlight).toBe(false);
        expect(hCard.vault().state).toBe('no_vault');
      });
      hCard.setCurrentMe(makeMe(USER_A_ID, 'present'));
      await hCard.loginSession('a@example.test', 'pw');
      await waitFor(() => {
        expect(hCard.vault().state).toBe('locked');
        expect(hCard.vault().inFlight).toBe(false);
      });
      await hCard.unlockWithoutReload();
      expect(hCard.vault().state).toBe('unlocked');
      expect(hCard.vault().vaultMeta).toBeNull();
      act(() => {
        hCard.qc.setQueryData(vaultBodyQueryKey(ENTRY_ID_1, version), cachedBody);
      });
      await waitFor(() => {
        expect(screen.getByTestId('entry-body')).toHaveTextContent(cachedBody);
      });
      failCardVaultGet500 = false;
    };

    // 2a. Regular Save with vaultMeta === null:
    // First hold GET /vault, lock + unlock before releasing -> STALE_GENERATION, holder wiped, zero seal, zero PUT.
    await enterUnlockedWithNullVaultMetaAndCachedBody('Initial card body v1', 1);
    holdCardVaultGet = true;
    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    fireEvent.change(screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`), {
      target: { value: 'SENTINEL-REGULAR-SAVE-HELD-RELOAD' },
    });
    expect(holderProbeRef.current.draftValue).toBe('SENTINEL-REGULAR-SAVE-HELD-RELOAD');

    const sealsBeforeRegLock = hCard.workerCalls.filter((c) => c.type === 'sealEntry').length;
    const putsBeforeRegLock = hCard.server.requests.filter(
      (r) => r.method === 'PUT' && r.url.endsWith(`/entries/${ENTRY_ID_1}`),
    ).length;

    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    await cardVaultGetEntered.promise;

    // Lock while reloadVaultMeta is held -> holder wiped synchronously before getText
    await hCard.lock();
    expect(holderProbeRef.current).toEqual({
      originalSource: '',
      draftValue: '',
      submittedCandidateSource: '',
    });
    await hCard.unlockWithoutReload();

    cardVaultGetRelease.resolve();
    await waitFor(() => {
      expect(hCard.vault().vaultMeta?.vault_key_id).toBe(KEY_ID);
    });
    await flushMacrotask();
    await flushMacrotask();

    expect(hCard.workerCalls.filter((c) => c.type === 'sealEntry').length).toBe(
      sealsBeforeRegLock,
    );
    expect(
      hCard.server.requests.filter(
        (r) => r.method === 'PUT' && r.url.endsWith(`/entries/${ENTRY_ID_1}`),
      ),
    ).toHaveLength(putsBeforeRegLock);
    expect(holderProbeRef.current).toEqual({
      originalSource: '',
      draftValue: '',
      submittedCandidateSource: '',
    });
    expect(hCard.container.textContent).not.toContain('SENTINEL-REGULAR-SAVE-HELD-RELOAD');

    // Now regular Save happy path with vaultMeta === null -> reloads GET /vault then sends PUT -> v2
    holdCardVaultGet = false;
    await enterUnlockedWithNullVaultMetaAndCachedBody('Initial card body v1', 1);
    hCard.server.requests.splice(0);

    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    fireEvent.change(screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`), {
      target: { value: 'Regular save body v2 after null vaultMeta' },
    });
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(hCard.vault().vaultMeta?.vault_key_id).toBe(KEY_ID);
      expect(screen.queryByTestId(`entry-edit-textarea-${ENTRY_ID_1}`)).toBeNull();
      expect(screen.getByTestId('entry-body')).toHaveTextContent(
        'Regular save body v2 after null vaultMeta',
      );
    });
    const regVaultIdx = hCard.server.requests.findIndex(
      (r) => r.method === 'GET' && r.url.endsWith('/vault'),
    );
    const regPutIdx = hCard.server.requests.findIndex(
      (r) => r.method === 'PUT' && r.url.endsWith(`/entries/${ENTRY_ID_1}`),
    );
    expect(regVaultIdx).toBeGreaterThanOrEqual(0);
    expect(regPutIdx).toBeGreaterThan(regVaultIdx);

    // 2b. Keep mine with vaultMeta === null:
    // Trigger 412 conflict, then with vaultMeta === null click Keep mine -> reloads GET /vault then sends PUT -> v4
    await enterUnlockedWithNullVaultMetaAndCachedBody(
      'Regular save body v2 after null vaultMeta',
      2,
    );
    // Bump server entry version to 3 so the initial PUT gets 412 with current_version: 3
    await hCard.server.sealTextForEntry(ENTRY_ID_1, 'Remote concurrent v3', 3, 0);

    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    fireEvent.change(screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`), {
      target: { value: 'Keep mine draft v4 after null vaultMeta' },
    });
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(screen.getByTestId(`entry-conflict-banner-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    let forceNullMetaForKeepMine = true;
    Object.defineProperty(hCard.vault(), 'vaultMeta', {
      get: () => (forceNullMetaForKeepMine ? null : { vault_key_id: KEY_ID, version: 1 }),
      configurable: true,
    });
    hCard.server.requests.splice(0);

    fireEvent.click(screen.getByTestId(`entry-conflict-keep-mine-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(
        hCard.server.requests.some((r) => r.method === 'GET' && r.url.endsWith('/vault')),
      ).toBe(true);
      expect(
        hCard.server.requests.some(
          (r) => r.method === 'PUT' && r.url.endsWith(`/entries/${ENTRY_ID_1}`),
        ),
      ).toBe(true);
    });
    forceNullMetaForKeepMine = false;
    const keepMineVaultIdx = hCard.server.requests.findIndex(
      (r) => r.method === 'GET' && r.url.endsWith('/vault'),
    );
    const keepMinePutIdx = hCard.server.requests.findIndex(
      (r) => r.method === 'PUT' && r.url.endsWith(`/entries/${ENTRY_ID_1}`),
    );
    expect(keepMineVaultIdx).toBeGreaterThanOrEqual(0);
    expect(keepMinePutIdx).toBeGreaterThan(keepMineVaultIdx);
    await waitFor(() => {
      expect(screen.queryByTestId(`entry-edit-textarea-${ENTRY_ID_1}`)).toBeNull();
      expect(screen.getByTestId('entry-body')).toHaveTextContent(
        'Keep mine draft v4 after null vaultMeta',
      );
    });

    // 2c. 404 "Save as new entry" with vaultMeta === null:
    // First hold GET /vault during Save as new entry, lock + unlock before releasing -> STALE_GENERATION, zero seal, zero POST, empty holder.
    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    fireEvent.change(screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`), {
      target: { value: 'SENTINEL-SAVE-AS-NEW-HELD-RELOAD' },
    });
    hCard.server.entries.get(ENTRY_ID_1)!.deleted = true;
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(screen.getByTestId(`entry-deleted-remotely-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    let forceNullMetaForSaveAsNew = true;
    Object.defineProperty(hCard.vault(), 'vaultMeta', {
      get: () => (forceNullMetaForSaveAsNew ? null : { vault_key_id: KEY_ID, version: 1 }),
      configurable: true,
    });

    holdCardVaultGet = true;
    cardVaultGetEntered = Promise.withResolvers<void>();
    cardVaultGetRelease = Promise.withResolvers<void>();
    const sealsBeforeSaveAsNewLock = hCard.workerCalls.filter((c) => c.type === 'sealEntry').length;

    fireEvent.click(screen.getByTestId(`entry-save-as-new-${ENTRY_ID_1}`));
    await cardVaultGetEntered.promise;

    await hCard.lock();
    expect(holderProbeRef.current).toEqual({
      originalSource: '',
      draftValue: '',
      submittedCandidateSource: '',
    });
    await hCard.unlock();
    forceNullMetaForSaveAsNew = false;

    cardVaultGetRelease.resolve();
    await flushMacrotask();
    await flushMacrotask();

    expect(hCard.workerCalls.filter((c) => c.type === 'sealEntry').length).toBe(
      sealsBeforeSaveAsNewLock,
    );
    expect(
      hCard.server.requests.filter(
        (r) => r.method === 'POST' && r.url.endsWith(`/items/${ITEM_ID}/entries`),
      ),
    ).toHaveLength(0);
    expect(hCard.container.textContent).not.toContain('SENTINEL-SAVE-AS-NEW-HELD-RELOAD');

    // Now 404 "Save as new entry" happy path with vaultMeta === null -> reloads GET /vault then POSTs /items/{id}/entries
    holdCardVaultGet = false;
    hCard.server.entries.get(ENTRY_ID_1)!.deleted = false;
    act(() => {
      hCard.qc.setQueryData(
        vaultBodyQueryKey(ENTRY_ID_1, 4),
        'Keep mine draft v4 after null vaultMeta',
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent(
        'Keep mine draft v4 after null vaultMeta',
      );
    });

    fireEvent.click(screen.getByTestId(`entry-edit-btn-${ENTRY_ID_1}`));
    fireEvent.change(screen.getByTestId(`entry-edit-textarea-${ENTRY_ID_1}`), {
      target: { value: 'Rescued via 404 Save as new entry with null vaultMeta' },
    });
    hCard.server.entries.get(ENTRY_ID_1)!.deleted = true;
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(screen.getByTestId(`entry-deleted-remotely-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    let forceNullMetaHappySaveAsNew = true;
    Object.defineProperty(hCard.vault(), 'vaultMeta', {
      get: () => (forceNullMetaHappySaveAsNew ? null : { vault_key_id: KEY_ID, version: 1 }),
      configurable: true,
    });
    hCard.server.requests.splice(0);

    fireEvent.click(screen.getByTestId(`entry-save-as-new-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(
        hCard.server.requests.some((r) => r.method === 'GET' && r.url.endsWith('/vault')),
      ).toBe(true);
      expect(
        hCard.server.requests.some(
          (r) => r.method === 'POST' && r.url.endsWith(`/items/${ITEM_ID}/entries`),
        ),
      ).toBe(true);
    });
    forceNullMetaHappySaveAsNew = false;
    const saveAsNewVaultIdx = hCard.server.requests.findIndex(
      (r) => r.method === 'GET' && r.url.endsWith('/vault'),
    );
    const saveAsNewPostIdx = hCard.server.requests.findIndex(
      (r) => r.method === 'POST' && r.url.endsWith(`/items/${ITEM_ID}/entries`),
    );
    expect(saveAsNewVaultIdx).toBeGreaterThanOrEqual(0);
    expect(saveAsNewPostIdx).toBeGreaterThan(saveAsNewVaultIdx);
    await waitFor(() => {
      expect(screen.getByTestId('entry-body')).toHaveTextContent(
        'Rescued via 404 Save as new entry with null vaultMeta',
      );
    });
  });

  it('IP15-FE4-3: unlocked item page with vaultKeyId === null makes one reloadVaultMeta() attempt and shows the error/Retry card instead of an endless skeleton if it fails or stays null, then decrypts on Retry', async () => {
    let failVaultMetaMode: 'network_500' | 'invalid_key_id' | 'ok' = 'network_500';
    const h = await setupItemPageHarness({
      initialPlaintexts: [{ id: ENTRY_ID_1, text: 'Decrypted after Retry', position: 0 }],
      skipInitialVaultMetaReload: true,
    });

    // First lock, configure /vault to fail with 500, and unlockWithoutReload so useEntryBody enters
    // unlocked state with vaultKeyId === null against the failing /vault endpoint.
    await h.lock();
    h.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.endsWith('/vault')) {
        if (failVaultMetaMode === 'network_500') {
          return problemResponse('internal_error', 500);
        }
        if (failVaultMetaMode === 'invalid_key_id') {
          return jsonResponse({
            vault_key_id: '',
            version: 1,
          });
        }
      }
      return null;
    });
    h.server.requests.splice(0);

    await h.unlockWithoutReload();
    expect(h.vault().state).toBe('unlocked');
    expect(h.vault().vaultMeta).toBeNull();

    // 1. One reloadVaultMeta() attempt fails (500) -> shows entry-body-error with Retry instead of endless loading skeleton
    await waitFor(() => {
      expect(screen.getByTestId('entry-body-error')).toBeInTheDocument();
      expect(screen.getByTestId('entry-body-retry')).toBeEnabled();
    });
    expect(screen.queryByTestId('entry-body-loading')).toBeNull();
    expect(
      h.server.requests.filter((r) => r.method === 'GET' && r.url.endsWith('/vault')),
    ).toHaveLength(1);

    // 2. Click Retry when reloadVaultMeta returns an empty/invalid key_id -> still shows entry-body-error with Retry
    failVaultMetaMode = 'invalid_key_id';
    fireEvent.click(screen.getByTestId('entry-body-retry'));
    await waitFor(() => {
      expect(
        h.server.requests.filter((r) => r.method === 'GET' && r.url.endsWith('/vault')),
      ).toHaveLength(2);
      expect(screen.getByTestId('entry-body-error')).toBeInTheDocument();
      expect(screen.getByTestId('entry-body-retry')).toBeEnabled();
    });
    expect(screen.queryByTestId('entry-body-loading')).toBeNull();

    // 3. Click Retry when reloadVaultMeta succeeds -> resolves vault_key_id and decrypts the entry body
    failVaultMetaMode = 'ok';
    fireEvent.click(screen.getByTestId('entry-body-retry'));
    await waitFor(() => {
      expect(h.vault().vaultMeta?.vault_key_id).toBe(KEY_ID);
      expect(screen.queryByTestId('entry-body-error')).toBeNull();
      expect(screen.getByTestId('entry-body')).toHaveTextContent('Decrypted after Retry');
    });
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
      const bodiesText = screen
        .getAllByTestId('entry-body')
        .map((el) => el.textContent);
      expect(bodiesText).toEqual([
        'Entry 2 body',
        'Draft rescued via Save as new entry',
      ]);
    });
    const postCreateRequests = h.server.requests.filter(
      (r) => r.method === 'POST' && r.url.endsWith(`/items/${ITEM_ID}/entries`),
    );
    const parsedPostCreate: unknown = JSON.parse(
      postCreateRequests[postCreateRequests.length - 1].rawBody,
    );
    const rescuedEntryId =
      parsedPostCreate !== null &&
      typeof parsedPostCreate === 'object' &&
      'id' in parsedPostCreate &&
      typeof parsedPostCreate.id === 'string'
        ? parsedPostCreate.id
        : '';
    expect(getRenderedEntryCardIds(h.container)).toEqual([ENTRY_ID_2, rescuedEntryId]);
  });
});
