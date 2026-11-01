'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { RailTagChip, usePaginatedTagsList } from '@/features/tags';
import { getContentErrorI18nKey, type ContentErrorCode } from '@/lib/api/content';

export interface RailProps {
  readonly selectedTagId?: string | null;
  readonly onSelectTag?: (tagId: string | null) => void;
  readonly enabled?: boolean;
}

/**
 * Tag filter rail for `/app` (`mockups/index.html` `#rail-tags`, SPEC §7.0 / §7.7, Task 19):
 * - Fetches the user's active tags (`GET /tags`) under `contentQueryKeys.tags({ sort: 'recent' })`
 *   with "Show more" cursor pagination (`next_cursor`) via `usePaginatedTagsList`.
 * - Each tag chip shows `display` + `item_count`, toggles `?tag=<id>`, and opens a menu for inline rename + delete with Undo.
 * - Demo "Gần đây" list and "Gần nghĩa" switch removed per Task 19 (single recent list on the home grid; semantic is P05).
 */
export function Rail({
  selectedTagId = null,
  onSelectTag,
  enabled = true,
}: RailProps) {
  const tRail = useTranslations('content.home.rail');
  const tErrors = useTranslations('content.errors');
  const { tags, hasMore, isLoadingMore, loadMoreError, loadMore } = usePaginatedTagsList({
    sort: 'recent',
    enabled,
  });
  const [restoreErrorCode, setRestoreErrorCode] = useState<ContentErrorCode | null>(null);

  const loadMoreErrorCode = loadMoreError
    ? (getContentErrorI18nKey(loadMoreError).replace(/^content\.errors\./, '') as ContentErrorCode)
    : null;
  const railAlertCode = restoreErrorCode ?? loadMoreErrorCode;

  const handleChipSelect = (tagId: string) => {
    setRestoreErrorCode(null);
    const nextTagId = selectedTagId === tagId ? null : tagId;
    onSelectTag?.(nextTagId);
  };

  const handleTagDeleted = (deletedTagId: string) => {
    setRestoreErrorCode(null);
    if (selectedTagId === deletedTagId) {
      onSelectTag?.(null);
    }
  };

  return (
    <nav
      id="rail-tags"
      tabIndex={-1}
      aria-label={tRail('ariaLabel')}
      data-testid="rail-tags"
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="t-label m-0 text-muted">{tRail('heading')}</p>
        {selectedTagId ? (
          <button
            type="button"
            id="rail-clear-filter"
            data-testid="rail-clear-filter"
            onClick={() => {
              setRestoreErrorCode(null);
              onSelectTag?.(null);
            }}
            className="mono cursor-pointer border-0 bg-transparent px-1 py-0.5 text-[13px] text-[#005A9F] underline decoration-dotted dark:text-[#63B3FF]"
          >
            {tRail('clearFilter')}
          </button>
        ) : null}
      </div>

      {railAlertCode !== null ? (
        <p
          role="alert"
          data-testid="rail-tags-error"
          className="field-error !mt-0 m-0"
        >
          {tErrors(railAlertCode)}
        </p>
      ) : null}

      {tags.length > 0 ? (
        <>
          <div
            id="rail-tag-list"
            data-testid="rail-tag-list"
            className="flex flex-wrap gap-1.5"
          >
            {tags.map((tag) => (
              <RailTagChip
                key={tag.id}
                tag={tag}
                selected={selectedTagId === tag.id}
                onSelect={handleChipSelect}
                onTagDeleted={handleTagDeleted}
                onRestoreError={(code) => setRestoreErrorCode(code)}
              />
            ))}
          </div>
          {hasMore ? (
            <div>
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={isLoadingMore}
                data-testid="rail-tags-load-more"
                className="btn btn-tertiary btn-sm"
              >
                {isLoadingMore ? tRail('loadingMore') : tRail('loadMore')}
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <p data-testid="rail-tags-empty" className="m-0 text-[13px] text-muted">
          {tRail('empty')}
        </p>
      )}
    </nav>
  );
}
