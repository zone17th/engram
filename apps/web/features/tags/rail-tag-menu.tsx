'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useTranslations } from 'next-intl';
import { useOptionalUndoToast } from '@/components/ui/undo-toast';
import {
  useTagDeleteMutation,
  useTagRenameMutation,
  useTagRestoreMutation,
} from '@/features/tags/mutations';
import {
  createIdempotencyKey,
  getContentErrorI18nKey,
  type ContentErrorCode,
  type Tag,
} from '@/lib/api/content';
import { cn } from '@/lib/cn';

const MAX_TAG_DISPLAY_RUNES = 50;

export interface RailTagChipProps {
  readonly tag: Tag;
  readonly selected: boolean;
  readonly onSelect: (tagId: string) => void;
  readonly onTagDeleted?: (tagId: string) => void;
}

/**
 * Interactive tag pill for the home rail (`mockups/index.html` `#rail-tag-list`):
 * - Filter button sets/clears `?tag=<id>` (ID only in the URL)
 * - Actions menu (`⋯`, keyboard reachable with Arrow/Home/End/Escape)
 * - Inline rename form (`PATCH /tags/{id}` via `useContentMutation`; maps `tag_conflict` and validation errors via `getContentErrorI18nKey`)
 * - Delete (`DELETE /tags/{id}` + Undo toast calling `POST /tags/{id}/restore`; items are kept)
 */
