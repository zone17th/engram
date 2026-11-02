import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  LOCKED_ITEM_FIXTURE,
  installItemPageContentMocks,
  type LockedItemEntriesFixture,
} from './content-itempage-support';
import { UI_WAIT_MS, installApiMocks, unlockFromBanner } from './vault-locked-support';

/**
 * FU11 JSON-TABLE + ITEM TOUCH (advisor-dec-216, -217, -221, -223, -224):
 * Verifies in a coarse-pointer context (`hasTouch: true, isMobile: true`, asserting
 * `window.matchMedia('(pointer: coarse)').matches === true`) at both 390x844 and 768x1024:
 * 1. Every item header and JSON table control reaches >= 44x44 px and `document.elementFromPoint`
 *    at all four corners (inset 1.5 px) and the center of its claimed >= 44x44 area hits the
 *    intended control:
 *    - breadcrumb "All items" link (`nav a[href="/app"]`)
 *    - inline `#tag` link and remove `×` button (`.chip-x`) in tag chips, including both a short tag
 *      and a 50-rune tag at 390, with distinct non-overlapping hit areas (dec-221)
 *    - short `json-cell-btn` values (`5432`), container toggles (`json-toggle-*`), field delete `×`
 *      buttons (`json-remove-field-*`), and array row delete `×` buttons (`json-remove-row-*`) (dec-217)
 *    - the whole in-cell JSON editor bar (`json-cell-input-*`, `json-type-select-*`,
 *      `json-commit-cell-*`, `json-cancel-cell-*`) and the add-field toolbar bar
 *      (`json-new-key-input-*`, `json-new-type-select-*`, `json-confirm-add-field-*`,
 *      `json-cancel-add-field-*`) (dec-223, dec-224)
 * 2. At 390 and 768, JSON table cells wrap without horizontal clipping, per-row delete `×` buttons
 *    remain on-screen inside the table host viewport in edit/table mode, and the item hint input
 *    placeholder fits without truncation at 390 (dec-216).
 * 3. In a default fine-pointer (`(pointer: fine)`) context, visible bounding boxes are unchanged
 *    when the FU11 coarse-pointer classes are removed.
 */

const TAG_LONG_50_NAME = `${'tag-chip-50-rune-'.repeat(2)}tail50`.padEnd(50, 'q').slice(0, 50);

const FU11_ITEM_FIXTURE: LockedItemEntriesFixture = {
  item: {
    ...LOCKED_ITEM_FIXTURE.item,
    hint: null,
    tags: [
      ...LOCKED_ITEM_FIXTURE.item.tags,
      {
        id: 'cccc3333-3333-4333-8333-333333333333',
        display: TAG_LONG_50_NAME,
      },
    ],
  },
  entries: LOCKED_ITEM_FIXTURE.entries,
};

const JSON_ENTRY_ID = FU11_ITEM_FIXTURE.entries.find((e) => e.meta.type === 'json')!.meta.id;

interface ProbedControlResult {
  readonly name: string;
  readonly selector: string;
  readonly rect: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly width: number;
    readonly height: number;
  };
  readonly hits: {
    readonly center: boolean;
    readonly topLeft: boolean;
    readonly topRight: boolean;
    readonly bottomLeft: boolean;
    readonly bottomRight: boolean;
  };
  readonly missDetails: readonly string[];
}

