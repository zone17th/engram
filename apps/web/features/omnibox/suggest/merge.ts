/**
 * Pure stable merge reducer for omnibox `/suggest` and `/search` responses
 * per P05 plan mục 2.8, mục 2.24 (items 2, 3, 5, 10), and SPEC §3.5 rule 11, §6.8.
 *
 * Key invariants:
 * - `queryGen`: monotonic generation counter; responses with `gen !== state.queryGen` are dropped.
 * - `snapshot = { gen, qn, scope, limit, lexical, near, nearState }`:
 *   - A response with non-empty `lexical_partial` NEVER defines or replaces a snapshot (FE-12a);
 *     if no complete lexical response arrives for `gen`, previous rows are kept.
 *   - The first complete lexical response (`lexical_partial.length === 0`, regardless of `semantic` flag)
 *     defines the snapshot (`lexical = [...tags, ...items]`).
 *   - The other response (or a `semantic=1` response with `lexical_partial` arriving after a complete
 *     snapshot for the same `gen`) contributes ONLY `near`: deduplicated by `(kind, id)` against
 *     `lexical` (and itself), clipped to `min(quota.near, limit - lexical.length)`, and appended
 *     without mutating or re-creating the `lexical` array reference.
 * - `activeKey: "kind:id" | null`: preserved across updates if `(kind, id)` remains in the visible rows,
 *   otherwise reset to `null` (never auto-activates first row except in `#` tag mode, rule 7).
 * - `#` tag mode (rule 7 + 2.24 item 10):
 *   - Local cached tag rows show immediately with the first row active (`activeKey = "tag:<id>"`).
 *   - Server `scope=tag` response replaces the tag rows, keeping `activeKey` if still present,
 *     otherwise activating the first row (`null` if empty).
 *   - Gate close in `#` mode (`closeGate` with `keepLocalTagCache: true`) keeps local cached tag rows,
 *     clears server snapshot rows, and resets `activeKey = null` so Enter does not open a stale row.
 * - Gate close outside `#` mode clears `snapshot = null`, `localTagRows = []`, `activeKey = null`,
 *   `isBusy = false`, `dropdownOpen = false`.
 * - Toggle `≈` off removes only `near` (`near = []`, `nearState = 'off'`); if `activeKey` was in `near`,
 *   resets `activeKey = null`.
 * - Cursor page merge ("Xem thêm", OpenAPI `/search` description + SPEC §6.8 / FE-C21):
 *   appends `items` (or `tags` when `scope === 'tag'`) in server order deduplicated by `(kind, id)`,
 *   preserving page-1 `near`, `nearState`, and semantic status (`semantic: false` / `near: []` /
 *   `semantic_reason: 'request_lexical'` on a cursor page never triggers `'degraded'` or `'off'`).
 */

import type { Tag } from '@/lib/api/content';
import type {
  SearchResponse,
  SearchScope,
  SemanticReason,
  SuggestItem,
  SuggestNearRow,
  SuggestQuota,
  SuggestResponse,
  SuggestTag,
} from '@/lib/api/search';
import { computeClientNearCap, SEARCH_FIRST_PAGE_NEAR_MAX } from './quota';

export type SuggestRow = SuggestTag | SuggestItem;
export type SuggestActiveKey = `tag:${string}` | `item:${string}`;

export type NearZoneState =
  | 'idle'
  | 'pending'
  | 'shown'
  | 'off'
  | 'degraded'
  | 'unavailable';

export interface SuggestSnapshot {
  readonly gen: number;
  readonly qn: string;
  readonly scope: SearchScope;
  readonly limit: number;
  /** Fixed lexical rows (`tags` followed by `items`). Reference stays stable when late `near` arrives. */
  readonly lexical: readonly SuggestRow[];
  /** Near-meaning rows (`match: "semantic"`), deduplicated against `lexical` and clipped by quota. */
  readonly near: readonly SuggestNearRow[];
  readonly nearState: NearZoneState;
  /** Effective wire `quota` from `/suggest` (or synthetic page-1 quota for `/search`). */
  readonly quota: SuggestQuota;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly generation: number | null;
  readonly source: 'suggest' | 'search' | 'tag-cache';
}

export interface PendingNearBuffer {
  readonly gen: number;
  readonly semantic: boolean;
  readonly semanticReason: SemanticReason | null;
  readonly near: readonly SuggestNearRow[];
  readonly generation: number | null;
}

export interface SemanticLegOutcome {
  readonly gen: number;
  readonly kind: 'failed' | 'aborted';
}

