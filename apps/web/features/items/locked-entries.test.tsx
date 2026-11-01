import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ItemPage from '@/app/app/items/[id]/page';
import { ThemeProvider } from '@/components/theme-provider';
import { UndoToastProvider } from '@/components/ui/undo-toast';
import { VaultPill } from '@/components/ui/vault-pill';
import { RouteGuard } from '@/features/auth/route-guard';
import { SessionProvider } from '@/features/auth/session-provider';
import { resetEntryBodyLoadLimiterForTests } from '@/features/entries';
import { EntryBody, LOCK_MASK_TEXT, type EntryBodyLoader } from '@/features/items/entry-body';
import { ItemDetailPage } from '@/features/items/item-detail-page';
import { ItemList, type ItemListEntry } from '@/features/items/item-list';
import { LockedBanner } from '@/features/items/locked-banner';
import {
  VAULT_BODY_QUERY_KEY_PREFIX,
  VaultProvider,
  resetVaultBroadcastForTests,
  useVault,
  vaultBodyQueryKey,
  type LockEpochEnvironment,
  type VaultContextValue,
} from '@/features/vault';
import {
  TEST_VECTOR_KDF,
  TEST_VECTOR_PASSPHRASE,
  TEST_VECTOR_VAULT_KEY_ID,
  TEST_VECTOR_WRAPPED_PRIV,
  TEST_VECTOR_WRAPPED_VK,
} from '@/e2e/vault-locked-support';
import lockedItemFixture from '@/e2e/fixtures/locked-item-entries.json';
import type { Me } from '@/lib/api/auth';
import type { Entry, EntryEnvelopeV1, EntryMeta, ItemSummary } from '@/lib/api/content';
import { CryptoClient, type CreateVaultResult } from '@/lib/crypto/client';
import { KEK_BYTES, type DeriveKekFn, type ValidatedKdfParams } from '@/lib/crypto/kdf';
import type { Sodium } from '@/lib/crypto/sodium';
import { createWorkerShim, type ShimmedWorkerInstance } from '@/lib/crypto/test/worker-shim';
import en from '@/messages/en.json';

/**
 * P03-T21: locked state U5 (plan Task 21), migrated in P04-T15 to the real item page (`ItemDetailPage` + `loadRealEntryBody`)
 * for `/app/items/<id>` assertions while keeping every original assertion's intent.
 *
 * The harness is the real `VaultProvider`, the real `CryptoClient` and the real `worker-core` behind the Node
 * `MessageChannel` shim (same as the provider/unlock tests), with a fast deterministic KEK derive. The fixture
 * ciphertext is sealed by that Worker (`sealEntry`) while a throw-away vault is unlocked, then kept only as
 * `{ envelope, ciphertext }`; the fixture loader and the real item-page loader open it through `client.openEntry`.
 * No plaintext of the fixture is written anywhere except as the expected value of the assertions below.
 */

const routerMocks = vi.hoisted(() => {
  const replace = vi.fn();
  const push = vi.fn();
  const redirect = vi.fn((target: string) => {
    throw new Error(`NEXT_REDIRECT:${target}`);
  });
  return { pathname: '/app', replace, push, redirect, router: { replace, push } };
});

