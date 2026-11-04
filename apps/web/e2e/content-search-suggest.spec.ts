import { expect, test, type Locator, type Page } from '@playwright/test';
import enMessages from '../messages/en.json';
import { uniqueEmail } from './helpers';
import { bootstrapUnlockedUser } from './content-a11y-support';
import {
  SEARCH_CORPUS_ONE,
  SEARCH_CORPUS_TWO,
  SEARCH_QUIET_WINDOW_MS,
  SEARCH_TEST_TIMEOUT_MS,
  SEARCH_UI_WAIT_MS,
  attachSearchRequestRecorder,
  clearDraft,
  expectRowKeys,
  expectedKeysFromSuggest,
  hasQueryParam,
  newClipboardContext,
  queryParamOf,
  readListbox,
  rowKeys,
  searchOmnibox,
  seedSearchCorpus,
  toggleSemanticSetting,
  typeKeys,
  waitForSuggestLegResponse,
  waitForSuggestResponse,
  type ListboxInfo,
  type SearchCorpus,
  type SeededCorpus,
  type SearchRequestRecorder,
  type SuggestCapture,
} from './content-search-support';
import {
  documentInput,
  fakeembedSetAliases,
  fakeembedStats,
  itemDocumentText,
  nextProbeQuery,
  uniqueSemanticQuery,
  waitForEmbedded,
} from './content-search-semantic-support';

// Disable Playwright's automatic error-context DOM snapshot in this worker before any test runs: the omnibox holds the
// typed draft and a failure snapshot must never serialize it to disk.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

const search = enMessages.search;

/**
 * P05 Task 22 (22-1a): lexical `/suggest` end to end on the real stack (embedding provider `noop`, semantic off).
 *
 * Order and groups are asserted twice: against the plan 2.3 ranking derived for the seeded corpus (see the comment on
 * `SEARCH_CORPUS_ONE`) and against the body the real server returned for the same request (so a drift between the
 * server and the dropdown can never hide behind a wrong derivation). If the derived order and the server order ever
 * differ, the first assert names the query and the second would still pass: report both, do not guess.
 *
 * Every probe query is typed exactly once per user: the client caches a response for 30 s (plan 2.7), so a second typing
 * of the same query would not touch the network and the "clean typing really sends /suggest" guard (FE-5) would be void.
 */

interface QueryResult {
  readonly capture: SuggestCapture;
  readonly info: ListboxInfo;
}

/** Clears the draft, types `typed` with real key events and waits for the matching `/suggest` response and the DOM. */
async function typeProbe(
  page: Page,
  omnibox: Locator,
  typed: string,
  expectReq: { readonly q: string; readonly scope: string },
): Promise<QueryResult> {
  await clearDraft(page, omnibox);
  const response = waitForSuggestResponse(page, { q: expectReq.q, scope: expectReq.scope });
  await typeKeys(page, typed);
  const capture = await response;
  expect(capture.status).toBe(200);
  await expectRowKeys(page, expectedKeysFromSuggest(capture.body));
  return { capture, info: await readListbox(page) };
}

function itemNames(capture: SuggestCapture): string[] {
  return capture.body.items.map((i) => i.name);
}

function tagNames(capture: SuggestCapture): string[] {
  return capture.body.tags.map((t) => t.display);
}

function zoneIds(info: ListboxInfo): string[] {
  return info.zones.map((z) => z.id);
}

/** Markup contract of plan 2.8 rule 5: one listbox, options only inside groups, the actions group is last. */
function expectGroupedMarkup(info: ListboxInfo): void {
  expect(info.present).toBe(true);
  expect(info.options.filter((o) => o.zone === null)).toEqual([]);
  const ids = zoneIds(info);
  const actionsAt = ids.indexOf('actions');
  if (actionsAt >= 0) {
    expect(actionsAt).toBe(ids.length - 1);
  }
  for (const zone of info.zones) {
    expect(zone.heading.length).toBeGreaterThan(0);
    expect(zone.keys.length).toBeGreaterThan(0);
  }
}

