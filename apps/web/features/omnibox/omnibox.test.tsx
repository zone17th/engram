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
  clearAllUnconfirmedSaves,
  getUnconfirmedSavesSnapshot,
  recordUnconfirmedSave,
  useUnconfirmedSavesForUser,
} from '@/features/entries/unconfirmed-save-store';
import {
  clearLockClearedNotice,
  getLockClearedNoticeSnapshot,
  recordLockClearedNotice,
} from '@/features/omnibox/unconfirmed-save-store';
import { setKnownDeviceSessionUserId } from '@/features/vault/device-store';
import * as contentApi from '@/lib/api/content';
import type { EntryEnvelopeV1, EntryMeta, ItemSummary, Tag } from '@/lib/api/content';
import * as searchApi from '@/lib/api/search';
import type { SearchResponse, SuggestItem, SuggestResponse, SuggestTag } from '@/lib/api/search';
import * as authApi from '@/lib/api/auth';
import type { Me } from '@/lib/api/auth';
import { buildSuggestQueryKey } from '@/features/omnibox/suggest/query-keys';
import { getSessionEpoch } from '@/lib/api/auth-fetch';
import { postSessionBroadcast } from '@/lib/auth/broadcast';
import {
  commitAuthenticatedUser,
  __testing as userChangedTesting,
} from '@/lib/auth/user-changed';
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

const ITEM_ROUTER_NEAR: ItemSummary = {
  id: '4444dddd-4444-4444-8444-444444444444',
  name: 'mạng nội bộ',
  hint: null,
  tags: [{ id: TAG_OPS.id, display: TAG_OPS.display }],
  entry_count: 5,
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
function makeEmptySuggestResponse(
  overrides: Partial<SuggestResponse> = {},
): SuggestResponse {
  return {
    scope: 'all',
    limit: 8,
    mode: 'full',
    quota: { tag: 3, lexical: 6, near: 2 },
    tags: [],
    items: [],
    has_more: false,
    lexical_partial: [],
    semantic: false,
    semantic_reason: 'disabled_server',
    near: [],
    generation: null,
    ...overrides,
  };
}

function makeSearchResponse(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    scope: 'all',
    limit: 20,
    mode: 'full',
    items: [],
    tags: [],
    next_cursor: null,
    semantic: false,
    semantic_reason: 'disabled_server',
    near: [],
    generation: null,
    ...overrides,
  };
}

function makeSuggestItemRow(item: ItemSummary, overrides: Partial<SuggestItem> = {}): SuggestItem {
  return {
    kind: 'item',
    id: item.id,
    name: item.name,
    entry_count: item.entry_count,
    created_at: item.created_at,
    last_used_at: item.last_used_at,
    tags: item.tags.slice(0, 3).map((tag) => ({ id: tag.id, display: tag.display })),
    tag_total: item.tags.length,
    match: 'prefix',
    ...overrides,
  };
}

function makeSuggestTagRow(tag: Tag, overrides: Partial<SuggestTag> = {}): SuggestTag {
  return {
    kind: 'tag',
    id: tag.id,
    display: tag.display,
    item_count: tag.item_count,
    last_used_at: tag.last_used_at,
    match: 'prefix',
    ...overrides,
  };
}

function seedMe(
  queryClient: QueryClient,
  features: { semantic_available: boolean; semantic_external?: boolean },
  semanticSuggest: boolean,
) {
  queryClient.setQueryData(['auth', 'me', getSessionEpoch()], {
    user: { id: USER_A_ID },
    settings: { semantic_suggest: semanticSuggest },
    features: { semantic_external: false, ...features },
  });
}

function dispatchNativeTextEdit(
  textarea: HTMLElement,
  params: {
    readonly inputType: string;
    readonly data?: string | null;
    readonly nextValue: string;
    readonly isComposing?: boolean;
  },
) {
  const el = textarea as HTMLTextAreaElement;
  el.dispatchEvent(
    new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: params.inputType,
      data: params.data ?? null,
      isComposing: params.isComposing ?? false,
    }),
  );
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(el, params.nextValue);
  el.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      inputType: params.inputType,
      data: params.data ?? null,
      isComposing: params.isComposing ?? false,
    }),
  );
}

function typeNativeString(textarea: HTMLElement, text: string) {
  const el = textarea as HTMLTextAreaElement;
  for (const ch of text) {
    dispatchNativeTextEdit(el, {
      inputType: 'insertText',
      data: ch,
      nextValue: el.value + ch,
      isComposing: false,
    });
  }
}