export interface SuggestMergeState {
  readonly queryGen: number;
  readonly pendingQn: string;
  readonly pendingScope: SearchScope;
  readonly pendingLimit: number;
  /** Per-generation hint indicating whether `queryGen` issued a `semantic=1` request (`pending` near zone). */
  readonly expectSemantic: boolean;
  readonly isBusy: boolean;
  readonly dropdownOpen: boolean;
  readonly snapshot: SuggestSnapshot | null;
  /** Buffered semantic leg that arrived with `lexical_partial` before any complete snapshot for `queryGen` (RV-T9-FE1-4). */
  readonly pendingNear: PendingNearBuffer | null;
  /** Recorded semantic leg failure/abort that arrived before any complete snapshot for `queryGen` (RV-T9-FE2-1). */
  readonly semanticLegOutcome: SemanticLegOutcome | null;
  /**
   * Durable user semantic toggle flag (`Me.settings.semantic_suggest`), changed only by
   * `toggle_semantic_off`, `toggle_semantic_on_pending`, or `sync_semantic_enabled` (RV-T9-FE1-5, RV-T9-FE2-2).
   */
  readonly semanticEnabled: boolean;
  /** Local tag-cache rows in `#` mode (kept when gate closes in `#` mode per 2.24 item 10). */
  readonly localTagRows: readonly SuggestTag[];
  readonly activeKey: SuggestActiveKey | null;
  /** Set to `true` when toggle-off clears an `activeKey` that belonged to `near` (rule 4 live region cue). */
  readonly activeClearedFromNear: boolean;
}

export function getRowKey(row: { readonly kind: 'tag' | 'item'; readonly id: string }): SuggestActiveKey {
  return `${row.kind}:${row.id}`;
}

export function isSuggestTag(tag: Tag | SuggestTag): tag is SuggestTag {
  return 'kind' in tag && tag.kind === 'tag';
}

export function toSuggestTagFromCachedTag(tag: Tag): SuggestTag {
  return {
    kind: 'tag',
    id: tag.id,
    display: tag.display,
    item_count: tag.item_count,
    last_used_at: tag.last_used_at,
    match: 'prefix',
  };
}

export function createInitialMergeState(): SuggestMergeState {
  return {
    queryGen: 0,
    pendingQn: '',
    pendingScope: 'all',
    pendingLimit: 8,
    expectSemantic: false,
    isBusy: false,
    dropdownOpen: false,
    snapshot: null,
    pendingNear: null,
    semanticLegOutcome: null,
    semanticEnabled: true,
    localTagRows: [],
    activeKey: null,
    activeClearedFromNear: false,
  };
}
function deriveNearStateFromResponse(params: {
  readonly semantic: boolean;
  readonly semanticReason: SemanticReason | null;
  readonly expectSemanticResponse: boolean;
  readonly currentNearState?: NearZoneState;
}): NearZoneState {
  if (params.semantic) {
    return 'shown';
  }
  switch (params.semanticReason) {
    case 'disabled_server':
      return 'unavailable';
    case 'disabled_user':
      return 'off';
    case 'degraded':
      return 'degraded';
    case 'short_query':
      return 'idle';
    case 'request_lexical':
      if (params.expectSemanticResponse) {
        return params.currentNearState === 'shown' ? 'shown' : 'pending';
      }
      return params.currentNearState ?? 'idle';
    default:
      return params.expectSemanticResponse ? 'pending' : 'idle';
  }
}

function dedupAndClipNear(
  lexical: readonly SuggestRow[],
  candidateNear: readonly SuggestNearRow[],
  quotaNear: number,
  limit: number,
): readonly SuggestNearRow[] {
  const cap = computeClientNearCap(quotaNear, limit, lexical.length);
  if (cap <= 0 || candidateNear.length === 0) {
    return [];
  }

  const seen = new Set<SuggestActiveKey>();
  for (const row of lexical) {
    seen.add(getRowKey(row));
  }

  const result: SuggestNearRow[] = [];
  for (const row of candidateNear) {
    const key = getRowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
    if (result.length >= cap) {
      break;
    }
  }
  return result;
}

function hasKeyInRows(
  key: SuggestActiveKey | null,
  lexical: readonly SuggestRow[],
  near: readonly SuggestNearRow[],
): boolean {
  if (!key) return false;
  for (const row of lexical) {
    if (getRowKey(row) === key) return true;
  }
  for (const row of near) {
    if (getRowKey(row) === key) return true;
  }
  return false;
}

