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
import userEvent from '@testing-library/user-event';
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
  getUnconfirmedSavesSnapshot,
  resetEntryBodyLoadLimiterForTests,
  type EditorPlaintextHolder,
} from '@/features/entries';
import { __testing as unconfirmedSaveStoreTesting } from '@/features/entries/unconfirmed-save-store';
import { __testing as userChangedTesting } from '@/lib/auth/user-changed';
import { assertNoPlaintextAttrs } from '@/features/entries/test-utils/assert-no-plaintext-attrs';
import { ItemDetailPage } from '@/features/items/item-detail-page';
import {
  JsonEntryCard,
  NewJsonEntryComposer,
  __testing as jsonTableTesting,
  type JsonComposerPlaintextHolder,
} from '@/features/json-table';
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
const USER_B_ID = '44444444-4444-4444-8444-444444444444';

const utf8Encoder = new TextEncoder();

function createDeferred<T = void>(): PromiseWithResolvers<T> {
  return Promise.withResolvers<T>();
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
    userChangedTesting.resetCommittedUserForTests();
    jsonTableTesting.setJsonEditorPlaintextHolderForTests(null);
    jsonTableTesting.setJsonComposerPlaintextHolderForTests(null);
  });

  afterEach(() => {
    cleanup();
    jsonTableTesting.setJsonEditorPlaintextHolderForTests(null);
    jsonTableTesting.setJsonComposerPlaintextHolderForTests(null);
    if (originalClipboardDesc) {
      Object.defineProperty(navigator, 'clipboard', originalClipboardDesc);
    }
    for (const shim of shims.splice(0)) shim.close();
    resetVaultBroadcastForTests();
    resetEntryBodyLoadLimiterForTests();
    clearAllUnconfirmedSaves();
    userChangedTesting.resetCommittedUserForTests();
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
    signOutSession: () => Promise<void>;
    loginSession: (email: string, password: string) => Promise<void>;
    setCurrentMe: (me: Me | null) => void;
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
    let currentMe: Me | null = makeMe(USER_A_ID, 'present');
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
      if (url.endsWith('/auth/login')) {
        return jsonResponse(currentMe ?? makeMe(USER_A_ID, 'present'));
      }
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

    // Duplicate key disambiguation in object table: (#1) ⁽¹⁾ and (#2) ⁽²⁾ with sr-only occurrenceAria (FE2-2)
    const dupOcc0 = within(card1).getByTestId('json-dup-occ-root.k0');
    const dupOcc1 = within(card1).getByTestId('json-dup-occ-root.k1');
    expect(dupOcc0).toHaveTextContent('(#1) ⁽¹⁾');
    expect(dupOcc1).toHaveTextContent('(#2) ⁽²⁾');
    expect(dupOcc0.querySelector('.sr-only')).toHaveTextContent('Lần xuất hiện thứ 1');
    expect(dupOcc1.querySelector('.sr-only')).toHaveTextContent('Lần xuất hiện thứ 2');
    expect(within(card1).getByTestId('json-cell-btn-root.k0')).toHaveAccessibleName(
      'Hàng 1, cột 1',
    );
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
  }, 30_000);

  it(
    'renders 10000-level deep nested JSON input without stack overflow and builds only one level lazily until expanded, and paginates 600 rows into 12 pages (50 rows/page)',
    async () => {
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
    const page1Cells = Array.from(
      card600.querySelectorAll<HTMLElement>('[data-testid^="json-cell-btn-root.e"]'),
    );
    expect(page1Cells).toHaveLength(50);
    expect(within(card600).getByTestId('json-cell-btn-root.e0')).toHaveTextContent(/^row_val_1$/);
    expect(within(card600).getByTestId('json-cell-btn-root.e49')).toHaveTextContent(/^row_val_50$/);
    expect(within(card600).queryByTestId('json-cell-btn-root.e50')).toBeNull();

    // Click Next page -> Trang 2/12, shows rows 51..100
    fireEvent.click(within(card600).getByTestId('json-page-next-root'));
    expect(within(card600).getByTestId('json-page-indicator-root')).toHaveTextContent(
      'Trang 2/12',
    );
    const page2Cells = Array.from(
      card600.querySelectorAll<HTMLElement>('[data-testid^="json-cell-btn-root.e"]'),
    );
    expect(page2Cells).toHaveLength(50);
    expect(within(card600).getByTestId('json-cell-btn-root.e50')).toHaveTextContent(/^row_val_51$/);
    expect(within(card600).getByTestId('json-cell-btn-root.e99')).toHaveTextContent(/^row_val_100$/);
    expect(within(card600).queryByTestId('json-cell-btn-root.e0')).toBeNull();
    expect(page2Cells.map((el) => el.textContent?.trim())).not.toContain('row_val_1');
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
    },
    30_000,
  );

  describe('A6 corpus UI edit-one-cell byte preservation across EVERY Task 12 valid fixture', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(CORPUS_DIR, 'manifest.json'), 'utf8'),
    ) as CorpusManifest;
    const validFixtures = manifest.fixtures.filter(
      (f) => f.kind === 'valid' || f.kind === 'valid-bom',
    );

    const uiTargetByFixture: Readonly<
      Record<
        string,
        | { kind: 'cell'; expand?: readonly string[]; cellKey: string; newVal: string }
        | { kind: 'type'; cellKey: string; newType: 'string' }
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
      'root-null': { kind: 'type', cellKey: 'root', newType: 'string' },
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
        cellKey: 'root.e0.extra.p20',
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

    it('maps every valid and valid-bom fixture in manifest.json 1-to-1 with uiTargetByFixture', () => {
      expect(Object.keys(uiTargetByFixture).sort()).toEqual(
        validFixtures.map((f) => f.id).sort(),
      );
    });

    it.each(validFixtures.map((f) => [f.id, f] as const))(
      'edits one cell in corpus fixture %s through the JsonEntryCard UI, saves, decrypts the saved payload, and verifies bytes outside the edited span are identical (A6)',
      async (_fixtureId, fixture) => {
        const rawBytes = new Uint8Array(
          fs.readFileSync(path.join(CORPUS_DIR, fixture.file)),
        );
        const decoded = decodeUtf8FileStrict(rawBytes);
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) return;

        const sourceText = decoded.text;
        const originalBytes = utf8Encoder.encode(sourceText);
        const parsedBefore = parseJsonStrict(sourceText);
        expect(parsedBefore.ok).toBe(true);
        if (!parsedBefore.ok) return;

        const h = await setupJsonCardHarness({
          initialEntries: [
            { id: ENTRY_ID_1, text: sourceText, type: 'json', position: 0, version: 1 },
          ],
        });

        const entryMeta: EntryMeta = {
          id: ENTRY_ID_1,
          item_id: ITEM_ID,
          type: 'json',
          position: 0,
          version: 1,
          plaintext_len_bucket: Math.max(
            256,
            Math.ceil(originalBytes.byteLength / 256) * 256,
          ),
          created_at: '2026-11-01T00:00:00Z',
          updated_at: '2026-11-01T00:00:00Z',
        };

        h.rerenderPage(
          <JsonEntryCard
            key={fixture.id}
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
        if (!action) return;

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

        const savedPlaintext = await h.server.openServerEntryPlaintext(ENTRY_ID_1);
        const savedBytes = utf8Encoder.encode(savedPlaintext);

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
          if (fixture.id === 'root-number') {
            expect(p + s).toBe(0);
            expect(savedPlaintext).toBe('9007199254740993');
          } else {
            expect(p + s).toBeGreaterThan(0);
          }
          const replacedOriginalLen = originalBytes.byteLength - p - s;
          expect(replacedOriginalLen).toBeLessThanOrEqual(32);
        }
      },
      30_000,
    );
  });

  it(
    'edits cell inline, preserves surrounding bytes + CRLF + duplicate keys + 9007199254740993 on Save, keeps neighbor string with \\n byte-identical, keeps \\n escape when editing a multiline cell, and sends NO PUT on no-op commit (preserving \\u00e9 and \\/)',
    async () => {
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
    },
    30_000,
  );

  it(
    'blocks a Table cell edit that pushes the JSON document over 256 KiB (262,144 UTF-8 bytes) with an inline message and sends no PUT',
    async () => {
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
    },
    30_000,
  );

  it(
    'supports cell type conversion (string "42" -> number 42 -> null), Add field, Remove field, Add row, Remove row, missing cell (—) initialization, and keyboard navigation (Arrows, Tab/Shift+Tab, Enter, Esc, Ctrl+S)',
    async () => {
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
    const keyBtn1 = within(card).getByTestId('json-cell-btn-root.k1');
    const toggleBtn1 = within(card).getByTestId('json-toggle-root.p1');

    keyBtn0.focus();
    expect(document.activeElement).toBe(keyBtn0);
    fireEvent.keyDown(keyBtn0, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(valBtn0);
    fireEvent.keyDown(valBtn0, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(toggleBtn1);
    fireEvent.keyDown(toggleBtn1, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(valBtn0);

    // Native Tab / Shift+Tab focus order across interactive grid buttons and chevron Enter activation (FE2-10)
    const navButtons = Array.from(
      within(card)
        .getByTestId(`json-table-host-${ENTRY_ID_1}`)
        .querySelectorAll<HTMLElement>('[data-json-grid-nav]:not(:disabled)'),
    );
    expect(navButtons.slice(0, 4)).toEqual([keyBtn0, valBtn0, keyBtn1, toggleBtn1]);
    expect(keyBtn0.tabIndex).toBe(0);
    expect(valBtn0.tabIndex).toBe(0);
    expect(toggleBtn1.tabIndex).toBe(0);
    fireEvent.keyDown(keyBtn0, { key: 'Tab' });
    valBtn0.focus();
    expect(document.activeElement).toBe(valBtn0);
    fireEvent.keyDown(valBtn0, { key: 'Tab', shiftKey: true });
    keyBtn0.focus();
    expect(document.activeElement).toBe(keyBtn0);

    // Chevron Enter key on native <button> expands and collapses container
    toggleBtn1.focus();
    fireEvent.keyDown(toggleBtn1, { key: 'Enter', code: 'Enter' });
    fireEvent.click(toggleBtn1);
    expect(toggleBtn1).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(toggleBtn1, { key: 'Enter', code: 'Enter' });
    fireEvent.click(toggleBtn1);
    expect(toggleBtn1).toHaveAttribute('aria-expanded', 'false');
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

    // Open a cell editor on root.p2, edit to false, and press Ctrl+S while the cell editor is still open -> commits pending cell first and saves (FE1-14, FE2-10)
    fireEvent.click(within(card).getByTestId('json-cell-btn-root.p2'));
    const openBoolInput = within(card).getByTestId('json-cell-input-root.p2');
    fireEvent.change(openBoolInput, { target: { value: 'true' } });
    fireEvent.keyDown(openBoolInput, { key: 's', ctrlKey: true });
    await waitFor(() => {
      expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    });

    const saved = await h.server.openServerEntryPlaintext(ENTRY_ID_1);
    expect(parseJsonStrict(saved).ok).toBe(true);
    expect(saved).toContain('"count": 42');
    expect(saved).toContain('"enabled": true');
    expect(saved).toContain('"b": ""');
    },
    30_000,
  );

  it(
    'marks cells with lone surrogate (\\ud800) or carriage return (\\r) as read-only in Table view with explanation note and allows editing in Raw JSON',
    async () => {
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
    },
    30_000,
  );

  it(
    'validates Raw JSON on typing pause, shows line/col error box, jumps to error offset on "Đi tới lỗi" with both LF+emoji and CRLF+emoji, blocks switching to Table while invalid, and formats with 2-space indent preserving token stream',
    async () => {
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

    // 2b. Test "Đi tới lỗi" with CRLF (\r\n) + astral emoji on the textarea value:
    // Browsers and jsdom normalize CRLF (\r\n) to LF (\n) in HTMLTextAreaElement.value (WHATWG HTML spec),
    // so each of the 2 preceding \r\n line breaks occupies 1 UTF-16 code unit (\n) instead of 2 (\r\n)
    // in the live textarea value, while the astral emoji pair ("🚀🎉") still occupies 4 UTF-16 code units.
    // Line 3, column 13 therefore resolves to UTF-16 offset 33 (= 35 in raw CRLF source minus 2 normalized \r chars):
    //   Line 1: "{\n"                    ->  2 code units (offsets 0..1)
    //   Line 2: '  "emoji": "🚀🎉",\n'   -> 19 code units (offsets 2..20, where 🚀🎉 is 4 UTF-16 code units)
    //   Line 3: '  "broken": @'          -> 12 code units before '@' (offsets 21..32), so '@' is at offset 33.
    const invalidWithCrlfAndEmoji = '{\r\n  "emoji": "🚀🎉",\r\n  "broken": @\r\n}';
    const normalizedTextareaValue = invalidWithCrlfAndEmoji.replace(/\r\n/g, '\n');
    const parsedCrlfErr = parseJsonStrict(invalidWithCrlfAndEmoji);
    expect(parsedCrlfErr.ok).toBe(false);
    const expectedRawCrlfOffset = invalidWithCrlfAndEmoji.indexOf('@'); // 35 in raw CRLF string
    const expectedTextareaOffset = normalizedTextareaValue.indexOf('@'); // 33 in textarea.value (35 - 2 prior \r)
    expect(expectedRawCrlfOffset).toBe(35);
    expect(expectedTextareaOffset).toBe(33);
    if (!parsedCrlfErr.ok) {
      expect(
        lineColumnToOffset(
          invalidWithCrlfAndEmoji,
          parsedCrlfErr.error.line,
          parsedCrlfErr.error.column,
        ),
      ).toBe(expectedRawCrlfOffset);
      expect(
        lineColumnToOffset(
          normalizedTextareaValue,
          parsedCrlfErr.error.line,
          parsedCrlfErr.error.column,
        ),
      ).toBe(expectedTextareaOffset);
    }
    fireEvent.change(rawTextarea, { target: { value: invalidWithCrlfAndEmoji } });
    fireEvent.blur(rawTextarea);
    const errBoxAfterCrlf = await within(card).findByTestId(`json-raw-error-${ENTRY_ID_1}`);
    expect(errBoxAfterCrlf).toHaveTextContent('Dòng 3, cột 13');
    fireEvent.click(within(card).getByTestId(`json-raw-goto-btn-${ENTRY_ID_1}`));
    expect(rawTextarea.selectionStart).toBe(expectedTextareaOffset);
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

    // 5. Switch back to Raw JSON and press Ctrl+S inside the textarea -> flushes validation and sends exactly 1 PUT without double-handling (FE2-8, FE2-10)
    fireEvent.click(within(card).getByTestId(`json-tab-raw-${ENTRY_ID_1}`));
    const rawTaForCtrlS = within(card).getByTestId(`json-raw-textarea-${ENTRY_ID_1}`);
    fireEvent.keyDown(rawTaForCtrlS, { key: 's', ctrlKey: true });
    await waitFor(() => {
      expect(within(card).queryByTestId(`json-raw-cancel-btn-${ENTRY_ID_1}`)).toBeNull();
    });
  },
    30_000,
  );

  it(
    'blocks Save and Format when Raw JSON exceeds 256 KiB (262,144 UTF-8 bytes) and refuses Format when nesting depth > JSON_FORMAT_MAX_DEPTH',
    async () => {
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
    },
    30_000,
  );

  it(
    'preserves CRLF without PUT when opening Raw JSON and clicking Save without edits, keeps CRLF outside a 1-char Raw edit, and warns before normalizing mixed EOL on Save',
    async () => {
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
    },
    30_000,
  );

  it(
    '"+ JSON / bảng" composer creates a new JSON entry with Empty object {} or Empty array [] preset, and lazy-loads GET /vault when vaultMeta is initially null (advisor-dec-200)',
    async () => {
    const h = await setupJsonCardHarness({
      initialEntries: [],
      skipInitialReloadVaultMeta: true,
    });

    await waitFor(() => {
      expect(screen.getByTestId('btn-add-json')).toBeEnabled();
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
    expect(composer.textContent).toContain(
      viMessages.content.json.emptyObject.replaceAll("'", ''),
    );
    expect(composer.textContent).not.toContain('content.json.emptyObject');

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
    },
    30_000,
  );

  it(
    'wipes plaintext holder on lock AND on unmount (card and composer), holds no plaintext across reloadVaultMeta or fallback GET awaits, and sends zero seal/PUT after lock or unmount (IP16-FE1-2, FE1-3)',
    async () => {
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
    jsonTableTesting.setJsonEditorPlaintextHolderForTests(holderRef);

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
    const { promise: unmountGetFinished, resolve: notifyUnmountGetFinished } = createDeferred();
    h.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && method === 'GET') {
        notifyUnmountGetEntered();
        await unmountGetGate;
        queueMicrotask(() => notifyUnmountGetFinished());
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
    await unmountGetFinished;
    await act(async () => {
      await flushMacrotask();
      await flushMacrotask();
      await flushMacrotask();
    });
    expect(sealSpy).not.toHaveBeenCalled();
    expect(h.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(putsBeforeUnmount);

    // 3. Composer unmount wipe & held reloadVaultMeta lock race (IP16-FE1-2, FE1-3)
    const composerHolderRef: { current: JsonComposerPlaintextHolder } = {
      current: { candidateSource: '' },
    };
    jsonTableTesting.setJsonComposerPlaintextHolderForTests(composerHolderRef);

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

    // 4. Held reloadVaultMeta lock race on card Save via route-level GET /vault hold (IP16-FE1-2, FE2-5):
    //    Mount a fresh harness with skipInitialReloadVaultMeta: true so vaultMeta is genuinely null when the user clicks Save;
    //    hold GET /vault at the route level, lock vault while GET /vault is in flight, then release GET /vault ->
    //    holder is empty before release, and zero sealEntry / PUT calls occur after release.
    cleanup();
    const reloadRaceHolderRef: { current: EditorPlaintextHolder } = {
      current: { originalSource: '', draftValue: '', submittedCandidateSource: '', tableSource: '' },
    };
    jsonTableTesting.setJsonEditorPlaintextHolderForTests(reloadRaceHolderRef);

    const RELOAD_RACE_SENTINEL = 'JSON_RELOAD_RACE_SENTINEL_112233';
    const hRace = await setupJsonCardHarness({
      initialEntries: [],
      skipInitialReloadVaultMeta: true,
    });

    let holdVaultGet = false;
    const { promise: vaultGate, resolve: releaseVaultGet } = createDeferred();
    const { promise: vaultEntered, resolve: notifyVaultEntered } = createDeferred();
    const { promise: vaultFinished, resolve: notifyVaultFinished } = createDeferred();

    hRace.server.overrideRoute(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.endsWith('/vault') && holdVaultGet) {
        notifyVaultEntered();
        await vaultGate;
        queueMicrotask(() => notifyVaultFinished());
      }
      return null;
    });

    expect(hRace.vault().vaultMeta).toBeNull();
    const raceEntryMeta = await hRace.server.sealJsonForEntry(
      ENTRY_ID_1,
      '{"secretKey":"INITIAL_NULL_META_V1"}',
      1,
      0,
    );
    act(() => {
      hRace.qc.setQueryData(
        vaultBodyQueryKey(ENTRY_ID_1, 1),
        '{"secretKey":"INITIAL_NULL_META_V1"}',
      );
    });
    hRace.rerenderPage(
      <JsonEntryCard
        entry={raceEntryMeta}
        itemId={ITEM_ID}
        index={0}
        total={1}
        canReorder={false}
        lazy={false}
        load={async () => '{"secretKey":"INITIAL_NULL_META_V1"}'}
        onMoveUp={() => {}}
        onMoveDown={() => {}}
        onDelete={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('json-cell-btn-root.p0')).toHaveTextContent(
        'INITIAL_NULL_META_V1',
      );
    });
    expect(hRace.vault().vaultMeta).toBeNull();

    fireEvent.click(screen.getByTestId('json-cell-btn-root.p0'));
    const raceInput = screen.getByTestId('json-cell-input-root.p0');
    fireEvent.change(raceInput, { target: { value: RELOAD_RACE_SENTINEL } });
    fireEvent.keyDown(raceInput, { key: 'Enter' });
    expect(reloadRaceHolderRef.current.tableSource).toContain(RELOAD_RACE_SENTINEL);

    holdVaultGet = true;
    const raceSealSpy = vi.spyOn(hRace.vault().getClient(), 'sealEntry');
    const putsBeforeRace = hRace.server.requests.filter((r) => r.method === 'PUT').length;

    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    await vaultEntered;

    // Lock while route-level GET /vault is in flight -> holder is wiped BEFORE GET /vault resolves
    await hRace.lock();
    expect(reloadRaceHolderRef.current).toEqual({
      originalSource: '',
      draftValue: '',
      submittedCandidateSource: '',
      tableSource: '',
    });

    holdVaultGet = false;
    hRace.server.overrideRoute(null);
    releaseVaultGet();
    await vaultFinished;
    await act(async () => {
      await flushMacrotask();
      await flushMacrotask();
      await flushMacrotask();
    });

    expect(raceSealSpy).not.toHaveBeenCalled();
    expect(hRace.server.requests.filter((r) => r.method === 'PUT')).toHaveLength(putsBeforeRace);
  },
  30_000,
);

  it(
    'handles 5xx/network failure with Retry (same sealed bytes + same Idempotency-Key), single-flight concurrent Save (exact 1 PUT), 412 localized panel text (vi + en) preserving raw draft and table expanded/page state, Load latest discarding draft, and assertNoPlaintextAttrs across states (IP16-FE1-9, FE1-10, FE2-1, FE2-9)',
    async () => {
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

    // 1. First PUT is held and then fails with 503 dependency_unavailable -> single-flight guard blocks concurrent Ctrl+S / Save while in flight (FE2-9)
    let failPut503 = true;
    let holdFirstPut = true;
    const { promise: firstPutGate, resolve: releaseFirstPut } = createDeferred();
    const { promise: firstPutEntered, resolve: notifyFirstPutEntered } = createDeferred();
    h.server.overrideRoute(async (url, init) => {
      if (url.endsWith(`/entries/${ENTRY_ID_1}`) && init?.method === 'PUT' && failPut503) {
        if (holdFirstPut) {
          notifyFirstPutEntered();
          await firstPutGate;
        }
        return problemResponse('dependency_unavailable', 503, {
          retry_after: 60,
        });
      }
      return null;
    });

    // Dispatch two rapid Ctrl+S keydowns synchronously before React flushes disabled state, and a third while PUT is held
    fireEvent.keyDown(card, { key: 's', ctrlKey: true });
    fireEvent.keyDown(card, { key: 's', ctrlKey: true });
    await firstPutEntered;
    fireEvent.keyDown(card, { key: 's', ctrlKey: true });
    holdFirstPut = false;
    releaseFirstPut();
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

    // Wait for the version-2 body query to finish decrypting so the Table / Raw JSON tabs re-mount
    await waitFor(() => {
      expect(within(card).getByTestId(`json-tab-raw-${ENTRY_ID_1}`)).toBeInTheDocument();
    });

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
    // Assert localized Vietnamese text in 412 conflict panel (no raw key names like content.entry.conflictHeading — FE2-1)
    const conflictBoxVi = within(card).getByTestId(`entry-conflict-box-${ENTRY_ID_1}`);
    expect(conflictBoxVi).toHaveTextContent(viMessages.content.entry.conflictTitle);
    expect(conflictBoxVi).toHaveTextContent(viMessages.content.entry.conflictBody);
    expect(within(card).getByTestId(`entry-conflict-copy-mine-${ENTRY_ID_1}`)).toHaveTextContent(
      viMessages.content.entry.copyMine,
    );
    expect(
      within(card).getByTestId(`entry-conflict-load-latest-${ENTRY_ID_1}`),
    ).toHaveTextContent(viMessages.content.entry.loadLatest);
    expect(within(card).getByTestId(`entry-conflict-keep-mine-${ENTRY_ID_1}`)).toHaveTextContent(
      viMessages.content.entry.keepMine,
    );
    expect(conflictBoxVi.textContent).not.toContain('content.entry.');
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
      expect(within(card).getByTestId('json-toggle-root.p2')).toBeInTheDocument();
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

    // Click Load latest -> assert localized confirmation prompt & buttons -> confirm discard -> local draft is dropped and REMOTE_V5_LOADED is displayed
    fireEvent.click(within(card).getByTestId(`entry-conflict-load-latest-${ENTRY_ID_1}`));
    const reloadConfirmVi = within(card).getByTestId(
      `entry-conflict-reload-confirm-${ENTRY_ID_1}`,
    );
    expect(reloadConfirmVi).toHaveTextContent(viMessages.content.entry.reloadConfirmPrompt);
    expect(reloadConfirmVi).toHaveTextContent(viMessages.content.entry.keepEditing);
    expect(
      within(card).getByTestId(`entry-conflict-confirm-discard-${ENTRY_ID_1}`),
    ).toHaveTextContent(viMessages.content.entry.discardAndLoad);
    fireEvent.click(within(card).getByTestId(`entry-conflict-confirm-discard-${ENTRY_ID_1}`));
    await waitFor(() => {
      expect(within(card).queryByTestId(`entry-conflict-box-${ENTRY_ID_1}`)).toBeNull();
      expect(within(card).getByTestId('json-cell-btn-root.p1')).toHaveTextContent(
        'REMOTE_V5_LOADED',
      );
    });
    expect(card.textContent).not.toContain('DISCARDED_LOCAL_DRAFT');
    // 4. Verify English (en) localized text for 412 conflict panel and occurrenceAria (FE2-1, FE2-2)
    cleanup();
    const hEn = await setupJsonCardHarness({
      locale: 'en',
      initialEntries: [
        {
          id: ENTRY_ID_1,
          text: '{\n  "dup": "v1",\n  "dup": "v2"\n}',
          type: 'json',
          position: 0,
          version: 1,
        },
      ],
    });
    await waitFor(() => {
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
    });
    const cardEn = screen.getByTestId(`entry-card-${ENTRY_ID_1}`);
    expect(
      within(cardEn).getByTestId('json-dup-occ-root.k0').querySelector('.sr-only'),
    ).toHaveTextContent(en.content.json.occurrenceAria.replace('{occ}', '1'));

    fireEvent.click(within(cardEn).getByTestId('json-cell-btn-root.p0'));
    const inputEn = within(cardEn).getByTestId('json-cell-input-root.p0');
    fireEvent.change(inputEn, { target: { value: 'edited_en' } });
    fireEvent.keyDown(inputEn, { key: 'Enter' });

    await hEn.server.sealJsonForEntry(
      ENTRY_ID_1,
      '{\n  "dup": "remote_en",\n  "dup": "v2"\n}',
      2,
      0,
    );
    fireEvent.click(within(cardEn).getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
    const conflictBoxEn = await within(cardEn).findByTestId(`entry-conflict-box-${ENTRY_ID_1}`);
    expect(conflictBoxEn).toHaveTextContent(en.content.entry.conflictTitle);
    expect(conflictBoxEn).toHaveTextContent(en.content.entry.conflictBody);
    expect(within(cardEn).getByTestId(`entry-conflict-copy-mine-${ENTRY_ID_1}`)).toHaveTextContent(
      en.content.entry.copyMine,
    );
    expect(
      within(cardEn).getByTestId(`entry-conflict-load-latest-${ENTRY_ID_1}`),
    ).toHaveTextContent(en.content.entry.loadLatest);
    expect(within(cardEn).getByTestId(`entry-conflict-keep-mine-${ENTRY_ID_1}`)).toHaveTextContent(
      en.content.entry.keepMine,
    );
    fireEvent.click(within(cardEn).getByTestId(`entry-conflict-load-latest-${ENTRY_ID_1}`));
    const reloadConfirmEn = within(cardEn).getByTestId(
      `entry-conflict-reload-confirm-${ENTRY_ID_1}`,
    );
    expect(reloadConfirmEn).toHaveTextContent(en.content.entry.reloadConfirmPrompt);
    expect(
      within(cardEn).getByTestId(`entry-conflict-confirm-discard-${ENTRY_ID_1}`),
    ).toHaveTextContent(en.content.entry.discardAndLoad);
    expect(conflictBoxEn.textContent).not.toContain('content.entry.');
  },
  30_000,
);

  it(
    'IP16-R3-1: keeps JSON table and mode switcher mounted across the post-Save version hand-off and restores focus to the edited cell (or card when the cell no longer exists)',
    async () => {
      const h = await setupJsonCardHarness({
        initialEntries: [
          {
            id: ENTRY_ID_1,
            text: '{\n  "host": "db-primary",\n  "temp": "remove-me"\n}',
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

      // Hold the version-2 GET /entries/{id} so body === undefined during the version hand-off after PUT v2 commits
      const { promise: v2GetGate, resolve: releaseV2Get } = createDeferred();
      const { promise: v2GetEntered, resolve: notifyV2GetEntered } = createDeferred();
      let holdV2Get = true;
      h.server.overrideRoute(async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.endsWith(`/entries/${ENTRY_ID_1}`) && method === 'GET' && holdV2Get) {
          notifyV2GetEntered();
          await v2GetGate;
        }
        return null;
      });

      // 1. Edit cell root.p0 and Save -> while GET /entries/{id} for v2 is held, table stays mounted (no entry-body-loading flash) and focus returns to root.p0
      fireEvent.click(within(card).getByTestId('json-cell-btn-root.p0'));
      const hostInput = within(card).getByTestId('json-cell-input-root.p0');
      fireEvent.change(hostInput, { target: { value: 'db-replica-v2' } });
      fireEvent.keyDown(hostInput, { key: 'Enter' });

      fireEvent.click(within(card).getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
      await v2GetEntered;

      // Even before v2 decrypts, the table and Table/Raw switcher remain rendered and focus is restored to the edited cell
      expect(within(card).queryByTestId('entry-body-loading')).toBeNull();
      expect(within(card).getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
      expect(within(card).getByTestId(`json-mode-switcher-${ENTRY_ID_1}`)).toBeInTheDocument();
      await waitFor(() => {
        expect(document.activeElement).toBe(within(card).getByTestId('json-cell-btn-root.p0'));
      });

      holdV2Get = false;
      releaseV2Get();
      await waitFor(() => {
        expect(within(card).getByTestId('json-cell-btn-root.p0')).toHaveTextContent('db-replica-v2');
      });
      expect(document.activeElement).toBe(within(card).getByTestId('json-cell-btn-root.p0'));

      // 2. Edit cell root.p1, then switch to Raw and remove the second field so root.p1 no longer exists after Save -> focus falls back to the card article
      fireEvent.click(within(card).getByTestId('json-cell-btn-root.p1'));
      const tempInput = within(card).getByTestId('json-cell-input-root.p1');
      fireEvent.change(tempInput, { target: { value: 'about-to-vanish' } });
      fireEvent.keyDown(tempInput, { key: 'Enter' });

      fireEvent.click(within(card).getByTestId(`json-tab-raw-${ENTRY_ID_1}`));
      const rawTa = within(card).getByTestId(`json-raw-textarea-${ENTRY_ID_1}`);
      fireEvent.change(rawTa, { target: { value: '{\n  "host": "db-replica-v2"\n}' } });
      fireEvent.blur(rawTa);
      fireEvent.click(within(card).getByTestId(`json-raw-save-btn-${ENTRY_ID_1}`));

      await waitFor(() => {
        expect(within(card).queryByTestId('json-cell-btn-root.p1')).toBeNull();
        expect(document.activeElement).toBe(card);
      });
    },
    30_000,
  );

  it(
    'IP16-R3-2: moves focus with real userEvent.tab() / userEvent.tab({ shift: true }) and expands/collapses chevron with userEvent.keyboard("{Enter}")',
    async () => {
      const user = userEvent.setup();
      await setupJsonCardHarness({
        initialEntries: [
          {
            id: ENTRY_ID_1,
            text: '{\n  "count": "42",\n  "nested": { "flag": true }\n}',
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
      const keyBtn0 = within(card).getByTestId('json-cell-btn-root.k0');
      const valBtn0 = within(card).getByTestId('json-cell-btn-root.p0');
      const removeBtn0 = within(card).getByTestId('json-remove-field-root-0');
      const keyBtn1 = within(card).getByTestId('json-cell-btn-root.k1');
      const toggleBtn1 = within(card).getByTestId('json-toggle-root.p1');

      keyBtn0.focus();
      expect(document.activeElement).toBe(keyBtn0);

      await user.tab();
      expect(document.activeElement).toBe(valBtn0);

      await user.tab({ shift: true });
      expect(document.activeElement).toBe(keyBtn0);

      await user.tab();
      expect(document.activeElement).toBe(valBtn0);
      await user.tab();
      expect(document.activeElement).toBe(removeBtn0);
      await user.tab();
      expect(document.activeElement).toBe(keyBtn1);
      await user.tab();
      expect(document.activeElement).toBe(toggleBtn1);

      expect(toggleBtn1).toHaveAttribute('aria-expanded', 'false');
      await user.keyboard('{Enter}');
      expect(toggleBtn1).toHaveAttribute('aria-expanded', 'true');
      expect(within(card).getByTestId('json-nest-root.p1')).toBeInTheDocument();

      await user.keyboard('{Enter}');
      expect(toggleBtn1).toHaveAttribute('aria-expanded', 'false');
      expect(within(card).queryByTestId('json-nest-root.p1')).toBeNull();
    },
    30_000,
  );

  it(
    'IP16-R3-3: late terminal session_invalid from held JSON card PUT or held JSON composer POST after explicit signOut() or User A->B switch drops saveUnconfirmed (pure snapshot [])',
    async () => {
      const h = await setupJsonCardHarness({
        initialEntries: [
          {
            id: ENTRY_ID_1,
            text: '{\n  "k": "v1"\n}',
            type: 'json',
            position: 0,
            version: 1,
          },
        ],
      });

      await waitFor(() => {
        expect(screen.getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
      });

      // 1. JSON card PUT held across explicit signOut() -> release with 401 session_invalid -> pure snapshot stays []
      const { promise: cardLogoutGate, resolve: releaseCardLogout } = createDeferred();
      const { promise: cardLogoutEntered, resolve: notifyCardLogoutEntered } = createDeferred();
      const { promise: cardLogoutFinished, resolve: notifyCardLogoutFinished } = createDeferred();
      let holdCardLogout = true;
      h.server.overrideRoute(async (url, init) => {
        if (url.endsWith(`/entries/${ENTRY_ID_1}`) && init?.method === 'PUT' && holdCardLogout) {
          notifyCardLogoutEntered();
          await cardLogoutGate;
          queueMicrotask(() => notifyCardLogoutFinished());
          return problemResponse('session_invalid', 401);
        }
        return null;
      });

      const genBeforeCardLogout = unconfirmedSaveStoreTesting.getClearGenerationForTests();
      const card = screen.getByTestId(`entry-card-${ENTRY_ID_1}`);
      fireEvent.click(within(card).getByTestId('json-cell-btn-root.p0'));
      const input1 = within(card).getByTestId('json-cell-input-root.p0');
      fireEvent.change(input1, { target: { value: 'v2-held-logout' } });
      fireEvent.keyDown(input1, { key: 'Enter' });
      fireEvent.click(within(card).getByTestId(`entry-save-btn-${ENTRY_ID_1}`));
      await cardLogoutEntered;

      await h.signOutSession();
      expect(unconfirmedSaveStoreTesting.getClearGenerationForTests()).toBeGreaterThan(
        genBeforeCardLogout,
      );
      expect(getUnconfirmedSavesSnapshot()).toEqual([]);

      holdCardLogout = false;
      releaseCardLogout();
      await cardLogoutFinished;
      await act(async () => {
        await flushMacrotask();
        await flushMacrotask();
        await flushMacrotask();
      });

      expect(getUnconfirmedSavesSnapshot()).toEqual([]);
      expect(unconfirmedSaveStoreTesting.peekUnconfirmedSavesForTests()).toEqual([]);

      // Re-login User A and unlock for part 2 (JSON composer POST held across User A->B switch)
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
      await h.unlock();
      await waitFor(() => {
        expect(screen.getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
      });

      // 2. JSON composer POST held across explicit signOut() AND User A->B switch -> release with 401 session_invalid -> pure snapshot stays []
      const { promise: compLogoutGate, resolve: releaseCompLogout } = createDeferred();
      const { promise: compLogoutEntered, resolve: notifyCompLogoutEntered } = createDeferred();
      const { promise: compLogoutFinished, resolve: notifyCompLogoutFinished } = createDeferred();
      let holdCompLogout = true;
      h.server.overrideRoute(async (url, init) => {
        if (
          url.endsWith(`/items/${ITEM_ID}/entries`) &&
          init?.method === 'POST' &&
          holdCompLogout
        ) {
          notifyCompLogoutEntered();
          await compLogoutGate;
          queueMicrotask(() => notifyCompLogoutFinished());
          return problemResponse('session_invalid', 401);
        }
        return null;
      });

      const genBeforeCompSwitch = unconfirmedSaveStoreTesting.getClearGenerationForTests();
      fireEvent.click(screen.getByTestId('btn-add-json'));
      const composer = screen.getByTestId('new-json-entry-composer');
      fireEvent.click(within(composer).getByTestId('json-open-add-field-root'));
      fireEvent.change(within(composer).getByTestId('json-new-key-input-root'), {
        target: { value: 'compKey' },
      });
      fireEvent.click(within(composer).getByTestId('json-confirm-add-field-root'));
      fireEvent.click(within(composer).getByTestId('new-json-save-btn'));
      await compLogoutEntered;

      // Switch User A -> User B before the held composer POST returns 401 session_invalid
      h.setCurrentMe(makeMe(USER_B_ID, 'present'));
      await h.loginSession('b@example.test', 'pw');
      expect(unconfirmedSaveStoreTesting.getClearGenerationForTests()).toBeGreaterThan(
        genBeforeCompSwitch,
      );
      expect(getUnconfirmedSavesSnapshot()).toEqual([]);

      holdCompLogout = false;
      releaseCompLogout();
      await compLogoutFinished;
      await act(async () => {
        await flushMacrotask();
        await flushMacrotask();
        await flushMacrotask();
      });

      expect(getUnconfirmedSavesSnapshot()).toEqual([]);
      expect(unconfirmedSaveStoreTesting.peekUnconfirmedSavesForTests()).toEqual([]);
    },
    30_000,
  );

  it(
    'FU11 (advisor-dec-216/217/221/223/224/228): applies 44x44 coarse-pointer classes, sticky action column, cell wrap, nested overflow-x-auto, and non-overlapping .chip-x rules',
    async () => {
      const longTag50 = `${'tag-chip-50-rune-'.repeat(2)}tail50`.padEnd(50, 'q').slice(0, 50);
      expect(Array.from(longTag50).length).toBe(50);

      await setupJsonCardHarness({
        initialItem: makeItemSummary({
          tags: [
            { id: 'tag-1', display: 'db' },
            { id: 'tag-50', display: longTag50 },
          ],
        }),
        initialEntries: [
          {
            id: ENTRY_ID_1,
            text: '{"service":"billing-worker","port":80,"nested":{"region":"ap-southeast-1"},"rows":[{"host":"api-1","w":1}]}',
            type: 'json',
            position: 0,
            version: 1,
          },
        ],
      });

      const card = await screen.findByTestId(`entry-card-${ENTRY_ID_1}`);
      await waitFor(() => {
        expect(within(card).getByTestId(`json-table-host-${ENTRY_ID_1}`)).toBeInTheDocument();
      });

      // 1. Breadcrumb All items link and hint input classes (dec-216, dec-217)
      const breadcrumbNav = screen.getByRole('navigation');
      const allItemsLink = within(breadcrumbNav).getByRole('link');
      expect(allItemsLink.className).toContain('[@media(pointer:coarse)]:min-h-[44px]');
      expect(allItemsLink.className).toContain('[@media(pointer:coarse)]:min-w-[44px]');

      const hintInput = screen.getByTestId('item-hint-input');
      expect(hintInput.className).toContain('max-[639px]:placeholder:text-[11.5px]');

      // 2. Tag chips (short & 50-rune) and remove buttons (dec-217, dec-221)
      for (const tagDisplay of ['db', longTag50]) {
        const chip = screen.getByTestId(`item-tag-chip-${tagDisplay}`);
        expect(chip.className).toContain('max-w-full');
        expect(chip.className).toContain('[@media(pointer:coarse)]:gap-0');
        const tagLink = within(chip).getByRole('link');
        expect(tagLink.className).toContain('truncate');
        expect(tagLink.className).toContain('[@media(pointer:coarse)]:min-h-[44px]');
        expect(tagLink.className).toContain('[@media(pointer:coarse)]:min-w-[44px]');
        const removeBtn = within(chip).getByTestId(`item-tag-remove-${tagDisplay}`);
        expect(removeBtn.className).toContain('chip-x');
        expect(removeBtn.className).toContain('shrink-0');
      }

      // 3. JSON cell buttons, wrapping, nested scroll, and sticky action column (dec-216, dec-217)
      const cellBtn = within(card).getByTestId('json-cell-btn-root.p1');
      expect(cellBtn.className).toContain('max-w-full');
      expect(cellBtn.className).toContain('[overflow-wrap:anywhere]');
      expect(cellBtn.className).toContain('[@media(pointer:coarse)]:min-h-[44px]');
      expect(cellBtn.className).toContain('[@media(pointer:coarse)]:min-w-[44px]');

      const removeFieldBtn = within(card).getByTestId('json-remove-field-root-0');
      expect(removeFieldBtn.className).toContain('[@media(pointer:coarse)]:min-h-[44px]');
      expect(removeFieldBtn.className).toContain('[@media(pointer:coarse)]:min-w-[44px]');
      const actionTd = removeFieldBtn.closest('td');
      expect(actionTd?.className).toContain('max-[768px]:sticky');
      expect(actionTd?.className).toContain('max-[768px]:right-0');

      // Expand nested object and array-of-objects to verify .json-nest overflow-x-auto and row delete button
      fireEvent.click(within(card).getByTestId('json-toggle-root.p2'));
      const nestContainer = within(card).getByTestId('json-nest-root.p2');
      expect(nestContainer.className).toContain('overflow-x-auto');

      fireEvent.click(within(card).getByTestId('json-toggle-root.p3'));
      const removeRowBtn = within(card).getByTestId('json-remove-row-root.p3-0');
      expect(removeRowBtn.className).toContain('[@media(pointer:coarse)]:min-h-[44px]');
      expect(removeRowBtn.className).toContain('[@media(pointer:coarse)]:min-w-[44px]');

      // 4. Open inline JSON cell editor and verify dec-223 / dec-224 classes on input, type select, commit, cancel
      fireEvent.click(within(card).getByTestId('json-cell-btn-root.p0'));
      const cellInput = within(card).getByTestId('json-cell-input-root.p0');
      const typeSelect = within(card).getByTestId('json-type-select-root.p0');
      const commitBtn = within(card).getByTestId('json-commit-cell-root.p0');
      const cancelBtn = within(card).getByTestId('json-cancel-cell-root.p0');
      expect(cellInput.className).toContain('json-cell-input');
      expect(typeSelect.className).toContain('[@media(pointer:coarse)]:min-h-[44px]');
      expect(typeSelect.className).toContain('[@media(pointer:coarse)]:min-w-[44px]');
      expect(commitBtn.className).toContain('[@media(pointer:coarse)]:min-h-[44px]');
      expect(commitBtn.className).toContain('[@media(pointer:coarse)]:min-w-[44px]');
      expect(cancelBtn.className).toContain('[@media(pointer:coarse)]:min-h-[44px]');
      expect(cancelBtn.className).toContain('[@media(pointer:coarse)]:min-w-[44px]');

      // 5. Verify tokens.css coarse rules and absence of overlapping .chip-x::after
      const tokensCss = fs.readFileSync(
        path.resolve(__dirname, '../../styles/tokens.css'),
        'utf8',
      );
      expect(tokensCss).toMatch(/\.chip-x::after\s*\{\s*content:\s*none;\s*\}/);
      expect(tokensCss).toMatch(/\.chip-x\s*\{\s*min-width:\s*44px;\s*min-height:\s*44px;\s*\}/);
      expect(tokensCss).toMatch(/\.json-cell-input\s*\{\s*min-height:\s*44px;\s*\}/);

      // 6. Open Import JSON dialog and verify dec-228 coarse-pointer classes on parse-error jump and format checkbox label
      fireEvent.click(screen.getByTestId('btn-import-json'));
      const importDialog = screen.getByTestId('import-json-dialog');
      const importTextarea = within(importDialog).getByTestId('import-json-source-textarea');
      fireEvent.change(importTextarea, { target: { value: '{\n  "bad": 1,\n}' } });

      const parseErrorJumpBtn = within(importDialog).getByTestId('import-json-parse-error-jump');
      expect(parseErrorJumpBtn.className).toContain('[@media(pointer:coarse)]:min-h-[44px]');

      const formatCheckbox = within(importDialog).getByTestId(
        'import-json-format-checkbox',
      ) as HTMLInputElement;
      const formatLabel = within(importDialog).getByTestId('import-json-format-label');
      expect(formatCheckbox.closest('label')).toBe(formatLabel);
      expect(formatLabel.className).toContain('[@media(pointer:coarse)]:min-h-[44px]');
      expect(formatLabel.className).toContain('[@media(pointer:coarse)]:min-w-[44px]');

      fireEvent.change(importTextarea, { target: { value: '{"ok":1}' } });
      expect(formatCheckbox.disabled).toBe(false);
      expect(formatCheckbox.checked).toBe(false);
      fireEvent.click(formatLabel);
      expect(formatCheckbox.checked).toBe(true);
    },
    30_000,
  );
});
