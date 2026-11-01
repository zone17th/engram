import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MOCKED_HOME_ITEMS, MOCKED_HOME_TAGS, installHomeContentMetadataRoutes } from './content-home-support';
import { STEP_TIMEOUT, UI_WAIT_MS, installApiMocks, type Theme } from './vault-locked-support';

type Locale = 'en' | 'vi';

/**
 * Layers locale + theme cookies, `Accept-Language`, and `/api/v1/auth/me` (`settings.locale`, `settings.theme`)
 * on top of `installApiMocks` without adding a second catch-all route.
 */
async function applyLocaleAndThemeMocks(
  context: BrowserContext,
  locale: Locale,
  theme: Theme,
): Promise<void> {
  const origin = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:3000').origin;
  await context.setExtraHTTPHeaders({
    'accept-language': locale === 'vi' ? 'vi-VN,vi;q=0.9,en;q=0.8' : 'en-US,en;q=0.9',
  });
  await context.addCookies([
    { name: 'sabk_locale', value: locale, url: `${origin}/` },
    { name: 'sabk_theme', value: theme, url: `${origin}/` },
    { name: 'sabk_csrf', value: 'test-csrf-token', url: `${origin}/` },
  ]);

  await context.route('**/api/v1/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: '22222222-2222-4222-8222-222222222222',
          email: 'vault-locked@example.test',
          email_verified: true,
          created_at: '2026-10-30T00:00:00Z',
        },
        settings: { locale, theme, auto_lock_minutes: 15, semantic_suggest: false },
        identities: [{ provider: 'password', linked_at: '2026-10-30T00:00:00Z' }],
        features: {
          semantic_available: false,
          email_verification_required: false,
          oauth_providers: [],
          oauth_reauth_providers: [],
          password_enrollment_available: false,
          captcha_site_key: null,
        },
        vault: { status: 'present' },
      }),
    });
  });
}

async function saveToastCapture(
  page: Page,
  testInfo: TestInfo,
  fileName: string,
): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}',
  });
  await page.evaluate(() => {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    return promise;
  });
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);

  const outputPath = testInfo.outputPath(fileName);
  mkdirSync(dirname(outputPath), { recursive: true });
  const buffer = await page.screenshot({
    path: outputPath,
    timeout: STEP_TIMEOUT,
    fullPage: false,
    animations: 'disabled',
    caret: 'hide',
  });
  expect(buffer.byteLength).toBeGreaterThan(0);
}

/**
 * FU10 UNDO-TOAST-390 (advisor-dec-216, ACC-TV1-2, ACC-TV1-5; fix2 RV-FU10-1..2, TV-FU10-1..3; fix3 RV-FU10-R2-1..3):
 * Verifies at 390x844 and 768x1024 viewports that:
 * 1. At 390x844, the undo-toast stack (`data-testid="undo-toast-stack"`) is anchored to the viewport bottom
 *    (16 px bottom inset), has width >= 390 - 2*16 - 2 (356 px, 16 px side gutters), has bounded
 *    height with a 200-rune item name (message clamped to <= 2 lines, full 200-rune name preserved
 *    in `title` and `role="status"` live region), and its bounding box does not overlap the omnibox input
 *    or an open omnibox listbox.
 * 2. At 390x844 with a multi-toast stack (3 visible toasts + `+1` overflow button), the stack remains
 *    bottom-anchored (`bottom` within 12–20 px of the viewport bottom).
 * 3. At both 390x844 and 768x1024 (ACC-TV1-5, RV-FU10-1, RV-FU10-2, TV-FU10-2, RV-FU10-R2-1, RV-FU10-R2-2),
 *    when a page control positioned under the stack (including the last focusable control at the end of `/app`
 *    and when a 2nd toast grows the stack while a control is focused) receives keyboard focus, `UndoToastProvider`
 *    adds bottom scroll room (`--undo-stack-h`, `scroll-padding-bottom`, and `body { padding-bottom: calc(var(--undo-stack-h) + 8px) }`)
 *    and scrolls it clear of the stack so its bounding rect + 2 px does not intersect the stack rect and
 *    `document.elementFromPoint` at its center hits the focused control.
 * 4. Saves CI evidence screenshots (`fu10-undo-toast-{en-light,vi-dark}-{390,768}.png` and
 *    `fu10-undo-toast-stack-en-light-390.png`) into `testInfo.outputPath(...)` for the sanitizer allowlist.
 */
