'use client';

import Link from 'next/link';
import { BadgeType } from '@/components/ui/badge-type';
import { loadDemoEntryBody } from '@/features/items/demo-body-loader';
import { EntryBody, type EntryBodyLoader } from '@/features/items/entry-body';

/** Metadata that stays readable while the vault is locked (SPEC §5.1: name, tag, type are not encrypted). */
export interface ItemListEntry {
  id: string;
  title: string;
  kind: 'text' | 'json';
  tags: readonly string[];
}

/**
 * Item cards (mockups `index.html`). Name, tags and type are plain metadata and always render; the body line is an
 * `EntryBody`, i.e. `🔒 ••••••` until the vault is unlocked. Nothing here creates or edits an entry.
 */
export function ItemList({
  items,
  load = loadDemoEntryBody,
  openLabel,
}: {
  items: readonly ItemListEntry[];
  load?: EntryBodyLoader;
  openLabel: string;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2" data-testid="item-list">
      {items.map((item) => (
        <Link
          key={item.id}
          href={`/app/items/${item.id}`}
          data-testid="item-card"
          className="card flex flex-col gap-2 p-5 no-underline !text-body"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display font-bold text-ink">{item.title}</h2>
            <BadgeType kind={item.kind} />
          </div>
          {item.tags.length > 0 ? (
            <span className="mono text-[12px] text-muted">{item.tags.map((tag) => `#${tag}`).join(' ')}</span>
          ) : null}
          <EntryBody entryId={item.id} load={load} kind={item.kind} variant="summary" />
          <span className="t-caption mt-auto text-link">{openLabel}</span>
        </Link>
      ))}
    </div>
  );
}
