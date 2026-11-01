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
import { useState, type ReactNode } from 'react';
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
  clearAllChangesSyncState,
  hasActiveContentEntriesQuery,
} from '@/features/entries/changes-sync';
import { assertNoPlaintextAttrs } from '@/features/entries/test-utils/assert-no-plaintext-attrs';
import { ItemDetailPage } from '@/features/items/item-detail-page';
import {
  JsonTreeGrid,
  __testing as jsonTableTesting,
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
  EntryChange,
  EntryCreateRequest,
  EntryChangesPage,
  EntryMeta,
  EntryUpdateRequest,
  ItemSummary,
  Tag,
} from '@/lib/api/content';
import { __testing as userChangedTesting } from '@/lib/auth/user-changed';
import type { CreateVaultResult } from '@/lib/crypto/client';
import { KEK_BYTES, type DeriveKekFn, type ValidatedKdfParams } from '@/lib/crypto/kdf';
import type { Sodium } from '@/lib/crypto/sodium';
import { createWorkerShim } from '@/lib/crypto/test/worker-shim';
import { parseJsonStrict, type JsonEditOutcome } from '@/lib/json';
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

const PASSPHRASE = 'task20-json-cell-draft-passphrase-1';
const KEY_ID_1 = 'vk:7f3a91c4e0b2d8a1f5c309';
const ITEM_ID = '11111111-1111-4111-8111-111111111111';
const ENTRY_ID_JSON = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_A_ID = '33333333-3333-4333-8333-333333333333';

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
  let marker = { epochIncarnation: 'inc-task20-r8c-1', lockEpoch: 1 };
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
    name: 'wifi-sync-r8c',
    hint: 'json cell draft retention test',
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
    type: overrides.type ?? 'json',
    position: overrides.position ?? 0,
    version: overrides.version ?? 1,
    plaintext_len_bucket: overrides.plaintext_len_bucket ?? 256,
    created_at: overrides.created_at ?? '2026-11-01T10:00:00Z',
    updated_at: overrides.updated_at ?? '2026-11-01T10:00:00Z',
    deleted_at: overrides.deleted_at ?? null,
  };
}

