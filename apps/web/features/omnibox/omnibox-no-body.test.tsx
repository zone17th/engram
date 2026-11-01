import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Omnibox } from '@/components/app-shell/omnibox';
import { UndoToastProvider } from '@/components/ui/undo-toast';
import { SessionProvider } from '@/features/auth/session-provider';
import { assertVaultSecretElementAttributes } from '@/features/entries/secret-input-props';
import { assertNoPlaintextAttrs } from '@/features/entries/test-utils/assert-no-plaintext-attrs';
import { EntryBody, type EntryBodyLoader } from '@/features/items/entry-body';
import { ItemList, type ItemListEntry } from '@/features/items/item-list';
import { contentQueryKeys } from '@/features/items/query-keys';
import { normalizeForPrefixMatch } from '@/features/omnibox/search-helpers';
import {
  VAULT_BODY_QUERY_KEY_PREFIX,
  VaultProvider,
  resetVaultBroadcastForTests,
  useVault,
  type LockEpochEnvironment,
  type VaultContextValue,
} from '@/features/vault';
import type { Me } from '@/lib/api/auth';
import * as contentApi from '@/lib/api/content';
import type { ItemSummary, Tag } from '@/lib/api/content';
import type { CreateVaultResult } from '@/lib/crypto/client';
import { KEK_BYTES, type DeriveKekFn, type ValidatedKdfParams } from '@/lib/crypto/kdf';
import type { Sodium } from '@/lib/crypto/sodium';
import { createWorkerShim, type ShimmedWorkerInstance } from '@/lib/crypto/test/worker-shim';
import { DEMO_ITEMS } from '@/lib/demo-fixtures';
import en from '@/messages/en.json';

/**
 * Replacement for P03 `FE1-2: the Omnibox never shows or matches body previews unless the vault is unlocked`
 * (advisor-dec-191, plan §7 line 638).
 *
 * Stronger P04 invariant: the Omnibox NEVER shows or matches entry body previews in ANY vault state
 * (locked, unlocked, unlocking, error, or outside a VaultProvider), and locking the vault immediately
 * clears the Omnibox input, closes its listbox, clears the live region, and purges search query keys.
 */

const routerMocks = vi.hoisted(() => {
  const replace = vi.fn();
  const push = vi.fn();
  return { pathname: '/app', replace, push, router: { replace, push } };
});

vi.mock('next/navigation', () => ({
  usePathname: () => routerMocks.pathname,
  useRouter: () => routerMocks.router,
  useSearchParams: () => new URLSearchParams(),
}));

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
  let marker = { epochIncarnation: 'inc-omni-test-1', lockEpoch: 1 };
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

const PASSPHRASE = 'locked-state-fixture-passphrase-1';
const KEY_ID = 'vk:7f3a91c4e0b2d8a1f5c309';

const FIXTURE_ITEMS: ReadonlyArray<ItemListEntry & { secret: string }> = [
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: 'Router wifi',
    kind: 'text',
    tags: ['home', 'ops'],
    secret: 'FIXTURE-BODY-ALPHA ssid zone17 pass tr4m-ngh1n',
  },
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    title: 'Server config',
    kind: 'json',
    tags: ['config'],
    secret: '{"FIXTURE_BODY_BRAVO":"token-8841"}',
  },
];
const SECRET_FRAGMENTS = ['FIXTURE-BODY-ALPHA', 'tr4m-ngh1n', 'FIXTURE_BODY_BRAVO', 'token-8841'];

const D1 = DEMO_ITEMS[0]!; // title "Cà phê sữa đá tỉ lệ 1:2"; its preview contains "phin" and nowhere else.
const DEMO_BODIES = DEMO_ITEMS.map((item) => item.preview);

const MOCKED_API_ITEMS: ItemSummary[] = DEMO_ITEMS.map((item, idx) => ({
  id: item.id,
  name: item.title,
  hint: null,
  tags: item.tags.map((tag, tagIdx) => ({
    id: `tag-${idx}-${tagIdx}`,
    display: tag,
  })),
  entry_count: 1,
  version: 1,
  created_at: '2026-10-30T00:00:00Z',
  updated_at: '2026-10-30T00:00:00Z',
  last_used_at: '2026-10-30T00:00:00Z',
}));

const MOCKED_API_TAGS: Tag[] = [
  {
    id: 'tag-cong-thuc',
    display: 'công-thức',
    item_count: 2,
    last_used_at: '2026-10-30T00:00:00Z',
    created_at: '2026-10-30T00:00:00Z',
  },
  {
    id: 'tag-ghi-chu',
    display: 'ghi-chú',
    item_count: 3,
    last_used_at: '2026-10-30T00:00:00Z',
    created_at: '2026-10-30T00:00:00Z',
  },
];

