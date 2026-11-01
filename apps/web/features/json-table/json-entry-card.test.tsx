import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import {
  JsonEntryCard,
  NewJsonEntryComposer,
  setJsonComposerPlaintextHolderForTests,
  setJsonEditorPlaintextHolderForTests,
  type JsonComposerPlaintextHolder,
} from '@/features/json-table';
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
import {
  JSON_FORMAT_MAX_DEPTH,
  areNonWhitespaceTokensIdentical,
  changeCellType,
  decodeUtf8FileStrict,
  insertField,
  insertRow,
  lineColumnToOffset,
  parseJsonStrict,
} from '@/lib/json';
import en from '@/messages/en.json';
import viMessages from '@/messages/vi.json';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CORPUS_DIR = path.resolve(
  __dirname,
  '../../../../packages/content-fixtures/json-corpus',
);

interface CorpusFixtureEntry {
  id: string;
  file: string;
  kind: 'valid' | 'valid-bom' | 'invalid-json-second-bom' | 'invalid-utf8';
  eol: 'lf' | 'crlf' | 'mixed' | 'cr';
  expectedBomStripped: boolean;
  expectedValidJson: boolean;
  byteLength: number;
  description: string;
}

interface CorpusManifest {
  version: number;
  fixtures: CorpusFixtureEntry[];
}

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

