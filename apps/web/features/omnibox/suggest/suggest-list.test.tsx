import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import enMessages from '@/messages/en.json';
import { SuggestList, type SuggestListModel } from './suggest-list';

function model(overrides: Partial<SuggestListModel>): SuggestListModel {
  return {
    kind: 'search',
    scope: 'all',
    markQuery: '',
    zones: [],
    rowCount: 0,
    hasMore: false,
    showCreate: false,
    displayQuery: 'zzzq',
    nearState: 'pending',
    isEmpty: true,
    navKeys: [],
    ...overrides,
  };
}

function renderList(m: SuggestListModel) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SuggestList
        baseId="t"
        listboxId="t-list"
        model={m}
        activeKey={null}
        busy={false}
        showSkeleton={false}
        rateLimitedSeconds={null}
        enable409={false}
        onActivate={() => {}}
      />
    </NextIntlClientProvider>,
  );
}

describe('SuggestList near-pending line (F-23)', () => {
  afterEach(() => cleanup());

  it('hides "Searching by meaning…" on the no-match view, where there is no row to append to', () => {
    renderList(model({ nearState: 'pending', isEmpty: true }));
    expect(screen.getByTestId('omnibox-search-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('omnibox-status-near-pending')).toBeNull();
  });

  it('still shows it while rows are listed and the near zone is pending', () => {
    renderList(model({ nearState: 'pending', isEmpty: false, rowCount: 1 }));
    expect(screen.getByTestId('omnibox-status-near-pending')).toHaveTextContent(enMessages.search.state.nearPending);
  });
});
