import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { triggerFocusWake } from './content-acceptance-support';
import {
  A11Y_LANGS,
  A11Y_THEMES,
  CONTENT_A11Y_UI_WAIT_MS,
  a11yStep,
  bootstrapUnlockedUser,
  expectInputEmpty,
  expectInputEquals,
  type A11yLang,
  type A11yTheme,
} from './content-a11y-support';
import {
  SEARCH_LISTBOX_ID,
  SEARCH_OMNIBOX_SELECTOR,
  searchApiCreate,
  toggleSemanticSetting,
  waitForSuggestLegResponse,
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
import enMessages from '../messages/en.json';
import viMessages from '../messages/vi.json';
import { newContext, patchSettingsViaPage, uniqueEmail } from './helpers';

// Disable Playwright's automatic error-context DOM snapshot in this worker before any test runs
// (the omnibox draft may hold a typed value when a step fails).
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

/**
 * P05-T22 (22-1b) — search a11y on the REAL stack (`Content e2e`: this file name does not start with `content-a11y-`, so it is
 * not skipped and does not run in `Content a11y`; intended). Embedding provider `noop`: only lexical states.
 *
 * - axe (`wcag2a` + `wcag2aa`, 0 violations, nothing disabled) with the omnibox OPEN on lexical rows + create CTA, the `#` tags
 *   group, the no-match box, the `/search` page with "Load more" + result count, the 429 status line (stub on `GET /search`, the
 *   only stub), and settings `#timkiem` (server-off card), at 390 and 1440, in every lang x theme combination.
 * - the plan 2.8 rule 5 markup contract (one listbox, option only inside a labelled group, actions group last, visible status
 *   lines outside the listbox and outside any live region, no `role=status`/`aria-live` on them).
 * - a keyboard-only journey (`/`, ↓, Tab, Enter) in en-light.
 *
 * 22-2b (`@semantic`, second describe at the end of this file, job `Search semantic e2e (fake provider)`, real `fakeembed`, no
 * `page.route`; en-light + vi-dark only): axe + the rule 5 markup with the near zone (≈ badge, ArrowDown reaches a near row),
 * `omnibox-status-near-pending` (fakeembed `slow`, needs EMBEDDING_QUERY_TIMEOUT=5s, advisor-dec-338), `omnibox-status-degraded`
 * (`down`), the omnibox enable-409 line, and settings `#timkiem` with semantic available (409 status, then ON).
 */

const AXE_WIDTHS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;
const NIMBUS_COUNT = 25;
const NIMBUS_TAG = 'nimbus-prod';
const TAG_NAMES = ['network', 'ops', NIMBUS_TAG] as const;
const RATE_LIMIT_RETRY_AFTER_S = 7;

// ---------------------------------------------------------------------------------------------------------------------
// Seeding (real API; `searchApiCreate` is paced + replays 429 with the same Idempotency-Key)
// ---------------------------------------------------------------------------------------------------------------------

async function seedCorpus(page: Page): Promise<void> {
  const tagIds: Record<string, string> = {};
  for (const display of TAG_NAMES) {
    tagIds[display] = (await searchApiCreate<{ id: string }>(page, '/tags', { display })).id;
  }
  for (let n = 1; n <= NIMBUS_COUNT; n += 1) {
    const item = await searchApiCreate<{ id: string }>(page, '/items', { name: `nimbus ${String(n).padStart(2, '0')}` });
    if (n <= 2) {
      await searchApiCreate(page, `/items/${item.id}/tags`, { tag_ids: [tagIds[NIMBUS_TAG]!] });
    }
  }
  const viet = await searchApiCreate<{ id: string }>(page, '/items', { name: 'mã wifi nhà' });
  await searchApiCreate(page, `/items/${viet.id}/tags`, { tag_ids: [tagIds.network!] });
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------

const omniboxOf = (page: Page) => page.locator(SEARCH_OMNIBOX_SELECTOR);
const listboxOf = (page: Page) => page.locator(`#${SEARCH_LISTBOX_ID}`);

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

async function resetOmnibox(page: Page): Promise<void> {
  const omnibox = omniboxOf(page);
  await omnibox.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  await omnibox.blur();
  await expectInputEmpty(omnibox);
  await expect(listboxOf(page)).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
  await settle(page);
}

async function expectRowsSettled(page: Page, kind: 'item' | 'tag'): Promise<void> {
  const listbox = listboxOf(page);
  await expect(listbox).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
  await expect(listbox.locator(`[role="option"][data-opt-kind="${kind}"]`).first()).toBeVisible({
    timeout: CONTENT_A11Y_UI_WAIT_MS,
  });
  await expect(listbox).not.toHaveAttribute('aria-busy', 'true', { timeout: CONTENT_A11Y_UI_WAIT_MS });
}

/** axe with the P02/P03 tag set, nothing disabled; reports rule id, impact and CSS targets only (never node HTML). */
async function expectAxeClean(
  page: Page,
  label: string,
  include?: string,
): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']);
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  console.log(`axe ${label}: total=${results.violations.length}`);
  const detail = results.violations
    .map((v) => `${v.id} (${String(v.impact)}): ${v.nodes.map((n) => JSON.stringify(n.target)).join(' | ')}`)
    .join('; ');
  expect.soft(results.violations.length, `axe ${label}: ${detail}`).toBe(0);
}

/**
 * Plan 2.8 rule 5 + 2.24 item 3 markup contract for the OPEN dropdown. Structure only: never reads or prints a draft.
 */
async function expectListboxMarkup(page: Page, label: string): Promise<void> {
  const m = await page.evaluate((listboxId) => {
    const visible = (el: Element): boolean => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      return getComputedStyle(el).display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const listboxes = Array.from(document.querySelectorAll('[role="listbox"]')).filter(visible);
    const lb = document.getElementById(listboxId);
    const problems: string[] = [];
    if (listboxes.length !== 1) problems.push(`visible listboxes=${listboxes.length}`);
    if (!lb) return { problems: [...problems, 'no #omni-listbox'], options: 0, groups: 0 };

    const options = Array.from(lb.querySelectorAll('[role="option"]'));
    const groups = Array.from(lb.querySelectorAll('[role="group"]'));
    for (const opt of options) {
      const group = opt.closest('[role="group"]');
      if (!group || !lb.contains(group)) problems.push('option outside a group');
    }
    for (const group of groups) {
      const labelledBy = group.getAttribute('aria-labelledby');
      const heading = labelledBy ? document.getElementById(labelledBy) : null;
      if (!heading || (heading.textContent ?? '').trim() === '') problems.push('group without a labelling heading');
    }
    const actionOptions = options.filter((o) => ['create', 'more'].includes(o.getAttribute('data-opt-kind') ?? ''));
    const lastGroup = groups[groups.length - 1];
    for (const opt of actionOptions) {
      if (opt.closest('[role="group"]') !== lastGroup) problems.push('actions option not in the last group');
    }
    if (actionOptions.length > 0 && !(lastGroup?.getAttribute('aria-labelledby') ?? '').endsWith('-grp-actions-hdr')) {
      problems.push('last group is not the actions group');
    }
    const nonActionGroups = groups.filter((g) => g !== lastGroup || actionOptions.length === 0);
    for (const g of nonActionGroups) {
      if (Array.from(g.querySelectorAll('[role="option"]')).some((o) => ['create', 'more'].includes(o.getAttribute('data-opt-kind') ?? ''))) {
        problems.push('create/more option in a content group');
      }
    }

    const statusEls = Array.from(
      document.querySelectorAll('[data-testid^="omnibox-status-"], [data-testid="omnibox-result-count"]'),
    );
    for (const el of statusEls) {
      if (lb.contains(el)) problems.push('status line inside the listbox');
      if (el.closest('[role="status"], [role="alert"], [aria-live]')) problems.push('status line inside a live region');
      if (el.hasAttribute('role') || el.hasAttribute('aria-live')) problems.push('status line carries role/aria-live');
    }
    const live = document.querySelector('[data-testid="omnibox-live"]');
    if (!live) problems.push('omnibox-live missing');
    return { problems, options: options.length, groups: groups.length };
  }, SEARCH_LISTBOX_ID);
  expect.soft(m.problems, `listbox markup ${label}`).toEqual([]);
  expect.soft(m.options, `listbox markup ${label}: options`).toBeGreaterThan(0);
  expect.soft(m.groups, `listbox markup ${label}: groups`).toBeGreaterThan(0);
}

interface Ctx {
  readonly page: Page;
  readonly lang: A11yLang;
  readonly theme: A11yTheme;
}

/** Runs `open` at each axe width on a cold omnibox (the suggest limit is resolved at send time from the viewport width). */
async function sweepAxe(
  ctx: Ctx,
  state: string,
  open: (width: number) => Promise<void>,
  opts: { readonly markup?: boolean; readonly include?: string; readonly afterAxe?: () => Promise<void> } = {},
): Promise<void> {
  for (const { width, height } of AXE_WIDTHS) {
    await ctx.page.setViewportSize({ width, height });
    await settle(ctx.page);
    await resetOmnibox(ctx.page);
    await open(width);
    await settle(ctx.page);
    const label = `${state} ${ctx.lang}-${ctx.theme} ${width}`;
    if (opts.markup) await expectListboxMarkup(ctx.page, label);
    await expectAxeClean(ctx.page, label, opts.include);
    await opts.afterAxe?.();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Keyboard-only journey (en-light): `/`, ↓, Tab, Enter
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Asserts exactly one active option of `kind` (`aria-selected` + `data-opt-kind`) and that the textbox points at it through
 * `aria-activedescendant`. With `press`, sends one ArrowDown first. Returns the active option id.
 */
async function expectActiveOption(
  page: Page,
  kind: 'tag' | 'item',
  opts: { readonly press?: boolean } = {},
): Promise<string> {
  if (opts.press) await page.keyboard.press('ArrowDown');
  const active = listboxOf(page).locator('[role="option"][aria-selected="true"]');
  await expect(active).toHaveCount(1);
  await expect(active).toHaveAttribute('data-opt-kind', kind);
  const id = await active.getAttribute('id');
  expect(id, `active ${kind} option has an id`).toBeTruthy();
  await expect(omniboxOf(page)).toHaveAttribute('aria-activedescendant', id!);
  return id!;
}

async function runKeyboardJourney(page: Page): Promise<void> {
  const omnibox = omniboxOf(page);
  const listbox = listboxOf(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await resetOmnibox(page);

  // 1. `/` from a non-editable focus target opens the omnibox (and the recent dropdown), no pointer involved.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press('/');
  await expect(omnibox).toBeFocused({ timeout: CONTENT_A11Y_UI_WAIT_MS });
  await expectRowsSettled(page, 'item');
  await expect(omnibox).toHaveAttribute('aria-controls', SEARCH_LISTBOX_ID);
  await expectInputEmpty(omnibox);

  // 2. Typing keeps the textbox role contract; Tab with NO active row is the browser default (focus leaves, nothing filled).
  await page.keyboard.type('nim');
  await expectRowsSettled(page, 'item');
  await expect(omnibox).not.toHaveAttribute('aria-activedescendant');
  await page.keyboard.press('Tab');
  await expect(omnibox).not.toBeFocused();
  await expectInputEquals(omnibox, 'nim');

  // 3. `/` again (focus + select-all), type over the selection, ↓ activates a row, Tab fills `name: ` (add mode).
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press('/');
  await expect(omnibox).toBeFocused({ timeout: CONTENT_A11Y_UI_WAIT_MS });
  // `/` selects the old draft; delete it with a real key (deleteContentBackward) instead of typing over the selection.
  await page.keyboard.press('Backspace');
  await expectInputEmpty(omnibox);
  await page.keyboard.type('nim');
  await expectRowsSettled(page, 'item');
  // Group order is tags, then items: the first ↓ lands on the tag `nimbus-prod`, the second on the first item.
  const active = listbox.locator('[role="option"][aria-selected="true"]');
  await expectActiveOption(page, 'tag', { press: true });
  await page.keyboard.press('ArrowDown');
  await expectActiveOption(page, 'item');
  const activeName = (await active.locator('.omni-opt-title').first().textContent()) ?? '';
  expect(activeName).not.toBe('');
  await page.keyboard.press('Tab');
  await expectInputEquals(omnibox, `${activeName}: `);
  await expect(omnibox).toBeFocused();
  await expect(page.getByTestId('omnibox-add-preview')).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });

  // 4. Clear with the keyboard, search again, ↓ then Enter opens the active item.
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await expectInputEmpty(omnibox);
  await page.keyboard.type('nim');
  await expectRowsSettled(page, 'item');
  await expectActiveOption(page, 'tag', { press: true });
  await page.keyboard.press('ArrowDown');
  await expectActiveOption(page, 'item');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/app\/items\/[0-9a-f-]{36}$/, { timeout: CONTENT_A11Y_UI_WAIT_MS });
}

// ---------------------------------------------------------------------------------------------------------------------
// Test body
// ---------------------------------------------------------------------------------------------------------------------

async function runA11yGroup(
  browser: Browser,
  lang: A11yLang,
  theme: A11yTheme,
): Promise<void> {
  const label = `${lang}-${theme}`;
  const keyboard = lang === 'en' && theme === 'light';
  const context = await newContext(browser);
  try {
    const page = await context.newPage();
    const ctx: Ctx = { page, lang, theme };
    const omnibox = omniboxOf(page);
    const listbox = listboxOf(page);

    await a11yStep(`[search-a11y ${label}] signup, onboarding skip, locale/theme, seed corpus`, async () => {
      await bootstrapUnlockedUser(page, uniqueEmail(`content-search-a11y-${label}`), lang, theme);
      await expect(page.getByTestId('home-empty-state')).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
      await seedCorpus(page);
      await triggerFocusWake(page);
      await expect(page.getByTestId('rail-tag-item')).toHaveCount(TAG_NAMES.length, {
        timeout: CONTENT_A11Y_UI_WAIT_MS,
      });
    });

    await a11yStep(`[search-a11y ${label}] axe + markup: lexical rows, tags group, create CTA`, async () => {
      await sweepAxe(
        ctx,
        'suggest',
        async () => {
          await omnibox.focus();
          await page.keyboard.type('nim');
          await expectRowsSettled(page, 'item');
          await expect(listbox.locator('[role="option"][data-opt-kind="tag"]').first()).toBeVisible();
          await expect(listbox.locator('[role="option"][data-opt-kind="create"]')).toHaveCount(1);
          await page.keyboard.press('ArrowDown');
          await expect(listbox.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
        },
        { markup: true },
      );
    });

    await a11yStep(`[search-a11y ${label}] axe + markup: # mode tags group`, async () => {
      await sweepAxe(
        ctx,
        'tags',
        async () => {
          await omnibox.focus();
          await page.keyboard.type('#n');
          await expectRowsSettled(page, 'tag');
        },
        { markup: true },
      );
    });

    await a11yStep(`[search-a11y ${label}] axe: no match and tag no match`, async () => {
      await sweepAxe(ctx, 'empty', async () => {
        await omnibox.focus();
        await page.keyboard.type('zzqx');
        await expect(page.getByTestId('omnibox-search-empty')).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
      });
      await sweepAxe(ctx, 'tag-empty', async () => {
        await omnibox.focus();
        await page.keyboard.type('#zzqx');
        await expect(page.getByTestId('omnibox-tag-empty')).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
      });
    });

    await a11yStep(`[search-a11y ${label}] axe + markup: /search page with result count and Load more`, async () => {
      await sweepAxe(
        ctx,
        'more',
        async () => {
          await omnibox.focus();
          await page.keyboard.type('nimbus');
          await expectRowsSettled(page, 'item');
          await page.keyboard.press('Enter');
          await expect(page.getByTestId('omnibox-result-count')).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(listbox.locator('[role="option"][data-opt-kind="more"]')).toBeVisible({
            timeout: CONTENT_A11Y_UI_WAIT_MS,
          });
        },
        { markup: true },
      );
    });

    await a11yStep(`[search-a11y ${label}] axe + markup: 429 status line (stub on GET /search)`, async () => {
      await page.route('**/api/v1/search*', async (route) => {
        await route.fulfill({
          status: 429,
          headers: { 'retry-after': String(RATE_LIMIT_RETRY_AFTER_S) },
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'https://engram.zone17.click/problems/rate_limited',
            title: 'Too many requests',
            status: 429,
            code: 'rate_limited',
            retry_after: RATE_LIMIT_RETRY_AFTER_S,
          }),
        });
      });
      try {
        await sweepAxe(
          ctx,
          'rate-limited',
          async () => {
            await omnibox.focus();
            await page.keyboard.type('nim');
            await expectRowsSettled(page, 'item');
            await page.keyboard.press('Enter');
            await expect(page.getByTestId('omnibox-status-rate-limited')).toBeVisible({
              timeout: CONTENT_A11Y_UI_WAIT_MS,
            });
          },
          { markup: true },
        );
      } finally {
        await page.unroute('**/api/v1/search*');
      }
    });

    if (keyboard) {
      await a11yStep(`[search-a11y ${label}] keyboard-only journey: /, ArrowDown, Tab, Enter`, async () => {
        await runKeyboardJourney(page);
      });
    }

    // Last: a full navigation locks the in-memory vault key.
    await a11yStep(`[search-a11y ${label}] axe: settings #timkiem (server-off card)`, async () => {
      await page.goto('/app/settings#timkiem', { waitUntil: 'domcontentloaded', timeout: CONTENT_A11Y_UI_WAIT_MS });
      await expect(page.getByTestId('settings-semantic-card')).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
      await expect(page.getByTestId('settings-semantic-server-off')).toBeVisible();
      await expect(page.getByTestId('settings-semantic-switch')).toBeDisabled();
      for (const { width, height } of AXE_WIDTHS) {
        await page.setViewportSize({ width, height });
        await settle(page);
        await expectAxeClean(page, `settings-timkiem ${label} ${width}`, '#timkiem');
      }
    });
  } finally {
    await context.close();
  }
}

