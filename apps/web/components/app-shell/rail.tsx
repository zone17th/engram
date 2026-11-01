'use client';

import { useTranslations } from 'next-intl';
import { RailTagChip, useTagsList } from '@/features/tags';

export interface RailProps {
  readonly selectedTagId?: string | null;
  readonly onSelectTag?: (tagId: string | null) => void;
  readonly enabled?: boolean;
}

/**
 * Tag filter rail for `/app` (`mockups/index.html` `#rail-tags`, SPEC §7.0 / §7.7, Task 19):
 * - Fetches the user's active tags (`GET /tags`) under `contentQueryKeys.tags({ sort: 'recent' })`.
 * - Each tag chip shows `display` + `item_count`, toggles `?tag=<id>`, and opens a menu for inline rename + delete with Undo.
 * - Demo "Gần đây" list and "Gần nghĩa" switch removed per Task 19 (single recent list on the home grid; semantic is P05).
 */
export function Rail({
  selectedTagId = null,
  onSelectTag,
  enabled = true,
}: RailProps) {
  const tRail = useTranslations('content.home.rail');
  const tagsQuery = useTagsList({ sort: 'recent', enabled });
  const tags = tagsQuery.data?.items ?? [];

  const handleChipSelect = (tagId: string) => {
    const nextTagId = selectedTagId === tagId ? null : tagId;
    onSelectTag?.(nextTagId);
  };

  const handleTagDeleted = (deletedTagId: string) => {
    if (selectedTagId === deletedTagId) {
      onSelectTag?.(null);
    }
  };

  return (
    <nav
      id="rail-tags"
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
            onClick={() => onSelectTag?.(null)}
            className="mono cursor-pointer border-0 bg-transparent px-1 py-0.5 text-[13px] text-[#005A9F] underline decoration-dotted dark:text-[#63B3FF]"
          >
            {tRail('clearFilter')}
          </button>
        ) : null}
      </div>

      {tags.length > 0 ? (
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
            />
          ))}
        </div>
      ) : (
        <p data-testid="rail-tags-empty" className="m-0 text-[13px] text-muted">
          {tRail('empty')}
        </p>
      )}
    </nav>
  );
}
