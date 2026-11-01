'use client';

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Kbd } from '@/components/ui/kbd';
import { itemsLookupExact, type ItemSummary } from '@/lib/api/content';

const MAX_VISIBLE_DUP_TAG_CHIPS = 3;

export type DupPickerSelection =
  | {
      readonly kind: 'existing';
      readonly item: ItemSummary;
    }
  | {
      readonly kind: 'create-new';
    };

export interface DupPickerDialogProps {
  readonly open: boolean;
  readonly name: string;
  readonly initialItems: readonly ItemSummary[];
  readonly total: number;
  readonly initialNextCursor: string | null;
  readonly onPick: (selection: DupPickerSelection) => void;
  readonly onCancel: () => void;
}

/**
 * U9 Duplicate Item Name Picker (`mockups/index.html` `#dupDialog`, `mockups/mock.js` `openDupDialog`,
 * SPEC §3.4, plan §2.11):
 * - Opened ONLY when `GET /items/lookup?name=` on Enter returns >= 2 matching items.
 * - Renders `role="listbox"` (`#dupListbox`) with each item option (`name`, up to 3 tag chips + `+N`,
 *   optional `hint`, `entry_count`, `created_at`) plus a final option "Tạo mục mới cùng tên".
 * - Supports "Xem thêm" pagination (`GET /items/lookup?name=&cursor=`) while `total > items.length`.
 * - Supports `ArrowUp` / `ArrowDown` / `Enter` / `Escape`; returns an item ID (or create-new choice)
 *   and restores focus to the omnibox when closed.
 */