test.describe('P05-T22 search a11y (axe, markup contract, keyboard-only journey)', () => {
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  for (const lang of A11Y_LANGS) {
    for (const theme of A11Y_THEMES) {
      test(`search a11y: ${lang} ${theme}${lang === 'en' && theme === 'light' ? ' (+ keyboard journey)' : ''}`, async ({
        browser,
      }) => {
        test.setTimeout(300_000);
        await runA11yGroup(browser, lang, theme);
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// @semantic (22-2b): real fakeembed, job `Search semantic e2e (fake provider)`; `Content e2e` skips it (--grep-invert @semantic)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * How long the `slow` fake holds the provider answer (= how long `omnibox-status-near-pending` is on screen while axe runs). The API
 * query-embedding budget is `EMBEDDING_QUERY_TIMEOUT` (tei default 300 ms; a longer delay ends `degraded` and opens the breaker), so
 * the semantic job raises it to 5 s (ci.yml job `e2e-search-semantic`, advisor-dec-338). Keep this well under that 5 s.
 */
const PENDING_SLOW_DELAY_MS = 3_500;
const NEAR_TARGET_NAME = 'router closet shelf';
/** `tomorow` -> `tomorrow checklist`: word-similarity ~.70 fuzzy hit (same shape as `pasword`/`password`), aliased to the near target. */
const FUZZY_ITEM_NAME = 'tomorrow checklist';
const FUZZY_QUERY = 'tomorow';
/** Prefix of the fuzzy item (lexical row for the 409 pass). */
const PREFIX_QUERY = 'tomorrow';
const NEAR_ZONE_OPTIONS = '[data-zone="near"] [role="option"]';
const LEXICAL_ITEM_ROWS = '[data-zone="items"] [data-opt-kind="item"]';
/** The API breaker stays open 60 s (SPEC 6.6); polling for PATCH true waits it out. */
const BREAKER_RECOVERY_MAX_MS = 80_000;
const EMBEDDED_CHUNK = 5;

interface SemanticFixtures {
  readonly allIds: readonly string[];
  readonly pendingQueries: readonly string[];
  readonly downQueries: readonly string[];
}

/** Real-API fixtures: a near target, the fuzzy item, and per axe width a unique-token item (never-sent queries for slow/down). */
async function seedSemanticCorpus(page: Page): Promise<SemanticFixtures> {
  const ids: string[] = [];
  const create = async (name: string): Promise<void> => {
    ids.push((await searchApiCreate<{ id: string }>(page, '/items', { name })).id);
  };
  await create(NEAR_TARGET_NAME);
  await create(FUZZY_ITEM_NAME);
  const pendingQueries = AXE_WIDTHS.map(() => uniqueSemanticQuery('pend'));
  const downQueries = AXE_WIDTHS.map(() => uniqueSemanticQuery('down'));
  for (const query of [...pendingQueries, ...downQueries]) {
    await create(`${query} wallet`);
  }
  return { allIds: ids, pendingQueries, downQueries };
}

/** Every seeded item needs a vector before `slow`/`down` (otherwise the worker retries into a failing provider). */
async function waitForAllEmbedded(page: Page, ids: readonly string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += EMBEDDED_CHUNK) {
    await waitForEmbedded(
      page,
      ids.slice(i, i + EMBEDDED_CHUNK).map((id) => ({ id, probeQuery: nextProbeQuery() })),
    );
  }
}

/** >= 1 near row with the `≈` badge, and neither the pending nor the degraded line (never an empty green). */
async function expectNearShown(page: Page): Promise<void> {
  const near = listboxOf(page).locator(NEAR_ZONE_OPTIONS);
  await expect(near.first()).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
  expect(await near.count(), 'at least one near row').toBeGreaterThan(0);
  await expect(near.first().locator('.sugg-near-badge')).toBeVisible();
  await expect(page.getByTestId('omnibox-status-near-pending')).toHaveCount(0);
  await expect(page.getByTestId('omnibox-status-degraded')).toHaveCount(0);
}

/** Plan 2.9: ArrowDown walks tags, items, then near; the textbox points at the active near row through `aria-activedescendant`. */
async function expectArrowDownReachesNearRow(page: Page): Promise<void> {
  const active = listboxOf(page).locator('[data-zone="near"] [role="option"][aria-selected="true"]');
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('ArrowDown');
    if ((await active.count()) === 1) break;
  }
  await expect(active, 'ArrowDown must reach a near row').toHaveCount(1);
  const id = await active.getAttribute('id');
  expect(id, 'active near option has an id').toBeTruthy();
  await expect(omniboxOf(page)).toHaveAttribute('aria-activedescendant', id!);
}

async function clickEnableAndExpect409(page: Page): Promise<void> {
  const toggle = page.getByTestId('omnibox-semantic-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false', { timeout: CONTENT_A11Y_UI_WAIT_MS });
  const patched = page.waitForResponse(
    (res) => res.request().method() === 'PATCH' && new URL(res.url()).pathname === '/api/v1/me/settings',
    { timeout: CONTENT_A11Y_UI_WAIT_MS },
  );
  await toggle.click();
  expect((await patched).status(), 'PATCH semantic_suggest=true while the breaker is open').toBe(409);
  await expect(page.getByTestId('omnibox-status-enable409')).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
}

/**
 * Fake `ok`, wait out the 60 s API breaker by polling the real `PATCH semantic_suggest=true` (409 while it is open), then close
 * the breaker with one real semantic query so the next `@semantic` spec starts clean.
 */
async function recoverSemantic(page: Page): Promise<void> {
  await fakeembedSetMode('ok');
  const deadline = Date.now() + BREAKER_RECOVERY_MAX_MS;
  for (;;) {
    const res = await patchSettingsViaPage(page, { semantic_suggest: true });
    if (res.status === 200) break;
    if (Date.now() >= deadline) {
      throw new Error(`semantic did not recover: PATCH semantic_suggest=true still ${res.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const probe = await suggestSemanticViaPage(page, uniqueSemanticQuery('rec'));
    if (probe.status === 200 && (probe.body as { semantic?: boolean } | null)?.semantic === true) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('semantic did not return after the breaker window');
}

/**
 * RV-T22-2-FE1-1: types `query` so that the provider-stats baseline belongs to `query` itself. The prefix (`query` minus its last
 * character) is typed while the fake is still `ok` and its `semantic=1` leg is awaited, so no earlier keystroke leg can still
 * reach the fake later. Only then is the scenario mode set and the baseline read; the last character sends the scenario query,
 * its `semantic=1` request is awaited, and `query_requests` must grow. `down` is switched on here too: with the API breaker
 * threshold 1, a `down` prefix leg would open the breaker and the scenario query would never reach the fake.
 */
async function typeScenarioQueryPinned(page: Page, query: string, setScenarioMode: () => Promise<void>): Promise<void> {
  const omnibox = omniboxOf(page);
  const prefix = query.slice(0, -1);
  const prefixNear = waitForSuggestLegResponse(page, { q: prefix, semantic: 1 }, CONTENT_A11Y_UI_WAIT_MS);
  await omnibox.focus();
  await page.keyboard.type(prefix);
  expect((await prefixNear).status, 'prefix near leg (fake still ok)').toBe(200);
  await setScenarioMode();
  const before = await fakeembedStats();
  const scenarioNear = page.waitForRequest(
    (req) => {
      const url = new URL(req.url());
      return (
        req.method() === 'GET' &&
        url.pathname === '/api/v1/suggest' &&
        url.searchParams.get('q') === query &&
        url.searchParams.get('semantic') === '1'
      );
    },
    { timeout: CONTENT_A11Y_UI_WAIT_MS },
  );
  await page.keyboard.type(query.slice(-1));
  await scenarioNear;
  // The provider path was really called for the scenario query (cache miss) before anything is asserted about near/degraded.
  await expect
    .poll(async () => (await fakeembedStats()).query_requests, { timeout: CONTENT_A11Y_UI_WAIT_MS })
    .toBeGreaterThan(before.query_requests);
}

/** Set by the test body; read by the describe `afterEach` when the body's own `finally` did not get to run (e.g. a timeout). */
const semanticCleanup: { page: Page | null; cookies: Awaited<ReturnType<BrowserContext['cookies']>> } = {
  page: null,
  cookies: [],
};

/**
 * RV-T22-2-FE1-2: the describe-level safety net (same contract as the stable/degrade specs). Always puts the shared fake back to
 * `ok`; after a failed run it also waits out the API breaker (`recoverSemantic`, bounded by BREAKER_RECOVERY_MAX_MS) with the
 * test user's session: on the test's own page if the body was abandoned before closing it, else on a short-lived context that
 * carries that user's cookies.
 */
async function semanticAfterEach(browser: Browser, testInfo: TestInfo): Promise<void> {
  const { page: tracked, cookies } = semanticCleanup;
  semanticCleanup.page = null;
  semanticCleanup.cookies = [];
  await fakeembedReset();
  const leftOpen = tracked !== null && !tracked.isClosed() ? tracked : null;
  if (testInfo.status === testInfo.expectedStatus) {
    await leftOpen?.context().close().catch(() => undefined);
    return;
  }
  let context: BrowserContext | null = leftOpen?.context() ?? null;
  try {
    let page: Page;
    if (leftOpen !== null) {
      page = leftOpen;
    } else {
      if (cookies.length === 0) return;
      context = await newContext(browser);
      await context.addCookies(cookies);
      page = await context.newPage();
      await page.goto('/api/v1/healthz', { waitUntil: 'domcontentloaded', timeout: CONTENT_A11Y_UI_WAIT_MS });
    }
    await recoverSemantic(page);
  } catch {
    // no session to recover with, or the breaker outlived the bound: the next spec's own setup reports it
  } finally {
    await context?.close().catch(() => undefined);
  }
}

async function runSemanticA11yGroup(browser: Browser, lang: A11yLang, theme: A11yTheme): Promise<void> {
  const label = `${lang}-${theme}`;
  const messages = lang === 'vi' ? viMessages : enMessages;
  const context = await newContext(browser);
  let breakerMayBeOpen = false;
  let page: Page | null = null;
  try {
    page = await context.newPage();
    const live = page;
    const ctx: Ctx = { page: live, lang, theme };
    const omnibox = omniboxOf(live);
    const listbox = listboxOf(live);
    let fixtures!: SemanticFixtures;
    const widthIdx = (width: number): number => AXE_WIDTHS.findIndex((w) => w.width === width);

    await a11yStep(`[search-a11y-sem ${label}] signup, locale/theme, seed, waitForEmbedded, aliases`, async () => {
      semanticCleanup.page = live;
      await bootstrapUnlockedUser(live, uniqueEmail(`content-search-a11y-sem-${label}`), lang, theme);
      semanticCleanup.cookies = await context.cookies();
      await expect(live.getByTestId('home-empty-state')).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
      fixtures = await seedSemanticCorpus(live);
      // seed -> waitForEmbedded -> (slow | down) -> type (plan Task 22, N1); probe queries are never typed below.
      await waitForAllEmbedded(live, fixtures.allIds);
      const targetDocument = documentInput(itemDocumentText(NEAR_TARGET_NAME, null));
      const aliases: Record<string, string> = { [FUZZY_QUERY]: targetDocument };
      for (const q of fixtures.pendingQueries) aliases[q] = targetDocument;
      await fakeembedSetAliases(aliases);
      await expect(live.getByTestId('omnibox-semantic-toggle')).toHaveAttribute('aria-pressed', 'true', {
        timeout: CONTENT_A11Y_UI_WAIT_MS,
      });
    });

    await a11yStep(`[search-a11y-sem ${label}] axe + markup: near zone with ≈ badge, ArrowDown reaches a near row`, async () => {
      await sweepAxe(
        ctx,
        'near',
        async () => {
          await omnibox.focus();
          await live.keyboard.type(FUZZY_QUERY);
          await expect(listbox.locator(LEXICAL_ITEM_ROWS).filter({ hasText: FUZZY_ITEM_NAME })).toHaveCount(1, {
            timeout: CONTENT_A11Y_UI_WAIT_MS,
          });
          await expectNearShown(live);
          await expectArrowDownReachesNearRow(live);
        },
        { markup: true },
      );
    });

    await a11yStep(`[search-a11y-sem ${label}] axe + markup: near-pending line (slow ${PENDING_SLOW_DELAY_MS} ms)`, async () => {
      const pending = live.getByTestId('omnibox-status-near-pending');
      try {
        await sweepAxe(
          ctx,
          'near-pending',
          async (width) => {
            // Prefix with the fake `ok`, then `slow`, baseline, last char: stats pinned to the scenario query (RV-T22-2-FE1-1).
            await fakeembedSetMode('ok');
            await typeScenarioQueryPinned(live, fixtures.pendingQueries[widthIdx(width)]!, () =>
              fakeembedSetMode('slow', { delayMs: PENDING_SLOW_DELAY_MS }),
            );
            await expect(pending).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
            await expect(listbox.locator(LEXICAL_ITEM_ROWS)).toHaveCount(1);
            await expect(live.locator('[data-zone="near"]')).toHaveCount(0);
          },
          {
            markup: true,
            // Scoped to the popover: the full-page axe run is too slow for the pending window.
            include: '#omni-pop',
            afterAxe: async () => {
              // axe + markup ran while the line was still on screen, and the late near zone does arrive (>= 1 near row).
              await expect(pending, 'axe must have run inside the near-pending window').toBeVisible();
              await expectNearShown(live);
            },
          },
        );
      } finally {
        await fakeembedSetMode('ok');
      }
    });

    // ---- one 60 s API breaker window: degraded -> omnibox enable-409 -> settings 409 (settings last: a full navigation
    // locks the in-memory vault key), then recovery and settings ON. ----
    const breaker = { openedAt: 0 };
    await a11yStep(`[search-a11y-sem ${label}] axe + markup: degraded line (down)`, async () => {
      breakerMayBeOpen = true;
      const degraded = live.getByTestId('omnibox-status-degraded');
      await sweepAxe(
        ctx,
        'degraded',
        async (width) => {
          const idx = widthIdx(width);
          if (idx === 0) {
            // First down query: prefix with the fake `ok`, then `down`, baseline, last char, so the scenario query itself is the
            // cache miss that reaches the fake and opens the breaker (RV-T22-2-FE1-1). Later widths hit the open breaker.
            await typeScenarioQueryPinned(live, fixtures.downQueries[idx]!, () => fakeembedSetMode('down'));
            breaker.openedAt = Date.now();
          } else {
            await omnibox.focus();
            await live.keyboard.type(fixtures.downQueries[idx]!);
          }
          await expect(degraded).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(listbox.locator(LEXICAL_ITEM_ROWS)).toHaveCount(1);
          await expect(live.locator('[data-zone="near"]')).toHaveCount(0);
        },
        { markup: true },
      );
    });

    await a11yStep(`[search-a11y-sem ${label}] axe + markup: omnibox enable-409 line`, async () => {
      await sweepAxe(
        ctx,
        'enable409',
        async () => {
          await omnibox.focus();
          await live.keyboard.type(PREFIX_QUERY);
          await expect(listbox.locator('[role="option"][data-opt-kind="create"]')).toHaveCount(1, {
            timeout: CONTENT_A11Y_UI_WAIT_MS,
          });
          const toggle = live.getByTestId('omnibox-semantic-toggle');
          if ((await toggle.getAttribute('aria-pressed')) === 'true') {
            // PATCH false always succeeds; a refused enable never flips the stored value back on.
            await toggleSemanticSetting(live, false);
          }
          await clickEnableAndExpect409(live);
        },
        { markup: true },
      );
    });

    await a11yStep(`[search-a11y-sem ${label}] axe: settings #timkiem, semantic available (409 status, then ON)`, async () => {
      await live.goto('/app/settings#timkiem', { waitUntil: 'domcontentloaded', timeout: CONTENT_A11Y_UI_WAIT_MS });
      await expect(live.getByTestId('settings-semantic-card')).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
      await expect(live.getByTestId('settings-semantic-server-off')).toHaveCount(0);
      const toggle = live.getByTestId('settings-semantic-switch');
      await expect(toggle).toBeEnabled();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      const patched = live.waitForResponse(
        (res) => res.request().method() === 'PATCH' && new URL(res.url()).pathname === '/api/v1/me/settings',
        { timeout: CONTENT_A11Y_UI_WAIT_MS },
      );
      await toggle.click();
      expect(
        (await patched).status(),
        `PATCH semantic_suggest=true while the breaker is open (${Date.now() - breaker.openedAt} ms after it opened; window 60000)`,
      ).toBe(409);
      await expect(live.getByTestId('settings-semantic-status')).toHaveText(messages.settings.search.semanticEnable409);
      for (const { width, height } of AXE_WIDTHS) {
        await live.setViewportSize({ width, height });
        await settle(live);
        await expectAxeClean(live, `settings-timkiem-409 ${label} ${width}`, '#timkiem');
      }

      await recoverSemantic(live);
      breakerMayBeOpen = false;
      await live.reload({ waitUntil: 'domcontentloaded', timeout: CONTENT_A11Y_UI_WAIT_MS });
      await expect(live.getByTestId('settings-semantic-card')).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
      await expect(toggle).toBeEnabled();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(live.locator('[data-testid^="settings-semantic-copy-"]')).toBeVisible();
      for (const { width, height } of AXE_WIDTHS) {
        await live.setViewportSize({ width, height });
        await settle(live);
        await expectAxeClean(live, `settings-timkiem-on ${label} ${width}`, '#timkiem');
      }
    });
  } finally {
    await fakeembedReset().catch(() => undefined);
    if (breakerMayBeOpen && page !== null) {
      await recoverSemantic(page).catch(() => undefined);
    }
    await context.close();
  }
}

test.describe('P05-T22 @semantic search a11y (near, near-pending, degraded, enable-409, #timkiem)', () => {
  // Local runs without the stack skip. In CI this never skips (a misconfigured semantic job must go red, not green-by-skip).
  test.skip(!process.env.E2E_STACK && !process.env.CI, 'needs the semantic-fake compose stack (E2E_STACK=1)');

  // The fake is shared by every @semantic spec of the job: never leave it `slow`/`down`, and after a FAILED run wait out the API
  // breaker even when a timeout abandoned the body's `finally` (RV-T22-2-FE1-2, same contract as the stable/degrade specs).
  test.afterEach(async ({ browser }, testInfo) => {
    await semanticAfterEach(browser, testInfo);
  });

  for (const lang of A11Y_LANGS) {
    for (const theme of A11Y_THEMES) {
      // en-light and vi-dark only (both langs, both themes): keeps the semantic job under its 30 min ceiling.
      if (!((lang === 'en' && theme === 'light') || (lang === 'vi' && theme === 'dark'))) continue;
      test(`@semantic search a11y: ${lang} ${theme} (near, ArrowDown, near-pending, degraded, enable-409, settings)`, async ({
        browser,
      }) => {
        test.setTimeout(480_000);
        await runSemanticA11yGroup(browser, lang, theme);
      });
    }
  }
});
