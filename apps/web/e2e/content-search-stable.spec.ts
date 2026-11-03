import { expect, test, type ElementHandle, type Locator, type Page } from '@playwright/test';
import { uniqueEmail } from './helpers';
import { bootstrapUnlockedUser } from './content-a11y-support';
import {
  SEARCH_CORPUS_ONE,
  SEARCH_TEST_TIMEOUT_MS,
  SEARCH_UI_WAIT_MS,
  attachSearchRequestRecorder,
  clearDraft,
  expectRowKeys,
  expectedKeysFromSuggest,
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
  type SuggestCapture,
} from './content-search-support';
import {
  documentInput,
  fakeembedReset,
  fakeembedSetAliases,
  fakeembedSetMode,
  fakeembedStats,
  itemDocumentText,
  nextProbeQuery,
  suggestSemanticViaPage,
  uniqueSemanticQuery,
  waitForEmbedded,
} from './content-search-semantic-support';

// Disable Playwright's automatic error-context DOM snapshot in this worker before any test runs.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

/**
 * P05 Task 22 (22-1a) stable merge, LEXICAL half, real stack (embedding provider `noop`, no near rows ever).
 *
 * Plan 2.8 rule 1 says a new query keeps the rows it already shows until the first full response of the new generation,
 * keeps `activeKey` when its `(kind, id)` is still in the new snapshot and otherwise clears it without auto-activating the
 * first row, and that React keys are `kind:id`, so a surviving row is the same DOM node.
 *
 * The `@semantic` half (PR 22-2a) is the second `describe` at the bottom of this file. It runs only in job
 * `Search semantic e2e (fake provider)` against the real `fakeembed` (`Content e2e` skips it through
 * `--grep-invert @semantic`).
 *
 * Every lexical query below is typed once per user: responses are cached client-side for 30 s (plan 2.7), a second typing
 * would not hit the network and the response wait would time out.
 */

interface RowHandles {
  readonly keys: string[];
  readonly handles: Map<string, ElementHandle<HTMLElement>>;
}

async function captureRowHandles(page: Page): Promise<RowHandles> {
  const keys = rowKeys(await readListbox(page));
  const handles = new Map<string, ElementHandle<HTMLElement>>();
  for (const key of keys) {
    const handle = await page.locator(`#omni-listbox [data-opt-key="${key}"]`).elementHandle();
    if (!handle) {
      throw new Error('listbox row vanished while capturing handles');
    }
    handles.set(key, handle as ElementHandle<HTMLElement>);
  }
  return { keys, handles };
}

