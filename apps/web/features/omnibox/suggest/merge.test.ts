import { waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SearchResponse, SuggestItem, SuggestResponse, SuggestTag } from '@/lib/api/search';
import {
  applyGateClose,
  applySearchCursorPageResponse,
  applySearchFirstPageResponse,
  applySuggestResponse,
  applyToggleSemanticOff,
  createInitialMergeState,
  getRowKey,
  moveActiveRowKey,
  seedTagModeCacheRows,
  startNewQueryGen,
  suggestMergeReducer,
} from './merge';

function makeTag(id: string, display: string, match: SuggestTag['match'] = 'prefix'): SuggestTag {
  return {
    kind: 'tag',
    id,
    display,
    item_count: 3,
    last_used_at: '2026-11-02T00:00:00Z',
    match,
  };
}

function makeItem(id: string, name: string, match: SuggestItem['match'] = 'prefix'): SuggestItem {
  return {
    kind: 'item',
    id,
    name,
    entry_count: 2,
    created_at: '2026-11-02T00:00:00Z',
    last_used_at: '2026-11-02T00:00:00Z',
    tags: [],
    tag_total: 0,
    match,
  };
}

function makeSuggestResponse(overrides: Partial<SuggestResponse> = {}): SuggestResponse {
  return {
    scope: 'all',
    limit: 8,
    mode: 'full',
    quota: { tag: 3, lexical: 6, near: 2 },
    tags: [],
    items: [],
    has_more: false,
    lexical_partial: [],
    semantic: false,
    semantic_reason: 'request_lexical',
    near: [],
    generation: null,
    ...overrides,
  };
}

