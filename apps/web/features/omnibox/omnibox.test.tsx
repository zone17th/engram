import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProblemError } from '@engram/shared-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Omnibox } from '@/components/app-shell/omnibox';
import { UndoToastProvider } from '@/components/ui/undo-toast';
import { assertVaultSecretElementAttributes } from '@/features/entries/secret-input-props';
import { assertNoPlaintextAttrs } from '@/features/entries/test-utils/assert-no-plaintext-attrs';
import { contentQueryKeys } from '@/features/items/query-keys';
import {
  clearLockClearedNotice,
  clearSaveUnconfirmed,
  getLockClearedNoticeSnapshot,
  getSaveUnconfirmedSnapshot,
  recordLockClearedNotice,
  recordSaveUnconfirmed,
} from '@/features/omnibox/unconfirmed-save-store';
import { setKnownDeviceSessionUserId } from '@/features/vault/device-store';
import * as contentApi from '@/lib/api/content';
import type { EntryEnvelopeV1, EntryMeta, ItemSummary, Tag } from '@/lib/api/content';
import { postSessionBroadcast } from '@/lib/auth/broadcast';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';
const mockRouterPush = vi.fn();
const mockRouterReplace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: mockRouterReplace,
    prefetch: vi.fn(),
  }),
  usePathname: () => '/app',
  useSearchParams: () => new URLSearchParams(),
}));

const TEST_KEY_ID = 'vk:7f3a91c4e0b2d8a1f5c309';
const USER_A_ID = 'aaaa0000-0000-4000-8000-000000000001';
const USER_B_ID = 'bbbb0000-0000-4000-8000-000000000002';

const registeredResetFns = new Set<() => void>();
let mockVaultState: 'locked' | 'unlocked' = 'unlocked';
let mockVaultGeneration = 1;
let mockVaultMetaOverride: { vault_key_id: string; version: number } | null | undefined = undefined;
const mockReloadVaultMeta = vi.fn<() => Promise<{ vault_key_id: string; version: number } | null>>(
  async () => ({ vault_key_id: TEST_KEY_ID, version: 1 }),
);
const mockSealEntryCalls: Array<{
  readonly entryId: string;
  readonly keyId: string;
  readonly plaintext: string;
  readonly opGeneration: number;
}> = [];

const fakeCryptoClient = {
  getState: () => mockVaultState,
  getGeneration: () => mockVaultGeneration,
  captureGeneration: () => mockVaultGeneration,
  sealEntry: vi.fn(
    async (params: {
      readonly entryId: string;
      readonly keyId: string;
      readonly plaintext: string;
      readonly opGeneration: number;
    }): Promise<{ readonly envelope: EntryEnvelopeV1; readonly ciphertext: string }> => {
      mockSealEntryCalls.push(params);
      return {
        envelope: {
          v: 1,
          alg: 'xchacha20poly1305-ietf',
          key_id: params.keyId,
          nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAA_nonce1',
          ct_enc: 'utf8',
        },
        ciphertext: 'Q0lQSEVSVEVYVF9PUEFRVUVfQllURVM',
      };
    },
  ),
};

function triggerVaultLockReset() {
  mockVaultState = 'locked';
  mockVaultGeneration += 1;
  for (const fn of [...registeredResetFns]) {
    fn();
  }
}

function triggerVaultUnlock() {
  mockVaultState = 'unlocked';
  mockVaultGeneration += 1;
}

vi.mock('@/features/vault/vault-provider', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useOptionalVault: () => ({
      state: mockVaultState,
      minutesLeft: 15,
      vaultMeta:
        mockVaultMetaOverride !== undefined
          ? mockVaultMetaOverride
          : { vault_key_id: TEST_KEY_ID, version: 1 },
      reloadVaultMeta: mockReloadVaultMeta,
      beginOp: () => {
        const capturedGen = mockVaultGeneration;
        return {
          opGeneration: capturedGen,
          isCurrent: () => mockVaultState === 'unlocked' && mockVaultGeneration === capturedGen,
          client: fakeCryptoClient,
        };
      },
      getClient: () => fakeCryptoClient,
      captureOpGeneration: () => mockVaultGeneration,
      lockNow: vi.fn(async () => {
        triggerVaultLockReset();
      }),
      registerSecretFormReset: (fn: () => void) => {
        registeredResetFns.add(fn);
        return () => {
          registeredResetFns.delete(fn);
        };
      },
    }),
  };
});
const TAG_NHA: Tag = {
  id: 'aaaa1111-1111-4111-8111-111111111111',
  display: 'nhà',
  item_count: 12,
  last_used_at: '2026-11-01T00:00:00Z',
  created_at: '2026-11-01T00:00:00Z',
};

const TAG_OPS: Tag = {
  id: 'bbbb2222-2222-4222-8222-222222222222',
  display: 'ops',
  item_count: 7,
  last_used_at: '2026-11-01T00:00:00Z',
  created_at: '2026-11-01T00:00:00Z',
};

const ITEM_WIFI: ItemSummary = {
  id: '1111aaaa-1111-4111-8111-111111111111',
  name: 'wifi',
  hint: 'Nhà + văn phòng',
  tags: [
    { id: TAG_NHA.id, display: TAG_NHA.display },
    { id: TAG_OPS.id, display: TAG_OPS.display },
    { id: 't3', display: 'home-lab' },
    { id: 't4', display: 'backup' },
  ],
  entry_count: 12,
  version: 1,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  last_used_at: '2026-11-01T00:00:00Z',
};

const ITEM_WIFI_GUEST: ItemSummary = {
  id: '2222bbbb-2222-4222-8222-222222222222',
  name: 'wifi khách',
  hint: null,
  tags: [{ id: TAG_NHA.id, display: TAG_NHA.display }],
  entry_count: 3,
  version: 1,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  last_used_at: '2026-11-01T00:00:00Z',
};

function renderOmnibox(
  ui: ReactNode = <Omnibox />,
  {
    locale = 'vi',
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    }),
  }: { locale?: 'en' | 'vi'; queryClient?: QueryClient } = {},
) {
  const messages = locale === 'en' ? enMessages : viMessages;
  return {
    queryClient,
    ...render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <QueryClientProvider client={queryClient}>
          <UndoToastProvider>{ui}</UndoToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    ),
  };
}

