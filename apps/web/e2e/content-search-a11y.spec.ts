import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
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
import { SEARCH_LISTBOX_ID, SEARCH_OMNIBOX_SELECTOR } from './content-search-support';
import { newContext, uniqueEmail } from './helpers';

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
 * 22-2 (`@semantic`): axe + markup with the near zone, the ≈ badge, `omnibox-status-near-pending`, `omnibox-status-degraded`
 * and the enable-409 line (not reachable on the noop stack; see content-search-visual.spec.ts).
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
// Seeding (real API; paced under the 10 writes / 1 s content_write limit)
// ---------------------------------------------------------------------------------------------------------------------

async function seedCorpus(page: Page): Promise<void> {
  const spec = { nimbusCount: NIMBUS_COUNT, nimbusTag: NIMBUS_TAG, tagNames: [...TAG_NAMES] };
  await page.evaluate(async (s) => {
    const csrf = (() => {
      for (const part of document.cookie.split(';')) {
        const trimmed = part.trim();
        if (trimmed.startsWith('sabk_csrf=')) {
          return decodeURIComponent(trimmed.slice('sabk_csrf='.length));
        }
      }
      return '';
    })();
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const post = async (path: string, body: unknown): Promise<{ id: string }> => {
      const key = `seed-${crypto.randomUUID().replace(/-/g, '')}`;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const res = await fetch(`/api/v1${path}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'Idempotency-Key': key,
            ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          },
          body: JSON.stringify(body),
        });
        if (res.status === 429) {
          const retry = Number(res.headers.get('retry-after') ?? '1');
          await sleep((Number.isFinite(retry) && retry > 0 ? retry : 1) * 1000 + 50);
          continue;
        }
        if (!res.ok) {
          throw new Error(`seed POST ${path.replace(/[0-9a-f-]{36}/g, ':id')} -> ${res.status}`);
        }
        const parsed = (await res.json()) as { id: string };
        await sleep(110);
        return parsed;
      }
      throw new Error(`seed POST ${path.replace(/[0-9a-f-]{36}/g, ':id')} kept hitting 429`);
    };

    const tagIds: Record<string, string> = {};
    for (const display of s.tagNames) {
      tagIds[display] = (await post('/tags', { display })).id;
    }
    for (let n = 1; n <= s.nimbusCount; n += 1) {
      const item = await post('/items', { name: `nimbus ${String(n).padStart(2, '0')}` });
      if (n <= 2) {
        await post(`/items/${item.id}/tags`, { tag_ids: [tagIds[s.nimbusTag]!] });
      }
    }
    const viet = await post('/items', { name: 'mã wifi nhà' });
    await post(`/items/${viet.id}/tags`, { tag_ids: [tagIds.network!] });
  }, spec);
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
  open: () => Promise<void>,
  opts: { readonly markup?: boolean } = {},
): Promise<void> {
  for (const { width, height } of AXE_WIDTHS) {
    await ctx.page.setViewportSize({ width, height });
    await settle(ctx.page);
    await resetOmnibox(ctx.page);
    await open();
    await settle(ctx.page);
    const label = `${state} ${ctx.lang}-${ctx.theme} ${width}`;
    if (opts.markup) await expectListboxMarkup(ctx.page, label);
    await expectAxeClean(ctx.page, label);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Keyboard-only journey (en-light): `/`, ↓, Tab, Enter
// ---------------------------------------------------------------------------------------------------------------------

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
  await page.keyboard.press('ArrowDown');
  const active = listbox.locator('[role="option"][aria-selected="true"]');
  await expect(active).toHaveCount(1);
  const activeId = await active.getAttribute('id');
  expect(activeId).toBeTruthy();
  await expect(omnibox).toHaveAttribute('aria-activedescendant', activeId!);
  const activeKind = await active.getAttribute('data-opt-kind');
  expect(activeKind).toBe('item');
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
  await page.keyboard.press('ArrowDown');
  await expect(listbox.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
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