test.describe('FU10 UNDO-TOAST-390 compact bottom-anchored undo-toast stack and focus-ring clearance at 390x844 & 768x1024', () => {
  test('at 390x844 (en light & vi dark): 200-rune toast geometry, non-overlap with omnibox & open listbox, 3-toast + "+1" stack bottom-anchoring, keyboard Tab focus clearance, and CI captures', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(90_000);

    const long200RuneName = `${'long-item-segment-'.repeat(11)}ab`;
    expect(Array.from(long200RuneName).length).toBe(200);

    const extraItems = Array.from({ length: 8 }, (_, idx) => ({
      id: `00000000-0000-4000-8000-00000000030${idx + 1}`,
      name: `Fixture card ${idx + 1}`,
      hint: 'Fixture summary line for scrollable viewport height',
      tags: [MOCKED_HOME_TAGS[0]!],
      entry_count: idx + 1,
      version: 1,
      created_at: '2026-10-30T00:00:00Z',
      updated_at: '2026-10-30T00:00:00Z',
      last_used_at: '2026-10-30T00:00:00Z',
    }));
    const allHomeItems = [...MOCKED_HOME_ITEMS, ...extraItems];

    // --- Part A: 390x844 en light ---
    const contextEn = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });

    try {
      await installApiMocks(contextEn);
      await applyLocaleAndThemeMocks(contextEn, 'en', 'light');
      await installHomeContentMetadataRoutes(contextEn);

      const createdItemId = '00000000-0000-4000-8000-000000000999';
      let deletedItemId: string | null = null;

      const createdItemSummary = {
        id: createdItemId,
        name: long200RuneName,
        hint: null,
        tags: [],
        entry_count: 0,
        version: 1,
        created_at: '2026-11-02T00:00:00Z',
        updated_at: '2026-11-02T00:00:00Z',
        last_used_at: '2026-11-02T00:00:00Z',
      };

      // Playwright `*` does not cross `/`: register both `**/api/v1/items*` and `**/api/v1/items/**`
      // plus `**/api/v1/tags/**` after `installApiMocks` + `installHomeContentMetadataRoutes`.
      await contextEn.route('**/api/v1/items*', async (route, request) => {
        const url = new URL(request.url());
        if (request.method() === 'POST' && url.pathname === '/api/v1/items') {
          await route.fulfill({
            status: 201,
            contentType: 'application/json',
            body: JSON.stringify(createdItemSummary),
          });
          return;
        }
        if (request.method() === 'GET' && url.pathname === '/api/v1/items') {
          const rawQ = url.searchParams.get('q') ?? '';
          if (!rawQ) {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ items: allHomeItems, next_cursor: null }),
            });
            return;
          }
        }
        await route.fallback();
      });

      await contextEn.route('**/api/v1/items/**', async (route, request) => {
        const method = request.method();
        const pathname = new URL(request.url()).pathname;
        if (method === 'DELETE') {
          deletedItemId = pathname.split('/').pop() ?? null;
          await route.fulfill({ status: 204 });
          return;
        }
        if (method === 'POST' && pathname.endsWith('/restore')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(createdItemSummary),
          });
          return;
        }
        await route.fallback();
      });

      await contextEn.route('**/api/v1/tags/**', async (route, request) => {
        const method = request.method();
        const pathname = new URL(request.url()).pathname;
        if (method === 'DELETE') {
          await route.fulfill({ status: 204 });
          return;
        }
        if (method === 'POST' && pathname.endsWith('/restore')) {
          const tagId = pathname.split('/').slice(-2, -1)[0] ?? '';
          const matched = MOCKED_HOME_TAGS.find((t) => t.id === tagId) ?? MOCKED_HOME_TAGS[0]!;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(matched),
          });
          return;
        }
        await route.fallback();
      });

      const page = await contextEn.newPage();
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      await page.goto('/app');
      await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });

      const omnibox = page.locator('#omni textarea[data-vault-secret]');
      await expect(omnibox).toBeVisible({ timeout: UI_WAIT_MS });

      // Trigger a keyboard interaction first so the toast gets the 10 s keyboard duration
      await omnibox.focus();
      await omnibox.fill(long200RuneName);
      await omnibox.press('Enter');

      const listbox = page.getByRole('listbox');
      await expect(listbox).toBeVisible({ timeout: UI_WAIT_MS });
      const createOption = listbox.getByRole('option').first();
      await expect(createOption).toBeVisible({ timeout: UI_WAIT_MS });
      await omnibox.press('ArrowDown');
      await omnibox.press('Enter');

      const toastItem = page.getByTestId('undo-toast-item');
      await expect(toastItem).toHaveCount(1, { timeout: UI_WAIT_MS });
      await expect(toastItem.first()).toBeVisible({ timeout: UI_WAIT_MS });

      // Open the tag-filter listbox (`#`) while the toast is visible to verify non-overlap with an open listbox (TV-FU10-3)
      await omnibox.fill('#');
      await expect(listbox).toBeVisible({ timeout: UI_WAIT_MS });

      const metrics = await page.evaluate(() => {
        const stack = document.querySelector<HTMLElement>('[data-testid="undo-toast-stack"]');
        const card = document.querySelector<HTMLElement>('[data-testid="undo-toast-item"]');
        const msg = document.querySelector<HTMLElement>('[data-testid="undo-toast-message"]');
        const live = document.querySelector<HTMLElement>('[data-testid="undo-toast-stack"] [role="status"]');
        const omni = document.querySelector<HTMLElement>('#omni textarea[data-vault-secret]');
        const lb = document.querySelector<HTMLElement>('[role="listbox"]');
        if (!stack || !card || !msg || !live || !omni || !lb) {
          throw new Error('Missing toast stack, card, message, live region, omnibox, or listbox element');
        }
        const stackRect = stack.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const msgRect = msg.getBoundingClientRect();
        const omniRect = omni.getBoundingClientRect();
        const lbRect = lb.getBoundingClientRect();
        const msgStyle = window.getComputedStyle(msg);
        return {
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          undoStackHVar: document.documentElement.style.getPropertyValue('--undo-stack-h'),
          scrollPaddingBottom: document.documentElement.style.getPropertyValue('scroll-padding-bottom'),
          dataUndoStackActive: document.documentElement.getAttribute('data-undo-stack-active'),
          bodyPaddingBottom: document.body.style.getPropertyValue('padding-bottom'),
          stackRect: {
            left: stackRect.left,
            top: stackRect.top,
            right: stackRect.right,
            bottom: stackRect.bottom,
            width: stackRect.width,
            height: stackRect.height,
          },
          cardRect: {
            left: cardRect.left,
            top: cardRect.top,
            right: cardRect.right,
            bottom: cardRect.bottom,
            width: cardRect.width,
            height: cardRect.height,
          },
          msgHeight: msgRect.height,
          msgWebkitLineClamp: msgStyle.webkitLineClamp,
          msgTitle: msg.getAttribute('title') ?? '',
          liveText: live.textContent ?? '',
          omniRect: {
            left: omniRect.left,
            top: omniRect.top,
            right: omniRect.right,
            bottom: omniRect.bottom,
          },
          lbRect: {
            left: lbRect.left,
            top: lbRect.top,
            right: lbRect.right,
            bottom: lbRect.bottom,
          },
        };
      });

      // 1. Anchored to the viewport bottom (16 px bottom gutter at < 640 px) and exposes --undo-stack-h
      expect(metrics.viewportWidth).toBe(390);
      expect(metrics.viewportHeight).toBe(844);
      expect(metrics.undoStackHVar).toMatch(/^\d+px$/);
      expect(metrics.scrollPaddingBottom).toBe('calc(var(--undo-stack-h) + 8px)');
      expect(metrics.dataUndoStackActive).toBe('true');
      expect(metrics.bodyPaddingBottom).toBe('calc(var(--undo-stack-h) + 8px)');
      expect(metrics.stackRect.bottom).toBeGreaterThanOrEqual(844 - 20);
      expect(metrics.stackRect.bottom).toBeLessThanOrEqual(844 - 12);

      // 2. Near-full-width with 16 px side gutters: width >= 390 - 2*16 - 2 (356 px)
      expect(metrics.stackRect.width).toBeGreaterThanOrEqual(390 - 2 * 16 - 2);
      expect(metrics.cardRect.width).toBeGreaterThanOrEqual(390 - 2 * 16 - 2);
      expect(metrics.stackRect.left).toBeGreaterThanOrEqual(14);
      expect(metrics.stackRect.left).toBeLessThanOrEqual(18);
      expect(metrics.stackRect.right).toBeGreaterThanOrEqual(390 - 18);
      expect(metrics.stackRect.right).toBeLessThanOrEqual(390 - 14);

      // 3. Height bounded with a 200-rune item name (message clamped to 2 lines, card height <= 120 px)
      expect(metrics.msgWebkitLineClamp).toBe('2');
      expect(metrics.msgHeight).toBeLessThanOrEqual(44);
      expect(metrics.cardRect.height).toBeLessThanOrEqual(120);
      expect(metrics.stackRect.height).toBeLessThanOrEqual(120);
      expect(metrics.msgTitle).toContain(long200RuneName);
      expect(metrics.liveText).toContain(long200RuneName);

      // 4. Bounding box does not overlap the omnibox input or the open listbox (TV-FU10-3)
      const overlapsOmnibox =
        metrics.stackRect.left < metrics.omniRect.right &&
        metrics.stackRect.right > metrics.omniRect.left &&
        metrics.stackRect.top < metrics.omniRect.bottom &&
        metrics.stackRect.bottom > metrics.omniRect.top;
      expect(overlapsOmnibox).toBe(false);
      expect(metrics.stackRect.top).toBeGreaterThan(metrics.omniRect.bottom);

      const overlapsListbox =
        metrics.stackRect.left < metrics.lbRect.right &&
        metrics.stackRect.right > metrics.lbRect.left &&
        metrics.stackRect.top < metrics.lbRect.bottom &&
        metrics.stackRect.bottom > metrics.lbRect.top;
      expect(overlapsListbox).toBe(false);

      // Save single-toast 200-rune capture at 390 (en light) with open listbox
      await saveToastCapture(page, testInfo, 'fu10-undo-toast-en-light-390.png');

      // Close listbox before focus test
      await omnibox.press('Escape');
      await omnibox.fill('');

      // 5. RV-FU10-2 / TV-FU10-2 at 390x844: position a control under the stack, focus it via keyboard Tab,
      // and assert its bounding rect + 2 px does not intersect the stack rect and elementFromPoint hits the control.
      const targetCardIndex = await page.evaluate(() => {
        const stack = document.querySelector<HTMLElement>('[data-testid="undo-toast-stack"]')!;
        const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="item-card"]'));
        // Scroll so one of the cards sits directly under the fixed toast stack
        for (let i = 0; i < cards.length; i++) {
          const card = cards[i]!;
          const rect = card.getBoundingClientRect();
          const stackRect = stack.getBoundingClientRect();
          const desiredScrollY = window.scrollY + rect.bottom - (stackRect.bottom - 4);
          window.scrollTo({ top: Math.max(0, desiredScrollY), behavior: 'instant' });
          const afterRect = card.getBoundingClientRect();
          const afterStack = stack.getBoundingClientRect();
          if (
            afterRect.bottom > afterStack.top + 8 &&
            afterRect.top < afterStack.bottom &&
            i > 0
          ) {
            cards[i - 1]!.focus();
            return i;
          }
        }
        throw new Error('Could not position an item-card under the undo-toast stack at 390x844');
      });

      await page.keyboard.press('Tab');

      await expect
        .poll(
          async () => {
            return page.evaluate((idx) => {
              const stack = document.querySelector<HTMLElement>('[data-testid="undo-toast-stack"]');
              const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="item-card"]'));
              const target = cards[idx];
              if (!stack || !target || document.activeElement !== target) {
                return { focused: false, intersects: true, centerHit: false };
              }
              const fRect = target.getBoundingClientRect();
              const sRect = stack.getBoundingClientRect();
              const pad = 2;
              const intersects =
                fRect.left - pad < sRect.right &&
                fRect.right + pad > sRect.left &&
                fRect.top - pad < sRect.bottom &&
                fRect.bottom + pad > sRect.top;
              const cx = fRect.left + fRect.width / 2;
              const cy = fRect.top + fRect.height / 2;
              const hit = document.elementFromPoint(cx, cy);
              const centerHit = Boolean(hit && (hit === target || target.contains(hit)));
              return { focused: true, intersects, centerHit };
            }, targetCardIndex);
          },
          { timeout: UI_WAIT_MS },
        )
        .toEqual({ focused: true, intersects: false, centerHit: true });

      // 6. RV-FU10-R2-1 at 390x844: focus the LAST focusable control on /app (end of page) with a toast showing;
      // body bottom padding from --undo-stack-h provides scroll room so its rect + 2 px does not intersect the stack
      // and elementFromPoint hits the control.
      const lastCardIdx = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="item-card"]'));
        if (cards.length < 2) {
          throw new Error('Expected at least 2 item-card elements on /app');
        }
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
        const prev = cards[cards.length - 2]!;
        prev.focus();
        return cards.length - 1;
      });

      await page.keyboard.press('Tab');

      await expect
        .poll(
          async () => {
            return page.evaluate((idx) => {
              const stack = document.querySelector<HTMLElement>('[data-testid="undo-toast-stack"]');
              const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="item-card"]'));
              const target = cards[idx];
              if (!stack || !target || document.activeElement !== target) {
                return { focused: false, intersects: true, centerHit: false };
              }
              const fRect = target.getBoundingClientRect();
              const sRect = stack.getBoundingClientRect();
              const pad = 2;
              const intersects =
                fRect.left - pad < sRect.right &&
                fRect.right + pad > sRect.left &&
                fRect.top - pad < sRect.bottom &&
                fRect.bottom + pad > sRect.top;
              const cx = fRect.left + fRect.width / 2;
              const cy = fRect.top + fRect.height / 2;
              const hit = document.elementFromPoint(cx, cy);
              const centerHit = Boolean(hit && (hit === target || target.contains(hit)));
              return { focused: true, intersects, centerHit };
            }, lastCardIdx);
          },
          { timeout: UI_WAIT_MS },
        )
        .toEqual({ focused: true, intersects: false, centerHit: true });

      // 7. RV-FU10-R2-2 at 390x844: stack growth (a 2nd toast pushed while the last control is focused)
      // updates --undo-stack-h and scrolls the focused control clear of the taller 2-toast stack.
      await page.evaluate(() => {
        const tag1Id = '00000000-0000-4000-8000-000000000101';
        const trigger = document.querySelector<HTMLElement>(
          `[data-testid="rail-tag-menu-trigger-${tag1Id}"]`,
        );
        trigger?.click();
      });
      await page.evaluate(() => {
        const tag1Id = '00000000-0000-4000-8000-000000000101';
        const delBtn = document.querySelector<HTMLElement>(
          `[data-testid="rail-tag-delete-action-${tag1Id}"]`,
        );
        const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="item-card"]'));
        const lastCard = cards[cards.length - 1]!;
        // Simulate keyboard state and keep focus on the last card while triggering the 2nd toast
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        delBtn?.click();
        lastCard.focus();
      });

      await expect(toastItem).toHaveCount(2, { timeout: UI_WAIT_MS });

      await expect
        .poll(
          async () => {
            return page.evaluate((idx) => {
              const stack = document.querySelector<HTMLElement>('[data-testid="undo-toast-stack"]');
              const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="item-card"]'));
              const target = cards[idx];
              if (!stack || !target || document.activeElement !== target) {
                return { focused: false, intersects: true, centerHit: false };
              }
              const fRect = target.getBoundingClientRect();
              const sRect = stack.getBoundingClientRect();
              const pad = 2;
              const intersects =
                fRect.left - pad < sRect.right &&
                fRect.right + pad > sRect.left &&
                fRect.top - pad < sRect.bottom &&
                fRect.bottom + pad > sRect.top;
              const cx = fRect.left + fRect.width / 2;
              const cy = fRect.top + fRect.height / 2;
              const hit = document.elementFromPoint(cx, cy);
              const centerHit = Boolean(hit && (hit === target || target.contains(hit)));
              return { focused: true, intersects, centerHit };
            }, lastCardIdx);
          },
          { timeout: UI_WAIT_MS },
        )
        .toEqual({ focused: true, intersects: false, centerHit: true });

      // Scroll back to top and queue 2 more toasts via rail tag delete so we have 4 total (3 visible + "+1")
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      for (let i = 2; i <= 3; i++) {
        const tagId = `00000000-0000-4000-8000-00000000010${i}`;
        await page.getByTestId(`rail-tag-menu-trigger-${tagId}`).click();
        await page.getByTestId(`rail-tag-delete-action-${tagId}`).click();
      }

      await expect(toastItem).toHaveCount(3, { timeout: UI_WAIT_MS });
      const overflowBtn = page.getByTestId('undo-toast-overflow');
      await expect(overflowBtn).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(overflowBtn).toHaveText('+1');

      // TV-FU10-3: Assert the 3-toast + "+1" stack at 390 is bottom-anchored
      const multiStackMetrics = await page.evaluate(() => {
        const stack = document.querySelector<HTMLElement>('[data-testid="undo-toast-stack"]')!;
        const r = stack.getBoundingClientRect();
        return {
          bottom: r.bottom,
          left: r.left,
          right: r.right,
          width: r.width,
          top: r.top,
        };
      });
      expect(multiStackMetrics.bottom).toBeGreaterThanOrEqual(844 - 20);
      expect(multiStackMetrics.bottom).toBeLessThanOrEqual(844 - 12);
      expect(multiStackMetrics.width).toBeGreaterThanOrEqual(390 - 2 * 16 - 2);

      // Save multi-toast stack with "+1" capture at 390
      await saveToastCapture(page, testInfo, 'fu10-undo-toast-stack-en-light-390.png');

      // Expand and click the 200-rune item's Undo button to verify DELETE /api/v1/items/{id}
      await overflowBtn.click();
      await expect(toastItem).toHaveCount(4, { timeout: UI_WAIT_MS });
      await toastItem.nth(3).getByRole('button', { name: /Undo|Hoàn tác/i }).click();
      await expect.poll(() => deletedItemId, { timeout: UI_WAIT_MS }).toBe(createdItemId);
    } finally {
      await contextEn.close();
    }

    // --- Part B: 390x844 vi dark capture ---
    const contextVi = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    try {
      await installApiMocks(contextVi);
      await applyLocaleAndThemeMocks(contextVi, 'vi', 'dark');
      await installHomeContentMetadataRoutes(contextVi);

      await contextVi.route('**/api/v1/items*', async (route, request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/items') {
          await route.fulfill({
            status: 201,
            contentType: 'application/json',
            body: JSON.stringify({
              id: '00000000-0000-4000-8000-000000000998',
              name: long200RuneName,
              hint: null,
              tags: [],
              entry_count: 0,
              version: 1,
              created_at: '2026-11-02T00:00:00Z',
              updated_at: '2026-11-02T00:00:00Z',
              last_used_at: '2026-11-02T00:00:00Z',
            }),
          });
          return;
        }
        await route.fallback();
      });

      const pageVi = await contextVi.newPage();
      await pageVi.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await pageVi.goto('/app');
      await expect(pageVi.locator('html')).toHaveAttribute('data-theme', 'dark', { timeout: UI_WAIT_MS });
      await expect(pageVi.locator('html')).toHaveAttribute('lang', 'vi', { timeout: UI_WAIT_MS });
      await expect(pageVi.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });

      const omniboxVi = pageVi.locator('#omni textarea[data-vault-secret]');
      await omniboxVi.focus();
      await omniboxVi.fill(long200RuneName);
      await omniboxVi.press('Enter');

      const listboxVi = pageVi.getByRole('listbox');
      await expect(listboxVi).toBeVisible({ timeout: UI_WAIT_MS });
      await omniboxVi.press('ArrowDown');
      await omniboxVi.press('Enter');

      await expect(pageVi.getByTestId('undo-toast-item')).toHaveCount(1, { timeout: UI_WAIT_MS });
      await saveToastCapture(pageVi, testInfo, 'fu10-undo-toast-vi-dark-390.png');
    } finally {
      await contextVi.close();
    }
  });

  test('at 768x1024 (en light & vi dark): keyboard Tab focus onto a control under the stack scrolls it clear, elementFromPoint hits the control, and CI captures are saved', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(90_000);

    const long200RuneName = `${'long-item-segment-'.repeat(11)}ab`;
    const extraItems = Array.from({ length: 12 }, (_, idx) => ({
      id: `00000000-0000-4000-8000-00000000050${idx + 1}`,
      name: `Tablet fixture card ${idx + 1}`,
      hint: 'Tablet fixture summary line for scrollable viewport height at 768x1024',
      tags: [MOCKED_HOME_TAGS[0]!],
      entry_count: idx + 1,
      version: 1,
      created_at: '2026-10-30T00:00:00Z',
      updated_at: '2026-10-30T00:00:00Z',
      last_used_at: '2026-10-30T00:00:00Z',
    }));
    const allHomeItems = [...MOCKED_HOME_ITEMS, ...extraItems];

    for (const { locale, theme, fileName } of [
      { locale: 'en' as const, theme: 'light' as const, fileName: 'fu10-undo-toast-en-light-768.png' },
      { locale: 'vi' as const, theme: 'dark' as const, fileName: 'fu10-undo-toast-vi-dark-768.png' },
    ]) {
      const context = await browser.newContext({
        viewport: { width: 768, height: 1024 },
      });

      try {
        await installApiMocks(context);
        await applyLocaleAndThemeMocks(context, locale, theme);
        await installHomeContentMetadataRoutes(context);

        await context.route('**/api/v1/items*', async (route, request) => {
          const url = new URL(request.url());
          if (request.method() === 'POST' && url.pathname === '/api/v1/items') {
            await route.fulfill({
              status: 201,
              contentType: 'application/json',
              body: JSON.stringify({
                id: '00000000-0000-4000-8000-000000000997',
                name: long200RuneName,
                hint: null,
                tags: [],
                entry_count: 0,
                version: 1,
                created_at: '2026-11-02T00:00:00Z',
                updated_at: '2026-11-02T00:00:00Z',
                last_used_at: '2026-11-02T00:00:00Z',
              }),
            });
            return;
          }
          if (request.method() === 'GET' && url.pathname === '/api/v1/items') {
            const rawQ = url.searchParams.get('q') ?? '';
            if (!rawQ) {
              await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ items: allHomeItems, next_cursor: null }),
              });
              return;
            }
          }
          await route.fallback();
        });

        const page = await context.newPage();
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        await page.goto('/app');
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: UI_WAIT_MS });
        await expect(page.locator('html')).toHaveAttribute('lang', locale, { timeout: UI_WAIT_MS });
        await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });

        const omnibox = page.locator('#omni textarea[data-vault-secret]');
        await omnibox.focus();
        await omnibox.fill(long200RuneName);
        await omnibox.press('Enter');

        const listbox = page.getByRole('listbox');
        await expect(listbox).toBeVisible({ timeout: UI_WAIT_MS });
        await omnibox.press('ArrowDown');
        await omnibox.press('Enter');

        const toastItem = page.getByTestId('undo-toast-item');
        await expect(toastItem).toHaveCount(1, { timeout: UI_WAIT_MS });
        await expect(toastItem.first()).toBeVisible({ timeout: UI_WAIT_MS });

        // Save 768 capture before scrolling
        await saveToastCapture(page, testInfo, fileName);

        // RV-FU10-2 / TV-FU10-2 at 768x1024: position a control under the 560 px centered toast stack,
        // focus the preceding card, press Tab, and assert bounding rect + 2 px does not intersect the stack rect
        // and elementFromPoint at center hits the control.
        const targetCardIndex = await page.evaluate(() => {
          const stack = document.querySelector<HTMLElement>('[data-testid="undo-toast-stack"]')!;
          const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="item-card"]'));
          for (let i = 1; i < cards.length; i++) {
            const card = cards[i]!;
            const rect = card.getBoundingClientRect();
            const stackRect = stack.getBoundingClientRect();
            const desiredScrollY = window.scrollY + rect.bottom - (stackRect.bottom - 4);
            window.scrollTo({ top: Math.max(0, desiredScrollY), behavior: 'instant' });
            const afterRect = card.getBoundingClientRect();
            const afterStack = stack.getBoundingClientRect();
            const horizOverlaps = afterRect.left < afterStack.right && afterRect.right > afterStack.left;
            const vertOverlaps = afterRect.bottom > afterStack.top + 8 && afterRect.top < afterStack.bottom;
            if (horizOverlaps && vertOverlaps) {
              cards[i - 1]!.focus();
              return i;
            }
          }
          throw new Error('Could not position an item-card under the undo-toast stack at 768x1024');
        });

        await page.keyboard.press('Tab');

        await expect
          .poll(
            async () => {
              return page.evaluate((idx) => {
                const stack = document.querySelector<HTMLElement>('[data-testid="undo-toast-stack"]');
                const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="item-card"]'));
                const target = cards[idx];
                if (!stack || !target || document.activeElement !== target) {
                  return { focused: false, intersects: true, centerHit: false };
                }
                const fRect = target.getBoundingClientRect();
                const sRect = stack.getBoundingClientRect();
                const pad = 2;
                const intersects =
                  fRect.left - pad < sRect.right &&
                  fRect.right + pad > sRect.left &&
                  fRect.top - pad < sRect.bottom &&
                  fRect.bottom + pad > sRect.top;
                const cx = fRect.left + fRect.width / 2;
                const cy = fRect.top + fRect.height / 2;
                const hit = document.elementFromPoint(cx, cy);
                const centerHit = Boolean(hit && (hit === target || target.contains(hit)));
                return { focused: true, intersects, centerHit };
              }, targetCardIndex);
            },
            { timeout: UI_WAIT_MS },
          )
          .toEqual({ focused: true, intersects: false, centerHit: true });
      } finally {
        await context.close();
      }
    }
  });
});
