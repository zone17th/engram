import { test } from '@playwright/test';
import { LOCKED_ITEM_FIXTURE, installItemPageContentMocks } from './content-itempage-support';
import { THEMES, WIDTHS, capture, gotoLocked, installVisualApiMocks, prepare } from './vault-locked-support';

/**
 * P03-T21 visual captures for the U5 locked item page (`/app/items/${ITEM_ID}`), split from
 * `vault-locked-visual.spec.ts` (P4FE3-1, P4FE4-1) and migrated in P04-T15 to the real item page.
 */
const ITEM_ID = LOCKED_ITEM_FIXTURE.item.id;

test.describe('P03-T21 Locked state U5 visual captures (AC VISUAL)', () => {
  for (const theme of THEMES) {
    for (const viewport of WIDTHS) {
      const label = `${theme}-${viewport.width}`;

      test(`locked item (${label})`, async ({ context, page }, testInfo) => {
        test.setTimeout(90_000);
        await installVisualApiMocks(context, theme);
        await installItemPageContentMocks(context);
        await prepare(page, theme, viewport.width, viewport.height);
        await gotoLocked(page, `/app/items/${ITEM_ID}`, theme);
        await capture(page, testInfo, 'locked-item', theme, viewport.width);
      });
    }
  }
});