function resolveActiveKeyAfterSnapshotReplace(params: {
  readonly prevActiveKey: SuggestActiveKey | null;
  readonly scope: SearchScope;
  readonly lexical: readonly SuggestRow[];
  readonly near: readonly SuggestNearRow[];
}): SuggestActiveKey | null {
  if (hasKeyInRows(params.prevActiveKey, params.lexical, params.near)) {
    return params.prevActiveKey;
  }
  // Rule 1 & Rule 7: never auto-activate first row except in `#` (`scope === 'tag'`) mode.
  if (params.scope === 'tag' && params.lexical.length > 0) {
    return getRowKey(params.lexical[0]!);
  }
  return null;
}

export type SuggestMergeAction =
  | {
      readonly type: 'start_query';
      readonly qn: string;
      readonly scope: SearchScope;
      readonly limit: number;
      readonly expectSemantic?: boolean;
    }
  | {
      readonly type: 'seed_tag_cache';
      readonly qn: string;
      readonly limit?: number;
      readonly tags: readonly (Tag | SuggestTag)[];
    }
  | {
      readonly type: 'receive_suggest';
      readonly gen: number;
      readonly qn?: string;
      readonly response: SuggestResponse;
      readonly expectSemantic?: boolean;
    }
  | {
      readonly type: 'receive_search_first_page';
      readonly gen: number;
      readonly qn: string;
      readonly response: SearchResponse;
      readonly expectSemantic?: boolean;
    }
  | {
      readonly type: 'receive_search_cursor_page';
      readonly gen: number;
      readonly response: SearchResponse;
    }
  | {
      readonly type: 'semantic_leg_failed';
      readonly gen?: number;
      readonly aborted?: boolean;
    }
  | {
      readonly type: 'toggle_semantic_off';
    }
  | {
      readonly type: 'toggle_semantic_on_pending';
    }
  | {
      readonly type: 'sync_semantic_enabled';
      readonly enabled: boolean;
    }
  | {
      readonly type: 'set_active_key';
      readonly activeKey: SuggestActiveKey | null;
    }
  | {
      readonly type: 'move_active';
      readonly direction: 'next' | 'prev';
    }
  | {
      readonly type: 'close_gate';
      readonly keepLocalTagCache?: boolean;
    }
  | {
      readonly type: 'reset';
    };

/**
 * Starts a new query generation (`queryGen + 1`), keeping existing rows visible with `isBusy = true`
 * until the first complete lexical response for the new `queryGen` arrives (plan mục 2.8 rule 1).
 * Note: `expectSemantic` is a per-generation hint (only chooses `'pending'` when `semanticEnabled` is true)
 * and never mutates the durable `semanticEnabled` user setting (RV-T9-FE2-2).
 */
export function startNewQueryGen(
  state: SuggestMergeState,
  params: {
    readonly qn: string;
    readonly scope: SearchScope;
    readonly limit: number;
    readonly expectSemantic?: boolean;
  },
): SuggestMergeState {
  const nextGen = state.queryGen + 1;
  return {
    ...state,
    queryGen: nextGen,
    pendingQn: params.qn,
    pendingScope: params.scope,
    pendingLimit: params.limit,
    expectSemantic: state.semanticEnabled && Boolean(params.expectSemantic),
    pendingNear: null,
    semanticLegOutcome: null,
    isBusy: true,
    activeClearedFromNear: false,
  };
}

/**
 * Seeds immediate client-side cached tag rows in `#` mode (plan mục 2.8 rule 7):
 * - First row is automatically activated (`activeKey = "tag:<id>"`).
 * - Stored in `localTagRows` and reflected in `snapshot` until server `scope='tag'` response arrives.
 */
export function seedTagModeCacheRows(
  state: SuggestMergeState,
  params: {
    readonly qn: string;
    readonly limit?: number;
    readonly tags: readonly (Tag | SuggestTag)[];
  },
): SuggestMergeState {
  const limit = params.limit ?? state.pendingLimit;
  const suggestTags: SuggestTag[] = params.tags
    .slice(0, limit)
    .map((t) => (isSuggestTag(t) ? t : toSuggestTagFromCachedTag(t)));
  const firstKey: SuggestActiveKey | null =
    suggestTags.length > 0 ? getRowKey(suggestTags[0]!) : null;
  const activeKey: SuggestActiveKey | null =
    state.activeKey && suggestTags.some((t) => getRowKey(t) === state.activeKey)
      ? state.activeKey
      : firstKey;

  const snapshot: SuggestSnapshot = {
    gen: state.queryGen,
    qn: params.qn,
    scope: 'tag',
    limit,
    lexical: suggestTags,
    near: [],
    nearState: 'idle',
    quota: { tag: limit, lexical: limit, near: 0 },
    hasMore: false,
    nextCursor: null,
    generation: null,
    source: 'tag-cache',
  };

  return {
    ...state,
    pendingQn: params.qn,
    pendingScope: 'tag',
    pendingLimit: limit,
    dropdownOpen: true,
    localTagRows: suggestTags,
    snapshot,
    activeKey,
    activeClearedFromNear: false,
  };
}

