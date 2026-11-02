'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ItemSummary } from '@/lib/api/content';

export const MAX_VISIBLE_ITEM_TAG_CHIPS = 3;

export interface RecentItemCardProps {
  readonly item: ItemSummary;
}

/**
 * Single item card on the home recent grid (`mockups/index.html` `#recent-grid`, Q6 / advisor-dec-104):
 * - Displays item `name` (plaintext metadata), up to 3 tag chips + `+N` overflow, and `entry_count` (ICU plural).
 * - Never fetches, decrypts, or renders any entry body or lock mask.
 */
export function RecentItemCard({ item }: RecentItemCardProps) {
  const tRecent = useTranslations('content.home.recent');
  const visibleTags = item.tags.slice(0, MAX_VISIBLE_ITEM_TAG_CHIPS);
  const hiddenTagCount = Math.max(0, item.tags.length - MAX_VISIBLE_ITEM_TAG_CHIPS);

  return (
    <Link
      href={`/app/items/${item.id}`}
      data-testid="item-card"
      data-item-card={item.id}
      className="card flex min-w-0 flex-col gap-3 p-5 no-underline !text-body"
    >
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 min-w-0 max-w-full break-words font-display text-[19px] font-bold tracking-[-.03em] text-ink [overflow-wrap:anywhere]">
          {item.name}
        </h3>
        <span
          data-testid="item-entry-count"
          className="mono shrink-0 text-[12px] text-muted"
        >
          {tRecent('entryCount', { count: item.entry_count })}
        </span>
      </div>

      {item.hint ? (
        <p className="m-0 min-w-0 break-words text-[13px] text-muted [overflow-wrap:anywhere]">
          {item.hint}
        </p>
      ) : null}

      {visibleTags.length > 0 ? (
        <div
          data-testid="item-card-tags"
          className="mt-auto flex min-w-0 flex-wrap items-center gap-1.5"
        >
          {visibleTags.map((tag) => (
            <span
              key={tag.id}
              data-testid="item-tag-chip"
              className="chip inline-block max-w-full truncate !px-2 !py-0.5 !text-[12px]"
            >
              #{tag.display}
            </span>
          ))}
          {hiddenTagCount > 0 ? (
            <>
              <span
                aria-hidden="true"
                data-testid="item-tag-overflow"
                className="mono text-[12px] text-muted"
              >
                +{hiddenTagCount}
              </span>
              <span className="sr-only">
                {tRecent('moreTagsAria', { count: hiddenTagCount })}
              </span>
            </>
          ) : null}
        </div>
      ) : null}
    </Link>
  );
}

export interface RecentItemsGridProps {
  readonly items: readonly ItemSummary[];
  readonly hasNextPage?: boolean;
  readonly isFetchingNextPage?: boolean;
  readonly isFetchNextPageError?: boolean;
  readonly loadMoreErrorMessage?: string | null;
  readonly onLoadMore?: () => void;
}

/**
 * Home page recent items grid (`mockups/index.html` `#recent-grid`, SPEC §7.0 / §7.7).
 * Supports both an explicit "Load more" button and an `IntersectionObserver` sentinel for cursor pagination.
 */
export function RecentItems({
  items,
  hasNextPage = false,
  isFetchingNextPage = false,
  isFetchNextPageError = false,
  loadMoreErrorMessage = null,
  onLoadMore,
}: RecentItemsGridProps) {
  const tRecent = useTranslations('content.home.recent');
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage || isFetchNextPageError || !onLoadMore) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const node = sentinelRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMore();
        }
      },
      { rootMargin: '120px' },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, onLoadMore]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div
        id="recent-grid"
        data-testid="recent-items-grid"
        className="grid min-w-0 gap-3 sm:grid-cols-2"
      >
        {items.map((item) => (
          <RecentItemCard key={item.id} item={item} />
        ))}
      </div>

      {isFetchNextPageError && loadMoreErrorMessage && onLoadMore ? (
        <div
          role="alert"
          data-testid="recent-items-load-more-error"
          className="card card-error flex flex-wrap items-center justify-between gap-3 p-4"
        >
          <p className="m-0 text-[14px] text-body">{loadMoreErrorMessage}</p>
          <button
            type="button"
            onClick={onLoadMore}
            disabled={isFetchingNextPage}
            data-testid="recent-items-load-more-retry"
            className="btn btn-secondary btn-sm"
          >
            {tRecent('retry')}
          </button>
        </div>
      ) : hasNextPage && onLoadMore ? (
        <div
          ref={sentinelRef}
          className="flex justify-center pt-2"
          data-testid="recent-items-pagination"
        >
          <button
            type="button"
            onClick={onLoadMore}
            disabled={isFetchingNextPage}
            data-testid="recent-items-load-more"
            className="btn btn-tertiary btn-sm"
          >
            {isFetchingNextPage ? tRecent('loadingMore') : tRecent('loadMore')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
