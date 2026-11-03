import { expect, test, type Locator, type Page } from '@playwright/test';
import enMessages from '../messages/en.json';
import { uniqueEmail } from './helpers';
import { bootstrapUnlockedUser } from './content-a11y-support';
import {
  SEARCH_CORPUS_ONE,
  SEARCH_CORPUS_TWO,
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
  typeKeys,
  waitForSuggestResponse,
  type ListboxInfo,
  type SeededCorpus,
  type SearchRequestRecorder,
  type SuggestCapture,
} from './content-search-support';

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

    // 22-2: near rows, the Gần nghĩa zone with its ≈ badge, the ≈ toggle, near-pending / degraded / enable-409 lines and the
    // cursor page ("Xem thêm") are `@semantic` (job `e2e-search-semantic`, real `fakeembed`) or need the semantic stack and
    // land in PR 22-2. They go right after the lexical probes above, with the same typeProbe/waitForSuggestResponse
    // helpers; this spec must stay lexical-only (no `semantic=1`, no `page.route` stub, advisor-dec-323 Q2).

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
