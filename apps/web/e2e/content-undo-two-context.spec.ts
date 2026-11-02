import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { EntryMeta, ItemSummary } from '../lib/api/content';
import { newContext, uniqueEmail } from './helpers';
import {
  createVaultViaOnboarding,
  expectUnlockedOnApp,
  loginViaUiSecret,
  signupPasswordUser,
  unlockFromLockedList,
} from './vault-journey-support';
import {
  CRYPTO_WAIT_MS,
  UI_WAIT_MS,
  VAULT_PASSPHRASE,
  expectOnUnlockPage,
  expectVaultShut,
} from './vault-passkey-support';
import { fillSecret } from './vault-settings-secret';

// Disable Playwright's automatic error-context DOM snapshot in this worker before any test runs,
// so a failure while a recovery-key sheet or secret input is mounted can never serialize secrets to disk.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

const UNDO_TWO_CONTEXT_TIMEOUT_MS = 300_000;
const ENTRY_CARD_SELECTOR = '[data-testid^="entry-card-"]:not([data-testid="entry-card-list"])';

interface RecordedRequest {
  readonly method: string;
  readonly pathname: string;
}

/**
 * Writes a value into a `<textarea>` or `<input>` without appearing in Playwright's `fill()` call logs.
 */
async function setSecretFieldValue(locator: Locator, value: string): Promise<void> {
  await expect(locator).toBeVisible({ timeout: UI_WAIT_MS });
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

async function apiMutateFromPage<TResponse>(
  page: Page,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: TResponse }> {
  return page.evaluate(
    async ({ methodArg, pathArg, bodyArg }) => {
      const parts = document.cookie.split(';');
      let csrf: string | null = null;
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith('sabk_csrf=')) {
          csrf = decodeURIComponent(trimmed.slice('sabk_csrf='.length));
          break;
        }
      }
      const res = await fetch(`/api/v1${pathArg}`, {
        method: methodArg,
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          ...(bodyArg !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: bodyArg !== undefined ? JSON.stringify(bodyArg) : undefined,
      });
      const parsed = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
      return { status: res.status, data: parsed as TResponse };
    },
    { methodArg: method, pathArg: path, bodyArg: body },
  );
}

async function expectOnUnlockPageWithOptionalReturnTo(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/app\/unlock(\?|$)/, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('vault-unlock-page')).toBeVisible({ timeout: UI_WAIT_MS });
  await expectVaultShut(page);
}

async function unlockFromLockedBannerOnItemPage(
  page: Page,
  itemId: string,
  passphrase = VAULT_PASSPHRASE,
): Promise<void> {
  await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
  await page.getByTestId('vault-locked-unlock-cta').click({ timeout: UI_WAIT_MS });
  await expectOnUnlockPageWithOptionalReturnTo(page);
  await fillSecret(page.getByTestId('unlock-passphrase-input'), passphrase, CRYPTO_WAIT_MS);
  await page.getByTestId('unlock-submit-button').click();
  await expect(page).toHaveURL(new RegExp(`/app/items/${itemId}$`), { timeout: CRYPTO_WAIT_MS });
  await expect(page.locator('.vault-pill').first()).toHaveAttribute(
    'data-vault-state',
    'unlocked',
    { timeout: CRYPTO_WAIT_MS },
  );
}

async function gotoItemPageAndUnlockIfLocked(
  page: Page,
  itemId: string,
  passphrase = VAULT_PASSPHRASE,
): Promise<void> {
  await page.goto(`/app/items/${itemId}`);
  const pill = page.locator('.vault-pill').first();
  await expect(pill).toBeVisible({ timeout: UI_WAIT_MS });
  const state = await pill.getAttribute('data-vault-state');
  if (state !== 'unlocked') {
    await unlockFromLockedBannerOnItemPage(page, itemId, passphrase);
  }
}

async function closeAll(contexts: BrowserContext[]): Promise<void> {
  for (const ctx of contexts) {
    await ctx.close().catch(() => undefined);
  }
}

