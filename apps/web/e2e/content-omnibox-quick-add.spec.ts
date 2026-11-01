import { expect, test, type Locator, type Page } from '@playwright/test';
import { uniqueEmail } from './helpers';
import {
  createVaultViaOnboarding,
  expectUnlockedOnApp,
  signupPasswordUser,
} from './vault-journey-support';
import { VAULT_PASSPHRASE } from './vault-passkey-support';

// Disable Playwright's automatic error-context DOM snapshot in this worker before any test runs,
// so a failure while a recovery-key sheet or secret input is mounted can never serialize secrets to disk.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

const QUICK_ADD_TIMEOUT_MS = 300_000;
const UI_WAIT_MS = 30_000;
const G1_MEDIAN_BUDGET_MS = 3_000;

/**
 * Writes a value into a `<textarea>` or `<input>` without appearing in Playwright's `fill()` call logs.
 */
async function setSecretTextareaValue(locator: Locator, value: string): Promise<void> {
  await expect(locator).toBeEditable({ timeout: UI_WAIT_MS });
  await locator.evaluate((element, nextValue) => {
    const isTextarea = element.tagName.toUpperCase() === 'TEXTAREA';
    const proto = isTextarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) {
      throw new Error('Value setter missing on element prototype');
    }
    setter.call(element, nextValue);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

function computeMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

async function measureFiveSavesMedianMs(
  page: Page,
  omnibox: Locator,
  prefix: string,
): Promise<number> {
  const samples: number[] = [];

  for (let i = 0; i < 5; i += 1) {
    const itemName = `${prefix}-${i + 1}`;
    const draft = `${itemName} #g1: payload-${i + 1}`;
    await setSecretTextareaValue(omnibox, draft);

    const startMs = Date.now();
    await omnibox.press('Enter');

    const toast = page
      .getByTestId('undo-toast-item')
      .filter({ hasText: itemName })
      .first();
    await expect(toast).toBeVisible({ timeout: UI_WAIT_MS });
    const elapsedMs = Date.now() - startMs;
    samples.push(elapsedMs);
  }

  return computeMedian(samples);
}

test.describe('P04-T18b quick-add E2E (A3 retry & idempotency, Ctrl+Z Undo vs native undo, U9 picker, and G1 latency)', () => {
  test.skip(
    !process.env.E2E_STACK,
    'needs the compose stack (E2E_STACK=1): real API, real database',
  );

  test('executes A3 response-loss retry without duplicate items/entries, U9 duplicate picker selection & 3rd item creation, Ctrl+Z quick-add Undo vs native undo after typing, and G1 median <= 3 s latency', async ({
    page,
  }) => {
    test.setTimeout(QUICK_ADD_TIMEOUT_MS);

    const email = uniqueEmail('content-omni-add');
    await signupPasswordUser(page, email);
    await createVaultViaOnboarding(page, VAULT_PASSPHRASE, { kind: 'skip' });
    await expectUnlockedOnApp(page);

    await page.goto('/app');
    const omnibox = page.locator('#omni textarea[data-vault-secret]');
    await expect(omnibox).toBeVisible({ timeout: UI_WAIT_MS });
    await expect(page.getByTestId('home-empty-state')).toBeVisible({ timeout: UI_WAIT_MS });

    // --- 1. G1: Enter -> "Đã lưu" toast <= 3 s median of 5 runs (1 rerun allowed if runner is slow; log both numbers) ---
    const firstMedianMs = await measureFiveSavesMedianMs(page, omnibox, 'g1-run1');
    if (firstMedianMs > G1_MEDIAN_BUDGET_MS) {
      const secondMedianMs = await measureFiveSavesMedianMs(page, omnibox, 'g1-run2');
      console.info(
        `[G1 quick-add latency] run1 median=${firstMedianMs}ms, run2 median=${secondMedianMs}ms`,
      );
      expect(secondMedianMs).toBeLessThanOrEqual(G1_MEDIAN_BUDGET_MS);
    } else {
      console.info(`[G1 quick-add latency] run1 median=${firstMedianMs}ms (within 3000ms budget)`);
      expect(firstMedianMs).toBeLessThanOrEqual(G1_MEDIAN_BUDGET_MS);
    }

    // --- 2. A3: Drop response after server commits `POST /items` -> Retry reuses Idempotency-Key -> 1 item + 1 entry;
    //         Drop response after server commits `POST /items/{id}/entries` -> Retry reuses Idempotency-Key -> 1 entry ---
    let interceptPostItemsOnce = true;
    const seenPostItemsKeys: string[] = [];
    await page.route('**/api/v1/items', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const key = route.request().headers()['idempotency-key'] ?? '';
      seenPostItemsKeys.push(key);
      if (interceptPostItemsOnce) {
        interceptPostItemsOnce = false;
        // Forward to the real backend so the item is committed in Postgres, then abort the browser response!
        await route.fetch();
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    let interceptPostEntriesOnce = false;
    const seenPostEntriesKeys: string[] = [];
    await page.route('**/api/v1/items/*/entries', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const key = route.request().headers()['idempotency-key'] ?? '';
      seenPostEntriesKeys.push(key);
      if (interceptPostEntriesOnce) {
        interceptPostEntriesOnce = false;
        // Forward to the real backend so the entry is committed in Postgres, then abort the browser response!
        await route.fetch();
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    await setSecretTextareaValue(omnibox, 'a3-item #nhà: a3-secret-payload');
    await omnibox.press('Enter');

    // First failure at POST /items (auto-retried once inside contentMutate or surfaced to plan error if still failing)
    // Wait for either the toast (if contentMutate's built-in 1x retry recovered transparently!) or the manual Retry button.
    const toastOrRetry = await Promise.race([
      page
        .getByTestId('undo-toast-item')
        .filter({ hasText: 'a3-item' })
        .first()
        .waitFor({ state: 'visible', timeout: UI_WAIT_MS })
        .then(() => 'toast' as const),
      page
        .getByTestId('omnibox-retry-plan-btn')
        .waitFor({ state: 'visible', timeout: UI_WAIT_MS })
        .then(() => 'retry' as const),
    ]);
    if (toastOrRetry === 'retry') {
      await page.getByTestId('omnibox-retry-plan-btn').click();
      await expect(
        page.getByTestId('undo-toast-item').filter({ hasText: 'a3-item' }).first(),
      ).toBeVisible({ timeout: UI_WAIT_MS });
    }
    expect(seenPostItemsKeys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seenPostItemsKeys).size).toBe(1);

    // Verify via real backend lookup that exactly 1 'a3-item' with entry_count === 1 exists
    const lookupA3Item1 = await page.evaluate(async () => {
      const res = await fetch('/api/v1/items/lookup?name=a3-item', { credentials: 'include' });
      return (await res.json()) as { items: Array<{ id: string; entry_count: number }>; total: number };
    });
    expect(lookupA3Item1.total).toBe(1);
    expect(lookupA3Item1.items[0]?.entry_count).toBe(1);

    // Now test dropping the response on `POST /items/{id}/entries`
    seenPostEntriesKeys.length = 0;
    interceptPostEntriesOnce = true;
    await setSecretTextareaValue(omnibox, 'a3-item: second-entry-payload');
    await omnibox.press('Enter');

    const entryToastOrRetry = await Promise.race([
      page
        .getByTestId('omnibox-retry-plan-btn')
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => 'retry' as const)
        .catch(() => 'toast' as const),
      page
        .waitForFunction(
          () => {
            const el = document.querySelector('#omni textarea[data-vault-secret]') as HTMLTextAreaElement | null;
            return el != null && el.value === '';
          },
          undefined,
          { timeout: UI_WAIT_MS },
        )
        .then(() => 'toast' as const),
    ]);
    if (entryToastOrRetry === 'retry') {
      await page.getByTestId('omnibox-retry-plan-btn').click();
    }
    await expect(omnibox).toHaveValue('', { timeout: UI_WAIT_MS });
    expect(seenPostEntriesKeys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seenPostEntriesKeys).size).toBe(1);

    const lookupA3Item2 = await page.evaluate(async () => {
      const res = await fetch('/api/v1/items/lookup?name=a3-item', { credentials: 'include' });
      return (await res.json()) as { items: Array<{ id: string; entry_count: number }>; total: number };
    });
    expect(lookupA3Item2.total).toBe(1);
    expect(lookupA3Item2.items[0]?.entry_count).toBe(2);

    await page.unroute('**/api/v1/items');
    await page.unroute('**/api/v1/items/*/entries');

    // --- 3. Ctrl+Enter creates a 2nd item with the same name 'a3-item', then Enter opens Picker U9 ---
    await setSecretTextareaValue(omnibox, 'a3-item #ops: second-same-name-item-entry');
    await omnibox.press('Control+Enter');
    await expect(omnibox).toHaveValue('', { timeout: UI_WAIT_MS });

    const lookupTwoSameName = await page.evaluate(async () => {
      const res = await fetch('/api/v1/items/lookup?name=a3-item', { credentials: 'include' });
      return (await res.json()) as { items: Array<{ id: string; entry_count: number }>; total: number };
    });
    expect(lookupTwoSameName.total).toBe(2);

    // Enter with 2 matches opens Picker U9 -> choose "Create a new item with the same name" -> creates 3rd item
    await setSecretTextareaValue(omnibox, 'a3-item: third-same-name-item-entry');
    await omnibox.press('Enter');

    const pickerDialog = page.getByTestId('dup-picker-dialog');
    await expect(pickerDialog).toBeVisible({ timeout: UI_WAIT_MS });
    await page.getByTestId('dup-picker-create-same-name').click();
    await expect(omnibox).toHaveValue('', { timeout: UI_WAIT_MS });

    const lookupThreeSameName = await page.evaluate(async () => {
      const res = await fetch('/api/v1/items/lookup?name=a3-item', { credentials: 'include' });
      return (await res.json()) as { items: Array<{ id: string; entry_count: number }>; total: number };
    });
    expect(lookupThreeSameName.total).toBe(3);

    // --- 4. Ctrl+Z right after save deletes ONLY the entry (item stays with entry_count === 0);
    //         Typing 1 character in the omnibox then pressing Ctrl+Z performs native text undo instead of deleting entry ---
    await setSecretTextareaValue(omnibox, 'undo-target #nhà: secret-to-undo');
    await omnibox.press('Enter');
    await expect(omnibox).toHaveValue('', { timeout: UI_WAIT_MS });

    const beforeUndoLookup = await page.evaluate(async () => {
      const res = await fetch('/api/v1/items/lookup?name=undo-target', { credentials: 'include' });
      return (await res.json()) as { items: Array<{ id: string; entry_count: number }>; total: number };
    });
    expect(beforeUndoLookup.total).toBe(1);
    expect(beforeUndoLookup.items[0]?.entry_count).toBe(1);

    // Press Ctrl+Z while omnibox is still empty right after save -> triggers quick-add Undo (DELETE /entries/{id})
    await omnibox.focus();
    await page.keyboard.press('Control+z');

    await expect
      .poll(
        async () => {
          const res = await page.evaluate(async () => {
            const r = await fetch('/api/v1/items/lookup?name=undo-target', {
              credentials: 'include',
            });
            return (await r.json()) as {
              items: Array<{ id: string; entry_count: number }>;
              total: number,
            };
          });
          return res.items[0]?.entry_count ?? -1;
        },
        { timeout: UI_WAIT_MS },
      )
      .toBe(0);

    // Save another entry into 'undo-target', then type a character into the omnibox and press Ctrl+Z -> entry is NOT deleted
    await setSecretTextareaValue(omnibox, 'undo-target: keep-this-entry');
    await omnibox.press('Enter');
    await expect(omnibox).toHaveValue('', { timeout: UI_WAIT_MS });

    await omnibox.focus();
    await omnibox.pressSequentially('x');
    await expect(omnibox).toHaveValue('x');
    await page.keyboard.press('Control+z');

    // Wait briefly and verify the entry on 'undo-target' was NOT deleted by Ctrl+Z when omnibox had text
    await page.waitForTimeout(400);
    const afterTypingCtrlZLookup = await page.evaluate(async () => {
      const res = await fetch('/api/v1/items/lookup?name=undo-target', { credentials: 'include' });
      return (await res.json()) as { items: Array<{ id: string; entry_count: number }>; total: number };
    });
    expect(afterTypingCtrlZLookup.total).toBe(1);
    expect(afterTypingCtrlZLookup.items[0]?.entry_count).toBe(1);
  });
});