function mergePrimarySnapshotResponse(
  state: SuggestMergeState,
  params: {
    readonly gen: number;
    readonly qn: string;
    readonly scope: SearchScope;
    readonly limit: number;
    readonly tags: readonly SuggestTag[];
    readonly items: readonly SuggestItem[];
    readonly near: readonly SuggestNearRow[];
    readonly semantic: boolean;
    readonly semanticReason: SemanticReason | null;
    readonly quota: SuggestQuota;
    readonly nearClipLimit: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
    readonly generation: number | null;
    readonly source: 'suggest' | 'search';
    readonly isPartial: boolean;
    readonly hasCompleteSnapshotForGen: boolean;
    readonly expectSemantic?: boolean;
  },
): SuggestMergeState {
  if (params.gen !== state.queryGen) {
    return state;
  }

  const isLexicalOnlyLeg = !params.semantic && params.semanticReason === 'request_lexical';

  // Case A: Complete snapshot for this `gen` does NOT exist yet.
  if (!params.hasCompleteSnapshotForGen) {
    if (params.isPartial) {
      // Rule 1 (FE-12a): `lexical_partial` never defines or replaces a snapshot; keep previous rows.
      // RV-T9-FE1-4: if the semantic leg (`semantic=1`) arrived first with `lexical_partial`,
      // buffer its `near` rows and semantic outcome for `params.gen` so the later complete `semantic=0`
      // response merges them instead of getting stuck at `nearState: 'pending'`.
      const nextPendingNear: PendingNearBuffer | null =
        state.semanticEnabled && !isLexicalOnlyLeg
          ? {
              gen: params.gen,
              semantic: params.semantic,
              semanticReason: params.semanticReason,
              near: params.semantic ? params.near : [],
              generation: params.generation,
            }
          : state.pendingNear;

      return {
        ...state,
        pendingNear: nextPendingNear,
        isBusy: false,
        activeClearedFromNear: false,
      };
    }

    const lexical: readonly SuggestRow[] = [...params.tags, ...params.items];
    const buffered =
      state.pendingNear !== null && state.pendingNear.gen === params.gen
        ? state.pendingNear
        : null;
    const recordedOutcome =
      state.semanticLegOutcome !== null && state.semanticLegOutcome.gen === params.gen
        ? state.semanticLegOutcome
        : null;

    let near: readonly SuggestNearRow[] = [];
    let nearState: NearZoneState;
    let generation: number | null = params.generation;

    // RV-T9-FE1-5 & RV-T9-FE2-2: if the durable user setting `semanticEnabled` is false,
    // never show `near` and keep `nearState = 'off'` even if a `semantic=1` response arrives.
    if (!state.semanticEnabled) {
      near = [];
      nearState = 'off';
    } else if (params.semantic) {
      near = dedupAndClipNear(lexical, params.near, params.quota.near, params.nearClipLimit);
      nearState = 'shown';
    } else if (buffered) {
      if (buffered.semantic) {
        near = dedupAndClipNear(lexical, buffered.near, params.quota.near, params.nearClipLimit);
      }
      nearState = deriveNearStateFromResponse({
        semantic: buffered.semantic,
        semanticReason: buffered.semanticReason,
        expectSemanticResponse: false,
      });
      generation = buffered.generation ?? params.generation;
    } else if (recordedOutcome) {
      // RV-T9-FE2-1: consume a semantic-leg failure or abort that arrived before the complete lexical snapshot.
      nearState = recordedOutcome.kind === 'aborted' ? 'idle' : 'degraded';
    } else {
      const expectSemantic =
        params.expectSemantic !== undefined ? params.expectSemantic : state.expectSemantic;
      nearState = deriveNearStateFromResponse({
        semantic: false,
        semanticReason: params.semanticReason,
        expectSemanticResponse: expectSemantic,
      });
    }
    const activeKey = resolveActiveKeyAfterSnapshotReplace({
      prevActiveKey: state.activeKey,
      scope: params.scope,
      lexical,
      near,
    });

    const nextSnapshot: SuggestSnapshot = {
      gen: params.gen,
      qn: params.qn,
      scope: params.scope,
      limit: params.limit,
      lexical,
      near,
      nearState,
      quota: params.quota,
      hasMore: params.hasMore,
      nextCursor: params.nextCursor,
      generation,
      source: params.source,
    };

    return {
      ...state,
      pendingNear: null,
      semanticLegOutcome: null,
      isBusy: false,
      dropdownOpen: true,
      snapshot: nextSnapshot,
      activeKey,
      activeClearedFromNear: false,
    };
  }

  // Case B: Complete snapshot for this `gen` ALREADY exists.
  // The second response contributes ONLY `near` (or updates `nearState` if it was the semantic leg).
  const currentSnapshot = state.snapshot!;
  if (isLexicalOnlyLeg) {
    // Late lexical-only response arriving after complete `semantic=1` response defined the snapshot:
    // its tags/items are ignored because the snapshot is already complete.
    return {
      ...state,
      isBusy: false,
      activeClearedFromNear: false,
    };
  }

  // RV-T9-FE1-5: if user toggled `≈` off while the `semantic=1` request was in flight,
  // ignore the late semantic leg and keep `near = []` and `nearState = 'off'`.
  if (!state.semanticEnabled || currentSnapshot.nearState === 'off') {
    return {
      ...state,
      pendingNear: null,
      semanticLegOutcome: null,
      isBusy: false,
      snapshot: {
        ...currentSnapshot,
        near: [],
        nearState: 'off',
      },
      activeClearedFromNear: false,
    };
  }

  const nextNear = params.semantic
    ? dedupAndClipNear(
        currentSnapshot.lexical,
        params.near,
        currentSnapshot.quota.near,
        params.nearClipLimit,
      )
    : currentSnapshot.near;

  const nextNearState = deriveNearStateFromResponse({
    semantic: params.semantic,
    semanticReason: params.semanticReason,
    expectSemanticResponse: false,
    currentNearState: currentSnapshot.nearState,
  });

  // Preserve exact `currentSnapshot.lexical` array reference and `activeKey`.
  return {
    ...state,
    pendingNear: null,
    semanticLegOutcome: null,
    isBusy: false,
    snapshot: {
      ...currentSnapshot,
      near: nextNear,
      nearState: nextNearState,
      generation: params.generation ?? currentSnapshot.generation,
    },
    activeClearedFromNear: false,
  };
}