/** Relative order of the rows present in both lists is identical (a keystroke never reorders survivors). */
function survivorsKeepOrder(prev: readonly string[], next: readonly string[]): boolean {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  const a = prev.filter((k) => nextSet.has(k));
  const b = next.filter((k) => prevSet.has(k));
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

async function expectActiveKey(page: Page, expected: string | null): Promise<void> {
  await expect
    .poll(async () => (await readListbox(page)).activeKey, { timeout: SEARCH_UI_WAIT_MS })
    .toBe(expected);
}

async function typeAndSettle(
  page: Page,
  suffix: string,
  expectedQ: string,
): Promise<SuggestCapture> {
  const response = waitForSuggestResponse(page, { q: expectedQ, scope: 'all' });
  await typeKeys(page, suffix);
  const capture = await response;
  expect(capture.status).toBe(200);
  expect(capture.body.near).toEqual([]);
  await expectRowKeys(page, expectedKeysFromSuggest(capture.body));
  return capture;
}

test.describe('P05-T22 search stable merge (lexical, real stack)', () => {
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  test('lexical order is stable across keystrokes and the active row keeps its (kind,id) and its DOM node while the query refines', async ({
    page,
  }) => {
    test.setTimeout(SEARCH_TEST_TIMEOUT_MS);
    const recorder = attachSearchRequestRecorder(page.context());
    await bootstrapUnlockedUser(page, uniqueEmail('content-search-stable'), 'en', 'light');
    const seeded = await seedSearchCorpus(page, SEARCH_CORPUS_ONE);
    const omnibox: Locator = searchOmnibox(page);
    await expect(omnibox).toBeVisible({ timeout: SEARCH_UI_WAIT_MS });
    await omnibox.focus();

    // ---- wi -> wif -> wifi: ↓↓ activates the second row; every refinement keeps it, its node and the survivors' order ----
    await test.step('refine wi -> wif -> wifi', async () => {
      const first = await typeAndSettle(page, 'wi', 'wi');
      const firstKeys = expectedKeysFromSuggest(first.body);
      // [tag wifi-khách, WiFi Khách, wifi B, wifi A, window license]: the second navigable row is `WiFi Khách`.
      const activeKey = seeded.itemKey('wifiKhach');
      expect(firstKeys[1]).toBe(activeKey);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await expectActiveKey(page, activeKey);
      const activeId = (await readListbox(page)).activeDescendantId;
      expect(activeId).not.toBeNull();

      let prev: RowHandles = await captureRowHandles(page);
      const steps: ReadonlyArray<{ readonly suffix: string; readonly q: string }> = [
        { suffix: 'f', q: 'wif' },
        { suffix: 'i', q: 'wifi' },
      ];
      for (const step of steps) {
        const capture = await typeAndSettle(page, step.suffix, step.q);
        const nextKeys = expectedKeysFromSuggest(capture.body);
        expect(survivorsKeepOrder(prev.keys, nextKeys), `order of surviving rows changed at ${step.q}`).toBe(true);
        expect(nextKeys, 'the active row still matches this query').toContain(activeKey);

        // `(kind,id)` kept: same `activeKey`, same option id in `aria-activedescendant`, `aria-selected` on that row.
        await expectActiveKey(page, activeKey);
        const info = await readListbox(page);
        expect(info.activeDescendantId).toBe(activeId);
        await expect(page.locator(`#omni-listbox [data-opt-key="${activeKey}"]`)).toHaveAttribute(
          'aria-selected',
          'true',
        );

        // Same DOM nodes: React keys are `kind:id`, so a surviving row is never remounted.
        for (const key of nextKeys) {
          const old = prev.handles.get(key);
          if (!old) continue;
          expect(await old.evaluate((el) => el.isConnected), `row node for a surviving key was remounted at ${step.q}`).toBe(
            true,
          );
        }
        prev = await captureRowHandles(page);
      }

      // ↑↓ are computed from `activeKey` at press time (plan 2.8 rule 5): one ↓ goes to the row after `WiFi Khách`.
      const after = rowKeys(await readListbox(page));
      const next = after[after.indexOf(activeKey) + 1];
      expect(next, 'a row follows WiFi Khách in `wifi`').toBeDefined();
      await page.keyboard.press('ArrowDown');
      await expectActiveKey(page, next ?? null);
    });

    // ---- ma -> mast: the active row no longer matches; activeKey becomes null and the first row is NOT auto-activated ----
    await test.step('active row that stops matching is dropped, not replaced', async () => {
      await clearDraft(page, omnibox);
      const first = await typeAndSettle(page, 'ma', 'ma');
      const keys = expectedKeysFromSuggest(first.body);
      // [tag mạng, master key, mã vạch, máy in]: ↓ x3 = `mã vạch`.
      const activeKey = seeded.itemKey('mavach');
      expect(keys[2]).toBe(activeKey);
      for (let i = 0; i < 3; i += 1) {
        await page.keyboard.press('ArrowDown');
      }
      await expectActiveKey(page, activeKey);

      // `mast` shares no word with `mã vạch`/`máy in` (word-similarity .40 < .5), so only `master key` is left.
      const refined = await typeAndSettle(page, 'st', 'mast');
      expect(refined.body.items.map((i) => i.id)).toEqual([seeded.itemId('master')]);
      expect(refined.body.tags).toEqual([]);
      await expectActiveKey(page, null);
      await expect(omnibox).not.toHaveAttribute('aria-activedescendant');
      const info = await readListbox(page);
      expect(info.options.some((o) => o.key === seeded.itemKey('master'))).toBe(true);
      expect(info.options.filter((o) => o.zone === null)).toEqual([]);
    });

    // Real stack: semantic is off, so every keystroke request is the lexical leg only.
    await recorder.flush();
    const sent = recorder.suggestSince(0, { withQuery: true });
    expect(sent.length).toBeGreaterThanOrEqual(5);
    expect(sent.every((r) => queryParamOf(r, 'semantic') === '0')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// @semantic half (P05 Task 22, PR 22-2a). Real semantic server + CI-only `fakeembed`; no `page.route` anywhere.
// Order (plan Task 22 / 20b, N1): seed -> waitForEmbedded -> `slow` -> type a NEW never-sent query -> stats grew -> late near.
// ---------------------------------------------------------------------------------------------------------------------------

const SEMANTIC_TEST_TIMEOUT_MS = 300_000;
/**
 * Provider delay of the `slow` scenario, the ONE place to change it (advisor-dec-338: job `Search semantic e2e (fake
 * provider)` sets `EMBEDDING_QUERY_TIMEOUT: 5s`, commit 02b0bd2). It must stay well under that 5 s query timeout: a slower
 * provider times out, opens the API breaker for 60 s and turns the near leg into `degraded` instead of late. 2.5 s is long
 * enough that the lexical leg, the pending line and the ↓ keystrokes all provably happen before the near zone arrives.
 */
const SLOW_DELAY_MS = 2_500;
/**
 * `afterEach` recovery bound after a FAILED run, derived from the breaker window of `content-search-degrade.spec.ts`
 * (`BreakerOpenWindow` 60 s + one poll + request slack + report margin): 60_000 + 500 + 2_000 + 10_000.
 */
const CLEANUP_RECOVERY_MS = 72_500;
const CLEANUP_POLL_MS = 500;
const NEAR_ZONE = '#omni-listbox [data-zone="near"]';
const TARGET_NAME = 'lantern keeper';

/** Row keys outside the near zone (tags, then items): what the lexical leg decides. */
function lexicalKeys(info: ListboxInfo): string[] {
  return info.options.filter((o) => (o.kind === 'item' || o.kind === 'tag') && o.zone !== 'near').map((o) => o.key);
}

function nearKeys(info: ListboxInfo): string[] {
  return info.options.filter((o) => (o.kind === 'item' || o.kind === 'tag') && o.zone === 'near').map((o) => o.key);
}

/** Keys the lexical leg alone puts on screen (`near` stripped), in on-screen order. */
function lexicalKeysFromBody(body: SuggestCapture['body']): string[] {
  return expectedKeysFromSuggest({ ...body, near: [] });
}

/** `true` when `old` and the node currently rendered for `key` are the very same DOM node (never re-mounted). */
async function isSameNode(page: Page, old: ElementHandle<HTMLElement>, key: string): Promise<boolean> {
  const current = await page.locator(`#omni-listbox [data-opt-key="${key}"]`).elementHandle();
  if (!current) return false;
  return old.evaluate((el, other) => el === other, current);
}

test.describe('P05-T22 search stable merge (@semantic, real fakeembed)', () => {
  // Locally without the stack: skip. In CI never skip: a misconfigured semantic job must go red, not green-by-skipping.
  test.skip(
    !process.env.E2E_STACK && !process.env.CI,
    'needs the compose stack (E2E_STACK=1) with profile semantic-fake: real API, real fakeembed provider',
  );

  // The fake is shared by every @semantic spec of the job: never leave it `slow`. After a FAILED run the API breaker can
  // still be open although the fake is `ok` again, so wait it out with fresh queries (same recovery as the degrade spec).
  test.afterEach(async ({ page }, testInfo) => {
    await fakeembedReset();
    if (testInfo.status === testInfo.expectedStatus) {
      return;
    }
    const deadline = Date.now() + CLEANUP_RECOVERY_MS;
    try {
      while (Date.now() < deadline) {
        const response = await suggestSemanticViaPage(page, uniqueSemanticQuery('reset'));
        if (response.status === 200 && (response.body as { semantic?: boolean } | null)?.semantic === true) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, CLEANUP_POLL_MS));
      }
    } catch {
      // page gone or not on the app origin: nothing to recover
    }
  });

  test('@semantic slow provider: the late near zone leaves every lexical row on the same DOM node and keeps activeKey; ≈ off/on never reorders the lexical rows', async ({
    page,
  }) => {
    test.setTimeout(SEMANTIC_TEST_TIMEOUT_MS);
    const recorder = attachSearchRequestRecorder(page.context());
    await bootstrapUnlockedUser(page, uniqueEmail('content-search-stable-sem'), 'en', 'light');

    // The scenario query is `token`: it prefix-matches the three `token ...` items and is aliased to the target
    // (`lantern keeper`, no lexical relation), so the near leg returns exactly that one row. `prefixQuery` (token minus its
    // last character) is typed first so ↓↓ happens BEFORE the scenario query exists: the near arrival is then provably late.
    const token = uniqueSemanticQuery('stab');
    const prefixQuery = token.slice(0, -1);
    const lastChar = token.slice(-1);
    const corpus: SearchCorpus = {
      tags: [],
      items: [
        { ref: 'target', name: TARGET_NAME },
        { ref: 'alpha', name: `${token} alpha` },
        { ref: 'beta', name: `${token} beta` },
        { ref: 'gamma', name: `${token} gamma` },
      ],
    };
    const seeded = await seedSearchCorpus(page, corpus);
    const targetId = seeded.itemId('target');
    const targetKey = seeded.itemKey('target');
    const omnibox: Locator = searchOmnibox(page);
    await expect(omnibox).toBeVisible({ timeout: SEARCH_UI_WAIT_MS });

    await test.step('waitForEmbedded: the target has a vector; then alias the scenario query to it and switch to slow', async () => {
      await waitForEmbedded(page, [{ id: targetId, probeQuery: nextProbeQuery() }]);
      await fakeembedSetAliases({ [token]: documentInput(itemDocumentText(TARGET_NAME, null)) });
      await fakeembedSetMode('slow', { delayMs: SLOW_DELAY_MS });
    });

    let before: RowHandles = { keys: [], handles: new Map() };
    let activeKey = '';
    let activeDescendantId: string | null = null;

    await test.step('prefix query: lexical rows, ↓↓ activates the second row (before the scenario query exists)', async () => {
      await omnibox.focus();
      const lexLeg = waitForSuggestLegResponse(page, { q: prefixQuery, semantic: 0 });
      const nearLeg = waitForSuggestLegResponse(page, { q: prefixQuery, semantic: 1 });
      await typeKeys(page, prefixQuery);
      const [lexical, near] = await Promise.all([lexLeg, nearLeg]);
      expect(lexical.status).toBe(200);
      expect(near.status).toBe(200);
      expect(near.body.semantic, 'prefix near leg is served by the real provider').toBe(true);

      const keys = lexicalKeysFromBody(lexical.body);
      expect(keys, 'the three token items match the prefix query').toHaveLength(3);
      await expect.poll(async () => lexicalKeys(await readListbox(page)), { timeout: SEARCH_UI_WAIT_MS }).toEqual(keys);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      activeKey = keys[1] ?? '';
      expect(activeKey).not.toBe('');
      await expectActiveKey(page, activeKey);
      activeDescendantId = (await readListbox(page)).activeDescendantId;
      expect(activeDescendantId).not.toBeNull();
      before = await captureRowHandles(page);
      expect(before.keys.filter((k) => keys.includes(k))).toEqual(keys);
    });

    let lexicalOrder: string[] = [];
    await test.step('scenario query (new, never sent): lexical first, near arrives late, nothing re-mounts', async () => {
      const statsBefore = await fakeembedStats();
      const lexLeg = waitForSuggestLegResponse(page, { q: token, semantic: 0 });
      const nearLeg = waitForSuggestLegResponse(page, { q: token, semantic: 1 });
      await typeKeys(page, lastChar);
      const lexical = await lexLeg;
      expect(lexical.status).toBe(200);
      expect(lexical.body.near).toEqual([]);

      // Lexical leg landed, near leg still in flight (provider delay): rows are on screen, the pending line is up, there is
      // no near zone yet, and the rows of the previous generation are already the same nodes and still active.
      await expect(page.getByTestId('omnibox-status-near-pending')).toBeVisible({ timeout: SEARCH_UI_WAIT_MS });
      await expect(page.locator(NEAR_ZONE)).toHaveCount(0);
      await expect
        .poll(async () => lexicalKeys(await readListbox(page)), { timeout: SEARCH_UI_WAIT_MS })
        .toEqual(lexicalKeysFromBody(lexical.body));
      for (const key of before.keys) {
        const old = before.handles.get(key);
        if (!old) continue;
        expect(await isSameNode(page, old, key), 'a lexical row was re-mounted by the new generation').toBe(true);
      }
      await expectActiveKey(page, activeKey);

      const near = await nearLeg;
      expect(near.status).toBe(200);
      expect(near.body.semantic, 'near leg of the scenario query is served (slow, not degraded)').toBe(true);
      expect(near.body.near.map((n) => `${n.kind}:${n.id}`), 'the aliased target is the only near row').toEqual([targetKey]);
      // The provider path was really called for this brand-new query (N1/BE-15), before any late-near assert.
      await expect
        .poll(async () => (await fakeembedStats()).query_requests, {
          timeout: SEARCH_UI_WAIT_MS,
          message: 'fakeembed query_requests must grow: the scenario query was a cache miss that reached the provider',
        })
        .toBeGreaterThan(statsBefore.query_requests);

      // >= 1 near row first, then the stability assertions (never an empty green).
      await expect(page.locator(`${NEAR_ZONE} [data-opt-key="${targetKey}"]`)).toBeVisible({ timeout: SEARCH_UI_WAIT_MS });
      const info = await readListbox(page);
      expect(nearKeys(info)).toEqual([targetKey]);
      const zoneIds = info.zones.map((z) => z.id);
      expect(zoneIds.indexOf('near'), 'near zone sits right after the items zone').toBe(zoneIds.indexOf('items') + 1);

      lexicalOrder = lexicalKeys(info);
      expect(lexicalOrder).toEqual(lexicalKeysFromBody(lexical.body));
      expect(survivorsKeepOrder(before.keys, lexicalOrder), 'lexical order unchanged by the new query').toBe(true);
      expect(lexicalOrder).toHaveLength(before.keys.length);
      for (const key of lexicalOrder) {
        const old = before.handles.get(key);
        expect(old, 'every lexical row of the new query existed before it').toBeDefined();
        if (!old) continue;
        expect(await isSameNode(page, old, key), 'a lexical row was re-mounted by the late near zone').toBe(true);
      }
      await expectActiveKey(page, activeKey);
      expect((await readListbox(page)).activeDescendantId).toBe(activeDescendantId);
      await expect(page.locator(`#omni-listbox [data-opt-key="${activeKey}"]`)).toHaveAttribute('aria-selected', 'true');
    });

    await test.step('≈ off: near zone gone, lexical order and nodes unchanged, no near request', async () => {
      await recorder.flush();
      const mark = recorder.mark();
      await toggleSemanticSetting(page, false);
      await expect(page.locator(NEAR_ZONE)).toHaveCount(0, { timeout: SEARCH_UI_WAIT_MS });
      const info = await readListbox(page);
      expect(lexicalKeys(info)).toEqual(lexicalOrder);
      expect(nearKeys(info)).toEqual([]);
      for (const key of lexicalOrder) {
        const old = before.handles.get(key);
        if (!old) continue;
        expect(await isSameNode(page, old, key), 'turning ≈ off re-mounted a lexical row').toBe(true);
      }
      await recorder.flush();
      expect(
        recorder.suggestSince(mark, { withQuery: true }).filter((r) => queryParamOf(r, 'semantic') === '1'),
        'turning ≈ off must not send a near request',
      ).toHaveLength(0);
    });

    await test.step('≈ on again: near comes back (>= 1 row), lexical order and nodes still unchanged', async () => {
      const nearAgain = waitForSuggestLegResponse(page, { q: token, semantic: 1 });
      await toggleSemanticSetting(page, true);
      const near = await nearAgain;
      expect(near.status).toBe(200);
      expect(near.body.semantic).toBe(true);
      await expect(page.locator(`${NEAR_ZONE} [data-opt-key="${targetKey}"]`)).toBeVisible({ timeout: SEARCH_UI_WAIT_MS });
      const info = await readListbox(page);
      expect(nearKeys(info)).toEqual([targetKey]);
      expect(lexicalKeys(info)).toEqual(lexicalOrder);
      for (const key of lexicalOrder) {
        const old = before.handles.get(key);
        if (!old) continue;
        expect(await isSameNode(page, old, key), 'turning ≈ on re-mounted a lexical row').toBe(true);
      }
      await expectActiveKey(page, activeKey);
    });
  });
});