function delayMs(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// RV-T17-1-FE2-1: a long synchronous run of native edits never yields to React's scheduler, so pending passive-effect
// work keeps `nestedUpdateCount` climbing until React throws "Maximum update depth exceeded" (limit 50). Real typing
// yields between keystrokes; tests that dispatch many edits must do the same (real timers, ~0 ms, far below the
// 120 ms suggest debounce).
async function yieldToReact(): Promise<void> {
  await act(async () => {
    await delayMs(0);
  });
}

// Types `text` rune by rune like `typeNativeString`, yielding to React every `chunkSize` runes and once at the end.
async function typeNativeStringYielding(
  textarea: HTMLElement,
  text: string,
  chunkSize = 20,
): Promise<void> {
  const runes = Array.from(text);
  for (let i = 0; i < runes.length; i += chunkSize) {
    typeNativeString(textarea, runes.slice(i, i + chunkSize).join(''));
    await yieldToReact();
  }
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
    clearAllUnconfirmedSaves();
    clearLockClearedNotice();
    userChangedTesting.resetCommittedUserForTests();
    setKnownDeviceSessionUserId(USER_A_ID);
    commitAuthenticatedUser(USER_A_ID);
    vi.spyOn(searchApi, 'suggest').mockResolvedValue(makeEmptySuggestResponse());
    vi.spyOn(searchApi, 'search').mockResolvedValue({
      scope: 'all',
      limit: 20,
      mode: 'full',
      items: [],
      tags: [],
      next_cursor: null,
      semantic: false,
      semantic_reason: 'disabled_server',
      near: [],
      generation: null,
    });
  });

  it('shows search.help.sentToServer help copy in search mode (with tainted enterToSearch variant), tagHint in #… mode, and no hint in add mode', () => {
    const itemsSpy = vi.spyOn(contentApi, 'itemsList');
    const tagsSpy = vi.spyOn(contentApi, 'tagsList');
    const createSpy = vi.spyOn(contentApi, 'itemCreate');

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // semantic_external: false -> search.help.sentToServer
    queryClient.setQueryData(['auth', 'me', getSessionEpoch()], {
      user: { id: USER_A_ID },
      settings: { semantic_suggest: false },
      features: { semantic_available: false, semantic_external: false },
    });

    renderOmnibox(<Omnibox />, { queryClient });
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });
    const hint = screen.getByTestId('omnibox-hint');

    // Empty input -> hint hidden
    expect(hint).toHaveAttribute('hidden');

    // Clean typed search mode -> search.help.sentToServer visible, renders mono `tên:` span
    typeNativeString(textarea, 'wifi');
    expect(hint).not.toHaveAttribute('hidden');
    expect(hint).toHaveTextContent(
      'Chữ gõ để tìm được gửi tới máy chủ, không mã hoá; lưu nội dung thì gõ tên: trước.',
    );
    expect(hint.querySelector('span.mono')?.textContent).toBe('tên:');
    expect(hint.textContent).not.toContain('`');

    // Clear and test tainted input (insertFromPaste) -> search.help.enterToSearch
    dispatchNativeTextEdit(textarea, {
      inputType: 'deleteWordBackward',
      nextValue: '',
    });
    dispatchNativeTextEdit(textarea, {
      inputType: 'insertFromPaste',
      data: 'pasted-query',
      nextValue: 'pasted-query',
    });
    expect(hint).not.toHaveAttribute('hidden');
    expect(hint).toHaveTextContent(viMessages.search.help.enterToSearch);
    // Clear and test tag filter mode (#…) with clean typing -> tagHint visible, Ctrl+Enter does nothing; 0 cached tags renders no empty role="listbox" (HM18A-R1-9)
    dispatchNativeTextEdit(textarea, {
      inputType: 'deleteWordBackward',
      nextValue: '',
    });
    typeNativeString(textarea, '#nhà');
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
    vi.spyOn(searchApi, 'search').mockResolvedValue(
      makeSearchResponse({
        items: [makeSuggestItemRow(ITEM_WIFI), makeSuggestItemRow(ITEM_WIFI_GUEST)],
      }),
    );

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

  it('sends 0 requests for tainted, colon-locked, add-mode, or multi-line input, while clean typing sends /suggest after debounce; Enter opens listbox without changing URL; second Enter searches again; ArrowDown + Enter opens item; editing closes listbox; live region announces count', async () => {
    const searchSpy = vi.spyOn(searchApi, 'search').mockResolvedValue(
      makeSearchResponse({
        items: [makeSuggestItemRow(ITEM_WIFI), makeSuggestItemRow(ITEM_WIFI_GUEST)],
      }),
    );
    const suggestSpy = vi
      .spyOn(searchApi, 'suggest')
      .mockResolvedValue(makeEmptySuggestResponse());

    renderOmnibox();
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    // Tainted input (insertFromPaste, insertFromDrop, historyUndo after setDraft, type-then-paste),
    // colon-locked (ASCII `:`, U+FF1A `：`, `http://x`), add mode, multi-line (`insertLineBreak`), and > 200 runes -> 0 requests (RV-T17-1-FE1-4)
    // RV-T17-1-FE2-1: yield to React after every case (`clearToEmpty` yields) and every <= 20 runes of the long draft,
    // so the burst of native edits never trips React's nested-update limit. Every blocked draft is kept.
    const clearToEmpty = async () => {
      dispatchNativeTextEdit(textarea, {
        inputType: 'deleteWordBackward',
        nextValue: '',
      });
      await yieldToReact();
    };

    // RV-T17-1-FE3-1: a real user's textarea already has focus when Esc arrives, so `handleDiscardDraft` -> `focus()` is a
    // no-op there. Focus it here first (the legitimate focus-on-empty `recent` /suggest, which carries no draft text), wait
    // for that single call, then reset the spy so the "0 requests" window below only sees draft-driven traffic.
    act(() => {
      textarea.focus();
    });
    await waitFor(() => {
      expect(suggestSpy).toHaveBeenCalledTimes(1);
    });
    expect(suggestSpy.mock.calls[0]?.[0]).not.toHaveProperty('q');
    suggestSpy.mockClear();

    dispatchNativeTextEdit(textarea, {
      inputType: 'insertFromPaste',
      data: 'pasted-tainted',
      nextValue: 'pasted-tainted',
    });
    await clearToEmpty();
    dispatchNativeTextEdit(textarea, {
      inputType: 'insertFromDrop',
      data: 'dropped-secret',
      nextValue: 'dropped-secret',
    });
    await clearToEmpty();
    typeNativeString(textarea, 'ab');
    fireEvent.keyDown(textarea, { key: 'Escape' }); // clears via setDraft('')
    dispatchNativeTextEdit(textarea, {
      inputType: 'historyUndo',
      nextValue: 'ab',
    });
    await clearToEmpty();
    typeNativeString(textarea, 'wi');
    dispatchNativeTextEdit(textarea, {
      inputType: 'insertFromPaste',
      data: 'fi-secret',
      nextValue: 'wifi-secret',
    });
    await clearToEmpty();
    await typeNativeStringYielding(textarea, 'http://x');
    await clearToEmpty();
    await typeNativeStringYielding(textarea, 'wifi： mật khẩu');
    await clearToEmpty();
    await typeNativeStringYielding(textarea, 'wifi: secret');
    await clearToEmpty();
    typeNativeString(textarea, 'line1');
    dispatchNativeTextEdit(textarea, {
      inputType: 'insertLineBreak',
      data: '\n',
      nextValue: 'line1\n',
    });
    typeNativeString(textarea, 'line2');
    await clearToEmpty();
    await typeNativeStringYielding(textarea, 'a'.repeat(201));
    await delayMs(160);
    expect(suggestSpy).not.toHaveBeenCalled();
    expect(searchSpy).not.toHaveBeenCalled();

    // Clear to reset taint/colon lock, then clean typing -> sends /suggest after 120ms debounce
    await clearToEmpty();
    suggestSpy.mockClear();
    typeNativeString(textarea, 'wifi');
    await waitFor(() => {
      expect(suggestSpy).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'wifi', scope: 'all', semantic: 0 }),
        expect.anything(),
      );
    });
    expect(searchSpy).not.toHaveBeenCalled();
    // First Enter (no active row) -> GET /search?q=wifi&scope=all&limit=20&semantic=0, URL unchanged, live region announces 2 results
    fireEvent.keyDown(textarea, { key: 'Enter' });
    const listbox = await screen.findByRole('listbox', { name: 'Kết quả tìm kiếm' });
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'wifi', scope: 'all', limit: 20, semantic: 0 }),
      expect.anything(),
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
    expect(within(firstOption).getByText('12 mục')).toBeInTheDocument();
    expect(firstOption).toHaveAttribute(
      'aria-label',
      'wifi #nhà #ops #home-lab Còn 1 tag nữa — 12 mục',
    );
    expect(
      within(listbox).getByRole('option', {
        name: 'wifi #nhà #ops #home-lab Còn 1 tag nữa — 12 mục',
      }),
    ).toBe(firstOption);
    await waitFor(() => {
      expect(screen.getByTestId('omnibox-live')).toHaveTextContent('2 kết quả');
    });
    // No option active after Enter -> pressing Enter a second time searches again
    expect(textarea).not.toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => {
      expect(searchSpy).toHaveBeenCalledTimes(2);
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

  it('shows the "Không khớp" /search state in live region and visible box, and last option "Tạo mục “…”" creates an item with no entry; Ctrl+Enter also creates an item with no entry', async () => {
    vi.spyOn(searchApi, 'search').mockResolvedValue(makeSearchResponse());
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
    await waitFor(() => {
      expect(screen.getByTestId('omnibox-live')).toHaveTextContent('Không khớp “thuế 2026”');
    });
    // The visible no-match box is a separate element OUTSIDE the listbox (FE-23): it is neither a row nor a live region.
    const emptyBox = screen.getByTestId('omnibox-search-empty');
    expect(emptyBox).toHaveTextContent('Không khớp “thuế 2026”');
    expect(listbox.contains(emptyBox)).toBe(false);
    expect(emptyBox.closest('[role="status"],[aria-live]')).toBeNull();
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
    const itemsSpy = vi.spyOn(searchApi, 'search');
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

  it('shows cached tags instantly in #… mode with the first row active, sends /suggest?scope=tag by keystroke and never GET /tags?q=, opens the active tag on Enter, and Enter without an active row runs /search?scope=tag&semantic=0', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(contentQueryKeys.tags({ sort: 'recent' }), {
      items: [TAG_NHA, TAG_OPS],
      next_cursor: null,
    });
    const tagCloud: Tag = {
      id: 'cccc3333-3333-4333-8333-333333333333',
      display: 'cloud',
      item_count: 4,
      last_used_at: '2026-11-01T00:00:00Z',
      created_at: '2026-11-01T00:00:00Z',
    };

    const tagsSpy = vi.spyOn(contentApi, 'tagsList');
    const suggestSpy = vi.spyOn(searchApi, 'suggest').mockImplementation(async (params) =>
      makeEmptySuggestResponse({
        scope: 'tag',
        mode: 'full',
        tags: [makeSuggestTagRow(params?.q === 'clo' ? tagCloud : TAG_NHA)],
      }),
    );
    const searchSpy = vi
      .spyOn(searchApi, 'search')
      .mockResolvedValue(makeSearchResponse({ scope: 'tag', tags: [makeSuggestTagRow(tagCloud)] }));

    renderOmnibox(<Omnibox />, { queryClient });
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    // Typing #nh cleanly -> the cached tag shows instantly (before any request) with the first row active (rule 7);
    // exact ICU live count with literal '#' (HM18A-R1-1, HM18A-R1-3).
    typeNativeString(textarea, '#nh');
    const listbox = screen.getByRole('listbox', { name: 'Kết quả lọc tag' });
    expect(suggestSpy).not.toHaveBeenCalled();
    expect(textarea).toHaveAttribute('aria-controls', 'omni-listbox');
    const nhaOption = within(listbox).getByRole('option', { name: /#nhà/ });
    expect(within(listbox).queryByRole('option', { name: /#ops/ })).not.toBeInTheDocument();
    expect(nhaOption).toHaveAttribute('aria-selected', 'true');
    expect(textarea).toHaveAttribute('aria-activedescendant', nhaOption.id);
    await waitFor(() => {
      expect(screen.getByTestId('omnibox-live')).toHaveTextContent('1 tag khớp #nh');
    });

    // The keystroke /suggest?scope=tag goes out after the debounce; server rows replace the tag group and keep the active row.
    await waitFor(() => {
      expect(suggestSpy).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'nh', scope: 'tag', semantic: 0 }),
        expect.anything(),
      );
    });
    expect(tagsSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('option', { name: /#nhà/ })).toHaveAttribute('aria-selected', 'true');

    // Enter on the active row -> navigates to /app?tag=<id> (never the tag name), no /search
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(mockRouterPush).toHaveBeenCalledWith(`/app?tag=${TAG_NHA.id}`);
    expect(searchSpy).not.toHaveBeenCalled();

    // Typing #clo (not in cache) -> empty state shown WITHOUT an empty role="listbox" (HM18A-R1-9), then the server row arrives
    typeNativeString(textarea, '#clo');
    expect(screen.getByTestId('omnibox-tag-empty')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(textarea).not.toHaveAttribute('aria-controls');
    expect(await screen.findByRole('option', { name: /#cloud/ })).toBeInTheDocument();
    expect(tagsSpy).not.toHaveBeenCalled();

    // A tainted #… draft (gate closed, no active row) + Enter -> GET /search?q=clo&scope=tag&semantic=0, still no GET /tags?q=
    searchSpy.mockClear();
    fireEvent.change(textarea, { target: { value: '#clo' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => {
      expect(searchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'clo', scope: 'tag', semantic: 0 }),
        expect.anything(),
      );
    });
    expect(await screen.findByRole('option', { name: /#cloud/ })).toBeInTheDocument();
    expect(tagsSpy).not.toHaveBeenCalled();

    // >50-rune tag token -> blocked on Enter, 0 requests
    searchSpy.mockClear();
    fireEvent.change(textarea, { target: { value: `#${'t'.repeat(51)}` } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(searchSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('omnibox-guard-alert')).toHaveTextContent(
      viMessages.content.omnibox.tagGuardTitle,
    );
  });

  it('ignores Enter, Ctrl+Enter, Escape, and arrow keys while IME isComposing or keyCode === 229', () => {
    const itemsSpy = vi.spyOn(searchApi, 'search');
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

    vi.spyOn(searchApi, 'search').mockResolvedValue(makeSearchResponse());

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

  it('discards in-flight /search and /suggest responses of an older generation when the user edits the input or presses Escape so stale rows never open (HM18A-R1-6, HM18A-R2-4)', async () => {
    const { promise: heldSearch, resolve: resolveHeldSearch } =
      Promise.withResolvers<SearchResponse>();
    const searchSpy = vi.spyOn(searchApi, 'search').mockImplementationOnce(() => heldSearch);

    renderOmnibox();
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    // 1. Start Enter search while listbox is closed, then edit input before response arrives
    fireEvent.change(textarea, { target: { value: 'old-query' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: 'new-edited-query' } });
    await act(async () => {
      resolveHeldSearch(makeSearchResponse({ items: [makeSuggestItemRow(ITEM_WIFI)] }));
      await Promise.resolve();
    });

    // Stale response for 'old-query' is discarded and must NOT open the listbox
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(textarea).toHaveValue('new-edited-query');

    // 2. Start another Enter search, press Escape to clear while in-flight -> resolving must be discarded and NOT open the listbox
    const { promise: heldEscSearch, resolve: resolveEscSearch } =
      Promise.withResolvers<SearchResponse>();
    searchSpy.mockImplementationOnce(() => heldEscSearch);

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(searchSpy).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(textarea).toHaveValue('');

    await act(async () => {
      resolveEscSearch(makeSearchResponse({ items: [makeSuggestItemRow(ITEM_WIFI)] }));
      await Promise.resolve();
    });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    // 3. Keystroke /suggest?scope=tag (the old GET /tags?q= lookup is gone): resolving after the user edits the input
    // is discarded and ignored (HM18A-R2-4).
    const { promise: heldTagSuggest, resolve: resolveHeldTagSuggest } =
      Promise.withResolvers<SuggestResponse>();
    let heldSuggestSignal: AbortSignal | undefined;
    const suggestSpy = vi.spyOn(searchApi, 'suggest').mockImplementationOnce((_params, opts) => {
      heldSuggestSignal = opts?.signal;
      return heldTagSuggest;
    });

    typeNativeString(textarea, '#clo');
    await waitFor(() => {
      expect(suggestSpy).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'clo', scope: 'tag', semantic: 0 }),
        expect.anything(),
      );
    });
    expect(heldSuggestSignal?.aborted).toBe(false);

    // User changes input to a tainted search-mode draft before /suggest resolves -> the request is aborted
    fireEvent.change(textarea, { target: { value: 'changed-after-tag-suggest' } });
    expect(heldSuggestSignal?.aborted).toBe(true);

    await act(async () => {
      resolveHeldTagSuggest(
        makeEmptySuggestResponse({
          scope: 'tag',
          mode: 'full',
          tags: [
            makeSuggestTagRow({
              id: 'cccc3333-3333-4333-8333-333333333333',
              display: 'cloud',
              item_count: 4,
              last_used_at: '2026-11-01T00:00:00Z',
              created_at: '2026-11-01T00:00:00Z',
            }),
          ],
        }),
      );
      await Promise.resolve();
    });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /#cloud/ })).not.toBeInTheDocument();
    // The discarded response is never announced (a stale 'no tags' line from the cached-tag phase may remain).
    expect(screen.getByTestId('omnibox-live')).not.toHaveTextContent('cloud');
    expect(textarea).toHaveValue('changed-after-tag-suggest');
  });

  it('clears textarea, closes listbox, clears live region, and removes seeded search queries (including ["search", ...]) from QueryCache on vault lock (P4FE3-5, P4FE4-8, HM18A-R1-7, HM18A-R2-6, L4)', async () => {
    const secretQuery = 'pasted-secret-token-7788';
    const seededSecretQuery = 'seeded-cache-secret-8899';
    const seededP05SuggestQuery = 'seeded-p05-suggest-secret-9900';
    vi.spyOn(searchApi, 'search').mockResolvedValue(makeSearchResponse());

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    // Seed both a P04 content search key and a P05 `['search', ...]` key with infinite gcTime
    const seededKey = contentQueryKeys.items({ sort: 'alpha', q: seededSecretQuery });
    queryClient.setQueryData(seededKey, { items: [ITEM_WIFI], next_cursor: null });
    const seededSearchKey = buildSuggestQueryKey({
      userId: USER_A_ID,
      scope: 'all',
      limit: 8,
      requestMode: 'lex',
      semanticSuggestSetting: false,
      generationId: null,
      qn: seededP05SuggestQuery,
    })!;
    queryClient.setQueryData(seededSearchKey, makeEmptySuggestResponse());
    expect(queryClient.getQueryCache().find({ queryKey: seededKey })).toBeDefined();
    expect(queryClient.getQueryCache().find({ queryKey: seededSearchKey })).toBeDefined();

    const { container } = renderOmnibox(<Omnibox />, { queryClient });
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    // Type a string in search mode and press Enter (empty result renders the string in DOM)
    fireEvent.change(textarea, { target: { value: secretQuery } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await screen.findByRole('listbox', { name: 'Kết quả tìm kiếm' });
    expect(container.textContent).toContain(secretQuery);

    // Lock the vault -> synchronous reset runs and `removeQueries` purges all omnibox search keys (both `['content', ...]` and `['search', ...]`)
    act(() => {
      triggerVaultLockReset();
    });

    expect(textarea).toHaveValue('');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByTestId('omnibox-live')).toHaveTextContent('');
    expect(container.innerHTML).not.toContain(secretQuery);
    assertNoPlaintextAttrs(
      container,
      [secretQuery, seededSecretQuery, seededP05SuggestQuery],
      { locked: true },
    );
    expect(queryClient.getQueryCache().find({ queryKey: seededKey })).toBeUndefined();
    expect(queryClient.getQueryCache().find({ queryKey: seededSearchKey })).toBeUndefined();

    // Verify every QueryCache key and state is free of all search strings
    const allQueries = queryClient.getQueryCache().getAll();
    const serializedCache = JSON.stringify(
      allQueries.map((q) => ({ key: q.queryKey, data: q.state.data })),
    );
    expect(serializedCache).not.toContain(secretQuery);
    expect(serializedCache).not.toContain(seededSecretQuery);
    expect(serializedCache).not.toContain(seededP05SuggestQuery);
  });

  it('discards in-flight search, in-flight suggest, and in-flight Ctrl+Enter itemCreate when the vault locks so nothing opens, shows a toast, or appears in the DOM after lock (HM18A-R2-6, L4)', async () => {
    const inFlightQuery = 'in-flight-lock-query-6611';
    const inFlightSuggestName = 'in-flight-lock-suggest-5500';
    const inFlightCreateName = 'in-flight-lock-create-7722';

    const { promise: heldSearch, resolve: resolveHeldSearch } =
      Promise.withResolvers<SearchResponse>();
    let capturedSearchSignal: AbortSignal | undefined;
    const searchSpy = vi.spyOn(searchApi, 'search').mockImplementation((_params, opts) => {
      capturedSearchSignal = opts?.signal;
      return heldSearch;
    });

    let capturedSuggestSignal: AbortSignal | undefined;
    const { promise: heldSuggest, resolve: resolveHeldSuggest } =
      Promise.withResolvers<SuggestResponse>();
    const suggestSpy = vi
      .spyOn(searchApi, 'suggest')
      .mockImplementation((_params, opts) => {
        capturedSuggestSignal = opts?.signal;
        return heldSuggest;
      });

    const { promise: heldCreate, resolve: resolveHeldCreate } =
      Promise.withResolvers<ItemSummary>();
    const createSpy = vi.spyOn(contentApi, 'itemCreate').mockImplementation(() => heldCreate);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const { container } = renderOmnibox(<Omnibox />, { queryClient });
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    // 1. Start keystroke suggest (`GET /suggest`) and Enter search (`GET /search`), then lock while both are in flight
    typeNativeString(textarea, inFlightQuery);
    await waitFor(() => {
      expect(suggestSpy).toHaveBeenCalledTimes(1);
    });
    expect(capturedSuggestSignal?.aborted).toBe(false);

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    act(() => {
      triggerVaultLockReset();
    });
    expect(textarea).toHaveValue('');
    expect(capturedSuggestSignal?.aborted).toBe(true);
    expect(capturedSearchSignal?.aborted).toBe(true);

    await act(async () => {
      resolveHeldSuggest(
        makeEmptySuggestResponse({
          items: [
            {
              kind: 'item',
              id: ITEM_WIFI.id,
              name: inFlightSuggestName,
              entry_count: 1,
              created_at: ITEM_WIFI.created_at,
              last_used_at: ITEM_WIFI.last_used_at,
              tags: [],
              tag_total: 0,
              match: 'prefix',
            },
          ],
        }),
      );
      resolveHeldSearch(
        makeSearchResponse({ items: [makeSuggestItemRow({ ...ITEM_WIFI, name: inFlightQuery })] }),
      );
      await Promise.resolve();
    });

    // Nothing opens or shows afterwards, and ['search'] cache stays empty
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByTestId('omnibox-live')).toHaveTextContent('');
    expect(container.innerHTML).not.toContain(inFlightQuery);
    expect(container.innerHTML).not.toContain(inFlightSuggestName);
    expect(queryClient.getQueryCache().findAll({ queryKey: ['search'] })).toEqual([]);
    assertNoPlaintextAttrs(container, [inFlightQuery, inFlightSuggestName], { locked: true });
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
  it('renders English strings with zero hard-coded Vietnamese in en locale, including the new search.* dropdown, status and toggle strings (UIA-2, UIA-20, HM18A-R1-1, HM18A-R1-3, HM18A-R1-10, HM18A-R1-11, FE-19)', async () => {
    const itemRouter: ItemSummary = {
      ...ITEM_WIFI,
      id: '5555eeee-5555-4555-8555-555555555555',
      name: 'router lab',
      hint: null,
      tags: [
        { id: TAG_OPS.id, display: 'ops' },
        { id: 'e1', display: 'lab' },
        { id: 'e2', display: 'core' },
        { id: 'e3', display: 'edge' },
      ],
      entry_count: 12,
    };
    const itemNear: ItemSummary = {
      ...ITEM_ROUTER_NEAR,
      name: 'network notes',
      tags: [{ id: TAG_OPS.id, display: 'ops' }],
    };
    const searchSpy = vi
      .spyOn(searchApi, 'search')
      .mockResolvedValueOnce(
        makeSearchResponse({ semantic: true, semantic_reason: null, generation: 3 }),
      )
      .mockResolvedValue(
        makeSearchResponse({
          semantic: true,
          semantic_reason: null,
          generation: 3,
          tags: [makeSuggestTagRow(TAG_OPS)],
          items: [makeSuggestItemRow(itemRouter, { match: 'fuzzy' })],
          near: [makeSuggestItemRow(itemNear, { match: 'semantic' })],
          next_cursor: 'cursor-page-2',
        }),
      );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(contentQueryKeys.tags({ sort: 'recent' }), {
      items: [TAG_OPS],
      next_cursor: null,
    });
    seedMe(queryClient, { semantic_available: true, semantic_external: true }, true);

    const { container } = renderOmnibox(<Omnibox />, { locale: 'en', queryClient });
    const textarea = screen.getByRole('textbox', { name: 'Search or save' });

    expect(textarea).toHaveAttribute('placeholder', enMessages.content.omnibox.placeholder);
    expect(enMessages.content.omnibox.placeholder.length).toBeLessThanOrEqual(26);
    // search.toggle.semanticAriaLabel on the ≈ button
    expect(screen.getByRole('button', { name: 'Meaning-based search' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.change(textarea, { target: { value: '#op' } });
    await waitFor(() => {
      expect(screen.getByTestId('omnibox-live')).toHaveTextContent('1 matching tag for #op');
    });

    dispatchNativeTextEdit(textarea, {
      inputType: 'deleteWordBackward',
      nextValue: '',
    });
    typeNativeString(textarea, 'router');
    const hint = screen.getByTestId('omnibox-hint');
    expect(hint).toHaveTextContent(
      'Text you type to search is sent to the server, and to an external embedding service when ≈ is on, not encrypted. To save content, type name: first.',
    );
    expect(hint.querySelector('span.mono')?.textContent).toBe('name:');

    // First Enter -> empty /search page: search.state.noMatch + search.actions.createItem, box outside the listbox
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await screen.findByRole('listbox', { name: 'Search results' });
    expect(searchSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'router', scope: 'all', semantic: 1 }),
      expect.anything(),
    );
    expect(
      within(screen.getByTestId('omnibox-search-empty')).getByText('No match for “router”'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('omnibox-live')).toHaveTextContent('No match for “router”');
    });
    expect(screen.getByRole('option', { name: /Create item “router”/ })).toBeInTheDocument();

    // Second Enter -> rows: group headings, count line, badges, "Load more", aria-labels (search.group/row/match/actions/state)
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await screen.findByRole('option', { name: /router lab/ });
    const listbox = screen.getByRole('listbox', { name: 'Search results' });
    const headings = within(listbox)
      .getAllByRole('group')
      .map((group) => group.querySelector('.sugg-group')?.textContent);
    expect(headings).toEqual(['Tags', 'Items', 'Similar meaning', 'Actions']);
    expect(screen.getByTestId('omnibox-result-count')).toHaveTextContent('3 results');
    await waitFor(() => {
      expect(screen.getByTestId('omnibox-live')).toHaveTextContent('3 results');
    });
    expect(within(listbox).getByRole('option', { name: '#ops — 7 items' })).toBeInTheDocument();
    expect(
      within(listbox).getByRole('option', {
        name: 'router lab #ops #lab #core 1 more tag — 12 entries · fuzzy',
      }),
    ).toBeInTheDocument();
    expect(
      within(listbox).getByRole('option', {
        name: 'network notes #ops — 5 entries · ≈ similar meaning',
      }),
    ).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: 'Load more' })).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: /Create item “router”/ })).toBeInTheDocument();

    // Ensure no Vietnamese diacritics appear anywhere in the rendered English omnibox DOM (text and aria-labels)
    const viDiacritics =
      /[àáảãạăắằẳẵặâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]/i;
    expect(container.textContent).not.toMatch(viDiacritics);
    for (const el of Array.from(container.querySelectorAll('[aria-label]'))) {
      expect(el.getAttribute('aria-label')).not.toMatch(viDiacritics);
    }

    // Source check: omnibox.tsx and suggest-list.tsx have no hard-coded Vietnamese characters
    for (const rel of ['../../components/app-shell/omnibox.tsx', './suggest/suggest-list.tsx']) {
      const source = readFileSync(resolve(__dirname, rel), 'utf8');
      expect(source).not.toMatch(viDiacritics);
    }
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
    clearAllUnconfirmedSaves();
    clearLockClearedNotice();
    userChangedTesting.resetCommittedUserForTests();
    setKnownDeviceSessionUserId(USER_A_ID);
    commitAuthenticatedUser(USER_A_ID);
    document.cookie = 'sabk_csrf=v1.sess.test; path=/';
    vi.spyOn(searchApi, 'suggest').mockResolvedValue(makeEmptySuggestResponse());
    vi.spyOn(searchApi, 'search').mockResolvedValue({
      scope: 'all',
      limit: 20,
      mode: 'full',
      items: [],
      tags: [],
      next_cursor: null,
      semantic: false,
      semantic_reason: 'disabled_server',
      near: [],
      generation: null,
    });
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
    // advisor-dec-209 (Milestone C Task 17): banner action is visible and opens the Import JSON dialog with the pasted text.
    const jsonBannerAction = screen.getByTestId('omnibox-json-banner-action');
    expect(jsonBannerAction).not.toHaveAttribute('hidden');
    fireEvent.click(jsonBannerAction);
    expect(screen.getByTestId('import-json-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('import-json-source-textarea')).toHaveValue('{"ssid":"Zone17","vlan":10}');
    fireEvent.click(screen.getByTestId('import-json-close-btn'));
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
    clearAllUnconfirmedSaves();
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
    clearAllUnconfirmedSaves();
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
    commitAuthenticatedUser(USER_A_ID);
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

    // Switching to User B via `commitAuthenticatedUser` (and `['auth', 'me', ...]` cache) reactively hides and clears User A's
    // unconfirmed notice immediately without requiring an unmount or parent rerender (HM18-CI-10, advisor-dec-199/205)
    act(() => {
      queryClient.setQueriesData({ queryKey: ['auth', 'me'] }, { user: { id: USER_B_ID } });
      setKnownDeviceSessionUserId(USER_B_ID);
      commitAuthenticatedUser(USER_B_ID);
    });
    expect(screen.queryByTestId('omnibox-save-unconfirmed-notice')).not.toBeInTheDocument();

    // Even if session switches back to User A later without a new uncertain save, User A's cleared notice does not reappear
    act(() => {
      queryClient.setQueriesData({ queryKey: ['auth', 'me'] }, { user: { id: USER_A_ID } });
      setKnownDeviceSessionUserId(USER_A_ID);
      commitAuthenticatedUser(USER_A_ID);
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

    // Switching to User B via `commitAuthenticatedUser` (and `['auth', 'me', ...]` cache) reactively hides and clears User A's
    // lock notice immediately without requiring an unmount or parent rerender (HM18-CI-10, advisor-dec-199/205)
    act(() => {
      queryClient.setQueriesData({ queryKey: ['auth', 'me'] }, { user: { id: USER_B_ID } });
      setKnownDeviceSessionUserId(USER_B_ID);
      commitAuthenticatedUser(USER_B_ID);
    });
    expect(screen.queryByTestId('omnibox-lock-cleared-notice')).not.toBeInTheDocument();

    // Even if session switches back to User A later, the cleared lock notice does not reappear
    act(() => {
      queryClient.setQueriesData({ queryKey: ['auth', 'me'] }, { user: { id: USER_A_ID } });
      setKnownDeviceSessionUserId(USER_A_ID);
      commitAuthenticatedUser(USER_A_ID);
    });
    expect(screen.queryByTestId('omnibox-lock-cleared-notice')).not.toBeInTheDocument();

    // HM18B-R2-6 & HM18-R3-4: When user ID is unknown at lock time, lock notice is recorded with `userId: null`
    // while `activeUserId === null`, cleared on any `signed_out` reason (incl. `expired`/`revoked`), and dropped
    // (never adopted) when a user ID subsequently appears so User B can never see a notice recorded before User B signed in.
    remounted.unmount();
    clearLockClearedNotice();
    userChangedTesting.resetCommittedUserForTests();
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
      commitAuthenticatedUser(USER_A_ID);
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

    const rejectView = renderOmnibox();
    const rejectTextarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });
    fireEvent.change(rejectTextarea, { target: { value: 'reject-meta-item: secret-body' } });
    fireEvent.keyDown(rejectTextarea, { key: 'Enter', ctrlKey: true });

    const actionErr = await screen.findByTestId('omnibox-action-error');
    expect(actionErr).toHaveTextContent(viMessages.content.errors.network);
    expect(mockSealEntryCalls).toHaveLength(0);
    expect(itemCreateSpy).not.toHaveBeenCalled();
    rejectView.unmount();

    // 4. Superseded start A resolving while newer start B is still awaiting reloadVaultMeta must NOT clear B's savePlanStartingRef guard (HM18-R4-3)
    mockVaultMetaOverride = null;
    mockReloadVaultMeta.mockReset();
    const { promise: heldReloadA, resolve: resolveHeldReloadA } =
      Promise.withResolvers<{ vault_key_id: string; version: number } | null>();
    const { promise: heldReloadB, resolve: resolveHeldReloadB } =
      Promise.withResolvers<{ vault_key_id: string; version: number } | null>();
    mockReloadVaultMeta
      .mockImplementationOnce(() => heldReloadA)
      .mockImplementationOnce(() => heldReloadB);

    const raceView = renderOmnibox();
    const raceTextarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });
    fireEvent.change(raceTextarea, { target: { value: 'race-item-a: secret-a' } });
    fireEvent.keyDown(raceTextarea, { key: 'Enter', ctrlKey: true });
    expect(mockReloadVaultMeta).toHaveBeenCalledTimes(1);

    // Lock and re-unlock while start A's reloadVaultMeta is still pending
    act(() => {
      triggerVaultLockReset();
    });
    triggerVaultUnlock();
    raceView.rerender(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <QueryClientProvider client={raceView.queryClient}>
          <UndoToastProvider>
            <Omnibox />
          </UndoToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );

    // Start B begins and awaits heldReloadB
    fireEvent.change(raceTextarea, { target: { value: 'race-item-b: secret-b' } });
    fireEvent.keyDown(raceTextarea, { key: 'Enter', ctrlKey: true });
    expect(mockReloadVaultMeta).toHaveBeenCalledTimes(2);

    // Superseded start A resolves while B is still awaiting heldReloadB
    await act(async () => {
      resolveHeldReloadA({ vault_key_id: TEST_KEY_ID, version: 1 });
    });

    // A duplicate Ctrl+Enter while B is still awaiting heldReloadB must be ignored because B's savePlanStartingRef stays true
    fireEvent.keyDown(raceTextarea, { key: 'Enter', ctrlKey: true });
    expect(mockReloadVaultMeta).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveHeldReloadB(null);
    });
    expect(mockSealEntryCalls).toHaveLength(0);
    expect(itemCreateSpy).not.toHaveBeenCalled();
    raceView.unmount();
  });

  it('reactively hides and clears lock-cleared notice and saveUnconfirmed line immediately when [\'auth\', \'me\', ...] cache switches from user A to user B without unmount or parent rerender (HM18-CI-10, dec-120)', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Seed the real epoch-keyed `['auth', 'me', sessionEpoch]` entry used by `SessionProvider`
    queryClient.setQueryData(['auth', 'me', getSessionEpoch()], { user: { id: USER_A_ID } });
    setKnownDeviceSessionUserId(USER_A_ID);
    commitAuthenticatedUser(USER_A_ID);
    recordLockClearedNotice({ userId: USER_A_ID, kind: 'plan' });
    recordUnconfirmedSave({
      userId: USER_A_ID,
      itemId: ITEM_WIFI.id,
      itemName: 'wifi',
      source: 'omnibox',
    });

    renderOmnibox(<Omnibox />, { queryClient });

    expect(screen.getByTestId('omnibox-lock-cleared-notice')).toHaveTextContent(
      'Bản nháp chưa lưu đã bị xoá khi khoá vault; mục/tag đã tạo vẫn còn',
    );
    expect(screen.getByTestId('omnibox-save-unconfirmed-notice')).toHaveTextContent(
      'Lần lưu trước vào “wifi” chưa xác nhận; kiểm tra mục trước khi lưu lại',
    );

    // Switch to User B via `commitAuthenticatedUser` (and `['auth', 'me', ...]` cache) WITHOUT unmounting or calling `rerender(...)`
    act(() => {
      queryClient.setQueriesData(
        { queryKey: ['auth', 'me'] },
        { user: { id: USER_B_ID } },
      );
      setKnownDeviceSessionUserId(USER_B_ID);
      commitAuthenticatedUser(USER_B_ID);
    });

    expect(screen.queryByTestId('omnibox-lock-cleared-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('omnibox-save-unconfirmed-notice')).not.toBeInTheDocument();
    expect(getLockClearedNoticeSnapshot()).toBeNull();
    expect(getUnconfirmedSavesSnapshot()).toEqual([]);
  });

  it('shares a single unconfirmed-save store between omnibox and item page notice (omnibox -> item page and item page -> omnibox), and user switch clears both views (FU7, dec-205)', async () => {
    vi.spyOn(contentApi, 'itemsLookupExact').mockResolvedValue({
      items: [ITEM_WIFI],
      total: 1,
      next_cursor: null,
    });

    // Hook probe (RV-C-FE-2): the real `ItemDetailPage` banner uses the same `useUnconfirmedSavesForUser` hook.
    function ItemPageNoticeProbe({
      userId,
      itemId,
    }: {
      readonly userId: string | null;
      readonly itemId: string;
    }) {
      const notices = useUnconfirmedSavesForUser(userId, itemId);
      return (
        <>
          {notices.map((notice) => (
            <div
              key={`${notice.source}-${notice.itemId}`}
              role="status"
              data-testid="entry-save-unconfirmed-banner"
            >
              <span>{notice.itemName}</span>
            </div>
          ))}
        </>
      );
    }

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['auth', 'me', getSessionEpoch()], { user: { id: USER_A_ID } });
    setKnownDeviceSessionUserId(USER_A_ID);
    commitAuthenticatedUser(USER_A_ID);

    const { rerender } = renderOmnibox(
      <>
        <Omnibox />
        <ItemPageNoticeProbe userId={USER_A_ID} itemId={ITEM_WIFI.id} />
      </>,
      { queryClient },
    );

    // 1. Record saved from the omnibox path (uncertain send followed by 401 session_invalid on retry)
    // is visible to BOTH the omnibox notice AND the item page notice (`useUnconfirmedSavesForUser(userId, itemId)`).
    let omniAttempt = 0;
    const entryCreateSpy = vi.spyOn(contentApi, 'entryCreate').mockImplementation(async () => {
      omniAttempt += 1;
      if (omniAttempt === 1) {
        throw new TypeError('Failed to fetch: lost POST /entries response');
      }
      throw new ProblemError({
        type: 'https://engram.zone17.click/problems/session_invalid',
        title: 'Session invalid',
        status: 401,
        code: 'session_invalid',
      });
    });

    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });
    fireEvent.change(textarea, { target: { value: 'wifi: omnibox uncertain save' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await screen.findByTestId('omnibox-retry-plan-btn');
    fireEvent.click(screen.getByTestId('omnibox-retry-plan-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('omnibox-save-unconfirmed-notice')).toHaveTextContent('wifi');
    });
    expect(screen.getByTestId('entry-save-unconfirmed-banner')).toHaveTextContent('wifi');
    expect(getUnconfirmedSavesSnapshot()).toHaveLength(1);
    expect(getUnconfirmedSavesSnapshot()[0]).toMatchObject({
      userId: USER_A_ID,
      itemId: ITEM_WIFI.id,
      itemName: 'wifi',
      source: 'omnibox',
    });
    entryCreateSpy.mockRestore();

    // User A -> User B switch clears both views and empties the single store
    act(() => {
      queryClient.setQueriesData({ queryKey: ['auth', 'me'] }, { user: { id: USER_B_ID } });
      setKnownDeviceSessionUserId(USER_B_ID);
      commitAuthenticatedUser(USER_B_ID);
    });
    rerender(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <QueryClientProvider client={queryClient}>
          <UndoToastProvider>
            <Omnibox />
            <ItemPageNoticeProbe userId={USER_B_ID} itemId={ITEM_WIFI.id} />
          </UndoToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    expect(screen.queryByTestId('omnibox-save-unconfirmed-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('entry-save-unconfirmed-banner')).not.toBeInTheDocument();
    expect(getUnconfirmedSavesSnapshot()).toEqual([]);

    // 2. Vice versa: a record saved from the item page path (`source: 'entry'`) is visible to BOTH
    // the item page notice AND the omnibox notice, and a subsequent user switch (B -> A) clears both views.
    act(() => {
      recordUnconfirmedSave({
        userId: USER_B_ID,
        itemId: ITEM_WIFI_GUEST.id,
        itemName: ITEM_WIFI_GUEST.name,
        source: 'entry',
      });
    });
    rerender(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <QueryClientProvider client={queryClient}>
          <UndoToastProvider>
            <Omnibox />
            <ItemPageNoticeProbe userId={USER_B_ID} itemId={ITEM_WIFI_GUEST.id} />
          </UndoToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('entry-save-unconfirmed-banner')).toHaveTextContent('wifi khách');
    expect(screen.getByTestId('omnibox-save-unconfirmed-notice')).toHaveTextContent(
      'Lần lưu trước vào “wifi khách” chưa xác nhận; kiểm tra mục trước khi lưu lại',
    );

    // Switch from User B back to User A -> clears both views immediately
    act(() => {
      queryClient.setQueriesData({ queryKey: ['auth', 'me'] }, { user: { id: USER_A_ID } });
      setKnownDeviceSessionUserId(USER_A_ID);
      commitAuthenticatedUser(USER_A_ID);
    });
    rerender(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <QueryClientProvider client={queryClient}>
          <UndoToastProvider>
            <Omnibox />
            <ItemPageNoticeProbe userId={USER_A_ID} itemId={ITEM_WIFI_GUEST.id} />
          </UndoToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    expect(screen.queryByTestId('omnibox-save-unconfirmed-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('entry-save-unconfirmed-banner')).not.toBeInTheDocument();
    expect(getUnconfirmedSavesSnapshot()).toEqual([]);
  });

  it('dismisses only source: "omnibox" unconfirmed records on quick-add submit and preserves item-page source: "entry" records for the same user (RV-C-FE-1)', async () => {
    vi.spyOn(contentApi, 'itemsLookupExact').mockResolvedValue({
      items: [ITEM_WIFI],
      total: 1,
      next_cursor: null,
    });
    vi.spyOn(contentApi, 'entryCreate').mockImplementation(async (itemId, body) =>
      makeEntryMeta(itemId, body.id),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['auth', 'me', getSessionEpoch()], { user: { id: USER_A_ID } });
    setKnownDeviceSessionUserId(USER_A_ID);
    commitAuthenticatedUser(USER_A_ID);

    recordUnconfirmedSave({
      userId: USER_A_ID,
      itemId: ITEM_WIFI_GUEST.id,
      itemName: ITEM_WIFI_GUEST.name,
      source: 'entry',
    });
    recordUnconfirmedSave({
      userId: USER_A_ID,
      itemId: ITEM_WIFI.id,
      itemName: ITEM_WIFI.name,
      source: 'omnibox',
    });
    expect(getUnconfirmedSavesSnapshot()).toHaveLength(2);

    renderOmnibox(<Omnibox />, { queryClient });

    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });
    fireEvent.change(textarea, { target: { value: 'wifi: quick-add submit preserves entry notice' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const toast = await screen.findByTestId('undo-toast-item');
    expect(within(toast).getByText(/Đã lưu vào “wifi”/)).toBeInTheDocument();

    const remaining = getUnconfirmedSavesSnapshot();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      userId: USER_A_ID,
      itemId: ITEM_WIFI_GUEST.id,
      itemName: ITEM_WIFI_GUEST.name,
      source: 'entry',
    });
  });
  describe('P05-T17 PR 17-1 — send-gate wiring, setDraft/syncOwnWrite, composition, and lock reset', () => {
    beforeEach(() => {
      vi.spyOn(searchApi, 'suggest').mockResolvedValue(makeEmptySuggestResponse());
      vi.spyOn(searchApi, 'search').mockResolvedValue({
        scope: 'all',
        limit: 20,
        mode: 'full',
        items: [],
        tags: [],
        next_cursor: null,
        semantic: false,
        semantic_reason: 'disabled_server',
        near: [],
        generation: null,
      });
    });

    it('keystroke suggest after typed input only', async () => {
      const suggestSpy = vi
        .spyOn(searchApi, 'suggest')
        .mockResolvedValue(makeEmptySuggestResponse());
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      // Enable both semantic_available and semantic_suggest so >= 3 runes fires semantic=0 and semantic=1 on the same tick
      queryClient.setQueryData(['auth', 'me', getSessionEpoch()], {
        user: { id: USER_A_ID },
        settings: { semantic_suggest: true },
        features: { semantic_available: true, semantic_external: false },
      });

      renderOmnibox(<Omnibox />, { queryClient });
      const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

      // Paste via insertFromPaste -> 0 requests
      dispatchNativeTextEdit(textarea, {
        inputType: 'insertFromPaste',
        data: 'pasted-secret',
        nextValue: 'pasted-secret',
      });
      await delayMs(160);
      expect(suggestSpy).not.toHaveBeenCalled();

      // Clear to '', then type 2 runes ('wi') -> only semantic=0 after 120ms debounce
      dispatchNativeTextEdit(textarea, {
        inputType: 'deleteWordBackward',
        nextValue: '',
      });
      suggestSpy.mockClear();
      typeNativeString(textarea, 'wi');
      // RV-T17-1-FE2-3: fail clearly if the seeded `Me` is not the one the hook reads (semantic_external: false ->
      // `search.help.sentToServer`; a missed read would default to `sentToServerExternal` and drop the semantic=1 leg).
      expect(screen.getByTestId('omnibox-hint')).toHaveTextContent('gửi tới máy chủ, không mã hoá');
      expect(screen.getByTestId('omnibox-hint')).not.toHaveTextContent('dịch vụ nhúng bên ngoài');
      await waitFor(() => {
        expect(suggestSpy).toHaveBeenCalledTimes(1);
      });
      expect(suggestSpy).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'wi', scope: 'all', semantic: 0 }),
        expect.anything(),
      );

      // Type 3rd rune ('f' -> 'wif') -> fires both semantic=0 and semantic=1 on the same debounce tick
      suggestSpy.mockClear();
      typeNativeString(textarea, 'f');
      await waitFor(() => {
        expect(suggestSpy).toHaveBeenCalledTimes(2);
      });
      expect(suggestSpy).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'wif', scope: 'all', semantic: 0 }),
        expect.anything(),
      );
      expect(suggestSpy).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'wif', scope: 'all', semantic: 1 }),
        expect.anything(),
      );
    });

    it('native beforeinput listener reads inputType', async () => {
      const suggestSpy = vi
        .spyOn(searchApi, 'suggest')
        .mockResolvedValue(makeEmptySuggestResponse());

      renderOmnibox();
      const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });
      const hint = screen.getByTestId('omnibox-hint');

      // Multi-grapheme insertText (Gboard clipboard chip / keyboard suggestion tap) taints via native beforeinput/input
      dispatchNativeTextEdit(textarea, {
        inputType: 'insertText',
        data: 'wifi',
        nextValue: 'wifi',
      });
      expect(hint).toHaveTextContent(viMessages.search.help.enterToSearch);
      await delayMs(160);
      expect(suggestSpy).not.toHaveBeenCalled();

      // Clear, then dispatch insertReplacementText (autocorrect) -> taints
      dispatchNativeTextEdit(textarea, {
        inputType: 'deleteWordBackward',
        nextValue: '',
      });
      dispatchNativeTextEdit(textarea, {
        inputType: 'insertReplacementText',
        data: 'router',
        nextValue: 'router',
      });
      expect(hint).toHaveTextContent(viMessages.search.help.enterToSearch);
      await delayMs(160);
      expect(suggestSpy).not.toHaveBeenCalled();

      // Clear, then single-grapheme insertText -> untainted, sends /suggest
      dispatchNativeTextEdit(textarea, {
        inputType: 'deleteWordBackward',
        nextValue: '',
      });
      typeNativeString(textarea, 'ok');
      await waitFor(() => {
        expect(suggestSpy).toHaveBeenCalledWith(
          expect.objectContaining({ q: 'ok', semantic: 0 }),
          expect.anything(),
        );
      });
    });

    it('no request while composing; send after compositionend', async () => {
      const suggestSpy = vi
        .spyOn(searchApi, 'suggest')
        .mockResolvedValue(makeEmptySuggestResponse());

      renderOmnibox();
      const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' }) as HTMLTextAreaElement;

      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      dispatchNativeTextEdit(textarea, {
        inputType: 'insertCompositionText',
        data: 'dduowngf',
        nextValue: 'dduowngf',
        isComposing: true,
      });

      // Wait longer than 120ms debounce while still composing -> 0 requests (intermediate Telex string never leaves browser)
      await delayMs(180);
      expect(suggestSpy).not.toHaveBeenCalled();

      // Commit composition (`compositionend`) -> restarts 120ms debounce and sends committed text
      dispatchNativeTextEdit(textarea, {
        inputType: 'insertCompositionText',
        data: 'đường',
        nextValue: 'đường',
        isComposing: true,
      });
      textarea.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: 'đường' }),
      );

      await waitFor(() => {
        expect(suggestSpy).toHaveBeenCalledTimes(1);
      });
      expect(suggestSpy).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'đường', scope: 'all', semantic: 0 }),
        expect.anything(),
      );
      expect(JSON.stringify(suggestSpy.mock.calls)).not.toContain('dduowngf');
    });

    it('lock mid-suggest drops late response and clears [\'search\']', async () => {
      const lateSecretName = 'late-suggest-after-lock-9191';
      let capturedSignal: AbortSignal | undefined;
      const { promise: heldSuggest, resolve: resolveHeldSuggest } =
        Promise.withResolvers<SuggestResponse>();
      const suggestSpy = vi
        .spyOn(searchApi, 'suggest')
        .mockImplementation((_params, opts) => {
          capturedSignal = opts?.signal;
          return heldSuggest;
        });

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity } },
      });
      const preSeededKey = buildSuggestQueryKey({
        userId: USER_A_ID,
        scope: 'all',
        limit: 8,
        requestMode: 'lex',
        semanticSuggestSetting: false,
        generationId: null,
        qn: 'cached-before-lock',
      })!;
      queryClient.setQueryData(preSeededKey, makeEmptySuggestResponse());
      expect(queryClient.getQueryCache().find({ queryKey: preSeededKey })).toBeDefined();

      renderOmnibox(<Omnibox />, { queryClient });
      const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

      typeNativeString(textarea, 'wifi');
      await waitFor(() => {
        expect(suggestSpy).toHaveBeenCalledTimes(1);
      });
      expect(capturedSignal?.aborted).toBe(false);

      // Lock vault mid-suggest
      act(() => {
        triggerVaultLockReset();
      });
      expect(capturedSignal?.aborted).toBe(true);
      expect(queryClient.getQueryCache().findAll({ queryKey: ['search'] })).toEqual([]);

      // Resolve the held suggest promise after lock -> must be dropped and never cached or rendered
      await act(async () => {
        resolveHeldSuggest(
          makeEmptySuggestResponse({
            items: [
              {
                kind: 'item',
                id: ITEM_WIFI.id,
                name: lateSecretName,
                entry_count: 1,
                created_at: ITEM_WIFI.created_at,
                last_used_at: ITEM_WIFI.last_used_at,
                tags: [],
                tag_total: 0,
                match: 'prefix',
              },
            ],
          }),
        );
        await Promise.resolve();
      });

      expect(queryClient.getQueryCache().findAll({ queryKey: ['search'] })).toEqual([]);
    });

    it('save clear then type → first typed char untainted, /suggest sent', async () => {
      vi.spyOn(contentApi, 'itemsLookupExact').mockResolvedValue({
        items: [ITEM_WIFI],
        total: 1,
        next_cursor: null,
      });
      vi.spyOn(contentApi, 'entryCreate').mockImplementation(async (itemId, body) =>
        makeEntryMeta(itemId, body.id),
      );
      const suggestSpy = vi
        .spyOn(searchApi, 'suggest')
        .mockResolvedValue(makeEmptySuggestResponse());

      renderOmnibox();
      const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

      // Save an entry via quick-add (which clears the omnibox via setDraft(''))
      fireEvent.change(textarea, { target: { value: 'wifi: secret-to-save' } });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      await screen.findByTestId('undo-toast-item');
      expect(textarea).toHaveValue('');

      // Type a single character -> untainted, /suggest sent
      suggestSpy.mockClear();
      typeNativeString(textarea, 'w');
      const hint = screen.getByTestId('omnibox-hint');
      expect(hint).not.toHaveTextContent(viMessages.search.help.enterToSearch);
      await waitFor(() => {
        expect(suggestSpy).toHaveBeenCalledWith(
          expect.objectContaining({ q: 'w', scope: 'all', semantic: 0 }),
          expect.anything(),
        );
      });
    });

    it('Esc clear then type → untainted', async () => {
      const suggestSpy = vi
        .spyOn(searchApi, 'suggest')
        .mockResolvedValue(makeEmptySuggestResponse());

      renderOmnibox();
      const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

      // Paste text (tainted), then press Escape to clear via setDraft('')
      dispatchNativeTextEdit(textarea, {
        inputType: 'insertFromPaste',
        data: 'pasted-draft',
        nextValue: 'pasted-draft',
      });
      fireEvent.keyDown(textarea, { key: 'Escape' });
      expect(textarea).toHaveValue('');

      // Type a character -> untainted, /suggest sent
      suggestSpy.mockClear();
      typeNativeString(textarea, 'a');
      expect(screen.getByTestId('omnibox-hint')).not.toHaveTextContent(
        viMessages.search.help.enterToSearch,
      );
      await waitFor(() => {
        expect(suggestSpy).toHaveBeenCalledWith(
          expect.objectContaining({ q: 'a', scope: 'all', semantic: 0 }),
          expect.anything(),
        );
      });
    });

    it('Tab on tag then type → not tainted by (d)', async () => {
      const suggestSpy = vi
        .spyOn(searchApi, 'suggest')
        .mockResolvedValue(makeEmptySuggestResponse());

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      queryClient.setQueryData(contentQueryKeys.tags({ sort: 'recent' }), {
        items: [TAG_NHA, TAG_OPS],
        next_cursor: null,
      });

      renderOmnibox(<Omnibox />, { queryClient });
      const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

      // Type `#nh` cleanly -> cached tag `#nhà` is shown and active
      typeNativeString(textarea, '#nh');
      expect(screen.getByRole('listbox', { name: 'Kết quả lọc tag' })).toBeInTheDocument();

      // When listbox is closed via Escape, Tab is default (does not preventDefault or trap focus — RV-T17-1-FE1-5)
      fireEvent.keyDown(textarea, { key: 'Escape' });
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      const tabWhenClosed = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      });
      textarea.dispatchEvent(tabWhenClosed);
      expect(tabWhenClosed.defaultPrevented).toBe(false);
      expect(textarea).toHaveValue('#nh');

      // Re-open tag-filter listbox with active row, then press Tab -> fills `#nhà ` via setDraft() -> syncOwnWrite()
      dispatchNativeTextEdit(textarea, {
        inputType: 'deleteWordBackward',
        nextValue: '',
      });
      typeNativeString(textarea, '#nh');
      expect(screen.getByRole('listbox', { name: 'Kết quả lọc tag' })).toBeInTheDocument();
      fireEvent.keyDown(textarea, { key: 'Tab' });
      expect(textarea).toHaveValue('#nhà ');

      // Type another character -> not tainted by rule 1(d)!
      suggestSpy.mockClear();
      typeNativeString(textarea, 'x');
      expect(textarea).toHaveValue('#nhà x');
      expect(screen.getByTestId('omnibox-hint')).toHaveTextContent(
        viMessages.content.omnibox.tagHint,
      );
      await waitFor(() => {
        expect(suggestSpy).toHaveBeenCalledWith(
          expect.objectContaining({ q: 'nhà', scope: 'tag', semantic: 0 }),
          expect.anything(),
        );
      });
    });

    it('programmatic foreign `.value` write (not via setDraft) still taints', async () => {
      const suggestSpy = vi
        .spyOn(searchApi, 'suggest')
        .mockResolvedValue(makeEmptySuggestResponse());

      renderOmnibox();
      const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' }) as HTMLTextAreaElement;

      // Type 'ab' cleanly so gate state has value='ab' and prevValue='ab'
      typeNativeString(textarea, 'ab');
      await waitFor(() => {
        expect(suggestSpy).toHaveBeenCalledWith(
          expect.objectContaining({ q: 'ab', scope: 'all', semantic: 0 }),
          expect.anything(),
        );
      });
      suggestSpy.mockClear();

      // Foreign code mutates `textarea.value` to a same-length string ('ab') without setDraft, or wait:
      // if foreign code mutates `textarea.value` to `'xy'` (same length, not via setDraft) and then `beforeinput`
      // runs with `currentDomValue: 'xy'`, `stepSendGateBeforeInput` taints strictly via rule 1(d) (`currentDomValue !== state.prevValue`).
      // Even if `input` later sees `nextValue: 'xyz'` where `event.data = 'z'`, let's verify rule 1(d) in isolation:
      // foreign code sets `textarea.value = 'xy'` before `beforeinput`, then reverts to `'ab'` before `input` so `computeSingleSpliceDiff('ab', 'abz')` has `inserted === 'z' === data` (1 grapheme).
      // Only `stepSendGateBeforeInput`'s `currentDomValue !== state.prevValue` (rule 1(d)) can catch this!
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(textarea, 'xy');
      textarea.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: 'z',
          isComposing: false,
        }),
      );
      setter?.call(textarea, 'abz');
      textarea.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: 'z',
          isComposing: false,
        }),
      );
      expect(screen.getByTestId('omnibox-hint')).toHaveTextContent(
        viMessages.search.help.enterToSearch,
      );

      await delayMs(160);
      expect(suggestSpy).not.toHaveBeenCalled();
    });

    it('typing #home sends only token, and typing colon after in-flight request aborts it and sends nothing after colon', async () => {
      const signals: AbortSignal[] = [];
      const { promise: heldHomeSuggest, resolve: resolveHeldHomeSuggest } =
        Promise.withResolvers<SuggestResponse>();
      const suggestSpy = vi
        .spyOn(searchApi, 'suggest')
        .mockImplementation((params, opts) => {
          if (opts?.signal) {
            signals.push(opts.signal);
          }
          if (params?.q === 'home') {
            return heldHomeSuggest;
          }
          return Promise.resolve(makeEmptySuggestResponse());
        });

      renderOmnibox();
      const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

      // 1. Type `#home` and wait for the debounced `/suggest` request to be in-flight
      typeNativeString(textarea, '#home');
      await waitFor(() => {
        expect(suggestSpy).toHaveBeenCalledTimes(1);
      });
      expect(suggestSpy).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'home', scope: 'tag', semantic: 0 }),
        expect.anything(),
      );
      expect(signals[0]?.aborted).toBe(false);

      // 2. Type `:` then secret text -> immediately aborts the in-flight controller and locks the gate
      typeNativeString(textarea, ':secret-after-colon');
      expect(signals[0]?.aborted).toBe(true);
      await delayMs(160);
      expect(suggestSpy).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(suggestSpy.mock.calls)).not.toContain('secret-after-colon');
      resolveHeldHomeSuggest(makeEmptySuggestResponse());

      // 3. Clear to '', then type `#home secret` -> sends only `q: 'home'` with `scope: 'tag', semantic: 0`
      dispatchNativeTextEdit(textarea, {
        inputType: 'deleteWordBackward',
        nextValue: '',
      });
      suggestSpy.mockClear();
      typeNativeString(textarea, '#home secret');
      await waitFor(() => {
        expect(suggestSpy).toHaveBeenCalledTimes(1);
      });
      expect(suggestSpy).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'home', scope: 'tag', semantic: 0 }),
        expect.anything(),
      );
      expect(JSON.stringify(suggestSpy.mock.calls)).not.toContain('secret');
    });

    // CI-41431143632-E2E-QA402 / CI-41431143632-SMOKE-LOCKED: in a real browser the native `input` event reaches the
    // textarea listener BEFORE React's root `onChange` listener, and React flushes a sync-lane update scheduled from
    // that native listener in a microtask between the two listeners. The flush re-applies the stale controlled value
    // and wipes the typed / `fill()`ed text before `onChange` can read it. jsdom's script `dispatchEvent` never
    // flushes between listeners, so this test stops propagation at the target (React's root listener never runs) and
    // asserts the native listeners alone schedule no render that could rewrite the DOM value.
    it('native input listener never schedules a render that rewrites the controlled textarea before onChange (typed char survives)', async () => {
      const suggestSpy = vi
        .spyOn(searchApi, 'suggest')
        .mockResolvedValue(makeEmptySuggestResponse());

      renderOmnibox();
      const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' }) as HTMLTextAreaElement;
      const stopRootListener = (event: Event) => {
        event.stopPropagation();
      };
      textarea.addEventListener('input', stopRootListener);
      try {
        dispatchNativeTextEdit(textarea, { inputType: 'insertText', data: 'x', nextValue: 'x' });
        // Let any render scheduled by the native listeners flush (act-environment microtasks + scheduler tick).
        await act(async () => {
          await Promise.resolve();
        });
        await delayMs(30);
        expect(textarea.value).toBe('x');

        // `fill()`-style single insertText of a whole multi-grapheme string must survive the same way.
        dispatchNativeTextEdit(textarea, {
          inputType: 'insertText',
          data: 'Cà phê',
          nextValue: 'Cà phê',
        });
        await act(async () => {
          await Promise.resolve();
        });
        await delayMs(30);
        expect(textarea.value).toBe('Cà phê');
      } finally {
        textarea.removeEventListener('input', stopRootListener);
      }
      expect(suggestSpy).not.toHaveBeenCalled();
    });

    // RV-T17-1-FE2-5: jsdom never reproduces the real-browser native-listener -> microtask -> stale-value ordering
    // (CI-41431143632-E2E-QA402), so this test is NOT a regression guard for that ordering. It asserts only the
    // post-save typed value, the native-undo revert, the surviving toast and 0 DELETEs. The ordering guards are the
    // stopPropagation test above and e2e `content-omnibox-quick-add.spec.ts:402`.
    it('after quick-add save, a typed char keeps its value and sends /suggest, native undo reverts it to empty, the toast stays, and 0 DELETE requests are sent (HM18B-R1-7)', async () => {
      vi.spyOn(contentApi, 'itemsLookupExact').mockResolvedValue({
        items: [ITEM_WIFI],
        total: 1,
        next_cursor: null,
      });
      vi.spyOn(contentApi, 'entryCreate').mockImplementation(async (itemId, body) =>
        makeEntryMeta(itemId, body.id),
      );
      const entryDeleteSpy = vi.spyOn(contentApi, 'entryDelete').mockResolvedValue(undefined);
      const suggestSpy = vi
        .spyOn(searchApi, 'suggest')
        .mockResolvedValue(makeEmptySuggestResponse());

      renderOmnibox();
      const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' }) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'wifi: keep-this-entry' } });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      await screen.findByTestId('undo-toast-item');
      expect(textarea).toHaveValue('');

      suggestSpy.mockClear();
      typeNativeString(textarea, 'x');
      // Real timers: wait past the 120 ms debounce so any late re-render has had its chance to overwrite the value.
      await waitFor(() => {
        expect(suggestSpy).toHaveBeenCalledWith(
          expect.objectContaining({ q: 'x', scope: 'all', semantic: 0 }),
          expect.anything(),
        );
      });
      expect(textarea.value).toBe('x');

      dispatchNativeTextEdit(textarea, { inputType: 'historyUndo', nextValue: '' });
      await delayMs(30);
      expect(textarea.value).toBe('');
      expect(screen.getByTestId('undo-toast-item')).toBeInTheDocument();
      expect(entryDeleteSpy).not.toHaveBeenCalled();
    });

    it('fill-style edit (one insertText with a whole name) then Enter opens the search listbox via GET /search and sends no keystroke /suggest (P03-T21 U5, FU10; vault unlocked in this unit — locked-mode coverage is e2e vault-locked-search.spec.ts)', async () => {
      const searchSpy = vi
        .spyOn(searchApi, 'search')
        .mockResolvedValue(makeSearchResponse({ items: [makeSuggestItemRow(ITEM_WIFI)] }));
      const suggestSpy = vi
        .spyOn(searchApi, 'suggest')
        .mockResolvedValue(makeEmptySuggestResponse());

      renderOmnibox();
      const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' }) as HTMLTextAreaElement;

      dispatchNativeTextEdit(textarea, {
        inputType: 'insertText',
        data: 'Cà phê',
        nextValue: 'Cà phê',
      });
      await delayMs(30);
      expect(textarea.value).toBe('Cà phê');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(await screen.findByRole('listbox')).toBeInTheDocument();
      // A tainted (fill-style) draft is searched lexically: semantic=0 (plan 2.24 item 1).
      expect(searchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'Cà phê', semantic: 0 }),
        expect.anything(),
      );
      // `fill()` is a multi-grapheme single insert: the draft is tainted, so no keystroke `/suggest` was sent.
      expect(suggestSpy).not.toHaveBeenCalled();
    });
  });
});