/**
 * Applies a `/suggest` response for generation `gen` per plan mục 2.8 rules 1–3, 7.
 */
export function applySuggestResponse(
  state: SuggestMergeState,
  params: {
    readonly gen: number;
    readonly qn?: string;
    readonly response: SuggestResponse;
    readonly expectSemantic?: boolean;
  },
): SuggestMergeState {
  const { response } = params;
  const hasCompleteServerSnapshotForGen =
    state.snapshot !== null &&
    state.snapshot.gen === params.gen &&
    state.snapshot.source !== 'tag-cache';

  return mergePrimarySnapshotResponse(state, {
    gen: params.gen,
    qn: params.qn ?? state.pendingQn,
    scope: response.scope,
    limit: response.limit,
    tags: response.tags,
    items: response.items,
    near: response.near,
    semantic: response.semantic,
    semanticReason: response.semantic_reason,
    quota: response.quota,
    nearClipLimit: response.limit,
    hasMore: response.has_more,
    nextCursor: null,
    generation: response.generation,
    source: 'suggest',
    isPartial: response.lexical_partial.length > 0,
    hasCompleteSnapshotForGen: hasCompleteServerSnapshotForGen,
    expectSemantic: params.expectSemantic,
  });
}

/**
 * Applies a first-page `GET /search` response (Enter when no row is active).
 */