function makeMe(): Me {
  return {
    user: {
      id: '33333333-3333-4333-8333-333333333333',
      email: 'locked-state@example.test',
      email_verified: true,
      created_at: '2026-10-30T00:00:00Z',
    },
    settings: { locale: 'en', theme: 'light', auto_lock_minutes: 15, semantic_suggest: false },
    identities: [{ provider: 'password', linked_at: '2026-10-30T00:00:00Z' }],
    features: {
      semantic_available: false,
      email_verification_required: false,
      oauth_providers: [],
      oauth_reauth_providers: [],
      password_enrollment_available: false,
      captcha_site_key: null,
    },
    vault: { status: 'present' },
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function findLeaks(root: HTMLElement, fragments: readonly string[]): string[] {
  const leaks: string[] = [];
  const nodes = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
  for (const node of nodes) {
    for (const attr of Array.from(node.attributes)) {
      for (const fragment of fragments) {
        if (attr.value.includes(fragment)) {
          leaks.push(`attribute ${attr.name} on <${node.tagName.toLowerCase()}>`);
        }
      }
    }
    for (const [key, value] of Object.entries(node.dataset)) {
      for (const fragment of fragments) {
        if ((value ?? '').includes(fragment)) {
          leaks.push(`dataset.${key} on <${node.tagName.toLowerCase()}>`);
        }
      }
    }
  }
  for (const fragment of fragments) {
    if (root.textContent?.includes(fragment)) leaks.push(`text ${fragment}`);
    if (root.innerHTML.includes(fragment)) leaks.push(`markup ${fragment}`);
  }
  return leaks;
}

function bodyDataInCache(qc: QueryClient): unknown[] {
  return qc
    .getQueryCache()
    .findAll({ queryKey: VAULT_BODY_QUERY_KEY_PREFIX })
    .filter((query) => query.state.data !== undefined)
    .map((query) => query.queryKey);
}

describe('FE1-2 (P04-T18a, advisor-dec-191): the Omnibox never shows or matches body previews in any vault state', () => {
  const shims: Array<{ close: () => void }> = [];

  beforeEach(() => {
    document.cookie = 'sabk_csrf=test-csrf-token';
    routerMocks.pathname = '/app';
    routerMocks.replace.mockReset();
    routerMocks.push.mockReset();
    resetVaultBroadcastForTests();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (url.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (url.endsWith('/auth/me')) return jsonResponse(makeMe());
      return jsonResponse({});
    });
    vi.spyOn(contentApi, 'itemsList').mockImplementation(async (params) => {
      const normQ = normalizeForPrefixMatch(params?.q ?? '');
      const filtered = normQ
        ? MOCKED_API_ITEMS.filter((it) => normalizeForPrefixMatch(it.name).startsWith(normQ))
        : MOCKED_API_ITEMS;
      return { items: filtered, next_cursor: null };
    });
    vi.spyOn(contentApi, 'tagsList').mockImplementation(async (params) => {
      const normQ = normalizeForPrefixMatch(params?.q ?? '');
      const filtered = normQ
        ? MOCKED_API_TAGS.filter((t) => normalizeForPrefixMatch(t.display).startsWith(normQ))
        : MOCKED_API_TAGS;
      return { items: filtered, next_cursor: null };
    });
  });

  afterEach(() => {
    cleanup();
    for (const shim of shims.splice(0)) shim.close();
    resetVaultBroadcastForTests();
    vi.restoreAllMocks();
  });

  interface Harness {
    qc: QueryClient;
    vault: () => VaultContextValue;
    created: CreateVaultResult;
    sealed: Map<string, { envelope: unknown; ciphertext: string }>;
    opened: string[];
    loadFixtureBody: EntryBodyLoader;
    unlock: () => Promise<void>;
    holdNextKdf: () => { entered: Promise<void>; release: () => void };
    crashWorker: () => void;
  }

  async function mountLockedWithFixture(
    ui: (h: Pick<Harness, 'loadFixtureBody'>) => ReactNode,
  ): Promise<Harness> {
    const sealed = new Map<string, { envelope: unknown; ciphertext: string }>();
    const opened: string[] = [];
    let armed = false;
    const loadFixtureBody: EntryBodyLoader = async (entryId, { client, opGeneration }) => {
      const entry = sealed.get(entryId);
      if (!entry) throw new Error('fixture_missing');
      if (!armed) throw new Error('fixture_not_armed');
      opened.push(entryId);
      const result = await client.openEntry({
        entryId,
        envelope: entry.envelope,
        ciphertext: entry.ciphertext,
        opGeneration,
      });
      return result.plaintext;
    };

    let vaultCtx!: VaultContextValue;
    function Probe() {
      vaultCtx = useVault();
      return <output data-testid="probe">{vaultCtx.state}</output>;
    }

    let kdfGate: { notifyEntered: () => void; waitRelease: Promise<void> } | null = null;
    let activeShim: ShimmedWorkerInstance | null = null;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(contentQueryKeys.tags({ sort: 'recent' }), {
      items: MOCKED_API_TAGS,
      next_cursor: null,
    });

    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <QueryClientProvider client={qc}>
          <UndoToastProvider>
            <SessionProvider>
              <VaultProvider
                createWorker={() => {
                  const shim = createWorkerShim({
                    deriveKek: async (sodium, passphrase, params) => {
                      if (kdfGate) {
                        const gate = kdfGate;
                        kdfGate = null;
                        gate.notifyEntered();
                        await gate.waitRelease;
                      }
                      return fastTestDeriveKek(sodium, passphrase, params);
                    },
                  });
                  activeShim = shim;
                  shims.push(shim);
                  return shim.port;
                }}
                lockEpochEnv={makeSimpleLockEpochEnv()}
              >
                <Probe />
                {ui({ loadFixtureBody })}
              </VaultProvider>
            </SessionProvider>
          </UndoToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('locked'));

    const createOp = vaultCtx.beginOp();
    let created!: CreateVaultResult;
    await act(async () => {
      created = await vaultCtx.createVault({
        passphrase: PASSPHRASE,
        opGeneration: createOp.opGeneration,
      });
    });
    await waitFor(() => expect(vaultCtx.state).toBe('unlocked'));

    for (const item of FIXTURE_ITEMS) {
      const result = await vaultCtx.getClient().sealEntry({
        entryId: item.id,
        keyId: KEY_ID,
        plaintext: item.secret,
        opGeneration: vaultCtx.captureOpGeneration(),
      });
      sealed.set(item.id, { envelope: result.envelope, ciphertext: result.ciphertext });
    }

    await act(async () => {
      await vaultCtx.lockNow();
    });
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('locked'));
    armed = true;

    const unlock = async () => {
      const op = vaultCtx.beginOp();
      await act(async () => {
        await vaultCtx.unlockPassphrase({
          passphrase: PASSPHRASE,
          kdf: created.kdf,
          vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
          privateKeysWrapped: created.private_keys_wrapped,
          opGeneration: op.opGeneration,
        });
      });
      await waitFor(() => expect(vaultCtx.state).toBe('unlocked'));
    };

    const holdNextKdf = () => {
      const { promise: entered, resolve: notifyEntered } = Promise.withResolvers<void>();
      const { promise: waitRelease, resolve: release } = Promise.withResolvers<void>();
      kdfGate = { notifyEntered, waitRelease };
      return { entered, release };
    };
    const crashWorker = () => {
      if (!activeShim) throw new Error('worker_not_created');
      activeShim.simulateCrash();
    };

    return {
      qc,
      vault: () => vaultCtx,
      created,
      sealed,
      opened,
      loadFixtureBody,
      unlock,
      holdNextKdf,
      crashWorker,
    };
  }

  function searchOnEnter(value: string) {
    const input = screen.getByRole('textbox', { name: 'Search or save' });
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter' });
  }

  it('locked: name prefix and #tag filter match metadata only, no preview text anywhere, and a body-only query matches no items', async () => {
    await mountLockedWithFixture(() => <Omnibox />);

    // Name prefix match on Enter
    searchOnEnter('Cà phê');
    const listbox = await screen.findByRole('listbox', { name: 'Search results' });
    expect(within(listbox).getByRole('option', { name: new RegExp(D1.title) })).toBeInTheDocument();
    expect(findLeaks(document.body, [...DEMO_BODIES, ...SECRET_FRAGMENTS])).toEqual([]);
    assertNoPlaintextAttrs(document.body, [...DEMO_BODIES, ...SECRET_FRAGMENTS], { locked: true });
    assertVaultSecretElementAttributes(document.body);

    // #tag filter match (client-side cache)
    const input = screen.getByRole('textbox', { name: 'Search or save' });
    fireEvent.change(input, { target: { value: '#công-thức' } });
    const tagListbox = await screen.findByRole('listbox', { name: 'Tag filter results' });
    expect(within(tagListbox).getByRole('option', { name: /công-thức/ })).toBeInTheDocument();
    expect(findLeaks(document.body, [...DEMO_BODIES, ...SECRET_FRAGMENTS])).toEqual([]);

    // Body-only query ("phin" appears only in D1.preview) -> matches 0 items, offers only Create item option
    searchOnEnter('phin');
    const emptyListbox = await screen.findByRole('listbox', { name: 'Search results' });
    expect(screen.getByTestId('omnibox-search-empty')).toBeInTheDocument();
    expect(within(emptyListbox).getByRole('option', { name: /Create item “phin”/ })).toBeInTheDocument();
    expect(findLeaks(document.body, DEMO_BODIES.filter((b) => !b.includes('phin')))).toEqual([]);
    expect(document.body.textContent).not.toContain(D1.preview);
    assertNoPlaintextAttrs(document.body, [...DEMO_BODIES, ...SECRET_FRAGMENTS]);
  }, 30_000);

  it('unlocked: the Omnibox still never shows or matches entry body previews (P04 prefix search is name/tag only)', async () => {
    const h = await mountLockedWithFixture(() => <Omnibox />);
    await h.unlock();

    searchOnEnter('Cà phê');
    const listbox = await screen.findByRole('listbox', { name: 'Search results' });
    expect(within(listbox).getByRole('option', { name: new RegExp(D1.title) })).toBeInTheDocument();
    expect(screen.queryByText(D1.preview)).toBeNull();
    expect(findLeaks(document.body, [...DEMO_BODIES, ...SECRET_FRAGMENTS])).toEqual([]);
    assertNoPlaintextAttrs(document.body, [...DEMO_BODIES, ...SECRET_FRAGMENTS]);

    // Body-only query still matches no item even while unlocked
    searchOnEnter('phin');
    await screen.findByTestId('omnibox-search-empty');
    expect(screen.queryByText(D1.preview)).toBeNull();
    expect(findLeaks(document.body, DEMO_BODIES.filter((b) => !b.includes('phin')))).toEqual([]);
  }, 30_000);

  it('search results and input that are open when the vault locks are cleared immediately along with search QueryCache keys', async () => {
    const h = await mountLockedWithFixture(() => <Omnibox />);
    await h.unlock();

    searchOnEnter('Cà phê');
    await screen.findByRole('listbox', { name: 'Search results' });

    await act(async () => {
      await h.vault().lockNow();
    });
    await waitFor(() => expect(h.vault().state).toBe('locked'));

    const input = screen.getByRole('textbox', { name: 'Search or save' });
    expect(input).toHaveValue('');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(findLeaks(document.body, [...DEMO_BODIES, ...SECRET_FRAGMENTS, 'Cà phê'])).toEqual([]);
    assertNoPlaintextAttrs(document.body, [...DEMO_BODIES, ...SECRET_FRAGMENTS, 'Cà phê'], {
      locked: true,
    });
  }, 30_000);

  it('while locked no entry body reaches any surface: omnibox, results, list, attributes, query cache', async () => {
    const everyCachedValue = (qc: QueryClient) =>
      JSON.stringify(
        qc
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data ?? null),
      );
    const h = await mountLockedWithFixture(({ loadFixtureBody }) => (
      <>
        <Omnibox />
        <ItemList items={DEMO_ITEMS} load={loadFixtureBody} openLabel="Open" />
      </>
    ));

    const input = screen.getByRole('textbox', { name: 'Search or save' });
    for (const value of ['Cà phê', '#công-thức', 'Ghi', 'phin', 'localhost']) {
      searchOnEnter(value);
      await screen.findByRole('listbox');
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(findLeaks(document.body, DEMO_BODIES)).toEqual([]);
      assertNoPlaintextAttrs(document.body, DEMO_BODIES);
    }
    expect(screen.getAllByTestId('item-card')).toHaveLength(DEMO_ITEMS.length);
    expect(screen.getAllByTestId('entry-body-locked')).toHaveLength(DEMO_ITEMS.length);
    expect(bodyDataInCache(h.qc)).toEqual([]);
    for (const body of DEMO_BODIES) {
      expect(everyCachedValue(h.qc)).not.toContain(JSON.stringify(body).slice(1, -1));
    }
    expect(h.opened).toEqual([]);
  }, 30_000);

  it('FE2-1: while unlock is held in flight (unlocking) and after it fails (error), Omnibox, ItemList and EntryBody fail closed', async () => {
    const nonCryptoLoader = vi.fn<EntryBodyLoader>(async (entryId) => {
      const item = FIXTURE_ITEMS.find((candidate) => candidate.id === entryId);
      if (!item) throw new Error('fixture_missing');
      return item.secret;
    });
    const h = await mountLockedWithFixture(() => (
      <>
        <Omnibox />
        <ItemList items={FIXTURE_ITEMS} load={nonCryptoLoader} openLabel="Open" />
      </>
    ));
    nonCryptoLoader.mockClear();

    const assertAllSurfacesMasked = async () => {
      searchOnEnter('Cà phê');
      const listbox = await screen.findByRole('listbox', { name: 'Search results' });
      expect(within(listbox).getByRole('option', { name: new RegExp(D1.title) })).toBeInTheDocument();
      expect(findLeaks(document.body, DEMO_BODIES)).toEqual([]);

      searchOnEnter('phin');
      await screen.findByTestId('omnibox-search-empty');
      expect(document.body.textContent).not.toContain(D1.preview);

      expect(screen.getAllByTestId('item-card')).toHaveLength(FIXTURE_ITEMS.length);
      expect(screen.getAllByTestId('entry-body-locked')).toHaveLength(FIXTURE_ITEMS.length);
      expect(screen.queryAllByTestId('entry-body')).toHaveLength(0);
      expect(nonCryptoLoader).not.toHaveBeenCalled();
      expect(bodyDataInCache(h.qc)).toEqual([]);
      expect(findLeaks(document.body, SECRET_FRAGMENTS)).toEqual([]);
      assertNoPlaintextAttrs(document.body, [...DEMO_BODIES, ...SECRET_FRAGMENTS]);
    };

    const gate = h.holdNextKdf();
    const op = h.vault().beginOp();
    let unlockPromise!: Promise<{ unlocked: true }>;
    act(() => {
      unlockPromise = h.vault().unlockPassphrase({
        passphrase: PASSPHRASE,
        kdf: h.created.kdf,
        vaultKeyWrappedByKek: h.created.vault_key_wrapped_by_kek,
        privateKeysWrapped: h.created.private_keys_wrapped,
        opGeneration: op.opGeneration,
      });
      unlockPromise.catch(() => undefined);
    });
    await act(async () => {
      await gate.entered;
    });
    expect(h.vault().state).toBe('unlocking');
    await assertAllSurfacesMasked();

    await act(async () => {
      h.crashWorker();
      gate.release();
      await expect(unlockPromise).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
    });
    expect(h.vault().state).toBe('error');
    await assertAllSurfacesMasked();
  }, 30_000);

  it('FE2-1: without a VaultProvider, Omnibox, ItemList and EntryBody fail closed', async () => {
    const nonCryptoLoader = vi.fn<EntryBodyLoader>(async (entryId) => {
      const item = FIXTURE_ITEMS.find((candidate) => candidate.id === entryId);
      if (!item) throw new Error('fixture_missing');
      return item.secret;
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <QueryClientProvider client={qc}>
          <UndoToastProvider>
            <Omnibox />
            <ItemList items={FIXTURE_ITEMS} load={nonCryptoLoader} openLabel="Open" />
            <EntryBody entryId={FIXTURE_ITEMS[0]!.id} load={nonCryptoLoader} />
          </UndoToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );

    searchOnEnter('Cà phê');
    const listbox = await screen.findByRole('listbox', { name: 'Search results' });
    expect(within(listbox).getByRole('option', { name: new RegExp(D1.title) })).toBeInTheDocument();
    expect(findLeaks(document.body, DEMO_BODIES)).toEqual([]);

    searchOnEnter('phin');
    await screen.findByTestId('omnibox-search-empty');
    expect(document.body.textContent).not.toContain(D1.preview);

    expect(screen.getAllByTestId('item-card')).toHaveLength(FIXTURE_ITEMS.length);
    expect(screen.getAllByTestId('entry-body-locked').length).toBeGreaterThanOrEqual(
      FIXTURE_ITEMS.length,
    );
    expect(screen.queryAllByTestId('entry-body')).toHaveLength(0);
    expect(nonCryptoLoader).not.toHaveBeenCalled();
    expect(bodyDataInCache(qc)).toEqual([]);
    expect(findLeaks(document.body, SECRET_FRAGMENTS)).toEqual([]);
    assertNoPlaintextAttrs(document.body, [...DEMO_BODIES, ...SECRET_FRAGMENTS]);
  });
});
