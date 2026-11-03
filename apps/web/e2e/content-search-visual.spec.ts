import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
  type TestInfo,
} from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { triggerFocusWake } from './content-acceptance-support';
import {
  A11Y_LANGS,
  A11Y_THEMES,
  CONTENT_A11Y_UI_WAIT_MS,
  a11yStep,
  attachPlaintextLeakGuard,
  bootstrapUnlockedUser,
  expectInputEmpty,
  expectInputEquals,
  measureCoarseTouchTargets,
  newCoarseTouchContext,
  setQuietValue,
  unlockLockedAppPage,
  type A11yLang,
  type A11yTheme,
} from './content-a11y-support';
import enMessages from '../messages/en.json';
import viMessages from '../messages/vi.json';
import {
  SEARCH_LISTBOX_ID,
  SEARCH_OMNIBOX_SELECTOR,
  SEARCH_QUIET_WINDOW_MS,
  grantClipboard,
  pasteIntoOmnibox,
  searchApiCreate,
  toggleSemanticSetting,
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
import { fetchMeViaPage, newContext, patchSettingsViaPage, uniqueEmail } from './helpers';

// Disable Playwright's automatic error-context DOM snapshot in this worker before any test runs
// (the omnibox / quick-add draft may hold a typed value when a step fails).
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

/**
 * P05-T22 (22-1b) — search dropdown visual captures + computable asserts on the REAL stack (`Content e2e`, embedding provider
 * `noop`, server semantic off). Screenshots are capture + reviewer review (no `toHaveScreenshot`); the asserts are the FS-20
 * computable ones: dropdown rows >= 44 px (also with a real `pointer: coarse` context), the `data-theme=dark` token through
 * computed style, no horizontal scroll at 390 px, `+N` chip counts per breakpoint.
 *
 * The corpus is seeded through the real API (`POST /items`, `POST /tags`, `POST /items/{id}/tags`). The only stubs are a 429 on
 * `GET /search` (the muted rate-limit line only shows on Enter / "load more", plan 2.6) and a HELD `route.continue()` (real
 * response body) on `GET /suggest` to hold the first query long enough to capture the skeleton (plan 2.10).
 *
 * Captures: `content-search-<state>-<lang>-<theme>-<width>.png`, registered in `scripts/sanitize-e2e-artifacts.mjs`.
 * Core states run in every lang x theme combination; the edge states (`skeleton`, `more`, `more-page2`, `rate-limited`,
 * `undo-toast`) run in `EDGE_COMBOS` only, to keep `Content e2e` (30 min ceiling, gate 10) small.
 *
 * 22-2b (`@semantic`, job `Search semantic e2e (fake provider)`, real `fakeembed`, no `page.route`): the second describe at the end
 * of this file captures the near zone with the ≈ badge and a fuzzy marker, ≈ off, near-pending (`slow`), degraded (`down`), the
 * omnibox enable-409 line and settings `#timkiem` (semantic available, and its 409 status). The enable-409 UI IS reachable on that
 * stack without a stub: provider `down` + one semantic query opens the API breaker for 60 s, and `PATCH semantic_suggest=true`
 * is then refused with 409 (`Runtime.IsBreakerOpen`, auth/service.go). Those tests run for EDGE_COMBOS only (en-light, vi-dark).
 * On the noop stack (the first describe) only the real `PATCH true -> 409` API contract is asserted.
 */

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
] as const;
type Width = (typeof WIDTHS)[number]['width'];

/** Combinations that also run the edge states (both langs, both themes between them). */
const EDGE_COMBOS: ReadonlySet<string> = new Set(['en-light', 'vi-dark']);

const MULTI_TAG_ITEM = 'zephyr multitag';
const MULTI_TAG_QUERY = 'zeph';
const MULTI_TAG_NAMES = ['network', 'ops', 'staging', 'edge', 'core'] as const;
const NIMBUS_COUNT = 25;
const NIMBUS_TAG = 'nimbus-prod';
const SEED_TAG_NAMES = [...MULTI_TAG_NAMES, NIMBUS_TAG] as const;
/** Draft texts that are public fixture strings (never masked in a capture). */
const PUBLIC_DRAFTS: readonly string[] = ['nim', 'nimbus', 'zeph', 'zzqx', '#n', '#zzqx'];
const RATE_LIMIT_RETRY_AFTER_S = 7;
const TOAST_ITEM_NAME = 'undo fixture';
/** Public fixture string pasted for the `tainted` state (also in PUBLIC_DRAFTS, so the capture does not mask it). */
const TAINTED_PASTE = 'nimbus';

function isEdge(lang: A11yLang, theme: A11yTheme): boolean {
  return EDGE_COMBOS.has(`${lang}-${theme}`);
}

function searchCaptureName(
  state: string,
  lang: A11yLang,
  theme: A11yTheme,
  width: number,
): string {
  return `content-search-${state}-${lang}-${theme}-${width}.png`;
}

interface CaptureContext {
  readonly page: Page;
  readonly testInfo: TestInfo;
  readonly lang: A11yLang;
  readonly theme: A11yTheme;
}

// ---------------------------------------------------------------------------------------------------------------------
// Seeding (real API, paced + 429 replay in content-search-support)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Creates the fixture corpus through the real API. `searchApiCreate` (content-search-support) paces every write under the
 * 10 writes / 1 s `content_write` limit and replays a 429 with the same Idempotency-Key. Never logs a body.
 */
async function seedCorpus(page: Page): Promise<void> {
  const tagIds: Record<string, string> = {};
  for (const display of SEED_TAG_NAMES) {
    tagIds[display] = (await searchApiCreate<{ id: string }>(page, '/tags', { display })).id;
  }
  const multi = await searchApiCreate<{ id: string }>(page, '/items', { name: MULTI_TAG_ITEM });
  await searchApiCreate(page, `/items/${multi.id}/tags`, { tag_ids: MULTI_TAG_NAMES.map((n) => tagIds[n]!) });
  for (let n = 1; n <= NIMBUS_COUNT; n += 1) {
    const item = await searchApiCreate<{ id: string }>(page, '/items', { name: `nimbus ${String(n).padStart(2, '0')}` });
    if (n === 1 || n === 2) {
      const ids = n === 1 ? [tagIds[NIMBUS_TAG]!] : [tagIds[NIMBUS_TAG]!, tagIds.ops!];
      await searchApiCreate(page, `/items/${item.id}/tags`, { tag_ids: ids });
    }
  }
  const viet = await searchApiCreate<{ id: string }>(page, '/items', { name: 'mã wifi nhà' });
  await searchApiCreate(page, `/items/${viet.id}/tags`, { tag_ids: [tagIds.network!] });
  await searchApiCreate(page, '/items', { name: 'wifi guest' });
}

// ---------------------------------------------------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------------------------------------------------

function omniboxOf(page: Page): Locator {
  return page.locator(SEARCH_OMNIBOX_SELECTOR);
}