export function applySearchFirstPageResponse(
  state: SuggestMergeState,
  params: {
    readonly gen: number;
    readonly qn: string;
    readonly response: SearchResponse;
    readonly expectSemantic?: boolean;
  },
): SuggestMergeState {
  const { response } = params;
  const hasCompleteSearchSnapshotForGen =
    state.snapshot !== null &&
    state.snapshot.gen === params.gen &&
    state.snapshot.source === 'search';
  const lexicalCount =
    hasCompleteSearchSnapshotForGen && state.snapshot
      ? state.snapshot.lexical.length
      : response.tags.length + response.items.length;
  const quotaNear = SEARCH_FIRST_PAGE_NEAR_MAX;

  return mergePrimarySnapshotResponse(state, {
    gen: params.gen,
    qn: params.qn,
    scope: response.scope,
    limit: response.limit,
    tags: response.tags,
    items: response.items,
    near: response.near,
    semantic: response.semantic,
    semanticReason: response.semantic_reason,
    quota: {
      tag: response.tags.length,
      lexical: lexicalCount,
      near: quotaNear,
    },
    nearClipLimit: lexicalCount + quotaNear,
    hasMore: response.next_cursor !== null,
    nextCursor: response.next_cursor,
    generation: response.generation,
    source: 'search',
    isPartial: false,
    hasCompleteSnapshotForGen: hasCompleteSearchSnapshotForGen,
    expectSemantic: params.expectSemantic,
  });
}

/**
 * Applies a cursor page ("Xem thêm") of `GET /search` per OpenAPI `/search` description and SPEC §6.8 (FE-C21):
 * - Appends `items` (or `tags` when `scope === 'tag'`) in server order, deduplicating by `(kind, id)`
 *   against existing `lexical` rows (and stripping any newly lexical-matched `(kind, id)` from `near` if needed,
 *   while preserving page-1 `near`, `nearState`, and `generation`).
 * - Never interprets `semantic: false` / `near: []` / `semantic_reason: "request_lexical"` on a cursor page
 *   as `'degraded'` or `'off'`.
 */
export function applySearchCursorPageResponse(
  state: SuggestMergeState,
  params: {
    readonly gen: number;
    readonly response: SearchResponse;
  },
): SuggestMergeState {
  if (params.gen !== state.queryGen || !state.snapshot || state.snapshot.gen !== params.gen) {
    return state;
  }

  const currentSnapshot = state.snapshot;
  const { response } = params;
  const incomingRows: readonly SuggestRow[] =
    currentSnapshot.scope === 'tag' ? response.tags : response.items;

  const seenLexical = new Set<SuggestActiveKey>();
  for (const row of currentSnapshot.lexical) {
    seenLexical.add(getRowKey(row));
  }

  const appendedLexical: SuggestRow[] = [...currentSnapshot.lexical];
  for (const row of incomingRows) {
    const key = getRowKey(row);
    if (seenLexical.has(key)) continue;
    seenLexical.add(key);
    appendedLexical.push(row);
  }

  // Keep page-1 `near` rows (filtering out any item/tag that just appeared in the new lexical page)
  // and preserve page-1 `nearState` & `generation` untouched.
  const preservedNear = currentSnapshot.near.filter((row) => !seenLexical.has(getRowKey(row)));

  return {
    ...state,
    isBusy: false,
    snapshot: {
      ...currentSnapshot,
      lexical: appendedLexical,
      near: preservedNear,
      nearState: currentSnapshot.nearState,
      hasMore: response.next_cursor !== null,
      nextCursor: response.next_cursor,
      generation: currentSnapshot.generation,
    },
    activeClearedFromNear: false,
  };
}

/**
 * Handles a failed, rate-limited, or aborted `semantic=1` leg for `gen` (RV-T9-FE1-4, RV-T9-FE2-1):
 * - When a complete server snapshot for `gen` already exists in `'pending'`, transitions `nearState`
 *   to `'idle'` (abort) or `'degraded'` (failure/429).
 * - When no complete server snapshot for `gen` exists yet, records `semanticLegOutcome` for `gen`
 *   so the later complete lexical response consumes it and never stays stuck at `'pending'`.
 * - Ignores stale `gen !== state.queryGen`.
 */
export function applySemanticLegFailed(
  state: SuggestMergeState,
  params: { readonly gen?: number; readonly aborted?: boolean } = {},
): SuggestMergeState {
  const targetGen = params.gen ?? state.queryGen;
  if (targetGen !== state.queryGen) {
    return state;
  }

  const nextPendingNear =
    state.pendingNear && state.pendingNear.gen === targetGen ? null : state.pendingNear;
  const outcomeKind: SemanticLegOutcome['kind'] = params.aborted ? 'aborted' : 'failed';

  const hasCompleteServerSnapshotForGen =
    state.snapshot !== null &&
    state.snapshot.gen === targetGen &&
    state.snapshot.source !== 'tag-cache';

  if (!hasCompleteServerSnapshotForGen) {
    return {
      ...state,
      pendingNear: nextPendingNear,
      semanticLegOutcome: {
        gen: targetGen,
        kind: outcomeKind,
      },
    };
  }

  if (state.snapshot!.nearState !== 'pending') {
    return {
      ...state,
      pendingNear: nextPendingNear,
      semanticLegOutcome: null,
    };
  }

  const nextNearState: NearZoneState = outcomeKind === 'aborted' ? 'idle' : 'degraded';
  return {
    ...state,
    pendingNear: nextPendingNear,
    semanticLegOutcome: null,
    snapshot: {
      ...state.snapshot!,
      nearState: nextNearState,
    },
    activeClearedFromNear: false,
  };
}

