'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Kbd } from '@/components/ui/kbd';
import { markPrefix } from '@/lib/demo-search';
import { searchHero, type HeroRow } from '@/components/landing/hero-search';
import type { LandingLocale } from '@/components/landing/landing-fixtures';

/**
 * Chuỗi tự gõ để mời người xem thử (như mockups/landing.html: "wif" rồi mở gợi ý).
 * Dừng ngay khi có tương tác thật.
 */
const AUTOTYPE = 'wif';
const AUTOTYPE_STEP_MS = 180;

export interface HeroDemoProps {
  /**
   * Bật chuỗi tự gõ mời dùng thử. Mặc định true cho trang thật; test tương tác
   * truyền false để chuỗi tự gõ không chạy đua với userEvent.type.
   */
  autoType?: boolean;
}

/** Tên đọc lên khi chọn một hàng: tag thì kèm dấu #, mục thì là tên mục. */
function rowLabel(row: HeroRow): string {
  return row.kind === 'tag' ? `#${row.tag.name}` : row.item.name;
}

/** Tên có phần khớp được bôi đậm; bản liền mạch nằm ở sr-only để a11y/test đọc một lần. */
function MarkedName({ text, query }: { text: string; query: string }) {
  const { before, match, after } = markPrefix(text, query);
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {before}
        <mark>{match}</mark>
        {after}
      </span>
    </>
  );
}

function RowTags({ tags }: { tags: string[] }) {
  return (
    <>
      {tags.map((tag) => (
        <span key={tag} className="mono text-[12px] text-muted">
          {' '}#{tag}
        </span>
      ))}
    </>
  );
}

