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
 * 2. In a default fine-pointer (`(pointer: fine)`) context, visible bounding boxes on 1440x900
 *    and 390x844 are completely unchanged by `.touch-target` (equal before and after removing
 *    `.touch-target` on the same page, with `::after` content `'none'`).
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
      // Probe 1.5px inside the 44x44 effective box edges around the control center so subpixel
      // flex centering (e.g. cy = 33.5 -> y = 54.5 rounding to y = 55) stays strictly inside the
      // control's 44px box [12..56] instead of landing on the bottom border pixel.
      const halfW = Math.max(22, width / 2) - 1.5;
      const halfH = Math.max(22, height / 2) - 1.5;

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

      const desktopComparison = await page.evaluate(() => {
        const selectors = {
          logo: 'header a[href="/app"]',
          vaultLock: '[data-testid="vault-lock-button"]',
          vaultPill: '[data-testid="vault-lock-button"] .vault-pill',
          settings: 'header a[href="/app/settings"]',
          themeToggle: 'header button.btn-icon',
          signOut: 'header div.ml-auto > button.btn-tertiary:not(.btn-icon)',
        } as const;

        const measureAll = () => {
          const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
          for (const [key, sel] of Object.entries(selectors)) {
            const r = document.querySelector<HTMLElement>(sel)!.getBoundingClientRect();
            out[key] = { x: r.x, y: r.y, width: r.width, height: r.height };
          }
          return out;
        };

        const afterContents: Record<string, string> = {};
        for (const [key, sel] of Object.entries(selectors)) {
          const el = document.querySelector<HTMLElement>(sel)!;
          afterContents[key] = window.getComputedStyle(el, '::after').content;
        }

        const withTouchTarget = measureAll();
        const touchedNodes = Array.from(document.querySelectorAll<HTMLElement>('.touch-target'));
        for (const node of touchedNodes) {
          node.classList.remove('touch-target');
        }
        const withoutTouchTarget = measureAll();
        for (const node of touchedNodes) {
          node.classList.add('touch-target');
        }

        return {
          afterContents,
          touchedCount: touchedNodes.length,
          withTouchTarget,
          withoutTouchTarget,
        };
      });

      // Under fine pointer, .touch-target::after is not generated and every header control's box is identical with or without .touch-target
      expect(desktopComparison.touchedCount).toBeGreaterThan(0);
      for (const [key, content] of Object.entries(desktopComparison.afterContents)) {
        expect(content, `${key} ::after content at 1440 fine pointer`).toBe('none');
      }
      expect(desktopComparison.withTouchTarget).toEqual(desktopComparison.withoutTouchTarget);

      // At 390x844 under fine pointer (e.g. desktop mobile-390 Playwright project), all visible header controls also match with vs without .touch-target
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId('vault-lock-button-mobile')).toBeVisible({ timeout: UI_WAIT_MS });
      const mobileFineComparison = await page.evaluate(() => {
        const selectors = {
          logo: 'header a[href="/app"]',
          vaultLockMobile: '[data-testid="vault-lock-button-mobile"]',
          settings: 'header a[href="/app/settings"]',
          themeToggle: 'header button.btn-icon',
          signOut: 'header div.ml-auto > button.btn-tertiary:not(.btn-icon)',
        } as const;

        const measureAll = () => {
          const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
          for (const [key, sel] of Object.entries(selectors)) {
            const r = document.querySelector<HTMLElement>(sel)!.getBoundingClientRect();
            out[key] = { x: r.x, y: r.y, width: r.width, height: r.height };
          }
          return out;
        };

        const afterContents: Record<string, string> = {};
        for (const [key, sel] of Object.entries(selectors)) {
          const el = document.querySelector<HTMLElement>(sel)!;
          afterContents[key] = window.getComputedStyle(el, '::after').content;
        }

        const withTouchTarget = measureAll();
        const touchedNodes = Array.from(document.querySelectorAll<HTMLElement>('.touch-target'));
        for (const node of touchedNodes) {
          node.classList.remove('touch-target');
        }
        const withoutTouchTarget = measureAll();
        for (const node of touchedNodes) {
          node.classList.add('touch-target');
        }

        return {
          afterContents,
          touchedCount: touchedNodes.length,
          withTouchTarget,
          withoutTouchTarget,
        };
      });

      expect(mobileFineComparison.touchedCount).toBeGreaterThan(0);
      for (const [key, content] of Object.entries(mobileFineComparison.afterContents)) {
        expect(content, `${key} ::after content at 390 fine pointer`).toBe('none');
      }
      expect(mobileFineComparison.withTouchTarget).toEqual(mobileFineComparison.withoutTouchTarget);
    } finally {
      await context.close();
    }
  });

  test('coarse pointer on /app/auth/login keeps .field-toggle computed position absolute and inside the password input box while reaching >= 44x44 hit area (LEAD-FU3-1)', async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });

    try {
      const url = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
      await context.addCookies([
        { name: 'sabk_csrf', value: 'test-csrf-token', url },
        { name: 'sabk_locale', value: 'en', url },
      ]);
      await context.route('**/api/v1/auth/csrf', async (route) => {
        await route.fulfill({
          status: 204,
          headers: { 'set-cookie': 'sabk_csrf=test-csrf-token; Path=/; SameSite=Lax' },
        });
      });
      await context.route('**/api/v1/auth/config', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            oauth_providers: [],
            email_verification_required: false,
            captcha_site_key: null,
          }),
        });
      });
      await context.route('**/api/v1/auth/me', async (route) => {
        await route.fulfill({
          status: 401,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'about:blank',
            title: 'Unauthenticated',
            status: 401,
            code: 'unauthenticated',
          }),
        });
      });

      const page = await context.newPage();
      await page.goto('/app/auth/login');
      await expect(page.locator('#auth-login')).toBeVisible({ timeout: UI_WAIT_MS });

      const isCoarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
      expect(isCoarse).toBe(true);

      const fieldToggleCheck = await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>(
          '#auth-login .field-password .field-input',
        );
        const toggle = document.querySelector<HTMLButtonElement>(
          '#auth-login .field-password .field-toggle',
        );
        if (!input || !toggle) {
          throw new Error('Missing password .field-input or .field-toggle on /app/auth/login');
        }
        const toggleStyle = window.getComputedStyle(toggle);
        const inputRect = input.getBoundingClientRect();
        const toggleRect = toggle.getBoundingClientRect();
        return {
          computedPosition: toggleStyle.position,
          hasTouchTargetClass: toggle.classList.contains('touch-target'),
          inputRect: {
            left: inputRect.left,
            top: inputRect.top,
            right: inputRect.right,
            bottom: inputRect.bottom,
            width: inputRect.width,
            height: inputRect.height,
          },
          toggleRect: {
            left: toggleRect.left,
            top: toggleRect.top,
            right: toggleRect.right,
            bottom: toggleRect.bottom,
            width: toggleRect.width,
            height: toggleRect.height,
          },
        };
      });

      expect(fieldToggleCheck.hasTouchTargetClass).toBe(true);
      expect(fieldToggleCheck.computedPosition).toBe('absolute');
      expect(fieldToggleCheck.toggleRect.left).toBeGreaterThanOrEqual(
        fieldToggleCheck.inputRect.left,
      );
      expect(fieldToggleCheck.toggleRect.right).toBeLessThanOrEqual(
        fieldToggleCheck.inputRect.right,
      );
      expect(fieldToggleCheck.toggleRect.top).toBeGreaterThanOrEqual(
        fieldToggleCheck.inputRect.top,
      );
      expect(fieldToggleCheck.toggleRect.bottom).toBeLessThanOrEqual(
        fieldToggleCheck.inputRect.bottom,
      );

      const [measuredToggle] = await measureHeaderControls(page, [
        { name: 'password-field-toggle', selector: '#auth-login .field-password .field-toggle' },
      ]);
      expect(measuredToggle!.effectiveRect.width).toBeGreaterThanOrEqual(44);
      expect(measuredToggle!.effectiveRect.height).toBeGreaterThanOrEqual(44);
      expect(measuredToggle!.probeHits).toEqual({
        center: true,
        left: true,
        right: true,
        top: true,
        bottom: true,
      });
    } finally {
      await context.close();
    }
  });
});