export function RailTagChip({ tag, selected, onSelect, onTagDeleted }: RailTagChipProps) {
  const tRail = useTranslations('content.home.rail');
  const tErrors = useTranslations('content.errors');
  const undoToast = useOptionalUndoToast();

  const renameMutation = useTagRenameMutation();
  const deleteMutation = useTagDeleteMutation();
  const restoreMutation = useTagRestoreMutation();

  const [menuOpen, setMenuOpen] = useState(false);
  const [alignMenuRight, setAlignMenuRight] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftDisplay, setDraftDisplay] = useState(tag.display);
  const [errorCode, setErrorCode] = useState<ContentErrorCode | null>(null);

  const groupRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const pendingRenameKeyRef = useRef<{ display: string; key: string } | null>(null);

  const errorId = useId();
  const renameInputId = useId();

  const closeMenu = useCallback((returnFocus = false) => {
    setMenuOpen(false);
    if (returnFocus) {
      menuTriggerRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const firstItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    firstItem?.focus();
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && groupRef.current && !groupRef.current.contains(target)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu(true);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen, closeMenu]);

  useEffect(() => {
    if (!renaming) return;
    const input = renameInputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
  }, [renaming]);

  const handleToggleMenu = () => {
    if (menuOpen) {
      closeMenu(false);
      return;
    }
    const rect = groupRef.current?.getBoundingClientRect();
    if (rect && typeof window !== 'undefined' && rect.left + 190 > window.innerWidth - 12) {
      setAlignMenuRight(true);
    } else {
      setAlignMenuRight(false);
    }
    setMenuOpen(true);
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(currentIndex + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(currentIndex - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    }
  };

  const startRename = () => {
    setMenuOpen(false);
    setDraftDisplay(tag.display);
    setErrorCode(null);
    pendingRenameKeyRef.current = null;
    setRenaming(true);
  };

  const cancelRename = () => {
    setRenaming(false);
    setErrorCode(null);
    pendingRenameKeyRef.current = null;
    requestAnimationFrame(() => {
      menuTriggerRef.current?.focus();
    });
  };

  const handleRenameSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (renameMutation.isPending) return;

    const trimmed = draftDisplay.trim().replace(/^#+/, '').trim();
    const runeCount = Array.from(trimmed).length;
    if (runeCount < 1 || runeCount > MAX_TAG_DISPLAY_RUNES) {
      setErrorCode('tag_display_invalid');
      return;
    }

    if (trimmed === tag.display) {
      setRenaming(false);
      setErrorCode(null);
      pendingRenameKeyRef.current = null;
      return;
    }

    setErrorCode(null);
    const idempotencyKey =
      pendingRenameKeyRef.current?.display === trimmed
        ? pendingRenameKeyRef.current.key
        : createIdempotencyKey();
    pendingRenameKeyRef.current = { display: trimmed, key: idempotencyKey };

    try {
      await renameMutation.mutateAsync({
        id: tag.id,
        display: trimmed,
        idempotencyKey,
      });
      pendingRenameKeyRef.current = null;
      setRenaming(false);
      setErrorCode(null);
    } catch (error) {
      const i18nKey = getContentErrorI18nKey(error);
      setErrorCode(i18nKey.replace(/^content\.errors\./, '') as ContentErrorCode);
      pendingRenameKeyRef.current = null;
    }
  };

  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelRename();
    }
  };

  const handleDelete = async () => {
    if (deleteMutation.isPending) return;
    const originTrigger = menuTriggerRef.current;
    setMenuOpen(false);
    const deleteIdempotencyKey = createIdempotencyKey();
    try {
      await deleteMutation.mutateAsync({
        id: tag.id,
        idempotencyKey: deleteIdempotencyKey,
      });
      onTagDeleted?.(tag.id);
      undoToast?.pushUndoToast({
        message: tRail('deleteToastMessage', { display: tag.display }),
        detail: tRail('deleteToastDetail'),
        actionLabel: tRail('undoAction'),
        returnFocusTo: originTrigger,
        onUndo: async () => {
          await restoreMutation.mutateAsync({
            id: tag.id,
            idempotencyKey: createIdempotencyKey(),
          });
        },
      });
    } catch (error) {
      const i18nKey = getContentErrorI18nKey(error);
      setErrorCode(i18nKey.replace(/^content\.errors\./, '') as ContentErrorCode);
    }
  };

  if (renaming) {
    return (
      <div
        ref={groupRef}
        data-testid={`rail-tag-rename-form-${tag.id}`}
        className="w-full rounded-lg border border-line bg-surface p-2.5"
      >
        <form onSubmit={handleRenameSubmit} className="flex flex-col gap-2" noValidate>
          <label htmlFor={renameInputId} className="sr-only">
            {tRail('renameLabel')}
          </label>
          <input
            ref={renameInputRef}
            id={renameInputId}
            type="text"
            value={draftDisplay}
            onChange={(event) => {
              setDraftDisplay(event.target.value);
              if (errorCode) setErrorCode(null);
            }}
            onKeyDown={handleRenameKeyDown}
            maxLength={MAX_TAG_DISPLAY_RUNES}
            autoComplete="off"
            spellCheck={false}
            aria-label={tRail('renameLabel')}
            aria-invalid={errorCode !== null ? 'true' : undefined}
            aria-describedby={errorCode !== null ? errorId : undefined}
            disabled={renameMutation.isPending}
            data-testid={`rail-tag-rename-input-${tag.id}`}
            className="field-input !py-1.5 !text-[14px]"
          />
          {errorCode !== null ? (
            <p
              id={errorId}
              role="alert"
              data-testid={`rail-tag-rename-error-${tag.id}`}
              className="field-error !mt-0"
            >
              {tErrors(errorCode)}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={cancelRename}
              disabled={renameMutation.isPending}
              data-testid={`rail-tag-rename-cancel-${tag.id}`}
              className="btn btn-tertiary btn-sm"
            >
              {tRail('renameCancel')}
            </button>
            <button
              type="submit"
              disabled={renameMutation.isPending}
              data-testid={`rail-tag-rename-save-${tag.id}`}
              className="btn btn-primary btn-sm"
            >
              {renameMutation.isPending ? tRail('renameSaving') : tRail('renameSave')}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div
      ref={groupRef}
      data-tag-item={tag.id}
      data-testid="rail-tag-item"
      className={cn(
        'relative inline-flex max-w-full items-center rounded-pill border transition-colors',
        selected
          ? 'border-accent bg-paleAccent'
          : 'border-line bg-surface hover:border-lineStrong hover:bg-surfaceAlt',
      )}
    >
      <button
        type="button"
        onClick={() => {
          closeMenu(false);
          onSelect(tag.id);
        }}
        aria-pressed={selected}
        data-tag-filter={tag.id}
        data-testid={`rail-tag-filter-${tag.id}`}
        className={cn(
          'tag-pill-btn inline-flex min-w-0 items-center gap-1.5 rounded-l-pill border-0 bg-transparent py-1.5 pl-3 pr-2 font-mono text-[14px] font-medium cursor-pointer',
          selected ? 'text-accent' : 'text-body',
        )}
      >
        <span data-tag-label className="truncate">
          #{tag.display}
        </span>
        <span className="tag-pill-count text-[12px] text-muted">{tag.item_count}</span>
      </button>

      <button
        ref={menuTriggerRef}
        type="button"
        onClick={handleToggleMenu}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={tRail('menuAriaLabel', { display: tag.display })}
        data-tag-menu-btn={tag.id}
        data-testid={`rail-tag-menu-trigger-${tag.id}`}
        className="tag-menu-trigger inline-flex items-center justify-center rounded-r-pill border-0 border-l border-line bg-transparent px-2.5 py-1.5 font-mono text-[13px] text-muted cursor-pointer hover:bg-surfaceAlt hover:text-body"
      >
        ⋯
      </button>

      {menuOpen ? (
        <div
          ref={menuRef}
          role="menu"
          onKeyDown={handleMenuKeyDown}
          data-tag-menu={tag.id}
          data-testid={`rail-tag-menu-${tag.id}`}
          className={cn(
            ' absolute top-[calc(100%+4px)] z-50 flex min-w-[160px] max-w-[calc(100vw-32px)] flex-col gap-0.5 rounded-md border border-line bg-canvas p-1 shadow-pop',
            alignMenuRight ? 'right-0' : 'left-0',
          )}
        >
          <button
            type="button"
            role="menuitem"
            onClick={startRename}
            data-tag-rename={tag.id}
            data-testid={`rail-tag-rename-action-${tag.id}`}
            className="menu-item flex w-full items-center justify-between gap-2 rounded-sm border-0 bg-transparent px-2.5 py-2 text-left font-sans text-[14px] font-medium text-body cursor-pointer hover:bg-surface"
          >
            <span>{tRail('renameMenuItem')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
            data-tag-delete={tag.id}
            data-testid={`rail-tag-delete-action-${tag.id}`}
            className="menu-item flex w-full items-center justify-between gap-2 rounded-sm border-0 bg-transparent px-2.5 py-2 text-left font-sans text-[14px] font-medium text-[#B4232A] dark:text-[#FF8589] cursor-pointer hover:bg-surface disabled:opacity-45"
          >
            <span>{tRail('deleteMenuItem')}</span>
          </button>
        </div>
      ) : null}

      {errorCode !== null ? (
        <p role="alert" className="field-error w-full px-2 pb-1">
          {tErrors(errorCode)}
        </p>
      ) : null}
    </div>
  );
}