export function DupPickerDialog({
  open,
  name,
  initialItems,
  total,
  initialNextCursor,
  onPick,
  onCancel,
}: DupPickerDialogProps) {
  const tOmni = useTranslations('content.omnibox');
  const format = useFormatter();

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const loadMoreAbortRef = useRef<AbortController | null>(null);

  const [items, setItems] = useState<ItemSummary[]>([...initialItems]);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    setItems([...initialItems]);
    setNextCursor(initialNextCursor);
    setIsLoadingMore(false);
    setActiveIndex(0);
  }, [initialItems, initialNextCursor, name, open]);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;

    if (open) {
      if (!dlg.open && typeof dlg.showModal === 'function') {
        try {
          dlg.showModal();
        } catch {
          dlg.setAttribute('open', '');
        }
      } else if (!dlg.open) {
        dlg.setAttribute('open', '');
      }
      const firstOpt = optionRefs.current[0];
      if (firstOpt) {
        firstOpt.focus();
      }
    } else if (dlg.open) {
      if (typeof dlg.close === 'function') {
        try {
          dlg.close();
        } catch {
          dlg.removeAttribute('open');
        }
      } else {
        dlg.removeAttribute('open');
      }
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const activeOpt = optionRefs.current[activeIndex];
    if (activeOpt && document.activeElement !== activeOpt) {
      activeOpt.focus();
    }
  }, [activeIndex, open]);

  useEffect(() => {
    return () => {
      loadMoreAbortRef.current?.abort();
    };
  }, []);

  if (!open) {
    return null;
  }

  const totalOptionsCount = items.length + 1; // +1 for "Create new item with the same name"
  const createNewOptionIndex = items.length;
  const remainingCount = Math.max(0, total - items.length);
  const hasMore = remainingCount > 0 && Boolean(nextCursor);

  const formatCreatedAt = (isoString: string): string => {
    const parsedDate = new Date(isoString);
    if (Number.isNaN(parsedDate.getTime())) {
      return isoString;
    }
    try {
      return format.dateTime(parsedDate, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      return isoString.slice(0, 10);
    }
  };

  const handleLoadMore = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!nextCursor || isLoadingMore) return;

    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    setIsLoadingMore(true);

    try {
      const page = await itemsLookupExact({
        name,
        cursor: nextCursor,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;

      setItems((prev) => {
        const seen = new Set(prev.map((it) => it.id));
        const merged = [...prev];
        for (const item of page.items ?? []) {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            merged.push(item);
          }
        }
        return merged;
      });
      setNextCursor(page.next_cursor ?? null);
    } catch {
      // Keep existing loaded items if pagination request fails.
    } finally {
      if (loadMoreAbortRef.current === controller) {
        loadMoreAbortRef.current = null;
        setIsLoadingMore(false);
      }
    }
  };

  const handleSelectIndex = (idx: number) => {
    if (idx === createNewOptionIndex) {
      onPick({ kind: 'create-new' });
      return;
    }
    const target = items[idx];
    if (target) {
      onPick({ kind: 'existing', item: target });
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      setActiveIndex((prev) => (prev + 1) % totalOptionsCount);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      setActiveIndex((prev) => (prev - 1 + totalOptionsCount) % totalOptionsCount);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key === 'Enter') {
      const targetEl = event.target as HTMLElement | null;
      if (targetEl?.closest('[data-dup-more]') || targetEl?.closest('[data-close]')) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      handleSelectIndex(activeIndex);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      id="dupDialog"
      data-testid="dup-picker-dialog"
      aria-labelledby="dupDialogTitle"
      onKeyDown={handleKeyDown}
      onClose={() => {
        onCancel();
      }}
      className="m-auto border-0 bg-transparent p-0 text-body"
    >
      <div className="panel dup-panel w-[min(540px,100%)] max-w-[calc(100vw-24px)] max-h-[88vh] overflow-y-auto p-5">
        <p className="t-label mb-1 text-muted">{tOmni('dupEyebrow')}</p>
        <h2 id="dupDialogTitle" className="t-title-sm mb-1 text-ink">
          {tOmni('dupTitle', { count: total, name })}
        </h2>
        <p className="t-body m-0 mb-4 text-muted">{tOmni('dupBody')}</p>

        <div
          id="dupListbox"
          role="listbox"
          data-testid="dup-picker-listbox"
          aria-label={tOmni('dupListboxAriaLabel', { name })}
          className="dup-list mb-4 flex flex-col gap-2"
        >
          {items.map((item, idx) => {
            const isSelected = activeIndex === idx;
            const shownTags = item.tags.slice(0, MAX_VISIBLE_DUP_TAG_CHIPS);
            const extraTags = Math.max(0, item.tags.length - MAX_VISIBLE_DUP_TAG_CHIPS);
            const formattedDate = formatCreatedAt(item.created_at);

            return (
              <button
                key={item.id}
                ref={(el) => {
                  optionRefs.current[idx] = el;
                }}
                type="button"
                role="option"
                id={`dup-opt-${item.id}`}
                aria-selected={isSelected}
                tabIndex={isSelected ? 0 : -1}
                data-pick={item.id}
                data-opt-idx={idx}
                onClick={() => handleSelectIndex(idx)}
                className="dup-row flex w-full cursor-pointer flex-wrap items-start justify-between gap-x-3 gap-y-2 rounded-lg border border-line bg-canvas px-3.5 py-3 text-left text-body"
              >
                <span className="dup-row-main flex min-w-0 flex-1 flex-col gap-1">
                  <span className="dup-row-tags flex flex-wrap items-center gap-1">
                    <strong className="text-ink [overflow-wrap:anywhere]">{item.name}</strong>
                    {shownTags.map((tag) => (
                      <span
                        key={tag.id}
                        className="chip dup-chip inline-block max-w-full truncate !px-2 !py-0.5 !text-[12px]"
                      >
                        #{tag.display}
                      </span>
                    ))}
                    {extraTags > 0 ? (
                      <>
                        <span aria-hidden="true" className="mono text-[12px] text-muted">
                          +{extraTags}
                        </span>
                        <span className="sr-only">
                          {tOmni('dupMoreTagsAria', { count: extraTags })}
                        </span>
                      </>
                    ) : null}
                  </span>
                  {item.hint ? (
                    <span className="text-[13px] text-muted [overflow-wrap:anywhere]">
                      {item.hint}
                    </span>
                  ) : null}
                </span>
                <span className="sugg-meta mono !ml-0 flex-wrap !whitespace-normal text-[12px] text-muted">
                  {tOmni('dupEntryCount', { count: item.entry_count })} ·{' '}
                  {tOmni('dupCreatedDate', { date: formattedDate })}
                </span>
              </button>
            );
          })}

          <button
            ref={(el) => {
              optionRefs.current[createNewOptionIndex] = el;
            }}
            type="button"
            role="option"
            id="dup-opt-new"
            aria-selected={activeIndex === createNewOptionIndex}
            tabIndex={activeIndex === createNewOptionIndex ? 0 : -1}
            data-pick="new"
            data-opt-idx={createNewOptionIndex}
            onClick={() => handleSelectIndex(createNewOptionIndex)}
            className="dup-row dup-row-new flex w-full cursor-pointer flex-wrap items-center justify-start gap-2 rounded-lg border border-dashed border-line bg-canvas px-3.5 py-3 text-left text-body"
          >
            <span className="mono text-accent">+</span>
            <span>
              <strong>{tOmni('dupCreateNewOption')}</strong>
            </span>
          </button>
        </div>

        {hasMore ? (
          <div className="mb-4">
            <button
              type="button"
              data-dup-more="1"
              data-testid="dup-picker-load-more"
              disabled={isLoadingMore}
              onClick={(e) => void handleLoadMore(e)}
              className="btn btn-tertiary btn-sm w-full"
            >
              {isLoadingMore
                ? tOmni('dupLoadingMore')
                : tOmni('dupLoadMore', { count: remainingCount })}
            </button>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12px] text-muted">
            <Kbd>↑↓</Kbd> <Kbd>Enter</Kbd> <Kbd>Esc</Kbd> · {tOmni('dupShortcutHint')}
          </span>
          <button
            type="button"
            data-close="1"
            data-testid="dup-picker-cancel"
            onClick={onCancel}
            className="btn btn-tertiary"
          >
            {tOmni('dupCancel')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
