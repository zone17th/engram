'use client';

/**
 * Presentational grouped dropdown for the omnibox (P05 Task 17, plan 2.8 rule 5, 2.9, 2.10, 2.24 items 3 & 10).
 *
 * Markup contract (FE-13, FE-23):
 * - ONE `role="listbox"`; each zone (Tags, Items, Near, Actions) is a `role="group"` labelled by its heading
 *   (`aria-labelledby`); `role="option"` rows only live inside groups; the create CTA and "load more" options sit in
 *   the LAST group (`search.group.actions`).
 * - Visible status lines (near pending, degraded, 409, 429, result count) are plain elements OUTSIDE the listbox and
 *   carry no `role="status"` / `aria-live`; the instance `omnibox-live` region (owned by `omnibox.tsx`) only speaks.
 * - React keys are `kind:id` and zone containers are fixed keyed siblings, so a late `near` zone is appended without
 *   remounting the lexical rows (same DOM elements, same active option).
 * - Hover never changes the active row (plan 2.9); a click activates the row like Enter.
 *
 * The component holds no state and performs no I/O; `omnibox.tsx` owns the merge state and the requests.
 */

import { useTranslations } from 'next-intl';
import { Kbd } from '@/components/ui/kbd';
import { splitMarkedPrefix } from '@/features/omnibox/search-helpers';
import type { SuggestItem, SuggestNearRow, SuggestTag } from '@/lib/api/search';
import {
  getRowKey,
  type NearZoneState,
  type SuggestActiveKey,
  type SuggestRow,
  type SuggestSnapshot,
} from './merge';

export const SUGGEST_LIST_MAX_CHIPS = 3;
export const SUGGEST_LIST_MAX_CHIPS_MOBILE = 2;

export type SuggestListActionKey = 'action:more' | 'action:create';
export type SuggestListKey = SuggestActiveKey | SuggestListActionKey;
export type SuggestListKind = 'recent' | 'suggest' | 'search' | 'tag';
export type SuggestListZoneId = 'tags' | 'items' | 'near' | 'actions';

export interface SuggestListZone {
  readonly id: Exclude<SuggestListZoneId, 'actions'>;
  /** i18n key under `search.group` of the zone heading. */
  readonly headingKey: 'tags' | 'items' | 'near' | 'recentItems' | 'recentTags';
  readonly rows: readonly (SuggestRow | SuggestNearRow)[];
  readonly isNear: boolean;
}

export interface SuggestListModel {
  readonly kind: SuggestListKind;
  readonly scope: SuggestSnapshot['scope'];
  /** Normalised query of the snapshot, used only for `<mark>` highlighting. */
  readonly markQuery: string;
  readonly zones: readonly SuggestListZone[];
  readonly rowCount: number;
  readonly hasMore: boolean;
  readonly showCreate: boolean;
  /** Raw (trimmed) text shown in the no-match line and the create CTA. */
  readonly displayQuery: string;
  readonly nearState: NearZoneState;
  /** `true` when lexical + near are empty and the "no match" box must show (never in `recent`). */
  readonly isEmpty: boolean;
  /** Row keys then action keys, in on-screen order — the keyboard navigation order. */
  readonly navKeys: readonly SuggestListKey[];
}

export interface BuildSuggestListModelInput {
  readonly snapshot: SuggestSnapshot | null;
  /** Enter with a normalised-empty `q` (`!!!`): local no-match, no `/search` (plan 2.9, FE-17). */
  readonly localNoMatchQuery: string | null;
  /** Trimmed draft (search mode) or `#token` (tag mode) for labels and the CTA. */
  readonly displayQuery: string;
  /** Whether "load more" may be offered (cursor belongs to the current draft). */
  readonly allowMore: boolean;
  /** A newer query is in flight: hold back the "no match" box until its response settles (no flash on empty cache). */
  readonly waiting: boolean;
}