describe('features/omnibox/suggest/merge', () => {
  it('late semantic appends without touching lexical', async () => {
    const tag1 = makeTag('t1', 'nhà');
    const item1 = makeItem('i1', 'wifi phòng khách');
    const item2 = makeItem('i2', 'wifi sân thượng');
    const nearDup = makeItem('i1', 'wifi phòng khách', 'semantic');
    const near1 = makeTag('t2', 'mạng', 'semantic');
    const near2 = makeItem('i3', 'router tổng', 'semantic');
    const near3 = makeItem('i4', 'cáp quang', 'semantic');

    let state = createInitialMergeState();
    state = startNewQueryGen(state, { qn: 'wifi', scope: 'all', limit: 8 });
    const gen = state.queryGen;

    // 1. Lexical response (semantic=0) arrives first
    state = applySuggestResponse(state, {
      gen,
      qn: 'wifi',
      expectSemantic: true,
      response: makeSuggestResponse({
        tags: [tag1],
        items: [item1, item2],
        quota: { tag: 3, lexical: 6, near: 2 },
        semantic: false,
        semantic_reason: 'request_lexical',
      }),
    });

    const lexicalRefBefore = state.snapshot!.lexical;
    expect(lexicalRefBefore).toEqual([tag1, item1, item2]);
    expect(state.snapshot!.near).toEqual([]);
    expect(state.snapshot!.nearState).toBe('pending');

    // User selects item1 before semantic response arrives
    state = suggestMergeReducer(state, { type: 'set_active_key', activeKey: 'item:i1' });

    // 2. Late semantic response (semantic=1) arrives asynchronously (plan L13: real timers + waitFor)
    const lateDelivery = Promise.withResolvers<void>();
    setTimeout(() => {
      state = applySuggestResponse(state, {
        gen,
        qn: 'wifi',
        response: makeSuggestResponse({
          tags: [makeTag('t99', 'ignored-lexical-tag')],
          items: [makeItem('i99', 'ignored-lexical-item')],
          quota: { tag: 3, lexical: 6, near: 2 },
          semantic: true,
          semantic_reason: null,
          near: [nearDup, near1, near2, near3],
          generation: 1,
        }),
      });
      lateDelivery.resolve();
    }, 10);
    await lateDelivery.promise;
    await waitFor(() => {
      expect(state.snapshot!.nearState).toBe('shown');
    });

    // Lexical array reference and elements are strictly untouched; near is deduped and clipped to quota.near (2)
    expect(state.snapshot!.lexical).toBe(lexicalRefBefore);
    expect(state.snapshot!.lexical).toEqual([tag1, item1, item2]);
    expect(state.snapshot!.near).toEqual([near1, near2]);
    expect(state.activeKey).toBe('item:i1');
  });

  it('first complete response defines snapshot regardless of semantic flag', () => {
    const tag1 = makeTag('t1', 'nhà');
    const item1 = makeItem('i1', 'wifi');
    const near1 = makeItem('i2', 'router', 'semantic');

    let state = createInitialMergeState();
    state = startNewQueryGen(state, { qn: 'wifi', scope: 'all', limit: 8 });
    const gen = state.queryGen;

    // `semantic=1` finishes BEFORE `semantic=0` (e.g. query embedding cache hit on server)
    state = applySuggestResponse(state, {
      gen,
      qn: 'wifi',
      expectSemantic: true,
      response: makeSuggestResponse({
        tags: [tag1],
        items: [item1],
        quota: { tag: 3, lexical: 6, near: 2 },
        semantic: true,
        semantic_reason: null,
        near: [near1],
        generation: 1,
      }),
    });

    const lexicalRef = state.snapshot!.lexical;
    expect(lexicalRef).toEqual([tag1, item1]);
    expect(state.snapshot!.near).toEqual([near1]);
    expect(state.snapshot!.nearState).toBe('shown');

    // Late `semantic=0` arrives afterwards -> ignored, does not overwrite lexical or clear near
    state = applySuggestResponse(state, {
      gen,
      qn: 'wifi',
      response: makeSuggestResponse({
        tags: [tag1],
        items: [item1],
        semantic: false,
        semantic_reason: 'request_lexical',
        near: [],
      }),
    });

    expect(state.snapshot!.lexical).toBe(lexicalRef);
    expect(state.snapshot!.near).toEqual([near1]);
    expect(state.snapshot!.nearState).toBe('shown');
  });

  it('partial-first response never defines snapshot', () => {
    const prevItem = makeItem('i-prev', 'previous row');
    let state = createInitialMergeState();
    state = startNewQueryGen(state, { qn: 'wi', scope: 'all', limit: 8 });
    state = applySuggestResponse(state, {
      gen: state.queryGen,
      qn: 'wi',
      response: makeSuggestResponse({ items: [prevItem] }),
    });
    expect(state.snapshot!.lexical).toEqual([prevItem]);

    // Next query generation starts
    state = startNewQueryGen(state, { qn: 'wifi', scope: 'all', limit: 8 });
    const gen2 = state.queryGen;

    // First response for gen2 has `lexical_partial: ['item']` -> MUST NOT define or replace snapshot
    const partialItem = makeItem('i-partial', 'partial item');
    state = applySuggestResponse(state, {
      gen: gen2,
      qn: 'wifi',
      expectSemantic: true,
      response: makeSuggestResponse({
        items: [partialItem],
        lexical_partial: ['item'],
      }),
    });

    expect(state.snapshot!.gen).toBe(1);
    expect(state.snapshot!.lexical).toEqual([prevItem]);

    // Second response for gen2 is complete -> defines gen2 snapshot
    const completeItem = makeItem('i-complete', 'complete item');
    const nearItem = makeItem('i-near', 'near item', 'semantic');
    state = applySuggestResponse(state, {
      gen: gen2,
      qn: 'wifi',
      response: makeSuggestResponse({
        items: [completeItem],
        lexical_partial: [],
        semantic: true,
        semantic_reason: null,
        near: [nearItem],
      }),
    });

    expect(state.snapshot!.gen).toBe(gen2);
    expect(state.snapshot!.lexical).toEqual([completeItem]);
    expect(state.snapshot!.near).toEqual([nearItem]);
  });

  it('no complete response keeps previous rows', () => {
    const prevItem = makeItem('i-prev', 'kept item');
    let state = createInitialMergeState();
    state = startNewQueryGen(state, { qn: 'wi', scope: 'all', limit: 8 });
    state = applySuggestResponse(state, {
      gen: state.queryGen,
      qn: 'wi',
      response: makeSuggestResponse({ items: [prevItem] }),
    });
    state = suggestMergeReducer(state, { type: 'set_active_key', activeKey: 'item:i-prev' });

    // Gen 2 receives only partial responses
    state = startNewQueryGen(state, { qn: 'wifi', scope: 'all', limit: 8 });
    state = applySuggestResponse(state, {
      gen: state.queryGen,
      qn: 'wifi',
      response: makeSuggestResponse({
        items: [makeItem('i-dropped', 'dropped')],
        lexical_partial: ['tag'],
      }),
    });

    expect(state.snapshot!.gen).toBe(1);
    expect(state.snapshot!.lexical).toEqual([prevItem]);
    expect(state.activeKey).toBe('item:i-prev');
    expect(state.isBusy).toBe(false);
  });

  it('tag mode cached rows replaced by server rows keeping activeKey', () => {
    let state = createInitialMergeState();
    state = startNewQueryGen(state, { qn: 'nh', scope: 'tag', limit: 8 });
    const gen = state.queryGen;

    // Cached rows show immediately with first row active (rule 7)
    state = seedTagModeCacheRows(state, {
      qn: 'nh',
      limit: 8,
      tags: [
        {
          id: 't1',
          display: 'nhà',
          item_count: 5,
          last_used_at: '2026-11-02T00:00:00Z',
          created_at: '2026-11-02T00:00:00Z',
        },
        {
          id: 't2',
          display: 'nháp',
          item_count: 2,
          last_used_at: '2026-11-02T00:00:00Z',
          created_at: '2026-11-02T00:00:00Z',
        },
      ],
    });

    expect(state.activeKey).toBe('tag:t1');
    expect(state.snapshot!.source).toBe('tag-cache');

    // User moves selection to `tag:t2`
    state = moveActiveRowKey(state, 'next');
    expect(state.activeKey).toBe('tag:t2');

    // Server `scope=tag` response arrives containing `t2` and `t3` -> replaces cached rows and keeps `tag:t2`
    const serverT2 = makeTag('t2', 'nháp');
    const serverT3 = makeTag('t3', 'nhân sự');
    state = applySuggestResponse(state, {
      gen,
      qn: 'nh',
      response: makeSuggestResponse({
        scope: 'tag',
        tags: [serverT3, serverT2],
        items: [],
      }),
    });

    expect(state.snapshot!.source).toBe('suggest');
    expect(state.snapshot!.lexical).toEqual([serverT3, serverT2]);
    expect(state.activeKey).toBe('tag:t2');

    // If a subsequent server response in `#` mode no longer has `tag:t2`, falls back to first row
    state = startNewQueryGen(state, { qn: 'nha', scope: 'tag', limit: 8 });
    state = applySuggestResponse(state, {
      gen: state.queryGen,
      qn: 'nha',
      response: makeSuggestResponse({
        scope: 'tag',
        tags: [serverT3],
        items: [],
      }),
    });
    expect(state.activeKey).toBe('tag:t3');
  });

  it('stale gen dropped', async () => {
    const itemGen1 = makeItem('i1', 'gen1 item');
    const itemGen2 = makeItem('i2', 'gen2 item');

    let state = createInitialMergeState();
    state = startNewQueryGen(state, { qn: 'wi', scope: 'all', limit: 8 });
    const gen1 = state.queryGen;

    state = startNewQueryGen(state, { qn: 'wifi', scope: 'all', limit: 8 });
    const gen2 = state.queryGen;

    state = applySuggestResponse(state, {
      gen: gen2,
      qn: 'wifi',
      response: makeSuggestResponse({ items: [itemGen2] }),
    });
    expect(state.snapshot!.lexical).toEqual([itemGen2]);

    // Late gen1 response arrives asynchronously (plan L13: real timers + waitFor) -> dropped
    const staleDelivery = Promise.withResolvers<void>();
    setTimeout(() => {
      state = applySuggestResponse(state, {
        gen: gen1,
        qn: 'wi',
        response: makeSuggestResponse({ items: [itemGen1] }),
      });
      staleDelivery.resolve();
    }, 10);
    await staleDelivery.promise;
    await waitFor(() => {
      expect(state.snapshot!.gen).toBe(gen2);
    });
    expect(state.snapshot!.gen).toBe(gen2);
    expect(state.snapshot!.lexical).toEqual([itemGen2]);
  });

  it('toggle off removes only near', () => {
    const item1 = makeItem('i1', 'wifi');
    const near1 = makeItem('i2', 'router', 'semantic');

    let state = createInitialMergeState();
    state = startNewQueryGen(state, { qn: 'wifi', scope: 'all', limit: 8 });
    state = applySuggestResponse(state, {
      gen: state.queryGen,
      qn: 'wifi',
      response: makeSuggestResponse({
        items: [item1],
        semantic: true,
        semantic_reason: null,
        near: [near1],
      }),
    });

    const lexicalRef = state.snapshot!.lexical;
    // Select near row then toggle off -> activeKey becomes null and activeClearedFromNear is true
    state = suggestMergeReducer(state, { type: 'set_active_key', activeKey: getRowKey(near1) });
    state = applyToggleSemanticOff(state);

    expect(state.snapshot!.lexical).toBe(lexicalRef);
    expect(state.snapshot!.near).toEqual([]);
    expect(state.snapshot!.nearState).toBe('off');
    expect(state.activeKey).toBeNull();
    expect(state.activeClearedFromNear).toBe(true);
  });

  it('selection follows (kind,id)', () => {
    const tag1 = makeTag('t1', 'nhà');
    const item1 = makeItem('i1', 'wifi');
    const item2 = makeItem('i2', 'wifi khách');
    const near1 = makeItem('i3', 'router', 'semantic');

    let state = createInitialMergeState();
    state = startNewQueryGen(state, { qn: 'wi', scope: 'all', limit: 8 });
    state = applySuggestResponse(state, {
      gen: state.queryGen,
      qn: 'wi',
      response: makeSuggestResponse({
        tags: [tag1],
        items: [item1, item2],
        semantic: true,
        semantic_reason: null,
        near: [near1],
      }),
    });

    // Keyboard navigation moves across tag -> item -> near in order
    state = moveActiveRowKey(state, 'next');
    expect(state.activeKey).toBe('tag:t1');
    state = moveActiveRowKey(state, 'next');
    expect(state.activeKey).toBe('item:i1');
    state = moveActiveRowKey(state, 'next');
    expect(state.activeKey).toBe('item:i2');
    state = moveActiveRowKey(state, 'next');
    expect(state.activeKey).toBe('item:i3');

    // When a new generation reorders `item2` to index 0, `activeKey = 'item:i2'` stays on `item:i2`
    state = suggestMergeReducer(state, { type: 'set_active_key', activeKey: 'item:i2' });
    state = startNewQueryGen(state, { qn: 'wifi', scope: 'all', limit: 8 });
    state = applySuggestResponse(state, {
      gen: state.queryGen,
      qn: 'wifi',
      response: makeSuggestResponse({
        tags: [],
        items: [item2, item1],
      }),
    });
    expect(state.activeKey).toBe('item:i2');

    // When a new generation drops `item:i2` (in search mode), `activeKey` becomes `null` (never auto-activates first row)
    state = startNewQueryGen(state, { qn: 'wifix', scope: 'all', limit: 8 });
    state = applySuggestResponse(state, {
      gen: state.queryGen,
      qn: 'wifix',
      response: makeSuggestResponse({
        tags: [],
        items: [item1],
      }),
    });
    expect(state.activeKey).toBeNull();
  });

  it('colon after `#home` clears active row while keeping local tag-cache rows, and pasting into `wifi` closes dropdown (2.24 items 2 & 10)', () => {
    // 1. `#` mode: cached tag rows + server rows -> user types `:` (`#home:`) -> gate closes with keepLocalTagCache=true
    let tagState = createInitialMergeState();
    tagState = startNewQueryGen(tagState, { qn: 'home', scope: 'tag', limit: 8 });
    const cachedHome = makeTag('t-home', 'home');
    const serverHomeExtra = makeTag('t-home-2', 'home-lab');
    tagState = seedTagModeCacheRows(tagState, {
      qn: 'home',
      tags: [cachedHome],
    });
    expect(tagState.activeKey).toBe('tag:t-home');

    tagState = applySuggestResponse(tagState, {
      gen: tagState.queryGen,
      qn: 'home',
      response: makeSuggestResponse({
        scope: 'tag',
        tags: [cachedHome, serverHomeExtra],
      }),
    });
    expect(tagState.snapshot!.lexical).toEqual([cachedHome, serverHomeExtra]);
    expect(tagState.activeKey).toBe('tag:t-home');

    // Gate closes in `#` mode (`#home:`): keeps local tag-cache rows, drops server rows, resets activeKey=null
    tagState = applyGateClose(tagState, { keepLocalTagCache: true });
    expect(tagState.dropdownOpen).toBe(true);
    expect(tagState.snapshot!.source).toBe('tag-cache');
    expect(tagState.snapshot!.lexical).toEqual([cachedHome]);
    expect(tagState.activeKey).toBeNull();

    // 2. Search mode (`wifi`): open dropdown -> user pastes -> gate closes with keepLocalTagCache=false -> closes dropdown & clears snapshot
    let searchState = createInitialMergeState();
    searchState = startNewQueryGen(searchState, { qn: 'wifi', scope: 'all', limit: 8 });
    searchState = applySuggestResponse(searchState, {
      gen: searchState.queryGen,
      qn: 'wifi',
      response: makeSuggestResponse({
        items: [makeItem('i1', 'wifi')],
      }),
    });
    expect(searchState.dropdownOpen).toBe(true);
    expect(searchState.snapshot).not.toBeNull();

    searchState = applyGateClose(searchState, { keepLocalTagCache: false });
    expect(searchState.dropdownOpen).toBe(false);
    expect(searchState.snapshot).toBeNull();
    expect(searchState.activeKey).toBeNull();
    expect(searchState.isBusy).toBe(false);
  });

  it('cursor page merge ("Xem thêm") appends deduplicated lexical rows and keeps page-1 near and nearState (SPEC §6.8 / FE-C21)', () => {
    const tag1 = makeTag('t1', 'nhà');
    const item1 = makeItem('i1', 'wifi 1');
    const item2 = makeItem('i2', 'wifi 2');
    const item3 = makeItem('i3', 'wifi 3');
    const near1 = makeItem('n1', 'router gần nghĩa', 'semantic');

    let state = createInitialMergeState();
    state = startNewQueryGen(state, { qn: 'wifi', scope: 'all', limit: 20 });
    const gen = state.queryGen;

    const page1: SearchResponse = {
      scope: 'all',
      limit: 20,
      mode: 'full',
      tags: [tag1],
      items: [item1, item2],
      next_cursor: 'cursor-page-2',
      semantic: true,
      semantic_reason: null,
      near: [near1],
      generation: 3,
    };

    state = applySearchFirstPageResponse(state, {
      gen,
      qn: 'wifi',
      response: page1,
    });

    expect(state.snapshot!.lexical).toEqual([tag1, item1, item2]);
    expect(state.snapshot!.near).toEqual([near1]);
    expect(state.snapshot!.nearState).toBe('shown');
    expect(state.snapshot!.nextCursor).toBe('cursor-page-2');

    // Cursor page 2 arrives with `semantic: false, semantic_reason: 'request_lexical', near: []`
    // and includes a duplicate `item2` (e.g. `last_used_at` shifted) plus `item3`.
    const page2: SearchResponse = {
      scope: 'all',
      limit: 20,
      mode: 'full',
      tags: [],
      items: [item2, item3],
      next_cursor: null,
      semantic: false,
      semantic_reason: 'request_lexical',
      near: [],
      generation: null,
    };

    state = applySearchCursorPageResponse(state, {
      gen,
      response: page2,
    });

    expect(state.snapshot!.lexical).toEqual([tag1, item1, item2, item3]);
    expect(state.snapshot!.near).toEqual([near1]);
    expect(state.snapshot!.nearState).toBe('shown');
    expect(state.snapshot!.generation).toBe(3);
    expect(state.snapshot!.hasMore).toBe(false);
    expect(state.snapshot!.nextCursor).toBeNull();
  });
});