async function setupMockedItemPageRoutes(context: BrowserContext): Promise<void> {
  await installApiMocks(context);
  await installItemPageContentMocks(context, FU11_ITEM_FIXTURE);

  const itemId = FU11_ITEM_FIXTURE.item.id;

  // Playwright `*` does not cross `/`: register explicit item/tag/entry sub-routes after
  // `installApiMocks` + `installItemPageContentMocks` and call `route.fallback()` for others.
  await context.route(`**/api/v1/items/${itemId}/**`, async (route, request) => {
    const method = request.method();
    const pathname = new URL(request.url()).pathname;
    if (method === 'DELETE' && pathname.includes('/tags/')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FU11_ITEM_FIXTURE.item),
      });
      return;
    }
    if (method === 'POST' && pathname.endsWith('/tags')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FU11_ITEM_FIXTURE.item),
      });
      return;
    }
    await route.fallback();
  });

  await context.route(`**/api/v1/items/${itemId}`, async (route, request) => {
    if (request.method() === 'PATCH') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...FU11_ITEM_FIXTURE.item,
          version: FU11_ITEM_FIXTURE.item.version + 1,
        }),
      });
      return;
    }
    await route.fallback();
  });

  await context.route('**/api/v1/entries/**', async (route, request) => {
    if (request.method() === 'PUT') {
      const jsonRecord = FU11_ITEM_FIXTURE.entries.find((e) => e.meta.id === JSON_ENTRY_ID)!;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...jsonRecord.meta,
          version: jsonRecord.meta.version + 1,
        }),
      });
      return;
    }
    await route.fallback();
  });
}

async function probeCoarseControls(
  page: Page,
  targets: ReadonlyArray<{ readonly name: string; readonly selector: string }>,
): Promise<ProbedControlResult[]> {
  return page.evaluate((items) => {
    const describeNode = (node: Element | null): string => {
      if (!node) return 'null';
      const tag = node.tagName.toLowerCase();
      const testId = node.getAttribute('data-testid');
      const cls =
        typeof (node as HTMLElement).className === 'string' && (node as HTMLElement).className.trim()
          ? `.${(node as HTMLElement).className.trim().split(/\s+/).slice(0, 3).join('.')}`
          : '';
      return `${tag}${testId ? `[data-testid="${testId}"]` : ''}${cls}`;
    };

    const hitsIntendedControl = (el: HTMLElement, x: number, y: number): { ok: boolean; hitDesc: string } => {
      const hit = document.elementFromPoint(x, y);
      if (!hit) return { ok: false, hitDesc: 'null' };
      if (hit === el || el.contains(hit)) {
        return { ok: true, hitDesc: describeNode(hit) };
      }
      if (
        (el instanceof HTMLInputElement ||
          el instanceof HTMLSelectElement ||
          el instanceof HTMLTextAreaElement) &&
        el.labels
      ) {
        for (const label of Array.from(el.labels)) {
          if (label.contains(hit)) {
            return { ok: true, hitDesc: describeNode(hit) };
          }
        }
      }
      return { ok: false, hitDesc: describeNode(hit) };
    };

    return items.map(({ name, selector }) => {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) {
        throw new Error(`Missing control for selector (${name}): ${selector}`);
      }
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      const left = r.left;
      const top = r.top;
      const right = r.right;
      const bottom = r.bottom;
      const width = r.width;
      const height = r.height;

      const cx = (left + right) / 2;
      const cy = (top + bottom) / 2;
      const inset = 1.5;

      const points = {
        center: [cx, cy] as const,
        topLeft: [left + inset, top + inset] as const,
        topRight: [right - inset, top + inset] as const,
        bottomLeft: [left + inset, bottom - inset] as const,
        bottomRight: [right - inset, bottom - inset] as const,
      };

      const hits = {
        center: false,
        topLeft: false,
        topRight: false,
        bottomLeft: false,
        bottomRight: false,
      };
      const missDetails: string[] = [];

      (Object.keys(points) as Array<keyof typeof points>).forEach((key) => {
        const [px, py] = points[key];
        const res = hitsIntendedControl(el, px, py);
        hits[key] = res.ok;
        if (!res.ok) {
          missDetails.push(`${key}(${px.toFixed(1)},${py.toFixed(1)})->${res.hitDesc}`);
        }
      });

      return {
        name,
        selector,
        rect: { left, top, right, bottom, width, height },
        hits,
        missDetails,
      };
    });
  }, targets);
}

