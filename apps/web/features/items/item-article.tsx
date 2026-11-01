'use client';

import { BadgeType } from '@/components/ui/badge-type';
import { loadDemoEntryBody } from '@/features/items/demo-body-loader';
import { EntryBody, type EntryBodyLoader } from '@/features/items/entry-body';

/**
 * The entry card of the item page (mockups `item.html`): header (type + name) is metadata and always visible; the
 * body is an `EntryBody` and the footer text is static. Only the id crosses the server/client boundary for the body,
 * so the text never travels in server-rendered props.
 */
export function ItemArticle({
  entryId,
  version,
  itemId,
  title,
  kind,
  load = loadDemoEntryBody,
  headerLabel,
  footerLabel,
}: {
  entryId: string;
  version?: number;
  itemId?: string;
  title: string;
  kind: 'text' | 'json';
  /** Defaults to the P03 preview loader; a function prop cannot cross from the server page, so the page omits it. */
  load?: EntryBodyLoader;
  headerLabel: string;
  footerLabel: string;
}) {
  return (
    <article className="card overflow-hidden" data-testid="item-article" aria-label={title}>
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <BadgeType kind={kind} />
        <span className="text-[15px] font-semibold">{headerLabel}</span>
      </header>
      <div className="p-5">
        <EntryBody entryId={entryId} version={version} itemId={itemId} load={load} kind={kind} variant="full" />
      </div>
      <footer className="border-t border-line px-4 py-2 text-[12px] text-muted">{footerLabel}</footer>
    </article>
  );
}