test.describe('P04-FU14 two-context quick-add Undo (advisor-dec-239, dec-205 follow-up)', () => {
  test.skip(
    !process.env.E2E_STACK,
    'needs the compose stack (E2E_STACK=1): real API, real database',
  );

  test('quick-add Undo in context A deletes only the entry and preserves context B item rename and tag addition across reloads (P4BE1-2, dec-116, dec-239)', async ({
    browser,
  }) => {
    test.setTimeout(UNDO_TWO_CONTEXT_TIMEOUT_MS);
    const contexts: BrowserContext[] = [];

    try {
      const contextA = await newContext(browser);
      contexts.push(contextA);
      const pageA = await contextA.newPage();

      const contextB = await newContext(browser);
      contexts.push(contextB);
      const pageB = await contextB.newPage();

      // Record context A's /api/v1/* requests by method + pathname only (never bodies or headers, user-dec-016).
      const requestsFromA: RecordedRequest[] = [];
      contextA.on('request', (req) => {
        const url = req.url();
        if (url.includes('/api/v1/')) {
          requestsFromA.push({
            method: req.method(),
            pathname: new URL(url).pathname,
          });
        }
      });

      const email = uniqueEmail('content-undo-two-ctx');
      const initialItemName = 'shared-undo-item';
      const renamedItemName = 'shared-undo-item-renamed-by-b';
      const addedTagDisplay = 'b-tag';

      let itemId = '';
      let createdEntryId = '';

      await test.step('1. Same user signed in and unlocked in context A and context B; an item exists with no entries', async () => {
        await signupPasswordUser(pageA, email);
        await createVaultViaOnboarding(pageA, VAULT_PASSPHRASE, { kind: 'skip' });
        await expectUnlockedOnApp(pageA);

        const createItemRes = await apiMutateFromPage<ItemSummary>(pageA, 'POST', '/items', {
          name: initialItemName,
        });
        expect(createItemRes.status).toBe(201);
        expect(createItemRes.data.entry_count).toBe(0);
        itemId = createItemRes.data.id;

        // Sign in and unlock Context B on the item page, verifying the item exists with 0 entries.
        await loginViaUiSecret(pageB, email);
        await expectOnUnlockPage(pageB);
        await gotoItemPageAndUnlockIfLocked(pageB, itemId, VAULT_PASSPHRASE);
        await expect(pageB.getByTestId('btn-add-text')).toBeEnabled({ timeout: UI_WAIT_MS });
        await expect(pageB.getByTestId('item-name-input')).toHaveValue(initialItemName, {
          timeout: UI_WAIT_MS,
        });
        await expect(pageB.getByTestId('item-entries-empty')).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(pageB.locator(ENTRY_CARD_SELECTOR)).toHaveCount(0);
      });

      const undoToastA = pageA
        .getByTestId('undo-toast-item')
        .filter({ hasText: initialItemName })
        .first();
      const undoBtnA = undoToastA.getByRole('button', { name: /Undo|Hoàn tác/ });

      await test.step('2. Context A quick-adds an entry to that item and keeps the Undo toast open', async () => {
        const omniboxA = pageA.locator('#omni textarea[data-vault-secret]');
        await expect(omniboxA).toBeVisible({ timeout: UI_WAIT_MS });

        const postEntryPromise = pageA.waitForResponse(
          (res) =>
            res.request().method() === 'POST' &&
            new URL(res.url()).pathname === `/api/v1/items/${itemId}/entries`,
          { timeout: CRYPTO_WAIT_MS },
        );

        await setSecretFieldValue(omniboxA, `${initialItemName}: entry-from-context-a`);
        await omniboxA.press('Enter');

        const postEntryRes = await postEntryPromise;
        expect(postEntryRes.status()).toBe(201);
        const createdMeta = (await postEntryRes.json()) as EntryMeta;
        createdEntryId = createdMeta.id;
        expect(createdEntryId).toMatch(/^[0-9a-f-]{36}$/i);

        await expect(undoToastA).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(undoBtnA).toBeVisible({ timeout: UI_WAIT_MS });

        // Focus the Undo button inside the toast stack in A so UndoToastProvider pauses all timers
        // (`isFocusedInside === true`) while Context B renames the item, attaches a tag, and reloads.
        await undoBtnA.focus();
        await expect(undoBtnA).toBeFocused();
      });

      await test.step('3. Context B renames the item and adds a tag; wait until server has both (B sees them after reload)', async () => {
        const nameInputB = pageB.getByTestId('item-name-input');
        await expect(nameInputB).toBeVisible({ timeout: UI_WAIT_MS });

        const patchItemPromise = pageB.waitForResponse(
          (res) =>
            res.request().method() === 'PATCH' &&
            new URL(res.url()).pathname === `/api/v1/items/${itemId}`,
          { timeout: UI_WAIT_MS },
        );
        await nameInputB.fill(renamedItemName);
        await nameInputB.press('Enter');
        expect((await patchItemPromise).status()).toBe(200);

        await pageB.getByTestId('tag-add-chip').click();
        const tagInputB = pageB.getByTestId('tag-suggest-input');
        await expect(tagInputB).toBeVisible({ timeout: UI_WAIT_MS });

        const postTagPromise = pageB.waitForResponse(
          (res) =>
            res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/v1/tags',
          { timeout: UI_WAIT_MS },
        );
        const attachTagPromise = pageB.waitForResponse(
          (res) =>
            res.request().method() === 'POST' &&
            new URL(res.url()).pathname === `/api/v1/items/${itemId}/tags`,
          { timeout: UI_WAIT_MS },
        );
        await tagInputB.fill(addedTagDisplay);
        await pageB.getByTestId('tag-attach-submit').click();
        expect([200, 201]).toContain((await postTagPromise).status());
        expect((await attachTagPromise).status()).toBe(200);
        await expect(pageB.getByTestId(`item-tag-chip-${addedTagDisplay}`)).toBeVisible({
          timeout: UI_WAIT_MS,
        });

        // Reload B to confirm the server has persisted both the rename and the tag before A clicks Undo.
        await pageB.reload();
        await gotoItemPageAndUnlockIfLocked(pageB, itemId, VAULT_PASSPHRASE);
        await expect(pageB.getByTestId('item-name-input')).toHaveValue(renamedItemName, {
          timeout: UI_WAIT_MS,
        });
        await expect(pageB.getByTestId(`item-tag-chip-${addedTagDisplay}`)).toBeVisible({
          timeout: UI_WAIT_MS,
        });
      });

      await test.step('4. Context A clicks Undo; assert A sends only DELETE /api/v1/entries/<id> and no item/tag write', async () => {
        await expect(undoToastA).toBeVisible({ timeout: UI_WAIT_MS });
        requestsFromA.length = 0;

        const deleteEntryPromise = pageA.waitForResponse(
          (res) =>
            res.request().method() === 'DELETE' &&
            new URL(res.url()).pathname === `/api/v1/entries/${createdEntryId}`,
          { timeout: UI_WAIT_MS },
        );
        await undoBtnA.click();
        expect((await deleteEntryPromise).status()).toBe(204);
        await expect(pageA.getByTestId('undo-toast-item')).toHaveCount(0, {
          timeout: UI_WAIT_MS,
        });

        const writeRequestsFromA = requestsFromA.filter((req) =>
          ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method),
        );
        expect(writeRequestsFromA).toEqual([
          {
            method: 'DELETE',
            pathname: `/api/v1/entries/${createdEntryId}`,
          },
        ]);
        expect(
          requestsFromA.filter(
            (req) =>
              (req.method === 'PATCH' || req.method === 'PUT' || req.method === 'DELETE') &&
              req.pathname.startsWith('/api/v1/items'),
          ),
        ).toEqual([]);
      });

      await test.step('5. Reload A and B; assert the entry list is empty and B’s new name and tag remain in both contexts', async () => {
        // Reload Context A on `/app`, unlock, verify home card has B's renamed title, #b-tag, and 0 entries,
        // then open the item page in A and verify the empty entry list, renamed title, and tag chip.
        await pageA.reload();
        await unlockFromLockedList(pageA, VAULT_PASSPHRASE);
        const cardA = pageA.locator(`[data-item-card="${itemId}"]`);
        await expect(cardA).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(cardA.getByRole('heading', { name: renamedItemName })).toBeVisible({
          timeout: UI_WAIT_MS,
        });
        await expect(
          cardA.getByTestId('item-tag-chip').filter({ hasText: `#${addedTagDisplay}` }),
        ).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(cardA.getByTestId('item-entry-count')).toContainText('0', {
          timeout: UI_WAIT_MS,
        });

        await cardA.click();
        await expect(pageA).toHaveURL(new RegExp(`/app/items/${itemId}$`), { timeout: UI_WAIT_MS });
        await expect(pageA.getByTestId('btn-add-text')).toBeEnabled({ timeout: UI_WAIT_MS });
        await expect(pageA.getByTestId('item-name-input')).toHaveValue(renamedItemName, {
          timeout: UI_WAIT_MS,
        });
        await expect(pageA.getByTestId(`item-tag-chip-${addedTagDisplay}`)).toBeVisible({
          timeout: UI_WAIT_MS,
        });
        await expect(pageA.getByTestId('item-entries-empty')).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(pageA.locator(ENTRY_CARD_SELECTOR)).toHaveCount(0);
        await expect(pageA.getByTestId(`entry-card-${createdEntryId}`)).toHaveCount(0);

        // Reload Context B on the item page, unlock, and verify the empty entry list, renamed title, and tag chip.
        await pageB.reload();
        await gotoItemPageAndUnlockIfLocked(pageB, itemId, VAULT_PASSPHRASE);
        await expect(pageB.getByTestId('btn-add-text')).toBeEnabled({ timeout: UI_WAIT_MS });
        await expect(pageB.getByTestId('item-name-input')).toHaveValue(renamedItemName, {
          timeout: UI_WAIT_MS,
        });
        await expect(pageB.getByTestId(`item-tag-chip-${addedTagDisplay}`)).toBeVisible({
          timeout: UI_WAIT_MS,
        });
        await expect(pageB.getByTestId('item-entries-empty')).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(pageB.locator(ENTRY_CARD_SELECTOR)).toHaveCount(0);
        await expect(pageB.getByTestId(`entry-card-${createdEntryId}`)).toHaveCount(0);
      });
    } finally {
      await closeAll(contexts);
    }
  });
});
