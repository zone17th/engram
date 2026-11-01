import { ProblemError } from '@engram/shared-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppPage from '@/app/app/page';
import { ThemeProvider } from '@/components/theme-provider';
import { UndoToastProvider } from '@/components/ui/undo-toast';
import { configureContentQueryDefaults } from '@/features/items/query-keys';
import * as contentApi from '@/lib/api/content';
import type { ItemSummary, Tag } from '@/lib/api/content';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';

let mockSearchParamsString = '';
let mockVaultState: 'locked' | 'unlocked' = 'unlocked';
const mockReplace = vi.fn((url: string) => {
  const qIndex = url.indexOf('?');
  mockSearchParamsString = qIndex >= 0 ? url.slice(qIndex + 1) : '';
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: mockReplace,
    push: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/app',
  useSearchParams: () => new URLSearchParams(mockSearchParamsString),
}));

vi.mock('@/features/auth/session-provider', () => ({
  useSession: () => ({
    status: 'authenticated_with_vault',
    me: {
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'user@example.test',
        email_verified: true,
        created_at: '2026-11-01T00:00:00Z',
      },
      settings: {
        locale: 'vi',
        theme: 'light',
        auto_lock_minutes: 15,
        semantic_suggest: false,
      },
      identities: [{ provider: 'password', linked_at: '2026-11-01T00:00:00Z' }],
      features: {
        semantic_available: false,
        email_verification_required: false,
        oauth_providers: [],
        oauth_reauth_providers: [],
        password_enrollment_available: false,
        captcha_site_key: null,
      },
      vault: { status: 'present' },
    },
    signOut: vi.fn(),
  }),
}));

vi.mock('@/features/vault/vault-provider', () => ({
  useOptionalVault: () => ({
    state: mockVaultState,
    minutesLeft: 15,
    lockNow: vi.fn(),
  }),
}));

const TAG_NHA: Tag = {
  id: 'aaaa1111-1111-4111-8111-111111111111',
  display: 'nhà',
  item_count: 2,
  last_used_at: '2026-11-01T00:00:00Z',
  created_at: '2026-11-01T00:00:00Z',
};

const TAG_OPS: Tag = {
  id: 'bbbb2222-2222-4222-8222-222222222222',
  display: 'ops',
  item_count: 1,
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

const ITEM_DOCKER: ItemSummary = {
  id: '2222bbbb-2222-4222-8222-222222222222',
  name: 'docker',
  hint: null,
  tags: [{ id: TAG_OPS.id, display: TAG_OPS.display }],
  entry_count: 4,
  version: 1,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  last_used_at: '2026-11-01T00:00:00Z',
};

function createTestQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 30_000 },
      mutations: { retry: false },
    },
  });
  configureContentQueryDefaults(client);
  return client;
}

function renderHomePage(
  ui: ReactNode = <AppPage />,
  {
    locale = 'vi',
    queryClient = createTestQueryClient(),
  }: { locale?: 'en' | 'vi'; queryClient?: QueryClient } = {},
) {
  const messages = locale === 'en' ? enMessages : viMessages;
  return {
    queryClient,
    ...render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <ThemeProvider initialLocale={locale} initialTheme="light">
          <QueryClientProvider client={queryClient}>
            <UndoToastProvider>{ui}</UndoToastProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </NextIntlClientProvider>,
    ),
  };
}