function listboxOf(page: Page): Locator {
  return page.locator(`#${SEARCH_LISTBOX_ID}`);
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

async function setWidth(page: Page, width: Width): Promise<void> {
  const size = WIDTHS.find((w) => w.width === width)!;
  await page.setViewportSize({ width: size.width, height: size.height });
  await settle(page);
}

/** Empties the draft with real keys, closes the dropdown and blurs, so the next interaction starts cold. */
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

/** Types a CLEAN query with real key events and waits until the listbox holds settled (non-busy) rows. */
async function typeQuery(page: Page, text: string): Promise<void> {
  const omnibox = omniboxOf(page);
  await omnibox.focus();
  await omnibox.pressSequentially(text);
}

async function expectRowsSettled(page: Page, kind: 'item' | 'tag'): Promise<void> {
  const listbox = listboxOf(page);
  await expect(listbox).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
  await expect(listbox.locator(`[role="option"][data-opt-kind="${kind}"]`).first()).toBeVisible({
    timeout: CONTENT_A11Y_UI_WAIT_MS,
  });
  await expect(listbox).not.toHaveAttribute('aria-busy', 'true', { timeout: CONTENT_A11Y_UI_WAIT_MS });
}

/**
 * VIS-T22-2-1 (visual-T22-1-r2): a non-empty draft must show suggest rows, never the empty-draft recents. The create CTA exists
 * only for suggest/search snapshots (`showCreate = !isRecent && ...`), and the first group heading must not be a recents heading.
 */
async function expectSuggestRowsNotRecent(page: Page, lang: A11yLang): Promise<void> {
  const group = (lang === 'vi' ? viMessages : enMessages).search.group;
  const listbox = listboxOf(page);
  await expect(listbox.locator('[role="option"][data-opt-kind="create"]')).toHaveCount(1, {
    timeout: CONTENT_A11Y_UI_WAIT_MS,
  });
  const firstHeading = listbox.locator('[role="group"] .sugg-group').first();
  await expect(firstHeading).not.toHaveText(group.recentItems);
  await expect(firstHeading).not.toHaveText(group.recentTags);
}

async function expectServerOffStack(page: Page): Promise<void> {
  const me = await fetchMeViaPage(page);
  const features = (me.body as { features?: { semantic_available?: boolean } } | null)?.features;
  expect(me.status).toBe(200);
  expect(
    features?.semantic_available,
    'the Content e2e stack runs the noop embedding provider: semantic_available must be false',
  ).toBe(false);
  await expect(page.getByTestId('omnibox-semantic-toggle')).toHaveCount(0);
  await expect(page.getByTestId('omnibox-status-near-pending')).toHaveCount(0);
  await expect(page.getByTestId('omnibox-status-degraded')).toHaveCount(0);
}

// ---------------------------------------------------------------------------------------------------------------------
// Computable asserts (FS-20)
// ---------------------------------------------------------------------------------------------------------------------

async function expectNoHorizontalScroll(ctx: CaptureContext, state: string, width: number): Promise<void> {
  const m = await ctx.page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect
    .soft(
      m.scrollWidth,
      `horizontal scroll ${state} ${ctx.lang}-${ctx.theme} ${width}: scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth}`,
    )
    .toBeLessThanOrEqual(m.clientWidth);
}

/** Every visible dropdown row is >= 44 px tall (`.omni-listbox .sugg-row { min-height: 44px }`, plan 2.9). */
async function expectRowsAtLeast44(
  ctx: CaptureContext,
  state: string,
  width: number,
  opts: { readonly requireRows?: boolean } = {},
): Promise<void> {
  const m = await ctx.page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('#omni-listbox .sugg-row')).filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    });
    return { count: rows.length, min: Math.min(...rows.map((el) => el.getBoundingClientRect().height)) };
  });
  if (opts.requireRows) {
    // A renamed `.sugg-row` class would otherwise turn every >= 44 px assert vacuous (RV-T22-1-FE1-10).
    expect.soft(m.count, `dropdown rows ${state} ${ctx.lang}-${ctx.theme} ${width}: no .sugg-row found`).toBeGreaterThan(0);
  }
  if (m.count === 0) return;
  expect
    .soft(m.min, `dropdown row height ${state} ${ctx.lang}-${ctx.theme} ${width}: min ${m.min}px`)
    .toBeGreaterThanOrEqual(43.5);
}

/**
 * Dark-theme token through computed style (FS-20): `<html data-theme>` matches, `--canvas` resolves (as a computed colour) to the
 * theme's literal token, and the active dropdown row paints `--surface-alt` (dark) / `--pale-accent` (light). Needs an active option.
 */
async function expectThemeTokens(page: Page, theme: A11yTheme): Promise<void> {
  const m = await page.evaluate(() => {
    const resolveBg = (token: string): string => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = `var(${token})`;
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    };
    const active = document.querySelector<HTMLElement>('#omni-listbox .sugg-row[aria-selected="true"]');
    return {
      dataTheme: document.documentElement.getAttribute('data-theme'),
      canvas: resolveBg('--canvas'),
      activeBg: active ? getComputedStyle(active).backgroundColor : null,
      surfaceAlt: resolveBg('--surface-alt'),
      paleAccent: resolveBg('--pale-accent'),
    };
  });
  expect(m.dataTheme).toBe(theme);
  // Computed colour, not the raw custom-property text: the production CSS minifies `#FFFFFF` to `#FFF` (RV-T22-1-FE1-4).
  expect(m.canvas).toBe(theme === 'dark' ? 'rgb(22, 22, 22)' : 'rgb(255, 255, 255)');
  expect(m.activeBg, 'an active dropdown row is required for the token check').not.toBeNull();
  expect(m.activeBg).toBe(theme === 'dark' ? m.surfaceAlt : m.paleAccent);
}

