import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SEARCH_ALL_SCOPE_FIRST_PAGE_TAGS_MAX,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_FIRST_PAGE_NEAR_MAX,
  SEARCH_LIMITS,
  SUGGEST_DEFAULT_LIMIT,
  SUGGEST_LIMITS,
  SUGGEST_MOBILE_LIMIT,
  SUGGEST_QUOTA_TABLE,
  computeClientNearCap,
  type SuggestQuotaTableRow,
} from './quota';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const QUOTA_FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../../../packages/search-fixtures/quota.json',
);

interface RawQuotaFixture {
  readonly version: 1;
  readonly schema: 'engram-search-quota-v1';
  readonly suggest: {
    readonly limits: readonly number[];
    readonly default_limit: number;
    readonly mobile_limit: number;
    readonly table: readonly SuggestQuotaTableRow[];
  };
  readonly search: {
    readonly limits: readonly number[];
    readonly default_limit: number;
    readonly all_scope_first_page_tags_max: number;
    readonly first_page_near_max: number;
  };
  readonly $comment?: string;
}
function loadQuotaFixture(): RawQuotaFixture {
  const raw = fs.readFileSync(QUOTA_FIXTURE_PATH, 'utf-8');
  return JSON.parse(raw) as RawQuotaFixture;
}

describe('features/omnibox/suggest/quota', () => {
  it('TS table equals quota.json', () => {
    const fixture = loadQuotaFixture();

    expect(fixture.version).toBe(1);
    expect(fixture.schema).toBe('engram-search-quota-v1');
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
    }

    expect(SEARCH_LIMITS).toEqual(fixture.search.limits);
    expect(SEARCH_DEFAULT_LIMIT).toBe(fixture.search.default_limit);
    expect(SEARCH_ALL_SCOPE_FIRST_PAGE_TAGS_MAX).toBe(
      fixture.search.all_scope_first_page_tags_max,
    );
    expect(SEARCH_FIRST_PAGE_NEAR_MAX).toBe(fixture.search.first_page_near_max);
  });

  it('computes client near cap per min(quota.near, limit - lexical.length)', () => {
    expect(computeClientNearCap(3, 8, 6)).toBe(2);
    expect(computeClientNearCap(2, 8, 3)).toBe(2);
    expect(computeClientNearCap(2, 5, 5)).toBe(0);
  });
});
