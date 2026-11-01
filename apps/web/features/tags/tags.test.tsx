import { ProblemError } from '@engram/shared-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UndoToastProvider } from '@/components/ui/undo-toast';
import { configureContentQueryDefaults, contentQueryKeys } from '@/features/items/query-keys';
import { RailTagChip, useTagsList } from '@/features/tags';
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

  it('RailTagChip renames a tag via PATCH /tags/{id} and invalidates tag + item queries', async () => {
    const renameSpy = vi.spyOn(contentApi, 'tagRename').mockResolvedValue({
      ...SAMPLE_TAG,
      display: 'gia-đình',
    });

    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderWithProviders(
      <RailTagChip tag={SAMPLE_TAG} selected={false} onSelect={() => undefined} />,
      { queryClient },
    );

    const menuTrigger = screen.getByTestId(`rail-tag-menu-trigger-${SAMPLE_TAG.id}`);
    fireEvent.click(menuTrigger);

    const renameAction = screen.getByTestId(`rail-tag-rename-action-${SAMPLE_TAG.id}`);
    fireEvent.click(renameAction);

    const input = screen.getByTestId(`rail-tag-rename-input-${SAMPLE_TAG.id}`);
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
      <RailTagChip tag={SAMPLE_TAG} selected={false} onSelect={() => undefined} />,
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

  it('RailTagChip deletes a tag and pushes an Undo toast that calls tagRestore with a fresh Idempotency-Key', async () => {
    const deleteSpy = vi.spyOn(contentApi, 'tagDelete').mockResolvedValue();
    const restoreSpy = vi.spyOn(contentApi, 'tagRestore').mockResolvedValue(SAMPLE_TAG);
    const onTagDeleted = vi.fn();

    renderWithProviders(
      <RailTagChip
        tag={SAMPLE_TAG}
        selected
        onSelect={() => undefined}
        onTagDeleted={onTagDeleted}
      />,
      { locale: 'vi' },
    );

    fireEvent.click(screen.getByTestId(`rail-tag-menu-trigger-${SAMPLE_TAG.id}`));
    fireEvent.click(screen.getByTestId(`rail-tag-delete-action-${SAMPLE_TAG.id}`));

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith(
        SAMPLE_TAG.id,
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      );
    });
    expect(onTagDeleted).toHaveBeenCalledWith(SAMPLE_TAG.id);

    const deleteKey = deleteSpy.mock.calls[0]?.[1]?.idempotencyKey;
    expect(await screen.findByText(/Đã xoá tag #nhà/)).toBeInTheDocument();
    expect(screen.getByText(/Các mục gắn tag này vẫn giữ nguyên/)).toBeInTheDocument();

    const undoButton = screen.getByRole('button', { name: /Hoàn tác/ });
    fireEvent.click(undoButton);

    await waitFor(() => {
      expect(restoreSpy).toHaveBeenCalledWith(
        SAMPLE_TAG.id,
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      );
    });
    const restoreKey = restoreSpy.mock.calls[0]?.[1]?.idempotencyKey;
    expect(restoreKey).not.toBe(deleteKey);
  });

  it('supports keyboard navigation in the tag action menu and Escape to close', async () => {
    renderWithProviders(
      <RailTagChip tag={SAMPLE_TAG} selected={false} onSelect={() => undefined} />,
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
  });
});