describe('AppPage (/app — Task 19)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockSearchParamsString = '';
    mockVaultState = 'unlocked';
    mockReplace.mockClear();
  });

  it('flag off: shows empty state with no broken buttons and makes no /items or /tags API calls', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTENT_ENABLED', 'false');
    const itemsSpy = vi.spyOn(contentApi, 'itemsList');
    const tagsSpy = vi.spyOn(contentApi, 'tagsList');

    renderHomePage();

    expect(screen.getByTestId('home-flag-off-empty')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Chưa có gì ở đây' })).toBeInTheDocument();
    expect(screen.queryByTestId('recent-items-grid')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rail-tags')).not.toBeInTheDocument();
    expect(itemsSpy).not.toHaveBeenCalled();
    expect(tagsSpy).not.toHaveBeenCalled();
  });

  it('flag on + empty vault: renders SPEC §7.7 empty state with 3 quick-add examples as text', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTENT_ENABLED', 'true');
    vi.spyOn(contentApi, 'tagsList').mockResolvedValue({ items: [], next_cursor: null });
    vi.spyOn(contentApi, 'itemsList').mockResolvedValue({ items: [], next_cursor: null });

    renderHomePage();

    const emptyState = await screen.findByTestId('home-empty-state');
    expect(emptyState).toBeInTheDocument();
    const examples = screen.getByTestId('home-empty-examples').querySelectorAll('li');
    expect(examples).toHaveLength(3);
    expect(examples[0]?.textContent).toBe(viMessages.content.home.empty.example1);
    expect(examples[1]?.textContent).toBe(viMessages.content.home.empty.example2);
    expect(examples[2]?.textContent).toBe(viMessages.content.home.empty.example3);
  });

  it('filters recent items by tag ID in URL (?tag=<id>) and clears the filter', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTENT_ENABLED', 'true');
    vi.spyOn(contentApi, 'tagsList').mockResolvedValue({
      items: [TAG_NHA, TAG_OPS],
      next_cursor: null,
    });
    const itemsSpy = vi.spyOn(contentApi, 'itemsList').mockImplementation(async (params) => {
      if (params?.tag_id === TAG_NHA.id) {
        return { items: [ITEM_WIFI], next_cursor: null };
      }
      return { items: [ITEM_WIFI, ITEM_DOCKER], next_cursor: null };
    });

    const queryClient = createTestQueryClient();
    const { rerender } = renderHomePage(<AppPage />, { queryClient });

    expect(await screen.findAllByTestId('item-card')).toHaveLength(2);
    expect(itemsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'recent', tag_id: undefined }),
    );

    const tagBtn = screen.getByTestId(`rail-tag-filter-${TAG_NHA.id}`);
    fireEvent.click(tagBtn);

    expect(mockReplace).toHaveBeenCalledWith(`/app?tag=${TAG_NHA.id}`, { scroll: false });
    expect(mockReplace).not.toHaveBeenCalledWith(expect.stringContaining(TAG_NHA.display), expect.anything());

    rerender(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <ThemeProvider initialLocale="vi" initialTheme="light">
          <QueryClientProvider client={queryClient}>
            <UndoToastProvider>
              <AppPage />
            </UndoToastProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </NextIntlClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('item-card')).toHaveLength(1);
    });
    expect(screen.getByRole('heading', { name: 'wifi' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'docker' })).not.toBeInTheDocument();

    const clearBtn = screen.getByTestId('rail-clear-filter');
    fireEvent.click(clearBtn);
    expect(mockReplace).toHaveBeenLastCalledWith('/app', { scroll: false });
  });

  it('deleting a tag keeps items listed and Undo toast triggers tagRestore', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTENT_ENABLED', 'true');
    let tagDeleted = false;
    vi.spyOn(contentApi, 'tagsList').mockImplementation(async () => ({
      items: tagDeleted ? [TAG_OPS] : [TAG_NHA, TAG_OPS],
      next_cursor: null,
    }));
    vi.spyOn(contentApi, 'itemsList').mockImplementation(async () => ({
      items: [
        tagDeleted
          ? { ...ITEM_WIFI, tags: [{ id: TAG_OPS.id, display: TAG_OPS.display }] }
          : ITEM_WIFI,
        ITEM_DOCKER,
      ],
      next_cursor: null,
    }));
    const deleteSpy = vi.spyOn(contentApi, 'tagDelete').mockImplementation(async () => {
      tagDeleted = true;
    });
    const restoreSpy = vi.spyOn(contentApi, 'tagRestore').mockImplementation(async () => {
      tagDeleted = false;
      return TAG_NHA;
    });

    renderHomePage();

    expect(await screen.findAllByTestId('item-card')).toHaveLength(2);

    fireEvent.click(screen.getByTestId(`rail-tag-menu-trigger-${TAG_NHA.id}`));
    fireEvent.click(screen.getByTestId(`rail-tag-delete-action-${TAG_NHA.id}`));

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith(
        TAG_NHA.id,
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      );
    });

    // Both items remain listed even after the tag is soft-deleted.
    expect(await screen.findAllByTestId('item-card')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'wifi' })).toBeInTheDocument();

    const toast = await screen.findByTestId('undo-toast-item');
    const undoBtn = within(toast).getByRole('button', { name: /Hoàn tác/ });
    fireEvent.click(undoBtn);
    await waitFor(() => {
      expect(restoreSpy).toHaveBeenCalledWith(
        TAG_NHA.id,
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      );
    });
  });

  it('renaming a tag to an existing normalized name shows tag_conflict error', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTENT_ENABLED', 'true');
    vi.spyOn(contentApi, 'tagsList').mockResolvedValue({
      items: [TAG_NHA, TAG_OPS],
      next_cursor: null,
    });
    vi.spyOn(contentApi, 'itemsList').mockResolvedValue({
      items: [ITEM_WIFI],
      next_cursor: null,
    });
    vi.spyOn(contentApi, 'tagRename').mockRejectedValue(
      new ProblemError({
        type: 'https://engram.zone17.click/problems/tag_conflict',
        title: 'Tag conflict',
        status: 409,
        code: 'tag_conflict',
      }),
    );

    renderHomePage();

    expect(await screen.findByTestId(`rail-tag-menu-trigger-${TAG_NHA.id}`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`rail-tag-menu-trigger-${TAG_NHA.id}`));
    fireEvent.click(screen.getByTestId(`rail-tag-rename-action-${TAG_NHA.id}`));

    const input = screen.getByTestId(`rail-tag-rename-input-${TAG_NHA.id}`);
    fireEvent.change(input, { target: { value: 'ops' } });
    fireEvent.click(screen.getByTestId(`rail-tag-rename-save-${TAG_NHA.id}`));

    const alert = await screen.findByTestId(`rail-tag-rename-error-${TAG_NHA.id}`);
    expect(alert).toHaveTextContent(viMessages.content.errors.tag_conflict);
  });

  it('locked vault still shows item names, tags, and LockedBanner with no body mask on cards', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTENT_ENABLED', 'true');
    mockVaultState = 'locked';
    vi.spyOn(contentApi, 'tagsList').mockResolvedValue({
      items: [TAG_NHA, TAG_OPS],
      next_cursor: null,
    });
    vi.spyOn(contentApi, 'itemsList').mockResolvedValue({
      items: [ITEM_WIFI, ITEM_DOCKER],
      next_cursor: null,
    });

    renderHomePage();

    expect(await screen.findByTestId('vault-locked-banner')).toBeInTheDocument();
    const cards = await screen.findAllByTestId('item-card');
    expect(cards).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'wifi' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'docker' })).toBeInTheDocument();
    expect(screen.queryByTestId('entry-body')).not.toBeInTheDocument();
    expect(screen.queryByTestId('entry-body-locked')).not.toBeInTheDocument();
  });

  it('loads more items by cursor when next_cursor is returned', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTENT_ENABLED', 'true');
    vi.spyOn(contentApi, 'tagsList').mockResolvedValue({ items: [TAG_NHA], next_cursor: null });
    const itemsSpy = vi.spyOn(contentApi, 'itemsList').mockImplementation(async (params) => {
      if (params?.cursor === 'cursor-page-2') {
        return { items: [ITEM_DOCKER], next_cursor: null };
      }
      return { items: [ITEM_WIFI], next_cursor: 'cursor-page-2' };
    });

    renderHomePage();

    expect(await screen.findAllByTestId('item-card')).toHaveLength(1);
    const loadMoreBtn = screen.getByTestId('recent-items-load-more');
    fireEvent.click(loadMoreBtn);

    await waitFor(() => {
      expect(screen.getAllByTestId('item-card')).toHaveLength(2);
    });
    expect(itemsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'recent', cursor: 'cursor-page-2' }),
    );
  });

  it('shows filtered empty state with clear-filter control when ?tag= fails with 404 or 400', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTENT_ENABLED', 'true');
    mockSearchParamsString = 'tag=stale-tag-id';
    vi.spyOn(contentApi, 'tagsList').mockResolvedValue({ items: [TAG_NHA], next_cursor: null });
    vi.spyOn(contentApi, 'itemsList').mockRejectedValue(
      new ProblemError({
        type: 'https://engram.zone17.click/problems/not_found',
        title: 'Not found',
        status: 404,
        code: 'not_found',
      }),
    );

    renderHomePage();

    expect(await screen.findByTestId('home-filtered-empty-state')).toBeInTheDocument();
    expect(screen.queryByTestId('recent-items-error')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('home-filtered-clear-btn'));
    expect(mockReplace).toHaveBeenCalledWith('/app', { scroll: false });
  });

  it('shows filtered empty state with clear-filter control when ?tag= fails with 400 invalid_request', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTENT_ENABLED', 'true');
    mockSearchParamsString = 'tag=malformed-tag-id';
    vi.spyOn(contentApi, 'tagsList').mockResolvedValue({ items: [TAG_NHA], next_cursor: null });
    vi.spyOn(contentApi, 'itemsList').mockRejectedValue(
      new ProblemError({
        type: 'https://engram.zone17.click/problems/invalid_request',
        title: 'Invalid request',
        status: 400,
        code: 'invalid_request',
      }),
    );

    renderHomePage();

    expect(await screen.findByTestId('home-filtered-empty-state')).toBeInTheDocument();
    expect(screen.queryByTestId('recent-items-error')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('home-filtered-clear-btn'));
    expect(mockReplace).toHaveBeenCalledWith('/app', { scroll: false });
  });

  it('keeps loaded items on screen and shows inline retry calling fetchNextPage when load-more fails', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTENT_ENABLED', 'true');
    vi.spyOn(contentApi, 'tagsList').mockResolvedValue({ items: [TAG_NHA], next_cursor: null });
    let failPage2 = true;
    const itemsSpy = vi.spyOn(contentApi, 'itemsList').mockImplementation(async (params) => {
      if (params?.cursor === 'cursor-page-2') {
        if (failPage2) {
          throw new ProblemError({
            type: 'https://engram.zone17.click/problems/internal_error',
            title: 'Internal error',
            status: 500,
            code: 'internal_error',
          });
        }
        return { items: [ITEM_DOCKER], next_cursor: null };
      }
      return { items: [ITEM_WIFI], next_cursor: 'cursor-page-2' };
    });

    renderHomePage();

    expect(await screen.findAllByTestId('item-card')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('recent-items-load-more'));

    const loadMoreError = await screen.findByTestId('recent-items-load-more-error');
    expect(loadMoreError).toHaveTextContent(viMessages.content.errors.internal_error);
    // First page remains visible; full-page error is NOT shown.
    expect(screen.getAllByTestId('item-card')).toHaveLength(1);
    expect(screen.queryByTestId('recent-items-error')).not.toBeInTheDocument();

    failPage2 = false;
    fireEvent.click(screen.getByTestId('recent-items-load-more-retry'));

    await waitFor(() => {
      expect(screen.getAllByTestId('item-card')).toHaveLength(2);
    });
    expect(itemsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'recent', cursor: 'cursor-page-2' }),
    );
  });
});
