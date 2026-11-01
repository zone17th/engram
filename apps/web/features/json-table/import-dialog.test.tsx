import type { ProblemDetails } from '@engram/shared-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/components/theme-provider';
import { UndoToastProvider } from '@/components/ui/undo-toast';
import { SessionProvider, useSession } from '@/features/auth/session-provider';
import {
  assertVaultSecretElementAttributes,
  clearAllUnconfirmedSaves,
  resetEntryBodyLoadLimiterForTests,
} from '@/features/entries';
import { assertNoPlaintextAttrs } from '@/features/entries/test-utils/assert-no-plaintext-attrs';
import { ItemDetailPage } from '@/features/items/item-detail-page';
import {
  getJsonImportHandoffSnapshot,
  importDialogTesting,
  openJsonImportFromHandoff,
  wipeJsonImportHandoff,
  type JsonImportPlaintextHolder,
} from '@/features/json-table';
import {
  VaultProvider,
  resetVaultBroadcastForTests,
  useVault,
  type LockEpochEnvironment,
  type VaultContextValue,
} from '@/features/vault';
import type { Me } from '@/lib/api/auth';
import type {
  Entry,
  EntryEnvelopeV1,
  EntryMeta,
  ItemSummary,
  Tag,
} from '@/lib/api/content';
import { postSessionBroadcast } from '@/lib/auth/broadcast';
import { __testing as userChangedTesting } from '@/lib/auth/user-changed';
import type { CreateVaultResult } from '@/lib/crypto/client';
import { KEK_BYTES, type DeriveKekFn, type ValidatedKdfParams } from '@/lib/crypto/kdf';
import type { Sodium } from '@/lib/crypto/sodium';
import { createWorkerShim } from '@/lib/crypto/test/worker-shim';
import { JSON_FORMAT_MAX_DEPTH } from '@/lib/json';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  pathname: '/app/items/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: routerMocks.push,
    replace: routerMocks.replace,
    prefetch: vi.fn(),
  }),
  usePathname: () => routerMocks.pathname,
  useSearchParams: () => new URLSearchParams(),
  redirect: (url: string) => routerMocks.redirect(url),
}));

const PASSPHRASE = 'task17-import-json-passphrase-1';
const KEY_ID = 'vk:7f3a91c4e0b2d8a1f5c309';
const ITEM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENTRY_ID_1 = '11111111-1111-4111-8111-111111111111';
const USER_A_ID = '33333333-3333-4333-8333-333333333333';
const USER_B_ID = '44444444-4444-4444-8444-444444444444';

const utf8Encoder = new TextEncoder();

function createDeferred<T = void>(): PromiseWithResolvers<T> {
  return Promise.withResolvers<T>();
}

function flushMacrotask(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(() => resolve(), 0);
  return promise;
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
  let marker = { epochIncarnation: 'inc-task17-1', lockEpoch: 1 };
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

function rnJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function problemResponse(
  code: ProblemDetails['code'],
  status: number,
  extra?: Partial<ProblemDetails>,
): Response {
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
      headers: { 'Content-Type': 'application/problem+json' },
    },
  );
}

interface StoredEntryRecord extends Entry {
  source?: 'paste' | 'file';
  deleted?: boolean;
}

interface ServerSimulator {
  item: ItemSummary;
  entries: Map<string, StoredEntryRecord>;
  requests: Array<{
    method: string;
    url: string;
    headers: Record<string, string>;
    rawBody: string;
  }>;
  openServerEntryPlaintext: (entryId: string) => Promise<string>;
  overrideRoute: (
    fn:
      | ((
          url: string,
          init: RequestInit | undefined,
        ) => Promise<Response | null> | Response | null)
      | null,
  ) => void;
}

function toEntryMeta(rec: StoredEntryRecord): EntryMeta {
  return {
    id: rec.id,
    item_id: rec.item_id,
    type: rec.type,
    position: rec.position,
    version: rec.version,
    plaintext_len_bucket: rec.plaintext_len_bucket,
    created_at: rec.created_at,
    updated_at: rec.updated_at,
  };
}

const shims: Array<{ close: () => void }> = [];
let activeClipboardDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  activeClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  document.cookie = 'sabk_csrf=test-csrf-token';
  routerMocks.push.mockReset();
  routerMocks.replace.mockReset();
  routerMocks.redirect.mockClear();
  routerMocks.pathname = `/app/items/${ITEM_ID}`;
  resetVaultBroadcastForTests();
  resetEntryBodyLoadLimiterForTests();
  clearAllUnconfirmedSaves();
  userChangedTesting.resetCommittedUserForTests();
  wipeJsonImportHandoff({ bumpLockEpoch: true });
  importDialogTesting.setJsonImportPlaintextHolderForTests(null);
});