test.describe('FU11 JSON-TABLE + ITEM TOUCH 44x44 coarse-pointer targets and narrow table/hint layout', () => {
  test('coarse pointer at 390x844 and 768x1024 reaches >= 44x44 non-overlapping hit areas at 4 corners + center, keeps row delete on-screen, and fits hint placeholder', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    expect(Array.from(TAG_LONG_50_NAME).length).toBe(50);

    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });

    try {
      await setupMockedItemPageRoutes(context);
      const page = await context.newPage();
      await page.goto(`/app/items/${FU11_ITEM_FIXTURE.item.id}`);
      await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });

      const isCoarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
      expect(isCoarse).toBe(true);

      await unlockFromBanner(page);
      await expect(page).toHaveURL(new RegExp(`/app/items/${FU11_ITEM_FIXTURE.item.id}$`), {
        timeout: UI_WAIT_MS,
      });

      const tableHost = page.getByTestId(`json-table-host-${JSON_ENTRY_ID}`);
      await expect(tableHost).toBeVisible({ timeout: UI_WAIT_MS });

      // Expand nested array (`root.p3` = `["db","primary"]`) so primitive-array row delete `×` buttons are mounted
      const tagsToggle = tableHost.getByTestId('json-toggle-root.p3');
      await expect(tagsToggle).toBeVisible({ timeout: UI_WAIT_MS });
      await tagsToggle.click();
      await expect(tagsToggle).toHaveAttribute('aria-expanded', 'true');
      await expect(tableHost.getByTestId('json-remove-row-root.p3-0')).toBeVisible({
        timeout: UI_WAIT_MS,
      });

      const firstTagDisplay = FU11_ITEM_FIXTURE.item.tags[0]!.display;

      for (const viewport of [
        { width: 390, height: 844 },
        { width: 768, height: 1024 },
      ] as const) {
        await page.setViewportSize(viewport);

        // 1. Probe item header + JSON table read/action controls at 4 corners (inset 1.5 px) + center
        const baseTargets = [
          {
            name: 'breadcrumb-all-items',
            selector: '[data-testid="item-header"] nav a[href="/app"]',
          },
          {
            name: 'short-tag-link',
            selector: `[data-testid="item-tag-chip-${firstTagDisplay}"] a[href^="/app?tag="]`,
          },
          {
            name: 'short-tag-remove-x',
            selector: `[data-testid="item-tag-remove-${firstTagDisplay}"]`,
          },
          {
            name: 'long-50-rune-tag-link',
            selector: `[data-testid="item-tag-chip-${TAG_LONG_50_NAME}"] a[href^="/app?tag="]`,
          },
          {
            name: 'long-50-rune-tag-remove-x',
            selector: `[data-testid="item-tag-remove-${TAG_LONG_50_NAME}"]`,
          },
          {
            name: 'json-cell-btn-short-number',
            selector: '[data-testid="json-cell-btn-root.p1"]',
          },
          {
            name: 'json-cell-btn-key',
            selector: '[data-testid="json-cell-btn-root.k1"]',
          },
          {
            name: 'json-toggle-nested-array',
            selector: '[data-testid="json-toggle-root.p3"]',
          },
          {
            name: 'json-remove-field-btn',
            selector: '[data-testid="json-remove-field-root-0"]',
          },
          {
            name: 'json-remove-row-btn',
            selector: '[data-testid="json-remove-row-root.p3-0"]',
          },
        ] as const;

        const measuredBase = await probeCoarseControls(page, baseTargets);
        for (const ctrl of measuredBase) {
          expect(
            ctrl.rect.width,
            `${ctrl.name} width at ${viewport.width}`,
          ).toBeGreaterThanOrEqual(43.5);
          expect(
            ctrl.rect.height,
            `${ctrl.name} height at ${viewport.width}`,
          ).toBeGreaterThanOrEqual(43.5);
          expect(
            ctrl.hits,
            `${ctrl.name} 4-corner + center hits at ${viewport.width} (misses: ${ctrl.missDetails.join(', ')})`,
          ).toEqual({
            center: true,
            topLeft: true,
            topRight: true,
            bottomLeft: true,
            bottomRight: true,
          });
        }

        // Verify dec-221: inside each tag chip (short and 50-rune), the #tag link and remove x boxes do not overlap
        const shortLinkRect = measuredBase.find((c) => c.name === 'short-tag-link')!.rect;
        const shortRemoveRect = measuredBase.find((c) => c.name === 'short-tag-remove-x')!.rect;
        expect(shortLinkRect.right).toBeLessThanOrEqual(shortRemoveRect.left + 0.5);

        const longLinkRect = measuredBase.find((c) => c.name === 'long-50-rune-tag-link')!.rect;
        const longRemoveRect = measuredBase.find((c) => c.name === 'long-50-rune-tag-remove-x')!.rect;
        expect(longLinkRect.right).toBeLessThanOrEqual(longRemoveRect.left + 0.5);

        // 2. Verify dec-216: row/field delete buttons are visible on-screen within the table host & viewport
        //    and hint placeholder fits at 390 without clipping
        const layoutCheck = await page.evaluate((entryId) => {
          const host = document.querySelector<HTMLElement>(`[data-testid="json-table-host-${entryId}"]`);
          const removeField = document.querySelector<HTMLElement>(
            '[data-testid="json-remove-field-root-0"]',
          );
          const removeRow = document.querySelector<HTMLElement>(
            '[data-testid="json-remove-row-root.p3-0"]',
          );
          const hintInput = document.querySelector<HTMLInputElement>('[data-testid="item-hint-input"]');
          if (!host || !removeField || !removeRow || !hintInput) {
            throw new Error('Missing table host, remove buttons, or hint input');
          }
          const hostRect = host.getBoundingClientRect();
          const rfRect = removeField.getBoundingClientRect();
          const rrRect = removeRow.getBoundingClientRect();

          // Measure rendered width of hint placeholder using the computed placeholder styles
          const placeholderStyle = window.getComputedStyle(hintInput, '::placeholder');
          const inputStyle = window.getComputedStyle(hintInput);
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d')!;
          const fontSize = placeholderStyle.fontSize || inputStyle.fontSize;
          const fontFamily = placeholderStyle.fontFamily || inputStyle.fontFamily;
          const fontWeight = placeholderStyle.fontWeight || inputStyle.fontWeight;
          ctx.font = `${fontWeight} ${fontSize} ${fontFamily}`;
          const letterSpacing = Number.parseFloat(placeholderStyle.letterSpacing) || 0;
          const text = hintInput.placeholder;
          const measuredTextWidth =
            ctx.measureText(text).width + Math.max(0, text.length - 1) * letterSpacing;
          const padL = Number.parseFloat(inputStyle.paddingLeft) || 0;
          const padR = Number.parseFloat(inputStyle.paddingRight) || 0;
          const availableInnerWidth = hintInput.clientWidth - padL - padR;

          return {
            docScrollWidth: document.documentElement.scrollWidth,
            docClientWidth: document.documentElement.clientWidth,
            hostRight: hostRect.right,
            removeFieldRight: rfRect.right,
            removeFieldLeft: rfRect.left,
            removeRowRight: rrRect.right,
            removeRowLeft: rrRect.left,
            measuredPlaceholderWidth: measuredTextWidth,
            availableHintInnerWidth: availableInnerWidth,
          };
        }, JSON_ENTRY_ID);

        expect(layoutCheck.docScrollWidth).toBeLessThanOrEqual(layoutCheck.docClientWidth);
        expect(layoutCheck.removeFieldLeft).toBeGreaterThanOrEqual(0);
        expect(layoutCheck.removeFieldRight).toBeLessThanOrEqual(layoutCheck.hostRight + 1);
        expect(layoutCheck.removeRowLeft).toBeGreaterThanOrEqual(0);
        expect(layoutCheck.removeRowRight).toBeLessThanOrEqual(layoutCheck.hostRight + 1);
        expect(layoutCheck.measuredPlaceholderWidth).toBeLessThanOrEqual(
          layoutCheck.availableHintInnerWidth + 2,
        );

        // 3. Open inline cell editor on `root.p0` and probe the entire in-cell editor bar (dec-223, dec-224)
        await tableHost.getByTestId('json-cell-btn-root.p0').click();
        await expect(tableHost.getByTestId('json-cell-input-root.p0')).toBeVisible({
          timeout: UI_WAIT_MS,
        });

        const editorTargets = [
          {
            name: 'json-cell-input',
            selector: '[data-testid="json-cell-input-root.p0"]',
          },
          {
            name: 'json-type-select',
            selector: '[data-testid="json-type-select-root.p0"]',
          },
          {
            name: 'json-commit-cell',
            selector: '[data-testid="json-commit-cell-root.p0"]',
          },
          {
            name: 'json-cancel-cell',
            selector: '[data-testid="json-cancel-cell-root.p0"]',
          },
        ] as const;

        const measuredEditor = await probeCoarseControls(page, editorTargets);
        for (const ctrl of measuredEditor) {
          expect(
            ctrl.rect.width,
            `${ctrl.name} width at ${viewport.width}`,
          ).toBeGreaterThanOrEqual(43.5);
          expect(
            ctrl.rect.height,
            `${ctrl.name} height at ${viewport.width}`,
          ).toBeGreaterThanOrEqual(43.5);
          expect(
            ctrl.hits,
            `${ctrl.name} 4-corner + center hits at ${viewport.width} (misses: ${ctrl.missDetails.join(', ')})`,
          ).toEqual({
            center: true,
            topLeft: true,
            topRight: true,
            bottomLeft: true,
            bottomRight: true,
          });
        }

        // Close inline cell editor before next viewport iteration
        await tableHost.getByTestId('json-cancel-cell-root.p0').click();
        await expect(tableHost.getByTestId('json-cell-input-root.p0')).toBeHidden({
          timeout: UI_WAIT_MS,
        });

        // 4. Open object add-field toolbar form and probe its controls
        await tableHost.getByTestId('json-open-add-field-root').click();
        await expect(tableHost.getByTestId('json-new-key-input-root')).toBeVisible({
          timeout: UI_WAIT_MS,
        });
        const addFieldTargets = [
          {
            name: 'json-new-key-input',
            selector: '[data-testid="json-new-key-input-root"]',
          },
          {
            name: 'json-new-type-select',
            selector: '[data-testid="json-new-type-select-root"]',
          },
          {
            name: 'json-confirm-add-field',
            selector: '[data-testid="json-confirm-add-field-root"]',
          },
          {
            name: 'json-cancel-add-field',
            selector: '[data-testid="json-cancel-add-field-root"]',
          },
        ] as const;

        const measuredAddField = await probeCoarseControls(page, addFieldTargets);
        for (const ctrl of measuredAddField) {
          expect(
            ctrl.rect.width,
            `${ctrl.name} width at ${viewport.width}`,
          ).toBeGreaterThanOrEqual(43.5);
          expect(
            ctrl.rect.height,
            `${ctrl.name} height at ${viewport.width}`,
          ).toBeGreaterThanOrEqual(43.5);
          expect(
            ctrl.hits,
            `${ctrl.name} 4-corner + center hits at ${viewport.width} (misses: ${ctrl.missDetails.join(', ')})`,
          ).toEqual({
            center: true,
            topLeft: true,
            topRight: true,
            bottomLeft: true,
            bottomRight: true,
          });
        }
        await tableHost.getByTestId('json-cancel-add-field-root').click();
        await expect(tableHost.getByTestId('json-new-key-input-root')).toBeHidden({
          timeout: UI_WAIT_MS,
        });
      }
    } finally {
      await context.close();
    }
  });

  test('fine pointer context preserves identical bounding boxes with and without FU11 coarse classes', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      hasTouch: false,
      isMobile: false,
    });

    try {
      await setupMockedItemPageRoutes(context);
      const page = await context.newPage();
      await page.goto(`/app/items/${FU11_ITEM_FIXTURE.item.id}`);
      await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });

      const isCoarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
      expect(isCoarse).toBe(false);

      await unlockFromBanner(page);
      await expect(page).toHaveURL(new RegExp(`/app/items/${FU11_ITEM_FIXTURE.item.id}$`), {
        timeout: UI_WAIT_MS,
      });

      const tableHost = page.getByTestId(`json-table-host-${JSON_ENTRY_ID}`);
      await expect(tableHost).toBeVisible({ timeout: UI_WAIT_MS });

      // Expand nested array and open inline cell editor so all controls are in the DOM
      await tableHost.getByTestId('json-toggle-root.p3').click();
      await tableHost.getByTestId('json-cell-btn-root.p0').click();
      await expect(tableHost.getByTestId('json-cell-input-root.p0')).toBeVisible({
        timeout: UI_WAIT_MS,
      });

      const firstTagDisplay = FU11_ITEM_FIXTURE.item.tags[0]!.display;

      const comparison = await page.evaluate(
        ({ shortTag, longTag }) => {
          const selectors = {
            breadcrumbAllItems: '[data-testid="item-header"] nav a[href="/app"]',
            shortTagChip: `[data-testid="item-tag-chip-${shortTag}"]`,
            shortTagLink: `[data-testid="item-tag-chip-${shortTag}"] a[href^="/app?tag="]`,
            shortTagRemove: `[data-testid="item-tag-remove-${shortTag}"]`,
            longTagChip: `[data-testid="item-tag-chip-${longTag}"]`,
            longTagLink: `[data-testid="item-tag-chip-${longTag}"] a[href^="/app?tag="]`,
            longTagRemove: `[data-testid="item-tag-remove-${longTag}"]`,
            cellBtnNumber: '[data-testid="json-cell-btn-root.p1"]',
            removeFieldBtn: '[data-testid="json-remove-field-root-0"]',
            removeRowBtn: '[data-testid="json-remove-row-root.p3-0"]',
            cellInput: '[data-testid="json-cell-input-root.p0"]',
            typeSelect: '[data-testid="json-type-select-root.p0"]',
            commitCellBtn: '[data-testid="json-commit-cell-root.p0"]',
            cancelCellBtn: '[data-testid="json-cancel-cell-root.p0"]',
          } as const;

          const measureAll = () => {
            const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
            for (const [key, sel] of Object.entries(selectors)) {
              const r = document.querySelector<HTMLElement>(sel)!.getBoundingClientRect();
              out[key] = { x: r.x, y: r.y, width: r.width, height: r.height };
            }
            return out;
          };

          const withCoarseClasses = measureAll();

          // Strip every `[@media(pointer:coarse)]:*` class token and measure again
          const savedClasses = new Map<HTMLElement, string>();
          let strippedTokenCount = 0;
          for (const el of Array.from(document.querySelectorAll<HTMLElement>('[class]'))) {
            const tokens = Array.from(el.classList);
            const coarseTokens = tokens.filter((t) => t.startsWith('[@media(pointer:coarse)]:'));
            if (coarseTokens.length > 0) {
              savedClasses.set(el, el.className);
              for (const t of coarseTokens) {
                el.classList.remove(t);
                strippedTokenCount += 1;
              }
            }
          }

          const withoutCoarseClasses = measureAll();

          for (const [el, orig] of savedClasses.entries()) {
            el.className = orig;
          }

          return {
            strippedTokenCount,
            withCoarseClasses,
            withoutCoarseClasses,
          };
        },
        { shortTag: firstTagDisplay, longTag: TAG_LONG_50_NAME },
      );

      expect(comparison.strippedTokenCount).toBeGreaterThan(0);
      expect(comparison.withCoarseClasses).toEqual(comparison.withoutCoarseClasses);
    } finally {
      await context.close();
    }
  });
});