/** `+N` chips (FU-T22-VIS item 7): <= 3 chips + `.chip-more-desktop` at >= 768, <= 2 chips + `.chip-more-mobile` at 390. */
async function expectChipCounts(page: Page, width: Width): Promise<void> {
  const m = await page.evaluate(() => {
    const visible = (el: Element): boolean => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      return getComputedStyle(el).display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const row = Array.from(document.querySelectorAll<HTMLElement>('#omni-listbox [data-opt-kind="item"]')).find(
      (el) => el.querySelector('.chip-more-desktop, .chip-more-mobile') !== null,
    );
    if (!row) return null;
    return {
      chips: Array.from(row.querySelectorAll('.dup-chip')).filter(visible).length,
      desktopMore: Array.from(row.querySelectorAll('.chip-more-desktop')).filter(visible).map((e) => e.textContent ?? ''),
      mobileMore: Array.from(row.querySelectorAll('.chip-more-mobile')).filter(visible).map((e) => e.textContent ?? ''),
    };
  });
  expect(m, 'an item row with more than 3 tags must be in the dropdown').not.toBeNull();
  if (width >= 768) {
    expect(m!.chips).toBe(3);
    expect(m!.desktopMore).toEqual(['+2']);
    expect(m!.mobileMore).toEqual([]);
  } else {
    expect(m!.chips).toBe(2);
    expect(m!.mobileMore).toEqual(['+3']);
    expect(m!.desktopMore).toEqual([]);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------------------------------------------------

const MASKED_TEXT_STYLE = `[data-visual-mask], [data-visual-mask] * {
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  text-shadow: none !important;
  caret-color: transparent !important;
}
`;

/** Saves one allowlisted capture. The omnibox draft is shown only when it is a public fixture string; anything else is masked. */
async function saveCapture(
  ctx: CaptureContext,
  state: string,
  width: number,
  target?: Locator,
): Promise<void> {
  const { page, testInfo, lang, theme } = ctx;
  await page.evaluate((publicDrafts) => {
    for (const ta of Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea'))) {
      if (ta.value !== '' && !publicDrafts.includes(ta.value)) {
        ta.setAttribute('data-visual-mask', 'true');
      } else {
        ta.removeAttribute('data-visual-mask');
      }
    }
  }, PUBLIC_DRAFTS);
  const fileName = searchCaptureName(state, lang, theme, width);
  const outputPath = testInfo.outputPath(fileName);
  mkdirSync(dirname(outputPath), { recursive: true });
  const options = {
    path: outputPath,
    timeout: 30_000,
    animations: 'disabled' as const,
    caret: 'hide' as const,
    style: MASKED_TEXT_STYLE,
    mask: [page.locator('[data-visual-mask]')],
  };
  const buffer = target
    ? await target.screenshot(options)
    : await page.screenshot({ ...options, fullPage: false });
  expect.soft(buffer.byteLength, `screenshot ${fileName}`).toBeGreaterThan(0);
}

/**
 * Scrolls `target` inside the popover (`#omni-pop`) and hard-asserts that its box lies inside both the popover box and the
 * viewport, so a capture cannot pass while the element is clipped (VIS-T22-1-1/2: `toBeVisible()` is true for a clipped row).
 */
async function scrollIntoPopoverAndAssertFramed(page: Page, target: Locator, label: string): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  const pop = await page.locator('#omni-pop').boundingBox();
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  expect(box, `${label} must have a box`).not.toBeNull();
  expect(pop, '#omni-pop must have a box').not.toBeNull();
  if (!box || !pop) return;
  expect(box.y, `${label} top must be inside #omni-pop`).toBeGreaterThanOrEqual(pop.y - 0.5);
  expect(box.y + box.height, `${label} bottom must be inside #omni-pop`).toBeLessThanOrEqual(pop.y + pop.height + 0.5);
  expect(box.y, `${label} top must be inside the viewport`).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, `${label} bottom must be inside the viewport`).toBeLessThanOrEqual(viewportHeight);
}

/**
 * Runs `interact` once per width on a cold omnibox (the suggest limit is resolved at send time from the viewport width, so the
 * 390 px capture must come from a request made at 390 px), then asserts and captures.
 */
