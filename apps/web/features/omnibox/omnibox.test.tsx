import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import * as contentApi from '@/lib/api/content';
import type { ItemSummary, Tag } from '@/lib/api/content';
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

const registeredResetFns = new Set<() => void>();
let mockVaultState: 'locked' | 'unlocked' = 'unlocked';

function triggerVaultLockReset() {
  mockVaultState = 'locked';
  for (const fn of registeredResetFns) {
    fn();
  }
}

vi.mock('@/features/vault/vault-provider', () => ({
  useOptionalVault: () => ({
    state: mockVaultState,
    minutesLeft: 15,
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
}));

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
    mockVaultState = 'unlocked';
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

    // Search mode -> searchHint visible, mentions Ctrl+Enter and server/unencrypted
    fireEvent.change(textarea, { target: { value: 'wifi' } });
    expect(hint).not.toHaveAttribute('hidden');
    expect(hint).toHaveTextContent(/Ctrl\+Enter/);
    expect(hint).toHaveTextContent(/gửi tới máy chủ, không mã hoá/);

    // Tag filter mode (#…) -> tagHint visible, Ctrl+Enter does nothing
    fireEvent.change(textarea, { target: { value: '#nhà' } });
    expect(hint).not.toHaveAttribute('hidden');
    expect(hint).toHaveTextContent(viMessages.content.omnibox.tagHint);
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
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
    await screen.findByRole('listbox', { name: 'Kết quả tìm kiếm' });
    expect(itemsSpy).toHaveBeenCalledTimes(1);
    expect(itemsSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: 'alpha', q: 'wifi' }),
    );
    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(mockRouterReplace).not.toHaveBeenCalled();

    // Up to 3 tag chips + +1 overflow and entry count rendered
    expect(screen.getByText('#nhà')).toBeInTheDocument();
    expect(screen.getByText('#ops')).toBeInTheDocument();
    expect(screen.getByText('#home-lab')).toBeInTheDocument();
    expect(screen.queryByText('#backup')).not.toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByText('12 entry')).toBeInTheDocument();
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

    // Typing #nh -> filters client-side from cache, 0 network requests
    fireEvent.change(textarea, { target: { value: '#nh' } });
    expect(tagsSpy).not.toHaveBeenCalled();
    const listbox = screen.getByRole('listbox', { name: 'Kết quả lọc tag' });
    expect(within(listbox).getByRole('option', { name: /nhà/ })).toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: /ops/ })).not.toBeInTheDocument();

    // Enter on highlighted cached tag -> navigates to /app?tag=<id> (never tag name)
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(mockRouterPush).toHaveBeenCalledWith(`/app?tag=${TAG_NHA.id}`);
    expect(tagsSpy).not.toHaveBeenCalled();

    // Typing #clo (not in cache) -> still 0 requests while typing
    fireEvent.change(textarea, { target: { value: '#clo' } });
    expect(tagsSpy).not.toHaveBeenCalled();

    // Pressing Enter when not in cache -> sends GET /tags?q=clo
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => {
      expect(tagsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'alpha', q: 'clo' }),
      );
    });
    expect(await screen.findByRole('option', { name: /cloud/ })).toBeInTheDocument();

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

  it('clears textarea, closes listbox, clears live region, and removes search queries from QueryCache on vault lock (P4FE3-5, P4FE4-8)', async () => {
    const secretQuery = 'pasted-secret-token-7788';
    vi.spyOn(contentApi, 'itemsList').mockResolvedValue({
      items: [],
      next_cursor: null,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = renderOmnibox(<Omnibox />, { queryClient });
    const textarea = screen.getByRole('textbox', { name: 'Tìm hoặc lưu' });

    // Type a string in search mode and press Enter (empty result renders the string in DOM)
    fireEvent.change(textarea, { target: { value: secretQuery } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await screen.findByRole('listbox', { name: 'Kết quả tìm kiếm' });
    expect(container.textContent).toContain(secretQuery);

    // Lock the vault -> synchronous reset runs
    act(() => {
      triggerVaultLockReset();
    });

    expect(textarea).toHaveValue('');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByTestId('omnibox-live')).toHaveTextContent('');
    expect(container.innerHTML).not.toContain(secretQuery);
    assertNoPlaintextAttrs(container, [secretQuery], { locked: true });

    // Verify every QueryCache key and state is free of the search string
    const allQueries = queryClient.getQueryCache().getAll();
    const serializedCache = JSON.stringify(
      allQueries.map((q) => ({ key: q.queryKey, data: q.state.data })),
    );
    expect(serializedCache).not.toContain(secretQuery);
  });

  it('renders English strings with zero hard-coded Vietnamese in en locale (UIA-2) and applies placeholder ellipsis (UIA-20)', async () => {
    vi.spyOn(contentApi, 'itemsList').mockResolvedValue({
      items: [],
      next_cursor: null,
    });

    const { container } = renderOmnibox(<Omnibox />, { locale: 'en' });
    const textarea = screen.getByRole('textbox', { name: 'Search or save' });

    expect(textarea).toHaveAttribute('placeholder', enMessages.content.omnibox.placeholder);
    expect(textarea.className).toContain('placeholder:text-ellipsis');

    fireEvent.change(textarea, { target: { value: 'router' } });
    expect(screen.getByTestId('omnibox-hint')).toHaveTextContent(
      enMessages.content.omnibox.searchHint,
    );

    fireEvent.keyDown(textarea, { key: 'Enter' });
    await screen.findByRole('listbox', { name: 'Search results' });
    expect(screen.getByText('No items starting with “router”')).toBeInTheDocument();
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