describe('Omnibox — P04-T18a search, tag filter, ARIA, secret attributes, and lock reset', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockRouterPush.mockClear();
    mockRouterReplace.mockClear();
    registeredResetFns.clear();
    mockSealEntryCalls.length = 0;
    mockVaultState = 'unlocked';
    mockVaultGeneration = 1;
    mockVaultMetaOverride = undefined;
    mockReloadVaultMeta.mockReset();
    mockReloadVaultMeta.mockResolvedValue({ vault_key_id: TEST_KEY_ID, version: 1 });
    clearSaveUnconfirmed();
    clearLockClearedNotice();
    setKnownDeviceSessionUserId(USER_A_ID);
  });

  it('shows searchHint in search mode (mentioning Ctrl+Enter and server plaintext), tagHint in #… mode, and no hint in add mode', () => {
    const itemsSpy = vi.spyOn(contentApi, 'itemsList');
    const tagsSpy = vi.spyOn(contentApi, 'tagsList');
    const createSpy = vi.spyOn(contentApi, 'itemCreate');

    renderOmnibox();
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });
    const hint = screen.getByTestId('omnibox-hint');

    // Empty input -> hint hidden
    expect(hint).toHaveAttribute('hidden');

    // Search mode -> searchHint visible, mentions Ctrl+Enter and server/unencrypted, and renders mono span (HM18A-R1-10)
    fireEvent.change(textarea, { target: { value: 'wifi' } });
    expect(hint).not.toHaveAttribute('hidden');
    expect(hint).toHaveTextContent(/Ctrl\+Enter/);
    expect(hint).toHaveTextContent(/gửi tới máy chủ, không mã hoá/);
    expect(hint.querySelector('span.mono')?.textContent).toBe('tên: nội dung');
    expect(hint.textContent).not.toContain('`');

    // Tag filter mode (#…) -> tagHint visible, Ctrl+Enter does nothing; 0 cached tags renders no empty role="listbox" (HM18A-R1-9)
    fireEvent.change(textarea, { target: { value: '#nhà' } });
    expect(hint).not.toHaveAttribute('hidden');
    expect(hint).toHaveTextContent(viMessages.content.omnibox.tagHint);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(textarea).not.toHaveAttribute('aria-controls');
    expect(createSpy).not.toHaveBeenCalled();
    expect(tagsSpy).not.toHaveBeenCalled();

    // Add mode -> no hint, no request before Enter
    fireEvent.change(textarea, { target: { value: 'wifi #nhà: secret-pass-123' } });
    expect(hint).toHaveAttribute('hidden');

    // Add-invalid mode -> no hint, no request
    fireEvent.change(textarea, { target: { value: 'wifi:' } });
    expect(hint).toHaveAttribute('hidden');

    expect(itemsSpy).not.toHaveBeenCalled();
    expect(tagsSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('keeps implicit textbox role (no role="combobox", no aria-expanded) and sets aria-controls only while listbox is open (dec-152, dec-156, dec-170)', async () => {
    vi.spyOn(contentApi, 'itemsList').mockResolvedValue({
      items: [ITEM_WIFI, ITEM_WIFI_GUEST],
      next_cursor: null,
    });

    renderOmnibox();
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea).toHaveAttribute('rows', '1');
    expect(textarea).not.toHaveAttribute('role');
    expect(textarea).not.toHaveAttribute('aria-expanded');
    expect(textarea).not.toHaveAttribute('aria-controls');
    expect(textarea).not.toHaveAttribute('aria-activedescendant');
    expect(textarea).toHaveAttribute('aria-describedby', 'omni-hint');

    // Typing does not open listbox or set aria-controls
    fireEvent.change(textarea, { target: { value: 'wif' } });
    expect(textarea).not.toHaveAttribute('aria-controls');

    // Enter opens listbox -> aria-controls="omni-listbox", no option active yet
    fireEvent.keyDown(textarea, { key: 'Enter' });
    const listbox = await screen.findByRole('listbox', { name: 'Kết quả tìm kiếm' });
    expect(listbox).toHaveAttribute('id', 'omni-listbox');
    expect(textarea).toHaveAttribute('aria-controls', 'omni-listbox');
    expect(textarea).not.toHaveAttribute('aria-activedescendant');

    // ArrowDown activates first option -> aria-activedescendant set
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    const firstOption = screen.getAllByRole('option')[0]!;
    expect(textarea).toHaveAttribute('aria-activedescendant', firstOption.id);
    expect(firstOption).toHaveAttribute('aria-selected', 'true');

    // Escape closes listbox -> aria-controls and aria-activedescendant removed
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(textarea).not.toHaveAttribute('aria-controls');
    expect(textarea).not.toHaveAttribute('aria-activedescendant');
  });

  it('sends 0 requests while typing; Enter opens listbox without changing URL; second Enter searches again; ArrowDown + Enter opens item; editing closes listbox; live region announces count', async () => {
    const itemsSpy = vi.spyOn(contentApi, 'itemsList').mockResolvedValue({
      items: [ITEM_WIFI, ITEM_WIFI_GUEST],
      next_cursor: null,
    });

    renderOmnibox();
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    // Typing -> 0 requests
    fireEvent.change(textarea, { target: { value: 'w' } });
    fireEvent.change(textarea, { target: { value: 'wi' } });
    fireEvent.change(textarea, { target: { value: 'wifi' } });
    expect(itemsSpy).not.toHaveBeenCalled();

    // First Enter -> GET /items?sort=alpha&q=wifi, URL unchanged, live region announces 2 results
    fireEvent.keyDown(textarea, { key: 'Enter' });
    const listbox = await screen.findByRole('listbox', { name: 'Kết quả tìm kiếm' });
    expect(itemsSpy).toHaveBeenCalledTimes(1);
    expect(itemsSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: 'alpha', q: 'wifi' }),
    );
    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(mockRouterReplace).not.toHaveBeenCalled();

    // Up to 3 tag chips + +1 overflow and entry count rendered inside the first option and included in its accessible name for WCAG 2.5.3 label-in-name (HM18A-R1-3, HM18A-R2-5)
    const firstOption = within(listbox).getAllByRole('option')[0]!;
    expect(within(firstOption).getByText('#nhà')).toBeInTheDocument();
    expect(within(firstOption).getByText('#ops')).toBeInTheDocument();
    expect(within(firstOption).getByText('#home-lab')).toBeInTheDocument();
    expect(within(firstOption).queryByText('#backup')).not.toBeInTheDocument();
    expect(within(firstOption).getByText('+1')).toBeInTheDocument();
    expect(within(firstOption).getByText('12 entry')).toBeInTheDocument();
    expect(firstOption).toHaveAttribute(
      'aria-label',
      'wifi #nhà #ops #home-lab Còn 1 tag nữa — 12 entry',
    );
    expect(
      within(listbox).getByRole('option', {
        name: 'wifi #nhà #ops #home-lab Còn 1 tag nữa — 12 entry',
      }),
    ).toBe(firstOption);
    expect(screen.getByTestId('omnibox-live')).toHaveTextContent('2 kết quả');
    // No option active after Enter -> pressing Enter a second time searches again
    expect(textarea).not.toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => {
      expect(itemsSpy).toHaveBeenCalledTimes(2);
    });
    expect(mockRouterPush).not.toHaveBeenCalled();

    // Editing the input closes the listbox immediately
    fireEvent.change(textarea, { target: { value: 'wifi ' } });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(textarea).not.toHaveAttribute('aria-controls');

    // Search again, then ArrowDown + Enter opens the item
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await screen.findByRole('listbox', { name: 'Kết quả tìm kiếm' });
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(mockRouterPush).toHaveBeenCalledWith(`/app/items/${ITEM_WIFI.id}`);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    // Mouse pointer sequence (mouseDown -> click) keeps focus on textarea via preventDefault and activates option (HM18A-R1-2)
    mockRouterPush.mockClear();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    const listbox2 = await screen.findByRole('listbox', { name: 'Kết quả tìm kiếm' });
    const secondOption = within(listbox2).getAllByRole('option')[1]!;
    const mouseDownEvt = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    secondOption.dispatchEvent(mouseDownEvt);
    expect(mouseDownEvt.defaultPrevented).toBe(true);
    fireEvent.click(secondOption);
    expect(mockRouterPush).toHaveBeenCalledWith(`/app/items/${ITEM_WIFI_GUEST.id}`);
  });

  it('shows empty prefix state in live region and last option "Tạo mục “…”" creates an item with no entry; Ctrl+Enter also creates an item with no entry', async () => {
    vi.spyOn(contentApi, 'itemsList').mockResolvedValue({
      items: [],
      next_cursor: null,
    });
    const createdItem: ItemSummary = {
      id: '3333cccc-3333-4333-8333-333333333333',
      name: 'thuế 2026',
      hint: null,
      tags: [],
      entry_count: 0,
      version: 1,
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-01T00:00:00Z',
      last_used_at: '2026-11-01T00:00:00Z',
    };
    const createSpy = vi.spyOn(contentApi, 'itemCreate').mockResolvedValue(createdItem);

    renderOmnibox();
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    fireEvent.change(textarea, { target: { value: 'thuế 2026' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const listbox = await screen.findByRole('listbox', { name: 'Kết quả tìm kiếm' });
    expect(screen.getByTestId('omnibox-live')).toHaveTextContent(
      'Không có mục bắt đầu bằng “thuế 2026”',
    );
    const createOption = within(listbox).getByRole('option', { name: /Tạo mục “thuế 2026”/ });
    expect(createOption).toBeInTheDocument();

    // Reachable by ArrowDown + Enter
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(textarea).toHaveAttribute('aria-activedescendant', createOption.id);
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    expect(createSpy).toHaveBeenCalledWith(
      { name: 'thuế 2026' },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    await waitFor(() => {
      expect(textarea).toHaveValue('');
    });

    // Ctrl+Enter directly in search mode (1 line, <= 200 runes) creates an item with no entry
    fireEvent.change(textarea, { target: { value: 'mục nhanh' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(2);
    });
    expect(createSpy).toHaveBeenLastCalledWith(
      { name: 'mục nhanh' },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });

  it('blocks multi-line and >200-rune search inputs on Enter with "Thêm tên và dấu : để lưu" (Q17) and sends nothing', () => {
    const itemsSpy = vi.spyOn(contentApi, 'itemsList');
    const createSpy = vi.spyOn(contentApi, 'itemCreate');

    renderOmnibox();
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    // Multi-line without ':' -> guard alert shown, 0 requests
    fireEvent.change(textarea, { target: { value: 'dòng 1\ndòng 2 bí mật' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(itemsSpy).not.toHaveBeenCalled();
    const guardAlert = screen.getByTestId('omnibox-guard-alert');
    expect(guardAlert).not.toHaveAttribute('hidden');
    expect(guardAlert).toHaveTextContent('Thêm tên và dấu : để lưu');

    // >200 runes single-line without ':' -> guard alert shown, 0 requests
    const long201 = 'a'.repeat(201);
    fireEvent.change(textarea, { target: { value: long201 } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(itemsSpy).not.toHaveBeenCalled();
    expect(guardAlert).not.toHaveAttribute('hidden');

    // Ctrl+Enter on >200 runes also sends nothing
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('filters tags client-side from rail cache in #… mode without network requests, navigates to /app?tag=<id> on Enter, and queries GET /tags?q=<token> only on Enter when not in cache', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(contentQueryKeys.tags({ sort: 'recent' }), {
      items: [TAG_NHA, TAG_OPS],
      next_cursor: null,
    });

    const tagsSpy = vi.spyOn(contentApi, 'tagsList').mockResolvedValue({
      items: [
        {
          id: 'cccc3333-3333-4333-8333-333333333333',
          display: 'cloud',
          item_count: 4,
          last_used_at: '2026-11-01T00:00:00Z',
          created_at: '2026-11-01T00:00:00Z',
        },
      ],
      next_cursor: null,
    });

    renderOmnibox(<Omnibox />, { queryClient });
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    // Typing #nh -> filters client-side from cache, 0 network requests, exact ICU live count with literal '#' (HM18A-R1-1, HM18A-R1-3)
    fireEvent.change(textarea, { target: { value: '#nh' } });
    expect(tagsSpy).not.toHaveBeenCalled();
    const listbox = screen.getByRole('listbox', { name: 'Kết quả lọc tag' });
    expect(textarea).toHaveAttribute('aria-controls', 'omni-listbox');
    expect(within(listbox).getByRole('option', { name: /#nhà/ })).toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: /#ops/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('omnibox-live')).toHaveTextContent('1 tag khớp #nh');

    // Enter on highlighted cached tag -> navigates to /app?tag=<id> (never tag name)
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(mockRouterPush).toHaveBeenCalledWith(`/app?tag=${TAG_NHA.id}`);
    expect(tagsSpy).not.toHaveBeenCalled();

    // Typing #clo (not in cache) -> still 0 requests while typing; empty state shown without empty role="listbox" (HM18A-R1-9)
    fireEvent.change(textarea, { target: { value: '#clo' } });
    expect(tagsSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('omnibox-tag-empty')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(textarea).not.toHaveAttribute('aria-controls');

    // Pressing Enter when not in cache -> sends GET /tags?q=clo and opens listbox with matching option
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => {
      expect(tagsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'alpha', q: 'clo' }),
      );
    });
    expect(await screen.findByRole('option', { name: /#cloud/ })).toBeInTheDocument();
    expect(screen.getByTestId('omnibox-live')).toHaveTextContent('1 tag khớp #clo');
    // >50-rune tag token -> blocked on Enter, 0 requests
    tagsSpy.mockClear();
    fireEvent.change(textarea, { target: { value: `#${'t'.repeat(51)}` } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(tagsSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('omnibox-guard-alert')).toHaveTextContent(
      viMessages.content.omnibox.tagGuardTitle,
    );
  });

  it('ignores Enter, Ctrl+Enter, Escape, and arrow keys while IME isComposing or keyCode === 229', () => {
    const itemsSpy = vi.spyOn(contentApi, 'itemsList');
    const createSpy = vi.spyOn(contentApi, 'itemCreate');

    renderOmnibox();
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    fireEvent.change(textarea, { target: { value: 'tiếng việt' } });
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true, isComposing: true });
    fireEvent.keyDown(textarea, { key: 'Escape', isComposing: true });

    expect(itemsSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('tiếng việt');
  });

  it('satisfies assertVaultSecretElementAttributes and assertNoPlaintextAttrs in both search mode and add mode', async () => {
    const sentinelSearch = 'SENTINEL_SEARCH_SECRET_991';
    const sentinelAdd = 'SENTINEL_ADD_BODY_992';

    vi.spyOn(contentApi, 'itemsList').mockResolvedValue({
      items: [],
      next_cursor: null,
    });

    const { container } = renderOmnibox();
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    // Search mode with text + empty result listbox open
    fireEvent.change(textarea, { target: { value: sentinelSearch } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await screen.findByRole('listbox', { name: 'Kết quả tìm kiếm' });

    assertVaultSecretElementAttributes(container);
    assertNoPlaintextAttrs(container, [sentinelSearch, sentinelAdd]);

    // Add mode with secret body
    fireEvent.change(textarea, { target: { value: `wifi #nhà: ${sentinelAdd}` } });
    assertVaultSecretElementAttributes(container);
    assertNoPlaintextAttrs(container, [sentinelSearch, sentinelAdd]);
  });

  it('discards in-flight search or server tag lookup results when the user edits the input or presses Escape so stale results never open (HM18A-R1-6, HM18A-R2-4)', async () => {
    const { promise: heldSearch, resolve: resolveHeldSearch } =
      Promise.withResolvers<contentApi.ItemList>();
    vi.spyOn(contentApi, 'itemsList').mockImplementation(() => heldSearch);

    renderOmnibox();
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    // 1. Start Enter search while listbox is closed, then edit input before response arrives
    fireEvent.change(textarea, { target: { value: 'old-query' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: 'new-edited-query' } });
    await act(async () => {
      resolveHeldSearch({ items: [ITEM_WIFI], next_cursor: null });
      await Promise.resolve();
    });

    // Stale response for 'old-query' is discarded and must NOT open the listbox
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(textarea).toHaveValue('new-edited-query');

    // 2. Start another Enter search, press Escape to clear while in-flight -> resolving must be discarded and NOT open the listbox
    const { promise: heldEscSearch, resolve: resolveEscSearch } =
      Promise.withResolvers<contentApi.ItemList>();
    vi.spyOn(contentApi, 'itemsList').mockImplementation(() => heldEscSearch);

    fireEvent.keyDown(textarea, { key: 'Enter' });
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(textarea).toHaveValue('');

    await act(async () => {
      resolveEscSearch({ items: [ITEM_WIFI], next_cursor: null });
      await Promise.resolve();
    });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    // 3. Server tag lookup path (`GET /tags?q=` on Enter when tag is not in cache):
    // resolving after the user edits the input is discarded and ignored (HM18A-R2-4).
    const { promise: heldTagLookup, resolve: resolveHeldTagLookup } =
      Promise.withResolvers<contentApi.TagList>();
    const tagsSpy = vi.spyOn(contentApi, 'tagsList').mockImplementation(() => heldTagLookup);

    fireEvent.change(textarea, { target: { value: '#clo' } });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(tagsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'alpha', q: 'clo' }),
    );

    // User changes input to search mode before `GET /tags?q=clo` resolves
    fireEvent.change(textarea, { target: { value: 'changed-after-tag-enter' } });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await act(async () => {
      resolveHeldTagLookup({
        items: [
          {
            id: 'cccc3333-3333-4333-8333-333333333333',
            display: 'cloud',
            item_count: 4,
            last_used_at: '2026-11-01T00:00:00Z',
            created_at: '2026-11-01T00:00:00Z',
          },
        ],
        next_cursor: null,
      });
      await Promise.resolve();
    });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /#cloud/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('omnibox-live')).toHaveTextContent('');
    expect(textarea).toHaveValue('changed-after-tag-enter');
  });

  it('clears textarea, closes listbox, clears live region, and removes seeded search queries from QueryCache on vault lock (P4FE3-5, P4FE4-8, HM18A-R1-7, HM18A-R2-6)', async () => {
    const secretQuery = 'pasted-secret-token-7788';
    const seededSecretQuery = 'seeded-cache-secret-8899';
    vi.spyOn(contentApi, 'itemsList').mockResolvedValue({
      items: [],
      next_cursor: null,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    // Seed a search query key with infinite gcTime so only `removeQueries` on lock can purge it (HM18A-R1-7)
    const seededKey = contentQueryKeys.items({ sort: 'alpha', q: seededSecretQuery });
    queryClient.setQueryData(seededKey, { items: [ITEM_WIFI], next_cursor: null });
    expect(queryClient.getQueryCache().find({ queryKey: seededKey })).toBeDefined();

    const { container } = renderOmnibox(<Omnibox />, { queryClient });
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    // Type a string in search mode and press Enter (empty result renders the string in DOM)
    fireEvent.change(textarea, { target: { value: secretQuery } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await screen.findByRole('listbox', { name: 'Kết quả tìm kiếm' });
    expect(container.textContent).toContain(secretQuery);

    // Lock the vault -> synchronous reset runs and `removeQueries` purges all omnibox search keys
    act(() => {
      triggerVaultLockReset();
    });

    expect(textarea).toHaveValue('');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByTestId('omnibox-live')).toHaveTextContent('');
    expect(container.innerHTML).not.toContain(secretQuery);
    assertNoPlaintextAttrs(container, [secretQuery, seededSecretQuery], { locked: true });
    expect(queryClient.getQueryCache().find({ queryKey: seededKey })).toBeUndefined();

    // Verify every QueryCache key and state is free of both search strings
    const allQueries = queryClient.getQueryCache().getAll();
    const serializedCache = JSON.stringify(
      allQueries.map((q) => ({ key: q.queryKey, data: q.state.data })),
    );
    expect(serializedCache).not.toContain(secretQuery);
    expect(serializedCache).not.toContain(seededSecretQuery);
  });

  it('discards in-flight search and in-flight Ctrl+Enter itemCreate when the vault locks so nothing opens, shows a toast, or appears in the DOM after lock (HM18A-R2-6)', async () => {
    const inFlightQuery = 'in-flight-lock-query-6611';
    const inFlightCreateName = 'in-flight-lock-create-7722';

    const { promise: heldSearch, resolve: resolveHeldSearch } =
      Promise.withResolvers<contentApi.ItemList>();
    const itemsSpy = vi.spyOn(contentApi, 'itemsList').mockImplementation(() => heldSearch);

    const { promise: heldCreate, resolve: resolveHeldCreate } =
      Promise.withResolvers<ItemSummary>();
    const createSpy = vi.spyOn(contentApi, 'itemCreate').mockImplementation(() => heldCreate);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const { container } = renderOmnibox(<Omnibox />, { queryClient });
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    // 1. Start search (`GET /items?q=`), then lock while the search promise is still in flight
    fireEvent.change(textarea, { target: { value: inFlightQuery } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(itemsSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    act(() => {
      triggerVaultLockReset();
    });
    expect(textarea).toHaveValue('');

    await act(async () => {
      resolveHeldSearch({
        items: [{ ...ITEM_WIFI, name: inFlightQuery }],
        next_cursor: null,
      });
      await Promise.resolve();
    });

    // Nothing opens or shows afterwards
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByTestId('omnibox-live')).toHaveTextContent('');
    expect(container.innerHTML).not.toContain(inFlightQuery);
    assertNoPlaintextAttrs(container, [inFlightQuery], { locked: true });

    // 2. Unlock, start `Ctrl+Enter` itemCreate (`POST /items`), then lock while the create promise is still in flight
    triggerVaultUnlock();
    fireEvent.change(textarea, { target: { value: inFlightCreateName } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(createSpy).toHaveBeenCalledTimes(1);

    act(() => {
      triggerVaultLockReset();
    });
    expect(textarea).toHaveValue('');

    await act(async () => {
      resolveHeldCreate({
        ...ITEM_WIFI,
        id: '88888888-8888-4888-8888-888888888888',
        name: inFlightCreateName,
        tags: [],
        entry_count: 0,
      });
      await Promise.resolve();
    });

    // Resolving after lock produces no listbox, no Undo toast with the name, and nothing in the DOM
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByTestId('undo-toast-item')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(inFlightCreateName);
    expect(container.innerHTML).not.toContain(inFlightCreateName);
    assertNoPlaintextAttrs(document.body, [inFlightCreateName], { locked: true });
  });
  it('renders English strings with zero hard-coded Vietnamese in en locale (UIA-2, UIA-20, HM18A-R1-1, HM18A-R1-3, HM18A-R1-10, HM18A-R1-11)', async () => {
    vi.spyOn(contentApi, 'itemsList').mockResolvedValue({
      items: [],
      next_cursor: null,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(contentQueryKeys.tags({ sort: 'recent' }), {
      items: [TAG_OPS],
      next_cursor: null,
    });

    const { container } = renderOmnibox(<Omnibox />, { locale: 'en', queryClient });
    const textarea = screen.getByRole('textbox', { name: 'Search or save' });

    expect(textarea).toHaveAttribute('placeholder', enMessages.content.omnibox.placeholder);
    expect(enMessages.content.omnibox.placeholder.length).toBeLessThanOrEqual(26);

    fireEvent.change(textarea, { target: { value: '#op' } });
    expect(screen.getByTestId('omnibox-live')).toHaveTextContent('1 matching tag for #op');

    fireEvent.change(textarea, { target: { value: 'router' } });
    const hint = screen.getByTestId('omnibox-hint');
    expect(hint).toHaveTextContent(
      'Enter: search by name prefix · Ctrl+Enter: create item with this name — typed text is sent to the server, not encrypted. To save content, type name: content',
    );
    expect(hint.querySelector('span.mono')?.textContent).toBe('name: content');

    fireEvent.keyDown(textarea, { key: 'Enter' });
    await screen.findByRole('listbox', { name: 'Search results' });
    expect(
      within(screen.getByTestId('omnibox-search-empty')).getByText(
        'No items starting with “router”',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Create item “router”/ })).toBeInTheDocument();

    // Ensure no Vietnamese diacritics appear anywhere in the rendered English omnibox DOM
    expect(container.textContent).not.toMatch(/[àáảãạăắằẳẵặâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]/i);

    // Source check: omnibox.tsx has no hard-coded Vietnamese characters
    const source = readFileSync(
      resolve(__dirname, '../../components/app-shell/omnibox.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/[àáảãạăắằẳẵặâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]/i);
  });
});

describe('Omnibox — P04-T18b quick-add preview, lookup on Enter, U9 picker, save plan, retry, Undo, and lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockRouterPush.mockClear();
    mockRouterReplace.mockClear();
    registeredResetFns.clear();
    mockSealEntryCalls.length = 0;
    mockVaultState = 'unlocked';
    mockVaultGeneration = 1;
    mockVaultMetaOverride = undefined;
    mockReloadVaultMeta.mockReset();
    mockReloadVaultMeta.mockResolvedValue({ vault_key_id: TEST_KEY_ID, version: 1 });
    clearSaveUnconfirmed();
    clearLockClearedNotice();
    setKnownDeviceSessionUserId(USER_A_ID);
    document.cookie = 'sabk_csrf=v1.sess.test; path=/';
  });

  function makeEntryMeta(itemId: string, entryId: string, position = 0): EntryMeta {
    return {
      id: entryId,
      item_id: itemId,
      type: 'text',
      position,
      version: 1,
      plaintext_len_bucket: 256,
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-01T00:00:00Z',
    };
  }

  it('renders local add preview (target name + deduplicated tags, no match count before Enter), content.privacy line, body-empty hint, Q5 word-between-tags error, name > 200 runes block, JSON banner (action hidden until Milestone C), and locked "Mở khoá để lưu" button', () => {
    const lookupSpy = vi.spyOn(contentApi, 'itemsLookupExact');
    const itemCreateSpy = vi.spyOn(contentApi, 'itemCreate');

    const { rerender, queryClient } = renderOmnibox();
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    // 1. Valid add draft with duplicate normalized tags (#Nhà #nhà -> 1 tag)
    fireEvent.change(textarea, { target: { value: 'wifi #Nhà #nhà #ops: mk-bi-mat-123' } });
    const preview = screen.getByTestId('omnibox-add-preview');
    expect(preview).toBeInTheDocument();
    expect(screen.getByTestId('omnibox-add-dest-label')).toHaveTextContent('Sẽ lưu vào wifi');
    const destTags = screen.getByTestId('omnibox-add-dest-tags');
    expect(within(destTags).getByText('#Nhà')).toBeInTheDocument();
    expect(within(destTags).getByText('#ops')).toBeInTheDocument();
    expect(within(destTags).queryByText('#nhà')).not.toBeInTheDocument();
    expect(screen.getByTestId('omnibox-add-privacy')).toHaveTextContent(
      viMessages.content.privacy.notice,
    );
    // Nothing sent before Enter
    expect(lookupSpy).not.toHaveBeenCalled();

    // 2. Empty body after `:` -> soft hint "Gõ nội dung sau dấu :", Enter blocked
    fireEvent.change(textarea, { target: { value: 'wifi #nhà:   ' } });
    const errBox = screen.getByTestId('omnibox-add-error');
    expect(errBox).toHaveAttribute('role', 'status');
    expect(errBox).toHaveTextContent('Gõ nội dung sau dấu :');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(lookupSpy).not.toHaveBeenCalled();

    // 3. Q5 words between tags -> error "Tag không có khoảng trắng; dùng chip để gắn tag có khoảng trắng", Enter blocked
    fireEvent.change(textarea, { target: { value: 'wifi #nhà bố mẹ: nội dung' } });
    expect(screen.getByTestId('omnibox-add-error')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('omnibox-add-error')).toHaveTextContent(
      'Tag không có khoảng trắng; dùng chip để gắn tag có khoảng trắng',
    );
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(lookupSpy).not.toHaveBeenCalled();

    // 4. Name invalid ("!!!") or > 200 runes -> no lookup on Enter
    fireEvent.change(textarea, { target: { value: '!!!: nội dung' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(lookupSpy).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: `${'n'.repeat(201)}: nội dung` } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(lookupSpy).not.toHaveBeenCalled();

    // 5. JSON candidate body -> shows banner "Phát hiện JSON — Lưu như bảng", action button hidden until Milestone C, never auto-coerces type
    fireEvent.change(textarea, { target: { value: 'wifi: {"ssid":"Zone17","vlan":10}' } });
    const jsonBanner = screen.getByTestId('omnibox-json-banner');
    expect(jsonBanner).toHaveTextContent('Phát hiện JSON — Lưu như bảng');
    expect(screen.getByTestId('omnibox-json-banner-action')).toHaveAttribute('hidden');
    expect(preview).toHaveTextContent('text · E2E');

    // 6. Locked vault -> shows "Mở khoá để lưu" button, Enter does not fire lookup
    mockVaultState = 'locked';
    rerender(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <QueryClientProvider client={queryClient}>
          <UndoToastProvider>
            <Omnibox />
          </UndoToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    const unlockBtn = screen.getByTestId('omnibox-unlock-to-save-btn');
    expect(unlockBtn).toHaveTextContent('Mở khoá để lưu');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(unlockBtn).toHaveFocus();
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(itemCreateSpy).not.toHaveBeenCalled();
  });

  it('handles 0, 1, and >=2 lookup matches on Enter (picker U9 selecting 2nd item or creating 3rd item) and Ctrl+Enter in add mode always creates a new item with entry', async () => {
    const dupItem1: ItemSummary = {
      ...ITEM_WIFI,
      id: '11111111-1111-4111-8111-111111111111',
      name: 'wifi',
      entry_count: 5,
    };
    const dupItem2: ItemSummary = {
      ...ITEM_WIFI,
      id: '22222222-2222-4222-8222-222222222222',
      name: 'wifi',
      hint: 'Tầng 4',
      tags: [{ id: TAG_OPS.id, display: TAG_OPS.display }],
      entry_count: 2,
    };

    const lookupSpy = vi.spyOn(contentApi, 'itemsLookupExact');
    const itemCreateSpy = vi
      .spyOn(contentApi, 'itemCreate')
      .mockImplementation(async (body) => ({
        id: body.id ?? '99999999-9999-4999-8999-999999999999',
        name: body.name,
        hint: null,
        tags: [],
        entry_count: 0,
        version: 1,
        created_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-01T00:00:00Z',
        last_used_at: '2026-11-01T00:00:00Z',
      }));
    const tagUpsertSpy = vi.spyOn(contentApi, 'tagUpsert').mockResolvedValue(TAG_NHA);
    const itemTagsAddSpy = vi.spyOn(contentApi, 'itemTagsAdd').mockResolvedValue(dupItem1);
    const entryCreateSpy = vi
      .spyOn(contentApi, 'entryCreate')
      .mockImplementation(async (itemId, body) => makeEntryMeta(itemId, body.id));

    renderOmnibox();
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    // Case A: 0 matches -> creates item, upserts tag, assigns tag, creates sealed entry
    lookupSpy.mockResolvedValueOnce({ items: [], total: 0, next_cursor: null });
    fireEvent.change(textarea, { target: { value: 'mục-mới #nhà: nội dung 0 khớp' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(entryCreateSpy).toHaveBeenCalledTimes(1);
    });
    expect(lookupSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'mục-mới' }));
    expect(itemCreateSpy).toHaveBeenCalledTimes(1);
    const createdNewId = itemCreateSpy.mock.calls[0]?.[0]?.id;
    expect(createdNewId).toMatch(/^[0-9a-f-]{36}$/);
    expect(tagUpsertSpy).toHaveBeenCalledWith(
      { display: 'nhà' },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(itemTagsAddSpy).toHaveBeenCalledWith(
      createdNewId,
      { tag_ids: [TAG_NHA.id] },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(entryCreateSpy).toHaveBeenLastCalledWith(
      createdNewId,
      expect.objectContaining({ type: 'text' }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(textarea).toHaveValue('');

    // Case B: 1 match -> appends directly to that existing item ID without calling itemCreate
    itemCreateSpy.mockClear();
    entryCreateSpy.mockClear();
    lookupSpy.mockResolvedValueOnce({ items: [dupItem1], total: 1, next_cursor: null });
    fireEvent.change(textarea, { target: { value: 'wifi: nội dung 1 khớp' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(entryCreateSpy).toHaveBeenCalledTimes(1);
    });
    expect(itemCreateSpy).not.toHaveBeenCalled();
    expect(entryCreateSpy).toHaveBeenCalledWith(
      dupItem1.id,
      expect.objectContaining({ type: 'text' }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );

    // Case C: 2 matches -> opens picker U9; ArrowDown to choose the 2nd item -> entry lands on dupItem2.id
    itemCreateSpy.mockClear();
    entryCreateSpy.mockClear();
    lookupSpy.mockResolvedValueOnce({
      items: [dupItem1, dupItem2],
      total: 2,
      next_cursor: null,
    });
    fireEvent.change(textarea, { target: { value: 'wifi: nội dung chọn mục 2' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const pickerDialog = await screen.findByTestId('dup-picker-dialog');
    const pickerListbox = within(pickerDialog).getByRole('listbox', {
      name: 'Chọn mục đích cho wifi',
    });
    const pickerOptions = within(pickerListbox).getAllByRole('option');
    expect(pickerOptions).toHaveLength(3); // 2 items + "Tạo mục mới cùng tên"

    // Move to 2nd option (index 1 = dupItem2) and press Enter
    fireEvent.keyDown(pickerDialog, { key: 'ArrowDown' });
    expect(pickerOptions[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(pickerDialog, { key: 'Enter' });

    await waitFor(() => {
      expect(entryCreateSpy).toHaveBeenCalledTimes(1);
    });
    expect(itemCreateSpy).not.toHaveBeenCalled();
    expect(entryCreateSpy).toHaveBeenCalledWith(
      dupItem2.id,
      expect.objectContaining({ type: 'text' }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(textarea).toHaveFocus();
    // Case C2: 2 matches -> Escape closes the dialog before unmount and restores focus to the omnibox (HM18B-R1-2)
    lookupSpy.mockResolvedValueOnce({
      items: [dupItem1, dupItem2],
      total: 2,
      next_cursor: null,
    });
    fireEvent.change(textarea, { target: { value: 'wifi: nội dung thử đóng bằng Esc' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const pickerDialogEsc = await screen.findByTestId('dup-picker-dialog');
    fireEvent.keyDown(pickerDialogEsc, { key: 'Escape' });
    expect(screen.queryByTestId('dup-picker-dialog')).not.toBeInTheDocument();
    expect(textarea).toHaveFocus();
    expect(textarea).toHaveValue('wifi: nội dung thử đóng bằng Esc');

    // Case D: 2 matches -> choose "Tạo mục mới cùng tên" -> creates a 3rd item with entry
    itemCreateSpy.mockClear();
    entryCreateSpy.mockClear();
    lookupSpy.mockResolvedValueOnce({
      items: [dupItem1, dupItem2],
      total: 2,
      next_cursor: null,
    });
    fireEvent.change(textarea, { target: { value: 'wifi: nội dung tạo mục thứ 3' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const pickerDialog2 = await screen.findByTestId('dup-picker-dialog');
    const createSameNameBtn = within(pickerDialog2).getByTestId('dup-picker-create-same-name');
    expect(createSameNameBtn).toHaveTextContent('Tạo mục mới cùng tên');
    fireEvent.click(createSameNameBtn);
    // A duplicate click while the pick/plan is already starting does not start a second plan (HM18B-R1-8)
    fireEvent.click(createSameNameBtn);

    await waitFor(() => {
      expect(entryCreateSpy).toHaveBeenCalledTimes(1);
    });
    expect(itemCreateSpy).toHaveBeenCalledTimes(1);
    const thirdItemId = itemCreateSpy.mock.calls[0]?.[0]?.id;
    expect(thirdItemId).not.toBe(dupItem1.id);
    expect(thirdItemId).not.toBe(dupItem2.id);
    expect(entryCreateSpy).toHaveBeenCalledWith(
      thirdItemId,
      expect.objectContaining({ type: 'text' }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );

    // Case E: Ctrl+Enter in add mode when a same-name item exists -> skips lookup, always creates a new item with entry
    lookupSpy.mockClear();
    itemCreateSpy.mockClear();
    entryCreateSpy.mockClear();
    fireEvent.change(textarea, { target: { value: 'wifi: nội dung ctrl+enter luôn tạo mới' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    await waitFor(() => {
      expect(entryCreateSpy).toHaveBeenCalledTimes(1);
    });
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(itemCreateSpy).toHaveBeenCalledTimes(1);
    const ctrlEnterItemId = itemCreateSpy.mock.calls[0]?.[0]?.id;
    expect(entryCreateSpy).toHaveBeenCalledWith(
      ctrlEnterItemId,
      expect.objectContaining({ type: 'text' }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });

  it('blocks Enter with message and sends 0 write requests when 21 tags are entered or when target item has 18 tags + 3 new tags; deduplicates #Nhà #nhà into one tag', async () => {
    const existing18Tags = Array.from({ length: 18 }, (_, i) => ({
      id: `tag-${i + 1}`,
      display: `existing-${i + 1}`,
    }));
    const itemWith18Tags: ItemSummary = {
      ...ITEM_WIFI,
      tags: existing18Tags,
    };

    const lookupSpy = vi.spyOn(contentApi, 'itemsLookupExact').mockResolvedValue({
      items: [itemWith18Tags],
      total: 1,
      next_cursor: null,
    });
    const itemCreateSpy = vi.spyOn(contentApi, 'itemCreate');
    const tagUpsertSpy = vi.spyOn(contentApi, 'tagUpsert').mockResolvedValue(TAG_NHA);
    const itemTagsAddSpy = vi.spyOn(contentApi, 'itemTagsAdd').mockResolvedValue(itemWith18Tags);
    const entryCreateSpy = vi
      .spyOn(contentApi, 'entryCreate')
      .mockImplementation(async (itemId, body) => makeEntryMeta(itemId, body.id));

    renderOmnibox();
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    // 1. 21 tags in input -> blocked before lookup
    const tags21 = Array.from({ length: 21 }, (_, i) => `#t${i + 1}`).join(' ');
    fireEvent.change(textarea, { target: { value: `wifi ${tags21}: body` } });
    expect(screen.getByTestId('omnibox-add-error')).toHaveTextContent(
      'Đã nhập 21 tag; tối đa 20 tag mỗi mục.',
    );
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(tagUpsertSpy).not.toHaveBeenCalled();

    // 2. Target item has 18 tags + 3 new unassigned tags = 21 -> blocked after lookup with "Mục này đã có 18 tag; tối đa 20", 0 write requests
    fireEvent.change(textarea, {
      target: { value: 'wifi #new1 #new2 #new3: body vượt trần 20' },
    });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const alert = await screen.findByTestId('omnibox-add-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('Mục này đã có 18 tag; tối đa 20');
    expect(itemCreateSpy).not.toHaveBeenCalled();
    expect(tagUpsertSpy).not.toHaveBeenCalled();
    expect(itemTagsAddSpy).not.toHaveBeenCalled();
    expect(entryCreateSpy).not.toHaveBeenCalled();

    // 3. `#Nhà #nhà` deduplicates to 1 tag -> only 1 tagUpsert call
    lookupSpy.mockResolvedValueOnce({ items: [], total: 0, next_cursor: null });
    vi.spyOn(contentApi, 'itemCreate').mockResolvedValueOnce(ITEM_WIFI);
    fireEvent.change(textarea, { target: { value: 'wifi #Nhà #nhà: body gộp tag' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(entryCreateSpy).toHaveBeenCalledTimes(1);
    });
    expect(tagUpsertSpy).toHaveBeenCalledTimes(1);
    expect(tagUpsertSpy).toHaveBeenCalledWith(
      { display: 'Nhà' },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });

  it('preserves draft and save plan on step failure (timeout/network) and resumes from the failed step with the exact same Idempotency-Key and sealed payload without re-sealing (A3)', async () => {
    vi.spyOn(contentApi, 'itemsLookupExact').mockResolvedValue({
      items: [],
      total: 0,
      next_cursor: null,
    });

    let itemCreateAttempts = 0;
    const itemCreateSpy = vi
      .spyOn(contentApi, 'itemCreate')
      .mockImplementation(async (body) => {
        itemCreateAttempts += 1;
        if (itemCreateAttempts === 1) {
          throw new TypeError('Failed to fetch: simulated timeout after POST /items');
        }
        return {
          ...ITEM_WIFI,
          id: body.id ?? ITEM_WIFI.id,
          name: body.name,
        };
      });

    const tagUpsertSpy = vi.spyOn(contentApi, 'tagUpsert').mockResolvedValue(TAG_NHA);
    const itemTagsAddSpy = vi.spyOn(contentApi, 'itemTagsAdd').mockResolvedValue(ITEM_WIFI);

    let entryCreateAttempts = 0;
    const entryCreateSpy = vi
      .spyOn(contentApi, 'entryCreate')
      .mockImplementation(async (itemId, body) => {
        entryCreateAttempts += 1;
        if (entryCreateAttempts === 1) {
          throw new TypeError('Failed to fetch: simulated timeout after POST /entries');
        }
        return makeEntryMeta(itemId, body.id);
      });

    renderOmnibox();
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    fireEvent.change(textarea, {
      target: { value: 'router #nhà: cấu hình PPPoE ISP' },
    });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    // 1. Fails at `POST /items` -> draft and plan stay, Retry button shown, sealEntry called ONCE
    const planError1 = await screen.findByTestId('omnibox-plan-error');
    expect(planError1).toHaveTextContent(/Tạo mục “router”/);
    expect(textarea).toHaveValue('router #nhà: cấu hình PPPoE ISP');
    expect(mockSealEntryCalls).toHaveLength(1);
    const firstItemId = itemCreateSpy.mock.calls[0]?.[0]?.id;
    const firstItemKey = itemCreateSpy.mock.calls[0]?.[1]?.idempotencyKey;
    expect(entryCreateSpy).not.toHaveBeenCalled();

    // 2. Click "Thử lại" -> resumes from `POST /items` with same itemId + Idempotency-Key, then fails at `POST /entries`
    fireEvent.click(screen.getByTestId('omnibox-retry-plan-btn'));

    await waitFor(() => {
      expect(entryCreateSpy).toHaveBeenCalledTimes(1);
    });
    expect(itemCreateSpy).toHaveBeenCalledTimes(2);
    expect(itemCreateSpy.mock.calls[1]?.[0]?.id).toBe(firstItemId);
    expect(itemCreateSpy.mock.calls[1]?.[1]?.idempotencyKey).toBe(firstItemKey);
    expect(mockSealEntryCalls).toHaveLength(1); // Never re-sealed!

    const firstEntryBody = entryCreateSpy.mock.calls[0]?.[1];
    const firstEntryKey = entryCreateSpy.mock.calls[0]?.[2]?.idempotencyKey;
    expect(screen.getByTestId('omnibox-plan-error')).toHaveTextContent(
      /Mã hoá & lưu entry text/,
    );

    // 3. Click "Thử lại" again -> skips already-done item/tags/assign steps and replays ONLY `POST /entries` with same key + bytes
    fireEvent.click(screen.getByTestId('omnibox-retry-plan-btn'));

    await waitFor(() => {
      expect(entryCreateSpy).toHaveBeenCalledTimes(2);
    });
    expect(itemCreateSpy).toHaveBeenCalledTimes(2); // Not called again
    expect(tagUpsertSpy).toHaveBeenCalledTimes(1); // Not called again
    expect(itemTagsAddSpy).toHaveBeenCalledTimes(1); // Not called again
    expect(mockSealEntryCalls).toHaveLength(1); // Still sealed only once
    expect(entryCreateSpy.mock.calls[1]?.[1]).toEqual(firstEntryBody);
    expect(entryCreateSpy.mock.calls[1]?.[2]?.idempotencyKey).toBe(firstEntryKey);

    // Toast "Đã lưu vào “router”" shown only after entry 201
    await waitFor(() => {
      expect(textarea).toHaveValue('');
    });
    const routerToast = await screen.findByTestId('undo-toast-item');
    expect(within(routerToast).getByText(/Đã lưu vào “router”/)).toBeInTheDocument();
  });

  it('Undo calls ONLY entryDelete for the saved entry ID and never calls itemDelete, tagDelete, or itemTagRemove (Q18, P4BE1-2, HM18B-R1-6)', async () => {
    vi.spyOn(contentApi, 'itemsLookupExact').mockResolvedValue({
      items: [],
      total: 0,
      next_cursor: null,
    });

    const itemCreateSpy = vi
      .spyOn(contentApi, 'itemCreate')
      .mockImplementation(async (body) => ({
        ...ITEM_WIFI,
        id: body.id ?? 'new-item-id',
        name: body.name,
        tags: [],
        entry_count: 0,
      }));
    const itemDeleteSpy = vi.spyOn(contentApi, 'itemDelete');
    const tagDeleteSpy = vi.spyOn(contentApi, 'tagDelete');
    const itemTagRemoveSpy = vi.spyOn(contentApi, 'itemTagRemove');

    vi.spyOn(contentApi, 'tagUpsert').mockResolvedValue(TAG_NHA);
    vi.spyOn(contentApi, 'itemTagsAdd').mockResolvedValue(ITEM_WIFI);
    const entryCreateSpy = vi
      .spyOn(contentApi, 'entryCreate')
      .mockImplementation(async (itemId, body) => makeEntryMeta(itemId, body.id));
    const entryDeleteSpy = vi
      .spyOn(contentApi, 'entryDelete')
      .mockResolvedValue(undefined);

    renderOmnibox();
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    fireEvent.change(textarea, { target: { value: 'wifi #nhà: entry của thiết bị A' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const toast = await screen.findByTestId('undo-toast-item');
    expect(within(toast).getByText('Đã lưu vào “wifi”')).toBeInTheDocument();
    expect(within(toast).getByTestId('undo-toast-detail')).toHaveTextContent(
      'Hoàn tác chỉ xoá nội dung vừa lưu; mục và tag vẫn giữ',
    );

    expect(itemCreateSpy).toHaveBeenCalledTimes(1);
    expect(entryCreateSpy).toHaveBeenCalledTimes(1);
    const entryAId = entryCreateSpy.mock.calls[0]?.[1]?.id ?? '';
    expect(entryAId).toMatch(/^[0-9a-f-]{36}$/);

    fireEvent.click(within(toast).getByRole('button', { name: /Hoàn tác/ }));

    await waitFor(() => {
      expect(entryDeleteSpy).toHaveBeenCalledTimes(1);
    });
    expect(entryDeleteSpy).toHaveBeenCalledWith(
      entryAId,
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(itemDeleteSpy).not.toHaveBeenCalled();
    expect(tagDeleteSpy).not.toHaveBeenCalled();
    expect(itemTagRemoveSpy).not.toHaveBeenCalled();
    expect(textarea).toHaveFocus();
  });

  it('makes the textarea readOnly + aria-busy while the save plan is in flight and never silently destroys text if the textarea value diverges before completion (HM18B-R1-3)', async () => {
    vi.spyOn(contentApi, 'itemsLookupExact').mockResolvedValue({
      items: [ITEM_WIFI],
      total: 1,
      next_cursor: null,
    });

    const { promise: entryPromise, resolve: resolveEntry } = Promise.withResolvers<EntryMeta>();
    vi.spyOn(contentApi, 'entryCreate').mockImplementation(() => entryPromise);

    renderOmnibox();
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: 'wifi: đang lưu bản nháp 1' } });
    expect(textarea).not.toHaveAttribute('readonly');
    expect(textarea).not.toHaveAttribute('aria-busy');

    fireEvent.keyDown(textarea, { key: 'Enter' });

    // Wait until plan is running
    await screen.findByTestId('omnibox-save-plan');
    expect(textarea).toHaveAttribute('readonly');
    expect(textarea).toHaveAttribute('aria-busy', 'true');

    // Attempting to type via onChange while running is ignored and keeps the submitted draft intact
    fireEvent.change(textarea, { target: { value: 'wifi: gõ đè khi đang chạy' } });
    expect(textarea).toHaveValue('wifi: đang lưu bản nháp 1');

    // Even if a script or external setter mutates `textarea.value` to new text before completion,
    // completion will NOT wipe the diverged text.
    textarea.value = 'ghi chú mới gõ thêm';
    resolveEntry(makeEntryMeta(ITEM_WIFI.id, '00000000-0000-4000-8000-000000000099'));

    await screen.findByTestId('undo-toast-item');
    expect(textarea).not.toHaveAttribute('readonly');
    expect(textarea).not.toHaveAttribute('aria-busy');
    expect(textarea.value).toBe('ghi chú mới gõ thêm');
  });

  it('supports Ctrl+Z right after quick-add save, keeps native undo after typing a character, gives >= 10 s toast duration on keyboard save, and supports 4 consecutive saves via both "+1" overflow and repeated Ctrl+Z', async () => {
    vi.spyOn(contentApi, 'itemsLookupExact').mockResolvedValue({
      items: [ITEM_WIFI],
      total: 1,
      next_cursor: null,
    });
    vi.spyOn(contentApi, 'entryCreate').mockImplementation(async (itemId, body) =>
      makeEntryMeta(itemId, body.id),
    );
    const deletedEntryIds: string[] = [];
    const entryDeleteSpy = vi
      .spyOn(contentApi, 'entryDelete')
      .mockImplementation(async (entryId) => {
        deletedEntryIds.push(entryId);
      });

    renderOmnibox();
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });
    textarea.focus();

    // 1. Save via Enter -> omnibox is cleared & focused -> Ctrl+Z triggers quick-add Undo (entryDelete)
    fireEvent.change(textarea, { target: { value: 'wifi: lưu lần 1' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await screen.findByTestId('undo-toast-item');
    expect(textarea).toHaveValue('');
    expect(textarea).toHaveFocus();

    fireEvent.keyDown(textarea, { key: 'z', ctrlKey: true });
    await waitFor(() => {
      expect(entryDeleteSpy).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('undo-toast-item')).not.toBeInTheDocument();

    // 2. Save again, then type one character in omnibox -> Ctrl+Z does NOT trigger toast Undo (leaves native undo)
    entryDeleteSpy.mockClear();
    fireEvent.change(textarea, { target: { value: 'wifi: lưu lần 2' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await screen.findByTestId('undo-toast-item');

    fireEvent.change(textarea, { target: { value: 'a' } });
    fireEvent(textarea, new Event('input', { bubbles: true }));
    const ctrlZEvent = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(ctrlZEvent);
    expect(ctrlZEvent.defaultPrevented).toBe(false);
    expect(entryDeleteSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('undo-toast-item')).toBeInTheDocument();

    // Dismiss current toast before 4-save stack test
    fireEvent.click(within(screen.getByTestId('undo-toast-item')).getByRole('button', { name: /Hoàn tác/ }));
    await waitFor(() => {
      expect(screen.queryByTestId('undo-toast-item')).not.toBeInTheDocument();
    });

    // 3. 4 consecutive saves -> max 3 visible + "+1" overflow button; clicking "+1" reveals the 4th; pressing Ctrl+Z 4 times undoes all 4 LIFO
    deletedEntryIds.length = 0;
    const savedEntryIds: string[] = [];
    vi.spyOn(contentApi, 'entryCreate').mockImplementation(async (itemId, body) => {
      savedEntryIds.push(body.id);
      return makeEntryMeta(itemId, body.id);
    });

    for (let i = 1; i <= 4; i += 1) {
      fireEvent.change(textarea, { target: { value: `wifi: stack-${i}` } });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      await waitFor(() => {
        expect(savedEntryIds).toHaveLength(i);
      });
    }

    expect(screen.getAllByTestId('undo-toast-item')).toHaveLength(3);
    const expandBtn = screen.getByTestId('undo-toast-overflow');
    expect(expandBtn).toHaveTextContent('+1');

    // Clicking "+1" reveals all 4 toasts
    fireEvent.click(expandBtn);
    expect(screen.getAllByTestId('undo-toast-item')).toHaveLength(4);

    // Pressing Ctrl+Z 4 times while omnibox is empty undoes all 4 in LIFO order
    textarea.focus();
    for (let i = 0; i < 4; i += 1) {
      fireEvent.keyDown(textarea, { key: 'z', ctrlKey: true });
    }
    await waitFor(() => {
      expect(deletedEntryIds).toHaveLength(4);
    });
    expect(deletedEntryIds).toEqual([...savedEntryIds].reverse());
  });

  it('handles pre-lookup recovery (SPEC §3.4, dec-119/120): replays same Idempotency-Key on csrf_invalid or refreshed unauthenticated, and drops plan + shows user-scoped saveUnconfirmed notice on session_invalid', async () => {
    vi.spyOn(contentApi, 'itemsLookupExact').mockResolvedValue({
      items: [ITEM_WIFI],
      total: 1,
      next_cursor: null,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['auth', 'me'], { user: { id: USER_A_ID } });

    const { rerender } = renderOmnibox(<Omnibox />, { queryClient });
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    // Part 1: Lost response on first send, then `csrf_invalid` on retry -> `contentMutate` bootstraps `/auth/csrf` and replays same Idempotency-Key -> 1 entry
    const seenEntryKeys: string[] = [];
    let fetchCallCount = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/auth/csrf')) {
        document.cookie = 'sabk_csrf=v1.sess.refreshed; path=/';
        return new Response(null, { status: 204 });
      }
      if (url.includes('/entries')) {
        fetchCallCount += 1;
        const headers = new Headers(init?.headers);
        seenEntryKeys.push(headers.get('Idempotency-Key') ?? '');
        if (fetchCallCount === 1) {
          throw new TypeError('Failed to fetch: lost response');
        }
        if (fetchCallCount === 2) {
          return new Response(
            JSON.stringify({
              type: 'https://engram.zone17.click/problems/csrf_invalid',
              title: 'CSRF invalid',
              status: 403,
              code: 'csrf_invalid',
            }),
            { status: 403, headers: { 'content-type': 'application/problem+json' } },
          );
        }
        const parsedBody = JSON.parse(String(init?.body ?? '{}')) as { id: string };
        return new Response(JSON.stringify(makeEntryMeta(ITEM_WIFI.id, parsedBody.id)), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    fireEvent.change(textarea, { target: { value: 'wifi: test csrf replay' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(textarea).toHaveValue('');
    });
    expect(seenEntryKeys.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seenEntryKeys).size).toBe(1); // Exact same Idempotency-Key across all attempts
    fetchSpy.mockRestore();

    // Part 1b: Lost response on first send, then `401 unauthenticated` with session CSRF evidence -> `authMutate` refreshes `/auth/refresh` and replays same Idempotency-Key -> 1 entry
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (_name: string, cb: () => Promise<unknown>) => cb(),
      },
    });
    const sessionCsrfPayload = btoa('v1|sess|user-a|exp|nonce').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    document.cookie = `sabk_csrf=${sessionCsrfPayload}.sig; path=/`;
    const seenUnauthEntryKeys: string[] = [];
    let unauthEntryCallCount = 0;
    const unauthFetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/auth/me')) {
        return new Response(
          JSON.stringify({
            type: 'https://engram.zone17.click/problems/unauthenticated',
            title: 'Unauthenticated',
            status: 401,
            code: 'unauthenticated',
          }),
          { status: 401, headers: { 'content-type': 'application/problem+json' } },
        );
      }
      if (url.endsWith('/auth/refresh')) {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/entries')) {
        unauthEntryCallCount += 1;
        const headers = new Headers(init?.headers);
        seenUnauthEntryKeys.push(headers.get('Idempotency-Key') ?? '');
        if (unauthEntryCallCount === 1) {
          throw new TypeError('Failed to fetch: lost response before unauthenticated');
        }
        if (unauthEntryCallCount === 2) {
          return new Response(
            JSON.stringify({
              type: 'https://engram.zone17.click/problems/unauthenticated',
              title: 'Unauthenticated',
              status: 401,
              code: 'unauthenticated',
            }),
            { status: 401, headers: { 'content-type': 'application/problem+json' } },
          );
        }
        const parsedBody = JSON.parse(String(init?.body ?? '{}')) as { id: string };
        return new Response(JSON.stringify(makeEntryMeta(ITEM_WIFI.id, parsedBody.id)), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    fireEvent.change(textarea, { target: { value: 'wifi: test unauthenticated refresh replay' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(textarea).toHaveValue('');
    });
    expect(seenUnauthEntryKeys).toHaveLength(3);
    expect(new Set(seenUnauthEntryKeys).size).toBe(1);
    unauthFetchSpy.mockRestore();

    // Part 2a (HM18B-R1-5): A first-attempt `session_invalid` (no prior uncertain send, `priorUncertain === false`)
    // drops the plan and draft, and does NOT record `saveUnconfirmed` (SPEC §3.4 case b requires an uncertain earlier send).
    const firstAttemptSessionInvalidSpy = vi
      .spyOn(contentApi, 'entryCreate')
      .mockRejectedValueOnce(
        new ProblemError({
          type: 'https://engram.zone17.click/problems/session_invalid',
          title: 'Session invalid on first send',
          status: 401,
          code: 'session_invalid',
        }),
      );

    setKnownDeviceSessionUserId(USER_A_ID);
    fireEvent.change(textarea, { target: { value: 'wifi: first-attempt session_invalid' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(textarea).toHaveValue('');
    });
    expect(firstAttemptSessionInvalidSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('omnibox-save-unconfirmed-notice')).not.toBeInTheDocument();
    firstAttemptSessionInvalidSpy.mockRestore();

    // Part 2a-bis (HM18B-R2-3): First send inside `contentMutate` fails on network error (uncertain lost response)
    // and its automatic internal retry receives `401 session_invalid` -> `priorUncertain` is true via intra-call
    // retry observation, so `saveUnconfirmed` IS recorded for User A even on the first plan attempt.
    clearSaveUnconfirmed();
    let internalRetryAttempt = 0;
    const internalRetryFetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/entries')) {
        internalRetryAttempt += 1;
        if (internalRetryAttempt === 1) {
          throw new TypeError('Failed to fetch: lost response on first send inside contentMutate');
        }
        return new Response(
          JSON.stringify({
            type: 'https://engram.zone17.click/problems/session_invalid',
            title: 'Session invalid on internal retry',
            status: 401,
            code: 'session_invalid',
          }),
          { status: 401, headers: { 'content-type': 'application/problem+json' } },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    setKnownDeviceSessionUserId(USER_A_ID);
    fireEvent.change(textarea, { target: { value: 'wifi: internal retry session_invalid' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(textarea).toHaveValue('');
    });
    expect(internalRetryAttempt).toBe(2);
    expect(screen.getByTestId('omnibox-save-unconfirmed-notice')).toHaveTextContent(
      'Lần lưu trước vào “wifi” chưa xác nhận; kiểm tra mục trước khi lưu lại',
    );
    clearSaveUnconfirmed();
    internalRetryFetchSpy.mockRestore();

    // Part 2b (HM18B-R1-5): When no real user ID is known (`['auth','me']` cache empty and `getKnownDeviceSessionUserId() === null`),
    // even a retry `session_invalid` after an uncertain send does NOT record or render `saveUnconfirmed` (no shared fallback ID).
    queryClient.removeQueries({ queryKey: ['auth', 'me'] });
    setKnownDeviceSessionUserId(null);
    let noUserAttempt = 0;
    const noUserEntrySpy = vi
      .spyOn(contentApi, 'entryCreate')
      .mockImplementation(async () => {
        noUserAttempt += 1;
        if (noUserAttempt === 1) {
          throw new TypeError('Failed to fetch: lost POST /entries response without user id');
        }
        throw new ProblemError({
          type: 'https://engram.zone17.click/problems/session_invalid',
          title: 'Session invalid',
          status: 401,
          code: 'session_invalid',
        });
      });

    rerender(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <QueryClientProvider client={queryClient}>
          <UndoToastProvider>
            <Omnibox />
          </UndoToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    fireEvent.change(textarea, { target: { value: 'wifi: uncertain send without user id' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await screen.findByTestId('omnibox-retry-plan-btn');
    fireEvent.click(screen.getByTestId('omnibox-retry-plan-btn'));
    await waitFor(() => {
      expect(textarea).toHaveValue('');
    });
    expect(screen.queryByTestId('omnibox-save-unconfirmed-notice')).not.toBeInTheDocument();
    // Even after User A signs in later, nothing was recorded under a fallback ID
    queryClient.setQueryData(['auth', 'me'], { user: { id: USER_A_ID } });
    setKnownDeviceSessionUserId(USER_A_ID);
    rerender(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <QueryClientProvider client={queryClient}>
          <UndoToastProvider>
            <Omnibox />
          </UndoToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    expect(screen.queryByTestId('omnibox-save-unconfirmed-notice')).not.toBeInTheDocument();
    noUserEntrySpy.mockRestore();

    // Part 2c: Lost response on first send (`priorUncertain === true`), then `session_invalid` on retry with known User A ->
    // no replay, drops plan/draft, shows `saveUnconfirmed` after re-login/unlock for User A, and hides it for User B
    let entryAttempt = 0;
    const entryCreateSpy = vi
      .spyOn(contentApi, 'entryCreate')
      .mockImplementation(async () => {
        entryAttempt += 1;
        if (entryAttempt === 1) {
          throw new TypeError('Failed to fetch: lost POST /entries response');
        }
        throw new ProblemError({
          type: 'https://engram.zone17.click/problems/session_invalid',
          title: 'Session invalid',
          status: 401,
          code: 'session_invalid',
        });
      });

    setKnownDeviceSessionUserId(USER_A_ID);
    fireEvent.change(textarea, { target: { value: 'wifi: test session invalid' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    // First attempt fails with network loss -> Retry button appears
    await screen.findByTestId('omnibox-retry-plan-btn');
    // Second attempt (Retry) gets 401 session_invalid -> drops plan + draft, records saveUnconfirmed for USER_A_ID
    fireEvent.click(screen.getByTestId('omnibox-retry-plan-btn'));

    await waitFor(() => {
      expect(textarea).toHaveValue('');
    });
    expect(screen.queryByTestId('omnibox-save-plan')).not.toBeInTheDocument();

    // While locked, saveUnconfirmed notice is hidden
    mockVaultState = 'locked';
    rerender(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <QueryClientProvider client={queryClient}>
          <UndoToastProvider>
            <Omnibox />
          </UndoToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    expect(screen.queryByTestId('omnibox-save-unconfirmed-notice')).not.toBeInTheDocument();

    // When User A unlocks -> saveUnconfirmed notice is shown, nothing auto-replayed
    triggerVaultUnlock();
    rerender(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <QueryClientProvider client={queryClient}>
          <UndoToastProvider>
            <Omnibox />
          </UndoToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    const unconfirmedNotice = screen.getByTestId('omnibox-save-unconfirmed-notice');
    expect(unconfirmedNotice).toHaveTextContent(
      'Lần lưu trước vào “wifi” chưa xác nhận; kiểm tra mục trước khi lưu lại',
    );
    expect(entryCreateSpy).toHaveBeenCalledTimes(2); // No auto-replay after unlock

    // Switching to User B in the `['auth', 'me', ...]` cache reactively hides and clears User A's
    // unconfirmed notice immediately without requiring an unmount or parent rerender (HM18-CI-10)
    act(() => {
      queryClient.setQueriesData({ queryKey: ['auth', 'me'] }, { user: { id: USER_B_ID } });
      setKnownDeviceSessionUserId(USER_B_ID);
    });
    expect(screen.queryByTestId('omnibox-save-unconfirmed-notice')).not.toBeInTheDocument();

    // Even if `['auth', 'me']` switches back to User A later without a new uncertain save, User A's cleared notice does not reappear
    act(() => {
      queryClient.setQueriesData({ queryKey: ['auth', 'me'] }, { user: { id: USER_A_ID } });
      setKnownDeviceSessionUserId(USER_A_ID);
    });
    expect(screen.queryByTestId('omnibox-save-unconfirmed-notice')).not.toBeInTheDocument();
  });

  it('drops save plan and draft when vault locks mid-plan (after POST /items, before POST /entries), preserves the user-scoped lock notice across Omnibox unmount/remount on the unlock route (HM18B-R1-4), keeps item, and never leaks plaintext', async () => {
    const secretPlaintext = 'SENTINEL_MID_PLAN_LOCK_SECRET_999';
    const lookupSpy = vi.spyOn(contentApi, 'itemsLookupExact').mockResolvedValue({
      items: [],
      total: 0,
      next_cursor: null,
    });
    const itemCreateSpy = vi.spyOn(contentApi, 'itemCreate').mockResolvedValue(ITEM_WIFI);

    const { promise: tagUpsertPromise, resolve: resolveTagUpsert } = Promise.withResolvers<Tag>();
    const tagUpsertSpy = vi.spyOn(contentApi, 'tagUpsert').mockImplementation(() => tagUpsertPromise);
    const entryCreateSpy = vi.spyOn(contentApi, 'entryCreate');

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['auth', 'me'], { user: { id: USER_A_ID } });
    const { container, unmount } = renderOmnibox(<Omnibox />, { queryClient });
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    fireEvent.change(textarea, {
      target: { value: `wifi #nhà: ${secretPlaintext}` },
    });
    assertNoPlaintextAttrs(container, [secretPlaintext]);

    fireEvent.keyDown(textarea, { key: 'Enter' });

    // Wait until `POST /items` has completed and `POST /tags` is in flight
    await waitFor(() => {
      expect(itemCreateSpy).toHaveBeenCalledTimes(1);
    });

    // Lock the vault mid-plan!
    act(() => {
      triggerVaultLockReset();
    });

    // Draft and plan are dropped immediately; no plaintext attributes while locked
    expect(textarea).toHaveValue('');
    expect(screen.queryByTestId('omnibox-save-plan')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(secretPlaintext);
    assertNoPlaintextAttrs(container, [secretPlaintext], { locked: true });

    // Simulate navigating away to `/app/unlock` where Omnibox unmounts completely (HM18B-R1-4)
    unmount();

    // Even if in-flight tagUpsert resolves after lock/unmount, nothing proceeds to POST /entries
    resolveTagUpsert(TAG_NHA);
    await act(async () => {
      await Promise.resolve();
    });
    expect(entryCreateSpy).not.toHaveBeenCalled();
    for (const spy of [lookupSpy, itemCreateSpy, tagUpsertSpy, entryCreateSpy]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(secretPlaintext);
    }

    // Unlock the vault and mount a fresh `<Omnibox />` instance (as when returning from `/app/unlock` to `/app`) ->
    // shows post-unlock notice that draft was cleared and created item/tags were kept; nothing auto-sent
    triggerVaultUnlock();
    const remounted = renderOmnibox(<Omnibox />, { queryClient });

    const lockNotice = await screen.findByTestId('omnibox-lock-cleared-notice');
    expect(lockNotice).toHaveTextContent(
      'Bản nháp chưa lưu đã bị xoá khi khoá vault; mục/tag đã tạo vẫn còn',
    );
    expect(entryCreateSpy).not.toHaveBeenCalled();

    // Switching to User B in the `['auth', 'me', ...]` cache reactively hides and clears User A's
    // lock notice immediately without requiring an unmount or parent rerender (HM18-CI-10)
    act(() => {
      queryClient.setQueriesData({ queryKey: ['auth', 'me'] }, { user: { id: USER_B_ID } });
      setKnownDeviceSessionUserId(USER_B_ID);
    });
    expect(screen.queryByTestId('omnibox-lock-cleared-notice')).not.toBeInTheDocument();

    // Even if `['auth', 'me']` switches back to User A later, the cleared lock notice does not reappear
    act(() => {
      queryClient.setQueriesData({ queryKey: ['auth', 'me'] }, { user: { id: USER_A_ID } });
      setKnownDeviceSessionUserId(USER_A_ID);
    });
    expect(screen.queryByTestId('omnibox-lock-cleared-notice')).not.toBeInTheDocument();

    // HM18B-R2-6 & HM18-R3-4: When user ID is unknown at lock time, lock notice is recorded with `userId: null`
    // while `activeUserId === null`, cleared on any `signed_out` reason (incl. `expired`/`revoked`), and dropped
    // (never adopted) when a user ID subsequently appears so User B can never see a notice recorded before User B signed in.
    remounted.unmount();
    clearLockClearedNotice();
    queryClient.removeQueries({ queryKey: ['auth', 'me'] });
    setKnownDeviceSessionUserId(null);

    const unknownUserView = renderOmnibox(<Omnibox />, { queryClient });
    const unknownTextarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });
    fireEvent.change(unknownTextarea, { target: { value: 'nháp khi chưa biết userId: bí mật' } });
    act(() => {
      triggerVaultLockReset();
    });
    unknownUserView.unmount();

    // Unlock while user ID is still unknown -> generic draft-cleared notice is visible
    triggerVaultUnlock();
    const unlockedUnknownView = renderOmnibox(<Omnibox />, { queryClient });
    expect(screen.getByTestId('omnibox-lock-cleared-notice')).toHaveTextContent(
      'Bản nháp chưa lưu đã bị xoá khi khoá vault',
    );

    // HM18-R3-4 & HM18-CI-10 (dec-120): When a known user ID appears in `['auth', 'me', epoch]`,
    // a `userId: null` notice is reactively dropped rather than adopted without requiring unmount/rerender
    act(() => {
      queryClient.setQueryData(['auth', 'me', 1], { user: { id: USER_A_ID } });
      setKnownDeviceSessionUserId(USER_A_ID);
    });
    expect(screen.queryByTestId('omnibox-lock-cleared-notice')).not.toBeInTheDocument();

    // Record a known-user notice for User A and verify involuntary `signed_out` (`reason: 'expired'`) immediately clears it
    unlockedUnknownView.unmount();
    const knownUserView = renderOmnibox(<Omnibox />, { queryClient });
    const knownTextarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });
    fireEvent.change(knownTextarea, { target: { value: 'nháp của User A: bí mật' } });
    act(() => {
      triggerVaultLockReset();
    });
    triggerVaultUnlock();
    knownUserView.rerender(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <QueryClientProvider client={queryClient}>
          <UndoToastProvider>
            <Omnibox />
          </UndoToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('omnibox-lock-cleared-notice')).toBeInTheDocument();
    act(() => {
      postSessionBroadcast({ type: 'signed_out', reason: 'expired' });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('omnibox-lock-cleared-notice')).not.toBeInTheDocument();
    });
  });

  it('sends only sealed ciphertext to entryCreate and never leaks plaintext in spy arguments, DOM attributes, QueryCache, or MutationCache on unlocked, locked, or failed save (P4FE1-2, P4FE2-2, HM18B-R1-6)', async () => {
    const secretPlaintext = 'SENTINEL_MUTATION_CACHE_SECRET_4455';
    const lookupSpy = vi.spyOn(contentApi, 'itemsLookupExact').mockResolvedValue({
      items: [ITEM_WIFI],
      total: 1,
      next_cursor: null,
    });
    const entryCreateSpy = vi.spyOn(contentApi, 'entryCreate').mockRejectedValue(
      new ProblemError({
        type: 'https://engram.zone17.click/problems/internal_error',
        title: 'Internal error',
        status: 500,
        code: 'internal_error',
      }),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Seed a non-empty entry in MutationCache as a positive control so the cache scan is non-vacuous (HM18B-R1-6)
    const seededMutation = queryClient.getMutationCache().build(queryClient, {
      mutationKey: ['content', 'entries', 'create'],
    });
    expect(queryClient.getMutationCache().getAll().length).toBeGreaterThanOrEqual(1);
    expect(seededMutation).toBeDefined();

    const { container } = renderOmnibox(<Omnibox />, { queryClient });
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    fireEvent.change(textarea, {
      target: { value: `wifi: ${secretPlaintext}` },
    });
    assertNoPlaintextAttrs(container, [secretPlaintext]);

    fireEvent.keyDown(textarea, { key: 'Enter' });
    await screen.findByTestId('omnibox-plan-error');

    // Positive control (HM18B-R1-6): `entryCreate` was called with the opaque ciphertext and envelope,
    // and the plaintext sentinel is absent from every spy argument.
    expect(entryCreateSpy).toHaveBeenCalledTimes(1);
    const [calledItemId, calledBody, calledOpts] = entryCreateSpy.mock.calls[0]!;
    expect(calledItemId).toBe(ITEM_WIFI.id);
    expect(calledBody).toEqual(
      expect.objectContaining({
        type: 'text',
        ciphertext: 'Q0lQSEVSVEVYVF9PUEFRVUVfQllURVM',
        envelope: expect.objectContaining({
          v: 1,
          alg: 'xchacha20poly1305-ietf',
          key_id: TEST_KEY_ID,
        }),
      }),
    );
    expect(calledOpts).toEqual(
      expect.objectContaining({
        idempotencyKey: expect.any(String),
      }),
    );
    for (const spy of [lookupSpy, entryCreateSpy]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(secretPlaintext);
    }

    // Check DOM attributes after failed save
    assertNoPlaintextAttrs(container, [secretPlaintext]);

    // Scan MutationCache and QueryCache for the secret plaintext
    const allMutations = queryClient.getMutationCache().getAll();
    expect(allMutations.length).toBeGreaterThanOrEqual(1);
    for (const mutation of allMutations) {
      const serialized = JSON.stringify({
        variables: mutation.state.variables,
        context: mutation.state.context,
        data: mutation.state.data,
        error: mutation.state.error,
      });
      expect(serialized).not.toContain(secretPlaintext);
    }
    for (const query of queryClient.getQueryCache().getAll()) {
      const serialized = JSON.stringify({
        key: query.queryKey,
        data: query.state.data,
        error: query.state.error,
      });
      expect(serialized).not.toContain(secretPlaintext);
    }
  });

  it('ignores Enter and Ctrl+Enter while IME isComposing or keyCode === 229 in add mode (0 POST /items or POST /entries), then submits normally once composition ends (HM18B-R1-6)', async () => {
    const lookupSpy = vi.spyOn(contentApi, 'itemsLookupExact').mockResolvedValue({
      items: [ITEM_WIFI],
      total: 1,
      next_cursor: null,
    });
    const itemCreateSpy = vi.spyOn(contentApi, 'itemCreate');
    const tagUpsertSpy = vi.spyOn(contentApi, 'tagUpsert').mockResolvedValue(TAG_NHA);
    const itemTagsAddSpy = vi.spyOn(contentApi, 'itemTagsAdd').mockResolvedValue(ITEM_WIFI);
    const entryCreateSpy = vi
      .spyOn(contentApi, 'entryCreate')
      .mockImplementation(async (itemId, body) => makeEntryMeta(itemId, body.id));

    renderOmnibox();
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    fireEvent.change(textarea, { target: { value: 'wifi #nhà: đang gõ bộ gõ tiếng Việt' } });
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true, isComposing: true });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true, keyCode: 229 });

    expect(lookupSpy).not.toHaveBeenCalled();
    expect(itemCreateSpy).not.toHaveBeenCalled();
    expect(entryCreateSpy).not.toHaveBeenCalled();

    // Positive control (HM18B-R1-6): the exact same draft without `isComposing` / `229` submits and saves
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => {
      expect(lookupSpy).toHaveBeenCalledTimes(1);
      expect(tagUpsertSpy).toHaveBeenCalledTimes(1);
      expect(itemTagsAddSpy).toHaveBeenCalledTimes(1);
      expect(entryCreateSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('executes the real 4-step save-plan and features/entries seal/mutation helpers (mocking only fetch), lazy-loads GET /vault when vault.vaultMeta is initially null after onboarding, and sends POST /items/{id}/entries with ciphertext only (HM18-CI-7, HM18B-R2-4)', async () => {
    // Simulate fresh `/app` after onboarding where `vault.state === 'unlocked'` in the Worker
    // but `vault.vaultMeta` has not been fetched yet (`null`), requiring `reloadVaultMeta()` before sealing.
    mockVaultMetaOverride = null;
    mockReloadVaultMeta.mockImplementation(async () => {
      const loaded = { vault_key_id: TEST_KEY_ID, version: 1 };
      mockVaultMetaOverride = loaded;
      return loaded;
    });

    const secretPlaintext = 'SENTINEL_REAL_STACK_FETCH_ONLY_778899';
    const fetchRequests: Array<{
      readonly method: string;
      readonly url: string;
      readonly headers: Headers;
      readonly bodyText: string;
    }> = [];

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = new Headers(init?.headers);
      const bodyText = typeof init?.body === 'string' ? init.body : '';
      fetchRequests.push({ method, url, headers, bodyText });

      if (method === 'GET' && url.includes('/items/lookup')) {
        return new Response(
          JSON.stringify({ items: [], total: 0, next_cursor: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (method === 'POST' && /\/items$/.test(url)) {
        const parsed = JSON.parse(bodyText) as { id: string; name: string };
        return new Response(
          JSON.stringify({
            id: parsed.id,
            name: parsed.name,
            hint: null,
            tags: [],
            entry_count: 0,
            version: 1,
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T00:00:00Z',
            last_used_at: '2026-11-01T00:00:00Z',
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (method === 'POST' && /\/tags$/.test(url)) {
        const parsed = JSON.parse(bodyText) as { display: string };
        return new Response(
          JSON.stringify({
            id: TAG_NHA.id,
            display: parsed.display,
            item_count: 1,
            last_used_at: '2026-11-01T00:00:00Z',
            created_at: '2026-11-01T00:00:00Z',
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (method === 'POST' && /\/items\/[^/]+\/tags$/.test(url)) {
        return new Response(
          JSON.stringify(ITEM_WIFI),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (method === 'POST' && /\/items\/([^/]+)\/entries$/.test(url)) {
        const match = /\/items\/([^/]+)\/entries$/.exec(url);
        const itemId = match?.[1] ?? ITEM_WIFI.id;
        const parsed = JSON.parse(bodyText) as { id: string; plaintext_len_bucket: number };
        return new Response(
          JSON.stringify({
            id: parsed.id,
            item_id: itemId,
            type: 'text',
            position: 0,
            version: 1,
            plaintext_len_bucket: parsed.plaintext_len_bucket,
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T00:00:00Z',
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (method === 'GET' && (url.includes('/items') || url.includes('/tags') || url.includes('/entries'))) {
        return new Response(
          JSON.stringify({ items: [], next_cursor: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch in real-stack save-plan test: ${method} ${url}`);
    });

    renderOmnibox();
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    fireEvent.change(textarea, {
      target: { value: `real-stack-item #nhà: ${secretPlaintext}` },
    });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const toast = await screen.findByTestId('undo-toast-item');
    expect(within(toast).getByText(/Đã lưu vào “real-stack-item”/)).toBeInTheDocument();
    expect(textarea).toHaveValue('');

    // Verify `reloadVaultMeta` was invoked to populate `vault_key_id` before sealing
    expect(mockReloadVaultMeta).toHaveBeenCalledTimes(1);
    expect(mockSealEntryCalls).toHaveLength(1);

    // Verify all 4 write steps were executed in order after `GET /items/lookup`
    const writePaths = fetchRequests
      .filter((r) => r.method === 'POST')
      .map((r) => r.url);
    expect(writePaths).toHaveLength(4);
    expect(writePaths[0]).toMatch(/\/api\/v1\/items$/);
    expect(writePaths[1]).toMatch(/\/api\/v1\/tags$/);
    expect(writePaths[2]).toMatch(/\/api\/v1\/items\/[0-9a-f-]{36}\/tags$/);
    expect(writePaths[3]).toMatch(/\/api\/v1\/items\/[0-9a-f-]{36}\/entries$/);

    // Verify the `POST /items/{id}/entries` body carries only sealed ciphertext + envelope, never the plaintext
    const entryPost = fetchRequests.find((r) => r.method === 'POST' && r.url.endsWith('/entries'));
    expect(entryPost).toBeDefined();
    expect(entryPost!.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/i);
    const parsedEntryBody = JSON.parse(entryPost!.bodyText) as Record<string, unknown>;
    expect(parsedEntryBody).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      type: 'text',
      ciphertext: 'Q0lQSEVSVEVYVF9PUEFRVUVfQllURVM',
      plaintext_len_bucket: 256,
      envelope: {
        v: 1,
        alg: 'xchacha20poly1305-ietf',
        key_id: TEST_KEY_ID,
        nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAA_nonce1',
        ct_enc: 'utf8',
      },
    });

    for (const req of fetchRequests) {
      expect(req.url).not.toContain(secretPlaintext);
      expect(req.bodyText).not.toContain(secretPlaintext);
    }

    fetchSpy.mockRestore();
  });

  it('fences reloadVaultMeta() against lock/unlock during the await, double Ctrl+Enter submit, null return, and rejected error (HM18-R3-2)', async () => {
    const itemCreateSpy = vi.spyOn(contentApi, 'itemCreate');
    const entryCreateSpy = vi.spyOn(contentApi, 'entryCreate');

    // 1. Held-promise lock (and re-unlock) while reloadVaultMeta() is in flight + double Ctrl+Enter during the await ->
    //    only 1 reloadVaultMeta call, and when the held promise resolves after lock + unlock, nothing is sealed or sent.
    mockVaultMetaOverride = null;
    const { promise: heldReloadPromise, resolve: resolveHeldReload } =
      Promise.withResolvers<{ vault_key_id: string; version: number } | null>();
    mockReloadVaultMeta.mockImplementation(() => heldReloadPromise);

    const { rerender, queryClient, unmount } = renderOmnibox();
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });
    fireEvent.change(textarea, { target: { value: 'fenced-item #nhà: secret-dropped-during-reload' } });

    // First Ctrl+Enter starts reloadVaultMeta(); second Ctrl+Enter while pending is ignored by savePlanStartingRef
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(mockReloadVaultMeta).toHaveBeenCalledTimes(1);

    // Vault locks (and then unlocks again) before reloadVaultMeta resolves
    act(() => {
      triggerVaultLockReset();
    });
    triggerVaultUnlock();
    rerender(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <QueryClientProvider client={queryClient}>
          <UndoToastProvider>
            <Omnibox />
          </UndoToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );

    await act(async () => {
      resolveHeldReload({ vault_key_id: TEST_KEY_ID, version: 1 });
    });

    expect(mockSealEntryCalls).toHaveLength(0);
    expect(itemCreateSpy).not.toHaveBeenCalled();
    expect(entryCreateSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('omnibox-action-error')).not.toBeInTheDocument();
    unmount();

    // 2. reloadVaultMeta() resolves to `null` (e.g. foreign/signed-out session or handled 404) -> silent return, no `vault_absent` banner, no seal/write
    clearLockClearedNotice();
    mockVaultMetaOverride = null;
    mockReloadVaultMeta.mockReset();
    mockReloadVaultMeta.mockResolvedValueOnce(null);

    const nullView = renderOmnibox();
    const nullTextarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });
    fireEvent.change(nullTextarea, { target: { value: 'null-meta-item: secret-body' } });
    fireEvent.keyDown(nullTextarea, { key: 'Enter', ctrlKey: true });

    await waitFor(() => {
      expect(mockReloadVaultMeta).toHaveBeenCalledTimes(1);
    });
    expect(mockSealEntryCalls).toHaveLength(0);
    expect(itemCreateSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('omnibox-action-error')).not.toBeInTheDocument();
    nullView.unmount();

    // 3. reloadVaultMeta() rejects with a network/server error -> surfaces `omnibox-action-error` and does not seal or send writes
    mockVaultMetaOverride = null;
    mockReloadVaultMeta.mockReset();
    mockReloadVaultMeta.mockRejectedValueOnce(new TypeError('Failed to fetch /api/v1/vault'));

    renderOmnibox();
    const rejectTextarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });
    fireEvent.change(rejectTextarea, { target: { value: 'reject-meta-item: secret-body' } });
    fireEvent.keyDown(rejectTextarea, { key: 'Enter', ctrlKey: true });

    const actionErr = await screen.findByTestId('omnibox-action-error');
    expect(actionErr).toHaveTextContent(viMessages.content.errors.network);
    expect(mockSealEntryCalls).toHaveLength(0);
    expect(itemCreateSpy).not.toHaveBeenCalled();
  });

  it('reactively hides and clears lock-cleared notice and saveUnconfirmed line immediately when [\'auth\', \'me\', ...] cache switches from user A to user B without unmount or parent rerender (HM18-CI-10, dec-120)', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Seed the real epoch-keyed `['auth', 'me', sessionEpoch]` entry used by `SessionProvider`
    queryClient.setQueryData(['auth', 'me', 0], { user: { id: USER_A_ID } });
    setKnownDeviceSessionUserId(USER_A_ID);
    recordLockClearedNotice({ userId: USER_A_ID, kind: 'plan' });
    recordSaveUnconfirmed({ userId: USER_A_ID, itemName: 'wifi' });

    renderOmnibox(<Omnibox />, { queryClient });

    expect(screen.getByTestId('omnibox-lock-cleared-notice')).toHaveTextContent(
      'Bản nháp chưa lưu đã bị xoá khi khoá vault; mục/tag đã tạo vẫn còn',
    );
    expect(screen.getByTestId('omnibox-save-unconfirmed-notice')).toHaveTextContent(
      'Lần lưu trước vào “wifi” chưa xác nhận; kiểm tra mục trước khi lưu lại',
    );

    // Switch the `['auth', 'me', ...]` cache to User B WITHOUT unmounting or calling `rerender(...)`
    act(() => {
      queryClient.setQueriesData(
        { queryKey: ['auth', 'me'] },
        { user: { id: USER_B_ID } },
      );
      setKnownDeviceSessionUserId(USER_B_ID);
    });

    expect(screen.queryByTestId('omnibox-lock-cleared-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('omnibox-save-unconfirmed-notice')).not.toBeInTheDocument();
    expect(getLockClearedNoticeSnapshot()).toBeNull();
    expect(getSaveUnconfirmedSnapshot()).toBeNull();
  });
});