/**
 * Handles toggling `≈` OFF (plan mục 2.8 rule 4, RV-T9-FE1-5, RV-T9-FE2-2):
 * - Durably sets `semanticEnabled = false` and clears `pendingNear` / `semanticLegOutcome` (even when `snapshot === null`)
 *   so any in-flight `semantic=1` response or subsequent `start_query(expectSemantic: true)` cannot re-show `near`.
 * - Removes only the `near` zone (`near = []`, `nearState = 'off'`), keeping `lexical` untouched.
 * - If `activeKey` was inside `near`, resets `activeKey = null` and sets `activeClearedFromNear = true`.
 */
export function applyToggleSemanticOff(state: SuggestMergeState): SuggestMergeState {
  if (!state.snapshot) {
    return {
      ...state,
      expectSemantic: false,
      pendingNear: null,
      semanticLegOutcome: null,
      semanticEnabled: false,
      activeClearedFromNear: false,
    };
  }

  const wasActiveInNear =
    state.activeKey !== null &&
    state.snapshot.near.some((row) => getRowKey(row) === state.activeKey);

  return {
    ...state,
    expectSemantic: false,
    pendingNear: null,
    semanticLegOutcome: null,
    semanticEnabled: false,
    snapshot: {
      ...state.snapshot,
      near: [],
      nearState: 'off',
    },
    activeKey: wasActiveInNear ? null : state.activeKey,
    activeClearedFromNear: wasActiveInNear,
  };
}

/**
 * Marks `semanticEnabled = true` and `nearState = 'pending'` when toggling `≈` ON
 * for a clean query that re-issues `semantic=1`.
 * Note: Task 17 must only dispatch this when re-issuing `semantic=1` on a clean draft
 * (for an unclean draft, use `sync_semantic_enabled` after the settings PATCH succeeds).
 */
export function applyToggleSemanticOnPending(state: SuggestMergeState): SuggestMergeState {
  if (!state.snapshot) {
    return {
      ...state,
      expectSemantic: true,
      semanticLegOutcome: null,
      semanticEnabled: true,
      activeClearedFromNear: false,
    };
  }
  return {
    ...state,
    expectSemantic: true,
    semanticLegOutcome: null,
    semanticEnabled: true,
    snapshot: {
      ...state.snapshot,
      nearState: 'pending',
    },
    activeClearedFromNear: false,
  };
}

/**
 * Synchronizes the durable `semanticEnabled` flag from `Me.settings.semantic_suggest` (RV-T9-FE2-2).
 * When `enabled` is `false`, delegates to `applyToggleSemanticOff` so any visible `near` rows are cleared.
 * When `enabled` is `true`, updates `semanticEnabled = true` and moves a snapshot's `'off'` state back to `'idle'`
 * without forcing `'pending'` when no `semantic=1` request is in flight.
 */
export function applySyncSemanticEnabled(
  state: SuggestMergeState,
  enabled: boolean,
): SuggestMergeState {
  if (!enabled) {
    return applyToggleSemanticOff(state);
  }
  if (state.semanticEnabled) {
    return state;
  }
  if (!state.snapshot) {
    return {
      ...state,
      semanticEnabled: true,
      activeClearedFromNear: false,
    };
  }
  return {
    ...state,
    semanticEnabled: true,
    snapshot:
      state.snapshot.nearState === 'off'
        ? {
            ...state.snapshot,
            nearState: 'idle',
          }
        : state.snapshot,
    activeClearedFromNear: false,
  };
}

/**
 * Handles gate closing mid-typing (colon lock, taint, multi-line, > 200 runes)
 * per plan mục 2.24 items 2 & 10 and SPEC §3.5 rule 11:
 * - Outside `#` mode (`keepLocalTagCache = false`): clears `snapshot = null`, `localTagRows = []`,
 *   `activeKey = null`, `isBusy = false`, `dropdownOpen = false`.
 * - In `#` mode (`keepLocalTagCache = true`, FE-C20): keeps `localTagRows` visible in the dropdown
 *   (if any), removes server snapshot rows, and resets `activeKey = null` so Enter does not open a stale row.
 */