async function sweepWidths(
  ctx: CaptureContext,
  state: string,
  interact: (width: Width) => Promise<void>,
  opts: {
    readonly widths?: readonly Width[];
    readonly after?: (width: Width) => Promise<void>;
    readonly target?: Locator;
    readonly cleanup?: (width: Width) => Promise<void>;
    /** Row-bearing states: fail (not pass vacuously) when the dropdown holds no `.sugg-row`. */
    readonly requireRows?: boolean;
  } = {},
): Promise<void> {
  const widths = opts.widths ?? WIDTHS.map((w) => w.width);
  for (const width of widths) {
    await setWidth(ctx.page, width);
    await resetOmnibox(ctx.page);
    await interact(width);
    await settle(ctx.page);
    await expectNoHorizontalScroll(ctx, state, width);
    await expectRowsAtLeast44(ctx, state, width, { requireRows: opts.requireRows });
    await opts.after?.(width);
    await saveCapture(ctx, state, width, opts.target);
    await opts.cleanup?.(width);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------------------------------------------------

async function captureCoreStates(ctx: CaptureContext): Promise<void> {
  const { page, theme } = ctx;
  const omnibox = omniboxOf(page);
  const listbox = listboxOf(page);

  await a11yStep(`[search-visual ${ctx.lang}-${theme}] toggle-hidden (closed omnibox, server-off stack)`, async () => {
    await sweepWidths(
      ctx,
      'toggle-hidden',
      async () => {
        await expect(omnibox).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await expect(page.getByTestId('omnibox-semantic-toggle')).toHaveCount(0);
      },
      { target: page.locator('#omni') },
    );
  });

  await a11yStep(`[search-visual ${ctx.lang}-${theme}] recent (focus, empty draft)`, async () => {
    await sweepWidths(
      ctx,
      'recent',
      async () => {
        await omnibox.focus();
        await expectRowsSettled(page, 'item');
        await expect(listbox.locator('[role="group"]')).not.toHaveCount(0);
      },
      { requireRows: true },
    );
  });

  await a11yStep(`[search-visual ${ctx.lang}-${theme}] suggest (tags + items + create CTA, active row, theme token)`, async () => {
    await sweepWidths(
      ctx,
      'suggest',
      async () => {
        await typeQuery(page, 'nim');
        await expectRowsSettled(page, 'item');
        await expect(listbox.locator('[role="option"][data-opt-kind="tag"]').first()).toBeVisible();
        await expect(listbox.locator('[role="option"][data-opt-kind="create"]')).toHaveCount(1);
        await expectServerOffStack(page);
        await page.keyboard.press('ArrowDown');
        await expect(listbox.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
      },
      { after: async () => expectThemeTokens(page, theme), requireRows: true },
    );
  });

  await a11yStep(`[search-visual ${ctx.lang}-${theme}] chips (+N: max 3 at >= 768, 2 at 390)`, async () => {
    await sweepWidths(
      ctx,
      'chips',
      async () => {
        await typeQuery(page, MULTI_TAG_QUERY);
        await expectRowsSettled(page, 'item');
        // The focus-time `recent` rows stay visible and not busy for the 120 ms debounce: wait for the `zeph` server row
        // itself (`.chip-more-mobile` is rendered whenever the row has > 2 tags, at every width; CSS hides it at >= 768).
        await expect(
          listboxOf(page).locator('[role="option"][data-opt-kind="item"]').filter({ has: page.locator('.chip-more-mobile') }),
        ).toHaveCount(1, { timeout: CONTENT_A11Y_UI_WAIT_MS });
      },
      { after: async (width) => expectChipCounts(page, width), requireRows: true },
    );
  });

  await a11yStep(`[search-visual ${ctx.lang}-${theme}] tags (# mode: cached tags, then server rows)`, async () => {
    await sweepWidths(
      ctx,
      'tags',
      async () => {
        const serverRows = page.waitForResponse(
          (res) => {
            if (res.request().method() !== 'GET') return false;
            const url = new URL(res.url());
            return (
              url.pathname === '/api/v1/suggest' &&
              url.searchParams.get('scope') === 'tag' &&
              url.searchParams.get('q') === 'n'
            );
          },
          { timeout: CONTENT_A11Y_UI_WAIT_MS },
        );
        await typeQuery(page, '#n');
        expect((await serverRows).status()).toBe(200);
        await expectRowsSettled(page, 'tag');
        await expect(listbox.locator('[role="option"][data-opt-kind="item"]')).toHaveCount(0);
        await expect(listbox.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
      },
      { requireRows: true },
    );
  });

  await a11yStep(`[search-visual ${ctx.lang}-${theme}] empty (no match) and tag-empty`, async () => {
    await sweepWidths(ctx, 'empty', async () => {
      await typeQuery(page, 'zzqx');
      await expect(page.getByTestId('omnibox-search-empty')).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
      await expect(listbox.locator('[role="option"][data-opt-kind="item"]')).toHaveCount(0);
    });
    await sweepWidths(ctx, 'tag-empty', async () => {
      await typeQuery(page, '#zzqx');
      await expect(page.getByTestId('omnibox-tag-empty')).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
    });
  });

  // U18 "input tainted" (plan 2.10): a real clipboard paste (Control+V -> insertFromPaste) of a PUBLIC fixture string taints the
  // draft; the help line switches to "Press Enter to search" and nothing is sent while typing (plan 2.1 rule 1).
  await a11yStep(`[search-visual ${ctx.lang}-${theme}] tainted (paste: Enter-to-search help, no /suggest with q)`, async () => {
    const helpText = (ctx.lang === 'vi' ? viMessages : enMessages).search.help.enterToSearch;
    const sentSuggestQueries: string[] = [];
    const onRequest = (req: Request): void => {
      if (req.method() !== 'GET') return;
      const url = new URL(req.url());
      if (url.pathname === '/api/v1/suggest' && url.searchParams.has('q')) sentSuggestQueries.push('q');
    };
    page.on('request', onRequest);
    try {
      await sweepWidths(ctx, 'tainted', async () => {
        const before = sentSuggestQueries.length;
        await pasteIntoOmnibox(page, omnibox, TAINTED_PASTE);
        await expectInputEquals(omnibox, TAINTED_PASTE);
        await expect(page.getByTestId('omnibox-hint')).toContainText(helpText, { timeout: CONTENT_A11Y_UI_WAIT_MS });
        // The one allowed fixed wait (plan Task 22, ">= 1 s with no request"): the 120 ms debounce had time to fire.
        await page.waitForTimeout(SEARCH_QUIET_WINDOW_MS);
        expect(sentSuggestQueries.length - before, 'tainted paste must not send /suggest with q').toBe(0);
      });
    } finally {
      page.off('request', onRequest);
    }
  });
}

async function captureEdgeStates(ctx: CaptureContext): Promise<void> {
  const { page, theme } = ctx;
  const omnibox = omniboxOf(page);
  const listbox = listboxOf(page);

  await a11yStep(`[search-visual ${ctx.lang}-${theme}] skeleton (first query held with route.continue)`, async () => {
    const held: { promise: Promise<void>; release: () => void } = {
      promise: Promise.resolve(),
      release: () => undefined,
    };
    await page.route('**/api/v1/suggest*', async (route) => {
      await held.promise;
      await route.continue();
    });
    try {
      await sweepWidths(
        ctx,
        'skeleton',
        async () => {
          held.promise = new Promise<void>((resolve) => {
            held.release = resolve;
          });
          await omnibox.focus();
          await expect(page.getByTestId('omnibox-skeleton')).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        },
        {
          cleanup: async (width) => {
            held.release();
            await expectRowsSettled(page, 'item');
            // Once released the real rows must exist and be >= 44 px (RV-T22-1-FE1-10).
            await expectRowsAtLeast44(ctx, 'skeleton-released', width, { requireRows: true });
          },
        },
      );
    } finally {
      held.release();
      await page.unroute('**/api/v1/suggest*');
    }
  });

  await a11yStep(`[search-visual ${ctx.lang}-${theme}] more + more-page2 (real cursor from a 25-item corpus)`, async () => {
    const moreOption = listbox.locator('[role="option"][data-opt-kind="more"]');
    const itemRows = listbox.locator('[role="option"][data-opt-kind="item"]');
    let rowsBefore = 0;
    const openFirstPage = async () => {
      await typeQuery(page, 'nimbus');
      await expectRowsSettled(page, 'item');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('omnibox-result-count')).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
      await expect(moreOption).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
    };
    await sweepWidths(
      ctx,
      'more',
      async () => {
        await openFirstPage();
        rowsBefore = await itemRows.count();
        expect(rowsBefore).toBeGreaterThan(0);
        expect(rowsBefore).toBeLessThan(NIMBUS_COUNT);
      },
      {
        requireRows: true,
        // VIS-T22-1-1: the Xem them row sits at the end of the scrolling list; frame it before the capture. The `21 results`
        // header stays evidenced by `more-page2` and the a11y spec.
        after: async () => {
          await scrollIntoPopoverAndAssertFramed(page, moreOption, 'the more option');
        },
      },
    );
    await sweepWidths(
      ctx,
      'more-page2',
      async () => {
        await openFirstPage();
        rowsBefore = await itemRows.count();
        await moreOption.click();
        await expect(moreOption).toHaveCount(0, { timeout: CONTENT_A11Y_UI_WAIT_MS });
        expect(await itemRows.count()).toBeGreaterThanOrEqual(NIMBUS_COUNT);
        expect(await itemRows.count()).toBeGreaterThan(rowsBefore);
        // The appended rows are what the capture is about.
        await itemRows.nth(rowsBefore).scrollIntoViewIfNeeded();
        await expect(listbox).not.toHaveAttribute('aria-busy', 'true');
      },
      { requireRows: true },
    );
  });

  await a11yStep(`[search-visual ${ctx.lang}-${theme}] rate-limited (429 + Retry-After stub on GET /search, Enter)`, async () => {
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
      await sweepWidths(
        ctx,
        'rate-limited',
        async () => {
          await typeQuery(page, 'nim');
          await expectRowsSettled(page, 'item');
          // VIS-T22-2-1: the focus-time recents also satisfy `expectRowsSettled`; the `nim` suggest rows are the snapshot that
          // carries the create CTA (never present in `recent`). Not a response wait: `nim` is client-cached after the first width.
          await expectSuggestRowsNotRecent(page, ctx.lang);
          await page.keyboard.press('Enter');
          const line = page.getByTestId('omnibox-status-rate-limited');
          await expect(line).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(line).toContainText(String(RATE_LIMIT_RETRY_AFTER_S));
          // Plan 2.6: muted line, rows kept, never a toast and never a role=status/alert on the line.
          await expect(listbox.locator('[role="option"][data-opt-kind="item"]').first()).toBeVisible();
          await expect(page.getByTestId('undo-toast-item')).toHaveCount(0);
          await expect(line).not.toHaveAttribute('role', /.+/);
        },
        {
          requireRows: true,
          // VIS-T22-1-2: the muted line is the last child of a scrolling list; frame it before the capture.
          after: async () => {
            // VIS-T22-2-1: a resize after Enter / 429 must not turn the list back into the recents (product bug if it does).
            await expectSuggestRowsNotRecent(page, ctx.lang);
            await scrollIntoPopoverAndAssertFramed(
              page,
              page.getByTestId('omnibox-status-rate-limited'),
              'the 429 line',
            );
          },
        },
      );
    } finally {
      await page.unroute('**/api/v1/search*');
    }
  });

  await a11yStep(`[search-visual ${ctx.lang}-${theme}] undo-toast (dropdown open over the toast stack at 390, FU10)`, async () => {
    await setWidth(page, 390);
    await resetOmnibox(page);
    const body = `search-visual-body-${ctx.lang}-${theme}`;
    const leakGuard = attachPlaintextLeakGuard(page.context(), [{ label: 'quickAddBody', value: body }]);
    await setQuietValue(omnibox, `${TOAST_ITEM_NAME} #ops: ${body}`);
    const saveBtn = page.getByTestId('omnibox-save-now-btn');
    await expect(saveBtn).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
    await saveBtn.click();
    await expectInputEmpty(omnibox);
    const toast = page.getByTestId('undo-toast-item').filter({ hasText: TOAST_ITEM_NAME }).first();
    await expect(toast).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
    // Hover pauses the auto-dismiss timer; focus the omnibox programmatically so the pointer stays on the toast.
    await toast.hover();
    await typeQuery(page, 'nim');
    await expectRowsSettled(page, 'item');
    await expect(toast).toBeVisible();
    await settle(page);

    await expectNoHorizontalScroll(ctx, 'undo-toast', 390);
    await saveCapture(ctx, 'undo-toast', 390);
    leakGuard.assertNoLeaks();
    leakGuard.assertSawEntriesPost();

    // FU10 (advisor-dec-326): the product fix for RV-T22-1-FE1-6 lands in this PR, so this is a HARD assert. It measures the
    // VISIBLE popover (`#omni-pop`, the clipping box the user sees), not the unclipped `#omni-listbox`, which is taller than
    // `#omni-pop` once the popover scrolls. It runs after the capture so the evidence PNG still shows the popover at the top
    // (and a red run still leaves it); the scrollIntoView below only happens inside the measurement.
    const overlap = await page.evaluate(() => {
      const stack = document.querySelector<HTMLElement>('[data-testid="undo-toast-stack"]');
      const pop = document.getElementById('omni-pop');
      const create = pop?.querySelector<HTMLElement>('[data-opt-kind="create"]');
      if (!stack || !pop || !create) return null;
      const a = stack.getBoundingClientRect();
      const p = pop.getBoundingClientRect();
      const intersects = a.left < p.right && a.right > p.left && a.top < p.bottom && a.bottom > p.top;
      // The action row must be reachable by scrolling the popover.
      create.scrollIntoView({ block: 'nearest' });
      const c = create.getBoundingClientRect();
      const p2 = pop.getBoundingClientRect();
      return {
        intersects,
        stackTop: Math.round(a.top),
        popBottom: Math.round(p.bottom),
        createReachable: c.top >= p2.top - 1 && c.bottom <= p2.bottom + 1 && c.bottom <= a.top,
      };
    });
    expect(overlap, 'toast stack, #omni-pop and its create action row must all be present').not.toBeNull();
    expect(
      overlap!.intersects,
      `undo toast stack overlaps the open dropdown at 390 (stackTop=${overlap!.stackTop}, popBottom=${overlap!.popBottom})`,
    ).toBe(false);
    expect(
      overlap!.createReachable,
      'the create action row must be reachable above the toast stack by scrolling #omni-pop',
    ).toBe(true);
  });
}

/**
 * Real settings contract on the noop stack (RV-T22-1-FE1-5): `semantic_suggest` defaults to `true` (SPEC section 2), so first
 * read `/auth/me`, turn it OFF (always 200), then `PATCH true` must be 409 `semantic_unavailable` and must NOT flip the stored
 * value back on. The UI cannot show this here (see header).
 */
async function assertEnable409Contract(page: Page): Promise<void> {
  const readStored = async (): Promise<boolean | undefined> => {
    const me = await fetchMeViaPage(page);
    expect(me.status).toBe(200);
    return (me.body as { settings?: { semantic_suggest?: boolean } } | null)?.settings?.semantic_suggest;
  };
  expect(typeof (await readStored()), 'auth/me must expose settings.semantic_suggest').toBe('boolean');

  const off = await patchSettingsViaPage(page, { semantic_suggest: false });
  expect(off.status, 'PATCH semantic_suggest=false always succeeds').toBe(200);
  expect(await readStored()).toBe(false);

  const on = await patchSettingsViaPage(page, { semantic_suggest: true });
  expect(on.status).toBe(409);
  expect((on.body as { code?: string } | null)?.code).toBe('semantic_unavailable');
  expect(await readStored(), 'a refused enable must leave the stored value false').toBe(false);
  // The omnibox `omnibox-status-enable409` line and the settings `semanticEnable409` status need `semantic_available=true`
  // with the API breaker open: they are captured by the `@semantic` describe at the end of this file (22-2b).
}

async function captureSettings(ctx: CaptureContext): Promise<void> {
  const { page } = ctx;
  await page.goto('/app/settings#timkiem', { waitUntil: 'domcontentloaded', timeout: CONTENT_A11Y_UI_WAIT_MS });
  const card = page.getByTestId('settings-semantic-card');
  await expect(card).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
  await expect(page.getByTestId('settings-semantic-server-off')).toBeVisible();
  const toggle = page.getByTestId('settings-semantic-switch');
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(card).toHaveAttribute('aria-disabled', 'true');
  const section = page.locator('#timkiem');
  for (const { width } of WIDTHS) {
    await setWidth(page, width);
    await section.scrollIntoViewIfNeeded();
    await expectNoHorizontalScroll(ctx, 'settings', width);
    await saveCapture(ctx, 'settings', width, section);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Coarse pointer (real `pointer: coarse` context, once)
// ---------------------------------------------------------------------------------------------------------------------

async function assertCoarseRows(browser: Browser, sourcePage: Page): Promise<void> {
  const coarseContext = await newCoarseTouchContext(browser, sourcePage.context());
  try {
    const coarsePage = await coarseContext.newPage();
    await coarsePage.goto('/app', { waitUntil: 'domcontentloaded', timeout: CONTENT_A11Y_UI_WAIT_MS });
    await unlockLockedAppPage(coarsePage);
    const omnibox = omniboxOf(coarsePage);
    await expect(omnibox).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
    await omnibox.focus();
    await omnibox.pressSequentially(MULTI_TAG_QUERY);
    await expectRowsSettled(coarsePage, 'item');
    // Same focus -> recent -> type window as the chips step: wait for the `zeph` server row (it has `.chip-more-mobile`).
    await expect(
      listboxOf(coarsePage)
        .locator('[role="option"][data-opt-kind="item"]')
        .filter({ has: coarsePage.locator('.chip-more-mobile') }),
    ).toHaveCount(1, { timeout: CONTENT_A11Y_UI_WAIT_MS });
    await expect(listboxOf(coarsePage).locator('[role="option"][data-opt-kind="create"]')).toHaveCount(1);
    const [rows] = await measureCoarseTouchTargets(coarsePage, ['#omni-listbox .sugg-row']);
    expect(rows!.count).toBeGreaterThanOrEqual(2);
    expect(
      rows!.effectiveHeight,
      `coarse pointer dropdown rows: min effective height ${rows!.effectiveHeight}px (${rows!.below44.length} below 44)`,
    ).toBeGreaterThanOrEqual(43.5);
    await expectChipCounts(coarsePage, 390);
    const overflow = await coarsePage.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  } finally {
    await coarseContext.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------------

async function runVisualGroup(
  browser: Browser,
  testInfo: TestInfo,
  lang: A11yLang,
  theme: A11yTheme,
): Promise<void> {
  const label = `${lang}-${theme}`;
  const edge = isEdge(lang, theme);
  const context = await newContext(browser);
  await grantClipboard(context);
  try {
    const page = await context.newPage();
    const ctx: CaptureContext = { page, testInfo, lang, theme };

    await a11yStep(`[search-visual ${label}] signup, onboarding skip, locale/theme, seed corpus`, async () => {
      await bootstrapUnlockedUser(page, uniqueEmail(`content-search-visual-${label}`), lang, theme);
      await expect(page.getByTestId('home-empty-state')).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
      await seedCorpus(page);
      // Wake the changes sync so the rail (and therefore the omnibox `#` tag cache) refetches the seeded tags.
      await triggerFocusWake(page);
      await expect(page.getByTestId('rail-tag-item')).toHaveCount(SEED_TAG_NAMES.length, {
        timeout: CONTENT_A11Y_UI_WAIT_MS,
      });
    });

    await captureCoreStates(ctx);

    if (edge) {
      await captureEdgeStates(ctx);
      await a11yStep(`[search-visual ${label}] real coarse pointer: dropdown rows >= 44 px, chips, no overflow`, async () => {
        await assertCoarseRows(browser, page);
      });
      await a11yStep(`[search-visual ${label}] enable-409 API contract on the noop stack`, async () => {
        await assertEnable409Contract(page);
      });
    }

    // Last: a full navigation locks the in-memory vault key.
    await a11yStep(`[search-visual ${label}] settings #timkiem (server-off card)`, async () => {
      await captureSettings(ctx);
    });
  } finally {
    await context.close();
  }
}

test.describe('P05-T22 search visual captures (dropdown, U18 states, #timkiem)', () => {
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  for (const lang of A11Y_LANGS) {
    for (const theme of A11Y_THEMES) {
      test(`search visual: ${lang} ${theme}${isEdge(lang, theme) ? ' (core + edge states)' : ' (core states)'}`, async ({
        browser,
      }, testInfo) => {
        test.setTimeout(isEdge(lang, theme) ? 480_000 : 300_000);
        await runVisualGroup(browser, testInfo, lang, theme);
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// @semantic (22-2b): real fakeembed, job `Search semantic e2e (fake provider)`; `Content e2e` skips it (--grep-invert @semantic)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * How long the `slow` fake holds the provider answer, i.e. how long `omnibox-status-near-pending` stays on screen. The API's query
 * embedding budget is `EMBEDDING_QUERY_TIMEOUT` (tei default 300 ms): a longer delay would end `degraded` and open the breaker, so
 * the semantic job raises it to 5 s (ci.yml job `e2e-search-semantic`, advisor-dec-338). Keep this well under that 5 s. Fallback B
 * (no env change) would be ~200 ms, which is neither capturable nor axe-able.
 */
const PENDING_SLOW_DELAY_MS = 3_500;
/** The near target (never typed): reached only through an alias. */
const NEAR_TARGET_NAME = 'router closet shelf';
/** Lexical fuzzy fixture: `tomorow` -> `tomorrow checklist` is a word-similarity ~.70 typo hit (same shape as `pasword`/`password`). */
const FUZZY_ITEM_NAME = 'tomorrow checklist';
const FUZZY_QUERY = 'tomorow';
/** Prefix of the fuzzy item (a lexical row for the 409 captures). */
const PREFIX_QUERY = 'tomorrow';
const NEAR_ZONE_OPTIONS = '[data-zone="near"] [role="option"]';
const LEXICAL_ITEM_ROWS = '[data-zone="items"] [data-opt-kind="item"]';
/** The API breaker stays open 60 s (SPEC 6.6); polling for PATCH true waits it out. */
const BREAKER_RECOVERY_MAX_MS = 80_000;
/** Warm-up targets per `waitForEmbedded` call (plan: at most 5). */
const EMBEDDED_CHUNK = 5;

const widthIndex = (width: Width): number => WIDTHS.findIndex((w) => w.width === width);

interface SemanticFixtures {
  readonly targetId: string;
  readonly allIds: readonly string[];
  readonly pendingQueries: readonly string[];
  readonly downQueries: readonly string[];
}

/**
 * Real-API fixtures. Every `slow`/`down` scenario needs a NEVER-SENT query, so each width gets its own unique token, and an item
 * whose name starts with that token so a lexical row accompanies the status line. Nothing here is a secret.
 */
async function seedSemanticCorpus(page: Page): Promise<SemanticFixtures> {
  const ids: string[] = [];
  const create = async (name: string): Promise<string> => {
    const id = (await searchApiCreate<{ id: string }>(page, '/items', { name })).id;
    ids.push(id);
    return id;
  };
  const targetId = await create(NEAR_TARGET_NAME);
  await create(FUZZY_ITEM_NAME);
  const pendingQueries = WIDTHS.map(() => uniqueSemanticQuery('pend'));
  const downQueries = WIDTHS.map(() => uniqueSemanticQuery('down'));
  for (const query of [...pendingQueries, ...downQueries]) {
    await create(`${query} wallet`);
  }
  return { targetId, allIds: ids, pendingQueries, downQueries };
}

/** Every seeded item must have a vector before `slow`/`down` (otherwise the worker retries into a failing provider). */
async function waitForAllEmbedded(page: Page, ids: readonly string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += EMBEDDED_CHUNK) {
    await waitForEmbedded(
      page,
      ids.slice(i, i + EMBEDDED_CHUNK).map((id) => ({ id, probeQuery: nextProbeQuery() })),
    );
  }
}

function nearOptionsOf(page: Page): Locator {
  return listboxOf(page).locator(NEAR_ZONE_OPTIONS);
}

/** >= 1 near row with the `≈` badge, and neither the pending nor the degraded line (never an empty green). */
async function expectNearShown(page: Page): Promise<void> {
  const near = nearOptionsOf(page);
  await expect(near.first()).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
  expect(await near.count(), 'at least one near row').toBeGreaterThan(0);
  await expect(near.first().locator('.sugg-near-badge')).toBeVisible();
  await expect(page.getByTestId('omnibox-status-near-pending')).toHaveCount(0);
  await expect(page.getByTestId('omnibox-status-degraded')).toHaveCount(0);
}

/** The lexical `fuzzy` marker (`.sugg-match-badge`) on the typo hit. */
async function expectFuzzyMarker(page: Page): Promise<void> {
  const row = listboxOf(page).locator(LEXICAL_ITEM_ROWS).filter({ hasText: FUZZY_ITEM_NAME });
  await expect(row).toHaveCount(1, { timeout: CONTENT_A11Y_UI_WAIT_MS });
  await expect(row.locator('.sugg-match-badge')).toBeVisible();
}

/** Keyboard ArrowDown until the active option is inside the near zone (also draws the active-row token for the theme check). */
async function activateNearRow(page: Page): Promise<void> {
  const active = listboxOf(page).locator('[data-zone="near"] [role="option"][aria-selected="true"]');
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('ArrowDown');
    if ((await active.count()) === 1) break;
  }
  await expect(active, 'ArrowDown must reach a near row').toHaveCount(1);
}

/** Plain muted line outside the listbox, no live-region role (plan 2.8 rule 5, FE-23). */
async function expectStatusLineMarkup(line: Locator, label: string): Promise<void> {
  const structure = await line.evaluate((el) => ({
    outsideListbox: el.closest('[role="listbox"]') === null,
    noLiveRole: el.closest('[role="status"], [role="alert"], [aria-live]') === null && !el.hasAttribute('role'),
  }));
  expect.soft(structure, `${label}: status line markup`).toEqual({ outsideListbox: true, noLiveRole: true });
}

/** Clicks `≈` (setting currently OFF) and expects the real `PATCH true` to be refused with 409 and the muted line to show. */
async function clickEnableAndExpect409(page: Page): Promise<void> {
  const toggle = page.getByTestId('omnibox-semantic-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false', { timeout: CONTENT_A11Y_UI_WAIT_MS });
  const patched = page.waitForResponse(
    (res) => res.request().method() === 'PATCH' && new URL(res.url()).pathname === '/api/v1/me/settings',
    { timeout: CONTENT_A11Y_UI_WAIT_MS },
  );
  await toggle.click();
  const res = await patched;
  expect(res.status(), 'PATCH semantic_suggest=true while the breaker is open').toBe(409);
  await expect(page.getByTestId('omnibox-status-enable409')).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
}

/**
 * Back to a healthy stack: fake `ok`, wait out the 60 s API breaker by polling the real `PATCH semantic_suggest=true` (409 while
 * it is open), then close the breaker with one real semantic query so the next `@semantic` spec starts clean.
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

/** Real `pointer: coarse` context: every dropdown row (near rows included) is >= 44 px. */
async function assertCoarseNearRows(browser: Browser, sourcePage: Page): Promise<void> {
  const coarseContext = await newCoarseTouchContext(browser, sourcePage.context());
  try {
    const coarsePage = await coarseContext.newPage();
    await coarsePage.goto('/app', { waitUntil: 'domcontentloaded', timeout: CONTENT_A11Y_UI_WAIT_MS });
    await unlockLockedAppPage(coarsePage);
    const omnibox = omniboxOf(coarsePage);
    await expect(omnibox).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
    await omnibox.focus();
    await omnibox.pressSequentially(FUZZY_QUERY);
    await expectNearShown(coarsePage);
    await expectFuzzyMarker(coarsePage);
    const [rows] = await measureCoarseTouchTargets(coarsePage, ['#omni-listbox .sugg-row']);
    expect(rows!.count).toBeGreaterThanOrEqual(3);
    expect(
      rows!.effectiveHeight,
      `coarse pointer rows incl. near: min effective height ${rows!.effectiveHeight}px (${rows!.below44.length} below 44)`,
    ).toBeGreaterThanOrEqual(43.5);
    const overflow = await coarsePage.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  } finally {
    await coarseContext.close();
  }
}

async function captureSettingsWidths(
  ctx: CaptureContext,
  state: string,
  assertBeforeCapture?: (width: Width) => Promise<void>,
): Promise<void> {
  const section = ctx.page.locator('#timkiem');
  for (const { width } of WIDTHS) {
    await setWidth(ctx.page, width);
    await section.scrollIntoViewIfNeeded();
    await expectNoHorizontalScroll(ctx, state, width);
    await assertBeforeCapture?.(width);
    await saveCapture(ctx, state, width, section);
  }
}

async function runSemanticVisualGroup(
  browser: Browser,
  testInfo: TestInfo,
  lang: A11yLang,
  theme: A11yTheme,
): Promise<void> {
  const label = `${lang}-${theme}`;
  const messages = lang === 'vi' ? viMessages : enMessages;
  const context = await newContext(browser);
  let breakerMayBeOpen = false;
  let page: Page | null = null;
  try {
    page = await context.newPage();
    const live = page;
    const ctx: CaptureContext = { page: live, testInfo, lang, theme };
    const listbox = listboxOf(live);
    let fixtures!: SemanticFixtures;
    const targetDocument = documentInput(itemDocumentText(NEAR_TARGET_NAME, null));

    await a11yStep(`[search-visual-sem ${label}] signup, locale/theme, seed, waitForEmbedded, aliases`, async () => {
      semanticCleanup.page = live;
      await bootstrapUnlockedUser(live, uniqueEmail(`content-search-visual-sem-${label}`), lang, theme);
      semanticCleanup.cookies = await context.cookies();
      await expect(live.getByTestId('home-empty-state')).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
      fixtures = await seedSemanticCorpus(live);
      // seed -> waitForEmbedded -> (slow | down) -> type (plan Task 22, N1); probe queries are never typed below.
      await waitForAllEmbedded(live, fixtures.allIds);
      const aliases: Record<string, string> = { [FUZZY_QUERY]: targetDocument };
      for (const q of fixtures.pendingQueries) aliases[q] = targetDocument;
      await fakeembedSetAliases(aliases);
      await expect(live.getByTestId('omnibox-semantic-toggle')).toHaveAttribute('aria-pressed', 'true', {
        timeout: CONTENT_A11Y_UI_WAIT_MS,
      });
    });

    await a11yStep(`[search-visual-sem ${label}] near zone + ≈ badge + fuzzy marker, active near row, theme token`, async () => {
      await sweepWidths(
        ctx,
        'near',
        async () => {
          await typeQuery(live, FUZZY_QUERY);
          await expectFuzzyMarker(live);
          await expectNearShown(live);
          await activateNearRow(live);
        },
        { requireRows: true, after: async () => expectThemeTokens(live, theme) },
      );
    });

    await a11yStep(`[search-visual-sem ${label}] ≈ off removes the near zone, lexical rows stay (then ≈ on again)`, async () => {
      await sweepWidths(
        ctx,
        'near-off',
        async () => {
          await typeQuery(live, FUZZY_QUERY);
          await expectFuzzyMarker(live);
          await expectNearShown(live);
          await toggleSemanticSetting(live, false);
          await expect(live.locator('[data-zone="near"]')).toHaveCount(0);
          await expect(nearOptionsOf(live)).toHaveCount(0);
          await expectFuzzyMarker(live);
        },
        {
          requireRows: true,
          cleanup: async () => {
            await toggleSemanticSetting(live, true);
            await expectNearShown(live);
          },
        },
      );
    });

    await a11yStep(`[search-visual-sem ${label}] real coarse pointer: rows incl. near >= 44 px`, async () => {
      await assertCoarseNearRows(browser, live);
    });

    await a11yStep(`[search-visual-sem ${label}] near-pending (fakeembed slow ${PENDING_SLOW_DELAY_MS} ms, new query per width)`, async () => {
      const pending = live.getByTestId('omnibox-status-near-pending');
      await fakeembedSetMode('slow', { delayMs: PENDING_SLOW_DELAY_MS });
      try {
        await sweepWidths(
          ctx,
          'near-pending',
          async (width) => {
            const query = fixtures.pendingQueries[widthIndex(width)]!;
            const before = await fakeembedStats();
            await typeQuery(live, query);
            await expect(pending).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
            // The provider path was really called (cache miss) before anything is asserted about the late near zone.
            await expect
              .poll(async () => (await fakeembedStats()).query_requests, { timeout: CONTENT_A11Y_UI_WAIT_MS })
              .toBeGreaterThan(before.query_requests);
            await expect(listbox.locator(LEXICAL_ITEM_ROWS)).toHaveCount(1);
            await expect(live.locator('[data-zone="near"]')).toHaveCount(0);
          },
          {
            requireRows: true,
            after: async () => {
              await expect(pending).toBeVisible();
              await expectStatusLineMarkup(pending, `near-pending ${label}`);
              await scrollIntoPopoverAndAssertFramed(live, pending, 'the near-pending line');
            },
            cleanup: async () => {
              // The capture above was taken inside the pending window (the line is still there afterwards)...
              await expect(pending, 'near-pending must still be shown right after the capture').toBeVisible();
              // ...and the late near zone does arrive with >= 1 near row.
              await expectNearShown(live);
            },
          },
        );
      } finally {
        await fakeembedSetMode('ok');
      }
    });

    // ---- one 60 s API breaker window: degraded -> omnibox enable-409 -> settings enable-409 (settings last: a full
    // navigation locks the in-memory vault key). Elapsed time is reported in the 409 failure messages. ----
    const breaker = { openedAt: 0 };
    await a11yStep(`[search-visual-sem ${label}] degraded (fakeembed down, new query per width, muted line, no toast)`, async () => {
      await fakeembedSetMode('down');
      breakerMayBeOpen = true;
      const before = await fakeembedStats();
      const degraded = live.getByTestId('omnibox-status-degraded');
      await sweepWidths(
        ctx,
        'degraded',
        async (width) => {
          const idx = widthIndex(width);
          await typeQuery(live, fixtures.downQueries[idx]!);
          if (idx === 0) {
            // First down query: a cache miss that reaches the fake (and opens the breaker). Later widths hit the open breaker.
            await expect
              .poll(async () => (await fakeembedStats()).query_requests, { timeout: CONTENT_A11Y_UI_WAIT_MS })
              .toBeGreaterThan(before.query_requests);
            breaker.openedAt = Date.now();
          }
          await expect(degraded).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(listbox.locator(LEXICAL_ITEM_ROWS)).toHaveCount(1);
          await expect(live.locator('[data-zone="near"]')).toHaveCount(0);
          await expect(live.locator('.sugg-near-badge')).toHaveCount(0);
          await expect(live.getByTestId('undo-toast-item')).toHaveCount(0);
        },
        {
          requireRows: true,
          after: async () => {
            await expectStatusLineMarkup(degraded, `degraded ${label}`);
            await scrollIntoPopoverAndAssertFramed(live, degraded, 'the degraded line');
          },
        },
      );
    });

    await a11yStep(`[search-visual-sem ${label}] omnibox enable-409 (real PATCH true refused while the breaker is open)`, async () => {
      const line = live.getByTestId('omnibox-status-enable409');
      await sweepWidths(
        ctx,
        'enable409',
        async () => {
          await typeQuery(live, PREFIX_QUERY);
          await expect(listbox.locator('[role="option"][data-opt-kind="create"]')).toHaveCount(1, {
            timeout: CONTENT_A11Y_UI_WAIT_MS,
          });
          const toggle = live.getByTestId('omnibox-semantic-toggle');
          if ((await toggle.getAttribute('aria-pressed')) === 'true') {
            // PATCH false always succeeds; from here the stored setting stays false (a refused enable never flips it).
            await toggleSemanticSetting(live, false);
          }
          await clickEnableAndExpect409(live);
        },
        {
          requireRows: true,
          after: async () => {
            await expectStatusLineMarkup(line, `enable409 ${label}`);
            await scrollIntoPopoverAndAssertFramed(live, line, 'the enable-409 line');
          },
        },
      );
    });

    await a11yStep(`[search-visual-sem ${label}] settings #timkiem enable-409 status (semantic available, breaker open)`, async () => {
      await live.goto('/app/settings#timkiem', { waitUntil: 'domcontentloaded', timeout: CONTENT_A11Y_UI_WAIT_MS });
      const card = live.getByTestId('settings-semantic-card');
      await expect(card).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
      await expect(live.getByTestId('settings-semantic-server-off')).toHaveCount(0);
      const toggle = live.getByTestId('settings-semantic-switch');
      await expect(toggle).toBeEnabled();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      const patched = live.waitForResponse(
        (res) => res.request().method() === 'PATCH' && new URL(res.url()).pathname === '/api/v1/me/settings',
        { timeout: CONTENT_A11Y_UI_WAIT_MS },
      );
      await toggle.click();
      const res = await patched;
      expect(
        res.status(),
        `PATCH semantic_suggest=true while the breaker is open (${Date.now() - breaker.openedAt} ms after it opened; window 60000)`,
      ).toBe(409);
      await expect(live.getByTestId('settings-semantic-status')).toHaveText(messages.settings.search.semanticEnable409);
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      // RV-T22-2-FE1-3: the 409 copy must still be on screen at every width (a resize re-render must not clear it).
      await captureSettingsWidths(ctx, 'settings-semantic-409', async () => {
        await expect(live.getByTestId('settings-semantic-status')).toHaveText(messages.settings.search.semanticEnable409);
        await expect(toggle).toHaveAttribute('aria-checked', 'false');
      });
    });

    await a11yStep(`[search-visual-sem ${label}] settings #timkiem with semantic available and ON (after the breaker recovers)`, async () => {
      await recoverSemantic(live);
      breakerMayBeOpen = false;
      await live.reload({ waitUntil: 'domcontentloaded', timeout: CONTENT_A11Y_UI_WAIT_MS });
      const card = live.getByTestId('settings-semantic-card');
      await expect(card).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
      await expect(live.getByTestId('settings-semantic-server-off')).toHaveCount(0);
      const toggle = live.getByTestId('settings-semantic-switch');
      await expect(toggle).toBeEnabled();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(live.locator('[data-testid^="settings-semantic-copy-"]')).toBeVisible();
      await expect(live.getByTestId('settings-semantic-status')).toHaveText('');
      await captureSettingsWidths(ctx, 'settings-semantic');
    });
  } finally {
    await fakeembedReset().catch(() => undefined);
    if (breakerMayBeOpen && page !== null) {
      await recoverSemantic(page).catch(() => undefined);
    }
    await context.close();
  }
}

test.describe('P05-T22 @semantic search visual captures (near, pending, degraded, enable-409, #timkiem)', () => {
  // Local runs without the stack skip. In CI this never skips (a misconfigured semantic job must go red, not green-by-skip).
  test.skip(!process.env.E2E_STACK && !process.env.CI, 'needs the semantic-fake compose stack (E2E_STACK=1)');

  // The fake is shared by every @semantic spec of the job: never leave it `slow`/`down`, and after a FAILED run wait out the API
  // breaker even when a timeout abandoned the body's `finally` (RV-T22-2-FE1-2, same contract as the stable/degrade specs).
  test.afterEach(async ({ browser }, testInfo) => {
    await semanticAfterEach(browser, testInfo);
  });

  for (const lang of A11Y_LANGS) {
    for (const theme of A11Y_THEMES) {
      if (!isEdge(lang, theme)) continue;
      test(`@semantic search visual: ${lang} ${theme} (near, ≈ off, near-pending, degraded, enable-409, settings)`, async ({
        browser,
      }, testInfo) => {
        test.setTimeout(480_000);
        await runSemanticVisualGroup(browser, testInfo, lang, theme);
      });
    }
  }
});
