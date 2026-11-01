import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { EntryChangesPage, EntryMeta, ItemSummary, Tag } from '../lib/api/content';
import { PASSWORD, newContext, uniqueEmail } from './helpers';
import {
  createVaultViaOnboarding,
  expectLockedListOnApp,
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
  gotoSettings,
} from './vault-passkey-support';
import { fillSecret } from './vault-settings-secret';

// Disable Playwright's automatic error-context DOM snapshot in this worker before any test runs,
// so a failure while a recovery-key sheet or secret input is mounted can never serialize secrets to disk.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

const SYNC_TIMEOUT_MS = 360_000;
const NEW_VAULT_PASSPHRASE = 'sync-reset-new-vault-passphrase-2!';

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

async function triggerFocusWake(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
  });
}

async function expectOnUnlockPageWithOptionalReturnTo(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/app\/unlock(\?|$)/, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('vault-unlock-page')).toBeVisible({ timeout: UI_WAIT_MS });
  await expectVaultShut(page);
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
}
async function createTextEntryViaUi(page: Page, text: string): Promise<string> {
  await page.getByTestId('btn-add-text').click();
  const textarea = page.getByTestId('new-entry-textarea');
  await setSecretFieldValue(textarea, text);

  const createdResPromise = page.waitForResponse(
    (res) => res.request().method() === 'POST' && /\/api\/v1\/items\/[^/]+\/entries$/.test(new URL(res.url()).pathname),
    { timeout: CRYPTO_WAIT_MS },
  );
  await page.getByTestId('new-entry-save-btn').click();
  const createdRes = await createdResPromise;
  expect(createdRes.status()).toBe(201);
  const createdMeta = (await createdRes.json()) as EntryMeta;
  await expect(page.getByTestId(`entry-card-${createdMeta.id}`)).toBeVisible({ timeout: UI_WAIT_MS });
  return createdMeta.id;
}

async function closeAll(contexts: BrowserContext[]): Promise<void> {
  for (const ctx of contexts) {
    await ctx.close().catch(() => undefined);
  }
}

