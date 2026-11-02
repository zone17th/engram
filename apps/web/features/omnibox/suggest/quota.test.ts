import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  QUOTA_CONTRACT,
  SEARCH_ALL_SCOPE_FIRST_PAGE_TAGS_MAX,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_FIRST_PAGE_NEAR_MAX,
  SEARCH_LIMITS,
  SUGGEST_DEFAULT_LIMIT,
  SUGGEST_LIMITS,
  SUGGEST_MOBILE_LIMIT,
  SUGGEST_QUOTA_TABLE,
  computeClientNearCap,
  computeSuggestSlotUsage,
  getSuggestQuotaRow,
  type QuotaContract,
} from './quota';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const QUOTA_FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../../../packages/search-fixtures/quota.json',
);

interface RawQuotaFixture extends QuotaContract {
  readonly $comment?: string;
}

function loadQuotaFixture(): RawQuotaFixture {
  const raw = fs.readFileSync(QUOTA_FIXTURE_PATH, 'utf-8');
  return JSON.parse(raw) as RawQuotaFixture;
}

describe('features/omnibox/suggest/quota', () => {
  it('TS table equals quota.json', () => {
    const fixture = loadQuotaFixture();

    expect(QUOTA_CONTRACT.version).toBe(fixture.version);
    expect(QUOTA_CONTRACT.schema).toBe(fixture.schema);
    expect(SUGGEST_LIMITS).toEqual(fixture.suggest.limits);
    expect(SUGGEST_DEFAULT_LIMIT).toBe(fixture.suggest.default_limit);
    expect(SUGGEST_MOBILE_LIMIT).toBe(fixture.suggest.mobile_limit);
    expect(SUGGEST_QUOTA_TABLE).toHaveLength(fixture.suggest.table.length);

    for (let i = 0; i < fixture.suggest.table.length; i += 1) {
      const expected = fixture.suggest.table[i]!;
      const actual = SUGGEST_QUOTA_TABLE[i]!;
      expect(actual).toEqual({
        scope: expected.scope,
        limit: expected.limit,
        tag_max: expected.tag_max,
        lex_max: expected.lex_max,
        near_base: expected.near_base,
        near_max_cap: expected.near_max_cap,
        recent_tag: expected.recent_tag,
        recent_item: expected.recent_item,
      });
      expect(getSuggestQuotaRow(expected.scope, expected.limit)).toEqual(actual);
    }

    expect(SEARCH_LIMITS).toEqual(fixture.search.limits);
    expect(SEARCH_DEFAULT_LIMIT).toBe(fixture.search.default_limit);
    expect(SEARCH_ALL_SCOPE_FIRST_PAGE_TAGS_MAX).toBe(
      fixture.search.all_scope_first_page_tags_max,
    );
    expect(SEARCH_FIRST_PAGE_NEAR_MAX).toBe(fixture.search.first_page_near_max);
  });

  it('computes prefix/full and recent slot usage and effective wire quota.near per 2.4 + 2.24 item 5', () => {
    // Full lexical hits: tags=3, items=3 -> tags_used=3, items_used=3, quota.near=2
    const fullLex = computeSuggestSlotUsage({
      scope: 'all',
      limit: 8,
      mode: 'full',
      tagHits: 5,
      itemHits: 5,
      nearHitsAfterDedup: 4,
    });
    expect(fullLex).toEqual({
      tagsUsed: 3,
      itemsUsed: 3,
      nearUsed: 2,
      quota: { tag: 3, lexical: 6, near: 2 },
    });

    // Partial lexical hits: tags=1, items=2 -> unused lex = 3 -> quota.near = min(3, 2 + 3) = 3
    const partialLex = computeSuggestSlotUsage({
      scope: 'all',
      limit: 8,
      mode: 'prefix',
      tagHits: 1,
      itemHits: 2,
      nearHitsAfterDedup: 5,
    });
    expect(partialLex).toEqual({
      tagsUsed: 1,
      itemsUsed: 2,
      nearUsed: 3,
      quota: { tag: 3, lexical: 6, near: 3 },
    });

    // Recent mode: near=0, lexical=limit
    const recentAll = computeSuggestSlotUsage({
      scope: 'all',
      limit: 8,
      mode: 'recent',
      tagHits: 10,
      itemHits: 10,
      nearHitsAfterDedup: 5,
    });
    expect(recentAll).toEqual({
      tagsUsed: 3,
      itemsUsed: 5,
      nearUsed: 0,
      quota: { tag: 3, lexical: 8, near: 0 },
    });

    expect(computeClientNearCap(3, 8, 6)).toBe(2);
    expect(computeClientNearCap(2, 8, 3)).toBe(2);
    expect(computeClientNearCap(2, 5, 5)).toBe(0);
  });
});