function expectCtaLast(info: ListboxInfo): void {
  const last = info.options[info.options.length - 1];
  expect(last?.kind).toBe('create');
  expect(last?.zone).toBe('actions');
  expect(info.options.filter((o) => o.kind === 'create')).toHaveLength(1);
}

async function expectTypedSuggestSent(
  recorder: SearchRequestRecorder,
  mark: number,
  q: string,
  scope: string,
): Promise<void> {
  await recorder.flush();
  const sent = recorder.suggestSince(mark, { withQuery: true }).filter((r) => queryParamOf(r, 'q') === q);
  expect(sent.length, 'clean typing must send GET /suggest (FE-5)').toBeGreaterThanOrEqual(1);
  for (const rec of sent) {
    expect(rec.method).toBe('GET');
    expect(rec.postData).toBe('');
    expect(queryParamOf(rec, 'scope')).toBe(scope);
    expect(queryParamOf(rec, 'semantic')).toBe('0');
    expect(queryParamOf(rec, 'limit')).toBe('8');
  }
}

test.describe('P05-T22 search suggest (lexical, real stack)', () => {
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  test('wi / ma / duong / pasword / #nh / empty: order and groups match the plan 2.3 ranking and the server, clean typing sends /suggest, a second user sees none of it', async ({
    page,
    browser,
  }) => {
    test.setTimeout(SEARCH_TEST_TIMEOUT_MS);
    const recorder = attachSearchRequestRecorder(page.context());

    await bootstrapUnlockedUser(page, uniqueEmail('content-search-suggest'), 'en', 'light');
    const seeded: SeededCorpus = await seedSearchCorpus(page, SEARCH_CORPUS_ONE);
    const omnibox = searchOmnibox(page);
    await expect(omnibox).toBeVisible({ timeout: SEARCH_UI_WAIT_MS });

    // ---- empty draft: focus sends `recent` (no q); items first ("Recent"), then tags ("Frequent tags"); no CTA ----
    await test.step('empty draft (recent)', async () => {
      const markRecent = recorder.mark();
      const recentResponse = waitForSuggestResponse(page, { q: null });
      await omnibox.focus();
      const recent = await recentResponse;
      expect(recent.status).toBe(200);
      expect(recent.body.mode).toBe('recent');
      expect(recent.body.semantic).toBe(false);
      expect(recent.body.near).toEqual([]);
      // limit 8 at 1440 px => 5 recent items, 3 recent tags (quota table, plan 2.4). Items are the five newest names.
      expect(itemNames(recent)).toEqual([
        'duong dev server',
        'Dương Minh',
        'đường dẫn',
        'password vault',
        'passport scan',
      ]);
      expect(recent.body.tags).toHaveLength(3);
      for (const tag of tagNames(recent)) {
        expect(SEARCH_CORPUS_ONE.tags).toContain(tag);
      }
      await expectRowKeys(page, expectedKeysFromSuggest(recent.body, { recent: true }));
      const info = await readListbox(page);
      expectGroupedMarkup(info);
      expect(zoneIds(info)).toEqual(['items', 'tags']);
      expect(info.zones.map((z) => z.heading)).toEqual([search.group.recentItems, search.group.recentTags]);
      expect(info.options.some((o) => o.kind === 'create' || o.kind === 'more')).toBe(false);
      expect(info.activeKey, 'recent never auto-activates a row').toBeNull();
      await recorder.flush();
      const focusReads = recorder.suggestSince(markRecent);
      expect(focusReads.length).toBeGreaterThanOrEqual(1);
      expect(focusReads.every((r) => !hasQueryParam(r, 'q'))).toBe(true);
    });

    // ---- wi: tag `wifi-khách` + four tier-3 items, equal score => newest first; the duplicate name shows created_at ----
    await test.step('wi', async () => {
      const mark = recorder.mark();
      const { capture, info } = await typeProbe(page, omnibox, 'wi', { q: 'wi', scope: 'all' });
      await expectTypedSuggestSent(recorder, mark, 'wi', 'all');
      expect(capture.body.mode).toBe('full');
      expect(capture.body.semantic).toBe(false);
      expect(capture.body.semantic_reason).toBe('disabled_server');
      expect(capture.body.near).toEqual([]);
      expect(tagNames(capture)).toEqual(['wifi-khách']);
      expect(itemNames(capture)).toEqual(['WiFi Khách', 'wifi', 'wifi', 'window license']);
      // Derived ids: duplicate `wifi` pair, B (created later) before A.
      expect(capture.body.items.map((i) => i.id)).toEqual([
        seeded.itemId('wifiKhach'),
        seeded.itemId('wifiB'),
        seeded.itemId('wifiA'),
        seeded.itemId('window'),
      ]);
      expect(capture.body.items.every((i) => i.match === 'prefix')).toBe(true);

      expectGroupedMarkup(info);
      expect(zoneIds(info)).toEqual(['tags', 'items', 'actions']);
      expect(info.zones.map((z) => z.heading)).toEqual([search.group.tags, search.group.items, search.group.actions]);
      expect(info.ariaLabel).toBe(search.listbox.suggestAriaLabel);
      expect(info.options.map((o) => o.kind)).toEqual(['tag', 'item', 'item', 'item', 'item', 'create']);
      expectCtaLast(info);
      expect(info.activeKey, 'plain search never auto-activates the first row').toBeNull();

      const items = info.options.filter((o) => o.kind === 'item');
      // Only the colliding `wifi` rows show a created_at date (plan 2.9 / handoff conventions).
      expect(items.map((o) => o.hasDate)).toEqual([false, true, true, false]);
      // wifiA carries two chips (#wifi-khách, #nhà), wifiB none.
      expect(items.map((o) => o.chipCount)).toEqual([0, 0, 2, 0]);
      expect(items.map((o) => o.title)).toEqual(['WiFi Khách', 'wifi', 'wifi', 'window license']);
      expect(info.options.find((o) => o.kind === 'tag')?.title).toBe('wifi-khách');
    });

    // ---- ma: tier 3 `master key`, then folded prefix `mã vạch` (score 1.0) and `máy in` (.67); tag `mạng` ----
    await test.step('ma', async () => {
      const mark = recorder.mark();
      const { capture, info } = await typeProbe(page, omnibox, 'ma', { q: 'ma', scope: 'all' });
      await expectTypedSuggestSent(recorder, mark, 'ma', 'all');
      expect(tagNames(capture)).toEqual(['mạng']);
      expect(itemNames(capture)).toEqual(['master key', 'mã vạch', 'máy in']);
      expect(capture.body.items.map((i) => i.match)).toEqual(['prefix', 'prefix_folded', 'prefix_folded']);
      expect(capture.body.tags.map((t) => t.match)).toEqual(['prefix_folded']);
      expect(capture.body.items.map((i) => i.id)).toEqual([
        seeded.itemId('master'),
        seeded.itemId('mavach'),
        seeded.itemId('may'),
      ]);
      expectGroupedMarkup(info);
      expect(zoneIds(info)).toEqual(['tags', 'items', 'actions']);
      expect(info.options.map((o) => o.kind)).toEqual(['tag', 'item', 'item', 'item', 'create']);
      expectCtaLast(info);
    });

    // ---- duong: tier 3 `duong dev server`, then folded `Dương Minh` / `đường dẫn` (both 1.0, newer first); no tags ----
    await test.step('duong', async () => {
      const mark = recorder.mark();
      const { capture, info } = await typeProbe(page, omnibox, 'duong', { q: 'duong', scope: 'all' });
      await expectTypedSuggestSent(recorder, mark, 'duong', 'all');
      expect(capture.body.tags).toEqual([]);
      expect(itemNames(capture)).toEqual(['duong dev server', 'Dương Minh', 'đường dẫn']);
      expect(capture.body.items.map((i) => i.match)).toEqual(['prefix', 'prefix_folded', 'prefix_folded']);
      expect(capture.body.items.map((i) => i.id)).toEqual([
        seeded.itemId('duongDev'),
        seeded.itemId('duongMinh'),
        seeded.itemId('duongDan'),
      ]);
      expectGroupedMarkup(info);
      expect(zoneIds(info), 'no tag matched, so no Tags group is rendered').toEqual(['items', 'actions']);
      expect(info.options.map((o) => o.kind)).toEqual(['item', 'item', 'item', 'create']);
      expectCtaLast(info);
    });

    // ---- pasword: typo; only `password vault` (word-similarity ~.70, fuzzy) and it carries the fuzzy badge ----
    await test.step('pasword', async () => {
      const mark = recorder.mark();
      const { capture, info } = await typeProbe(page, omnibox, 'pasword', { q: 'pasword', scope: 'all' });
      await expectTypedSuggestSent(recorder, mark, 'pasword', 'all');
      expect(capture.body.tags).toEqual([]);
      expect(itemNames(capture)).toEqual(['password vault']);
      expect(capture.body.items[0]?.match).toBe('fuzzy');
      expect(capture.body.items[0]?.id).toBe(seeded.itemId('password'));
      expectGroupedMarkup(info);
      expect(info.options.map((o) => o.kind)).toEqual(['item', 'create']);
      expect(info.options[0]?.badge).toBe(search.match.fuzzy);
      expectCtaLast(info);
    });

    // ---- #nh: `scope=tag` with the token only; first row active; no CTA, no items ----
    await test.step('#nh', async () => {
      const mark = recorder.mark();
      const { capture, info } = await typeProbe(page, omnibox, '#nh', { q: 'nh', scope: 'tag' });
      await expectTypedSuggestSent(recorder, mark, 'nh', 'tag');
      expect(capture.body.items).toEqual([]);
      expect([...tagNames(capture)].sort()).toEqual(['nhà', 'nhật-ký']);
      expect(capture.body.tags.every((t) => t.match === 'prefix')).toBe(true);
      expectGroupedMarkup(info);
      expect(zoneIds(info)).toEqual(['tags']);
      expect(info.options.map((o) => o.kind)).toEqual(['tag', 'tag']);
      expect(info.options.some((o) => o.kind === 'create')).toBe(false);
      expect(info.ariaLabel).toBe(search.listbox.tagAriaLabel);
      // `#` mode (plan 2.8 rule 7): the first server row is auto-active and aria-activedescendant points at it.
      const first = rowKeys(info)[0];
      expect(info.activeKey).toBe(first);
      expect(info.activeDescendantId).not.toBeNull();
    });

    // This test stays lexical-only (no `semantic=1`, no `page.route` stub, advisor-dec-323 Q2). The near zone, its ≈ badge,
    // the near-only hit, the per-user near isolation and the user-off case are the `@semantic` tests in the second
    // `describe` at the bottom of this file (PR 22-2a, job `Search semantic e2e (fake provider)`).

    // The recorder saw only GET /suggest for the omnibox: no /search, no legacy GET /items?q= or GET /tags?q=.
    await recorder.flush();
    expect(recorder.searchSince(0)).toHaveLength(0);
    const legacyReads = recorder.records.filter(
      (r) => r.method === 'GET' && /^\/api\/v1\/(items|tags)$/.test(r.pathname) && hasQueryParam(r, 'q'),
    );
    expect(legacyReads).toHaveLength(0);

    // ---- a second user, same first letters: sees only their own rows, none of user one's ----
    await test.step('second user is isolated', async () => {
      const context2 = await newClipboardContext(browser);
      try {
        const page2 = await context2.newPage();
        await bootstrapUnlockedUser(page2, uniqueEmail('content-search-suggest-b'), 'en', 'light');
        const seededTwo = await seedSearchCorpus(page2, SEARCH_CORPUS_TWO);
        const omnibox2 = searchOmnibox(page2);
        await expect(omnibox2).toBeVisible({ timeout: SEARCH_UI_WAIT_MS });

        const { capture, info } = await typeProbe(page2, omnibox2, 'wi', { q: 'wi', scope: 'all' });
        expect(itemNames(capture)).toEqual(['wiz tracker']);
        expect(tagNames(capture)).toEqual(['wiz-team']);
        expect(capture.body.items[0]?.id).toBe(seededTwo.itemId('wiz'));
        const keysTwo = new Set(rowKeys(info));
        for (const key of seeded.allKeys) {
          expect(keysTwo.has(key), 'user two must never see a user one row').toBe(false);
        }
        expect(JSON.stringify(capture.body)).not.toContain('wifi');

        // A name only user one has: no rows, the local "no match" box instead of a listbox.
        const miss = waitForSuggestResponse(page2, { q: 'duong', scope: 'all' });
        await clearDraft(page2, omnibox2);
        await typeKeys(page2, 'duong');
        const missBody = await miss;
        expect(missBody.body.items).toEqual([]);
        expect(missBody.body.tags).toEqual([]);
        await expect(page2.getByTestId('omnibox-search-empty')).toBeVisible({ timeout: SEARCH_UI_WAIT_MS });
        expect((await readListbox(page2)).options.filter((o) => o.kind === 'item' || o.kind === 'tag')).toEqual([]);

        // The id of a user one item is a plain 404 for user two (same wire, different owner).
        const foreignGet = await page2.evaluate(async (id) => {
          const res = await fetch(`/api/v1/items/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
          return res.status;
        }, seeded.itemId('wifiA'));
        expect(foreignGet).toBe(404);
      } finally {
        await context2.close();
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// @semantic tests (P05 Task 22, PR 22-2a). Real semantic server + CI-only `fakeembed`, job `Search semantic e2e (fake
// provider)`; `Content e2e` skips them through `--grep-invert @semantic`. No `page.route` anywhere.
// Order (plan Task 22 / 20b, N1): seed -> waitForEmbedded -> alias the NEW query to the target -> type it once.
// ---------------------------------------------------------------------------------------------------------------------------

const NEAR_ZONE_SELECTOR = '#omni-listbox [data-zone="near"]';
/** Same name (so the same plan 2.14 document text and the same vector) for both users in the isolation case. */
const NEAR_TARGET_NAME = 'quiet harbor lamp';

/** Clears the draft, types `query` with real key events and resolves with BOTH legs of that query (lexical, near). */
async function typeSemanticQuery(
  page: Page,
  omnibox: Locator,
  query: string,
): Promise<{ readonly lexical: SuggestCapture; readonly near: SuggestCapture }> {
  await clearDraft(page, omnibox);
  const lexicalLeg = waitForSuggestLegResponse(page, { q: query, semantic: 0, scope: 'all' });
  const nearLeg = waitForSuggestLegResponse(page, { q: query, semantic: 1, scope: 'all' });
  await typeKeys(page, query);
  const [lexical, near] = await Promise.all([lexicalLeg, nearLeg]);
  expect(lexical.status).toBe(200);
  expect(near.status).toBe(200);
  return { lexical, near };
}

function nearKeysOf(capture: SuggestCapture): string[] {
  return capture.body.near.map((n) => `${n.kind}:${n.id}`);
}

test.describe('P05-T22 search suggest (@semantic, real fakeembed)', () => {
  // Locally without the stack: skip. In CI never skip: a misconfigured semantic job must go red, not green-by-skipping.
  test.skip(
    !process.env.E2E_STACK && !process.env.CI,
    'needs the compose stack (E2E_STACK=1) with profile semantic-fake: real API, real fakeembed provider',
  );

  test('@semantic near zone follows the lexical groups with the ≈ badge and no highlight; a near-only hit shows in it; a second user never sees user one near rows', async ({
    page,
    browser,
  }) => {
    test.setTimeout(SEARCH_TEST_TIMEOUT_MS);
    const recorder = attachSearchRequestRecorder(page.context());
    await bootstrapUnlockedUser(page, uniqueEmail('content-search-suggest-sem'), 'en', 'light');

    // `token` hits a tag and two items lexically (tags, items zones) and is aliased to the target, which has no lexical
    // relation to it (near zone). `onlyQuery` hits nothing lexically and is aliased to the same target (near-only).
    const token = uniqueSemanticQuery('sug');
    const onlyQuery = uniqueSemanticQuery('only');
    const corpus: SearchCorpus = {
      tags: [`${token}-tag`],
      items: [
        { ref: 'target', name: NEAR_TARGET_NAME },
        { ref: 'alpha', name: `${token} alpha` },
        { ref: 'beta', name: `${token} beta` },
      ],
    };
    const seeded = await seedSearchCorpus(page, corpus);
    const targetId = seeded.itemId('target');
    const targetKey = seeded.itemKey('target');
    const omnibox = searchOmnibox(page);
    await expect(omnibox).toBeVisible({ timeout: SEARCH_UI_WAIT_MS });

    await test.step('waitForEmbedded, then alias both new queries to the target', async () => {
      await waitForEmbedded(page, [{ id: targetId, probeQuery: nextProbeQuery() }]);
      const targetInput = documentInput(itemDocumentText(NEAR_TARGET_NAME, null));
      await fakeembedSetAliases({ [token]: targetInput, [onlyQuery]: targetInput });
    });

    await test.step('lexical groups first, then the near zone with the ≈ badge and no highlight mark', async () => {
      const mark = recorder.mark();
      const statsBefore = await fakeembedStats();
      const { lexical, near } = await typeSemanticQuery(page, omnibox, token);
      expect(near.body.semantic, 'near leg is served by the real provider').toBe(true);
      expect(lexical.body.near).toEqual([]);
      expect(lexical.body.tags.map((t) => t.display)).toEqual([`${token}-tag`]);
      expect(lexical.body.items.map((i) => i.name).sort()).toEqual([`${token} alpha`, `${token} beta`].sort());
      expect(nearKeysOf(near), 'the aliased target is the near row').toEqual([targetKey]);
      await expect
        .poll(async () => (await fakeembedStats()).query_requests, {
          timeout: SEARCH_UI_WAIT_MS,
          message: 'fakeembed query_requests must grow: a brand-new query reached the provider',
        })
        .toBeGreaterThan(statsBefore.query_requests);

      const nearRow = page.locator(`${NEAR_ZONE_SELECTOR} [data-opt-key="${targetKey}"]`);
      await expect(nearRow).toBeVisible({ timeout: SEARCH_UI_WAIT_MS });
      const info = await readListbox(page);
      expectGroupedMarkup(info);
      expect(zoneIds(info).filter((z) => z !== 'actions'), 'tags, items, then near').toEqual(['tags', 'items', 'near']);
      const near1 = info.zones.find((z) => z.id === 'near');
      expect(near1?.keys).toEqual([targetKey]);
      expect(near1?.heading).toBe(search.group.near);
      expect(info.ariaLabel).toBe(search.listbox.suggestAriaLabel);
      // Lexical rows keep the server order; the near key is the last row key (the CTA group follows it).
      expect(rowKeys(info)).toEqual(expectedKeysFromSuggest({ ...lexical.body, near: near.body.near }));

      // Plan 2.8 rule 5: the ≈ badge only on near rows; a near row is never highlighted (semantic, like fuzzy, has no mark)
      // and never carries the lexical `fuzzy` badge; lexical prefix rows keep their highlight and no ≈ badge.
      await expect(nearRow.locator('.sugg-near-badge')).toHaveText(search.match.semantic);
      await expect(nearRow.locator('mark')).toHaveCount(0);
      await expect(nearRow.locator('.sugg-match-badge')).toHaveCount(0);
      await expect(page.locator('#omni-listbox .sugg-near-badge')).toHaveCount(1);
      const lexicalRows = page.locator('#omni-listbox [data-zone="items"] [data-opt-kind="item"]');
      await expect(lexicalRows).toHaveCount(2);
      for (const row of await lexicalRows.all()) {
        await expect(row.locator('mark')).toHaveCount(1);
        await expect(row.locator('.sugg-near-badge')).toHaveCount(0);
      }

      // Real wire: both legs of the query went out, the near leg as `semantic=1`.
      await recorder.flush();
      const legs = recorder.suggestSince(mark, { withQuery: true }).filter((r) => queryParamOf(r, 'q') === token);
      expect(new Set(legs.map((r) => queryParamOf(r, 'semantic')))).toEqual(new Set(['0', '1']));
    });

    await test.step('near-only: a query with no lexical match shows only the near zone', async () => {
      const { lexical, near } = await typeSemanticQuery(page, omnibox, onlyQuery);
      expect(lexical.body.items).toEqual([]);
      expect(lexical.body.tags).toEqual([]);
      expect(near.body.semantic).toBe(true);
      expect(nearKeysOf(near)).toEqual([targetKey]);
      const nearRow = page.locator(`${NEAR_ZONE_SELECTOR} [data-opt-key="${targetKey}"]`);
      await expect(nearRow).toBeVisible({ timeout: SEARCH_UI_WAIT_MS });
      await expect(nearRow.locator('.sugg-near-badge')).toHaveText(search.match.semantic);
      await expect(page.getByTestId('omnibox-search-empty')).toHaveCount(0);
      const info = await readListbox(page);
      expectGroupedMarkup(info);
      expect(zoneIds(info).filter((z) => z !== 'actions')).toEqual(['near']);
      expect(rowKeys(info)).toEqual([targetKey]);
    });

    await test.step('second user: same query, own near row only, none of user one', async () => {
      const context2 = await newClipboardContext(browser);
      try {
        const page2 = await context2.newPage();
        await bootstrapUnlockedUser(page2, uniqueEmail('content-search-suggest-sem-b'), 'en', 'light');
        // Same name => same document text => cos 1 against the alias, so user two HAS a near hit (never an empty green),
        // and it must be user two's own row, never user one's.
        const seededTwo = await seedSearchCorpus(page2, {
          tags: [],
          items: [{ ref: 'target', name: NEAR_TARGET_NAME }],
        });
        const targetTwoKey = seededTwo.itemKey('target');
        expect(targetTwoKey).not.toBe(targetKey);
        const omnibox2 = searchOmnibox(page2);
        await expect(omnibox2).toBeVisible({ timeout: SEARCH_UI_WAIT_MS });
        await waitForEmbedded(page2, [{ id: seededTwo.itemId('target'), probeQuery: nextProbeQuery() }]);

        const { lexical, near } = await typeSemanticQuery(page2, omnibox2, token);
        expect(lexical.body.items).toEqual([]);
        expect(lexical.body.tags).toEqual([]);
        expect(near.body.semantic).toBe(true);
        expect(nearKeysOf(near), 'user two sees exactly their own near row').toEqual([targetTwoKey]);
        for (const body of [JSON.stringify(lexical.body), JSON.stringify(near.body)]) {
          for (const foreignId of seeded.allKeys) {
            expect(body.includes(foreignId.slice(foreignId.indexOf(':') + 1)), 'a user one id leaked into user two suggest').toBe(
              false,
            );
          }
        }
        await expect(page2.locator(`${NEAR_ZONE_SELECTOR} [data-opt-key="${targetTwoKey}"]`)).toBeVisible({
          timeout: SEARCH_UI_WAIT_MS,
        });
        const info = await readListbox(page2);
        expect(rowKeys(info)).toEqual([targetTwoKey]);
        for (const key of seeded.allKeys) {
          expect(info.options.some((o) => o.key === key), 'user two must never see a user one row').toBe(false);
        }
      } finally {
        await context2.close();
      }
    });
  });

  test('@semantic user turns ≈ off (real PATCH false): no near request, no near zone, no pending/degraded line, the provider is not called', async ({
    page,
  }) => {
    test.setTimeout(SEARCH_TEST_TIMEOUT_MS);
    const recorder = attachSearchRequestRecorder(page.context());
    await bootstrapUnlockedUser(page, uniqueEmail('content-search-suggest-off'), 'en', 'light');

    // Both queries are aliased to the target, so a near row WOULD exist if the near leg were sent; `onQuery` proves it
    // exists while ≈ is on, `offQuery` is typed after the user turned ≈ off.
    const onQuery = uniqueSemanticQuery('on');
    const offQuery = uniqueSemanticQuery('off');
    const seeded = await seedSearchCorpus(page, {
      tags: [],
      items: [
        { ref: 'target', name: NEAR_TARGET_NAME },
        { ref: 'onHit', name: `${onQuery} thing` },
        { ref: 'offHit', name: `${offQuery} thing` },
      ],
    });
    const targetKey = seeded.itemKey('target');
    const omnibox = searchOmnibox(page);
    await expect(omnibox).toBeVisible({ timeout: SEARCH_UI_WAIT_MS });
    await waitForEmbedded(page, [{ id: seeded.itemId('target'), probeQuery: nextProbeQuery() }]);
    const targetInput = documentInput(itemDocumentText(NEAR_TARGET_NAME, null));
    await fakeembedSetAliases({ [onQuery]: targetInput, [offQuery]: targetInput });

    await test.step('≈ on (default): the near row shows', async () => {
      const toggle = page.getByTestId('omnibox-semantic-toggle');
      await expect(toggle).toHaveAttribute('aria-pressed', 'true', { timeout: SEARCH_UI_WAIT_MS });
      const { near } = await typeSemanticQuery(page, omnibox, onQuery);
      expect(nearKeysOf(near)).toEqual([targetKey]);
      await expect(page.locator(`${NEAR_ZONE_SELECTOR} [data-opt-key="${targetKey}"]`)).toBeVisible({
        timeout: SEARCH_UI_WAIT_MS,
      });
    });

    await test.step('≈ off through the real PATCH: the near zone is hidden at once', async () => {
      await toggleSemanticSetting(page, false);
      await expect(page.locator(NEAR_ZONE_SELECTOR)).toHaveCount(0, { timeout: SEARCH_UI_WAIT_MS });
    });

    await test.step('a new aliased query after ≈ off: lexical leg only, provider untouched', async () => {
      await recorder.flush();
      const mark = recorder.mark();
      const statsBefore = await fakeembedStats();
      await clearDraft(page, omnibox);
      const lexicalLeg = waitForSuggestLegResponse(page, { q: offQuery, semantic: 0, scope: 'all' });
      await typeKeys(page, offQuery);
      const lexical = await lexicalLeg;
      expect(lexical.status).toBe(200);
      expect(lexical.body.items.map((i) => i.name)).toEqual([`${offQuery} thing`]);
      expect(lexical.body.near).toEqual([]);
      await expectRowKeys(page, [`item:${seeded.itemId('offHit')}`]);

      // The "wait >= 1 s with no request" case of the plan: a near leg of this query would have been sent with the lexical one.
      await page.waitForTimeout(SEARCH_QUIET_WINDOW_MS);
      await recorder.flush();
      const sent = recorder.suggestSince(mark, { withQuery: true }).filter((r) => queryParamOf(r, 'q') === offQuery);
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.every((r) => queryParamOf(r, 'semantic') === '0'), 'no semantic=1 request after ≈ off').toBe(true);
      expect(recorder.suggestSince(mark).filter((r) => queryParamOf(r, 'semantic') === '1')).toHaveLength(0);
      expect((await fakeembedStats()).query_requests, 'the provider is not called for a user who turned ≈ off').toBe(
        statsBefore.query_requests,
      );

      await expect(page.locator(NEAR_ZONE_SELECTOR)).toHaveCount(0);
      await expect(page.getByTestId('omnibox-status-near-pending')).toHaveCount(0);
      await expect(page.getByTestId('omnibox-status-degraded')).toHaveCount(0);
      await expect(page.getByTestId('omnibox-semantic-toggle')).toHaveAttribute('aria-pressed', 'false');
    });
  });
});