export function isRecentSnapshot(snapshot: SuggestSnapshot | null): boolean {
  return (
    snapshot !== null &&
    snapshot.source === 'suggest' &&
    snapshot.scope !== 'tag' &&
    snapshot.qn === ''
  );
}

/**
 * Pure builder shared by the list and the keyboard handler in `omnibox.tsx` so the visual order and the navigation
 * order can never diverge. Returns `null` when there is nothing to show (closed dropdown).
 */
export function buildSuggestListModel(input: BuildSuggestListModelInput): SuggestListModel | null {
  const { snapshot, localNoMatchQuery, displayQuery, allowMore, waiting } = input;

  if (snapshot === null) {
    if (localNoMatchQuery === null) {
      return null;
    }
    const navKeys: SuggestListKey[] = localNoMatchQuery !== '' ? ['action:create'] : [];
    return {
      kind: 'search',
      scope: 'all',
      markQuery: '',
      zones: [],
      rowCount: 0,
      hasMore: false,
      showCreate: localNoMatchQuery !== '',
      displayQuery: localNoMatchQuery,
      nearState: 'idle',
      isEmpty: true,
      navKeys,
    };
  }

  const isRecent = isRecentSnapshot(snapshot);
  const isTagScope = snapshot.scope === 'tag';
  const kind: SuggestListKind = isRecent
    ? 'recent'
    : isTagScope && snapshot.source !== 'search'
      ? 'tag'
      : snapshot.source === 'search'
        ? 'search'
        : 'suggest';

  const lexTags = snapshot.lexical.filter((row) => row.kind === 'tag');
  const lexItems = snapshot.lexical.filter((row) => row.kind === 'item');
  const nearRows = snapshot.near;

  const zones: SuggestListZone[] = [];
  if (isRecent) {
    if (lexItems.length > 0) {
      zones.push({ id: 'items', headingKey: 'recentItems', rows: lexItems, isNear: false });
    }
    if (lexTags.length > 0) {
      zones.push({ id: 'tags', headingKey: 'recentTags', rows: lexTags, isNear: false });
    }
  } else {
    if (lexTags.length > 0) {
      zones.push({ id: 'tags', headingKey: 'tags', rows: lexTags, isNear: false });
    }
    if (lexItems.length > 0) {
      zones.push({ id: 'items', headingKey: 'items', rows: lexItems, isNear: false });
    }
    if (nearRows.length > 0) {
      zones.push({ id: 'near', headingKey: 'near', rows: nearRows, isNear: true });
    }
  }

  const rowCount = zones.reduce((sum, zone) => sum + zone.rows.length, 0);
  if (isRecent && rowCount === 0) {
    return null;
  }

  const hasMore = allowMore && snapshot.source === 'search' && snapshot.nextCursor !== null;
  const showCreate = !isRecent && !isTagScope && displayQuery !== '';
  const navKeys: SuggestListKey[] = [];
  for (const zone of zones) {
    for (const row of zone.rows) {
      navKeys.push(getRowKey(row));
    }
  }
  if (hasMore) navKeys.push('action:more');
  if (showCreate) navKeys.push('action:create');

  return {
    kind,
    scope: snapshot.scope,
    markQuery: snapshot.qn,
    zones,
    rowCount,
    hasMore,
    showCreate,
    displayQuery,
    nearState: snapshot.nearState,
    isEmpty: !isRecent && rowCount === 0 && snapshot.nearState !== 'pending' && !waiting,
    navKeys,
  };
}

/** DOM id of an option (`aria-activedescendant` target). */
export function getSuggestOptionDomId(baseId: string, key: SuggestListKey): string {
  return `${baseId}-opt-${key.replace(':', '-')}`;
}

function nameCollisionKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** Names that occur more than once among the visible item rows (so `created_at` disambiguates them). */
export function collectCollidingNames(zones: readonly SuggestListZone[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const zone of zones) {
    for (const row of zone.rows) {
      if (row.kind !== 'item') continue;
      const key = nameCollisionKey(row.name);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const colliding = new Set<string>();
  for (const [key, count] of counts) {
    if (count > 1) colliding.add(key);
  }
  return colliding;
}

function MarkedText({ text, query, enabled }: { readonly text: string; readonly query: string; readonly enabled: boolean }) {
  if (!enabled || query === '') {
    return <>{text}</>;
  }
  const parts = splitMarkedPrefix(text, query);
  return (
    <>
      {parts.before}
      {parts.match ? <mark>{parts.match}</mark> : null}
      {parts.after}
    </>
  );
}

export interface SuggestListProps {
  readonly baseId: string;
  readonly listboxId: string;
  readonly model: SuggestListModel | null;
  readonly activeKey: SuggestListKey | null;
  /** `aria-busy` on the listbox while a newer query is pending (rows kept, plan 2.8 rule 1). */
  readonly busy: boolean;
  /** First query, no rows yet, > 150 ms: three skeleton rows (plan 2.10). */
  readonly showSkeleton: boolean;
  readonly rateLimitedSeconds: number | null;
  readonly enable409: boolean;
  readonly onActivate: (key: SuggestListKey) => void;
  readonly onOptionRef?: (key: SuggestListKey, element: HTMLElement | null) => void;
}

export function SuggestList({
  baseId,
  listboxId,
  model,
  activeKey,
  busy,
  showSkeleton,
  rateLimitedSeconds,
  enable409,
  onActivate,
  onOptionRef,
}: SuggestListProps) {
  const t = useTranslations('search');

  const colliding = model ? collectCollidingNames(model.zones) : new Set<string>();
  const hasOptions = model !== null && model.navKeys.length > 0;
  const nearPending = model?.nearState === 'pending';
  const degraded = model?.nearState === 'degraded';
  const showCount = model !== null && model.kind === 'search' && model.rowCount > 0;
  const showEmpty = model !== null && model.isEmpty && model.kind !== 'recent';
  const listboxLabel =
    model === null
      ? t('listbox.suggestAriaLabel')
      : model.scope === 'tag'
        ? t('listbox.tagAriaLabel')
        : model.kind === 'search'
          ? t('listbox.searchAriaLabel')
          : t('listbox.suggestAriaLabel');

  const setRef = (key: SuggestListKey) => (el: HTMLElement | null) => {
    onOptionRef?.(key, el);
  };

  const renderTagRow = (row: SuggestTag, isNear: boolean, markQuery: string) => {
    const key = getRowKey(row);
    const selected = activeKey === key;
    const countLabel = t('row.tagItemCount', { count: row.item_count });
    const badge = isNear
      ? t('match.semantic')
      : row.match === 'fuzzy'
        ? t('match.fuzzy')
        : null;
    return (
      <div
        key={key}
        ref={setRef(key)}
        id={getSuggestOptionDomId(baseId, key)}
        role="option"
        aria-label={`#${row.display} — ${countLabel}${badge ? ` · ${badge}` : ''}`}
        aria-selected={selected}
        data-opt-key={key}
        data-opt-kind="tag"
        onClick={() => onActivate(key)}
        className="sugg-row"
      >
        <span className="mono text-accent">#</span>
        <span className="omni-opt-title">
          <MarkedText
            text={row.display}
            query={markQuery}
            enabled={!isNear && (row.match === 'prefix' || row.match === 'prefix_folded')}
          />
        </span>
        <span className="sugg-meta mono">
          {countLabel}
          {badge ? (
            <>
              {' '}
              <span className={isNear ? 'sugg-near-badge mono' : 'sugg-match-badge mono'}>{badge}</span>
            </>
          ) : null}
        </span>
      </div>
    );
  };

  const renderItemRow = (row: SuggestItem, isNear: boolean, markQuery: string) => {
    const key = getRowKey(row);
    const selected = activeKey === key;
    const totalTags = Math.max(row.tag_total, row.tags.length);
    const shownTags = row.tags.slice(0, SUGGEST_LIST_MAX_CHIPS);
    const extraDesktop = Math.max(0, totalTags - SUGGEST_LIST_MAX_CHIPS);
    const extraMobile = Math.max(0, totalTags - SUGGEST_LIST_MAX_CHIPS_MOBILE);
    const countLabel = t('row.entryCount', { count: row.entry_count });
    const showDate = colliding.has(nameCollisionKey(row.name)) && row.created_at !== '';
    const dateLabel = showDate ? row.created_at.slice(0, 10) : '';
    const badge = isNear
      ? t('match.semantic')
      : row.match === 'fuzzy'
        ? t('match.fuzzy')
        : null;
    const moreAria = extraDesktop > 0 ? t('row.moreTagsAria', { count: extraDesktop }) : '';
    const mainLabel = [row.name, shownTags.map((tag) => `#${tag.display}`).join(' '), moreAria]
      .filter(Boolean)
      .join(' ');
    const metaLabel = [countLabel, dateLabel, badge].filter(Boolean).join(' · ');
    return (
      <div
        key={key}
        ref={setRef(key)}
        id={getSuggestOptionDomId(baseId, key)}
        role="option"
        aria-label={`${mainLabel} — ${metaLabel}`}
        aria-selected={selected}
        data-opt-key={key}
        data-opt-kind="item"
        onClick={() => onActivate(key)}
        className="sugg-row"
      >
        <span className="omni-opt-main flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className="omni-opt-title font-semibold text-ink [overflow-wrap:anywhere]">
            <MarkedText
              text={row.name}
              query={markQuery}
              enabled={!isNear && (row.match === 'prefix' || row.match === 'prefix_folded')}
            />
          </span>
          {shownTags.map((tag) => (
            <span
              key={tag.id}
              className="chip dup-chip inline-block max-w-full truncate !px-2 !py-0.5 !text-[12px]"
            >
              #{tag.display}
            </span>
          ))}
          {extraDesktop > 0 ? (
            <span aria-hidden="true" className="mono chip-more-desktop text-[12px] text-muted">
              +{extraDesktop}
            </span>
          ) : null}
          {extraMobile > 0 ? (
            <span aria-hidden="true" className="mono chip-more-mobile text-[12px] text-muted">
              +{extraMobile}
            </span>
          ) : null}
          {extraDesktop > 0 ? <span className="sr-only">{moreAria}</span> : null}
        </span>
        <span className="sugg-meta mono">
          {countLabel}
          {dateLabel ? ` · ${dateLabel}` : ''}
          {badge ? (
            <>
              {' '}
              <span className={isNear ? 'sugg-near-badge mono' : 'sugg-match-badge mono'}>{badge}</span>
            </>
          ) : null}
        </span>
      </div>
    );
  };

  const moreKey: SuggestListKey = 'action:more';
  const createKey: SuggestListKey = 'action:create';

  return (
    <>
      {showCount && model ? (
        <div
          className="sugg-status-line sugg-status-line-top"
          data-omni-status="search-count"
          data-testid="omnibox-result-count"
        >
          <span>{t('state.resultCount', { count: model.rowCount })}</span>
        </div>
      ) : null}

      {showEmpty && model ? (
        <div
          id={`${baseId}-search-empty`}
          data-testid={model.scope === 'tag' ? 'omnibox-tag-empty' : 'omnibox-search-empty'}
          className="omni-empty-box border-b border-line bg-surface px-4 py-4"
        >
          <p className="m-0 mb-0.5 text-[14px] font-semibold text-body">
            {t('state.noMatch', { query: model.displayQuery })}
          </p>
          {model.showCreate ? (
            <p className="m-0 text-[12px] text-muted">
              {t('state.noMatchHint', { query: model.displayQuery })}
            </p>
          ) : null}
        </div>
      ) : null}

      {showSkeleton && model === null ? (
        <div className="sugg-skeleton-wrap" aria-hidden="true" data-testid="omnibox-skeleton">
          {[0, 1, 2].map((i) => (
            <div key={i} className="sugg-skeleton-row">
              <span className="sugg-skeleton-bar" style={{ width: `${70 - i * 12}%` }} />
              <span className="sugg-skeleton-meta" />
            </div>
          ))}
        </div>
      ) : null}

      {hasOptions && model ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label={listboxLabel}
          aria-busy={busy ? 'true' : undefined}
          className={busy ? 'omni-listbox omni-listbox-busy' : 'omni-listbox'}
        >
          {model.zones.map((zone) => {
            const headingId = `${baseId}-grp-${zone.id}-hdr`;
            return (
              <div
                key={zone.id}
                role="group"
                aria-labelledby={headingId}
                data-zone={zone.id}
                className={zone.isNear ? 'sugg-zone sugg-zone-near-append' : 'sugg-zone'}
              >
                <div id={headingId} role="presentation" className="sugg-group">
                  {t(`group.${zone.headingKey}`)}
                </div>
                {zone.rows.map((row) =>
                  row.kind === 'tag'
                    ? renderTagRow(row, zone.isNear, model.markQuery)
                    : renderItemRow(row, zone.isNear, model.markQuery),
                )}
              </div>
            );
          })}

          {model.hasMore || model.showCreate ? (
            <div
              key="actions"
              role="group"
              aria-labelledby={`${baseId}-grp-actions-hdr`}
              data-zone="actions"
              className="sugg-zone sugg-zone-actions"
            >
              <div id={`${baseId}-grp-actions-hdr`} role="presentation" className="sugg-group">
                {t('group.actions')}
              </div>
              {model.hasMore ? (
                <div
                  key={moreKey}
                  ref={setRef(moreKey)}
                  id={getSuggestOptionDomId(baseId, moreKey)}
                  role="option"
                  aria-label={t('actions.loadMore')}
                  aria-selected={activeKey === moreKey}
                  data-opt-key={moreKey}
                  data-opt-kind="more"
                  onClick={() => onActivate(moreKey)}
                  className="sugg-row"
                >
                  <span aria-hidden="true" className="mono text-accent">
                    ↓
                  </span>
                  <span>
                    <strong>{t('actions.loadMore')}</strong>
                  </span>
                  <span className="sugg-meta">
                    <Kbd>{t('actions.loadMoreKbd')}</Kbd>
                  </span>
                </div>
              ) : null}
              {model.showCreate ? (
                <div
                  key={createKey}
                  ref={setRef(createKey)}
                  id={getSuggestOptionDomId(baseId, createKey)}
                  role="option"
                  aria-label={t('actions.createItem', { query: model.displayQuery })}
                  aria-selected={activeKey === createKey}
                  data-opt-key={createKey}
                  data-opt-kind="create"
                  onClick={() => onActivate(createKey)}
                  className="sugg-row omni-create-option"
                >
                  <span aria-hidden="true" className="mono text-accent">
                    +
                  </span>
                  <span className="!overflow-visible !whitespace-normal">
                    <strong>{t('actions.createItem', { query: model.displayQuery })}</strong>
                  </span>
                  <span className="sugg-meta">
                    <Kbd>{t('actions.createItemKbd')}</Kbd>
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {nearPending ? (
        <div className="sugg-status-line" data-omni-status="near-pending" data-testid="omnibox-status-near-pending">
          <span>{t('state.nearPending')}</span>
        </div>
      ) : null}
      {degraded ? (
        <div className="sugg-status-line" data-omni-status="degraded" data-testid="omnibox-status-degraded">
          <span>{t('state.degraded')}</span>
        </div>
      ) : null}
      {enable409 ? (
        <div className="sugg-status-line" data-omni-status="enable-409" data-testid="omnibox-status-enable409">
          <span>{t('state.enable409')}</span>
        </div>
      ) : null}
      {rateLimitedSeconds !== null ? (
        <div
          className="sugg-status-line"
          data-omni-status="rate-limited"
          data-testid="omnibox-status-rate-limited"
        >
          <span>{t('state.rateLimited', { seconds: rateLimitedSeconds })}</span>
        </div>
      ) : null}
    </>
  );
}
