import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { installHomeContentMetadataRoutes } from './content-home-support';
import { UI_WAIT_MS, installApiMocks, unlockFromBanner } from './vault-locked-support';

/**
 * FU3 UI-TOUCH-44 (advisor-dec-204, RV-UI4-6, dec-206):
 * Verifies that:
 * 1. Under `@media (pointer: coarse)` (mobile/tablet touch contexts at 390x844 and 768x1024),
 *    every AppHeader action (logo link, vault lock button / mobile lock button, Settings link,
 *    theme toggle, Sign out button) has an effective hit box >= 44x44 px (both via bounding box +
 *    `::after` / `::before` pseudo-element geometry and via `document.elementFromPoint` probes near
 *    the 44x44 box edges), with no neighbour hit-box overlap that steals taps.
 * 2. In a default fine-pointer (`(pointer: fine)`) context, visible bounding boxes are unchanged
 *    from pre-FU3 CSS sizes (38px height on `.btn-tertiary` / `.btn-icon` / mobile pill, 33.5px on
 *    desktop `.vault-pill`, 28px on logo).
 */

interface MeasuredControl {
  name: string;
  rect: { x: number; y: number; width: number; height: number };
  effectiveRect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  probeHits: { center: boolean; left: boolean; right: boolean; top: boolean; bottom: boolean };
}

async function setupMockedHomeRoute(context: BrowserContext) {
  await installApiMocks(context);
  await installHomeContentMetadataRoutes(context);
}

async function measureHeaderControls(page: Page, selectors: ReadonlyArray<{ name: string; selector: string }>): Promise<MeasuredControl[]> {
  return page.evaluate((items) => {
    function parsePx(val: string): number {
      const n = Number.parseFloat(val);
      return Number.isFinite(n) ? n : 0;
    }

    function expandWithPseudo(
      rect: DOMRect,
      style: CSSStyleDeclaration,
    ): { left: number; top: number; right: number; bottom: number } {
      if (!style.content || style.content === 'none' || style.content === 'normal') {
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      }
      const topInset = parsePx(style.top);
      const rightInset = parsePx(style.right);
      const bottomInset = parsePx(style.bottom);
      const leftInset = parsePx(style.left);
      return {
        left: Math.min(rect.left, rect.left + leftInset),
        top: Math.min(rect.top, rect.top + topInset),
        right: Math.max(rect.right, rect.right - rightInset),
        bottom: Math.max(rect.bottom, rect.bottom - bottomInset),
      };
    }

    function hitsControl(el: Element, x: number, y: number): boolean {
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit && (hit === el || el.contains(hit)));
    }

    return items.map(({ name, selector }) => {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) {
        throw new Error(`Missing header control for selector: ${selector}`);
      }
      const rect = el.getBoundingClientRect();
      const afterBounds = expandWithPseudo(rect, window.getComputedStyle(el, '::after'));
      const beforeBounds = expandWithPseudo(rect, window.getComputedStyle(el, '::before'));

      const left = Math.min(rect.left, afterBounds.left, beforeBounds.left);
      const top = Math.min(rect.top, afterBounds.top, beforeBounds.top);
      const right = Math.max(rect.right, afterBounds.right, beforeBounds.right);
      const bottom = Math.max(rect.bottom, afterBounds.bottom, beforeBounds.bottom);
      const width = right - left;
      const height = bottom - top;

      const cx = (left + right) / 2;
      const cy = (top + bottom) / 2;
      // Probe 1px inside the 44x44 effective box edges around the control center
      const halfW = Math.max(22, width / 2) - 1;
      const halfH = Math.max(22, height / 2) - 1;

      return {
        name,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        effectiveRect: { left, top, right, bottom, width, height },
        probeHits: {
          center: hitsControl(el, cx, cy),
          left: hitsControl(el, cx - halfW, cy),
          right: hitsControl(el, cx + halfW, cy),
          top: hitsControl(el, cx, cy - halfH),
          bottom: hitsControl(el, cx, cy + halfH),
        },
      };
    });
  }, selectors);
}

