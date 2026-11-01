import { expect, test, type Page } from '@playwright/test';
import type { ItemSummary, Tag } from '../lib/api/content';
import { patchSettingsViaPage, uniqueEmail } from './helpers';
import { createVaultViaOnboarding, expectUnlockedOnApp, signupPasswordUser } from './vault-journey-support';
import { VAULT_PASSPHRASE } from './vault-passkey-support';

// Disable Playwright's automatic error-context DOM snapshot in this worker before any test runs,
// so a failure while a recovery-key sheet is mounted can never serialize plaintext recovery keys to disk.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

const HOME_TIMEOUT_MS = 240_000;
const UI_WAIT_MS = 30_000;

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

test.describe('P04-T19 content home page (U10)', () => {
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  test('renders 200-rune item name and en locale without overflow, filters by tag, and deleting a tag keeps items with Undo restore', async ({
    page,
  }) => {
    test.setTimeout(HOME_TIMEOUT_MS);

    const email = uniqueEmail('content-home');
    await signupPasswordUser(page, email);
    await createVaultViaOnboarding(page, VAULT_PASSPHRASE, { kind: 'skip' });
    await expectUnlockedOnApp(page);

    // Switch locale to 'en' so the English UI strings are exercised against overflow.
    const settingsRes = await patchSettingsViaPage(page, { locale: 'en', theme: 'light' });
    expect(settingsRes.status).toBe(200);
    const origin = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:3000').origin;
    await page.context().addCookies([{ name: 'sabk_locale', value: 'en', url: `${origin}/` }]);

    // Empty state on /app before creating any items.
    await page.goto('/app');
    await expect(page.getByTestId('home-empty-state')).toBeVisible({ timeout: UI_WAIT_MS });

    // Create tags and items via the real API.
    const tagHomeRes = await apiMutateFromPage<Tag>(page, 'POST', '/tags', { display: 'home' });
    expect(tagHomeRes.status).toBe(201);
    const tagOpsRes = await apiMutateFromPage<Tag>(page, 'POST', '/tags', { display: 'ops' });
    expect(tagOpsRes.status).toBe(201);

    const long200RuneName = 'w'.repeat(200);
    const itemLongRes = await apiMutateFromPage<ItemSummary>(page, 'POST', '/items', {
      name: long200RuneName,
      hint: '200-rune boundary item name',
    });
    expect(itemLongRes.status).toBe(201);

    const assignLongTags = await apiMutateFromPage<ItemSummary>(
      page,
      'POST',
      `/items/${itemLongRes.data.id}/tags`,
      { tag_ids: [tagHomeRes.data.id] },
    );
    expect(assignLongTags.status).toBe(200);

    const itemOpsRes = await apiMutateFromPage<ItemSummary>(page, 'POST', '/items', {
      name: 'docker-cluster',
    });
    expect(itemOpsRes.status).toBe(201);

    const assignOpsTags = await apiMutateFromPage<ItemSummary>(
      page,
      'POST',
      `/items/${itemOpsRes.data.id}/tags`,
      { tag_ids: [tagOpsRes.data.id] },
    );
    expect(assignOpsTags.status).toBe(200);

    await page.reload();
    await expect(page.getByTestId('item-card')).toHaveCount(2, { timeout: UI_WAIT_MS });
    await expect(page.getByRole('heading', { name: long200RuneName })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'docker-cluster' })).toBeVisible();

    // Check 390 px mobile viewport has no horizontal overflow and the 200-rune card does not overflow.
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow390 = await page.evaluate(() => {
      const docOverflow = document.documentElement.scrollWidth <= document.documentElement.clientWidth;
      const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="item-card"]'));
      const cardsFit = cards.every((card) => card.scrollWidth <= card.clientWidth + 1);
      return {
        docScrollWidth: document.documentElement.scrollWidth,
        docClientWidth: document.documentElement.clientWidth,
        docOverflow,
        cardsFit,
      };
    });
    expect(overflow390.docScrollWidth).toBeLessThanOrEqual(overflow390.docClientWidth);
    expect(overflow390.cardsFit).toBe(true);

    // Return to desktop viewport and test tag filtering via the rail.
    await page.setViewportSize({ width: 1440, height: 900 });
    const homeTagFilter = page.getByTestId(`rail-tag-filter-${tagHomeRes.data.id}`);
    await expect(homeTagFilter).toBeVisible({ timeout: UI_WAIT_MS });
    await homeTagFilter.click();

    await expect(page).toHaveURL(new RegExp(`\\?tag=${tagHomeRes.data.id}$`), { timeout: UI_WAIT_MS });
    await expect(page.getByTestId('item-card')).toHaveCount(1, { timeout: UI_WAIT_MS });
    await expect(page.getByRole('heading', { name: long200RuneName })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'docker-cluster' })).toHaveCount(0);

    // Clear filter -> both items visible again.
    await page.getByTestId('rail-clear-filter').click();
    await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
    await expect(page.getByTestId('item-card')).toHaveCount(2, { timeout: UI_WAIT_MS });

    // Rename tag 'home' -> 'ops' triggers 409 tag_conflict inline message.
    await page.getByTestId(`rail-tag-menu-trigger-${tagHomeRes.data.id}`).click();
    await page.getByTestId(`rail-tag-rename-action-${tagHomeRes.data.id}`).click();
    const renameInput = page.getByTestId(`rail-tag-rename-input-${tagHomeRes.data.id}`);
    await renameInput.fill('ops');
    await page.getByTestId(`rail-tag-rename-save-${tagHomeRes.data.id}`).click();
    await expect(page.getByTestId(`rail-tag-rename-error-${tagHomeRes.data.id}`)).toBeVisible({
      timeout: UI_WAIT_MS,
    });
    await page.getByTestId(`rail-tag-rename-cancel-${tagHomeRes.data.id}`).click();

    // Delete tag 'home' -> item stays listed, Undo restores the tag.
    await page.getByTestId(`rail-tag-menu-trigger-${tagHomeRes.data.id}`).click();
    await page.getByTestId(`rail-tag-delete-action-${tagHomeRes.data.id}`).click();
    await expect(page.getByTestId(`rail-tag-filter-${tagHomeRes.data.id}`)).toHaveCount(0, {
      timeout: UI_WAIT_MS,
    });
    // Both items remain on the recent grid after deleting the tag.
    await expect(page.getByTestId('item-card')).toHaveCount(2, { timeout: UI_WAIT_MS });
    await expect(page.getByRole('heading', { name: long200RuneName })).toBeVisible();

    // Trigger Undo from the toast -> tag 'home' returns to the rail.
    const undoBtn = page.getByRole('button', { name: /Undo|Hoàn tác/ });
    await expect(undoBtn).toBeVisible({ timeout: UI_WAIT_MS });
    await undoBtn.click();
    await expect(page.getByTestId(`rail-tag-filter-${tagHomeRes.data.id}`)).toBeVisible({
      timeout: UI_WAIT_MS,
    });
  });
});