afterEach(() => {
  cleanup();
  wipeJsonImportHandoff({ bumpLockEpoch: true });
  importDialogTesting.setJsonImportPlaintextHolderForTests(null);
  if (activeClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', activeClipboardDescriptor);
  }
  for (const shim of shims.splice(0)) {
    shim.close();
  }
  resetVaultBroadcastForTests();
  resetEntryBodyLoadLimiterForTests();
  clearAllUnconfirmedSaves();
  userChangedTesting.resetCommittedUserForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface ImportHarness {
  container: HTMLElement;
  qc: QueryClient;
  vault: () => VaultContextValue;
  server: ServerSimulator;
  unlock: () => Promise<void>;
  lock: () => Promise<void>;
  setCurrentMe: (nextMe: Me | null) => void;
  rerenderPage: (node?: ReactNode) => void;
}

async function setupImportHarness(options?: {
  locale?: 'en' | 'vi';
  initialItem?: Partial<ItemSummary>;
  initialEntries?: Array<{
    id: string;
    text: string;
    type?: 'text' | 'json';
    position?: number;
    version?: number;
  }>;
  lookupItems?: ItemSummary[];
  skipInitialReloadVaultMeta?: boolean;
}): Promise<ImportHarness> {
  const locale = options?.locale ?? 'vi';
  let vaultCtx!: VaultContextValue;
  function Probe() {
    vaultCtx = useVault();
    useSession();
    return <output data-testid="vault-state-probe">{vaultCtx.state}</output>;
  }

  let createdVault: CreateVaultResult | null = null;
  let currentMe: Me | null = makeMe(USER_A_ID, 'present');
  const entriesMap = new Map<string, StoredEntryRecord>();
  const requests: ServerSimulator['requests'] = [];
  let routeOverride:
    | ((
        url: string,
        init: RequestInit | undefined,
      ) => Promise<Response | null> | Response | null)
    | null = null;

  const idempotencyCache = new Map<string, { status: number; body: unknown }>();

  const serverItem: ItemSummary = {
    id: ITEM_ID,
    name: 'wifi',
    hint: 'Router Tầng 2',
    tags: [{ id: 'tag-1', display: 'nhà' }],
    entry_count: 1,
    version: 1,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    last_used_at: '2026-11-01T00:00:00Z',
    ...(options?.initialItem ?? {}),
  };

  const catalogTags: Tag[] = [
    {
      id: 'tag-1',
      display: 'nhà',
      item_count: 3,
      created_at: '2026-11-01T00:00:00Z',
      last_used_at: '2026-11-01T00:00:00Z',
    },
  ];

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
    const headersObj: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        headersObj[k.toLowerCase()] = v;
      });
    }
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    requests.push({ method, url, headers: headersObj, rawBody });

    if (routeOverride) {
      const custom = await routeOverride(url, init);
      if (custom) return custom;
    }

    if (url.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
    if (url.endsWith('/auth/config')) {
      return rnJsonResponse({
        oauth_providers: [],
        email_verification_required: false,
        captcha_site_key: null,
      });
    }
    if (url.endsWith('/auth/me')) {
      if (!currentMe) return problemResponse('session_invalid', 401);
      return rnJsonResponse(currentMe);
    }
    if (url.endsWith('/auth/logout')) {
      currentMe = null;
      return new Response(null, { status: 204 });
    }
    if (url.endsWith('/vault')) {
      if (!createdVault) return problemResponse('vault_absent', 404);
      return rnJsonResponse(makeVaultGetResponse(createdVault, KEY_ID, 1));
    }

    const parsedUrl = new URL(url, 'http://localhost');
    const pathname = parsedUrl.pathname;

    if (pathname === '/api/v1/items/lookup' && method === 'GET') {
      const items = options?.lookupItems ?? [serverItem];
      return rnJsonResponse({
        items,
        total: items.length,
        next_cursor: null,
      });
    }

    if (pathname === '/api/v1/items' && method === 'POST') {
      const body = JSON.parse(rawBody) as { id?: string; name: string };
      const created: ItemSummary = {
        id: body.id ?? crypto.randomUUID().toLowerCase(),
        name: body.name,
        hint: null,
        tags: [],
        entry_count: 0,
        version: 1,
        created_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-01T00:00:00Z',
        last_used_at: '2026-11-01T00:00:00Z',
      };
      return rnJsonResponse(created, 201);
    }

    if (pathname === `/api/v1/items/${ITEM_ID}` && method === 'GET') {
      return rnJsonResponse({
        ...serverItem,
        entry_count: liveEntryMetas().length,
      });
    }

    if (pathname === '/api/v1/tags' && method === 'GET') {
      return rnJsonResponse({ items: catalogTags, next_cursor: null });
    }

    if (pathname === `/api/v1/items/${ITEM_ID}/entries` && method === 'GET') {
      return rnJsonResponse({
        items: liveEntryMetas(),
        next_cursor: null,
      });
    }

    // POST /api/v1/items/{id}/entries/import-json
    const importMatch = /^\/api\/v1\/items\/([^/]+)\/entries\/import-json$/.exec(pathname);
    if (importMatch && method === 'POST') {
      const targetItemId = decodeURIComponent(importMatch[1]!);
      const idemKey = headersObj['idempotency-key'] ?? '';
      if (idemKey && idempotencyCache.has(idemKey)) {
        const cached = idempotencyCache.get(idemKey)!;
        return rnJsonResponse(cached.body, cached.status);
      }

      const liveCount = Array.from(entriesMap.values()).filter(
        (e) => !e.deleted && e.item_id === targetItemId,
      ).length;
      if (liveCount >= 200 || (targetItemId === ITEM_ID && serverItem.entry_count >= 200)) {
        return problemResponse('item_entry_limit', 409);
      }

      const req = JSON.parse(rawBody) as {
        id: string;
        type: 'json';
        source: 'paste' | 'file';
        envelope: EntryEnvelopeV1;
        ciphertext: string;
        plaintext_len_bucket: number;
      };
      if (req.type !== 'json') {
        return problemResponse('entry_invalid', 400);
      }
      if (req.source !== 'paste' && req.source !== 'file') {
        return problemResponse('invalid_request', 400);
      }

      const allPositions = Array.from(entriesMap.values()).map((e) => e.position);
      const nextPos = allPositions.length > 0 ? Math.max(...allPositions) + 1 : 0;
      const newEntry: StoredEntryRecord = {
        id: req.id,
        item_id: targetItemId,
        type: 'json',
        source: req.source,
        position: nextPos,
        version: 1,
        plaintext_len_bucket: req.plaintext_len_bucket,
        envelope: req.envelope,
        ciphertext: req.ciphertext,
        created_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-01T00:00:00Z',
      };
      entriesMap.set(newEntry.id, newEntry);
      if (targetItemId === ITEM_ID) {
        serverItem.entry_count = liveEntryMetas().length;
      }
      const meta = toEntryMeta(newEntry);
      if (idemKey) {
        idempotencyCache.set(idemKey, { status: 201, body: meta });
      }
      return rnJsonResponse(meta, 201);
    }

    // POST /api/v1/items/{id}/entries (Save as text)
    const entriesPostMatch = /^\/api\/v1\/items\/([^/]+)\/entries$/.exec(pathname);
    if (entriesPostMatch && method === 'POST') {
      const targetItemId = decodeURIComponent(entriesPostMatch[1]!);
      const idemKey = headersObj['idempotency-key'] ?? '';
      if (idemKey && idempotencyCache.has(idemKey)) {
        const cached = idempotencyCache.get(idemKey)!;
        return rnJsonResponse(cached.body, cached.status);
      }

      const req = JSON.parse(rawBody) as {
        id: string;
        type: 'text' | 'json';
        envelope: EntryEnvelopeV1;
        ciphertext: string;
        plaintext_len_bucket: number;
      };
      const allPositions = Array.from(entriesMap.values()).map((e) => e.position);
      const nextPos = allPositions.length > 0 ? Math.max(...allPositions) + 1 : 0;
      const newEntry: StoredEntryRecord = {
        id: req.id,
        item_id: targetItemId,
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
      if (targetItemId === ITEM_ID) {
        serverItem.entry_count = liveEntryMetas().length;
      }
      const meta = toEntryMeta(newEntry);
      if (idemKey) {
        idempotencyCache.set(idemKey, { status: 201, body: meta });
      }
      return rnJsonResponse(meta, 201);
    }

    const singleEntryMatch = /^\/api\/v1\/entries\/([^/]+)$/.exec(pathname);
    if (singleEntryMatch) {
      const eid = decodeURIComponent(singleEntryMatch[1]!);
      const rec = entriesMap.get(eid);
      if (!rec || rec.deleted) {
        return problemResponse('not_found', 404);
      }
      if (method === 'GET') {
        return rnJsonResponse({
          ...toEntryMeta(rec),
          envelope: rec.envelope,
          ciphertext: rec.ciphertext,
        });
      }
      if (method === 'DELETE') {
        rec.deleted = true;
        serverItem.entry_count = liveEntryMetas().length;
        return new Response(null, { status: 204 });
      }
    }

    if (pathname === '/api/v1/tags' && method === 'POST') {
      const body = JSON.parse(rawBody) as { display: string };
      const tag: Tag = {
        id: `tag-${body.display}`,
        display: body.display,
        item_count: 1,
        created_at: '2026-11-01T00:00:00Z',
        last_used_at: '2026-11-01T00:00:00Z',
      };
      return rnJsonResponse(tag, 201);
    }

    const itemTagsMatch = /^\/api\/v1\/items\/([^/]+)\/tags$/.exec(pathname);
    if (itemTagsMatch && method === 'POST') {
      return rnJsonResponse(serverItem, 200);
    }

    return rnJsonResponse({});
  });

  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });

  const messages = locale === 'en' ? enMessages : viMessages;

  function buildTree(node?: ReactNode) {
    const content =
      node !== undefined ? (
        node
      ) : (
        <ItemDetailPage itemId={ITEM_ID} lazyCards={false} />
      );
    return (
      <NextIntlClientProvider locale={locale} messages={messages}>
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
                  {content}
                </VaultProvider>
              </SessionProvider>
            </UndoToastProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </NextIntlClientProvider>
    );
  }

  const rendered = render(buildTree(null));

  await waitFor(() => {
    expect(screen.getByTestId('vault-state-probe')).toHaveTextContent('locked');
  });

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

  const initialList = options?.initialEntries ?? [
    {
      id: ENTRY_ID_1,
      text: '{"ssid":"Zone17","vlan":10}',
      type: 'json' as const,
      position: 0,
      version: 1,
    },
  ];

  for (let i = 0; i < initialList.length; i++) {
    const spec = initialList[i]!;
    const op = vaultCtx.beginOp();
    const sealed = await op.client.sealEntry({
      entryId: spec.id,
      keyId: KEY_ID,
      plaintext: spec.text,
      opGeneration: op.opGeneration,
    });
    const bytes = utf8Encoder.encode(spec.text).byteLength;
    const bucket = Math.max(256, Math.ceil(bytes / 256) * 256);
    entriesMap.set(spec.id, {
      id: spec.id,
      item_id: ITEM_ID,
      type: spec.type ?? 'json',
      position: spec.position ?? i,
      version: spec.version ?? 1,
      plaintext_len_bucket: bucket,
      envelope: sealed.envelope,
      ciphertext: sealed.ciphertext,
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-01T00:00:00Z',
    });
  }
  serverItem.entry_count = liveEntryMetas().length;
  requests.splice(0);

  rendered.rerender(buildTree());

  const openServerEntryPlaintext = async (entryId: string): Promise<string> => {
    const rec = entriesMap.get(entryId);
    if (!rec) throw new Error(`Entry ${entryId} not found`);
    const op = vaultCtx.beginOp();
    const opened = await op.client.openEntry({
      entryId: rec.id,
      envelope: rec.envelope,
      ciphertext: rec.ciphertext,
      opGeneration: op.opGeneration,
    });
    return opened.plaintext;
  };

  return {
    container: rendered.container,
    qc,
    vault: () => vaultCtx,
    server: {
      item: serverItem,
      entries: entriesMap,
      requests,
      openServerEntryPlaintext,
      overrideRoute: (fn) => {
        routeOverride = fn;
      },
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
    lock: async () => {
      await act(async () => {
        await vaultCtx.lockNow();
      });
      await waitFor(() => expect(vaultCtx.state).toBe('locked'));
    },
    setCurrentMe: (nextMe: Me | null) => {
      currentMe = nextMe;
    },
    rerenderPage: (node?: ReactNode) => {
      rendered.rerender(buildTree(node));
    },
  };
}

