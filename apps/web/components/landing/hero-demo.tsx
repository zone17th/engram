'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { BadgeType } from '@/components/ui/badge-type';
import { Kbd } from '@/components/ui/kbd';
import { markPrefix, searchDemo } from '@/lib/demo-search';

/** Chuỗi tự gõ để mời người xem thử. Dừng ngay khi có tương tác thật. */
const AUTOTYPE = 'ca phe';
const AUTOTYPE_STEP_MS = 180;

export interface HeroDemoProps {
  /**
   * Bật chuỗi tự gõ mời dùng thử. Mặc định true cho trang thật; test tương tác
   * truyền false để chuỗi tự gõ không chạy đua với userEvent.type.
   */
  autoType?: boolean;
}

export function HeroDemo({ autoType = true }: HeroDemoProps = {}) {
  const listboxId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [picked, setPicked] = useState<string | null>(null);
  const touched = useRef(false);

  const result = useMemo(() => searchDemo(query), [query]);
  const options = result.items;

  // Tự gõ chỉ chạy khi KHÔNG bật reduced motion (P01-A6) và người dùng chưa chạm vào.
  useEffect(() => {
    if (!autoType) return;
    if (typeof window === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    let index = 0;
    const timer = window.setInterval(() => {
      if (touched.current || index >= AUTOTYPE.length) {
        window.clearInterval(timer);
        return;
      }
      index += 1;
      setQuery(AUTOTYPE.slice(0, index));
      setOpen(true);
    }, AUTOTYPE_STEP_MS);

    return () => window.clearInterval(timer);
  }, [autoType]);

  const choose = useCallback(
    (index: number) => {
      const item = options[index];
      if (!item) return;
      setPicked(item.title);
      setOpen(false);
    },
    [options],
  );

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    touched.current = true;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(active === -1 ? 0 : active);
    } else if (event.key === 'Escape') {
      setOpen(false);
      setActive(-1);
    }
  }

  return (
    <div className="panel p-6 md:p-10">
      {/*
        `data-visual-volatile` cho Playwright biết hai vùng này đổi theo thời gian
        (chuỗi tự gõ + popover kết quả) và phải mask khi so ảnh baseline — xem
        `toHaveScreenshot` ở Task 17. Chỉ là attribute, không thêm phần tử nào
        vào DOM nên layout giữ nguyên như mockup.
      */}
      <div className="omnibox-shell" data-visual-volatile>
        <input
          className="omnibox-input"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            active >= 0 && options[active] ? `${listboxId}-${options[active].id}` : undefined
          }
          placeholder="Gõ từ khoá…"
          value={query}
          onChange={(event) => {
            touched.current = true;
            setQuery(event.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
        />
        <Kbd>Ctrl K</Kbd>
      </div>

      {open && options.length > 0 && (
        <ul
          className="popover mt-2.5"
          role="listbox"
          id={listboxId}
          aria-label="Kết quả mẫu"
          data-visual-volatile
        >
          {options.map((item, index) => {
            const { before, match, after } = markPrefix(item.title, query);
            return (
              <li
                key={item.id}
                id={`${listboxId}-${item.id}`}
                role="option"
                aria-selected={index === active}
                className="sugg-row"
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(index);
                }}
              >
                {/*
                  getByText của Testing Library chỉ đọc text node trực tiếp, không
                  xuyên qua <mark>. Giữ một bản title liền mạch cho a11y/test, còn
                  bản bôi đậm thì aria-hidden để không bị đọc hai lần.
                */}
                <span className="sr-only">{item.title}</span>
                <span aria-hidden="true">
                  {before}
                  <mark>{match}</mark>
                  {after}
                </span>
                <span className="sugg-meta">
                  <BadgeType kind={item.kind} />
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <p className="t-legal mt-3 text-muted" role="note">
        Dữ liệu mẫu, gõ thoải mái — không có gì được gửi đi đâu cả.
      </p>

      <p className="sr-only" role="status" aria-live="polite">
        {picked ? `Đã chọn ${picked}` : ''}
      </p>
    </div>
  );
}
