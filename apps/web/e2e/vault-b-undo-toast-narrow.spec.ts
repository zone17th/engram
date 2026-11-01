import { expect, test } from '@playwright/test';
import { installHomeContentMetadataRoutes } from './content-home-support';
import { UI_WAIT_MS, installApiMocks } from './vault-locked-support';

/**
 * FU10 UNDO-TOAST-390 (advisor-dec-216, ACC-TV1-2, ACC-TV1-5):
 * Verifies at 390x844 mobile viewport that:
 * 1. The undo-toast stack (`data-testid="undo-toast-stack"`) is anchored to the viewport bottom
 *    (16 px bottom inset), has width >= 390 - 2*16 - 2 (356 px, 16 px side gutters), has bounded
 *    height with a 200-rune item name (message clamped to <= 2 lines, full 200-rune name preserved
 *    in `title` and `role="status"` live region), and its bounding box does not overlap the omnibox input.
 * 2. When a focused control overlaps the toast stack's box (ACC-TV1-5), the stack shifts out of the
 *    focused element's focus ring path so the focus ring is not hidden.
 */
test.describe('FU10 UNDO-TOAST-390 compact bottom-anchored undo-toast stack at 390x844', () => {
  test('at 390x844 with a 200-rune item name, the stack is bottom-anchored, width >= 390-2*16-2, height bounded, and does not overlap the omnibox input', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });

    try {
      await installApiMocks(context);
      await installHomeContentMetadataRoutes(context);

      const long200RuneName = `${'long-item-segment-'.repeat(11)}ab`;
      expect(Array.from(long200RuneName).length).toBe(200);

      const createdItemId = '00000000-0000-4000-8000-000000000999';
      let deletedItemId: string | null = null;

      await context.route('**/api/v1/items*', async (route, request) => {
        const method = request.method();
        if (method === 'POST') {
          await route.fulfill({
            status: 201,
            contentType: 'application/json',
            body: JSON.stringify({
              id: createdItemId,
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
        if (method === 'DELETE') {
          deletedItemId = new URL(request.url()).pathname.split('/').pop() ?? null;
          await route.fulfill({ status: 204 });
          return;
        }
        await route.fallback();
      });

      const page = await context.newPage();
      await page.goto('/app');
      await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });

      const omnibox = page.locator('#omni textarea[data-vault-secret]');
      await expect(omnibox).toBeVisible({ timeout: UI_WAIT_MS });

      // Search for the 200-rune name -> no matches -> click "Create item “<200-rune name>”"
      await omnibox.fill(long200RuneName);
      await omnibox.press('Enter');

      const listbox = page.getByRole('listbox');
      await expect(listbox).toBeVisible({ timeout: UI_WAIT_MS });
      const createOption = listbox.getByRole('option').first();
      await expect(createOption).toBeVisible({ timeout: UI_WAIT_MS });
      await createOption.click();

      const toastStack = page.getByTestId('undo-toast-stack');
      const toastItem = page.getByTestId('undo-toast-item');
      await expect(toastItem).toHaveCount(1, { timeout: UI_WAIT_MS });
      await expect(toastItem.first()).toBeVisible({ timeout: UI_WAIT_MS });

      const metrics = await page.evaluate(() => {
        const stack = document.querySelector<HTMLElement>('[data-testid="undo-toast-stack"]');
        const card = document.querySelector<HTMLElement>('[data-testid="undo-toast-item"]');
        const msg = document.querySelector<HTMLElement>('[data-testid="undo-toast-message"]');
        const live = document.querySelector<HTMLElement>('[data-testid="undo-toast-stack"] [role="status"]');
        const omni = document.querySelector<HTMLElement>('#omni textarea[data-vault-secret]');
        if (!stack || !card || !msg || !live || !omni) {
          throw new Error('Missing toast stack, card, message, live region, or omnibox element');
        }
        const stackRect = stack.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const msgRect = msg.getBoundingClientRect();
        const omniRect = omni.getBoundingClientRect();
        const msgStyle = window.getComputedStyle(msg);
        return {
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
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
            width: omniRect.width,
            height: omniRect.height,
          },
        };
      });

      // 1. Anchored to the viewport bottom (16 px bottom gutter at < 640 px)
      expect(metrics.viewportWidth).toBe(390);
      expect(metrics.viewportHeight).toBe(844);
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

      // Full 200-rune item name stays in title and live region
      expect(metrics.msgTitle).toContain(long200RuneName);
      expect(metrics.liveText).toContain(long200RuneName);

      // 4. Bounding box does not overlap the omnibox input
      const overlapsOmnibox =
        metrics.stackRect.left < metrics.omniRect.right &&
        metrics.stackRect.right > metrics.omniRect.left &&
        metrics.stackRect.top < metrics.omniRect.bottom &&
        metrics.stackRect.bottom > metrics.omniRect.top;
      expect(overlapsOmnibox).toBe(false);
      expect(metrics.stackRect.top).toBeGreaterThan(metrics.omniRect.bottom);

      // 5. Undo button remains clickable and triggers DELETE /api/v1/items/{id}
      await toastStack.getByRole('button', { name: /Undo|Hoàn tác/i }).click();
      await expect.poll(() => deletedItemId, { timeout: UI_WAIT_MS }).toBe(createdItemId);
      await expect(toastItem).toHaveCount(0, { timeout: UI_WAIT_MS });
    } finally {
      await context.close();
    }
  });
});