function makeFileFromBytes(bytes: Uint8Array, name = 'test.json'): File {
  const exactBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const file = new File([exactBuffer], name, { type: 'application/json' });
  if (typeof file.arrayBuffer !== 'function') {
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => exactBuffer,
    });
  }
  return file;
}

describe('P04-T17 Import JSON U14 (import-dialog.tsx, item-detail-page Milestone C, omnibox handoff dec-209)', () => {
  it('imports a UTF-8 BOM .json file and saves exact bytes minus at most one leading BOM, keeping a second BOM for strict parser rejection or Save as text', async () => {
    const h = await setupImportHarness();
    await waitFor(() => {
      expect(screen.getByTestId('btn-import-json')).toBeEnabled();
    });

    fireEvent.click(screen.getByTestId('btn-import-json'));
    const dialog = screen.getByTestId('import-json-dialog');
    expect(dialog).toBeInTheDocument();

    // 1. Single UTF-8 BOM (EF BB BF) + JSON content
    const jsonPayload = '{"bom_test":"kept","digits":100.50}';
    const bomBytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8Encoder.encode(jsonPayload)]);
    const fileInput = within(dialog).getByTestId('import-json-file-input');

    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [makeFileFromBytes(bomBytes, 'bom.json')] },
      });
    });

    await waitFor(() => {
      expect(within(dialog).getByTestId('import-json-source-badge')).toHaveTextContent(
        `${utf8Encoder.encode(jsonPayload).byteLength}`,
      );
    });

    fireEvent.click(within(dialog).getByTestId('import-json-submit-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('import-json-dialog')).toBeNull();
    });

    const importReqs = h.server.requests.filter((r) =>
      r.url.endsWith(`/items/${ITEM_ID}/entries/import-json`),
    );
    expect(importReqs).toHaveLength(1);
    const reqBody = JSON.parse(importReqs[0]!.rawBody) as { id: string; source: string };
    expect(reqBody.source).toBe('file');
    const savedPlaintext = await h.server.openServerEntryPlaintext(reqBody.id);
    expect(savedPlaintext).toBe(jsonPayload);
    expect(savedPlaintext.charCodeAt(0)).not.toBe(0xfeff);

    // 2. Double UTF-8 BOM (EF BB BF EF BB BF) -> strips at most one BOM, leaving the second U+FEFF
    //    so strict JSON parser rejects it while "Lưu dạng văn bản" (Save as text) preserves the second BOM verbatim
    fireEvent.click(screen.getByTestId('btn-import-json'));
    const dialogDoubleBom = screen.getByTestId('import-json-dialog');
    const doubleBomBytes = new Uint8Array([
      0xef, 0xbb, 0xbf,
      0xef, 0xbb, 0xbf,
      ...utf8Encoder.encode(jsonPayload),
    ]);
    await act(async () => {
      fireEvent.change(within(dialogDoubleBom).getByTestId('import-json-file-input'), {
        target: { files: [makeFileFromBytes(doubleBomBytes, 'double-bom.json')] },
      });
    });

    await waitFor(() => {
      expect(within(dialogDoubleBom).getByTestId('import-json-parse-error')).toBeInTheDocument();
    });
    expect(within(dialogDoubleBom).getByTestId('import-json-submit-btn')).toBeDisabled();

    const saveAsTextBtn = within(dialogDoubleBom).getByTestId('import-json-save-as-text-btn');
    expect(saveAsTextBtn).toBeEnabled();
    fireEvent.click(saveAsTextBtn);

    await waitFor(() => {
      expect(screen.queryByTestId('import-json-dialog')).toBeNull();
    });

    const textCreateReqs = h.server.requests.filter(
      (r) => r.url.endsWith(`/items/${ITEM_ID}/entries`) && r.method === 'POST',
    );
    expect(textCreateReqs).toHaveLength(1);
    const textReqBody = JSON.parse(textCreateReqs[0]!.rawBody) as { id: string; type: string };
    expect(textReqBody.type).toBe('text');
    const savedDoubleBomText = await h.server.openServerEntryPlaintext(textReqBody.id);
    expect(savedDoubleBomText).toBe(`\uFEFF${jsonPayload}`);
  });

  it('pasting JSON with CRLF via a simulated paste event preserves the exact clipboardData string as the saved source (rule 3)', async () => {
    const h = await setupImportHarness();
    await waitFor(() => {
      expect(screen.getByTestId('btn-import-json')).toBeEnabled();
    });

    fireEvent.click(screen.getByTestId('btn-import-json'));
    const dialog = screen.getByTestId('import-json-dialog');
    const textarea = within(dialog).getByTestId('import-json-source-textarea');

    const crlfClipboardJson = '{\r\n  "host": "db.internal",\r\n  "port": 5432\r\n}';
    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (type: string) => (type === 'text/plain' ? crlfClipboardJson : ''),
      },
    });

    await waitFor(() => {
      expect(within(dialog).getByTestId('import-json-submit-btn')).not.toBeDisabled();
    });

    fireEvent.click(within(dialog).getByTestId('import-json-submit-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('import-json-dialog')).toBeNull();
    });

    const importReqs = h.server.requests.filter((r) =>
      r.url.endsWith(`/items/${ITEM_ID}/entries/import-json`),
    );
    expect(importReqs).toHaveLength(1);
    const reqBody = JSON.parse(importReqs[0]!.rawBody) as { id: string; source: string };
    expect(reqBody.source).toBe('paste');
    const savedPlaintext = await h.server.openServerEntryPlaintext(reqBody.id);
    expect(savedPlaintext).toBe(crlfClipboardJson);
  });

  it('importing a CRLF .json file preserves CRLF byte-for-byte in the sealed entry and displays pasteExactHint', async () => {
    const h = await setupImportHarness();
    await waitFor(() => {
      expect(screen.getByTestId('btn-import-json')).toBeEnabled();
    });

    fireEvent.click(screen.getByTestId('btn-import-json'));
    const dialog = screen.getByTestId('import-json-dialog');
    expect(within(dialog).getByTestId('import-json-paste-exact-hint')).toHaveTextContent(
      viMessages.content.json.pasteExactHint,
    );

    const crlfFileContent = '{\r\n  "service": "vault",\r\n  "active": true\r\n}\r\n';
    const fileBytes = utf8Encoder.encode(crlfFileContent);
    const fileInput = within(dialog).getByTestId('import-json-file-input');

    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [makeFileFromBytes(fileBytes, 'crlf.json')] },
      });
    });

    await waitFor(() => {
      expect(within(dialog).getByTestId('import-json-submit-btn')).not.toBeDisabled();
    });

    // Switch preview to Raw JSON tab and verify read-only preview + Table tab
    fireEvent.click(within(dialog).getByTestId('import-json-preview-tab-raw'));
    expect(within(dialog).getByTestId('import-json-preview-raw')).toHaveTextContent('"service": "vault"');
    fireEvent.click(within(dialog).getByTestId('import-json-preview-tab-table'));
    expect(within(dialog).getByRole('treegrid')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByTestId('import-json-submit-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('import-json-dialog')).toBeNull();
    });

    const importReqs = h.server.requests.filter((r) =>
      r.url.endsWith(`/items/${ITEM_ID}/entries/import-json`),
    );
    expect(importReqs).toHaveLength(1);
    const reqBody = JSON.parse(importReqs[0]!.rawBody) as { id: string; source: string };
    expect(reqBody.source).toBe('file');
    const savedPlaintext = await h.server.openServerEntryPlaintext(reqBody.id);
    expect(savedPlaintext).toBe(crlfFileContent);
  });

  it('rejects corrupt UTF-8 .json files with fatal decoding and never inserts U+FFFD replacement characters', async () => {
    await setupImportHarness();
    await waitFor(() => {
      expect(screen.getByTestId('btn-import-json')).toBeEnabled();
    });

    fireEvent.click(screen.getByTestId('btn-import-json'));
    const dialog = screen.getByTestId('import-json-dialog');
    const fileInput = within(dialog).getByTestId('import-json-file-input');

    // Invalid UTF-8 sequence: 0xC3 0x28 inside '{"bad":"..."}'
    const invalidBytes = new Uint8Array([
      0x7b, 0x22, 0x62, 0x61, 0x64, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
    ]);

    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [makeFileFromBytes(invalidBytes, 'corrupt.json')] },
      });
    });

    await waitFor(() => {
      expect(within(dialog).getByTestId('import-json-utf8-error')).toBeInTheDocument();
    });

    const textarea = within(dialog).getByTestId('import-json-source-textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('');
    expect(textarea.value).not.toContain('\uFFFD');
    expect(within(dialog).getByTestId('import-json-submit-btn')).toBeDisabled();
  });

  it('accepts a 262,144-byte UTF-8 JSON payload and rejects a 262,145-byte payload with 413 over-cap error', async () => {
    const h = await setupImportHarness();
    await waitFor(() => {
      expect(screen.getByTestId('btn-import-json')).toBeEnabled();
    });

    fireEvent.click(screen.getByTestId('btn-import-json'));
    const dialog = screen.getByTestId('import-json-dialog');
    const fileInput = within(dialog).getByTestId('import-json-file-input');

    // Build exact 262,144 B JSON: `{"a":"..."}` where overhead is 8 bytes (`{"a":""}`) -> 262,136 'x' chars
    const exact256KiB = `{"a":"${'x'.repeat(262_144 - 8)}"}`;
    expect(utf8Encoder.encode(exact256KiB).byteLength).toBe(262_144);

    // Build 262,145 B JSON: 1 byte over cap
    const overCap256KiBPlus1 = `{"a":"${'x'.repeat(262_145 - 8)}"}`;
    expect(utf8Encoder.encode(overCap256KiBPlus1).byteLength).toBe(262_145);

    // 1. 262,145 B -> rejected with over-cap alert and submit disabled
    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [makeFileFromBytes(utf8Encoder.encode(overCap256KiBPlus1), 'over.json')] },
      });
    });

    await waitFor(() => {
      expect(within(dialog).getByTestId('import-json-over-cap-error')).toBeInTheDocument();
    });
    expect(within(dialog).getByTestId('import-json-submit-btn')).toBeDisabled();

    // 2. 262,144 B -> accepted and saves 201
    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [makeFileFromBytes(utf8Encoder.encode(exact256KiB), 'exact.json')] },
      });
    });

    await waitFor(() => {
      expect(within(dialog).queryByTestId('import-json-over-cap-error')).toBeNull();
      expect(within(dialog).getByTestId('import-json-submit-btn')).not.toBeDisabled();
    });

    fireEvent.click(within(dialog).getByTestId('import-json-submit-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('import-json-dialog')).toBeNull();
    });

    const importReqs = h.server.requests.filter((r) =>
      r.url.endsWith(`/items/${ITEM_ID}/entries/import-json`),
    );
    expect(importReqs).toHaveLength(1);
  });

  it('shows parse error line/column and saves verbatim as a text entry when clicking "Lưu dạng văn bản" (Save as text)', async () => {
    const h = await setupImportHarness();
    await waitFor(() => {
      expect(screen.getByTestId('btn-import-json')).toBeEnabled();
    });

    fireEvent.click(screen.getByTestId('btn-import-json'));
    const dialog = screen.getByTestId('import-json-dialog');
    const textarea = within(dialog).getByTestId('import-json-source-textarea');

    const brokenJson = '{\n  "key": "value",\n}';
    fireEvent.change(textarea, { target: { value: brokenJson } });

    const parseAlert = within(dialog).getByTestId('import-json-parse-error');
    expect(parseAlert).toHaveTextContent('Dòng 2, cột 17: dấu phẩy thừa');
    expect(within(dialog).getByTestId('import-json-submit-btn')).toBeDisabled();

    const saveAsTextBtn = within(dialog).getByTestId('import-json-save-as-text-btn');
    expect(saveAsTextBtn).not.toBeDisabled();
    fireEvent.click(saveAsTextBtn);

    await waitFor(() => {
      expect(screen.queryByTestId('import-json-dialog')).toBeNull();
    });

    const textCreateReqs = h.server.requests.filter(
      (r) => r.url.endsWith(`/items/${ITEM_ID}/entries`) && r.method === 'POST',
    );
    expect(textCreateReqs).toHaveLength(1);
    const reqBody = JSON.parse(textCreateReqs[0]!.rawBody) as { id: string; type: string };
    expect(reqBody.type).toBe('text');
    const savedText = await h.server.openServerEntryPlaintext(reqBody.id);
    expect(savedText).toBe(brokenJson);
  });

  it('preserves pasted text in the dialog when POST /entries/import-json returns 409 item_entry_limit at 200 entries', async () => {
    const h = await setupImportHarness();
    await waitFor(() => {
      expect(screen.getByTestId('btn-import-json')).toBeEnabled();
    });

    fireEvent.click(screen.getByTestId('btn-import-json'));
    const dialog = screen.getByTestId('import-json-dialog');
    const textarea = within(dialog).getByTestId('import-json-source-textarea') as HTMLTextAreaElement;

    const candidateJson = '{"limit_check":"keep_this_draft_on_409"}';
    fireEvent.change(textarea, { target: { value: candidateJson } });

    h.server.overrideRoute((url, init) => {
      if (url.endsWith(`/items/${ITEM_ID}/entries/import-json`) && init?.method === 'POST') {
        return problemResponse('item_entry_limit', 409);
      }
      return null;
    });

    fireEvent.click(within(dialog).getByTestId('import-json-submit-btn'));

    await waitFor(() => {
      expect(within(dialog).getByTestId('import-json-save-error')).toHaveTextContent(
        viMessages.content.errors.item_entry_limit,
      );
    });

    // Dialog stays open and the pasted text is preserved intact
    expect(screen.getByTestId('import-json-dialog')).toBeInTheDocument();
    expect(textarea.value).toBe(candidateJson);
  });

  it('retries after a network/503 failure with the exact same Idempotency-Key and sealed ciphertext without creating a duplicate entry, and never sends plaintext over the network', async () => {
    const h = await setupImportHarness();
    await waitFor(() => {
      expect(screen.getByTestId('btn-import-json')).toBeEnabled();
    });

    fireEvent.click(screen.getByTestId('btn-import-json'));
    const dialog = screen.getByTestId('import-json-dialog');
    const textarea = within(dialog).getByTestId('import-json-source-textarea');

    const secretMarker = 'SUPER_SECRET_IMPORT_VALUE_987654';
    const jsonPayload = `{"token":"${secretMarker}","nested":{"pin":4321}}`;
    fireEvent.change(textarea, { target: { value: jsonPayload } });

    let importAttempts = 0;
    h.server.overrideRoute((url, init) => {
      if (url.endsWith(`/items/${ITEM_ID}/entries/import-json`) && init?.method === 'POST') {
        importAttempts += 1;
        if (importAttempts <= 3) {
          return problemResponse('dependency_unavailable', 503, { retry_after: 60 });
        }
      }
      return null;
    });

    fireEvent.click(within(dialog).getByTestId('import-json-submit-btn'));

    await waitFor(() => {
      expect(within(dialog).getByTestId('import-json-retry-banner')).toBeInTheDocument();
    });

    // Click Retry -> replays the exact same Idempotency-Key and sealed body
    fireEvent.click(within(dialog).getByTestId('import-json-retry-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('import-json-dialog')).toBeNull();
    });

    const importReqs = h.server.requests.filter((r) =>
      r.url.endsWith(`/items/${ITEM_ID}/entries/import-json`),
    );
    expect(importReqs).toHaveLength(2);

    const firstKey = importReqs[0]!.headers['idempotency-key'];
    const firstBody = importReqs[0]!.rawBody;
    expect(firstKey).toBeTruthy();
    for (const req of importReqs) {
      expect(req.headers['idempotency-key']).toBe(firstKey);
      expect(req.rawBody).toBe(firstBody);
    }

    // Verify only 1 new entry was created (initial 1 + 1 imported = 2)
    expect(h.server.entries.size).toBe(2);

    // Verify NO request URL, header, or body ever carried the JSON plaintext or key names
    for (const req of h.server.requests) {
      expect(req.url).not.toContain(secretMarker);
      expect(req.rawBody).not.toContain(secretMarker);
      expect(req.rawBody).not.toContain('"nested"');
    }
  });

  it('passes assertNoPlaintextAttrs and assertVaultSecretElementAttributes when unlocked, after a failed save, and after vault lock', async () => {
    const h = await setupImportHarness();
    await waitFor(() => {
      expect(screen.getByTestId('btn-import-json')).toBeEnabled();
    });

    fireEvent.click(screen.getByTestId('btn-import-json'));
    const dialog = screen.getByTestId('import-json-dialog');
    const textarea = within(dialog).getByTestId('import-json-source-textarea');

    const secretKey = 'attr_leak_key_alpha';
    const secretVal = 'attr_leak_val_omega';
    const payload = `{"${secretKey}":"${secretVal}"}`;
    fireEvent.change(textarea, { target: { value: payload } });

    // 1. Unlocked with table preview & raw preview
    assertVaultSecretElementAttributes(dialog);
    assertNoPlaintextAttrs(h.container, [secretKey, secretVal]);

    fireEvent.click(within(dialog).getByTestId('import-json-preview-tab-raw'));
    assertVaultSecretElementAttributes(dialog);
    assertNoPlaintextAttrs(h.container, [secretKey, secretVal]);

    // 2. After failed save
    h.server.overrideRoute((url, init) => {
      if (url.endsWith(`/items/${ITEM_ID}/entries/import-json`) && init?.method === 'POST') {
        return problemResponse('dependency_unavailable', 503, { retry_after: 60 });
      }
      return null;
    });

    fireEvent.click(within(dialog).getByTestId('import-json-submit-btn'));
    await waitFor(() => {
      expect(within(dialog).getByTestId('import-json-retry-banner')).toBeInTheDocument();
    });
    assertNoPlaintextAttrs(h.container, [secretKey, secretVal]);

    // 3. After vault lock -> dialog closes and draft is wiped; unlock shows draft-cleared-on-lock banner
    await h.lock();
    expect(screen.queryByTestId('import-json-dialog')).toBeNull();
    assertNoPlaintextAttrs(h.container, [secretKey, secretVal]);

    await h.unlock();
    await waitFor(() => {
      expect(screen.getByTestId('draft-cleared-on-lock-banner')).toBeInTheDocument();
    });
  });

  it('advisor-dec-209: omnibox JSON banner handoff never touches location, history.state, or Web Storage, and wipes on lock between click and open, logout, user switch, and dialog close', async () => {
    const h = await setupImportHarness();
    await waitFor(() => {
      expect(screen.getByTestId('btn-import-json')).toBeEnabled();
    });

    const handoffSecret = 'DEC_209_HANDOFF_SECRET_884422';
    const omniTextarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });
    fireEvent.change(omniTextarea, {
      target: { value: `wifi #nhà: {"secret":"${handoffSecret}"}` },
    });

    const bannerAction = screen.getByTestId('omnibox-json-banner-action');
    expect(bannerAction).not.toHaveAttribute('hidden');
    fireEvent.click(bannerAction);

    const dialog = await screen.findByTestId('import-json-dialog');
    expect(within(dialog).getByTestId('import-json-source-textarea')).toHaveValue(
      `{"secret":"${handoffSecret}"}`,
    );

    // 1. Verify handoff plaintext never appears in window.location, history.state, localStorage, or sessionStorage
    expect(window.location.href).not.toContain(handoffSecret);
    expect(JSON.stringify(window.history.state ?? null)).not.toContain(handoffSecret);
    expect(JSON.stringify(window.localStorage)).not.toContain(handoffSecret);
    expect(JSON.stringify(window.sessionStorage)).not.toContain(handoffSecret);

    // 2. Dialog close wipes the handoff record and holder in place
    const snapshotBeforeClose = getJsonImportHandoffSnapshot();
    expect(snapshotBeforeClose).not.toBeNull();
    const holderRef = snapshotBeforeClose!.bodyHolder;
    expect(holderRef.text).toContain(handoffSecret);

    fireEvent.click(within(dialog).getByTestId('import-json-close-btn'));
    expect(screen.queryByTestId('import-json-dialog')).toBeNull();
    expect(getJsonImportHandoffSnapshot()).toBeNull();
    expect(holderRef.text).toBe('');

    // 3. Lock between handoff creation and dialog open drops the handoff immediately
    openJsonImportFromHandoff({
      name: 'wifi',
      tags: ['nhà'],
      body: `{"between_lock":"${handoffSecret}"}`,
      userId: USER_A_ID,
    });
    const directHolderRef = getJsonImportHandoffSnapshot()!.bodyHolder;
    wipeJsonImportHandoff({ bumpLockEpoch: true });
    expect(getJsonImportHandoffSnapshot()).toBeNull();
    expect(directHolderRef.text).toBe('');

    // 4. User switch (User A -> User B) wipes the open handoff
    act(() => {
      openJsonImportFromHandoff({
        name: 'wifi',
        tags: [],
        body: `{"user_switch":"${handoffSecret}"}`,
        userId: USER_A_ID,
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('import-json-dialog')).toBeInTheDocument();
    });
    const switchHolder = getJsonImportHandoffSnapshot()!.bodyHolder;

    await act(async () => {
      h.qc.setQueryData(['auth', 'me'], makeMe(USER_B_ID, 'present'));
    });

    await waitFor(() => {
      expect(getJsonImportHandoffSnapshot()).toBeNull();
    });
    expect(switchHolder.text).toBe('');

    // 5. Session signed_out broadcast wipes the handoff
    act(() => {
      openJsonImportFromHandoff({
        name: 'wifi',
        tags: [],
        body: `{"logout_wipe":"${handoffSecret}"}`,
        userId: USER_B_ID,
      });
    });
    const logoutHolder = getJsonImportHandoffSnapshot()!.bodyHolder;
    act(() => {
      postSessionBroadcast({ type: 'signed_out', reason: 'logout' });
    });
    expect(getJsonImportHandoffSnapshot()).toBeNull();
    expect(logoutHolder.text).toBe('');
  });

  it('wipes the plaintext holder synchronously and performs zero seal or POST calls when locked or unmounted during a held reloadVaultMeta or POST', async () => {
    const h = await setupImportHarness();
    await waitFor(() => {
      expect(screen.getByTestId('btn-import-json')).toBeEnabled();
    });

    const holder: { current: JsonImportPlaintextHolder } = {
      current: { draftText: '', submittedText: '' },
    };
    importDialogTesting.setJsonImportPlaintextHolderForTests(holder);

    fireEvent.click(screen.getByTestId('btn-import-json'));
    const dialog = screen.getByTestId('import-json-dialog');
    const textarea = within(dialog).getByTestId('import-json-source-textarea');

    const heldDraft = '{"held_save":"wipe_on_lock_during_post"}';
    fireEvent.change(textarea, { target: { value: heldDraft } });
    expect(holder.current.draftText).toBe(heldDraft);

    const { promise: postGate, resolve: releasePost } = createDeferred();
    const { promise: postEntered, resolve: notifyPostEntered } = createDeferred();

    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith(`/items/${ITEM_ID}/entries/import-json`) && init?.method === 'POST') {
        notifyPostEntered();
        await postGate;
      }
      return null;
    });

    fireEvent.click(within(dialog).getByTestId('import-json-submit-btn'));
    await postEntered;

    const reqCountAtLock = h.server.requests.filter((r) =>
      r.url.endsWith(`/items/${ITEM_ID}/entries/import-json`),
    ).length;

    // 1. Lock while POST is held in flight -> holder is wiped synchronously
    await h.lock();
    expect(holder.current).toEqual({
      draftText: '',
      submittedText: '',
    });

    releasePost();
    await act(async () => {
      await flushMacrotask();
    });

    // Zero additional POST calls after lock
    const reqCountAfterRelease = h.server.requests.filter((r) =>
      r.url.endsWith(`/items/${ITEM_ID}/entries/import-json`),
    ).length;
    expect(reqCountAfterRelease).toBe(reqCountAtLock);

    // 2. Lock during held route-level GET /vault (reloadVaultMeta when vaultMeta is genuinely null):
    //    Mount a fresh harness with skipInitialReloadVaultMeta: true so vaultMeta is null when Submit is clicked;
    //    holder.submittedText stays empty before and after release, and zero sealEntry or POST calls occur
    cleanup();
    const hPreSeal = await setupImportHarness({
      initialEntries: [],
      skipInitialReloadVaultMeta: true,
    });
    expect(hPreSeal.vault().vaultMeta).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('btn-import-json')).toBeEnabled();
    });

    let holdVaultGet = false;
    const { promise: vaultGate, resolve: releaseVaultGet } = createDeferred();
    const { promise: vaultEntered, resolve: notifyVaultEntered } = createDeferred();

    hPreSeal.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.endsWith('/vault') && holdVaultGet) {
        notifyVaultEntered();
        await vaultGate;
      }
      return null;
    });

    const clientSealSpy = vi.spyOn(hPreSeal.vault().getClient(), 'sealEntry');

    fireEvent.click(screen.getByTestId('btn-import-json'));
    const dialog2 = screen.getByTestId('import-json-dialog');
    const textarea2 = within(dialog2).getByTestId('import-json-source-textarea');
    fireEvent.change(textarea2, { target: { value: '{"pre_seal":"lock_before_seal"}' } });
    expect(holder.current.draftText).toBe('{"pre_seal":"lock_before_seal"}');
    expect(holder.current.submittedText).toBe('');

    holdVaultGet = true;
    clientSealSpy.mockClear();
    const postCountBeforePreSeal = hPreSeal.server.requests.filter((r) =>
      r.url.endsWith(`/items/${ITEM_ID}/entries/import-json`),
    ).length;

    fireEvent.click(within(dialog2).getByTestId('import-json-submit-btn'));
    await vaultEntered;

    // While reloadVaultMeta (GET /vault) is held in flight, submittedText was NOT populated yet
    expect(holder.current.submittedText).toBe('');

    await hPreSeal.lock();
    expect(holder.current).toEqual({
      draftText: '',
      submittedText: '',
    });

    holdVaultGet = false;
    hPreSeal.server.overrideRoute(null);
    releaseVaultGet();
    await act(async () => {
      await flushMacrotask();
    });

    expect(clientSealSpy).not.toHaveBeenCalled();
    const postCountAfterPreSeal = hPreSeal.server.requests.filter((r) =>
      r.url.endsWith(`/items/${ITEM_ID}/entries/import-json`),
    ).length;
    expect(postCountAfterPreSeal).toBe(postCountBeforePreSeal);
    clientSealSpy.mockRestore();

    // 3. Unmount during held reloadVaultMeta -> holder wiped synchronously on unmount, zero sealEntry or POST after release
    cleanup();
    const hUnmount = await setupImportHarness({
      initialEntries: [],
      skipInitialReloadVaultMeta: true,
    });
    expect(hUnmount.vault().vaultMeta).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('btn-import-json')).toBeEnabled();
    });

    const unmountSealSpy = vi.spyOn(hUnmount.vault().getClient(), 'sealEntry');
    const { promise: unmountVaultGate, resolve: releaseUnmountVaultGet } = createDeferred();
    const { promise: unmountVaultEntered, resolve: notifyUnmountVaultEntered } = createDeferred();
    holdVaultGet = true;
    hUnmount.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.endsWith('/vault') && holdVaultGet) {
        notifyUnmountVaultEntered();
        await unmountVaultGate;
      }
      return null;
    });

    fireEvent.click(screen.getByTestId('btn-import-json'));
    const dialog3 = screen.getByTestId('import-json-dialog');
    const textarea3 = within(dialog3).getByTestId('import-json-source-textarea');
    fireEvent.change(textarea3, { target: { value: '{"unmount_race":"wipe_on_unmount"}' } });
    expect(holder.current.draftText).toBe('{"unmount_race":"wipe_on_unmount"}');

    unmountSealSpy.mockClear();
    const postCountBeforeUnmount = hUnmount.server.requests.filter((r) =>
      r.url.endsWith(`/items/${ITEM_ID}/entries/import-json`),
    ).length;

    fireEvent.click(within(dialog3).getByTestId('import-json-submit-btn'));
    await unmountVaultEntered;

    // Unmount page while reloadVaultMeta is held in flight
    hUnmount.rerenderPage(<div data-testid="page-unmounted" />);
    expect(screen.getByTestId('page-unmounted')).toBeInTheDocument();
    expect(holder.current).toEqual({
      draftText: '',
      submittedText: '',
    });

    holdVaultGet = false;
    hUnmount.server.overrideRoute(null);
    releaseUnmountVaultGet();
    await act(async () => {
      await flushMacrotask();
    });

    expect(unmountSealSpy).not.toHaveBeenCalled();
    const postCountAfterUnmount = hUnmount.server.requests.filter((r) =>
      r.url.endsWith(`/items/${ITEM_ID}/entries/import-json`),
    ).length;
    expect(postCountAfterUnmount).toBe(postCountBeforeUnmount);
    unmountSealSpy.mockRestore();
  });

  it('formats JSON before saving when "Định dạng trước khi lưu" is checked and refuses when depth exceeds JSON_FORMAT_MAX_DEPTH (1000 levels)', async () => {
    const h = await setupImportHarness();
    await waitFor(() => {
      expect(screen.getByTestId('btn-import-json')).toBeEnabled();
    });

    fireEvent.click(screen.getByTestId('btn-import-json'));
    const dialog = screen.getByTestId('import-json-dialog');
    const textarea = within(dialog).getByTestId('import-json-source-textarea');

    // 1. Depth = JSON_FORMAT_MAX_DEPTH + 1 (1001) -> format checkbox refuses with depth warning and keeps original text
    const exceedDepth = JSON_FORMAT_MAX_DEPTH + 1;
    const deepJson = `${'{"a":'.repeat(exceedDepth)}1${'}'.repeat(exceedDepth)}`;
    fireEvent.change(textarea, { target: { value: deepJson } });
    const formatCheckbox = within(dialog).getByTestId('import-json-format-checkbox') as HTMLInputElement;
    fireEvent.click(formatCheckbox);
    expect(formatCheckbox.checked).toBe(false);
    expect(within(dialog).getByTestId('import-json-format-warning')).toHaveTextContent(
      String(JSON_FORMAT_MAX_DEPTH),
    );
    // 2. Minified valid JSON with depth 2 -> checking Format before saving formats the saved bytes
    const minified = '{"alpha":1,"beta":[true,false]}';
    fireEvent.change(textarea, { target: { value: minified } });
    fireEvent.click(formatCheckbox);
    expect(formatCheckbox.checked).toBe(true);
    expect(within(dialog).getByTestId('import-json-formatted-byte-badge')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByTestId('import-json-submit-btn'));
    await waitFor(() => {
      expect(screen.queryByTestId('import-json-dialog')).toBeNull();
    });

    const importReqs = h.server.requests.filter((r) =>
      r.url.endsWith(`/items/${ITEM_ID}/entries/import-json`),
    );
    expect(importReqs).toHaveLength(1);
    const reqBody = JSON.parse(importReqs[0]!.rawBody) as { id: string };
    const savedPlaintext = await h.server.openServerEntryPlaintext(reqBody.id);
    expect(savedPlaintext).toBe('{\n  "alpha": 1,\n  "beta": [\n    true,\n    false\n  ]\n}');
  });
});
