import { ProblemError } from '@engram/shared-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UndoToastProvider } from '@/components/ui/undo-toast';
import { configureContentQueryDefaults, contentQueryKeys } from '@/features/items/query-keys';
import { RailTagChip, usePaginatedTagsList, useTagsList } from '@/features/tags';
import * as contentApi from '@/lib/api/content';
import type { Tag } from '@/lib/api/content';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';

const SAMPLE_TAG: Tag = {
  id: '11111111-1111-4111-8111-111111111111',
  display: 'nhà',
  item_count: 8,
  last_used_at: '2026-11-01T00:00:00Z',
  created_at: '2026-11-01T00:00:00Z',
};

const SECOND_TAG: Tag = {
  id: '22222222-2222-4222-8222-222222222222',
  display: 'ops',
  item_count: 3,
  last_used_at: '2026-11-01T00:00:00Z',
  created_at: '2026-11-01T00:00:00Z',
};

const THIRD_TAG: Tag = {
  id: '33333333-3333-4333-8333-333333333333',
  display: 'cloud',
  item_count: 5,
  last_used_at: '2026-11-01T00:00:00Z',
  created_at: '2026-11-01T00:00:00Z',
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

function renderWithProviders(
  ui: ReactNode,
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
        <QueryClientProvider client={queryClient}>
          <UndoToastProvider>{ui}</UndoToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    ),
  };
}

function TagsListProbe() {
  const { data, isLoading } = useTagsList({ sort: 'recent' });
  if (isLoading) return <p>loading</p>;
  return (
    <ul>
      {(data?.items ?? []).map((t) => (
        <li key={t.id}>
          {t.display}:{t.item_count}
        </li>
      ))}
    </ul>
  );
}

function PaginatedTagsProbe() {
  const { tags, hasMore, loadMore, resetExtraPages } = usePaginatedTagsList({ sort: 'recent' });
  return (
    <div>
      <ul>
        {tags.map((t) => (
          <li key={t.id}>
            <span>{t.display}</span>
            <RailTagChip
              tag={t}
              selected={false}
              onSelect={() => undefined}
              onTagMutated={resetExtraPages}
              onRestoreError={() => undefined}
            />
          </li>
        ))}
      </ul>
      {hasMore ? (
        <button type="button" onClick={() => void loadMore()} data-testid="probe-load-more">
          more
        </button>
      ) : null}
    </div>
  );
}