test.describe('P04-T20 multi-device content sync and client vault reset (A5, A8, A9)', () => {
  test.skip(
    !process.env.E2E_STACK,
    'needs the compose stack (E2E_STACK=1): real API, real database',
  );

  test('two browser contexts of the same user: refocus updates edited entry, concurrent edit surfaces 412 conflict UI without overwriting (A5), delete removes card on focus (A8), empty feed still converges via refetch, second-page 500 preserves watermark, and vault reset in A locks B on focus and keeps items/tags while removing old entries (A9)', async ({
    browser,
  }) => {
    test.setTimeout(SYNC_TIMEOUT_MS);
    const contexts: BrowserContext[] = [];

    try {
      const contextA = await newContext(browser);
      contexts.push(contextA);
      const pageA = await contextA.newPage();

      const email = uniqueEmail('content-sync');

      // 1. Setup User in Context A: signup + create vault
      await signupPasswordUser(pageA, email);
      await createVaultViaOnboarding(pageA, VAULT_PASSPHRASE, { kind: 'skip' });
      await expectUnlockedOnApp(pageA);

      // Create tag + item + initial entry in Context A
      const tagRes = await apiMutateFromPage<Tag>(pageA, 'POST', '/tags', { display: 'sync-tag' });
      expect(tagRes.status).toBe(201);

      const itemRes = await apiMutateFromPage<ItemSummary>(pageA, 'POST', '/items', {
        name: 'sync-router-item',
        hint: 'multi-device sync item',
      });
      expect(itemRes.status).toBe(201);
      const itemId = itemRes.data.id;

      const assignRes = await apiMutateFromPage<ItemSummary>(
        pageA,
        'POST',
        `/items/${itemId}/tags`,
        { tag_ids: [tagRes.data.id] },
      );
      expect(assignRes.status).toBe(200);

      // Open the item page in Context A via client-side navigation (or unlock if full navigation locked the Worker)
      await triggerFocusWake(pageA);
      const itemCardA = pageA.locator(`[data-item-card="${itemId}"]`);
      await expect(itemCardA).toBeVisible({ timeout: UI_WAIT_MS });
      await itemCardA.click();
      await expect(pageA).toHaveURL(new RegExp(`/app/items/${itemId}$`), { timeout: UI_WAIT_MS });
      await expect(pageA.getByTestId('btn-add-text')).toBeEnabled({ timeout: UI_WAIT_MS });

      const entry1Id = await createTextEntryViaUi(pageA, 'entry-1-v1-from-A');
      await expect(
        pageA.getByTestId(`entry-card-${entry1Id}`).getByTestId('entry-body'),
      ).toHaveText('entry-1-v1-from-A', { timeout: UI_WAIT_MS });

      // 2. Setup Context B (same user): login, navigate to the item page, unlock via locked banner,
      //    and trigger a focus wake on the open item page to bootstrap B's changes watermark (F1/F3)
      const contextB = await newContext(browser);
      contexts.push(contextB);
      const pageB = await contextB.newPage();

      await loginViaUiSecret(pageB, email);
      await expectOnUnlockPage(pageB);
      await gotoItemPageAndUnlockIfLocked(pageB, itemId, VAULT_PASSPHRASE);
      await expect(pageB.getByTestId('btn-add-text')).toBeEnabled({ timeout: UI_WAIT_MS });
      await expect(
        pageB.getByTestId(`entry-card-${entry1Id}`).getByTestId('entry-body'),
      ).toHaveText('entry-1-v1-from-A', { timeout: UI_WAIT_MS });

      const bootstrapFeedPromiseB = pageB.waitForResponse(
        (res) =>
          res.request().method() === 'GET' &&
          new URL(res.url()).pathname === '/api/v1/entries/changes' &&
          res.status() === 200,
        { timeout: UI_WAIT_MS },
      );
      await triggerFocusWake(pageB);
      await bootstrapFeedPromiseB;
      // Case 1: A edits an entry; B (same item open, not editing) refocuses -> sees new content
      // -----------------------------------------------------------------------
      await pageA.getByTestId(`entry-edit-btn-${entry1Id}`).click();
      await setSecretFieldValue(
        pageA.getByTestId(`entry-edit-textarea-${entry1Id}`),
        'entry-1-v2-edited-by-A',
      );
      const putV2Promise = pageA.waitForResponse(
        (res) =>
          res.request().method() === 'PUT' &&
          new URL(res.url()).pathname === `/api/v1/entries/${entry1Id}`,
        { timeout: CRYPTO_WAIT_MS },
      );
      await pageA.getByTestId(`entry-save-btn-${entry1Id}`).click();
      expect((await putV2Promise).status()).toBe(200);
      await expect(
        pageA.getByTestId(`entry-card-${entry1Id}`).getByTestId('entry-body'),
      ).toHaveText('entry-1-v2-edited-by-A', { timeout: UI_WAIT_MS });

      await triggerFocusWake(pageB);
      await expect(
        pageB.getByTestId(`entry-card-${entry1Id}`).getByTestId('entry-body'),
      ).toHaveText('entry-1-v2-edited-by-A', { timeout: UI_WAIT_MS });

      // -----------------------------------------------------------------------
      // Case 2: A and B both edit the same entry -> the later saver gets 412 conflict UI, nothing overwritten (A5)
      // -----------------------------------------------------------------------
      await pageA.getByTestId(`entry-edit-btn-${entry1Id}`).click();
      await pageB.getByTestId(`entry-edit-btn-${entry1Id}`).click();

      await setSecretFieldValue(
        pageA.getByTestId(`entry-edit-textarea-${entry1Id}`),
        'entry-1-v3-saved-first-by-A',
      );
      const putV3Promise = pageA.waitForResponse(
        (res) =>
          res.request().method() === 'PUT' &&
          new URL(res.url()).pathname === `/api/v1/entries/${entry1Id}`,
        { timeout: CRYPTO_WAIT_MS },
      );
      await pageA.getByTestId(`entry-save-btn-${entry1Id}`).click();
      expect((await putV3Promise).status()).toBe(200);

      // B tries to save stale version 2 -> gets 412 conflict UI, draft kept, A's v3 not overwritten
      await setSecretFieldValue(
        pageB.getByTestId(`entry-edit-textarea-${entry1Id}`),
        'entry-1-stale-draft-from-B',
      );
      const putConflictPromise = pageB.waitForResponse(
        (res) =>
          res.request().method() === 'PUT' &&
          new URL(res.url()).pathname === `/api/v1/entries/${entry1Id}`,
        { timeout: CRYPTO_WAIT_MS },
      );
      await pageB.getByTestId(`entry-save-btn-${entry1Id}`).click();
      expect((await putConflictPromise).status()).toBe(412);

      await expect(pageB.getByTestId(`entry-conflict-412-${entry1Id}`)).toBeVisible({
        timeout: UI_WAIT_MS,
      });
      await expect(pageB.getByTestId('entry-conflict-badge')).toBeVisible({
        timeout: UI_WAIT_MS,
      });

      // Verify A's saved v3 was NOT overwritten on the server
      await pageA.reload();
      await gotoItemPageAndUnlockIfLocked(pageA, itemId, VAULT_PASSPHRASE);
      await expect(pageA.getByTestId('btn-add-text')).toBeEnabled({ timeout: UI_WAIT_MS });
      await expect(
        pageA.getByTestId(`entry-card-${entry1Id}`).getByTestId('entry-body'),
      ).toHaveText('entry-1-v3-saved-first-by-A', { timeout: UI_WAIT_MS });
      // In B, discard conflict draft and load latest so B returns to clean state showing v3
      await pageB.getByTestId(`entry-conflict-load-latest-${entry1Id}`).click();
      await pageB.getByTestId(`entry-conflict-reload-confirm-btn-${entry1Id}`).click();
      await expect(
        pageB.getByTestId(`entry-card-${entry1Id}`).getByTestId('entry-body'),
      ).toHaveText('entry-1-v3-saved-first-by-A', { timeout: UI_WAIT_MS });

      // -----------------------------------------------------------------------
      // Case 3: A deletes an entry -> B sees it disappear after focus (A8 tombstone)
      // -----------------------------------------------------------------------
      await pageA.getByTestId(`entry-menu-trigger-${entry1Id}`).click();
      const deleteEntry1Promise = pageA.waitForResponse(
        (res) =>
          res.request().method() === 'DELETE' &&
          new URL(res.url()).pathname === `/api/v1/entries/${entry1Id}`,
        { timeout: UI_WAIT_MS },
      );
      await pageA.getByTestId(`entry-menu-delete-${entry1Id}`).click();
      expect((await deleteEntry1Promise).status()).toBe(204);
      await expect(pageA.getByTestId(`entry-card-${entry1Id}`)).toHaveCount(0, {
        timeout: UI_WAIT_MS,
      });

      await triggerFocusWake(pageB);
      await expect(pageB.getByTestId(`entry-card-${entry1Id}`)).toHaveCount(0, {
        timeout: UI_WAIT_MS,
      });

      // -----------------------------------------------------------------------
      // Case 4: Feed returns empty (B page.route on **/entries/changes** fulfilling empty changes)
      //         but A added an entry -> B still sees it after focus (canonical refetch)
      // -----------------------------------------------------------------------
      const fixedWatermark = '2026-11-01T16:00:00.123456789Z';
      const expectedSinceFromFixed = '2026-11-01T15:58:00.123456789Z';

      await pageB.route('**/api/v1/entries/changes*', async (route) => {
        const body: EntryChangesPage = {
          changes: [],
          next_cursor: null,
          watermark: fixedWatermark,
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
      });

      const entry2Id = await createTextEntryViaUi(pageA, 'entry-2-added-by-A-while-feed-empty');

      const emptyFeedWakeRes = pageB.waitForResponse(
        (res) =>
          res.request().method() === 'GET' &&
          new URL(res.url()).pathname === '/api/v1/entries/changes',
        { timeout: UI_WAIT_MS },
      );
      await triggerFocusWake(pageB);
      await emptyFeedWakeRes;

      // Even though the feed returned changes: [], B's canonical refetch loads entry2Id and decrypts its body
      await expect(
        pageB.getByTestId(`entry-card-${entry2Id}`).getByTestId('entry-body'),
      ).toHaveText('entry-2-added-by-A-while-feed-empty', { timeout: UI_WAIT_MS });

      await pageB.unroute('**/api/v1/entries/changes*');

      // -----------------------------------------------------------------------
      // Case 5: Second feed page errors (first page with next_cursor, second 500) ->
      //         watermark unchanged (assert via next feed request's `since` param equals the earlier one)
      // -----------------------------------------------------------------------
      const seenChangesRequests: Array<{ since: string | null; cursor: string | null }> = [];
      let failSecondPage = true;

      await pageB.route('**/api/v1/entries/changes*', async (route) => {
        const reqUrl = new URL(route.request().url());
        const since = reqUrl.searchParams.get('since');
        const cursor = reqUrl.searchParams.get('cursor');
        seenChangesRequests.push({ since, cursor });

        if (failSecondPage) {
          if (!cursor) {
            const page1: EntryChangesPage = {
              changes: [],
              next_cursor: 'cursor-page-2-fail',
              watermark: '2026-11-01T17:30:00.999999999Z',
            };
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify(page1),
            });
            return;
          }
          await route.fulfill({
            status: 500,
            contentType: 'application/problem+json',
            body: JSON.stringify({
              type: 'https://engram.zone17.click/problems/internal_error',
              title: 'internal_error',
              status: 500,
              code: 'internal_error',
            }),
          });
          return;
        }

        const okPage: EntryChangesPage = {
          changes: [],
          next_cursor: null,
          watermark: '2026-11-01T18:00:00.000000000Z',
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(okPage),
        });
      });

      await triggerFocusWake(pageB);
      await expect
        .poll(() => seenChangesRequests.length, { timeout: UI_WAIT_MS })
        .toBe(2);

      expect(seenChangesRequests[0]).toEqual({
        since: expectedSinceFromFixed,
        cursor: null,
      });
      expect(seenChangesRequests[1]).toEqual({
        since: expectedSinceFromFixed,
        cursor: 'cursor-page-2-fail',
      });

      // Next wake: because page 2 failed with 500, watermark was NOT updated to 17:30,
      // so the next feed request's `since` parameter still equals expectedSinceFromFixed!
      failSecondPage = false;
      await triggerFocusWake(pageB);
      await expect
        .poll(() => seenChangesRequests.length, { timeout: UI_WAIT_MS })
        .toBe(3);

      expect(seenChangesRequests[2]).toEqual({
        since: expectedSinceFromFixed,
        cursor: null,
      });

      await pageB.unroute('**/api/v1/entries/changes*');

      // -----------------------------------------------------------------------
      // Case 6: Reset vault in A -> B on focus is locked (P03) and after a new vault is created
      //         no old entries remain; items/tags remain (A9)
      // -----------------------------------------------------------------------
      await gotoSettings(pageA);
      await pageA.locator('[data-open-dialog="resetDlg"]').click();
      const resetDialog = pageA.getByRole('dialog');
      await expect(resetDialog).toBeVisible({ timeout: UI_WAIT_MS });
      await resetDialog
        .getByRole('button', { name: /^(None of these work|Không đường nào dùng được)$/ })
        .click();
      await resetDialog
        .getByRole('button', { name: /^(Checked backups|Đã kiểm tra backup)$/ })
        .click();
      await fillSecret(resetDialog.locator('#rst-reauth-pwd'), PASSWORD, UI_WAIT_MS);
      await resetDialog.getByRole('button', { name: /^(Continue|Tiếp tục)$/ }).click();
      await resetDialog.locator('#rst-confirm-word').fill('RESET');
      await expect(resetDialog.locator('#rstConfirmBtn')).toBeEnabled({ timeout: UI_WAIT_MS });

      const deleteVaultPromise = pageA.waitForResponse(
        (res) =>
          res.request().method() === 'DELETE' && new URL(res.url()).pathname === '/api/v1/vault',
        { timeout: CRYPTO_WAIT_MS },
      );
      await resetDialog.locator('#rstConfirmBtn').click();
      expect((await deleteVaultPromise).status()).toBe(204);
      await expect(resetDialog.locator('[data-view="rst-s5"]')).toBeVisible({
        timeout: CRYPTO_WAIT_MS,
      });

      // Focus B -> B detects vault reset (404 on GET /vault + GET /auth/me), locks its Worker immediately,
      // purges decrypted bodies + entries cache, and shows locked state on `/app/items/<id>` with 0 decrypted bodies
      // and no old entry body text in B's DOM (plan Task 20: "reset ở A -> B khi focus bị khoá (P03)").
      await triggerFocusWake(pageB);
      await expect
        .poll(
          async () =>
            pageB.evaluate(() => {
              const pill = document.querySelector('.vault-pill');
              return {
                pathname: window.location.pathname,
                pillState: pill?.getAttribute('data-vault-state') ?? null,
                decryptedCount: document.querySelectorAll('[data-testid="entry-body"]').length,
                hasOldPlaintextInDom: document.body.innerText.includes(
                  'entry-2-added-by-A-while-feed-empty',
                ),
              };
            }),
          { timeout: UI_WAIT_MS },
        )
        .toEqual({
          pathname: `/app/items/${itemId}`,
          pillState: 'locked',
          decryptedCount: 0,
          hasOldPlaintextInDom: false,
        });
      await expectVaultShut(pageB);
      await expect(pageB.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(pageB.getByTestId('entry-body')).toHaveCount(0);

      // Create a new vault in A via the reset dialog's "Create new vault" link -> /app/onboarding
      await resetDialog.getByRole('link', { name: /^(Create new vault|Tạo vault mới)$/ }).click();
      await createVaultViaOnboarding(pageA, NEW_VAULT_PASSPHRASE, { kind: 'skip' });
      await expectUnlockedOnApp(pageA);

      // Navigate B to /app -> B sees the new vault is locked, unlocks with NEW_VAULT_PASSPHRASE,
      // and verifies that items and tags remain while old entries are gone (A9)
      await pageB.goto('/app');
      await expectLockedListOnApp(pageB);
      await unlockFromLockedList(pageB, NEW_VAULT_PASSPHRASE);

      // Item and tag remain on /app
      await expect(pageB.getByTestId(`rail-tag-filter-${tagRes.data.id}`)).toBeVisible({
        timeout: UI_WAIT_MS,
      });
      const itemCardB = pageB.locator(`[data-item-card="${itemId}"]`);
      await expect(itemCardB).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(itemCardB).toContainText('sync-router-item');

      // Open the item in B -> empty entries state, 0 old entry cards, and no old entry body text
      await itemCardB.click();
      await expect(pageB).toHaveURL(new RegExp(`/app/items/${itemId}$`), { timeout: UI_WAIT_MS });
      await expect(pageB.getByTestId('item-entries-empty')).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(pageB.getByTestId(`entry-card-${entry2Id}`)).toHaveCount(0);
      await expect(pageB.getByTestId('entry-body')).toHaveCount(0);
      await expect(pageB.locator('body')).not.toContainText('entry-2-added-by-A-while-feed-empty');
    } finally {
      await closeAll(contexts);
    }
  });
});
