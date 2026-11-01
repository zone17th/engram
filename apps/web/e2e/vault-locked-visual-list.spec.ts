import { expect, test } from '@playwright/test';
import { THEMES, WIDTHS, capture, gotoLocked, installVisualApiMocks, prepare } from './vault-locked-support';

/**
 * P03-T21 visual captures for the U5 locked list (`/app`), split from `vault-locked-visual.spec.ts` (P4FE3-1, P4FE4-1).
 */
test.describe('P03-T21 Locked state U5 visual captures (AC VISUAL)', () => {
  for (const theme of THEMES) {
    for (const viewport of WIDTHS) {
      const label = `${theme}-${viewport.width}`;

      test(`locked list (${label})`, async ({ context, page }, testInfo) => {
        test.setTimeout(90_000);
        await installVisualApiMocks(context, theme);
        await prepare(page, theme, viewport.width, viewport.height);
        await gotoLocked(page, '/app', theme);
        await expect(page.locator('.vault-pill, [data-vault-state="locked"]').first()).toBeAttached();
        await capture(page, testInfo, 'locked-list', theme, viewport.width);
      });
    }
  }
});