export function HeroDemo({ autoType = true }: HeroDemoProps = {}) {
  const t = useTranslations('landing');
  const locale: LandingLocale = useLocale() === 'en' ? 'en' : 'vi';
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [picked, setPicked] = useState<string | null>(null);
  const touched = useRef(false);

  const groups = useMemo(() => searchHero(locale, query), [locale, query]);
  // Mọi hàng của mọi nhóm là một option; ↑↓ đi qua chúng theo thứ tự hiển thị.
  const options = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const listboxVisible = open && options.length > 0;
  const optionId = (row: HeroRow) => `${listboxId}-${row.key}`;

  useEffect(() => {
    const focusInput = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      touched.current = true;
      inputRef.current?.focus();
      setOpen(true);
    };

    window.addEventListener('keydown', focusInput);
    return () => window.removeEventListener('keydown', focusInput);
  }, []);

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
      const row = options[index];
      if (!row) return;
      setPicked(rowLabel(row));
      setOpen(false);
      setActive(-1);
    },
    [options],
  );

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    touched.current = true;
    if (event.key === 'ArrowDown') {
      if (options.length === 0) return;
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (event.key === 'ArrowUp') {
      if (options.length === 0) return;
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(active === -1 ? 0 : active);
    } else if (event.key === 'Escape') {
      setOpen(false);
      setActive(-1);
    }
  }

  const groupLabel = {
    tags: t('demoGroupTags'),
    items: t('demoGroupItems'),
    near: t('demoGroupNear'),
  } as const;

  function renderRow(row: HeroRow, index: number) {
    let icon: ReactNode;
    let label: ReactNode;
    let meta: ReactNode;
    if (row.kind === 'tag') {
      icon = (
        <span aria-hidden="true" className="mono w-[22px] flex-none text-center text-accent">
          #
        </span>
      );
      label = <MarkedName text={row.tag.name} query={query} />;
      meta = t('demoTagCount', { count: row.tag.count });
    } else if (row.kind === 'item') {
      icon = (
        <span
          aria-hidden="true"
          className="mono inline-flex h-[22px] w-[22px] flex-none items-center justify-center rounded-sm bg-surfaceAlt text-[12px] text-muted"
        >
          {row.item.name.trim().charAt(0)}
        </span>
      );
      label = (
        <>
          <MarkedName text={row.item.name} query={query} />
          <RowTags tags={row.item.tags} />
          {row.item.hint ? (
            <span className="text-[13px] text-muted"> — {row.item.hint}</span>
          ) : null}
        </>
      );
      meta = t('demoItemMeta', { count: row.item.entries, updated: row.item.updated });
    } else {
      icon = (
        <span aria-hidden="true" className="mono w-[22px] flex-none text-center text-muted">
          ≈
        </span>
      );
      label = (
        <>
          {row.item.name}
          <RowTags tags={row.item.tags} />
        </>
      );
      meta = <span className="mono">{row.score.toFixed(2)}</span>;
    }

    return (
      <div
        key={row.key}
        id={optionId(row)}
        role="option"
        aria-selected={index === active}
        className="sugg-row"
        onMouseDown={(event) => {
          event.preventDefault();
          choose(index);
        }}
      >
        {icon}
        <span>{label}</span>
        <span className="sugg-meta">{meta}</span>
      </div>
    );
  }

  return (
    <div className="panel p-6 md:p-10">
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0">
          {/*
            `data-visual-volatile` cho Playwright biết hai vùng này đổi theo thời gian
            (chuỗi tự gõ + popover kết quả) và phải mask khi so ảnh baseline — xem
            `toHaveScreenshot` ở Task 17. Chỉ là attribute, không thêm phần tử nào.
          */}
          <div className="omnibox-shell !rounded-xl !py-[18px]" data-visual-volatile>
            <svg
              width="22"
              height="22"
              viewBox="0 0 20 20"
              fill="none"
              aria-hidden="true"
              className="flex-none"
            >
              <circle cx="8.5" cy="8.5" r="5.5" stroke="var(--muted)" strokeWidth="1.8" />
              <path d="M12.8 12.8 17 17" stroke="var(--muted)" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <input
              ref={inputRef}
              className="omnibox-input !text-[22px]"
              role="combobox"
              aria-label={t('demoInputLabel')}
              aria-expanded={listboxVisible}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={
                listboxVisible && active >= 0 && options[active]
                  ? optionId(options[active])
                  : undefined
              }
              placeholder={t('demoPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onFocus={() => {
                touched.current = true;
              }}
              onPointerDown={() => {
                touched.current = true;
              }}
              onChange={(event) => {
                touched.current = true;
                setQuery(event.target.value);
                setOpen(true);
                setActive(-1);
              }}
              onKeyDown={onKeyDown}
            />
            <Kbd className="hidden md:inline">Ctrl K</Kbd>
          </div>

          {listboxVisible && (
            // Gợi ý nằm trong luồng (không absolute) để panel cao theo kết quả, như mockup.
            <div className="popover mt-2.5" data-visual-volatile>
              <div role="listbox" id={listboxId} aria-label={t('demoResultsLabel')}>
                {groups.map((group, groupIndex) => {
                  const headingId = `${listboxId}-${group.id}`;
                  return (
                    <div
                      key={group.id}
                      role="group"
                      aria-labelledby={headingId}
                      className={groupIndex > 0 ? 'border-t border-line' : undefined}
                    >
                      <div id={headingId} role="presentation" className="sugg-group">
                        {groupLabel[group.id]}
                      </div>
                      {group.rows.map((row) => renderRow(row, options.indexOf(row)))}
                    </div>
                  );
                })}
              </div>
              {/* Chỉ các phím thật sự chạy trong demo (lead: không có Tab-điền). */}
              <div
                aria-hidden="true"
                className="flex flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-line bg-surface px-4 py-2.5 text-[12px] text-muted"
              >
                <span>
                  <Kbd>↑↓</Kbd> {t('demoKeySelect')}
                </span>
                <span>
                  <Kbd>Enter</Kbd> {t('demoKeyOpen')}
                </span>
                <span>
                  <Kbd>Esc</Kbd> {t('demoKeyClose')}
                </span>
                <span className="ml-auto">{t('demoNearOn')}</span>
              </div>
            </div>
          )}

          <p className="t-caption mt-3 text-muted" role="note">
            {t('demoCaption')}
          </p>
        </div>

        <div className="flex flex-col gap-4 lg:pt-1">
          <div>
            <p className="t-label mb-1.5 text-muted">{t('explainMatchTitle')}</p>
            <p className="t-body m-0">{t('explainMatchBody')}</p>
          </div>
          <hr className="rule" />
          <div>
            <p className="t-label mb-1.5 text-muted">{t('explainNearTitle')}</p>
            <p className="t-body m-0">{t('explainNearBody')}</p>
          </div>
          <hr className="rule" />
          <div>
            <p className="t-label mb-1.5 text-muted">{t('explainSaveTitle')}</p>
            <p className="t-body m-0">
              {t.rich('explainSaveBody', {
                code: (chunks) => <span className="mono text-[14px]">{chunks}</span>,
              })}
            </p>
          </div>
        </div>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {picked ? t('demoSelected', { item: picked }) : ''}
      </p>
    </div>
  );
}
