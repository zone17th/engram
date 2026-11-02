'use client';

import { ProblemError } from '@engram/shared-types';
import { Suspense, useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { AppHeader } from '@/components/app-shell/app-header';
import { EmptyState } from '@/components/app-shell/empty-state';
import { Omnibox } from '@/components/app-shell/omnibox';
import { Rail } from '@/components/app-shell/rail';
import { RecentItems } from '@/components/app-shell/recent-items';
import { useSession } from '@/features/auth/session-provider';
import { LockedBanner } from '@/features/items/locked-banner';
import { CONTENT_QUERY_OPTIONS, contentQueryKeys, type ContentItemsQueryKey } from '@/features/items/query-keys';
import { useTagsList } from '@/features/tags';
import {
  getContentErrorI18nKey,
  itemsList,
  type ContentErrorCode,
  type ItemList as ItemListPage,
} from '@/lib/api/content';
import { contentEnabled } from '@/lib/flags';

function HomeEmptyVaultState() {
  const tEmpty = useTranslations('content.home.empty');
  return (
    <div
      data-testid="home-empty-state"
      className="panel flex min-w-0 flex-col items-center p-8 text-center"
    >
      <p className="t-label mb-3 text-muted">{tEmpty('eyebrow')}</p>
      <h2 className="t-title-md mb-2 text-ink">{tEmpty('title')}</h2>
      <p className="t-body mx-auto mb-5 max-w-[480px] text-muted">{tEmpty('body')}</p>
      <div className="flex max-w-full flex-col items-center gap-2">
        <p className="t-caption m-0 text-muted">{tEmpty('examplesLabel')}</p>
        <ul
          data-testid="home-empty-examples"
          className="m-0 flex max-w-full list-none flex-wrap justify-center gap-2 p-0"
        >
          <li className="mono max-w-full break-words rounded-md border border-line bg-surface px-2.5 py-1 text-[12px] text-body [overflow-wrap:anywhere]">
            {tEmpty('example1')}
          </li>
          <li className="mono max-w-full break-words rounded-md border border-line bg-surface px-2.5 py-1 text-[12px] text-body [overflow-wrap:anywhere]">
            {tEmpty('example2')}
          </li>
          <li className="mono max-w-full break-words rounded-md border border-line bg-surface px-2.5 py-1 text-[12px] text-body [overflow-wrap:anywhere]">
            {tEmpty('example3')}
          </li>
        </ul>
      </div>
    </div>
  );
}

function HomeFilteredEmptyState({
  tagDisplay,
  onClearFilter,
}: {
  readonly tagDisplay?: string;
  readonly onClearFilter: () => void;
}) {
  const tFiltered = useTranslations('content.home.filteredEmpty');
  return (
    <div
      data-testid="home-filtered-empty-state"
      className="card flex min-w-0 flex-col items-center p-6 text-center"
    >
      <p className="t-label mb-2 text-muted">{tFiltered('eyebrow')}</p>
      <h2 className="t-title-sm mb-2 break-words text-ink [overflow-wrap:anywhere]">
        {tagDisplay ? tFiltered('title', { display: tagDisplay }) : tFiltered('titleFallback')}
      </h2>
      <p className="t-body mb-4 text-muted">{tFiltered('body')}</p>
      <button
        type="button"
        onClick={onClearFilter}
        data-testid="home-filtered-clear-btn"
        className="btn btn-tertiary btn-sm"
      >
        {tFiltered('clearFilter')}
      </button>
    </div>
  );
}

function HomeContent({ isContentEnabled }: { readonly isContentEnabled: boolean }) {
  const tHero = useTranslations('content.home.hero');
  const tRecent = useTranslations('content.home.recent');
  const tFlagOff = useTranslations('content.home.flagOff');
  const tErrors = useTranslations('content.errors');

  const router = useRouter();
  const pathname = usePathname() ?? '/app';
  const searchParams = useSearchParams();

  const rawTagParam = searchParams?.get('tag') ?? null;
  const selectedTagId = rawTagParam && rawTagParam.trim().length > 0 ? rawTagParam.trim() : null;

  const handleSelectTag = useCallback(
    (nextTagId: string | null) => {
      const params = new URLSearchParams(searchParams?.toString() ?? '');
      if (nextTagId) {
        params.set('tag', nextTagId);
      } else {
        params.delete('tag');
      }
      const query = params.toString();
      const targetUrl = query ? `${pathname}?${query}` : pathname;
      router.replace(targetUrl, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const tagsQuery = useTagsList({
    sort: 'recent',
    enabled: isContentEnabled,
  });

  const activeTag = useMemo(
    () => (tagsQuery.data?.items ?? []).find((t) => t.id === selectedTagId),
    [tagsQuery.data?.items, selectedTagId],
  );

  const itemsQuery = useInfiniteQuery<
    ItemListPage,
    unknown,
    { pages: ItemListPage[]; pageParams: (string | undefined)[] },
    ContentItemsQueryKey,
    string | undefined
  >({
    queryKey: contentQueryKeys.items({
      sort: 'recent',
      tagId: selectedTagId ?? undefined,
    }),
    initialPageParam: undefined,
    queryFn: ({ pageParam, signal }) =>
      itemsList({
        sort: 'recent',
        tag_id: selectedTagId ?? undefined,
        cursor: pageParam,
        signal,
      }),
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled: isContentEnabled,
    ...CONTENT_QUERY_OPTIONS,
  });

  const allItems = useMemo(() => {
    const pages = itemsQuery.data?.pages ?? [];
    const seen = new Set<string>();
    const list = [];
    for (const page of pages) {
      for (const item of page.items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          list.push(item);
        }
      }
    }
    return list;
  }, [itemsQuery.data?.pages]);

  if (!isContentEnabled) {
    return (
      <main className="mx-auto max-w-container px-5 py-8">
        <div data-testid="home-flag-off-empty">
          <EmptyState title={tFlagOff('title')} body={tFlagOff('body')} />
        </div>
      </main>
    );
  }

  const errorCode = itemsQuery.isError
    ? (getContentErrorI18nKey(itemsQuery.error).replace(/^content\.errors\./, '') as ContentErrorCode)
    : null;
  const errorStatus =
    itemsQuery.error instanceof ProblemError ? itemsQuery.error.problem.status : undefined;
  const isStaleOrMissingTagFilterError =
    Boolean(selectedTagId) &&
    itemsQuery.isError &&
    !itemsQuery.data &&
    (errorCode === 'not_found' ||
      errorCode === 'invalid_request' ||
      errorStatus === 404 ||
      errorStatus === 400);
  // Show full-page error only when no items are cached; failed background refetches keep the
  // stale-while-error grid visible, and load-more failures surface an inline retry in RecentItems.
  const showFullPageError = itemsQuery.isError && !itemsQuery.data && errorCode !== null;

  return (
    <main className="mx-auto grid max-w-container gap-8 px-5 py-8 lg:grid-cols-[236px_minmax(0,1fr)]">
      <Rail
        selectedTagId={selectedTagId}
        onSelectTag={handleSelectTag}
        enabled={isContentEnabled}
      />

      <section aria-labelledby="recent-heading" className="flex min-w-0 flex-col gap-4">
        <div>
          <h1 className="t-title-lg text-ink">{tHero('title')}</h1>
          <p className="t-body-lg mt-1 text-muted">{tHero('subtitle')}</p>
        </div>

        <Omnibox />

        <div
          id="recent-items-header"
          className="mt-6 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
        >
          <div>
            <h2 id="recent-heading" className="t-title-sm text-ink">
              {tRecent('heading')}
            </h2>
            <p className="m-0 mt-1 text-[13px] text-muted">{tRecent('subtitle')}</p>
          </div>
        </div>

        {itemsQuery.isLoading ? (
          <div
            role="status"
            data-testid="recent-items-loading"
            className="card p-6 text-[14px] text-muted"
          >
            {tRecent('loading')}
          </div>
        ) : isStaleOrMissingTagFilterError ? (
          <HomeFilteredEmptyState
            tagDisplay={activeTag?.display}
            onClearFilter={() => handleSelectTag(null)}
          />
        ) : showFullPageError && errorCode ? (
          <div
            role="alert"
            data-testid="recent-items-error"
            className="card card-error flex flex-col items-start gap-3 p-5"
          >
            <p className="m-0 text-[14px] text-body">{tErrors(errorCode)}</p>
            <button
              type="button"
              onClick={() => void itemsQuery.refetch()}
              className="btn btn-secondary btn-sm"
            >
              {tRecent('retry')}
            </button>
          </div>
        ) : allItems.length === 0 ? (
          selectedTagId ? (
            <HomeFilteredEmptyState
              tagDisplay={activeTag?.display}
              onClearFilter={() => handleSelectTag(null)}
            />
          ) : (
            <HomeEmptyVaultState />
          )
        ) : (
          <RecentItems
            items={allItems}
            hasNextPage={Boolean(itemsQuery.hasNextPage)}
            isFetchingNextPage={itemsQuery.isFetchingNextPage}
            isFetchNextPageError={itemsQuery.isFetchNextPageError}
            loadMoreErrorMessage={
              itemsQuery.isFetchNextPageError && errorCode ? tErrors(errorCode) : null
            }
            onLoadMore={() => {
              if (itemsQuery.hasNextPage && !itemsQuery.isFetchingNextPage) {
                void itemsQuery.fetchNextPage();
              }
            }}
          />
        )}
      </section>
    </main>
  );
}

export default function AppPage() {
  const { me, status } = useSession();
  const isContentEnabled = contentEnabled();
  const vaultState = me?.vault.status === 'present' ? 'locked' : 'absent';

  if (status === 'loading') return null;

  return (
    <>
      <AppHeader vault={{ state: vaultState }} showLogout />
      <LockedBanner />
      <Suspense fallback={null}>
        <HomeContent isContentEnabled={isContentEnabled} />
      </Suspense>
    </>
  );
}
