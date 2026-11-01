import { expect, test, type Locator, type Page } from '@playwright/test';
import { uniqueEmail } from './helpers';
import {
  createVaultViaOnboarding,
  expectLockedListOnApp,
  expectUnlockedOnApp,
  signupPasswordUser,
  unlockFromLockedList,
} from './vault-journey-support';
import { VAULT_PASSPHRASE } from './vault-passkey-support';

// Disable Playwright's automatic error-context DOM snapshot in this worker before any test runs,
// so a failure while a recovery-key sheet or secret input is mounted can never serialize secrets to disk.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

const QUICK_ADD_TIMEOUT_MS = 240_000;
const UI_WAIT_MS = 30_000;
const G1_MEDIAN_BUDGET_MS = 3_000;
/**
 * Matches `MAX_AUTO_RETRIES = 2` in `lib/api/content.ts:48` (initial send + 2 automatic retries = 3 sends per call).
 */
const CONTENT_MUTATE_MAX_AUTO_RETRIES = 2;
const CONTENT_MUTATE_ATTEMPTS_PER_CALL = CONTENT_MUTATE_MAX_AUTO_RETRIES + 1;

interface ApiResponseSummary {
  readonly method: string;
  readonly pathname: string;
  readonly status: number;
}

function attachApiResponseRecorder(page: Page): ApiResponseSummary[] {
  const responses: ApiResponseSummary[] = [];
  page.context().on('response', (res) => {
    const url = res.url();
    if (url.includes('/api/v1/')) {
      responses.push({
        method: res.request().method(),
        pathname: new URL(url).pathname,
        status: res.status(),
      });
    }
  });
  return responses;
}

async function collectOmniboxFailureDiagnostics(
  page: Page,
  apiResponses: readonly ApiResponseSummary[],
): Promise<string> {
  const domState = await page
    .evaluate(() => {
      const stepNodes = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="omnibox-save-plan"] [data-step-key]'),
      );
      const stepStatuses = stepNodes.map(
        (el) => `${el.getAttribute('data-step-key') ?? '?'}:${el.getAttribute('data-step-status') ?? '?'}`,
      );
      const errorTestIds = [
        'omnibox-plan-error',
        'omnibox-action-error',
        'omnibox-add-error',
        'omnibox-guard-alert',
      ].filter((id) => Boolean(document.querySelector(`[data-testid="${id}"]:not([hidden])`)));
      const actionErrorText =
        document.querySelector('[data-testid="omnibox-action-error"]')?.textContent?.trim() ?? null;
      return { stepStatuses, errorTestIds, actionErrorText };
    })
    .catch(() => ({ stepStatuses: [], errorTestIds: [], actionErrorText: null }));

  const recentResponses = apiResponses
    .slice(-15)
    .map((r) => `${r.method} ${r.pathname} -> ${r.status}`);
  return JSON.stringify({
    stepStatuses: domState.stepStatuses,
    errorTestIds: domState.errorTestIds,
    actionErrorText: domState.actionErrorText,
    recentResponses,
  });
}