describe('Omnibox — P05-T17 PR 17-2a grouped dropdown, Enter /search, Tab fill + pin, # mode, ≈ toggle, 429, and native-input follow-ups', () => {
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
    clearAllUnconfirmedSaves();
    clearLockClearedNotice();
    userChangedTesting.resetCommittedUserForTests();
    setKnownDeviceSessionUserId(USER_A_ID);
    commitAuthenticatedUser(USER_A_ID);
    vi.spyOn(searchApi, 'suggest').mockResolvedValue(makeEmptySuggestResponse());
    vi.spyOn(searchApi, 'search').mockResolvedValue(makeSearchResponse());
  });

  const NEAR_BADGE = viMessages.search.match.semantic;

  function semanticClient(semanticSuggest = true): QueryClient {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedMe(queryClient, { semantic_available: true, semantic_external: false }, semanticSuggest);
    return queryClient;
  }

  function getTextbox(): HTMLTextAreaElement {
    return screen.getByRole('textbox', { name: 'Tìm hoặc lưu' }) as HTMLTextAreaElement;
  }

  /** Real native `keydown` so `defaultPrevented` is observable (Tab is a browser-default key). */
  function pressNativeKey(el: HTMLElement, key: string): KeyboardEvent {
    const evt = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    act(() => {
      el.dispatchEvent(evt);
    });
    return evt;
  }

  /** Item/tag rows only: every typed dropdown also carries the "Tạo mục" CTA option in its last group. */
  function rowOptions(listbox: HTMLElement): HTMLElement[] {
    return Array.from(
      listbox.querySelectorAll<HTMLElement>(
        '[role="option"][data-opt-kind="item"], [role="option"][data-opt-kind="tag"]',
      ),
    );
  }

  function optionKeys(listbox: HTMLElement): string[] {
    return within(listbox)
      .getAllByRole('option')
      .map((option) => option.getAttribute('data-opt-key') ?? '');
  }

  it('late near keeps lexical DOM nodes (same element refs) and activeKey', async () => {
    const { promise: heldNear, resolve: resolveNear } = Promise.withResolvers<SuggestResponse>();
    const lexicalRows = {
      items: [makeSuggestItemRow(ITEM_WIFI), makeSuggestItemRow(ITEM_WIFI_GUEST)],
    };
    const suggestSpy = vi.spyOn(searchApi, 'suggest').mockImplementation(async (params) => {
      if (params?.semantic === 1) return heldNear;
      return makeEmptySuggestResponse({ ...lexicalRows, semantic_reason: 'request_lexical' });
    });

    renderOmnibox(<Omnibox />, { queryClient: semanticClient() });
    const textarea = getTextbox();
    typeNativeString(textarea, 'wif');

    const listbox = await screen.findByRole('listbox');
    const before = rowOptions(listbox);
    expect(before).toHaveLength(2);
    expect(screen.getByTestId('omnibox-status-near-pending')).toBeInTheDocument();

    // Activate the SECOND lexical row, then let the late near zone land.
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(before[1]).toHaveAttribute('aria-selected', 'true');
    expect(textarea).toHaveAttribute('aria-activedescendant', before[1]!.id);

    await act(async () => {
      resolveNear(
        makeEmptySuggestResponse({
          ...lexicalRows,
          near: [makeSuggestItemRow(ITEM_ROUTER_NEAR, { match: 'semantic' })],
          semantic: true,
          semantic_reason: null,
          generation: 7,
        }),
      );
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(rowOptions(screen.getByRole('listbox'))).toHaveLength(3);
    });

    // Same listbox, same lexical option elements (no remount), same active row; the near row is appended after them.
    expect(screen.getByRole('listbox')).toBe(listbox);
    const after = rowOptions(listbox);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[1]).toHaveAttribute('aria-selected', 'true');
    expect(textarea).toHaveAttribute('aria-activedescendant', before[1]!.id);
    expect(within(after[2]!).getByText(NEAR_BADGE)).toBeInTheDocument();
    expect(within(before[0]!).queryByText(NEAR_BADGE)).not.toBeInTheDocument();
    expect(within(before[1]!).queryByText(NEAR_BADGE)).not.toBeInTheDocument();
    expect(screen.queryByTestId('omnibox-status-near-pending')).not.toBeInTheDocument();
    expect(suggestSpy).toHaveBeenCalledTimes(2);
    // The late near is counted in the one spoken announcement (no separate "added" line while the 500 ms timer is pending).
    await waitFor(() => {
      expect(screen.getByTestId('omnibox-live')).toHaveTextContent('3 gợi ý');
    });
  });

  it('partial lexical response does not replace rows', async () => {
    const suggestSpy = vi.spyOn(searchApi, 'suggest').mockImplementation(async (params) => {
      if (params?.q === 'wifi') {
        // Lexical corpus timed out for 'wifi': partial, so it must never define or replace the snapshot (FE-12a).
        return makeEmptySuggestResponse({
          items: [makeSuggestItemRow(ITEM_WIFI)],
          lexical_partial: ['item'],
        });
      }
      return makeEmptySuggestResponse({
        items: [makeSuggestItemRow(ITEM_WIFI), makeSuggestItemRow(ITEM_WIFI_GUEST)],
      });
    });

    renderOmnibox();
    const textarea = getTextbox();
    typeNativeString(textarea, 'wif');
    const listbox = await screen.findByRole('listbox');
    const before = rowOptions(listbox);
    expect(before).toHaveLength(2);

    typeNativeString(textarea, 'i');
    await waitFor(() => {
      expect(suggestSpy).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'wifi' }),
        expect.anything(),
      );
    });
    await act(async () => {
      await delayMs(0);
    });

    // The previous rows stay (same nodes), nothing is marked busy any more, and the partial row set is not shown alone.
    expect(screen.getByRole('listbox')).toBe(listbox);
    expect(listbox).not.toHaveAttribute('aria-busy', 'true');
    const after = rowOptions(listbox);
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(within(listbox).getByRole('option', { name: /wifi khách/ })).toBeInTheDocument();
  });

  it('toggle ≈ off removes near only', async () => {
    const lexicalRows = {
      items: [makeSuggestItemRow(ITEM_WIFI), makeSuggestItemRow(ITEM_WIFI_GUEST)],
    };
    const suggestSpy = vi.spyOn(searchApi, 'suggest').mockImplementation(async (params) =>
      params?.semantic === 1
        ? makeEmptySuggestResponse({
            ...lexicalRows,
            near: [makeSuggestItemRow(ITEM_ROUTER_NEAR, { match: 'semantic' })],
            semantic: true,
            semantic_reason: null,
            generation: 7,
          })
        : makeEmptySuggestResponse({ ...lexicalRows, semantic_reason: 'request_lexical' }),
    );
    const patchSpy = vi.spyOn(authApi, 'patchSettings').mockResolvedValue({
      user: { id: USER_A_ID },
      settings: { semantic_suggest: false },
      features: { semantic_available: true, semantic_external: false },
    } as unknown as Me);

    renderOmnibox(<Omnibox />, { queryClient: semanticClient(true) });
    const textarea = getTextbox();
    typeNativeString(textarea, 'wif');
    const listbox = await screen.findByRole('listbox');
    await waitFor(() => {
      expect(rowOptions(listbox)).toHaveLength(3);
    });
    await waitFor(() => {
      expect(screen.getByTestId('omnibox-live')).toHaveTextContent('3 gợi ý');
    });
    const before = rowOptions(listbox);
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(before[0]).toHaveAttribute('aria-selected', 'true');
    const requestsBefore = suggestSpy.mock.calls.length;

    const toggle = screen.getByRole('button', { name: 'Tìm gần nghĩa' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-pressed', 'false');
    });
    expect(patchSpy).toHaveBeenCalledWith({ semantic_suggest: false });

    // Only the near row is removed: the lexical option elements and the active row are untouched, no new request is sent.
    await waitFor(() => {
      expect(rowOptions(listbox)).toHaveLength(2);
    });
    const after = rowOptions(listbox);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText(NEAR_BADGE)).not.toBeInTheDocument();
    expect(suggestSpy.mock.calls.length).toBe(requestsBefore);
    await waitFor(() => {
      expect(screen.getByTestId('omnibox-live')).toHaveTextContent(viMessages.search.live.nearHidden);
    });
  });

  it('≈ 409 shows inline muted line', async () => {
    vi.spyOn(authApi, 'patchSettings').mockRejectedValue(
      new ProblemError({
        type: 'https://engram.zone17.click/problems/semantic_unavailable',
        title: 'Semantic search unavailable',
        status: 409,
        code: 'semantic_unavailable',
      }),
    );

    renderOmnibox(<Omnibox />, { queryClient: semanticClient(false) });
    const textarea = getTextbox();
    const toggle = screen.getByRole('button', { name: 'Tìm gần nghĩa' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await act(async () => {
      fireEvent.click(toggle);
    });

    const line = await screen.findByTestId('omnibox-status-enable409');
    expect(line).toHaveTextContent(viMessages.search.state.enable409);
    // A muted inline line only: no role/aria-live of its own, no alert/toast, the toggle stays off.
    expect(line.closest('[role],[aria-live]')).toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByTestId('undo-toast-item')).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    // The next edit clears the line.
    typeNativeString(textarea, 'a');
    await waitFor(() => {
      expect(screen.queryByTestId('omnibox-status-enable409')).not.toBeInTheDocument();
    });
  });

  it('Tab on item fills `name: ` and pins id', async () => {
    vi.spyOn(searchApi, 'suggest').mockResolvedValue(
      makeEmptySuggestResponse({ items: [makeSuggestItemRow(ITEM_WIFI)] }),
    );
    const lookupSpy = vi.spyOn(contentApi, 'itemsLookupExact');
    const itemCreateSpy = vi.spyOn(contentApi, 'itemCreate');
    const entryCreateSpy = vi
      .spyOn(contentApi, 'entryCreate')
      .mockImplementation(async (itemId, body) => ({
        id: body.id,
        item_id: itemId,
        type: 'text',
        position: 0,
        version: 1,
        plaintext_len_bucket: 256,
        created_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-01T00:00:00Z',
      }));

    renderOmnibox();
    const textarea = getTextbox();
    typeNativeString(textarea, 'wif');
    const listbox = await screen.findByRole('listbox');
    expect(rowOptions(listbox)).toHaveLength(1);

    // Tab with NO active row keeps the browser default (no preventDefault, draft untouched; RV-T17-1-FE1-5).
    const tabWithoutActive = pressNativeKey(textarea, 'Tab');
    expect(tabWithoutActive.defaultPrevented).toBe(false);
    expect(textarea).toHaveValue('wif');

    // Tab on the active ITEM row fills `<name>: ` and pins that item id.
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    const tab = pressNativeKey(textarea, 'Tab');
    expect(tab.defaultPrevented).toBe(true);
    expect(textarea).toHaveValue('wifi: ');
    expect(screen.getByTestId('omnibox-add-dest-pinned')).toHaveTextContent(
      viMessages.search.tab.pinned,
    );

    // Saving targets the pinned item id with NO exact-name lookup and NO new item (OQ-2, save-plan pinnedItemId).
    typeNativeString(textarea, 'noi-dung-bi-mat');
    expect(textarea).toHaveValue('wifi: noi-dung-bi-mat');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => {
      expect(entryCreateSpy).toHaveBeenCalledTimes(1);
    });
    expect(entryCreateSpy.mock.calls[0]?.[0]).toBe(ITEM_WIFI.id);
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(itemCreateSpy).not.toHaveBeenCalled();
  });

  it('Tab on item pin is dropped when the name part of the draft changes', async () => {
    vi.spyOn(searchApi, 'suggest').mockResolvedValue(
      makeEmptySuggestResponse({ items: [makeSuggestItemRow(ITEM_WIFI)] }),
    );
    renderOmnibox();
    const textarea = getTextbox();
    typeNativeString(textarea, 'wif');
    await screen.findByRole('listbox');
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    pressNativeKey(textarea, 'Tab');
    expect(textarea).toHaveValue('wifi: ');
    expect(screen.getByTestId('omnibox-add-dest-pinned')).toBeInTheDocument();

    // Rename the item part: the pin no longer applies (the save would look the new name up instead).
    dispatchNativeTextEdit(textarea, {
      inputType: 'deleteContentBackward',
      nextValue: 'wif: ',
    });
    await yieldToReact();
    expect(textarea).toHaveValue('wif: ');
    expect(screen.queryByTestId('omnibox-add-dest-pinned')).not.toBeInTheDocument();
  });

  it('Tab on tag fills `#display `', async () => {
    const suggestSpy = vi.spyOn(searchApi, 'suggest').mockResolvedValue(
      makeEmptySuggestResponse({
        scope: 'tag',
        mode: 'full',
        tags: [makeSuggestTagRow(TAG_NHA)],
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(contentQueryKeys.tags({ sort: 'recent' }), {
      items: [TAG_NHA, TAG_OPS],
      next_cursor: null,
    });

    renderOmnibox(<Omnibox />, { queryClient });
    const textarea = getTextbox();
    typeNativeString(textarea, '#nh');
    expect(screen.getByRole('option', { name: /#nhà/ })).toHaveAttribute('aria-selected', 'true');

    const tab = pressNativeKey(textarea, 'Tab');
    expect(tab.defaultPrevented).toBe(true);
    expect(textarea).toHaveValue('#nhà ');
    // Filling a tag never pins an item.
    expect(screen.queryByTestId('omnibox-add-dest-pinned')).not.toBeInTheDocument();

    // The fill is an own write (setDraft): the next keystroke is clean and sends the token only.
    suggestSpy.mockClear();
    typeNativeString(textarea, 'x');
    await waitFor(() => {
      expect(suggestSpy).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'nhà', scope: 'tag', semantic: 0 }),
        expect.anything(),
      );
    });
  });

  it('Tab disabled for name with colon', async () => {
    const colonItem: ItemSummary = { ...ITEM_WIFI, name: 'wifi: khách' };
    vi.spyOn(searchApi, 'suggest').mockResolvedValue(
      makeEmptySuggestResponse({ items: [makeSuggestItemRow(colonItem)] }),
    );
    renderOmnibox();
    const textarea = getTextbox();
    typeNativeString(textarea, 'wif');
    await screen.findByRole('listbox');
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });

    const tab = pressNativeKey(textarea, 'Tab');
    // Tab is swallowed (focus stays) but nothing is filled or pinned; the user is told why.
    expect(tab.defaultPrevented).toBe(true);
    expect(textarea).toHaveValue('wif');
    expect(screen.queryByTestId('omnibox-add-dest-pinned')).not.toBeInTheDocument();
    expect(screen.getByTestId('omnibox-hint')).toHaveTextContent(viMessages.search.tab.cannotFill);
    await waitFor(() => {
      expect(screen.getByTestId('omnibox-live')).toHaveTextContent(viMessages.search.tab.cannotFill);
    });
  });

  it('429 keeps rows, no toast', async () => {
    let wifiCalls = 0;
    const rows = makeEmptySuggestResponse({
      items: [makeSuggestItemRow(ITEM_WIFI), makeSuggestItemRow(ITEM_WIFI_GUEST)],
    });
    const suggestSpy = vi.spyOn(searchApi, 'suggest').mockImplementation(async (params) => {
      if (params?.q === 'wifi') {
        wifiCalls += 1;
        if (wifiCalls === 1) {
          throw new ProblemError({
            type: 'https://engram.zone17.click/problems/rate_limited',
            title: 'Too many requests',
            status: 429,
            code: 'rate_limited',
            retry_after: 1,
          });
        }
      }
      return rows;
    });
    const searchSpy = vi.spyOn(searchApi, 'search').mockRejectedValue(
      new ProblemError({
        type: 'https://engram.zone17.click/problems/rate_limited',
        title: 'Too many requests',
        status: 429,
        code: 'rate_limited',
        retry_after: 7,
      }),
    );

    renderOmnibox();
    const textarea = getTextbox();
    typeNativeString(textarea, 'wif');
    const listbox = await screen.findByRole('listbox');
    const before = rowOptions(listbox);
    expect(before).toHaveLength(2);

    // 1. A rate-limited keystroke /suggest keeps the rows (same nodes) and shows no toast / alert / red text.
    typeNativeString(textarea, 'i');
    await waitFor(() => {
      expect(wifiCalls).toBe(1);
    });
    await act(async () => {
      await delayMs(0);
    });
    expect(screen.getByRole('listbox')).toBe(listbox);
    expect(rowOptions(listbox)[0]).toBe(before[0]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByTestId('undo-toast-item')).not.toBeInTheDocument();
    expect(screen.queryByTestId('omnibox-action-error')).not.toBeInTheDocument();
    // ...and it retries ONCE after Retry-After (the gate is re-run at send time), then settles on the fresh rows.
    await waitFor(
      () => {
        expect(wifiCalls).toBe(2);
      },
      { timeout: 3000 },
    );
    await waitFor(() => {
      expect(listbox).not.toHaveAttribute('aria-busy', 'true');
    });
    expect(rowOptions(listbox)).toHaveLength(2);
    expect(suggestSpy.mock.calls.filter(([params]) => params?.q === 'wifi')).toHaveLength(2);

    // 2. A rate-limited Enter /search: rows stay, one muted line with the Retry-After seconds, no toast.
    fireEvent.keyDown(textarea, { key: 'Enter' });
    const line = await screen.findByTestId('omnibox-status-rate-limited');
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(line).toHaveTextContent('Đang gửi hơi nhanh, thử lại sau 7 giây');
    expect(line.closest('[role],[aria-live]')).toBeNull();
    expect(screen.getByRole('listbox')).toBe(listbox);
    expect(rowOptions(listbox)).toHaveLength(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByTestId('undo-toast-item')).not.toBeInTheDocument();
    expect(screen.queryByTestId('omnibox-action-error')).not.toBeInTheDocument();
  });

  it('Enter without active row runs /search', async () => {
    const suggestSpy = vi.spyOn(searchApi, 'suggest').mockResolvedValue(
      makeEmptySuggestResponse({ items: [makeSuggestItemRow(ITEM_WIFI)] }),
    );
    const searchSpy = vi.spyOn(searchApi, 'search').mockResolvedValue(
      makeSearchResponse({
        items: [makeSuggestItemRow(ITEM_WIFI), makeSuggestItemRow(ITEM_WIFI_GUEST)],
        next_cursor: 'cursor-1',
      }),
    );

    renderOmnibox();
    const textarea = getTextbox();
    typeNativeString(textarea, 'wif');
    await screen.findByRole('listbox', { name: 'Gợi ý tìm kiếm' });
    expect(suggestSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).not.toHaveBeenCalled();
    expect(textarea).not.toHaveAttribute('aria-activedescendant');

    // No row is active -> Enter searches (GET /search page 1), it does NOT open anything and does not change the URL.
    fireEvent.keyDown(textarea, { key: 'Enter' });
    const listbox = await screen.findByRole('listbox', { name: 'Kết quả tìm kiếm' });
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'wif', scope: 'all', limit: 20, semantic: 0 }),
      expect.anything(),
    );
    expect(searchSpy.mock.calls[0]?.[0]).not.toHaveProperty('cursor');
    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(rowOptions(listbox)).toHaveLength(2);
    // The CTA and "Xem thêm" are the options of the LAST group.
    const groups = within(listbox).getAllByRole('group');
    const lastGroup = groups[groups.length - 1]!;
    expect(within(lastGroup).getByRole('option', { name: 'Xem thêm' })).toBeInTheDocument();
    expect(within(lastGroup).getByRole('option', { name: /Tạo mục “wif”/ })).toBeInTheDocument();
    expect(screen.getByTestId('omnibox-result-count')).toHaveTextContent('2 kết quả');

    // With an ACTIVE row Enter opens it and sends no further /search.
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(mockRouterPush).toHaveBeenCalledWith(`/app/items/${ITEM_WIFI.id}`);
    expect(searchSpy).toHaveBeenCalledTimes(1);
  });

  it('Enter with normalised-empty q shows no-match without /search', async () => {
    const searchSpy = vi.spyOn(searchApi, 'search');
    renderOmnibox();
    const textarea = getTextbox();

    typeNativeString(textarea, '!!!');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const box = await screen.findByTestId('omnibox-search-empty');
    expect(box).toHaveTextContent('Không khớp “!!!”');
    await waitFor(() => {
      expect(screen.getByTestId('omnibox-live')).toHaveTextContent('Không khớp “!!!”');
    });
    expect(searchSpy).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
    // Still creatable as an empty item, and the next edit drops the local no-match box.
    expect(screen.getByRole('option', { name: /Tạo mục “!!!”/ })).toBeInTheDocument();
    typeNativeString(textarea, 'a');
    await waitFor(() => {
      expect(screen.queryByTestId('omnibox-search-empty')).not.toBeInTheDocument();
    });
  });

  it('Enter /search passes expectSemantic explicitly: a tainted draft sends semantic=0 and never shows the near-pending line, a clean one sends semantic=1 (RV-T9-FE3-1)', async () => {
    const searchSpy = vi.spyOn(searchApi, 'search').mockImplementation(async (params) =>
      params.semantic === 1
        ? makeSearchResponse({
            items: [makeSuggestItemRow(ITEM_WIFI)],
            near: [makeSuggestItemRow(ITEM_ROUTER_NEAR, { match: 'semantic' })],
            semantic: true,
            semantic_reason: null,
            generation: 4,
          })
        : makeSearchResponse({
            items: [makeSuggestItemRow(ITEM_WIFI)],
            semantic: false,
            semantic_reason: 'request_lexical',
          }),
    );

    renderOmnibox(<Omnibox />, { queryClient: semanticClient(true) });
    const textarea = getTextbox();

    // Tainted draft (fireEvent.change is not a clean typed edit): lexical only, nothing pending.
    fireEvent.change(textarea, { target: { value: 'wif' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await screen.findByRole('listbox', { name: 'Kết quả tìm kiếm' });
    expect(searchSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'wif', semantic: 0 }),
      expect.anything(),
    );
    expect(screen.queryByTestId('omnibox-status-near-pending')).not.toBeInTheDocument();
    expect(screen.queryByText(NEAR_BADGE)).not.toBeInTheDocument();

    // Clean typed draft: semantic=1, the near row arrives with the first page and carries the ≈ badge.
    dispatchNativeTextEdit(textarea, { inputType: 'deleteWordBackward', nextValue: '' });
    await yieldToReact();
    typeNativeString(textarea, 'wif');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => {
      expect(searchSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: 'wif', scope: 'all', semantic: 1 }),
        expect.anything(),
      );
    });
    expect(await screen.findByText(NEAR_BADGE)).toBeInTheDocument();
    expect(screen.queryByTestId('omnibox-status-near-pending')).not.toBeInTheDocument();
  });

  it('Xem thêm appends cursor pages deduped by (kind,id), also against page-1 near rows, and always sends semantic=0 (FE-C24)', async () => {
    const itemX: ItemSummary = {
      ...ITEM_WIFI,
      id: '6666ffff-6666-4666-8666-666666666666',
      name: 'wifi quán cà phê',
      tags: [],
    };
    const searchSpy = vi.spyOn(searchApi, 'search').mockImplementation(async (params) =>
      params.cursor === undefined
        ? makeSearchResponse({
            items: [makeSuggestItemRow(ITEM_WIFI), makeSuggestItemRow(ITEM_WIFI_GUEST)],
            near: [makeSuggestItemRow(ITEM_ROUTER_NEAR, { match: 'semantic' })],
            semantic: true,
            semantic_reason: null,
            generation: 9,
            next_cursor: 'cursor-2',
          })
        : makeSearchResponse({
            // GUEST repeats page 1; ROUTER_NEAR was a page-1 NEAR row and now matches lexically.
            items: [
              makeSuggestItemRow(ITEM_WIFI_GUEST),
              makeSuggestItemRow(ITEM_ROUTER_NEAR),
              makeSuggestItemRow(itemX),
            ],
            near: [],
            semantic: false,
            semantic_reason: 'request_lexical',
            generation: null,
            next_cursor: null,
          }),
    );

    renderOmnibox(<Omnibox />, { queryClient: semanticClient(true) });
    const textarea = getTextbox();
    typeNativeString(textarea, 'wif');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    const listbox = await screen.findByRole('listbox', { name: 'Kết quả tìm kiếm' });
    await waitFor(() => {
      expect(optionKeys(listbox)).toEqual([
        `item:${ITEM_WIFI.id}`,
        `item:${ITEM_WIFI_GUEST.id}`,
        `item:${ITEM_ROUTER_NEAR.id}`,
        'action:more',
        'action:create',
      ]);
    });
    expect(listbox.querySelector('[data-zone="near"]')).not.toBeNull();
    const firstPageNodes = within(listbox).getAllByRole('option').slice(0, 2);

    // Keyboard: ArrowUp x2 from "no active row" lands on "Xem thêm" (create is the last action); Enter loads page 2.
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    const more = within(listbox).getByRole('option', { name: 'Xem thêm' });
    expect(textarea).toHaveAttribute('aria-activedescendant', more.id);
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(searchSpy).toHaveBeenCalledTimes(2);
    });
    expect(searchSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'wif', scope: 'all', cursor: 'cursor-2', semantic: 0 }),
      expect.anything(),
    );
    await waitFor(() => {
      expect(optionKeys(listbox)).toContain(`item:${itemX.id}`);
    });

    // Every (kind,id) appears exactly once: page-2 repeats are skipped, the page-1 near row moved into the lexical Items
    // group (so the near zone is gone), "Xem thêm" disappears with the cursor, and page-1 nodes are untouched.
    const keys = optionKeys(listbox);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      `item:${ITEM_WIFI.id}`,
      `item:${ITEM_WIFI_GUEST.id}`,
      `item:${ITEM_ROUTER_NEAR.id}`,
      `item:${itemX.id}`,
      'action:create',
    ]);
    expect(listbox.querySelector('[data-zone="near"]')).toBeNull();
    expect(within(listbox).queryByRole('option', { name: 'Xem thêm' })).not.toBeInTheDocument();
    expect(within(listbox).getAllByRole('option').slice(0, 2)[0]).toBe(firstPageNodes[0]);
    expect(within(listbox).getAllByRole('option').slice(0, 2)[1]).toBe(firstPageNodes[1]);
  });

  it('Enter-search (semantic=1) -> Xem thêm -> page-1 near rows still shown, no degraded line (SPEC §6.8, RV-T17-2-FE1-6)', async () => {
    const itemX: ItemSummary = {
      ...ITEM_WIFI,
      id: '7777ffff-7777-4777-8777-777777777777',
      name: 'wifi nhà ga',
      tags: [],
    };
    const searchSpy = vi.spyOn(searchApi, 'search').mockImplementation(async (params) =>
      params.cursor === undefined
        ? makeSearchResponse({
            items: [makeSuggestItemRow(ITEM_WIFI), makeSuggestItemRow(ITEM_WIFI_GUEST)],
            near: [makeSuggestItemRow(ITEM_ROUTER_NEAR, { match: 'semantic' })],
            semantic: true,
            semantic_reason: null,
            generation: 9,
            next_cursor: 'cursor-2',
          })
        : // A cursor page is always lexical-only (`semantic=0`): it never repeats the near row.
          makeSearchResponse({
            items: [makeSuggestItemRow(itemX)],
            near: [],
            semantic: false,
            semantic_reason: 'request_lexical',
            generation: null,
            next_cursor: null,
          }),
    );

    renderOmnibox(<Omnibox />, { queryClient: semanticClient(true) });
    const textarea = getTextbox();
    typeNativeString(textarea, 'wif');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    const listbox = await screen.findByRole('listbox', { name: 'Kết quả tìm kiếm' });
    await waitFor(() => {
      expect(optionKeys(listbox)).toContain('action:more');
    });
    expect(screen.getByText(NEAR_BADGE)).toBeInTheDocument();
    const nearNode = listbox.querySelector(`[data-opt-key="item:${ITEM_ROUTER_NEAR.id}"]`);
    expect(nearNode).not.toBeNull();

    fireEvent.click(within(listbox).getByRole('option', { name: 'Xem thêm' }));
    await waitFor(() => {
      expect(searchSpy).toHaveBeenCalledTimes(2);
    });
    expect(searchSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'wif', cursor: 'cursor-2', semantic: 0 }),
      expect.anything(),
    );
    await waitFor(() => {
      expect(optionKeys(listbox)).toContain(`item:${itemX.id}`);
    });

    // Page 2 appended its row; the page-1 near row is still in the near zone with its ≈ badge, and no degraded line shows.
    expect(listbox.querySelector('[data-zone="near"]')).not.toBeNull();
    expect(listbox.querySelector(`[data-opt-key="item:${ITEM_ROUTER_NEAR.id}"]`)).toBe(nearNode);
    expect(screen.getByText(NEAR_BADGE)).toBeInTheDocument();
    expect(screen.queryByTestId('omnibox-status-degraded')).not.toBeInTheDocument();
    expect(screen.queryByTestId('omnibox-status-near-pending')).not.toBeInTheDocument();
    const keys = optionKeys(listbox);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('prefix_folded rows highlight with the folded variant: query duong marks "Đường" (SPEC §6.8, RV-T17-2-FE1-4)', async () => {
    const itemFolded: ItemSummary = {
      ...ITEM_WIFI,
      id: '8888ffff-8888-4888-8888-888888888888',
      name: 'Đường đi',
      tags: [],
    };
    const itemFuzzy: ItemSummary = {
      ...ITEM_WIFI,
      id: '9999ffff-9999-4999-8999-999999999999',
      name: 'duong cụt',
      tags: [],
    };
    vi.spyOn(searchApi, 'suggest').mockResolvedValue(
      makeEmptySuggestResponse({
        items: [
          makeSuggestItemRow(itemFolded, { match: 'prefix_folded' }),
          makeSuggestItemRow(itemFuzzy, { match: 'fuzzy' }),
        ],
        semantic_reason: 'request_lexical',
      }),
    );

    renderOmnibox(<Omnibox />);
    const textarea = getTextbox();
    typeNativeString(textarea, 'duong');
    const listbox = await screen.findByRole('listbox');
    await waitFor(() => {
      expect(rowOptions(listbox)).toHaveLength(2);
    });
    const foldedRow = listbox.querySelector(`[data-opt-key="item:${itemFolded.id}"]`);
    const fuzzyRow = listbox.querySelector(`[data-opt-key="item:${itemFuzzy.id}"]`);
    expect(foldedRow?.querySelector('mark')?.textContent).toBe('Đường');
    expect(foldedRow?.querySelector('.omni-opt-title')?.textContent).toBe('Đường đi');
    // `fuzzy` rows get no mark at all.
    expect(fuzzyRow?.querySelector('mark')).toBeNull();
  });

  it('≈ toggle keeps the textarea focused on pointer-down (WebKit would blur and close the dropdown) (RV-T17-2-FE1-5)', async () => {
    const patchSpy = vi.spyOn(authApi, 'patchSettings').mockResolvedValue({
      user: { id: USER_A_ID },
      settings: { semantic_suggest: true },
      features: { semantic_available: true, semantic_external: false },
    } as unknown as Me);
    vi.spyOn(searchApi, 'suggest').mockResolvedValue(
      makeEmptySuggestResponse({
        items: [makeSuggestItemRow(ITEM_WIFI)],
        semantic_reason: 'request_lexical',
      }),
    );

    renderOmnibox(<Omnibox />, { queryClient: semanticClient(false) });
    const textarea = getTextbox();
    textarea.focus();
    typeNativeString(textarea, 'wif');
    const listbox = await screen.findByRole('listbox');
    await waitFor(() => {
      expect(rowOptions(listbox)).toHaveLength(1);
    });

    const toggle = screen.getByRole('button', { name: 'Tìm gần nghĩa' });
    // A prevented mousedown is what stops the browser moving focus off the textarea (blur with relatedTarget === null).
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => {
      toggle.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true);
    expect(textarea).toHaveFocus();
    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith({ semantic_suggest: true });
    });
    expect(screen.getByRole('listbox')).toBe(listbox);
    expect(textarea).toHaveFocus();
  });

  it('unmount aborts an in-flight "Xem thêm" request (RV-T17-2-FE1-8)', async () => {
    const signals: AbortSignal[] = [];
    vi.spyOn(searchApi, 'search').mockImplementation(async (params, opts) => {
      if (params.cursor === undefined) {
        return makeSearchResponse({
          items: [makeSuggestItemRow(ITEM_WIFI)],
          next_cursor: 'cursor-2',
        });
      }
      const signal = opts?.signal ?? params.signal;
      if (signal) signals.push(signal);
      return new Promise<SearchResponse>(() => {});
    });

    const { unmount } = renderOmnibox(<Omnibox />);
    const textarea = getTextbox();
    typeNativeString(textarea, 'wif');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    const listbox = await screen.findByRole('listbox', { name: 'Kết quả tìm kiếm' });
    fireEvent.click(await within(listbox).findByRole('option', { name: 'Xem thêm' }));
    await waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    expect(signals[0]?.aborted).toBe(false);
    unmount();
    expect(signals[0]?.aborted).toBe(true);
  });

  it('tag mode first cached row active, server rows replace keeping activeKey', async () => {
    const tagOracle: Tag = {
      id: 'dddd4444-4444-4444-8444-444444444444',
      display: 'oracle',
      item_count: 2,
      last_used_at: '2026-11-01T00:00:00Z',
      created_at: '2026-11-01T00:00:00Z',
    };
    const { promise: heldTagRows, resolve: resolveTagRows } =
      Promise.withResolvers<SuggestResponse>();
    const suggestSpy = vi.spyOn(searchApi, 'suggest').mockImplementation(() => heldTagRows);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(contentQueryKeys.tags({ sort: 'recent' }), {
      items: [TAG_OPS, TAG_NHA],
      next_cursor: null,
    });

    renderOmnibox(<Omnibox />, { queryClient });
    const textarea = getTextbox();
    typeNativeString(textarea, '#o');

    // Cached row shows INSTANTLY (no request has resolved) and is the active row.
    const listbox = screen.getByRole('listbox', { name: 'Kết quả lọc tag' });
    const cachedOps = within(listbox).getByRole('option', { name: /#ops/ });
    expect(within(listbox).getAllByRole('option')).toHaveLength(1);
    expect(cachedOps).toHaveAttribute('aria-selected', 'true');
    expect(textarea).toHaveAttribute('aria-activedescendant', cachedOps.id);
    await waitFor(() => {
      expect(suggestSpy).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'o', scope: 'tag', semantic: 0 }),
        expect.anything(),
      );
    });

    // Server rows REPLACE the tag group (a new row now sorts first) but the active row is kept, not reset to the first row.
    await act(async () => {
      resolveTagRows(
        makeEmptySuggestResponse({
          scope: 'tag',
          mode: 'full',
          tags: [makeSuggestTagRow(tagOracle), makeSuggestTagRow(TAG_OPS)],
        }),
      );
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(within(listbox).getAllByRole('option')).toHaveLength(2);
    });
    const rows = within(listbox).getAllByRole('option');
    expect(rows[0]).toHaveAttribute('data-opt-key', `tag:${tagOracle.id}`);
    expect(rows[1]).toBe(cachedOps);
    expect(rows[1]).toHaveAttribute('aria-selected', 'true');
    expect(rows[0]).toHaveAttribute('aria-selected', 'false');
    expect(textarea).toHaveAttribute('aria-activedescendant', cachedOps.id);

    // Enter opens the kept active tag.
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(mockRouterPush).toHaveBeenCalledWith(`/app?tag=${TAG_OPS.id}`);
  });

  it('listbox has groups with headings, status lines outside listbox and outside the sr-only live region', async () => {
    const { promise: heldNear, resolve: resolveNear } = Promise.withResolvers<SuggestResponse>();
    let degradeNext = false;
    const lexical = {
      tags: [makeSuggestTagRow(TAG_NHA)],
      items: [makeSuggestItemRow(ITEM_WIFI)],
    };
    vi.spyOn(searchApi, 'suggest').mockImplementation(async (params) => {
      if (params?.semantic === 1) {
        if (degradeNext) throw new Error('semantic leg failed');
        return heldNear;
      }
      return makeEmptySuggestResponse({ ...lexical, semantic_reason: 'request_lexical' });
    });

    renderOmnibox(<Omnibox />, { queryClient: semanticClient(true) });
    const textarea = getTextbox();
    typeNativeString(textarea, 'wif');
    const listbox = await screen.findByRole('listbox');
    const live = screen.getByTestId('omnibox-live');

    // listbox -> group (aria-labelledby heading) -> option; no option sits directly under the listbox.
    const groups = Array.from(listbox.querySelectorAll(':scope > [role="group"]'));
    expect(groups.map((group) => group.getAttribute('data-zone'))).toEqual([
      'tags',
      'items',
      'actions',
    ]);
    for (const group of groups) {
      const headingId = group.getAttribute('aria-labelledby');
      expect(headingId).toBeTruthy();
      const heading = document.getElementById(headingId!);
      expect(heading).not.toBeNull();
      expect(group.contains(heading)).toBe(true);
      expect(heading?.textContent).toMatch(/^(Tag|Mục|Thao tác)$/);
      expect(heading).not.toHaveAttribute('role', 'option');
    }
    expect(listbox.querySelectorAll(':scope > [role="option"]')).toHaveLength(0);
    for (const option of within(listbox).getAllByRole('option')) {
      expect(option.parentElement?.getAttribute('role')).toBe('group');
    }

    // The visible "searching by meaning" line is a separate element OUTSIDE the listbox, with no live semantics of its own,
    // and the sr-only live region carries spoken text only (no element children, not the visible status text).
    const pending = screen.getByTestId('omnibox-status-near-pending');
    expect(listbox.contains(pending)).toBe(false);
    expect(live.contains(pending)).toBe(false);
    expect(pending.closest('[role="status"],[aria-live],[role="alert"],[role="listbox"]')).toBeNull();
    expect(pending).not.toHaveAttribute('role');
    expect(pending).not.toHaveAttribute('aria-live');
    expect(live).toHaveClass('sr-only');
    expect(live.children).toHaveLength(0);
    expect(live).not.toHaveTextContent(viMessages.search.state.nearPending);

    // Near lands: the line goes away, the near group is appended INSIDE the listbox as a labelled group.
    await act(async () => {
      resolveNear(
        makeEmptySuggestResponse({
          ...lexical,
          near: [makeSuggestItemRow(ITEM_ROUTER_NEAR, { match: 'semantic' })],
          semantic: true,
          semantic_reason: null,
          generation: 3,
        }),
      );
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(listbox.querySelector('[data-zone="near"]')).not.toBeNull();
    });
    expect(screen.queryByTestId('omnibox-status-near-pending')).not.toBeInTheDocument();

    // A failed semantic leg shows the muted "degraded" line, again outside the listbox and outside the live region.
    degradeNext = true;
    typeNativeString(textarea, 'i');
    const degraded = await screen.findByTestId('omnibox-status-degraded');
    expect(degraded).toHaveTextContent(viMessages.search.state.degraded);
    expect(listbox.contains(degraded)).toBe(false);
    expect(live.contains(degraded)).toBe(false);
    expect(degraded.closest('[role="status"],[aria-live],[role="alert"],[role="listbox"]')).toBeNull();
    expect(live.children).toHaveLength(0);
  });

  // RV-T17-1-FE2-4: a native `input` that React turns into NO `onChange` (value tracker / stopPropagation) must still abort the
  // old draft's in-flight suggest request immediately and then re-render + re-send through the macrotask fallback, without
  // scheduling a React update from the native listener itself (CI-41431143632-E2E-QA402).
  it('native input with no React onChange still aborts in-flight suggest and re-renders via macrotask fallback', async () => {
    const signals: AbortSignal[] = [];
    const { promise: heldWi, resolve: resolveHeldWi } = Promise.withResolvers<SuggestResponse>();
    const suggestSpy = vi.spyOn(searchApi, 'suggest').mockImplementation((params, opts) => {
      if (opts?.signal) signals.push(opts.signal);
      return params?.q === 'wi' ? heldWi : Promise.resolve(makeEmptySuggestResponse());
    });

    renderOmnibox();
    const textarea = getTextbox();
    typeNativeString(textarea, 'wi');
    await waitFor(() => {
      expect(suggestSpy).toHaveBeenCalledTimes(1);
    });
    expect(signals[0]?.aborted).toBe(false);

    // The root (React) listener never sees this event.
    const stopRootListener = (event: Event) => {
      event.stopPropagation();
    };
    textarea.addEventListener('input', stopRootListener);
    try {
      dispatchNativeTextEdit(textarea, { inputType: 'insertText', data: 'x', nextValue: 'wix' });
      // Synchronously, from the native listener alone: the old draft's request is aborted (pure refs, no React update).
      expect(signals[0]?.aborted).toBe(true);
      expect(suggestSpy).toHaveBeenCalledTimes(1);
      resolveHeldWi(makeEmptySuggestResponse({ items: [makeSuggestItemRow(ITEM_WIFI)] }));

      // The macrotask fallback adopts the DOM value, re-renders and re-sends for the NEW draft only.
      await waitFor(() => {
        expect(suggestSpy).toHaveBeenCalledWith(
          expect.objectContaining({ q: 'wix', scope: 'all', semantic: 0 }),
          expect.anything(),
        );
      });
      expect(textarea.value).toBe('wix');
      expect(screen.getByTestId('omnibox-hint')).not.toHaveAttribute('hidden');
      // The aborted 'wi' response never opened rows.
      expect(screen.queryByRole('option', { name: /wifi/ })).not.toBeInTheDocument();
    } finally {
      textarea.removeEventListener('input', stopRootListener);
    }
  });

  // RV-T17-1-FE2-6: the reset helper (lock / logout / user switch) cancels the two macrotask timers armed by the native input
  // and composition listeners, so a late callback cannot re-render or re-send for the old draft.
  it('reset helper cancels nativeInputFlagTimerRef and compositionDeferTimerRef', async () => {
    const suggestSpy = vi.spyOn(searchApi, 'suggest').mockResolvedValue(makeEmptySuggestResponse());
    const realSetTimeout = window.setTimeout.bind(window);
    const realClearTimeout = window.clearTimeout.bind(window);
    const zeroDelayIds: number[] = [];
    const clearedIds = new Set<number>();
    let recording = false;
    vi.spyOn(window, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      const id = realSetTimeout(handler, timeout, ...args);
      if (recording && timeout === 0) zeroDelayIds.push(id as unknown as number);
      return id;
    }) as typeof window.setTimeout);
    vi.spyOn(window, 'clearTimeout').mockImplementation(((id?: number) => {
      if (id !== undefined) clearedIds.add(id);
      realClearTimeout(id);
    }) as typeof window.clearTimeout);

    renderOmnibox();
    const textarea = getTextbox();
    const stopRootListener = (event: Event) => {
      event.stopPropagation();
    };
    textarea.addEventListener('input', stopRootListener);
    try {
      // Arm the native-input flag timer (the last 0 ms timer armed by that listener).
      recording = true;
      dispatchNativeTextEdit(textarea, { inputType: 'insertText', data: 'x', nextValue: 'x' });
      const nativeInputTimerId = zeroDelayIds[zeroDelayIds.length - 1];
      expect(nativeInputTimerId).toBeDefined();
      // Arm the composition defer timer.
      const armedBeforeComposition = zeroDelayIds.length;
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      expect(zeroDelayIds.length).toBeGreaterThan(armedBeforeComposition);
      const compositionTimerId = zeroDelayIds[zeroDelayIds.length - 1];
      recording = false;
      expect(compositionTimerId).not.toBe(nativeInputTimerId);

      // Lock the vault BEFORE either macrotask runs.
      act(() => {
        triggerVaultLockReset();
      });
      expect(clearedIds.has(nativeInputTimerId!)).toBe(true);
      expect(clearedIds.has(compositionTimerId!)).toBe(true);
      expect(textarea).toHaveValue('');

      // The cancelled callbacks never run: no re-send for the old draft after the lock.
      await act(async () => {
        await delayMs(160);
      });
      expect(suggestSpy).not.toHaveBeenCalled();
      expect(textarea).toHaveValue('');
    } finally {
      textarea.removeEventListener('input', stopRootListener);
    }
  });
});
