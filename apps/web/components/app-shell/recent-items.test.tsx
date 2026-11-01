import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RecentItems } from '@/components/app-shell/recent-items';
import type { ItemSummary } from '@/lib/api/content';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';

function renderWithIntl(ui: ReactNode, locale: 'en' | 'vi' = 'vi') {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? enMessages : viMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const BASE_ITEM: ItemSummary = {
  id: 'aaaa1111-1111-4111-8111-111111111111',
  name: 'wifi',
  hint: 'Nhà + văn phòng',
  tags: [
    { id: 't1', display: 'nhà' },
    { id: 't2', display: 'office' },
    { id: 't3', display: 'home-lab' },
    { id: 't4', display: 'ops' },
    { id: 't5', display: 'backup' },
  ],
  entry_count: 12,
  version: 1,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  last_used_at: '2026-11-01T00:00:00Z',
};

describe('RecentItems', () => {
  it('renders item name, hint, entry count, link to /app/items/<id>, and no body or lock mask', () => {
    renderWithIntl(<RecentItems items={[BASE_ITEM]} />, 'vi');

    const card = screen.getByTestId('item-card');
    expect(card).toHaveAttribute('href', `/app/items/${BASE_ITEM.id}`);
    expect(screen.getByRole('heading', { name: 'wifi' })).toBeInTheDocument();
    expect(screen.getByText('Nhà + văn phòng')).toBeInTheDocument();
    expect(screen.getByTestId('item-entry-count')).toHaveTextContent('12 entry');
    expect(screen.queryByTestId('entry-body')).not.toBeInTheDocument();
    expect(screen.queryByTestId('entry-body-locked')).not.toBeInTheDocument();
  });

  it('caps visible tag chips at 3 and renders +N with accessible overflow text', () => {
    renderWithIntl(<RecentItems items={[BASE_ITEM]} />, 'en');

    const chips = screen.getAllByTestId('item-tag-chip');
    expect(chips).toHaveLength(3);
    expect(chips.map((c) => c.textContent)).toEqual(['#nhà', '#office', '#home-lab']);
    expect(screen.queryByText('#ops')).not.toBeInTheDocument();
    expect(screen.getByTestId('item-tag-overflow')).toHaveTextContent('+2');
    expect(screen.getByText('2 more tags')).toBeInTheDocument();
  });

  it('formats ICU plural entry counts in English (1 entry vs N entries)', () => {
    const oneEntry: ItemSummary = { ...BASE_ITEM, id: 'item-1', entry_count: 1, tags: [] };
    const zeroEntries: ItemSummary = { ...BASE_ITEM, id: 'item-0', entry_count: 0, tags: [] };

    renderWithIntl(<RecentItems items={[oneEntry, zeroEntries]} />, 'en');

    const counts = screen.getAllByTestId('item-entry-count').map((el) => el.textContent);
    expect(counts).toEqual(['1 entry', '0 entries']);
  });

  it('renders Load more button when hasNextPage is true and invokes onLoadMore on click', () => {
    const onLoadMore = vi.fn();
    renderWithIntl(
      <RecentItems items={[BASE_ITEM]} hasNextPage onLoadMore={onLoadMore} />,
      'vi',
    );

    const loadMoreBtn = screen.getByTestId('recent-items-load-more');
    expect(loadMoreBtn).toHaveTextContent('Xem thêm');
    fireEvent.click(loadMoreBtn);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