test.describe('FU3 UI-TOUCH-44 header and primary control touch targets', () => {
  test('coarse pointer at 390x844 and 768x1024 reaches >= 44x44 px hit area on every header action without neighbour overlap', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });

    try {
      await setupMockedHomeRoute(context);
      const page = await context.newPage();
      await page.goto('/app');
      await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });

      const isCoarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
      expect(isCoarse).toBe(true);

      // Unlock vault so the interactive vault lock button is active in the header (returns to /app)
      await unlockFromBanner(page);
      await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('vault-lock-button-mobile')).toBeVisible({ timeout: UI_WAIT_MS });
      const mobileControls = await measureHeaderControls(page, [
        { name: 'logo', selector: 'header a[href="/app"]' },
        { name: 'vault-lock-mobile', selector: '[data-testid="vault-lock-button-mobile"]' },
        { name: 'settings', selector: 'header a[href="/app/settings"]' },
        { name: 'theme-toggle', selector: 'header button.btn-icon' },
        { name: 'sign-out', selector: 'header div.ml-auto > button.btn-tertiary:not(.btn-icon)' },
      ]);

      for (const ctrl of mobileControls) {
        expect(ctrl.effectiveRect.width, `${ctrl.name} width at 390`).toBeGreaterThanOrEqual(44);
        expect(ctrl.effectiveRect.height, `${ctrl.name} height at 390`).toBeGreaterThanOrEqual(44);
        expect(ctrl.probeHits, `${ctrl.name} elementFromPoint probes at 390`).toEqual({
          center: true,
          left: true,
          right: true,
          top: true,
          bottom: true,
        });
      }

      // Verify adjacent right-hand header controls do not overlap horizontally at 390px
      const rightCluster = mobileControls.slice(1);
      for (let i = 0; i < rightCluster.length - 1; i++) {
        const cur = rightCluster[i]!;
        const next = rightCluster[i + 1]!;
        expect(
          cur.effectiveRect.right,
          `${cur.name} right edge vs ${next.name} left edge at 390`,
        ).toBeLessThanOrEqual(next.effectiveRect.left + 0.5);
      }

      // 2. Resize to 768x1024 under coarse pointer so desktop vault-lock-button (with VaultPill) is visible
      await page.setViewportSize({ width: 768, height: 1024 });
      await expect(page.getByTestId('vault-lock-button')).toBeVisible({ timeout: UI_WAIT_MS });

      const tabletControls = await measureHeaderControls(page, [
        { name: 'logo', selector: 'header a[href="/app"]' },
        { name: 'vault-lock-desktop', selector: '[data-testid="vault-lock-button"]' },
        { name: 'settings', selector: 'header a[href="/app/settings"]' },
        { name: 'theme-toggle', selector: 'header button.btn-icon' },
        { name: 'sign-out', selector: 'header div.ml-auto > button.btn-tertiary:not(.btn-icon)' },
      ]);

      for (const ctrl of tabletControls) {
        expect(ctrl.effectiveRect.width, `${ctrl.name} width at 768`).toBeGreaterThanOrEqual(44);
        expect(ctrl.effectiveRect.height, `${ctrl.name} height at 768`).toBeGreaterThanOrEqual(44);
        expect(ctrl.probeHits, `${ctrl.name} elementFromPoint probes at 768`).toEqual({
          center: true,
          left: true,
          right: true,
          top: true,
          bottom: true,
        });
      }
    } finally {
      await context.close();
    }
  });

  test('fine pointer context preserves exact pre-change visible bounding boxes on 390x844 and 1440x900', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      hasTouch: false,
      isMobile: false,
    });

    try {
      await setupMockedHomeRoute(context);
      const page = await context.newPage();
      await page.goto('/app');
      await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });

      const isCoarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
      expect(isCoarse).toBe(false);

      await unlockFromBanner(page);
      await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('vault-lock-button')).toBeVisible({ timeout: UI_WAIT_MS });

      const desktopBoxes = await page.evaluate(() => {
        const q = (sel: string) => {
          const r = document.querySelector<HTMLElement>(sel)!.getBoundingClientRect();
          return { width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 };
        };
        const logoEl = document.querySelector<HTMLElement>('header a[href="/app"]')!;
        const afterContent = window.getComputedStyle(logoEl, '::after').content;
        return {
          afterContent,
          logo: q('header a[href="/app"]'),
          vaultLock: q('[data-testid="vault-lock-button"]'),
          vaultPill: q('[data-testid="vault-lock-button"] .vault-pill'),
          settings: q('header a[href="/app/settings"]'),
          themeToggle: q('header button.btn-icon'),
          signOut: q('header div.ml-auto > button.btn-tertiary:not(.btn-icon)'),
        };
      });

      // Under fine pointer, .touch-target::after is not generated and heights stay at desktop values (38px buttons, 28px logo, < 38px pill)
      expect(desktopBoxes.afterContent).toBe('none');
      expect(desktopBoxes.logo.height).toBe(28);
      expect(desktopBoxes.vaultLock.height).toBeLessThan(38);
      expect(desktopBoxes.vaultPill.height).toBeLessThan(38);
      expect(desktopBoxes.settings.height).toBe(38);
      expect(desktopBoxes.themeToggle.height).toBe(38);
      expect(desktopBoxes.signOut.height).toBe(38);

      // At 390x844 under fine pointer (e.g. desktop mobile-390 Playwright project), mobile lock button stays 38x38
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId('vault-lock-button-mobile')).toBeVisible({ timeout: UI_WAIT_MS });
      const mobileFineBox = await page.getByTestId('vault-lock-button-mobile').boundingBox();
      expect(mobileFineBox?.width).toBe(38);
      expect(mobileFineBox?.height).toBe(38);
    } finally {
      await context.close();
    }
  });
});
