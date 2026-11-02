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
  typeKeys,
  waitForSuggestResponse,
  type SuggestCapture,
} from './content-search-support';

// Disable Playwright's automatic error-context DOM snapshot in this worker before any test runs.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

/**
 * P05 Task 22 (22-1a) stable merge, LEXICAL half, real stack (embedding provider `noop`, no near rows ever).
 *
 * Plan 2.8 rule 1 says a new query keeps the rows it already shows until the first full response of the new generation,
 * keeps `activeKey` when its `(kind, id)` is still in the new snapshot and otherwise clears it without auto-activating the
 * first row, and that React keys are `kind:id`, so a surviving row is the same DOM node.
 *
 * // 22-2: the `@semantic` half is NOT here. It belongs to PR 22-2 (job `e2e-search-semantic`, real `fakeembed`):
 * //   - `fakeembed` `slow` + a brand-new unique query (alias to a target so a near row exists, `/__control/stats` query
 * //     counter must rise >= 1, N1) makes the near zone arrive late; the `elementHandle` of every lexical row must be
 * //     unchanged and `activeKey` kept (plan Task 22 `content-search-stable`, `@semantic`);
 * //   - toggling the ≈ button on/off must not reorder the lexical rows.
 * //   Import `waitForEmbedded` from `content-search-semantic-support.ts` (PR 20b-1) and follow seed -> waitForEmbedded ->
 * //   slow -> type. Tag those tests `@semantic`.
 *
 * Every query below is typed once per user: responses are cached client-side for 30 s (plan 2.7), a second typing would not
 * hit the network and the response wait would time out.
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