export function applyGateClose(
  state: SuggestMergeState,
  opts: { readonly keepLocalTagCache?: boolean } = {},
): SuggestMergeState {
  const nextGen = state.queryGen + 1;
  if (opts.keepLocalTagCache) {
    const keptLocal = state.localTagRows;
    const localSnapshot: SuggestSnapshot | null =
      keptLocal.length > 0
        ? {
            gen: nextGen,
            qn: state.pendingQn,
            scope: 'tag',
            limit: state.pendingLimit,
            lexical: keptLocal,
            near: [],
            nearState: 'idle',
            quota: { tag: state.pendingLimit, lexical: state.pendingLimit, near: 0 },
            hasMore: false,
            nextCursor: null,
            generation: null,
            source: 'tag-cache',
          }
        : null;

    return {
      ...state,
      queryGen: nextGen,
      expectSemantic: false,
      pendingNear: null,
      semanticLegOutcome: null,
      isBusy: false,
      dropdownOpen: keptLocal.length > 0,
      snapshot: localSnapshot,
      activeKey: null,
      activeClearedFromNear: false,
    };
  }

  return {
    ...state,
    queryGen: nextGen,
    expectSemantic: false,
    pendingNear: null,
    semanticLegOutcome: null,
    isBusy: false,
    dropdownOpen: false,
    snapshot: null,
    localTagRows: [],
    activeKey: null,
    activeClearedFromNear: false,
  };
}

/**
 * Returns all navigable `(kind, id)` row keys in display order:
 * lexical (`tags` then `items`) followed by `near`.
 */
export function getVisibleRowKeys(snapshot: SuggestSnapshot | null): SuggestActiveKey[] {
  if (!snapshot) return [];
  const keys: SuggestActiveKey[] = [];
  for (const row of snapshot.lexical) {
    keys.push(getRowKey(row));
  }
  for (const row of snapshot.near) {
    keys.push(getRowKey(row));
  }
  return keys;
}

/**
 * Moves `activeKey` up/down relative to the current `activeKey` in `snapshot` (plan mục 2.8 rule 5:
 * "`↑↓` tính theo `activeKey` tại lúc bấm").
 */
export function moveActiveRowKey(
  state: SuggestMergeState,
  direction: 'next' | 'prev',
): SuggestMergeState {
  const keys = getVisibleRowKeys(state.snapshot);
  if (keys.length === 0) {
    return { ...state, activeKey: null, activeClearedFromNear: false };
  }

  const currentIndex = state.activeKey ? keys.indexOf(state.activeKey) : -1;
  let nextIndex: number;
  if (currentIndex === -1) {
    nextIndex = direction === 'next' ? 0 : keys.length - 1;
  } else if (direction === 'next') {
    nextIndex = (currentIndex + 1) % keys.length;
  } else {
    nextIndex = (currentIndex - 1 + keys.length) % keys.length;
  }

  return {
    ...state,
    activeKey: keys[nextIndex] ?? null,
    activeClearedFromNear: false,
  };
}

/**
 * Pure reducer entry point for `SuggestMergeState`.
 */
export function suggestMergeReducer(
  state: SuggestMergeState,
  action: SuggestMergeAction,
): SuggestMergeState {
  switch (action.type) {
    case 'start_query':
      return startNewQueryGen(state, action);
    case 'seed_tag_cache':
      return seedTagModeCacheRows(state, action);
    case 'receive_suggest':
      return applySuggestResponse(state, action);
    case 'receive_search_first_page':
      return applySearchFirstPageResponse(state, action);
    case 'receive_search_cursor_page':
      return applySearchCursorPageResponse(state, action);
    case 'semantic_leg_failed':
      return applySemanticLegFailed(state, action);
    case 'toggle_semantic_off':
      return applyToggleSemanticOff(state);
    case 'toggle_semantic_on_pending':
      return applyToggleSemanticOnPending(state);
    case 'sync_semantic_enabled':
      return applySyncSemanticEnabled(state, action.enabled);
    case 'set_active_key':
      return { ...state, activeKey: action.activeKey, activeClearedFromNear: false };
    case 'move_active':
      return moveActiveRowKey(state, action.direction);
    case 'close_gate':
      return applyGateClose(state, { keepLocalTagCache: action.keepLocalTagCache });
    case 'reset':
      return {
        ...createInitialMergeState(),
        queryGen: state.queryGen + 1,
        semanticEnabled: state.semanticEnabled,
      };
  }
}
