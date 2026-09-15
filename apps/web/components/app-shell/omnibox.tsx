'use client';

import { type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/cn';
import { markPrefix, searchDemo, type DemoSearchResult } from '@/lib/demo-search';

type SearchOption =
  | { id: string; kind: 'tag'; label: string; tag: string }
  | { id: string; kind: 'item'; label: string; href: string; preview: string; itemId: string };

function SearchIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="shrink-0">
      <circle cx="8.5" cy="8.5" r="5.5" stroke="var(--muted)" strokeWidth="1.8" />
      <path d="M12.8 12.8 17 17" stroke="var(--muted)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function MarkedText({ text, query }: { text: string; query: string }) {
  const parts = markPrefix(text, query);
  return (
    <>
      {parts.before}
      {parts.match ? <mark>{parts.match}</mark> : null}
      {parts.after}
    </>
  );
}

function makeOptions(result: DemoSearchResult): SearchOption[] {
  return [
    ...result.tags.map((tag, index) => ({ id: `tag-${index}-${tag}`, kind: 'tag' as const, label: `#${tag}`, tag })),
    ...result.items.map((item) => ({
      id: `item-${item.id}`,
      kind: 'item' as const,
      label: item.title,
      href: `/app/items/${item.id}`,
      preview: item.preview,
      itemId: item.id,
    })),
  ];
}

function isItemOption(option: SearchOption): option is Extract<SearchOption, { kind: 'item' }> {
  return option.kind === 'item';
}

export function Omnibox({ compact = false, className }: { compact?: boolean; className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Record<string, HTMLElement | null>>({});
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const result = useMemo(() => searchDemo(query), [query]);
  const options = useMemo(() => makeOptions(result), [result]);
  const listId = 'app-shell-search-results';
  const closeSuggestions = useCallback(() => {
    setOpen(false);
    setSelectedIndex(-1);
  }, []);

  useEffect(() => {
    const focusSearch = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };

    const closeWhenOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeSuggestions();
    };

    window.addEventListener('keydown', focusSearch);
    document.addEventListener('mousedown', closeWhenOutside);
    return () => {
      window.removeEventListener('keydown', focusSearch);
      document.removeEventListener('mousedown', closeWhenOutside);
    };
  }, [closeSuggestions]);

  useEffect(() => {
    if (selectedIndex >= options.length) setSelectedIndex(options.length - 1);
  }, [options.length, selectedIndex]);

  function selectTag(tag: string) {
    setQuery(tag);
    setSelectedIndex(-1);
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function activateSelected() {
    const option = options[selectedIndex];
    if (!option) return;

    if (option.kind === 'tag') {
      selectTag(option.tag);
      return;
    }

    optionRefs.current[option.id]?.click();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      closeSuggestions();
      return;
    }

    if (event.key === 'ArrowDown' && options.length > 0) {
      event.preventDefault();
      setOpen(true);
      setSelectedIndex((current) => (current + 1) % options.length);
      return;
    }

    if (event.key === 'ArrowUp' && options.length > 0) {
      event.preventDefault();
      setOpen(true);
      setSelectedIndex((current) => (current <= 0 ? options.length - 1 : current - 1));
      return;
    }

    if (event.key === 'Enter' && open && hasQuery && selectedIndex >= 0) {
      event.preventDefault();
      activateSelected();
    }
  }

  const hasQuery = query.trim().length > 0;

  function handleRootBlur(event: FocusEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget as Node | null;
    if (!nextTarget || !rootRef.current?.contains(nextTarget)) closeSuggestions();
  }

  return (
    <div
      ref={rootRef}
      onBlur={handleRootBlur}
      className={cn('relative', compact ? 'flex-1 md:block' : 'w-full', className)}
    >
      <label className={cn('omnibox-shell', compact && '!px-3.5 !py-2.5')}>
        <SearchIcon />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedIndex(-1);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          className={cn('omnibox-input', compact && '!text-[15px]')}
          placeholder={compact ? 'Tìm hoặc lưu…' : 'wifi, docker, hợp đồng… hoặc “tên #tag: nội dung”'}
          autoComplete="off"
          spellCheck={false}
          aria-label="Tìm hoặc lưu"
          aria-expanded={open && hasQuery}
          aria-controls={listId}
          aria-activedescendant={open && hasQuery && selectedIndex >= 0 ? options[selectedIndex]?.id : undefined}
          role="combobox"
        />
        <Kbd>Ctrl K</Kbd>
      </label>

      {open && hasQuery ? (
        <div
          id={listId}
          className="popover absolute left-0 right-0 top-[calc(100%+8px)] z-30 max-h-[440px] overflow-auto"
          role="listbox"
          aria-label="Gợi ý"
        >
          {result.tags.length > 0 ? <div className="sugg-group">Tag</div> : null}
          {result.tags.map((tag, index) => {
            const option = options[index];
            return (
              <button
                key={option.id}
                ref={(element) => {
                  optionRefs.current[option.id] = element;
                }}
                id={option.id}
                type="button"
                role="option"
                aria-selected={selectedIndex === index}
                className="sugg-row"
                onClick={() => selectTag(tag)}
              >
                <span aria-hidden="true">#</span>
                <span>
                  <MarkedText text={tag} query={query} />
                </span>
                <span className="sugg-meta">tag</span>
              </button>
            );
          })}

          {result.items.length > 0 ? <div className="sugg-group">Mục</div> : null}
          {result.items.map((item, index) => {
            const optionIndex = result.tags.length + index;
            const option = options[optionIndex];
            if (!isItemOption(option)) return null;
            return (
              <Link
                key={option.id}
                ref={(element) => {
                  optionRefs.current[option.id] = element;
                }}
                id={option.id}
                data-search-option={option.itemId}
                href={option.href}
                role="option"
                aria-selected={selectedIndex === optionIndex}
                className="sugg-row no-underline"
                onClick={closeSuggestions}
              >
                <span aria-hidden="true">↳</span>
                <span>
                  <span className="block">
                    <MarkedText text={item.title} query={query} />
                  </span>
                  <span className="t-caption text-muted">{item.preview}</span>
                </span>
                <span className="sugg-meta">mục</span>
              </Link>
            );
          })}

          {result.tags.length === 0 && result.items.length === 0 ? (
            <div className="p-4 text-[14px] text-muted" role="option" aria-disabled="true" aria-selected="false">
              Không có mục mẫu phù hợp.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