describe('features/tags', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('useTagsList fetches tags under contentQueryKeys.tags', async () => {
    const spy = vi.spyOn(contentApi, 'tagsList').mockResolvedValue({
      items: [SAMPLE_TAG],
      next_cursor: null,
    });

    const { queryClient } = renderWithProviders(<TagsListProbe />);
    expect(await screen.findByText('nhà:8')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ sort: 'recent' }));
    expect(queryClient.getQueryData(contentQueryKeys.tags({ sort: 'recent' }))).toEqual({
      items: [SAMPLE_TAG],
      next_cursor: null,
    });
  });

  it('usePaginatedTagsList loads extra pages by next_cursor while keeping first-page query key stable', async () => {
    const spy = vi.spyOn(contentApi, 'tagsList').mockImplementation(async (params) => {
      if (params?.cursor === 'cursor-tags-2') {
        return { items: [SECOND_TAG], next_cursor: null };
      }
      return { items: [SAMPLE_TAG], next_cursor: 'cursor-tags-2' };
    });

    const { queryClient } = renderWithProviders(<PaginatedTagsProbe />);
    expect(await screen.findByText('nhà')).toBeInTheDocument();
    expect(screen.queryByText('ops')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('probe-load-more'));
    expect(await screen.findByText('ops')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'recent', cursor: 'cursor-tags-2' }),
    );
    expect(queryClient.getQueryData(contentQueryKeys.tags({ sort: 'recent' }))).toEqual({
      items: [SAMPLE_TAG],
      next_cursor: 'cursor-tags-2',
    });
  });

  it('usePaginatedTagsList keeps extra pages across refocus/refetch with equal first-page data and resets when first page changes', async () => {
    let firstPageItems: Tag[] = [SAMPLE_TAG];
    const spy = vi.spyOn(contentApi, 'tagsList').mockImplementation(async (params) => {
      if (params?.cursor === 'cursor-tags-2') {
        return { items: [SECOND_TAG, THIRD_TAG], next_cursor: null };
      }
      return { items: firstPageItems.map((tag) => ({ ...tag })), next_cursor: 'cursor-tags-2' };
    });

    const { queryClient } = renderWithProviders(<PaginatedTagsProbe />);
    expect(await screen.findByText('nhà')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('probe-load-more'));
    expect(await screen.findByText('ops')).toBeInTheDocument();
    expect(screen.getByText('cloud')).toBeInTheDocument();

    // Refetch/refocus returning structurally equal first-page data keeps extra pages intact.
    await queryClient.refetchQueries({ queryKey: contentQueryKeys.tags({ sort: 'recent' }) });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(screen.getByText('nhà')).toBeInTheDocument();
    expect(screen.getByText('ops')).toBeInTheDocument();
    expect(screen.getByText('cloud')).toBeInTheDocument();

    // Refetch where first page changes resets extra pages instead of merging against stale ones.
    firstPageItems = [SAMPLE_TAG, { ...SECOND_TAG, display: 'ops-renamed' }];
    await queryClient.refetchQueries({ queryKey: contentQueryKeys.tags({ sort: 'recent' }) });
    expect(await screen.findByText('ops-renamed')).toBeInTheDocument();
    expect(screen.queryByText('ops')).not.toBeInTheDocument();
    expect(screen.queryByText('cloud')).not.toBeInTheDocument();
    expect(screen.getByTestId('probe-load-more')).toBeInTheDocument();
  });

  it('usePaginatedTagsList resets extra pages when a tag on an extra page is deleted, restored via Undo, or renamed (HM19-R3-1, HM19-R4-2)', async () => {
    let extraPageItems: Tag[] = [SECOND_TAG, THIRD_TAG];
    vi.spyOn(contentApi, 'tagsList').mockImplementation(async (params) => {
      if (params?.cursor === 'cursor-tags-2') {
        return { items: extraPageItems.map((tag) => ({ ...tag })), next_cursor: null };
      }
      return { items: [{ ...SAMPLE_TAG }], next_cursor: 'cursor-tags-2' };
    });
    const deleteSpy = vi.spyOn(contentApi, 'tagDelete').mockImplementation(async (id) => {
      extraPageItems = extraPageItems.filter((tag) => tag.id !== id);
    });
    const restoreSpy = vi.spyOn(contentApi, 'tagRestore').mockImplementation(async (id) => {
      if (id === SECOND_TAG.id && !extraPageItems.some((tag) => tag.id === SECOND_TAG.id)) {
        extraPageItems = [SECOND_TAG, ...extraPageItems];
      }
      return SECOND_TAG;
    });
    const renameSpy = vi.spyOn(contentApi, 'tagRename').mockImplementation(async (id, body) => {
      extraPageItems = extraPageItems.map((tag) =>
        tag.id === id ? { ...tag, display: body.display } : tag,
      );
      return { ...THIRD_TAG, display: body.display };
    });

    renderWithProviders(<PaginatedTagsProbe />);
    expect(await screen.findByText('nhà')).toBeInTheDocument();

    // (a) Load extra page, delete a tag on it -> chip is gone even though page 1 is unchanged.
    fireEvent.click(screen.getByTestId('probe-load-more'));
    expect(await screen.findByTestId(`rail-tag-filter-${SECOND_TAG.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`rail-tag-filter-${THIRD_TAG.id}`)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`rail-tag-menu-trigger-${SECOND_TAG.id}`));
    fireEvent.click(screen.getByTestId(`rail-tag-delete-action-${SECOND_TAG.id}`));

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith(
        SECOND_TAG.id,
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId(`rail-tag-filter-${SECOND_TAG.id}`)).not.toBeInTheDocument();
    });

    // (b) Load extra page (now only THIRD_TAG), then click Undo on the delete toast ->
    //     Undo-restore also calls onTagMutated={resetExtraPages}, dropping the stale extra page
    //     so reloading the extra page shows the restored SECOND_TAG (HM19-R4-2).
    fireEvent.click(screen.getByTestId('probe-load-more'));
    expect(await screen.findByTestId(`rail-tag-filter-${THIRD_TAG.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`rail-tag-filter-${SECOND_TAG.id}`)).not.toBeInTheDocument();

    const toast = await screen.findByTestId('undo-toast-item');
    fireEvent.click(within(toast).getByRole('button', { name: /Hoàn tác/ }));

    await waitFor(() => {
      expect(restoreSpy).toHaveBeenCalledWith(
        SECOND_TAG.id,
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      );
    });
    // Extra page was reset by Undo-restore (`onTagMutated`), so THIRD_TAG is collapsed until Load more is clicked.
    await waitFor(() => {
      expect(screen.queryByTestId(`rail-tag-filter-${THIRD_TAG.id}`)).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('probe-load-more')).toBeInTheDocument();

    // Reload extra page -> both restored SECOND_TAG and THIRD_TAG appear.
    fireEvent.click(screen.getByTestId('probe-load-more'));
    expect(await screen.findByTestId(`rail-tag-filter-${SECOND_TAG.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`rail-tag-filter-${THIRD_TAG.id}`)).toBeInTheDocument();

    // (c) Rename a tag on the extra page -> extra page resets and reloading shows the renamed display.
    fireEvent.click(screen.getByTestId(`rail-tag-menu-trigger-${THIRD_TAG.id}`));
    fireEvent.click(screen.getByTestId(`rail-tag-rename-action-${THIRD_TAG.id}`));
    fireEvent.change(screen.getByTestId(`rail-tag-rename-input-${THIRD_TAG.id}`), {
      target: { value: 'cloud-v2' },
    });
    fireEvent.click(screen.getByTestId(`rail-tag-rename-save-${THIRD_TAG.id}`));

    await waitFor(() => {
      expect(renameSpy).toHaveBeenCalledWith(
        THIRD_TAG.id,
        { display: 'cloud-v2' },
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText('cloud')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('probe-load-more'));
    expect(await screen.findByText('cloud-v2')).toBeInTheDocument();
    expect(screen.queryByText('cloud')).not.toBeInTheDocument();
  });

  it('RailTagChip renames a tag via PATCH /tags/{id}, invalidates queries, and focuses the chip filter button', async () => {
    const renameSpy = vi.spyOn(contentApi, 'tagRename').mockResolvedValue({
      ...SAMPLE_TAG,
      display: 'gia-đình',
    });

    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderWithProviders(
      <RailTagChip
        tag={SAMPLE_TAG}
        selected={false}
        onSelect={() => undefined}
        onRestoreError={() => undefined}
      />,
      { queryClient },
    );

    const menuTrigger = screen.getByTestId(`rail-tag-menu-trigger-${SAMPLE_TAG.id}`);
    fireEvent.click(menuTrigger);

    const renameAction = screen.getByTestId(`rail-tag-rename-action-${SAMPLE_TAG.id}`);
    fireEvent.click(renameAction);

    const input = screen.getByTestId(`rail-tag-rename-input-${SAMPLE_TAG.id}`);
    expect(input).not.toHaveAttribute('maxlength');
    fireEvent.change(input, { target: { value: 'gia-đình' } });
    fireEvent.click(screen.getByTestId(`rail-tag-rename-save-${SAMPLE_TAG.id}`));

    await waitFor(() => {
      expect(renameSpy).toHaveBeenCalledWith(
        SAMPLE_TAG.id,
        { display: 'gia-đình' },
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      );
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['content', 'tags'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['content', 'items'] });
    expect(document.activeElement).toBe(screen.getByTestId(`rail-tag-filter-${SAMPLE_TAG.id}`));
  });

  it('RailTagChip validates tag display by Unicode code points (50 runes allowed, 51 runes rejected)', async () => {
    const fiftyEmojiRunes = '🏠'.repeat(50);
    const fiftyOneEmojiRunes = '🏠'.repeat(51);
    const renameSpy = vi.spyOn(contentApi, 'tagRename').mockResolvedValue({
      ...SAMPLE_TAG,
      display: fiftyEmojiRunes,
    });

    renderWithProviders(
      <RailTagChip
        tag={SAMPLE_TAG}
        selected={false}
        onSelect={() => undefined}
        onRestoreError={() => undefined}
      />,
      { locale: 'vi' },
    );

    fireEvent.click(screen.getByTestId(`rail-tag-menu-trigger-${SAMPLE_TAG.id}`));
    fireEvent.click(screen.getByTestId(`rail-tag-rename-action-${SAMPLE_TAG.id}`));

    const input = screen.getByTestId(`rail-tag-rename-input-${SAMPLE_TAG.id}`);
    fireEvent.change(input, { target: { value: fiftyOneEmojiRunes } });
    fireEvent.click(screen.getByTestId(`rail-tag-rename-save-${SAMPLE_TAG.id}`));

    expect(screen.getByTestId(`rail-tag-rename-error-${SAMPLE_TAG.id}`)).toHaveTextContent(
      viMessages.content.errors.tag_display_invalid,
    );
    expect(renameSpy).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: fiftyEmojiRunes } });
    fireEvent.click(screen.getByTestId(`rail-tag-rename-save-${SAMPLE_TAG.id}`));

    await waitFor(() => {
      expect(renameSpy).toHaveBeenCalledWith(
        SAMPLE_TAG.id,
        { display: fiftyEmojiRunes },
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      );
    });
  });

  it('RailTagChip surfaces tag_conflict error via getContentErrorI18nKey when renaming to an existing tag', async () => {
    vi.spyOn(contentApi, 'tagRename').mockRejectedValue(
      new ProblemError({
        type: 'https://engram.zone17.click/problems/tag_conflict',
        title: 'Tag conflict',
        status: 409,
        code: 'tag_conflict',
      }),
    );

    renderWithProviders(
      <RailTagChip
        tag={SAMPLE_TAG}
        selected={false}
        onSelect={() => undefined}
        onRestoreError={() => undefined}
      />,
      { locale: 'vi' },
    );

    fireEvent.click(screen.getByTestId(`rail-tag-menu-trigger-${SAMPLE_TAG.id}`));
    fireEvent.click(screen.getByTestId(`rail-tag-rename-action-${SAMPLE_TAG.id}`));

    const input = screen.getByTestId(`rail-tag-rename-input-${SAMPLE_TAG.id}`);
    fireEvent.change(input, { target: { value: 'ops' } });
    fireEvent.click(screen.getByTestId(`rail-tag-rename-save-${SAMPLE_TAG.id}`));

    const alert = await screen.findByTestId(`rail-tag-rename-error-${SAMPLE_TAG.id}`);
    expect(alert).toHaveTextContent(viMessages.content.errors.tag_conflict);
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('RailTagChip deletes a tag, moves focus to a stable target, and pushes an Undo toast that restores focus on Undo', async () => {
    const deleteSpy = vi.spyOn(contentApi, 'tagDelete').mockResolvedValue();
    const restoreSpy = vi.spyOn(contentApi, 'tagRestore').mockResolvedValue(SAMPLE_TAG);
    const onTagDeleted = vi.fn();

    renderWithProviders(
      <nav data-testid="rail-tags" tabIndex={-1}>
        <RailTagChip
          tag={SAMPLE_TAG}
          selected
          onSelect={() => undefined}
          onTagDeleted={onTagDeleted}
          onRestoreError={() => undefined}
        />
        <RailTagChip
          tag={SECOND_TAG}
          selected={false}
          onSelect={() => undefined}
          onRestoreError={() => undefined}
        />
      </nav>,
      { locale: 'vi' },
    );

    fireEvent.click(screen.getByTestId(`rail-tag-menu-trigger-${SAMPLE_TAG.id}`));
    fireEvent.click(screen.getByTestId(`rail-tag-delete-action-${SAMPLE_TAG.id}`));

    // Focus moves immediately to the sibling tag's filter button when Delete closes the menu.
    expect(document.activeElement).toBe(screen.getByTestId(`rail-tag-filter-${SECOND_TAG.id}`));

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith(
        SAMPLE_TAG.id,
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      );
    });
    expect(onTagDeleted).toHaveBeenCalledWith(SAMPLE_TAG.id);

    const deleteKey = deleteSpy.mock.calls[0]?.[1]?.idempotencyKey;
    const toast = await screen.findByTestId('undo-toast-item');
    expect(within(toast).getByText(/Đã xoá tag #nhà/)).toBeInTheDocument();
    expect(within(toast).getByTestId('undo-toast-detail')).toHaveTextContent(
      /Các mục gắn tag này vẫn giữ nguyên/,
    );

    const undoButton = within(toast).getByRole('button', { name: /Hoàn tác/ });
    undoButton.focus();
    fireEvent.click(undoButton);

    await waitFor(() => {
      expect(restoreSpy).toHaveBeenCalledWith(
        SAMPLE_TAG.id,
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      );
    });
    const restoreKey = restoreSpy.mock.calls[0]?.[1]?.idempotencyKey;
    expect(restoreKey).not.toBe(deleteKey);
    expect(document.activeElement).toBe(screen.getByTestId(`rail-tag-filter-${SAMPLE_TAG.id}`));
  });

  it('surfaces mapped content.errors message in role="alert" when Undo tagRestore rejects with tag_conflict', async () => {
    vi.spyOn(contentApi, 'tagDelete').mockResolvedValue();
    vi.spyOn(contentApi, 'tagRestore').mockRejectedValue(
      new ProblemError({
        type: 'https://engram.zone17.click/problems/tag_conflict',
        title: 'Tag conflict',
        status: 409,
        code: 'tag_conflict',
      }),
    );
    const onRestoreError = vi.fn();

    renderWithProviders(
      <RailTagChip
        tag={SAMPLE_TAG}
        selected={false}
        onSelect={() => undefined}
        onRestoreError={onRestoreError}
      />,
      { locale: 'vi' },
    );

    fireEvent.click(screen.getByTestId(`rail-tag-menu-trigger-${SAMPLE_TAG.id}`));
    fireEvent.click(screen.getByTestId(`rail-tag-delete-action-${SAMPLE_TAG.id}`));

    const toast = await screen.findByTestId('undo-toast-item');
    fireEvent.click(within(toast).getByRole('button', { name: /Hoàn tác/ }));

    await waitFor(() => {
      expect(onRestoreError).toHaveBeenCalledWith('tag_conflict');
    });
  });

  it('supports keyboard navigation in the tag action menu, Escape, Tab, and focus leaving to close', async () => {
    renderWithProviders(
      <div>
        <RailTagChip
          tag={SAMPLE_TAG}
          selected={false}
          onSelect={() => undefined}
          onRestoreError={() => undefined}
        />
        <button type="button" data-testid="outside-focusable">
          outside
        </button>
      </div>,
    );

    const trigger = screen.getByTestId(`rail-tag-menu-trigger-${SAMPLE_TAG.id}`);
    fireEvent.click(trigger);

    const menu = screen.getByTestId(`rail-tag-menu-${SAMPLE_TAG.id}`);
    const renameItem = screen.getByTestId(`rail-tag-rename-action-${SAMPLE_TAG.id}`);
    const deleteItem = screen.getByTestId(`rail-tag-delete-action-${SAMPLE_TAG.id}`);

    expect(renameItem).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(deleteItem).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(renameItem).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByTestId(`rail-tag-menu-${SAMPLE_TAG.id}`)).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    // Tab closes the menu without trapping focus.
    fireEvent.click(trigger);
    expect(screen.getByTestId(`rail-tag-menu-${SAMPLE_TAG.id}`)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId(`rail-tag-menu-${SAMPLE_TAG.id}`), { key: 'Tab' });
    expect(screen.queryByTestId(`rail-tag-menu-${SAMPLE_TAG.id}`)).not.toBeInTheDocument();

    // Blur with relatedTarget: null (e.g. Safari/macOS Firefox button press) keeps the menu open.
    fireEvent.click(trigger);
    const reopenedMenu = screen.getByTestId(`rail-tag-menu-${SAMPLE_TAG.id}`);
    const reopenedRenameItem = screen.getByTestId(`rail-tag-rename-action-${SAMPLE_TAG.id}`);
    fireEvent.blur(reopenedRenameItem, { relatedTarget: null });
    expect(screen.getByTestId(`rail-tag-menu-${SAMPLE_TAG.id}`)).toBeInTheDocument();

    // Focus leaving the chip group (relatedTarget outside) closes the menu.
    fireEvent.blur(reopenedMenu, { relatedTarget: screen.getByTestId('outside-focusable') });
    expect(screen.queryByTestId(`rail-tag-menu-${SAMPLE_TAG.id}`)).not.toBeInTheDocument();
  });
});