const utf8Encoder = new TextEncoder();

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
  let originalClipboardDesc: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalClipboardDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    document.cookie = 'sabk_csrf=test-csrf-token';
    routerMocks.push.mockReset();
    routerMocks.replace.mockReset();
    routerMocks.redirect.mockClear();
    resetVaultBroadcastForTests();
    resetEntryBodyLoadLimiterForTests();
    clearAllUnconfirmedSaves();
    setJsonEditorPlaintextHolderForTests(null);
    setJsonComposerPlaintextHolderForTests(null);
  });

  afterEach(() => {
    cleanup();
    setJsonEditorPlaintextHolderForTests(null);
    setJsonComposerPlaintextHolderForTests(null);
    if (originalClipboardDesc) {
      Object.defineProperty(navigator, 'clipboard', originalClipboardDesc);
    }
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
      const bytes = utf8Encoder.encode(plaintext).byteLength;
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
    const nestedRows = within(within(card1).getByTestId('json-nest-root.p6')).getAllByRole('row');
    expect(nestedRows.some((r) => r.getAttribute('aria-level') === '2')).toBe(true);

    // Expand array-of-objects ("users" at root.p3) -> 20 columns + "+2 cột khác" overflow column + duplicate-key row fallback on row 2
    fireEvent.click(within(card1).getByTestId('json-toggle-root.p3'));
    expect(within(card1).getByTestId('json-extra-col-header-root.p3')).toHaveTextContent('+2');
    expect(within(card1).getByText(viMessages.content.json.duplicateRowBadge)).toBeInTheDocument();

    // Expand "+2 trường" overflow cell on row 1 -> reveals k21 and k22 (routed through i18n extraFieldsToggle)
    const extraToggle = within(card1).getByTestId('json-extra-toggle-root.p3.e0.extra');
    expect(extraToggle).toHaveTextContent('+2 trường');
    expect(card1.textContent).not.toContain('k21');
    fireEvent.click(extraToggle);
    expect(card1.textContent).toContain('k21');
    expect(card1.textContent).toContain('k22');

    // Expand primitive array ("tags" at root.p4) and array-of-arrays ("matrix" at root.p5)
    fireEvent.click(within(card1).getByTestId('json-toggle-root.p4'));
    expect(card1.textContent).toContain('primary');
    fireEvent.click(within(card1).getByTestId('json-toggle-root.p5'));
    expect(within(card1).getByTestId('json-toggle-root.p5.e0')).toHaveTextContent('Mảng (2)');

    // Root primitive table on card 2
    expect(within(card2).getByTestId('json-cell-btn-root')).toHaveTextContent(
      'ROOT_PRIMITIVE_STRING_VALUE',
    );
  });

  it('renders 10000-level deep nested JSON input without stack overflow and builds only one level lazily until expanded, and paginates 600 rows into 12 pages (50 rows/page)', async () => {
    const deep10000Path = path.join(CORPUS_DIR, 'deep-10000-array.json');
    const deep10000Text = fs.readFileSync(deep10000Path, 'utf8');
    const items600 = Array.from({ length: 600 }, (_, i) => `"row_val_${i + 1}"`).join(', ');
    const json600 = `[${items600}]`;

    const h = await setupJsonCardHarness({
      initialEntries: [
        { id: ENTRY_ID_1, text: deep10000Text, type: 'json', position: 0 },
        { id: ENTRY_ID_2, text: json600, type: 'json', position: 1 },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_2}`)).toBeInTheDocument();
    });

    // 1. 10000-level deep input renders and builds ONLY level 1 (one toggle button, no nested tables)
    const cardDeep = screen.getByTestId(`entry-card-${ENTRY_ID_1}`);
    const togglesBefore = cardDeep.querySelectorAll('[data-testid^="json-toggle-"]');
    expect(togglesBefore).toHaveLength(1);
    expect(within(cardDeep).getByTestId('json-toggle-root.e0')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(cardDeep.querySelectorAll('[data-testid^="json-nest-"]')).toHaveLength(0);

    // Expanding level 1 builds ONLY level 2 (now 2 toggles total, 1 nested container)
    fireEvent.click(within(cardDeep).getByTestId('json-toggle-root.e0'));
    expect(within(cardDeep).getByTestId('json-toggle-root.e0')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(cardDeep.querySelectorAll('[data-testid^="json-toggle-"]')).toHaveLength(2);
    expect(cardDeep.querySelectorAll('[data-testid^="json-nest-"]')).toHaveLength(1);

    // 2. 600 rows -> 12 pages (50 rows/page); mounts only 50 rows at once
    const card600 = screen.getByTestId(`entry-card-${ENTRY_ID_2}`);
    expect(within(card600).getByTestId('json-page-indicator-root')).toHaveTextContent(
      'Trang 1/12',
    );
    expect(card600.querySelectorAll('[data-testid^="json-cell-btn-root.e"]')).toHaveLength(50);
    expect(card600.textContent).toContain('row_val_1');
    expect(card600.textContent).toContain('row_val_50');
    expect(card600.textContent).not.toContain('row_val_51');

    // Click Next page -> Trang 2/12, shows rows 51..100
    fireEvent.click(within(card600).getByTestId('json-page-next-root'));
    expect(within(card600).getByTestId('json-page-indicator-root')).toHaveTextContent(
      'Trang 2/12',
    );
    expect(card600.textContent).toContain('row_val_51');
    expect(card600.textContent).toContain('row_val_100');
    expect(card600.textContent).not.toContain('row_val_1');
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
  });

  it('edits one cell in EVERY Task 12 valid corpus fixture through the JsonEntryCard UI, saves, decrypts the saved payload, and verifies bytes outside the edited span are identical (A6)', async () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(CORPUS_DIR, 'manifest.json'), 'utf8'),
    ) as CorpusManifest;
    const validFixtures = manifest.fixtures.filter(
      (f) => f.kind === 'valid' || f.kind === 'valid-bom',
    );
    expect(validFixtures.length).toBeGreaterThanOrEqual(22);

    const h = await setupJsonCardHarness({
      initialEntries: [{ id: ENTRY_ID_1, text: '{"init":1}', type: 'json', position: 0 }],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    // Map each valid fixture to a concrete UI cell edit (or structural insert for empty containers / deep-10000)
    const uiTargetByFixture: Readonly<
      Record<
        string,
        | { kind: 'cell'; expand?: readonly string[]; cellKey: string; newVal: string }
        | { kind: 'type'; cellKey: string; newType: 'string'; expectedVal: string }
        | { kind: 'add-field'; key: string }
        | { kind: 'add-row' }
        | { kind: 'raw-deep' }
      >
    > = {
      'duplicate-keys': { kind: 'cell', cellKey: 'root.p2', newVal: '202' },
      'integer-keys-order': { kind: 'cell', cellKey: 'root.p0', newVal: 'ten_edited' },
      'exact-numbers': { kind: 'cell', cellKey: 'root.p0', newVal: '42' },
      'escapes-and-unicode': { kind: 'cell', cellKey: 'root.p0', newVal: 'cafe_edited' },
      'whitespace-crlf-tab': { kind: 'cell', cellKey: 'root.p0', newVal: '10.0.0.2' },
      'root-crlf': { kind: 'cell', cellKey: 'root.p0', newVal: 'vault_edited' },
      'mixed-eol': { kind: 'cell', cellKey: 'root.p0', newVal: 'crlf_edited' },
      'lone-cr-eol': { kind: 'cell', cellKey: 'root.p1', newVal: '99' },
      'root-number': { kind: 'cell', cellKey: 'root', newVal: '9007199254740993' },
      'root-string': { kind: 'cell', cellKey: 'root', newVal: 'updated_root' },
      'root-null': { kind: 'type', cellKey: 'root', newType: 'string', expectedVal: '""' },
      'root-true': { kind: 'cell', cellKey: 'root', newVal: 'false' },
      'empty-array': { kind: 'add-row' },
      'empty-object': { kind: 'add-field', key: 'addedKey' },
      'mixed-array': { kind: 'cell', cellKey: 'root.e0', newVal: 'alpha_edited' },
      'array-of-arrays': {
        kind: 'cell',
        expand: ['root.e0'],
        cellKey: 'root.e0.e0',
        newVal: '111',
      },
      'array-of-objects-dup-row': {
        kind: 'cell',
        cellKey: 'root.e1.p2',
        newVal: '999',
      },
      'array-of-objects-25-cols': {
        kind: 'cell',
        expand: ['root.e0.extra'],
        cellKey: 'root.e0.extra.p0',
        newVal: '2100',
      },
      'lone-surrogate-string': {
        kind: 'cell',
        cellKey: 'root.p2',
        newVal: 'safe_edited',
      },
      'string-control-escapes': {
        kind: 'cell',
        cellKey: 'root.p3',
        newVal: 'hello_edited',
      },
      'proto-keys': {
        kind: 'cell',
        cellKey: 'root.p0',
        newVal: 'proto_edited',
      },
      'deep-10000-array': {
        kind: 'raw-deep',
      },
      'single-bom-crlf': {
        kind: 'cell',
        cellKey: 'root.p1',
        newVal: '42',
      },
    };

    let versionCounter = 1;
    for (const fixture of validFixtures) {
      const rawBytes = new Uint8Array(
        fs.readFileSync(path.join(CORPUS_DIR, fixture.file)),
      );
      const decoded = decodeUtf8FileStrict(rawBytes);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) continue;

      const sourceText = decoded.text;
      const originalBytes = utf8Encoder.encode(sourceText);
      const parsedBefore = parseJsonStrict(sourceText);
      expect(parsedBefore.ok).toBe(true);
      if (!parsedBefore.ok) continue;

      versionCounter += 1;
      await h.server.sealJsonForEntry(ENTRY_ID_1, sourceText, versionCounter, 0);

      const entryMeta: EntryMeta = {
        id: ENTRY_ID_1,
        item_id: ITEM_ID,
        type: 'json',
        position: 0,
        version: versionCounter,
        plaintext_len_bucket: Math.max(
          256,
          Math.ceil(originalBytes.byteLength / 256) * 256,
        ),
        created_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-01T00:00:00Z',
      };

      h.rerenderPage(
        <JsonEntryCard
          key={`${fixture.id}-${versionCounter}`}
          entry={entryMeta}
          itemId={ITEM_ID}
          index={0}
          total={1}
          canReorder={false}
          lazy={false}
          rawParseDebounceMs={0}
          onMoveUp={() => {}}
          onMoveDown={() => {}}
          onDelete={() => {}}
        />,
      );

      const card = await screen.findByTestId(`entry-card-${ENTRY_ID_1}`);
      await waitFor(() => {
        expect(within(card).getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
      });

      const action = uiTargetByFixture[fixture.id];
      expect(action, `Missing UI target spec for fixture ${fixture.id}`).toBeDefined();
      if (!action) continue;

      const putsBefore = h.server.requests.filter((r) => r.method === 'PUT').length;

      let expectedSplice: { offset: number; length: number; content: string } | null = null;

      if (action.kind === 'cell') {
        for (const expandPath of action.expand ?? []) {
          const toggleId = expandPath.endsWith('.extra')
            ? `json-extra-toggle-${expandPath}`
            : `json-toggle-${expandPath}`;
          fireEvent.click(within(card).getByTestId(toggleId));
        }
        const cellBtn = within(card).getByTestId(`json-cell-btn-${action.cellKey}`);
        fireEvent.click(cellBtn);
        const cellInput = within(card).getByTestId(`json-cell-input-${action.cellKey}`);
        fireEvent.change(cellInput, { target: { value: action.newVal } });
        fireEvent.keyDown(cellInput, { key: 'Enter' });

        fireEvent.click(within(card).getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
      } else if (action.kind === 'type') {
        fireEvent.click(within(card).getByTestId(`json-cell-btn-${action.cellKey}`));
        fireEvent.change(within(card).getByTestId(`json-type-select-${action.cellKey}`), {
          target: { value: action.newType },
        });
        const expectedLib = changeCellType(
          parsedBefore.document,
          {
            revision: parsedBefore.document.revision,
            nodeId: parsedBefore.document.root.id,
            span: parsedBefore.document.root.span,
            parentId: null,
          },
          action.newType,
        );
        if (expectedLib.ok && expectedLib.edit) {
          expectedSplice = expectedLib.edit;
        }
        fireEvent.click(within(card).getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
      } else if (action.kind === 'add-field') {
        fireEvent.click(within(card).getByTestId('json-open-add-field-root'));
        fireEvent.change(within(card).getByTestId('json-new-key-input-root'), {
          target: { value: action.key },
        });
        fireEvent.click(within(card).getByTestId('json-confirm-add-field-root'));
        const expectedLib = insertField(
          parsedBefore.document,
          {
            revision: parsedBefore.document.revision,
            nodeId: parsedBefore.document.root.id,
            span: parsedBefore.document.root.span,
            parentId: null,
          },
          action.key,
          { initialValueLexeme: 'null' },
        );
        if (expectedLib.ok && expectedLib.edit) {
          expectedSplice = expectedLib.edit;
        }
        fireEvent.click(within(card).getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
      } else if (action.kind === 'add-row') {
        fireEvent.click(within(card).getByTestId('json-add-row-root'));
        const expectedLib = insertRow(parsedBefore.document, {
          revision: parsedBefore.document.revision,
          nodeId: parsedBefore.document.root.id,
          span: parsedBefore.document.root.span,
          parentId: null,
        });
        if (expectedLib.ok && expectedLib.edit) {
          expectedSplice = expectedLib.edit;
        }
        fireEvent.click(within(card).getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
      } else if (action.kind === 'raw-deep') {
        // Edit the innermost 0 -> 1 in Raw JSON for deep-10000-array
        fireEvent.click(within(card).getByTestId(`json-tab-raw-${ENTRY_ID_1}`));
        const rawTa = within(card).getByTestId(
          `json-raw-textarea-${ENTRY_ID_1}`,
        ) as HTMLTextAreaElement;
        const zeroIdx = sourceText.indexOf('0');
        const nextText =
          sourceText.slice(0, zeroIdx) + '1' + sourceText.slice(zeroIdx + 1);
        expectedSplice = { offset: zeroIdx, length: 1, content: '1' };
        fireEvent.change(rawTa, { target: { value: nextText } });
        fireEvent.click(within(card).getByTestId(`json-raw-save-btn-${ENTRY_ID_1}`));
      }

      await waitFor(() => {
        expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(
          putsBefore + 1,
        );
      });
      versionCounter += 1;

      const savedPlaintext = await h.server.openServerEntryPlaintext(ENTRY_ID_1);
      const savedBytes = utf8Encoder.encode(savedPlaintext);

      // Verify exact byte preservation outside the edited span (A6)
      if (expectedSplice) {
        const prefixBytes = utf8Encoder.encode(
          sourceText.slice(0, expectedSplice.offset),
        );
        const suffixBytes = utf8Encoder.encode(
          sourceText.slice(expectedSplice.offset + expectedSplice.length),
        );
        const spliceBytes = utf8Encoder.encode(expectedSplice.content);
        expect(savedBytes.byteLength).toBe(
          prefixBytes.byteLength + spliceBytes.byteLength + suffixBytes.byteLength,
        );
        expect(
          Buffer.compare(
            savedBytes.subarray(0, prefixBytes.byteLength),
            originalBytes.subarray(0, prefixBytes.byteLength),
          ),
        ).toBe(0);
        expect(
          Buffer.compare(
            savedBytes.subarray(savedBytes.byteLength - suffixBytes.byteLength),
            originalBytes.subarray(originalBytes.byteLength - suffixBytes.byteLength),
          ),
        ).toBe(0);
      } else {
        // Compute longest common prefix and suffix in bytes and verify the splice is strictly bounded to the single edited primitive token
        let p = 0;
        while (
          p < originalBytes.byteLength &&
          p < savedBytes.byteLength &&
          originalBytes[p] === savedBytes[p]
        ) {
          p += 1;
        }
        let s = 0;
        while (
          s < originalBytes.byteLength - p &&
          s < savedBytes.byteLength - p &&
          originalBytes[originalBytes.byteLength - 1 - s] ===
            savedBytes[savedBytes.byteLength - 1 - s]
        ) {
          s += 1;
        }
        expect(p + s).toBeGreaterThan(0);
        const replacedOriginalLen = originalBytes.byteLength - p - s;
        expect(replacedOriginalLen).toBeLessThanOrEqual(32);
      }
    }
  });

  it('edits cell inline, preserves surrounding bytes + CRLF + duplicate keys + 9007199254740993 on Save, keeps neighbor string with \\n byte-identical, keeps \\n escape when editing a multiline cell, and sends NO PUT on no-op commit (preserving \\u00e9 and \\/)', async () => {
    const originalJson =
      '{\r\n  "cafe": "caf\\u00e9 \\/ bar",\r\n  "multilineNeighbor": "first\\nsecond",\r\n  "target": "old_val",\r\n  "dup": 1,\r\n  "dup": 2,\r\n  "big": 9007199254740993\r\n}';

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
    expect(within(card).queryByTestId(`entry-save-btn-${ENTRY_ID_1}`)).toBeNull();

    // 2. Edit neighbouring cell "target" (root.p2) next to "multilineNeighbor" (which contains \n) -> "multilineNeighbor" stays byte-identical
    fireEvent.click(within(card).getByTestId('json-cell-btn-root.p2'));
    const input2 = within(card).getByTestId('json-cell-input-root.p2') as HTMLInputElement;
    fireEvent.change(input2, { target: { value: 'new_val' } });
    fireEvent.keyDown(input2, { key: 'Enter' });

    const saveBtn = within(card).getByTestId(`entry-save-btn-${ENTRY_ID_1}`);
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    });

    const savedPlaintext1 = await h.server.openServerEntryPlaintext(ENTRY_ID_1);
    expect(savedPlaintext1).toBe(
      '{\r\n  "cafe": "caf\\u00e9 \\/ bar",\r\n  "multilineNeighbor": "first\\nsecond",\r\n  "target": "new_val",\r\n  "dup": 1,\r\n  "dup": 2,\r\n  "big": 9007199254740993\r\n}',
    );

    // 3. Edit the multiline cell "multilineNeighbor" (root.p1) itself -> keeps \n as the two-byte escape \n in the saved JSON
    fireEvent.click(within(card).getByTestId('json-cell-btn-root.p1'));
    const multilineTa = within(card).getByTestId(
      'json-cell-input-root.p1',
    ) as HTMLTextAreaElement;
    expect(multilineTa.tagName.toUpperCase()).toBe('TEXTAREA');
    fireEvent.change(multilineTa, { target: { value: 'first\nsecond\nthird' } });
    fireEvent.keyDown(multilineTa, { key: 'Enter' });

    fireEvent.click(within(card).getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(2);
    });

    const savedPlaintext2 = await h.server.openServerEntryPlaintext(ENTRY_ID_1);
    expect(savedPlaintext2).toBe(
      '{\r\n  "cafe": "caf\\u00e9 \\/ bar",\r\n  "multilineNeighbor": "first\\nsecond\\nthird",\r\n  "target": "new_val",\r\n  "dup": 1,\r\n  "dup": 2,\r\n  "big": 9007199254740993\r\n}',
    );
  });

  it('blocks a Table cell edit that pushes the JSON document over 256 KiB (262,144 UTF-8 bytes) with an inline message and sends no PUT', async () => {
    const h = await setupJsonCardHarness({
      initialEntries: [{ id: ENTRY_ID_1, text: '{\n  "k": "short"\n}', type: 'json', position: 0 }],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const card = screen.getByTestId(`entry-card-${ENTRY_ID_1}`);
    fireEvent.click(within(card).getByTestId('json-cell-btn-root.p0'));
    const cellInput = within(card).getByTestId('json-cell-input-root.p0');
    fireEvent.change(cellInput, { target: { value: 'x'.repeat(262_200) } });
    fireEvent.keyDown(cellInput, { key: 'Enter' });

    expect(within(card).getByTestId('json-cell-error-root.p0')).toHaveTextContent(
      viMessages.content.json.editErrorOverCap,
    );
    expect(within(card).queryByTestId(`entry-save-btn-${ENTRY_ID_1}`)).toBeNull();
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
  });

  it('supports cell type conversion (string "42" -> number 42 -> null), Add field, Remove field, Add row, Remove row, missing cell (—) initialization, and keyboard navigation (Arrows, Enter, Esc)', async () => {
    const initialJson = '{\n  "count": "42",\n  "list": [\n    { "a": "1", "b": "2" },\n    { "a": "3" }\n  ]\n}';
    const h = await setupJsonCardHarness({
      initialEntries: [{ id: ENTRY_ID_1, text: initialJson, type: 'json', position: 0 }],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const card = screen.getByTestId(`entry-card-${ENTRY_ID_1}`);

    // Keyboard navigation between cells: focus key cell root.k0, ArrowRight -> value cell root.p0, ArrowDown -> toggle root.p1, ArrowUp -> value cell root.p0
    const keyBtn0 = within(card).getByTestId('json-cell-btn-root.k0');
    const valBtn0 = within(card).getByTestId('json-cell-btn-root.p0');
    const toggleBtn1 = within(card).getByTestId('json-toggle-root.p1');

    keyBtn0.focus();
    expect(document.activeElement).toBe(keyBtn0);
    fireEvent.keyDown(keyBtn0, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(valBtn0);
    fireEvent.keyDown(valBtn0, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(toggleBtn1);
    fireEvent.keyDown(toggleBtn1, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(valBtn0);

    // Open cell edit, type a change, press Escape -> cancels edit and restores original display
    fireEvent.click(valBtn0);
    const editInput = within(card).getByTestId('json-cell-input-root.p0');
    fireEvent.change(editInput, { target: { value: '999' } });
    fireEvent.keyDown(editInput, { key: 'Escape' });
    expect(within(card).queryByTestId('json-cell-input-root.p0')).toBeNull();
    expect(within(card).getByTestId('json-cell-btn-root.p0')).toHaveTextContent('42');

    // 1. Convert string "42" (root.p0) to number 42 via type select
    fireEvent.click(within(card).getByTestId('json-cell-btn-root.p0'));
    const typeSelect = within(card).getByTestId('json-type-select-root.p0');
    fireEvent.change(typeSelect, { target: { value: 'number' } });
    expect(within(card).getByTestId('json-cell-btn-root.p0').querySelector('.v-num')).toHaveTextContent('42');

    // 2. Add field "enabled" of type true to root object
    fireEvent.click(within(card).getByTestId('json-open-add-field-root'));
    const newKeyInput = within(card).getByTestId('json-new-key-input-root');
    const newTypeSelect = within(card).getByTestId('json-new-type-select-root');
    assertVaultSecretElementAttributes(card);

    fireEvent.change(newKeyInput, { target: { value: 'count' } });
    fireEvent.click(within(card).getByTestId('json-confirm-add-field-root'));
    expect(within(card).getByTestId('json-add-field-error-root')).toHaveTextContent(
      viMessages.content.json.editErrorKeyExists,
    );

    fireEvent.change(newKeyInput, { target: { value: 'enabled' } });
    fireEvent.change(newTypeSelect, { target: { value: 'true' } });
    fireEvent.click(within(card).getByTestId('json-confirm-add-field-root'));
    expect(within(card).getByTestId('json-cell-btn-root.p2')).toHaveTextContent('true');

    // 3. Expand "list" (root.p1) and click missing cell "—" on row 2 col 2 (root.p1.e1.c1)
    fireEvent.click(within(card).getByTestId('json-toggle-root.p1'));
    const missingCellBtn = within(card).getByTestId('json-missing-cell-root.p1.e1.c1');
    fireEvent.click(missingCellBtn);
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
    expect(parseJsonStrict(saved).ok).toBe(true);
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
    fireEvent.click(ro0);
    expect(within(card).queryByTestId('json-cell-input-root.p0')).toBeNull();
  });

  it('validates Raw JSON on typing pause, shows line/col error box, jumps to error offset on "Đi tới lỗi" with both LF+emoji and CRLF+emoji, blocks switching to Table while invalid, and formats with 2-space indent preserving token stream', async () => {
    const initialJson = '{"alpha":1,"big":9007199254740993,"nested":{"k":"v"}}';
    await setupJsonCardHarness({
      initialEntries: [{ id: ENTRY_ID_1, text: initialJson, type: 'json', position: 0 }],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const card = screen.getByTestId(`entry-card-${ENTRY_ID_1}`);

    // Switch to Raw JSON tab -> only the raw editor's own Save button is shown (no duplicate footer Save button)
    fireEvent.click(within(card).getByTestId(`json-tab-raw-${ENTRY_ID_1}`));
    expect(within(card).getByTestId(`json-raw-save-btn-${ENTRY_ID_1}`)).toBeInTheDocument();
    expect(within(card).queryByTestId(`entry-save-btn-${ENTRY_ID_1}`)).toBeNull();

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

    // 2a. Type invalid JSON with LF + astral emoji before the syntax error -> verify line 4, column 1 and "Đi tới lỗi"
    const invalidWithLfAndEmoji = '{\n  "emoji": "🚀🎉",\n  "broken": \n}';
    fireEvent.change(rawTextarea, { target: { value: invalidWithLfAndEmoji } });
    fireEvent.blur(rawTextarea);

    const errBox = await within(card).findByTestId(`json-raw-error-${ENTRY_ID_1}`);
    expect(errBox).toHaveAttribute('role', 'alert');
    expect(errBox).toHaveTextContent('Dòng 4, cột 1');

    expect(within(card).getByTestId(`json-raw-save-btn-${ENTRY_ID_1}`)).toBeDisabled();
    expect(within(card).getByTestId(`json-raw-format-btn-${ENTRY_ID_1}`)).toBeDisabled();

    fireEvent.click(within(card).getByTestId(`json-raw-goto-btn-${ENTRY_ID_1}`));
    expect(document.activeElement).toBe(rawTextarea);
    expect(rawTextarea.selectionStart).toBe(invalidWithLfAndEmoji.lastIndexOf('}'));

    // 2b. Test "Đi tới lỗi" with CRLF (\r\n) + astral emoji on the textarea value
    const invalidWithCrlfAndEmoji = '{\r\n  "emoji": "🚀🎉",\r\n  "broken": @\r\n}';
    const parsedCrlfErr = parseJsonStrict(invalidWithCrlfAndEmoji);
    expect(parsedCrlfErr.ok).toBe(false);
    const expectedAtOffset = invalidWithCrlfAndEmoji.indexOf('@');
    if (!parsedCrlfErr.ok) {
      expect(
        lineColumnToOffset(
          invalidWithCrlfAndEmoji,
          parsedCrlfErr.error.line,
          parsedCrlfErr.error.column,
        ),
      ).toBe(expectedAtOffset);
    }
    fireEvent.change(rawTextarea, { target: { value: invalidWithCrlfAndEmoji } });
    // Even if user clicks "Đi tới lỗi" immediately before blur/timer settles, handleGoToError flushes live validation first
    Object.defineProperty(rawTextarea, 'value', {
      value: invalidWithCrlfAndEmoji,
      writable: true,
      configurable: true,
    });
    fireEvent.blur(rawTextarea);
    const errBoxAfterCrlf = await within(card).findByTestId(`json-raw-error-${ENTRY_ID_1}`);
    expect(errBoxAfterCrlf).toHaveTextContent('Dòng 3, cột 13');
    fireEvent.click(within(card).getByTestId(`json-raw-goto-btn-${ENTRY_ID_1}`));
    expect(rawTextarea.selectionStart).toBe(expectedAtOffset);

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
    fireEvent.blur(rawTextarea);
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

  it('blocks Save and Format when Raw JSON exceeds 256 KiB (262,144 UTF-8 bytes) and refuses Format when nesting depth > JSON_FORMAT_MAX_DEPTH', async () => {
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
    expect(within(card).getByTestId(`json-raw-format-btn-${ENTRY_ID_1}`)).toBeDisabled();

    // 2. Nesting depth = JSON_FORMAT_MAX_DEPTH + 1 -> valid JSON for iterative parser, so Format button is enabled,
    //    but clicking Format refuses with formatRefusedDepth and keeps the original text intact (IP16-FE1-4)
    const exceedDepth = JSON_FORMAT_MAX_DEPTH + 1;
    const tooDeepJson = '['.repeat(exceedDepth) + '1' + ']'.repeat(exceedDepth);
    fireEvent.change(rawTextarea, { target: { value: tooDeepJson } });
    fireEvent.blur(rawTextarea);

    const formatBtn = within(card).getByTestId(`json-raw-format-btn-${ENTRY_ID_1}`);
    expect(formatBtn).not.toBeDisabled();
    fireEvent.click(formatBtn);

    expect(within(card).getByTestId(`json-format-msg-${ENTRY_ID_1}`)).toBeInTheDocument();
    expect(rawTextarea.value).toBe(tooDeepJson);
  });

  it('preserves CRLF without PUT when opening Raw JSON and clicking Save without edits, keeps CRLF outside a 1-char Raw edit, and warns before normalizing mixed EOL on Save', async () => {
    const crlfJson = '{\r\n  "k": "v1",\r\n  "other": "stay"\r\n}';
    const h = await setupJsonCardHarness({
      initialEntries: [{ id: ENTRY_ID_1, text: crlfJson, type: 'json', position: 0 }],
    });

    await waitFor(() => {
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const card = screen.getByTestId(`entry-card-${ENTRY_ID_1}`);
    fireEvent.click(within(card).getByTestId(`json-tab-raw-${ENTRY_ID_1}`));

    // 1. Click Save in Raw JSON without any edits -> switches back to Table view (observable settle) and sends zero PUTs
    fireEvent.click(within(card).getByTestId(`json-raw-save-btn-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(within(card).getByTestId(`json-tab-table-${ENTRY_ID_1}`)).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);

    // 2. Edit 1 character in Raw JSON on CRLF document -> bytes outside the edit keep CRLF (\r\n)
    fireEvent.click(within(card).getByTestId(`json-tab-raw-${ENTRY_ID_1}`));
    const rawTa1 = within(card).getByTestId(
      `json-raw-textarea-${ENTRY_ID_1}`,
    ) as HTMLTextAreaElement;
    fireEvent.change(rawTa1, {
      target: { value: '{\n  "k": "v2",\n  "other": "stay"\n}' },
    });
    fireEvent.blur(rawTa1);
    fireEvent.click(within(card).getByTestId(`json-raw-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    });
    const savedCrlf = await h.server.openServerEntryPlaintext(ENTRY_ID_1);
    expect(savedCrlf).toBe('{\r\n  "k": "v2",\r\n  "other": "stay"\r\n}');

    // 3. Mixed EOL document (\r\n and \n): editing in Raw JSON and clicking Save shows mixedEolWarning confirmation before sealing
    const mixedEolJson = '{\r\n  "a": 1,\n  "b": 2\r\n}';
    await h.server.sealJsonForEntry(ENTRY_ID_1, mixedEolJson, 3, 0);
    await h.lock();
    await h.unlock();

    await waitFor(() => {
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const cardAfter = screen.getByTestId(`entry-card-${ENTRY_ID_1}`);
    fireEvent.click(within(cardAfter).getByTestId(`json-tab-raw-${ENTRY_ID_1}`));
    expect(within(cardAfter).getByTestId(`json-eol-warning-${ENTRY_ID_1}`)).toBeInTheDocument();

    const rawTa2 = within(cardAfter).getByTestId(`json-raw-textarea-${ENTRY_ID_1}`);
    fireEvent.change(rawTa2, { target: { value: '{\n  "a": 10,\n  "b": 2\n}' } });
    fireEvent.blur(rawTa2);

    const putsBeforeMixed = h.server.requests.filter((r) => r.method === 'PUT').length;
    fireEvent.click(within(cardAfter).getByTestId(`json-raw-save-btn-${ENTRY_ID_1}`));
    expect(
      within(cardAfter).getByTestId(`entry-mixed-eol-warning-${ENTRY_ID_1}`),
    ).toBeInTheDocument();
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(putsBeforeMixed);

    // Confirming mixed EOL normalization seals and sends PUT with majority CRLF
    fireEvent.click(within(cardAfter).getByTestId(`entry-confirm-mixed-eol-save-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(
        putsBeforeMixed + 1,
      );
    });
    const savedMixed = await h.server.openServerEntryPlaintext(ENTRY_ID_1);
    expect(savedMixed).toBe('{\r\n  "a": 10,\r\n  "b": 2\r\n}');
  });

  it('"+ JSON / bảng" composer creates a new JSON entry with Empty object {} or Empty array [] preset, and lazy-loads GET /vault when vaultMeta is initially null (advisor-dec-200)', async () => {
    const h = await setupJsonCardHarness({
      initialEntries: [],
      skipInitialReloadVaultMeta: true,
    });

    await waitFor(() => {
      expect(screen.getByTestId('btn-add-json')).toBeInTheDocument();
    });
    expect(h.vault().vaultMeta).toBeNull();

    const vaultGetsBefore = h.server.requests.filter(
      (r) => r.method === 'GET' && r.url.endsWith('/vault'),
    ).length;

    fireEvent.click(screen.getByTestId('btn-add-json'));
    const composer = screen.getByTestId('new-json-entry-composer');
    expect(composer).toBeInTheDocument();

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

    fireEvent.click(within(composer).getByTestId('new-json-save-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('new-json-entry-composer')).toBeNull();
      expect(
        h.server.requests.some(
          (r) => r.method === 'POST' && r.url.endsWith(`/items/${ITEM_ID}/entries`),
        ),
      ).toBe(true);
    });

    // Assert observable GET /vault request and populated vaultMeta (IP16-FE1-10)
    const vaultGetsAfter = h.server.requests.filter(
      (r) => r.method === 'GET' && r.url.endsWith('/vault'),
    ).length;
    expect(vaultGetsAfter).toBeGreaterThan(vaultGetsBefore);
    expect(h.vault().vaultMeta?.vault_key_id).toBe(KEY_ID);

    const postReq = h.server.requests.find(
      (r) => r.method === 'POST' && r.url.endsWith(`/items/${ITEM_ID}/entries`),
    )!;
    const postBody = JSON.parse(postReq.rawBody) as EntryCreateRequest;
    expect(postBody.type).toBe('json');
    expect(postReq.rawBody).not.toContain('host');
  });

  it('wipes plaintext holder on lock AND on unmount (card and composer), holds no plaintext across reloadVaultMeta or fallback GET awaits, and sends zero seal/PUT after lock or unmount (IP16-FE1-2, FE1-3)', async () => {
    const SECRET_SENTINEL = 'JSON_SECRET_SENTINEL_994411';
    const DRAFT_SENTINEL = 'JSON_DRAFT_KEEP_MINE_SENTINEL_772200';
    const UNMOUNT_SENTINEL = 'JSON_UNMOUNT_SENTINEL_883311';
    const COMPOSER_SENTINEL = 'JSON_COMPOSER_SENTINEL_665544';

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
    setJsonEditorPlaintextHolderForTests(holderRef);

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
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('json-cell-btn-root.p0')).toHaveTextContent(SECRET_SENTINEL);
    });
    assertNoPlaintextAttrs(h.container, [SECRET_SENTINEL]);

    // 1. Edit cell to DRAFT_SENTINEL
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

    // Lock vault while fallback GET is held -> holderRef is synchronously cleared before release
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

    // 2. Unmount while fallback GET is held (IP16-FE1-3): populate holder, enter held GET, unmount card -> holder empty BEFORE release, zero seal/PUT after
    fireEvent.click(screen.getByTestId('json-cell-btn-root.p0'));
    const cellInput2 = screen.getByTestId('json-cell-input-root.p0');
    fireEvent.change(cellInput2, { target: { value: UNMOUNT_SENTINEL } });
    fireEvent.keyDown(cellInput2, { key: 'Enter' });
    expect(holderRef.current.tableSource).toContain(UNMOUNT_SENTINEL);

    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(screen.getByTestId(`entry-conflict-box-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    const { promise: unmountGetGate, resolve: releaseUnmountGet } = createDeferred();
    const { promise: unmountGetEntered, resolve: notifyUnmountGetEntered } = createDeferred();
    h.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && method === 'GET') {
        notifyUnmountGetEntered();
        await unmountGetGate;
      }
      return null;
    });

    const putsBeforeUnmount = h.server.requests.filter((r) => r.method === 'PUT').length;
    sealSpy.mockClear();
    fireEvent.click(screen.getByTestId(`entry-conflict-keep-mine-${ENTRY_ID_1}`));
    await unmountGetEntered;

    // Unmount the card while the VaultProvider stays mounted and unlocked
    h.rerenderPage(<div data-testid="card-unmounted-placeholder" />);
    expect(screen.getByTestId('card-unmounted-placeholder')).toBeInTheDocument();

    // Holder MUST be empty immediately on unmount (before lock or GET release — fails on fa1f8c2)
    expect(holderRef.current).toEqual({
      originalSource: '',
      draftValue: '',
      submittedCandidateSource: '',
      tableSource: '',
    });

    await h.lock();
    await h.unlock();
    h.server.overrideRoute(null);
    releaseUnmountGet();
    const settleTimer = Promise.withResolvers<void>();
    setTimeout(settleTimer.resolve, 20);
    await settleTimer.promise;
    expect(sealSpy).not.toHaveBeenCalled();
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(putsBeforeUnmount);

    // 3. Composer unmount wipe & held reloadVaultMeta lock race (IP16-FE1-2, FE1-3)
    const composerHolderRef: { current: JsonComposerPlaintextHolder } = {
      current: { candidateSource: '' },
    };
    setJsonComposerPlaintextHolderForTests(composerHolderRef);

    h.rerenderPage(
      <NewJsonEntryComposer
        itemId={ITEM_ID}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    const composer = screen.getByTestId('new-json-entry-composer');
    fireEvent.click(within(composer).getByTestId('json-open-add-field-root'));
    fireEvent.change(within(composer).getByTestId('json-new-key-input-root'), {
      target: { value: COMPOSER_SENTINEL },
    });
    fireEvent.click(within(composer).getByTestId('json-confirm-add-field-root'));
    expect(composerHolderRef.current.candidateSource).toContain(COMPOSER_SENTINEL);

    // Unmount composer -> composerHolderRef is synchronously wiped
    h.rerenderPage(<div data-testid="composer-unmounted" />);
    expect(composerHolderRef.current.candidateSource).toBe('');

    // 4. Held reloadVaultMeta lock race on card Save (IP16-FE1-2):
    //    Suppose vaultMeta is null when user clicks Save; hold GET /vault, lock vault, then release GET /vault ->
    //    holder is empty before release, and zero sealEntry / PUT calls occur after release.
    const RELOAD_RACE_SENTINEL = 'JSON_RELOAD_RACE_SENTINEL_112233';
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
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('json-cell-btn-root.p0')).toHaveTextContent('REMOTE_V2_VALUE');
    });

    fireEvent.click(screen.getByTestId('json-cell-btn-root.p0'));
    const raceInput = screen.getByTestId('json-cell-input-root.p0');
    fireEvent.change(raceInput, { target: { value: RELOAD_RACE_SENTINEL } });
    fireEvent.keyDown(raceInput, { key: 'Enter' });
    expect(holderRef.current.tableSource).toContain(RELOAD_RACE_SENTINEL);

    const { promise: vaultGate, resolve: releaseVaultGet } = createDeferred();
    const { promise: vaultEntered, resolve: notifyVaultEntered } = createDeferred();
    const reloadMetaSpy = vi
      .spyOn(h.vault(), 'reloadVaultMeta')
      .mockImplementation(async () => {
        notifyVaultEntered();
        await vaultGate;
        return { vault_key_id: KEY_ID } as never;
      });
    const origMetaDesc = Object.getOwnPropertyDescriptor(h.vault(), 'vaultMeta');
    Object.defineProperty(h.vault(), 'vaultMeta', {
      get: () => null,
      configurable: true,
    });

    const putsBeforeRace = h.server.requests.filter((r) => r.method === 'PUT').length;
    sealSpy.mockClear();
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    await vaultEntered;

    // Lock while reloadVaultMeta is in flight -> holder is wiped BEFORE reloadVaultMeta resolves
    await h.lock();
    expect(holderRef.current).toEqual({
      originalSource: '',
      draftValue: '',
      submittedCandidateSource: '',
      tableSource: '',
    });

    if (origMetaDesc) {
      Object.defineProperty(h.vault(), 'vaultMeta', origMetaDesc);
    } else {
      Reflect.deleteProperty(h.vault(), 'vaultMeta');
    }
    reloadMetaSpy.mockRestore();
    releaseVaultGet();
    const raceSettle = Promise.withResolvers<void>();
    setTimeout(raceSettle.resolve, 20);
    await raceSettle.promise;

    expect(sealSpy).not.toHaveBeenCalled();
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(putsBeforeRace);
  });

  it('handles 5xx/network failure with Retry (same sealed bytes + same Idempotency-Key), single-flight double-click Save (exact 1 PUT), 412 preserving raw draft and table expanded/page state, Load latest discarding draft, and assertNoPlaintextAttrs across states (IP16-FE1-9, FE1-10)', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
    });

    const SECRET_RAW_DRAFT = 'RAW_CONFLICT_SECRET_DRAFT_551199';
    const SECRET_TABLE_DRAFT = 'TABLE_CONFLICT_SECRET_DRAFT_442288';

    const h = await setupJsonCardHarness({
      initialEntries: [
        {
          id: ENTRY_ID_1,
          text: '{\n  "notes": "line1\\nline2",\n  "status": "v1",\n  "nested": { "inner": "keep_expanded" }\n}',
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

    // Expand nested container in Table view so we can verify 412 preserves expandedPaths
    fireEvent.click(within(card).getByTestId('json-toggle-root.p2'));
    expect(within(card).getByTestId('json-toggle-root.p2')).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    // Edit cell to SECRET_TABLE_DRAFT
    fireEvent.click(within(card).getByTestId('json-cell-btn-root.p1'));
    const statusInput = within(card).getByTestId('json-cell-input-root.p1');
    fireEvent.change(statusInput, { target: { value: SECRET_TABLE_DRAFT } });
    fireEvent.keyDown(statusInput, { key: 'Enter' });

    // 1. First PUT fails with 503 dependency_unavailable -> single-flight double-click Save sends EXACTLY 1 PUT
    let failPut503 = true;
    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && init?.method === 'PUT' && failPut503) {
        return problemResponse('dependency_unavailable', 503);
      }
      return null;
    });

    const saveBtn = within(card).getByTestId(`entry-save-btn-${ENTRY_ID_1}`);
    fireEvent.click(saveBtn);
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(within(card).getByTestId(`entry-save-retry-box-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

    // assertNoPlaintextAttrs after a failed save (table mode)
    assertNoPlaintextAttrs(h.container, [SECRET_TABLE_DRAFT, 'keep_expanded']);

    const failedPuts = h.server.requests.filter((r) => r.method === 'PUT');
    expect(failedPuts).toHaveLength(1);
    const firstIdemKey = failedPuts[0]!.headers['idempotency-key'];
    const firstRawBody = failedPuts[0]!.rawBody;

    failPut503 = false;
    fireEvent.click(within(card).getByTestId(`entry-retry-save-btn-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(within(card).queryByTestId(`entry-save-retry-box-${ENTRY_ID_1}`)).toBeNull();
      expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(2);
    });
    const allPutsAfterRetry = h.server.requests.filter((r) => r.method === 'PUT');
    const retryPut = allPutsAfterRetry[1]!;
    expect(retryPut.headers['idempotency-key']).toBe(firstIdemKey);
    expect(retryPut.rawBody).toBe(firstRawBody);

    // 2. Switch to Raw JSON, edit draft to SECRET_RAW_DRAFT, trigger 412 -> verify 412 keeps Raw JSON draft AND Table expanded state
    fireEvent.click(within(card).getByTestId(`json-tab-raw-${ENTRY_ID_1}`));
    const rawTa = within(card).getByTestId(
      `json-raw-textarea-${ENTRY_ID_1}`,
    ) as HTMLTextAreaElement;
    const rawDraftJson = `{\n  "notes": "line1\\nline2",\n  "status": "${SECRET_RAW_DRAFT}",\n  "nested": { "inner": "keep_expanded" }\n}`;
    fireEvent.change(rawTa, { target: { value: rawDraftJson } });
    fireEvent.blur(rawTa);

    // assertNoPlaintextAttrs while unlocked in Raw JSON mode
    assertNoPlaintextAttrs(h.container, [SECRET_RAW_DRAFT]);

    // Server advances to version 3 concurrently
    await h.server.sealJsonForEntry(
      ENTRY_ID_1,
      '{\n  "notes": "remote",\n  "status": "remote_v3",\n  "nested": { "inner": "remote_inner" }\n}',
      3,
      0,
    );

    const putsBefore412 = h.server.requests.filter((r) => r.method === 'PUT').length;
    fireEvent.click(within(card).getByTestId(`json-raw-save-btn-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(within(card).getByTestId(`entry-conflict-box-${ENTRY_ID_1}`)).toBeInTheDocument();
      expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(putsBefore412 + 1);
    });

    // Raw draft is preserved on 412, and assertNoPlaintextAttrs after failed 412 save in Raw mode passes
    expect(rawTa.value).toBe(rawDraftJson);
    assertNoPlaintextAttrs(h.container, [SECRET_RAW_DRAFT]);

    // Copy mine copies the draft
    fireEvent.click(within(card).getByTestId(`entry-conflict-copy-mine-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalled();
    });
    expect(writeTextMock.mock.calls[0]?.[0]).toContain(SECRET_RAW_DRAFT);

    // Keep mine re-seals with fresh nonce and PUTs with If-Match: "3"
    const putsBeforeKeepMine = h.server.requests.filter((r) => r.method === 'PUT').length;
    fireEvent.click(within(card).getByTestId(`entry-conflict-keep-mine-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(
        putsBeforeKeepMine + 1,
      );
      expect(within(card).queryByTestId(`entry-conflict-box-${ENTRY_ID_1}`)).toBeNull();
    });
    const keepMinePuts = h.server.requests.filter((r) => r.method === 'PUT');
    expect(keepMinePuts[keepMinePuts.length - 1]!.headers['if-match']).toBe('"3"');

    // Table expanded state on root.p2 was preserved across Raw edit + 412 + Keep mine
    expect(within(card).getByTestId('json-toggle-root.p2')).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    // 3. Trigger another 412 in Table mode and click "Tải bản mới" (Load latest) -> discards local draft and loads remote v5
    fireEvent.click(within(card).getByTestId('json-cell-btn-root.p1'));
    const statusInput2 = within(card).getByTestId('json-cell-input-root.p1');
    fireEvent.change(statusInput2, { target: { value: 'DISCARDED_LOCAL_DRAFT' } });
    fireEvent.keyDown(statusInput2, { key: 'Enter' });

    await h.server.sealJsonForEntry(
      ENTRY_ID_1,
      '{\n  "notes": "remote",\n  "status": "REMOTE_V5_LOADED",\n  "nested": { "inner": "remote_inner" }\n}',
      5,
      0,
    );

    fireEvent.click(within(card).getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(within(card).getByTestId(`entry-conflict-box-${ENTRY_ID_1}`)).toBeInTheDocument();
    });
    // Table draft and expanded state are still intact during 412
    expect(within(card).getByTestId('json-cell-btn-root.p1')).toHaveTextContent(
      'DISCARDED_LOCAL_DRAFT',
    );
    expect(within(card).getByTestId('json-toggle-root.p2')).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    // Click Load latest -> confirm discard -> local draft is dropped and REMOTE_V5_LOADED is displayed
    fireEvent.click(within(card).getByTestId(`entry-conflict-load-latest-${ENTRY_ID_1}`));
    fireEvent.click(within(card).getByTestId(`entry-conflict-confirm-discard-${ENTRY_ID_1}`));

    await waitFor(() => {
      expect(within(card).queryByTestId(`entry-conflict-box-${ENTRY_ID_1}`)).toBeNull();
      expect(within(card).getByTestId('json-cell-btn-root.p1')).toHaveTextContent(
        'REMOTE_V5_LOADED',
      );
    });
    expect(card.textContent).not.toContain('DISCARDED_LOCAL_DRAFT');
  });
});