describe('P04-T20 SYNC-BER1-5 (advisor-dec-220): uncommitted JSON-cell draft retention and lock wipe', () => {
  const shims: Array<{ close: () => void }> = [];
  let originalClipboardDesc: PropertyDescriptor | undefined;

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
    jsonTableTesting.setJsonEditorPlaintextHolderForTests(null);
    originalClipboardDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
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
    jsonTableTesting.setJsonEditorPlaintextHolderForTests(null);
    if (originalClipboardDesc) {
      Object.defineProperty(navigator, 'clipboard', originalClipboardDesc);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
    vi.restoreAllMocks();
  });

  async function setupJsonRetentionHarness(initialJsonText = '{"key":"initial_json"}') {
    const locale = 'vi';
    let vaultCtx!: VaultContextValue;

    function Probe() {
      vaultCtx = useVault();
      const sess = useSession();
      return (
        <>
          <output data-testid="vault-state-probe">{vaultCtx.state}</output>
          <output data-testid="session-status-probe">{sess.status}</output>
        </>
      );
    }

    let createdVault: CreateVaultResult | null = null;
    const currentMe: Me = makeMe(USER_A_ID, 'present');
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

    const createPosts: EntryCreateRequest[] = [];
    const updatePuts: Array<{ ifMatch: string | null; req: EntryUpdateRequest }> = [];
    let putConflict = false;

    let changesHandler: (params: URLSearchParams) => Promise<Response> | Response = () =>
      jsonResponse({
        changes: [],
        next_cursor: null,
        watermark: '2026-11-01T12:00:00Z',
      } satisfies EntryChangesPage);

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
      const parsedUrl = new URL(url, 'http://localhost');

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
        return jsonResponse(currentMe);
      }
      if (parsedUrl.pathname.endsWith('/vault')) {
        if (!createdVault) {
          return problemResponse('vault_absent', 404);
        }
        return jsonResponse(makeVaultGetResponse(createdVault, KEY_ID_1, 1));
      }
      if (parsedUrl.pathname === '/api/v1/entries/changes' && method === 'GET') {
        return changesHandler(parsedUrl.searchParams);
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
      if (parsedUrl.pathname === `/api/v1/items/${ITEM_ID}/entries` && method === 'GET') {
        return jsonResponse({
          items: liveEntryMetas(),
          next_cursor: null,
        });
      }

      if (parsedUrl.pathname === `/api/v1/items/${ITEM_ID}/entries` && method === 'POST') {
        const req = JSON.parse(String(init?.body ?? '{}')) as EntryCreateRequest;
        createPosts.push(req);
        const created: Entry = {
          id: req.id,
          item_id: ITEM_ID,
          type: req.type,
          position: 1,
          version: 1,
          plaintext_len_bucket: req.plaintext_len_bucket,
          envelope: req.envelope,
          ciphertext: req.ciphertext,
          created_at: '2026-11-01T12:20:00Z',
          updated_at: '2026-11-01T12:20:00Z',
        };
        entriesMap.set(created.id, created);
        return jsonResponse(toEntryMeta(created), 201);
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
          const reqHeaders = new Headers(init?.headers);
          const req = JSON.parse(String(init?.body ?? '{}')) as EntryUpdateRequest;
          updatePuts.push({ ifMatch: reqHeaders.get('if-match'), req });
          if (putConflict) {
            return problemResponse('version_mismatch', 412, { current_version: rec.version + 1 });
          }
          rec.envelope = req.envelope;
          rec.ciphertext = req.ciphertext;
          rec.plaintext_len_bucket = req.plaintext_len_bucket;
          rec.version += 1;
          return jsonResponse(toEntryMeta(rec), 200);
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

    const sealOp = vaultCtx.beginOp();
    const sealed = await sealOp.client.sealEntry({
      entryId: ENTRY_ID_JSON,
      keyId: KEY_ID_1,
      plaintext: initialJsonText,
      opGeneration: sealOp.opGeneration,
    });
    const bytes = new TextEncoder().encode(initialJsonText).byteLength;
    const bucket = Math.max(256, Math.ceil(bytes / 256) * 256);
    entriesMap.set(ENTRY_ID_JSON, {
      id: ENTRY_ID_JSON,
      item_id: ITEM_ID,
      type: 'json',
      position: 0,
      version: 1,
      plaintext_len_bucket: bucket,
      envelope: sealed.envelope,
      ciphertext: sealed.ciphertext,
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-01T00:00:00Z',
    });

    rendered.rerender(
      buildTree(
        <>
          <ContentChangesSync />
          <ItemDetailPage itemId={ITEM_ID} lazyCards={false} />
        </>,
      ),
    );

    await waitFor(() => {
      expect(hasActiveContentEntriesQuery(qc)).toBe(true);
      expect(screen.getByTestId(`entry-card-${ENTRY_ID_JSON}`)).toBeInTheDocument();
      expect(screen.getByTestId(`json-table-host-${ENTRY_ID_JSON}`)).toBeInTheDocument();
    });

    return {
      container: rendered.container,
      qc,
      entriesMap,
      createPosts,
      updatePuts,
      setPutConflict: (value: boolean) => {
        putConflict = value;
      },
      openUpdatedPlaintext: async (req: EntryUpdateRequest): Promise<string> => {
        const op = vaultCtx.beginOp();
        const opened = await op.client.openEntry({
          entryId: ENTRY_ID_JSON,
          envelope: req.envelope,
          ciphertext: req.ciphertext,
          opGeneration: op.opGeneration,
        });
        return opened.plaintext;
      },
      openCreatedPlaintext: async (req: EntryCreateRequest): Promise<string> => {
        const op = vaultCtx.beginOp();
        const opened = await op.client.openEntry({
          entryId: req.id,
          envelope: req.envelope,
          ciphertext: req.ciphertext,
          opGeneration: op.opGeneration,
        });
        return opened.plaintext;
      },
      setChangesHandler: (fn: (params: URLSearchParams) => Promise<Response> | Response) => {
        changesHandler = fn;
      },
      lock: async () => {
        await act(async () => {
          await vaultCtx.lockNow();
        });
        await waitFor(() => expect(vaultCtx.state).toBe('locked'));
      },
    };
  }

  it('retains a JSON card with an uncommitted inline cell draft across a remote tombstone and shows the deleted-remotely banner/actions', async () => {
    const UNCOMMITTED_CELL_SENTINEL = 'UNCOMMITTED_JSON_CELL_DRAFT_SECRET_7701';
    const jsonHolderRef: { current: EditorPlaintextHolder } = {
      current: {
        originalSource: '',
        draftValue: '',
        submittedCandidateSource: '',
        tableSource: '',
      },
    };
    jsonTableTesting.setJsonEditorPlaintextHolderForTests(jsonHolderRef);

    const h = await setupJsonRetentionHarness('{"key":"initial_json"}');

    const jsonCard = screen.getByTestId(`entry-card-${ENTRY_ID_JSON}`);
    fireEvent.click(within(jsonCard).getByTestId('json-cell-btn-root.p0'));
    const jsonInput = within(jsonCard).getByTestId('json-cell-input-root.p0') as HTMLInputElement;

    // Type WITHOUT pressing Enter or blurring — tableSource remains clean ('{"key":"initial_json"}')
    fireEvent.change(jsonInput, { target: { value: UNCOMMITTED_CELL_SENTINEL } });
    expect(jsonInput.value).toBe(UNCOMMITTED_CELL_SENTINEL);
    expect(jsonHolderRef.current.tableSource).toBe('{"key":"initial_json"}');

    // Remote device deletes the JSON entry; online wake publishes the tombstone and drops it from the canonical list
    h.entriesMap.get(ENTRY_ID_JSON)!.deleted = true;
    h.setChangesHandler(() =>
      jsonResponse({
        changes: [
          makeEntryChange({
            id: ENTRY_ID_JSON,
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

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => {
      expect(screen.getByTestId(`entry-card-${ENTRY_ID_JSON}`)).toBeInTheDocument();
      expect(screen.getByTestId(`entry-deleted-remotely-${ENTRY_ID_JSON}`)).toBeInTheDocument();
      expect(screen.getByTestId(`entry-save-as-new-${ENTRY_ID_JSON}`)).toBeEnabled();
    });

    const retainedInput = screen.getByTestId('json-cell-input-root.p0') as HTMLInputElement;
    expect(retainedInput.value).toBe(UNCOMMITTED_CELL_SENTINEL);
    assertNoPlaintextAttrs(h.container, [UNCOMMITTED_CELL_SENTINEL]);
  });

  it('Save as new entry flushes a pending cell edit first: an invalid pending number posts nothing and keeps the draft, a corrected cell seals the corrected source (SYNC-BER2-1)', async () => {
    const jsonHolderRef: { current: EditorPlaintextHolder } = {
      current: {
        originalSource: '',
        draftValue: '',
        submittedCandidateSource: '',
        tableSource: '',
      },
    };
    jsonTableTesting.setJsonEditorPlaintextHolderForTests(jsonHolderRef);

    const h = await setupJsonRetentionHarness('{"n":1}');

    const jsonCard = screen.getByTestId(`entry-card-${ENTRY_ID_JSON}`);
    fireEvent.click(within(jsonCard).getByTestId('json-cell-btn-root.p0'));
    const pendingInput = within(jsonCard).getByTestId('json-cell-input-root.p0') as HTMLInputElement;
    // Incomplete number: not committed, the holder still carries the valid old source.
    fireEvent.change(pendingInput, { target: { value: '-' } });
    expect(pendingInput.value).toBe('-');
    expect(jsonHolderRef.current.tableSource).toBe('{"n":1}');

    h.entriesMap.get(ENTRY_ID_JSON)!.deleted = true;
    h.setChangesHandler(() =>
      jsonResponse({
        changes: [
          makeEntryChange({
            id: ENTRY_ID_JSON,
            item_id: ITEM_ID,
            type: 'json',
            version: 1,
            updated_at: '2026-11-01T12:30:00Z',
            deleted_at: '2026-11-01T12:30:00Z',
          }),
        ],
        next_cursor: null,
        watermark: '2026-11-01T12:31:00Z',
      } satisfies EntryChangesPage),
    );
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => {
      expect(screen.getByTestId(`entry-deleted-remotely-${ENTRY_ID_JSON}`)).toBeInTheDocument();
      expect(screen.getByTestId(`entry-save-as-new-${ENTRY_ID_JSON}`)).toBeEnabled();
    });

    // Invalid pending number: the flush fails, so no POST, the grid error shows, the draft stays.
    fireEvent.click(screen.getByTestId(`entry-save-as-new-${ENTRY_ID_JSON}`));
    await waitFor(() => {
      expect(screen.getByTestId('json-cell-error-root.p0')).toBeInTheDocument();
    });
    expect(h.createPosts).toHaveLength(0);
    const stillPending = screen.getByTestId('json-cell-input-root.p0') as HTMLInputElement;
    expect(stillPending.value).toBe('-');
    expect(screen.getByTestId(`entry-card-${ENTRY_ID_JSON}`)).toBeInTheDocument();
    expect(screen.getByTestId(`entry-save-as-new-${ENTRY_ID_JSON}`)).toBeEnabled();

    // Correct the cell: the flush applies it and exactly one POST seals the corrected source.
    fireEvent.change(stillPending, { target: { value: '2' } });
    fireEvent.click(screen.getByTestId(`entry-save-as-new-${ENTRY_ID_JSON}`));
    await waitFor(() => {
      expect(h.createPosts).toHaveLength(1);
    });
    const created = h.createPosts[0]!;
    expect(created.type).toBe('json');
    expect(await h.openCreatedPlaintext(created)).toBe('{"n":2}');
  });

  // SYNC-BER3-1 helpers: reach a 412 conflict panel, then leave an incomplete number pending.
  async function enter412WithPendingDash(
    h: Awaited<ReturnType<typeof setupJsonRetentionHarness>>,
  ) {
    h.setPutConflict(true);
    const card = screen.getByTestId(`entry-card-${ENTRY_ID_JSON}`);
    fireEvent.click(within(card).getByTestId('json-cell-btn-root.p0'));
    const editInput = within(card).getByTestId('json-cell-input-root.p0') as HTMLInputElement;
    fireEvent.change(editInput, { target: { value: '5' } });
    fireEvent.keyDown(editInput, { key: 'Enter' });
    fireEvent.click(screen.getByTestId(`entry-save-btn-${ENTRY_ID_JSON}`));
    await waitFor(() => {
      expect(screen.getByTestId(`entry-conflict-box-${ENTRY_ID_JSON}`)).toBeInTheDocument();
      expect(h.updatePuts).toHaveLength(1);
    });
    h.setPutConflict(false);
    fireEvent.click(within(card).getByTestId('json-cell-btn-root.p0'));
    const pending = within(card).getByTestId('json-cell-input-root.p0') as HTMLInputElement;
    // Incomplete number: not committed, the holder still carries the prior valid source.
    fireEvent.change(pending, { target: { value: '-' } });
    expect(pending.value).toBe('-');
    return pending;
  }

  function installClipboardMock() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    return writeText;
  }

  function expectNoCopiedMineAnnouncement() {
    expect(screen.getByTestId('item-page-live-region')).not.toHaveTextContent(
      viMessages.content.entry.copiedMine,
    );
  }

  it('412 Keep mine flushes a pending cell edit first: an invalid number sends no PUT and keeps the draft, a corrected cell seals the corrected source (SYNC-BER3-1)', async () => {
    const h = await setupJsonRetentionHarness('{"n":1}');
    const pending = await enter412WithPendingDash(h);

    fireEvent.click(screen.getByTestId(`entry-conflict-keep-mine-${ENTRY_ID_JSON}`));
    await waitFor(() => {
      expect(screen.getByTestId('json-cell-error-root.p0')).toBeInTheDocument();
    });
    await act(async () => {});
    expect(h.updatePuts).toHaveLength(1);
    expect((screen.getByTestId('json-cell-input-root.p0') as HTMLInputElement).value).toBe('-');
    expect(screen.getByTestId(`entry-conflict-box-${ENTRY_ID_JSON}`)).toBeInTheDocument();
    expect(screen.getByTestId(`entry-conflict-keep-mine-${ENTRY_ID_JSON}`)).toBeEnabled();

    fireEvent.change(pending, { target: { value: '2' } });
    fireEvent.click(screen.getByTestId(`entry-conflict-keep-mine-${ENTRY_ID_JSON}`));
    await waitFor(() => {
      expect(h.updatePuts).toHaveLength(2);
    });
    expect(await h.openUpdatedPlaintext(h.updatePuts[1]!.req)).toBe('{"n":2}');
  });

  it('412 Copy mine flushes a pending cell edit first: an invalid number copies and announces nothing, a corrected cell copies the corrected source (SYNC-BER3-1)', async () => {
    const writeText = installClipboardMock();
    const h = await setupJsonRetentionHarness('{"n":1}');
    const pending = await enter412WithPendingDash(h);

    fireEvent.click(screen.getByTestId(`entry-conflict-copy-mine-${ENTRY_ID_JSON}`));
    await waitFor(() => {
      expect(screen.getByTestId('json-cell-error-root.p0')).toBeInTheDocument();
    });
    await act(async () => {});
    expect(writeText).not.toHaveBeenCalled();
    expectNoCopiedMineAnnouncement();
    expect((screen.getByTestId('json-cell-input-root.p0') as HTMLInputElement).value).toBe('-');
    expect(screen.getByTestId(`entry-conflict-box-${ENTRY_ID_JSON}`)).toBeInTheDocument();

    fireEvent.change(pending, { target: { value: '2' } });
    fireEvent.click(screen.getByTestId(`entry-conflict-copy-mine-${ENTRY_ID_JSON}`));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    expect(writeText).toHaveBeenLastCalledWith('{"n":2}');
    await waitFor(() => {
      expect(screen.getByTestId('item-page-live-region')).toHaveTextContent(
        viMessages.content.entry.copiedMine,
      );
    });
    expect(h.updatePuts).toHaveLength(1);
  });

  it('412 Copy mine on a card retained by a remote tombstone still flushes a pending cell edit first (SYNC-BER3-1)', async () => {
    const writeText = installClipboardMock();
    const h = await setupJsonRetentionHarness('{"n":1}');
    const pending = await enter412WithPendingDash(h);

    h.entriesMap.get(ENTRY_ID_JSON)!.deleted = true;
    h.setChangesHandler(() =>
      jsonResponse({
        changes: [
          makeEntryChange({
            id: ENTRY_ID_JSON,
            item_id: ITEM_ID,
            type: 'json',
            version: 1,
            updated_at: '2026-11-01T12:40:00Z',
            deleted_at: '2026-11-01T12:40:00Z',
          }),
        ],
        next_cursor: null,
        watermark: '2026-11-01T12:41:00Z',
      } satisfies EntryChangesPage),
    );
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => {
      expect(screen.getByTestId(`entry-deleted-remotely-${ENTRY_ID_JSON}`)).toBeInTheDocument();
      expect(screen.getByTestId(`entry-conflict-box-${ENTRY_ID_JSON}`)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId(`entry-conflict-copy-mine-${ENTRY_ID_JSON}`));
    await waitFor(() => {
      expect(screen.getByTestId('json-cell-error-root.p0')).toBeInTheDocument();
    });
    await act(async () => {});
    expect(writeText).not.toHaveBeenCalled();
    expectNoCopiedMineAnnouncement();
    expect((screen.getByTestId('json-cell-input-root.p0') as HTMLInputElement).value).toBe('-');
    expect(screen.getByTestId(`entry-card-${ENTRY_ID_JSON}`)).toBeInTheDocument();

    fireEvent.change(pending, { target: { value: '2' } });
    fireEvent.click(screen.getByTestId(`entry-conflict-copy-mine-${ENTRY_ID_JSON}`));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    expect(writeText).toHaveBeenLastCalledWith('{"n":2}');
  });

  it('wipes the uncommitted cell input value and grid draft and drops the retained card when the vault locks', async () => {
    const LOCK_WIPE_CELL_SENTINEL = 'LOCK_WIPE_JSON_CELL_DRAFT_SECRET_7702';
    const INITIAL_VALUE_SENTINEL = 'INITIAL_JSON_CELL_SECRET_7703';
    const jsonHolderRef: { current: EditorPlaintextHolder } = {
      current: {
        originalSource: '',
        draftValue: '',
        submittedCandidateSource: '',
        tableSource: '',
      },
    };
    jsonTableTesting.setJsonEditorPlaintextHolderForTests(jsonHolderRef);

    const h = await setupJsonRetentionHarness(`{"key":"${INITIAL_VALUE_SENTINEL}"}`);

    const jsonCard = screen.getByTestId(`entry-card-${ENTRY_ID_JSON}`);
    fireEvent.click(within(jsonCard).getByTestId('json-cell-btn-root.p0'));
    const jsonInput = within(jsonCard).getByTestId('json-cell-input-root.p0') as HTMLInputElement;
    fireEvent.change(jsonInput, { target: { value: LOCK_WIPE_CELL_SENTINEL } });
    expect(jsonInput.value).toBe(LOCK_WIPE_CELL_SENTINEL);

    h.entriesMap.get(ENTRY_ID_JSON)!.deleted = true;
    h.setChangesHandler(() =>
      jsonResponse({
        changes: [
          makeEntryChange({
            id: ENTRY_ID_JSON,
            item_id: ITEM_ID,
            type: 'json',
            version: 1,
            updated_at: '2026-11-01T12:15:00Z',
            deleted_at: '2026-11-01T12:15:00Z',
          }),
        ],
        next_cursor: null,
        watermark: '2026-11-01T12:16:00Z',
      } satisfies EntryChangesPage),
    );

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => {
      expect(screen.getByTestId(`entry-deleted-remotely-${ENTRY_ID_JSON}`)).toBeInTheDocument();
    });
    expect(jsonInput.value).toBe(LOCK_WIPE_CELL_SENTINEL);

    // Lock the vault while the card is retained with an open inline cell editor
    await h.lock();

    expect(jsonInput.value).toBe('');
    expect(jsonHolderRef.current).toEqual({
      originalSource: '',
      draftValue: '',
      submittedCandidateSource: '',
      tableSource: '',
    });
    expect(screen.queryByTestId('json-cell-input-root.p0')).toBeNull();
    expect(h.container.textContent).not.toContain(LOCK_WIPE_CELL_SENTINEL);
    expect(h.container.textContent).not.toContain(INITIAL_VALUE_SENTINEL);
    assertNoPlaintextAttrs(h.container, [LOCK_WIPE_CELL_SENTINEL, INITIAL_VALUE_SENTINEL]);

    await waitFor(() => {
      expect(screen.queryByTestId(`entry-card-${ENTRY_ID_JSON}`)).toBeNull();
    });
  });

  it('invokes onCellEditActiveChange strictly with a single boolean argument across open, typing, cancel, commit, resetEpoch, and unmount', () => {
    const CALLBACK_DRAFT_SENTINEL = 'CALLBACK_ONLY_BOOLEAN_SECRET_7704';
    const onCellEditActiveChange = vi.fn<(active: boolean) => void>();

    function GridHarness({ resetEpoch }: { readonly resetEpoch: number }) {
      const [source, setSource] = useState('{"alpha":"initial","beta":"second"}');
      const parsed = parseJsonStrict(source);
      const doc = parsed.ok ? parsed.document : null;
      return (
        <NextIntlClientProvider locale="en" messages={en}>
          <JsonTreeGrid
            entryId={ENTRY_ID_JSON}
            document={doc}
            expandedPaths={new Set()}
            pageByPath={new Map()}
            onToggleExpand={() => {}}
            onPageChange={() => {}}
            onApplyEdit={(outcome: JsonEditOutcome & { readonly ok: true }) => {
              setSource(outcome.source);
              return true;
            }}
            onCellEditActiveChange={onCellEditActiveChange}
            resetEpoch={resetEpoch}
          />
        </NextIntlClientProvider>
      );
    }

    const rendered = render(<GridHarness resetEpoch={0} />);
    expect(onCellEditActiveChange).not.toHaveBeenCalled();

    // 1. Open inline cell editor -> called with (true); typing does not leak draft text or extra calls
    fireEvent.click(screen.getByTestId('json-cell-btn-root.p0'));
    expect(onCellEditActiveChange).toHaveBeenCalledTimes(1);
    expect(onCellEditActiveChange).toHaveBeenLastCalledWith(true);

    const input1 = screen.getByTestId('json-cell-input-root.p0') as HTMLInputElement;
    fireEvent.change(input1, { target: { value: CALLBACK_DRAFT_SENTINEL } });
    expect(onCellEditActiveChange).toHaveBeenCalledTimes(1);

    // 2. Cancel with Escape -> called with (false)
    fireEvent.keyDown(input1, { key: 'Escape' });
    expect(onCellEditActiveChange).toHaveBeenCalledTimes(2);
    expect(onCellEditActiveChange).toHaveBeenLastCalledWith(false);

    // 3. Re-open and commit with Enter -> (true) then (false)
    fireEvent.click(screen.getByTestId('json-cell-btn-root.p0'));
    expect(onCellEditActiveChange).toHaveBeenCalledTimes(3);
    expect(onCellEditActiveChange).toHaveBeenLastCalledWith(true);

    const input2 = screen.getByTestId('json-cell-input-root.p0') as HTMLInputElement;
    fireEvent.change(input2, { target: { value: `${CALLBACK_DRAFT_SENTINEL}_2` } });
    fireEvent.keyDown(input2, { key: 'Enter' });
    expect(onCellEditActiveChange).toHaveBeenCalledTimes(4);
    expect(onCellEditActiveChange).toHaveBeenLastCalledWith(false);

    // 4. Re-open and bump resetEpoch (lock wipe) -> (true) then (false)
    fireEvent.click(screen.getByTestId('json-cell-btn-root.p0'));
    expect(onCellEditActiveChange).toHaveBeenCalledTimes(5);
    expect(onCellEditActiveChange).toHaveBeenLastCalledWith(true);

    rendered.rerender(<GridHarness resetEpoch={1} />);
    expect(onCellEditActiveChange).toHaveBeenCalledTimes(6);
    expect(onCellEditActiveChange).toHaveBeenLastCalledWith(false);

    // 5. Re-open and unmount -> (true) then (false)
    fireEvent.click(screen.getByTestId('json-cell-btn-root.p0'));
    expect(onCellEditActiveChange).toHaveBeenCalledTimes(7);
    expect(onCellEditActiveChange).toHaveBeenLastCalledWith(true);

    rendered.unmount();
    expect(onCellEditActiveChange).toHaveBeenCalledTimes(8);
    expect(onCellEditActiveChange).toHaveBeenLastCalledWith(false);

    for (const call of onCellEditActiveChange.mock.calls) {
      expect(call).toHaveLength(1);
      expect(typeof call[0]).toBe('boolean');
      expect(call[0] === true || call[0] === false).toBe(true);
    }
  });
});
