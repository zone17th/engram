import { expect, test, type Browser, type Locator, type Page, type Request, type TestInfo } from '@playwright/test';
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
} from './content-search-support';
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
 * 22-2 (`@semantic`, job `e2e-search-semantic`, real `fakeembed`): near zone "Gần nghĩa" + the ≈ / fuzzy badges, a late near
 * arrival, the ≈ toggle on/off, `omnibox-status-near-pending`, `omnibox-status-degraded`, and the omnibox/settings enable-409 line.
 * The enable-409 UI is NOT reachable on the noop stack: `semantic_available=false` hides the ≈ button and disables the settings
 * switch, and the hook short-circuits before any PATCH, so only the real `PATCH true -> 409` API contract is asserted here.
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
      { requireRows: true },
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
          await page.keyboard.press('Enter');
          const line = page.getByTestId('omnibox-status-rate-limited');
          await expect(line).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(line).toContainText(String(RATE_LIMIT_RETRY_AFTER_S));
          // Plan 2.6: muted line, rows kept, never a toast and never a role=status/alert on the line.
          await expect(listbox.locator('[role="option"][data-opt-kind="item"]').first()).toBeVisible();
          await expect(page.getByTestId('undo-toast-item')).toHaveCount(0);
          await expect(line).not.toHaveAttribute('role', /.+/);
        },
        { requireRows: true },
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

    const overlap = await page.evaluate(() => {
      const stack = document.querySelector<HTMLElement>('[data-testid="undo-toast-stack"]');
      const lb = document.getElementById('omni-listbox');
      if (!stack || !lb) return null;
      const a = stack.getBoundingClientRect();
      const b = lb.getBoundingClientRect();
      const intersects = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      return { intersects, stackTop: Math.round(a.top), listboxBottom: Math.round(b.bottom) };
    });
    expect(overlap, 'toast stack and listbox must both be present').not.toBeNull();
    await expectNoHorizontalScroll(ctx, 'undo-toast', 390);
    await saveCapture(ctx, 'undo-toast', 390);
    leakGuard.assertNoLeaks();
    leakGuard.assertSawEntriesPost();
    // FU10 (advisor-dec-326): the product fix for RV-T22-1-FE1-6 lands in this PR, so this is a HARD assert. It runs after the
    // capture so a red run still leaves the evidence screenshot.
    expect(
      overlap!.intersects,
      `undo toast stack overlaps the open dropdown at 390 (stackTop=${overlap!.stackTop}, listboxBottom=${overlap!.listboxBottom})`,
    ).toBe(false);
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
  // 22-2: the omnibox `omnibox-status-enable409` line and the settings `semanticEnable409` status need a server where
  // `semantic_available=true` but the breaker/provider is down (`fakeembed /__control {"mode":"down"}`); capture them there.
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