vi.mock('next/navigation', () => ({
  usePathname: () => routerMocks.pathname,
  useRouter: () => routerMocks.router,
  useSearchParams: () => new URLSearchParams(),
  redirect: routerMocks.redirect,
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
  let marker = { epochIncarnation: 'inc-unlock-test-1', lockEpoch: 1 };
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Every place plaintext must never be while locked: text, attribute values, `dataset`, serialised markup. */
function findLeaks(root: HTMLElement, fragments: readonly string[]): string[] {
  const leaks: string[] = [];
  const nodes = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
  for (const node of nodes) {
    for (const attr of Array.from(node.attributes)) {
      for (const fragment of fragments) {
        if (attr.value.includes(fragment)) leaks.push(`attribute ${attr.name} on <${node.tagName.toLowerCase()}>`);
      }
    }
    for (const [key, value] of Object.entries(node.dataset)) {
      for (const fragment of fragments) {
        if ((value ?? '').includes(fragment)) leaks.push(`dataset.${key} on <${node.tagName.toLowerCase()}>`);
      }
    }
  }
  for (const fragment of fragments) {
    if (root.textContent?.includes(fragment)) leaks.push(`text ${fragment}`);
    if (root.innerHTML.includes(fragment)) leaks.push(`markup ${fragment}`);
  }
  return leaks;
}

/** Keys of every `['vault','body',*]` query that currently holds data. Empty shells (`state.data === undefined`) do not count. */
function bodyDataInCache(qc: QueryClient): unknown[] {
  return qc
    .getQueryCache()
    .findAll({ queryKey: VAULT_BODY_QUERY_KEY_PREFIX })
    .filter((query) => query.state.data !== undefined)
    .map((query) => query.queryKey);
}

describe('P03-T21 Locked state U5', () => {
  const shims: Array<{ close: () => void }> = [];

  beforeEach(() => {
    document.cookie = 'sabk_csrf=test-csrf-token';
    routerMocks.pathname = '/app';
    routerMocks.replace.mockReset();
    routerMocks.push.mockReset();
    routerMocks.redirect.mockClear();
    resetVaultBroadcastForTests();
    resetEntryBodyLoadLimiterForTests();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (url.endsWith('/auth/config')) {
        return jsonResponse({ oauth_providers: [], email_verification_required: false, captcha_site_key: null });
      }
      if (url.endsWith('/auth/me')) return jsonResponse(makeMe());
      return jsonResponse({});
    });
  });

  afterEach(() => {
    cleanup();
    for (const shim of shims.splice(0)) shim.close();
    resetVaultBroadcastForTests();
    resetEntryBodyLoadLimiterForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  interface Harness {
    qc: QueryClient;
    vault: () => VaultContextValue;
    created: CreateVaultResult;
    sealed: Map<string, { envelope: EntryEnvelopeV1; ciphertext: string }>;
    opened: string[];
    loadFixtureBody: EntryBodyLoader;
    unlock: () => Promise<void>;
    holdNextKdf: () => { entered: Promise<void>; release: () => void };
    crashWorker: () => void;
  }

  /**
   * Mounts `ui` inside the real providers, creates a throw-away vault (which unlocks it), seals the fixture entries with
   * the Worker, and locks again. The returned harness starts LOCKED with only ciphertext in hand, and wires the real
   * `/api/v1/items/{id}`, `/api/v1/items/{id}/entries`, `/api/v1/entries/{id}`, and `/api/v1/vault` endpoints so
   * `ItemDetailPage` + `loadRealEntryBody` operate against the sealed fixture ciphertexts.
   */
  async function mountLockedWithFixture(
    ui: (h: Pick<Harness, 'loadFixtureBody'>) => ReactNode,
  ): Promise<Harness> {
    const sealed = new Map<string, { envelope: EntryEnvelopeV1; ciphertext: string }>();
    const opened: string[] = [];
    // The list mounts while the setup vault is briefly unlocked; nothing may be opened until setup is over.
    let armed = false;
    let created!: CreateVaultResult;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (url.endsWith('/auth/config')) {
        return jsonResponse({ oauth_providers: [], email_verification_required: false, captcha_site_key: null });
      }
      if (url.endsWith('/auth/me')) return jsonResponse(makeMe());
      if (url.endsWith('/vault')) {
        if (!created) return jsonResponse({}, 404);
        return jsonResponse({
          vault_key_id: KEY_ID,
          version: 1,
          kdf: created.kdf,
          vault_key_wrapped_by_kek: created.vault_key_wrapped_by_kek,
          x25519_public: created.x25519_public,
          ed25519_public: created.ed25519_public,
          private_keys_wrapped: created.private_keys_wrapped,
          recovery_keys_remaining: 10,
          passkeys: [],
        });
      }

      const parsedUrl = new URL(url, 'http://localhost');
      const pathname = parsedUrl.pathname;

      const itemEntriesMatch = /^\/api\/v1\/items\/([^/]+)\/entries$/.exec(pathname);
      if (itemEntriesMatch) {
        const itemId = decodeURIComponent(itemEntriesMatch[1]);
        const fixture = FIXTURE_ITEMS.find((candidate) => candidate.id === itemId);
        if (!fixture) return jsonResponse({ code: 'not_found', status: 404 }, 404);
        const meta: EntryMeta = {
          id: fixture.id,
          item_id: fixture.id,
          type: fixture.kind,
          position: 0,
          version: 1,
          plaintext_len_bucket: 256,
          created_at: '2026-11-01T00:00:00Z',
          updated_at: '2026-11-01T00:00:00Z',
        };
        return jsonResponse({ items: [meta], next_cursor: null });
      }

      const itemMatch = /^\/api\/v1\/items\/([^/]+)$/.exec(pathname);
      if (itemMatch) {
        const itemId = decodeURIComponent(itemMatch[1]);
        const fixture = FIXTURE_ITEMS.find((candidate) => candidate.id === itemId);
        if (!fixture) return jsonResponse({ code: 'not_found', status: 404 }, 404);
        const summary: ItemSummary = {
          id: fixture.id,
          name: fixture.title,
          hint: null,
          tags: fixture.tags.map((tag, idx) => ({ id: `tag-${idx + 1}`, display: tag })),
          entry_count: 1,
          version: 1,
          created_at: '2026-11-01T00:00:00Z',
          updated_at: '2026-11-01T00:00:00Z',
          last_used_at: '2026-11-01T00:00:00Z',
        };
        return jsonResponse(summary);
      }

      const entryMatch = /^\/api\/v1\/entries\/([^/]+)$/.exec(pathname);
      if (entryMatch) {
        const entryId = decodeURIComponent(entryMatch[1]);
        const fixture = FIXTURE_ITEMS.find((candidate) => candidate.id === entryId);
        const sealedEntry = sealed.get(entryId);
        if (!fixture || !sealedEntry) return jsonResponse({ code: 'not_found', status: 404 }, 404);
        if (!armed) throw new Error('fixture_not_armed');
        opened.push(entryId);
        const payload: Entry = {
          id: fixture.id,
          item_id: fixture.id,
          type: fixture.kind,
          position: 0,
          version: 1,
          plaintext_len_bucket: 256,
          envelope: sealedEntry.envelope,
          ciphertext: sealedEntry.ciphertext,
          created_at: '2026-11-01T00:00:00Z',
          updated_at: '2026-11-01T00:00:00Z',
        };
        return jsonResponse(payload);
      }

      if (pathname === '/api/v1/tags') {
        return jsonResponse({ items: [], next_cursor: null });
      }

      return jsonResponse({});
    });

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
    const buildTree = (children: ReactNode) => (
      <NextIntlClientProvider locale="en" messages={en}>
        <ThemeProvider initialTheme="light" initialLocale="en">
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
                  {children}
                </VaultProvider>
              </SessionProvider>
            </UndoToastProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </NextIntlClientProvider>
    );

    const rendered = render(buildTree(null));
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('locked'));

    const createOp = vaultCtx.beginOp();
    await act(async () => {
      created = await vaultCtx.createVault({ passphrase: PASSPHRASE, opGeneration: createOp.opGeneration });
    });
    await waitFor(() => expect(vaultCtx.state).toBe('unlocked'));

    await act(async () => {
      await vaultCtx.reloadVaultMeta();
    });
    await waitFor(() => expect(vaultCtx.vaultMeta?.vault_key_id).toBe(KEY_ID));

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

    rendered.rerender(buildTree(ui({ loadFixtureBody })));

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
        await vaultCtx.reloadVaultMeta();
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

  function renderListUi({ loadFixtureBody }: Pick<Harness, 'loadFixtureBody'>) {
    return (
      <>
        <VaultPill />
        <LockedBanner />
        <ItemList items={FIXTURE_ITEMS} load={loadFixtureBody} openLabel="Open" />
      </>
    );
  }

  it('Task 21 bullets 1+3: unlock -> bodies show; lock -> bodies leave the DOM and the query cache; unlock again -> they show again', async () => {
    const h = await mountLockedWithFixture(renderListUi);
    // Mounted-but-disabled observers keep empty Query shells under the namespace; the contract is "no decrypted data".

    // Locked from the first frame: metadata visible, bodies masked, nothing decrypted anywhere.
    expect(h.vault().state).toBe('locked');
    expect(screen.getAllByTestId('item-card')).toHaveLength(FIXTURE_ITEMS.length);
    expect(screen.getAllByTestId('entry-body-locked')).toHaveLength(FIXTURE_ITEMS.length);
    expect(h.opened).toEqual([]);
    expect(bodyDataInCache(h.qc)).toEqual([]);

    // 1st unlock: every body appears, comes from the Worker, and lives in the vault-namespaced cache.
    await h.unlock();
    for (const item of FIXTURE_ITEMS) {
      expect(await screen.findByText(item.secret)).toBeInTheDocument();
      expect(h.qc.getQueryData(vaultBodyQueryKey(item.id))).toBe(item.secret);
    }
    expect(screen.queryAllByTestId('entry-body-locked')).toHaveLength(0);
    expect(h.opened.slice().sort()).toEqual(FIXTURE_ITEMS.map((item) => item.id).sort());
    // Unlocked: the helper really sees every decrypted body, so the empty results while locked are not vacuous.
    expect(bodyDataInCache(h.qc)).toHaveLength(FIXTURE_ITEMS.length);
    expect(findLeaks(document.body, SECRET_FRAGMENTS).filter((leak) => leak.startsWith('text') || leak.startsWith('markup')).length).toBeGreaterThan(0);
    // Even unlocked, the plaintext is only ever a text node: no attribute and no dataset carries it.
    expect(findLeaks(document.body, SECRET_FRAGMENTS).filter((leak) => !leak.startsWith('text') && !leak.startsWith('markup'))).toEqual([]);

    // Lock: the cache namespace is cleared synchronously, the DOM follows.
    let lockPromise!: Promise<unknown>;
    act(() => {
      lockPromise = h.vault().lockNow();
    });
    for (const item of FIXTURE_ITEMS) {
      expect(h.qc.getQueryData(vaultBodyQueryKey(item.id))).toBeUndefined();
    }
    expect(bodyDataInCache(h.qc)).toEqual([]);
    // Let the lock's durable lockEpoch write settle before the next unlock captures its baseline.
    await act(async () => {
      await lockPromise;
    });
    await waitFor(() => expect(screen.getAllByTestId('entry-body-locked')).toHaveLength(FIXTURE_ITEMS.length));
    expect(findLeaks(document.body, SECRET_FRAGMENTS)).toEqual([]);
    expect(bodyDataInCache(h.qc)).toEqual([]);
    expect(screen.getAllByTestId('item-card')).toHaveLength(FIXTURE_ITEMS.length);

    // 2nd unlock: bodies are decrypted again (not served from a stale cache entry).
    const openedBefore = h.opened.length;
    await h.unlock();
    for (const item of FIXTURE_ITEMS) {
      expect(await screen.findByText(item.secret)).toBeInTheDocument();
      expect(h.qc.getQueryData(vaultBodyQueryKey(item.id))).toBe(item.secret);
    }
    expect(h.opened.length).toBe(openedBefore + FIXTURE_ITEMS.length);
  }, 30_000);

  it('Task 21 bullet 1: while locked the list keeps name, tag and type, masks every body as "🔒 ••••••" with no plaintext in any attribute, and offers no create/edit control', async () => {
    await mountLockedWithFixture(renderListUi);

    const cards = screen.getAllByTestId('item-card');
    expect(cards).toHaveLength(FIXTURE_ITEMS.length);
    FIXTURE_ITEMS.forEach((item, index) => {
      const card = within(cards[index]);
      expect(card.getByRole('heading', { name: item.title })).toBeInTheDocument();
      expect(card.getByText(item.kind.toUpperCase())).toBeInTheDocument();
      for (const tag of item.tags) {
        expect(cards[index]).toHaveTextContent(`#${tag}`);
      }
      const mask = card.getByTestId('entry-body-locked');
      expect(mask).toHaveTextContent(LOCK_MASK_TEXT);
      // The mask is identical for every entry: it cannot leak the body's length or kind.
      expect(mask.textContent).toBe(screen.getAllByTestId('entry-body-locked')[0].textContent);
    });
    expect(screen.getAllByTestId('entry-body-locked')[0]).toHaveTextContent('🔒 ••••••');

    expect(findLeaks(document.body, SECRET_FRAGMENTS)).toEqual([]);

    // U5 banner with the unlock call to action (.locked-banner class + <640px short copy variant); no editing surface exists while locked.
    const banner = screen.getByTestId('vault-locked-banner');
    expect(banner).toHaveClass('locked-banner');
    expect(banner).toHaveTextContent('Vault locked');
    expect(screen.getByTestId('vault-locked-banner-body-short')).toHaveTextContent(
      en.content.item.lockedBannerBodyShort,
    );
    expect(screen.getByTestId('vault-locked-banner-body-full')).toHaveTextContent(
      en.vault.locked.bannerBody,
    );
    expect(screen.getByTestId('vault-locked-unlock-cta')).toHaveAttribute('href', '/app/unlock');
    expect(document.querySelector('textarea, [contenteditable]:not([contenteditable="false"])')).toBeNull();
    expect(
      screen.queryAllByRole('button', { name: /edit|save|create|new entry|add entry/i }),
    ).toHaveLength(0);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
  }, 30_000);

  it('Task 21 bullet 2: the vault pill follows the provider (locked -> unlocked -> locked) without being told the state', async () => {
    const h = await mountLockedWithFixture(renderListUi);
    const pill = () => document.querySelector<HTMLElement>('.vault-pill')!;

    expect(pill()).toHaveAttribute('data-vault-state', 'locked');
    expect(pill()).toHaveClass('vault-shut');
    expect(pill()).toHaveTextContent('Vault locked');

    await h.unlock();
    await waitFor(() => expect(pill()).toHaveAttribute('data-vault-state', 'unlocked'));
    expect(pill()).toHaveClass('vault-open');
    expect(pill()).toHaveTextContent('Vault open');
    expect(screen.queryByTestId('vault-locked-banner')).toBeNull();

    await act(async () => {
      await h.vault().lockNow();
    });
    await waitFor(() => expect(pill()).toHaveAttribute('data-vault-state', 'locked'));
    expect(pill()).toHaveClass('vault-shut');
    expect(screen.getByTestId('vault-locked-banner')).toBeInTheDocument();
  }, 30_000);

  it('a body that finishes decrypting after a lock is dropped: no DOM text, nothing in the query cache', async () => {
    let releaseLoad!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    let loadStarts = 0;
    // Loader that does no crypto: only the hook's own generation guard can stop it from being cached.
    const slowLoader: EntryBodyLoader = async () => {
      loadStarts += 1;
      await gate;
      return FIXTURE_ITEMS[0].secret;
    };

    const h = await mountLockedWithFixture(() => (
      <EntryBody entryId={FIXTURE_ITEMS[0].id} load={slowLoader} />
    ));
    const startsBeforeUnlock = loadStarts;
    await h.unlock();
    await waitFor(() => expect(loadStarts).toBeGreaterThan(startsBeforeUnlock));
    expect(screen.getByTestId('entry-body-loading')).toBeInTheDocument();

    await act(async () => {
      await h.vault().lockNow();
    });
    await waitFor(() => expect(screen.getByTestId('entry-body-locked')).toBeInTheDocument());

    await act(async () => {
      releaseLoad();
      await Promise.resolve();
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(h.qc.getQueryData(vaultBodyQueryKey(FIXTURE_ITEMS[0].id))).toBeUndefined();
    expect(bodyDataInCache(h.qc)).toEqual([]);
    expect(findLeaks(document.body, SECRET_FRAGMENTS)).toEqual([]);
    expect(screen.getByTestId('entry-body-locked')).toHaveTextContent(LOCK_MASK_TEXT);
  }, 30_000);

  describe('route guard while locked (advisor-dec-048: U5 over plan 15A for /app and /app/items/** only)', () => {
    function renderGuardedList({ loadFixtureBody }: Pick<Harness, 'loadFixtureBody'>) {
      return (
        <RouteGuard>
          <LockedBanner />
          <ItemList items={FIXTURE_ITEMS} load={loadFixtureBody} openLabel="Open" />
        </RouteGuard>
      );
    }

    it('cold start on /app while locked lands on the U5 list with an unlock action, not on /app/unlock', async () => {
      routerMocks.pathname = '/app';
      await mountLockedWithFixture(renderGuardedList);

      expect(routerMocks.replace).not.toHaveBeenCalled();
      expect(screen.getByTestId('vault-locked-banner')).toBeInTheDocument();
      expect(screen.getByTestId('vault-locked-unlock-cta')).toHaveAttribute('href', '/app/unlock');
      expect(screen.getAllByTestId('item-card')).toHaveLength(FIXTURE_ITEMS.length);
      expect(screen.getAllByTestId('entry-body-locked')).toHaveLength(FIXTURE_ITEMS.length);
      expect(findLeaks(document.body, SECRET_FRAGMENTS)).toEqual([]);
    }, 30_000);

    it('a locked deep link /app/items/<id> is not redirected and renders its real item page with a masked body (no body reachable)', async () => {
      const item = FIXTURE_ITEMS[0];
      routerMocks.pathname = `/app/items/${item.id}`;
      const h = await mountLockedWithFixture(() => (
        <RouteGuard>
          <ItemDetailPage itemId={item.id} lazyCards={false} />
        </RouteGuard>
      ));

      expect(routerMocks.replace).not.toHaveBeenCalled();
      expect(await screen.findByRole('heading', { level: 1, name: item.title })).toBeInTheDocument();
      const breadcrumbNav = screen.getByRole('navigation', {
        name: en.content.item.breadcrumbLabel,
      });
      expect(within(breadcrumbNav).getByRole('link', { name: en.content.item.allItems })).toHaveAttribute('href', '/app');
      expect(screen.getByTestId('item-name-input')).toHaveValue(item.title);
      expect(await screen.findByTestId(`entry-card-${item.id}`)).toBeInTheDocument();
      expect(screen.getByTestId('entry-body-locked')).toHaveTextContent(LOCK_MASK_TEXT);
      expect(screen.queryByTestId('entry-body')).toBeNull();
      for (const tag of item.tags) {
        expect(screen.getByTestId('item-tags')).toHaveTextContent(`#${tag}`);
      }
      expect(screen.getByTestId('vault-locked-unlock-cta')).toHaveAttribute(
        'href',
        `/app/unlock?returnTo=${encodeURIComponent(routerMocks.pathname)}`,
      );
      expect(document.querySelector('#entry-card-list textarea, #entry-card-list [contenteditable]:not([contenteditable="false"])')).toBeNull();
      expect(screen.getByTestId('btn-add-text')).toBeDisabled();
      expect(h.opened).toEqual([]);
      expect(bodyDataInCache(h.qc)).toEqual([]);
      expect(findLeaks(document.body, SECRET_FRAGMENTS)).toEqual([]);

      // Unlocking in place shows the body via loadRealEntryBody without any navigation; the page never left the item.
      await h.unlock();
      expect(await screen.findByText(item.secret)).toBeInTheDocument();
      expect(h.qc.getQueryData(vaultBodyQueryKey(item.id, 1))).toBe(item.secret);
      expect(screen.queryByTestId('entry-body-locked')).toBeNull();
      expect(routerMocks.replace).not.toHaveBeenCalled();

      // Locking again clears the decrypted body from the DOM and QueryCache while keeping the real item page mounted.
      await act(async () => {
        await h.vault().lockNow();
      });
      await waitFor(() => expect(screen.getByTestId('entry-body-locked')).toHaveTextContent(LOCK_MASK_TEXT));
      expect(h.qc.getQueryData(vaultBodyQueryKey(item.id, 1))).toBeUndefined();
      expect(bodyDataInCache(h.qc)).toEqual([]);
      expect(findLeaks(document.body, SECRET_FRAGMENTS)).toEqual([]);
    }, 30_000);

    it('/app/items/[id] with the content flag off (vi.stubEnv) redirects to /app', async () => {
      vi.stubEnv('NEXT_PUBLIC_CONTENT_ENABLED', 'false');
      await expect(
        ItemPage({ params: Promise.resolve({ id: FIXTURE_ITEMS[0].id }) }),
      ).rejects.toThrow('NEXT_REDIRECT:/app');
      expect(routerMocks.redirect).toHaveBeenCalledWith('/app');
    });

    it('/app/settings stays reachable while locked', async () => {
      routerMocks.pathname = '/app/settings';
      await mountLockedWithFixture(renderGuardedList);
      expect(routerMocks.replace).not.toHaveBeenCalled();
    }, 30_000);

    it.each(['/app/tags/home', '/app/items-archive'])(
      'every other app route (%s) still redirects to /app/unlock with returnTo while locked',
      async (pathname) => {
        routerMocks.pathname = pathname;
        await mountLockedWithFixture(renderGuardedList);
        expect(routerMocks.replace).toHaveBeenCalledWith(`/app/unlock?returnTo=${encodeURIComponent(pathname)}`);
      },
      30_000,
    );
  });

  it('outside any VaultProvider a body is masked and the loader is never called', () => {
    const load = vi.fn<EntryBodyLoader>(async () => FIXTURE_ITEMS[0].secret);
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <QueryClientProvider client={new QueryClient()}>
          <EntryBody entryId={FIXTURE_ITEMS[0].id} load={load} />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('entry-body-locked')).toHaveTextContent(LOCK_MASK_TEXT);
    expect(load).not.toHaveBeenCalled();
  });

  it('advisor-dec-183: committed e2e/fixtures/locked-item-entries.json opens every entry with the test-vector vault key through the real CryptoClient and Worker shim', async () => {
    expect(lockedItemFixture.entries.length).toBeGreaterThan(0);

    const shim = createWorkerShim();
    shims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });

    const unlockGeneration = client.captureGeneration();
    const unlocked = await client.unlockPassphrase({
      passphrase: TEST_VECTOR_PASSPHRASE,
      kdf: TEST_VECTOR_KDF,
      vaultKeyWrappedByKek: TEST_VECTOR_WRAPPED_VK,
      privateKeysWrapped: TEST_VECTOR_WRAPPED_PRIV,
      opGeneration: unlockGeneration,
    });
    expect(unlocked).toEqual({ unlocked: true });
    expect(client.getState()).toBe('unlocked');

    const openGeneration = client.captureGeneration();
    for (const record of lockedItemFixture.entries) {
      expect(record.entry.id).toBe(record.meta.id);
      expect(record.entry.item_id).toBe(lockedItemFixture.item.id);
      expect(record.entry.envelope.key_id).toBe(TEST_VECTOR_VAULT_KEY_ID);

      const opened = await client.openEntry({
        entryId: record.entry.id,
        envelope: record.entry.envelope,
        ciphertext: record.entry.ciphertext,
        opGeneration: openGeneration,
      });
      expect(opened.plaintext).toBe(record.plaintext);
    }
  }, 60_000);
});