async function expectOmniboxClearedOrReport(
  page: Page,
  omnibox: Locator,
  apiResponses: readonly ApiResponseSummary[],
): Promise<void> {
  try {
    await expect(omnibox).toHaveValue('', { timeout: UI_WAIT_MS });
  } catch (err) {
    const diag = await collectOmniboxFailureDiagnostics(page, apiResponses);
    throw new Error(
      `Quick-add did not clear omnibox textarea. Diagnostics: ${diag}\nOriginal error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

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
  apiResponses: readonly ApiResponseSummary[],
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
    try {
      await expect(toast).toBeVisible({ timeout: UI_WAIT_MS });
    } catch (err) {
      const diag = await collectOmniboxFailureDiagnostics(page, apiResponses);
      throw new Error(
        `G1 save "${itemName}" did not produce toast. Diagnostics: ${diag}\nOriginal error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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

  test('measures G1 latency (Enter -> saved toast <= 3 s median of 5 runs) and executes A3 response-loss retry on POST /items and POST /entries without duplicates (HM18B-R1-1, HM18B-R1-7)', async ({
    page,
  }) => {
    test.setTimeout(QUICK_ADD_TIMEOUT_MS);
    const apiResponses = attachApiResponseRecorder(page);
    const email = uniqueEmail('content-omni-a3');
    await signupPasswordUser(page, email);
    await createVaultViaOnboarding(page, VAULT_PASSPHRASE, { kind: 'skip' });
    await expectUnlockedOnApp(page);

    await page.goto('/app');
    const omnibox = page.locator('#omni textarea[data-vault-secret]');
    await expect(omnibox).toBeVisible({ timeout: UI_WAIT_MS });
    await expect(page.getByTestId('home-empty-state')).toBeVisible({ timeout: UI_WAIT_MS });

    // --- 1. G1: Enter -> "Đã lưu" toast <= 3 s median of 5 runs (1 rerun allowed if runner is slow; log both numbers) ---
    const firstMedianMs = await measureFiveSavesMedianMs(page, omnibox, 'g1-run1', apiResponses);
    if (firstMedianMs > G1_MEDIAN_BUDGET_MS) {
      const secondMedianMs = await measureFiveSavesMedianMs(page, omnibox, 'g1-run2', apiResponses);
      console.info(
        `[G1 quick-add latency] run1 median=${firstMedianMs}ms, run2 median=${secondMedianMs}ms`,
      );
      expect(secondMedianMs).toBeLessThanOrEqual(G1_MEDIAN_BUDGET_MS);
    } else {
      console.info(`[G1 quick-add latency] run1 median=${firstMedianMs}ms (within 3000ms budget)`);
      expect(firstMedianMs).toBeLessThanOrEqual(G1_MEDIAN_BUDGET_MS);
    }

    // --- 2. A3: Drop response after server commits `POST /items` -> Retry button reuses Idempotency-Key -> 1 item + 1 entry;
    //         Drop response after server commits `POST /items/{id}/entries` -> Retry button reuses Idempotency-Key -> 1 entry ---
    // `contentMutate` automatically retries a network failure up to `MAX_AUTO_RETRIES = 2` times (3 sends per call),
    // so we abort `CONTENT_MUTATE_ATTEMPTS_PER_CALL` (3) attempts after forwarding the first to the real backend;
    // this deterministically surfaces `omnibox-retry-plan-btn` and makes the 4th send come from the manual Retry click (HM18B-R2-1).
    let postItemsAbortRemaining = CONTENT_MUTATE_ATTEMPTS_PER_CALL;
    let postItemsForwardedToBackend = false;
    const seenPostItemsKeys: string[] = [];
    await page.route('**/api/v1/items', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const key = route.request().headers()['idempotency-key'] ?? '';
      seenPostItemsKeys.push(key);
      if (postItemsAbortRemaining > 0) {
        postItemsAbortRemaining -= 1;
        if (!postItemsForwardedToBackend) {
          postItemsForwardedToBackend = true;
          await route.fetch();
        }
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    let postEntriesAbortRemaining = 0;
    let postEntriesForwardedToBackend = false;
    const seenPostEntriesKeys: string[] = [];
    await page.route('**/api/v1/items/*/entries', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const key = route.request().headers()['idempotency-key'] ?? '';
      seenPostEntriesKeys.push(key);
      if (postEntriesAbortRemaining > 0) {
        postEntriesAbortRemaining -= 1;
        if (!postEntriesForwardedToBackend) {
          postEntriesForwardedToBackend = true;
          await route.fetch();
        }
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    await setSecretTextareaValue(omnibox, 'a3-item #nhà: a3-secret-payload');
    await omnibox.press('Enter');

    const retryBtn = page.getByTestId('omnibox-retry-plan-btn');
    await expect(retryBtn).toBeVisible({ timeout: UI_WAIT_MS });
    expect(seenPostItemsKeys).toHaveLength(CONTENT_MUTATE_ATTEMPTS_PER_CALL);
    await retryBtn.click();
    await expect(
      page.getByTestId('undo-toast-item').filter({ hasText: 'a3-item' }).first(),
    ).toBeVisible({ timeout: UI_WAIT_MS });
    await expectOmniboxClearedOrReport(page, omnibox, apiResponses);
    expect(seenPostItemsKeys).toHaveLength(CONTENT_MUTATE_ATTEMPTS_PER_CALL + 1);
    expect(new Set(seenPostItemsKeys).size).toBe(1);

    // Verify via real backend lookup that exactly 1 'a3-item' with entry_count === 1 exists
    const lookupA3Item1 = await page.evaluate(async () => {
      const res = await fetch('/api/v1/items/lookup?name=a3-item', { credentials: 'include' });
      return (await res.json()) as { items: Array<{ id: string; entry_count: number }>; total: number };
    });
    expect(lookupA3Item1.total).toBe(1);
    expect(lookupA3Item1.items[0]?.entry_count).toBe(1);

    // Now test dropping the response on `POST /items/{id}/entries` -> deterministically wait for Retry button and click it
    seenPostEntriesKeys.length = 0;
    postEntriesAbortRemaining = CONTENT_MUTATE_ATTEMPTS_PER_CALL;
    postEntriesForwardedToBackend = false;
    await setSecretTextareaValue(omnibox, 'a3-item: second-entry-payload');
    await omnibox.press('Enter');

    await expect(retryBtn).toBeVisible({ timeout: UI_WAIT_MS });
    expect(seenPostEntriesKeys).toHaveLength(CONTENT_MUTATE_ATTEMPTS_PER_CALL);
    await retryBtn.click();
    await expectOmniboxClearedOrReport(page, omnibox, apiResponses);
    expect(seenPostEntriesKeys).toHaveLength(CONTENT_MUTATE_ATTEMPTS_PER_CALL + 1);
    expect(new Set(seenPostEntriesKeys).size).toBe(1);

    const lookupA3Item2 = await page.evaluate(async () => {
      const res = await fetch('/api/v1/items/lookup?name=a3-item', { credentials: 'include' });
      return (await res.json()) as { items: Array<{ id: string; entry_count: number }>; total: number };
    });
    expect(lookupA3Item2.total).toBe(1);
    expect(lookupA3Item2.items[0]?.entry_count).toBe(2);

    await page.unroute('**/api/v1/items');
    await page.unroute('**/api/v1/items/*/entries');
  });

  test('opens U9 duplicate picker on >=2 matches, restores focus to the omnibox after Escape and after a pick, selects 2nd item, and creates a 3rd same-name item (HM18B-R1-1, HM18B-R1-2)', async ({
    page,
  }) => {
    test.setTimeout(QUICK_ADD_TIMEOUT_MS);

    const apiResponses = attachApiResponseRecorder(page);
    const email = uniqueEmail('content-omni-picker');
    await signupPasswordUser(page, email);
    await createVaultViaOnboarding(page, VAULT_PASSPHRASE, { kind: 'skip' });
    await expectUnlockedOnApp(page);

    await page.goto('/app');
    const omnibox = page.locator('#omni textarea[data-vault-secret]');
    await expect(omnibox).toBeVisible({ timeout: UI_WAIT_MS });

    // Create 1st item 'dup-target'
    await setSecretTextareaValue(omnibox, 'dup-target #nhà: first-dup-entry');
    await omnibox.press('Enter');
    await expectOmniboxClearedOrReport(page, omnibox, apiResponses);

    // Ctrl+Enter creates a 2nd item with the same name 'dup-target'
    await setSecretTextareaValue(omnibox, 'dup-target #ops: second-dup-entry');
    await omnibox.press('Control+Enter');
    await expectOmniboxClearedOrReport(page, omnibox, apiResponses);
    const lookupTwo = await page.evaluate(async () => {
      const res = await fetch('/api/v1/items/lookup?name=dup-target', { credentials: 'include' });
      return (await res.json()) as { items: Array<{ id: string; entry_count: number }>; total: number };
    });
    expect(lookupTwo.total).toBe(2);
    const secondItemId = lookupTwo.items[1]!.id;

    // 1. Enter with 2 matches opens Picker U9 -> Escape closes dialog and restores focus to omnibox (HM18B-R1-2)
    await setSecretTextareaValue(omnibox, 'dup-target: append-to-second-item');
    await omnibox.press('Enter');

    const pickerDialog = page.getByTestId('dup-picker-dialog');
    await expect(pickerDialog).toBeVisible({ timeout: UI_WAIT_MS });
    await page.keyboard.press('Escape');
    await expect(pickerDialog).toBeHidden({ timeout: UI_WAIT_MS });
    await expect(omnibox).toBeFocused({ timeout: UI_WAIT_MS });
    await expect(omnibox).toHaveValue('dup-target: append-to-second-item');

    // 2. Press Enter again -> choose the 2nd item -> entry lands on `secondItemId` and focus returns to omnibox (HM18B-R1-2)
    await omnibox.press('Enter');
    await expect(pickerDialog).toBeVisible({ timeout: UI_WAIT_MS });
    await page.locator(`#dup-opt-${secondItemId}`).click();
    await expect(pickerDialog).toBeHidden({ timeout: UI_WAIT_MS });
    await expect(omnibox).toHaveValue('', { timeout: UI_WAIT_MS });
    await expect(omnibox).toBeFocused({ timeout: UI_WAIT_MS });

    const lookupAfterPick2nd = await page.evaluate(async () => {
      const res = await fetch('/api/v1/items/lookup?name=dup-target', { credentials: 'include' });
      return (await res.json()) as { items: Array<{ id: string; entry_count: number }>; total: number };
    });
    expect(lookupAfterPick2nd.total).toBe(2);
    const updatedSecondItem = lookupAfterPick2nd.items.find((it) => it.id === secondItemId);
    expect(updatedSecondItem?.entry_count).toBe(2);

    // 3. Enter with 2 matches -> click `dup-picker-create-same-name` -> creates 3rd item and restores focus to omnibox (HM18B-R1-1, HM18B-R1-2)
    await setSecretTextareaValue(omnibox, 'dup-target: third-same-name-item-entry');
    await omnibox.press('Enter');
    await expect(pickerDialog).toBeVisible({ timeout: UI_WAIT_MS });
    await page.getByTestId('dup-picker-create-same-name').click();
    await expect(pickerDialog).toBeHidden({ timeout: UI_WAIT_MS });
    await expect(omnibox).toHaveValue('', { timeout: UI_WAIT_MS });
    await expect(omnibox).toBeFocused({ timeout: UI_WAIT_MS });

    const lookupThree = await page.evaluate(async () => {
      const res = await fetch('/api/v1/items/lookup?name=dup-target', { credentials: 'include' });
      return (await res.json()) as { items: Array<{ id: string; entry_count: number }>; total: number };
    });
    expect(lookupThree.total).toBe(3);
  });

  test('supports Ctrl+Z quick-add Undo right after save vs native textarea undo after typing a character, and preserves lock-cleared notice across the real unlock route (HM18B-R1-1, HM18B-R1-4, HM18B-R1-7)', async ({
    page,
  }) => {
    test.setTimeout(QUICK_ADD_TIMEOUT_MS);

    const apiResponses = attachApiResponseRecorder(page);
    const deleteRequestUrls: string[] = [];
    page.context().on('request', (req) => {
      if (req.method() === 'DELETE' && req.url().includes('/api/v1/')) {
        deleteRequestUrls.push(req.url());
      }
    });

    const email = uniqueEmail('content-omni-undo');
    await signupPasswordUser(page, email);
    await createVaultViaOnboarding(page, VAULT_PASSPHRASE, { kind: 'skip' });
    await expectUnlockedOnApp(page);

    await page.goto('/app');
    const omnibox = page.locator('#omni textarea[data-vault-secret]');
    await expect(omnibox).toBeVisible({ timeout: UI_WAIT_MS });

    // 1. Ctrl+Z right after save deletes ONLY the entry (item stays with entry_count === 0)
    await setSecretTextareaValue(omnibox, 'undo-target #nhà: secret-to-undo');
    await omnibox.press('Enter');
    await expectOmniboxClearedOrReport(page, omnibox, apiResponses);
    await expect(
      page.getByTestId('undo-toast-item').filter({ hasText: 'undo-target' }).first(),
    ).toBeVisible({ timeout: UI_WAIT_MS });

    const beforeUndoLookup = await page.evaluate(async () => {
      const res = await fetch('/api/v1/items/lookup?name=undo-target', { credentials: 'include' });
      return (await res.json()) as { items: Array<{ id: string; entry_count: number }>; total: number };
    });
    expect(beforeUndoLookup.total).toBe(1);
    expect(beforeUndoLookup.items[0]?.entry_count).toBe(1);

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
              total: number;
            };
          });
          return res.items[0]?.entry_count ?? -1;
        },
        { timeout: UI_WAIT_MS },
      )
      .toBe(0);
    expect(deleteRequestUrls).toHaveLength(1);
    expect(deleteRequestUrls[0]).toMatch(/\/api\/v1\/entries\/[0-9a-f-]{36}$/);

    // 2. Save another entry into 'undo-target', then type a character into the omnibox and press Ctrl+Z ->
    //    native textarea undo reverts the typed character to '' and fires 0 DELETE requests (HM18B-R1-7)
    deleteRequestUrls.length = 0;
    await setSecretTextareaValue(omnibox, 'undo-target: keep-this-entry');
    await omnibox.press('Enter');
    await expect(omnibox).toHaveValue('', { timeout: UI_WAIT_MS });
    await expect(
      page.getByTestId('undo-toast-item').filter({ hasText: 'undo-target' }).first(),
    ).toBeVisible({ timeout: UI_WAIT_MS });

    await omnibox.focus();
    await omnibox.pressSequentially('x');
    await expect(omnibox).toHaveValue('x');
    await page.keyboard.press('Control+z');

    // Native undo reverts 'x' to '' while the toast remains visible and no DELETE request is sent
    await expect(omnibox).toHaveValue('', { timeout: UI_WAIT_MS });
    await expect(
      page.getByTestId('undo-toast-item').filter({ hasText: 'undo-target' }).first(),
    ).toBeVisible({ timeout: UI_WAIT_MS });
    expect(deleteRequestUrls).toHaveLength(0);

    const afterTypingCtrlZLookup = await page.evaluate(async () => {
      const res = await fetch('/api/v1/items/lookup?name=undo-target', { credentials: 'include' });
      return (await res.json()) as { items: Array<{ id: string; entry_count: number }>; total: number };
    });
    expect(afterTypingCtrlZLookup.total).toBe(1);
    expect(afterTypingCtrlZLookup.items[0]?.entry_count).toBe(1);

    // 3. Lock mid-plan -> unlock via the real `/app/unlock` route -> post-unlock notice is visible (HM18B-R1-4)
    const { promise: postEntriesEntered, resolve: resolvePostEntriesEntered } =
      Promise.withResolvers<void>();
    const { promise: heldPostEntriesGate, resolve: releaseHeldPostEntries } =
      Promise.withResolvers<void>();
    await page.route('**/api/v1/items/*/entries', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      resolvePostEntriesEntered();
      await heldPostEntriesGate;
      await route.abort('aborted');
    });

    await setSecretTextareaValue(omnibox, 'lock-mid-plan-item #nhà: secret-dropped-on-lock');
    await omnibox.press('Enter');
    await postEntriesEntered;

    // Lock the vault while `POST /items` + `POST /tags` + `POST /items/{id}/tags` have committed and `POST /entries` is in flight
    await page.getByTestId('vault-lock-button').click();
    releaseHeldPostEntries();
    await page.unroute('**/api/v1/items/*/entries');

    await expectLockedListOnApp(page);
    await expect(omnibox).toHaveValue('');

    // Unlock through the real `/app/unlock` route (Omnibox unmounts on `/app/unlock` and remounts on `/app`)
    await unlockFromLockedList(page, VAULT_PASSPHRASE);

    const lockClearedNotice = page.getByTestId('omnibox-lock-cleared-notice');
    await expect(lockClearedNotice).toBeVisible({ timeout: UI_WAIT_MS });
    // Exact `plan` variant assertion: item and tags were committed before the lock (HM18B-R2-7)
    await expect(lockClearedNotice).toContainText(
      /Bản nháp chưa lưu đã bị xoá khi khoá vault; mục\/tag đã tạo vẫn còn|Unsaved draft was cleared when the vault locked; any item\/tags already created were kept/,
    );

    // Switching to another user in `['auth', 'me']` immediately hides and clears User A's lock notice (HM18B-R2-7)
    await page.evaluate(() => {
      const win = window as unknown as {
        __engramQueryClient?: {
          setQueryData: (key: readonly unknown[], updater: (prev: unknown) => unknown) => void;
        };
      };
      win.__engramQueryClient?.setQueryData(['auth', 'me'], (prev) => {
        if (!prev || typeof prev !== 'object') return prev;
        const prevObj: Record<string, unknown> = prev as Record<string, unknown>;
        const prevUser =
          'user' in prevObj && typeof prevObj.user === 'object' && prevObj.user !== null
            ? (prevObj.user as Record<string, unknown>)
            : {};
        return {
          ...prevObj,
          user: {
            ...prevUser,
            id: '00000000-0000-4000-8000-000000000999',
          },
        };
      });
    });
    await expect(lockClearedNotice).toBeHidden({ timeout: UI_WAIT_MS });
  });
});
