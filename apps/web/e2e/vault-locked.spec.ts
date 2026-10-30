import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { DEMO_ITEMS } from '../lib/demo-fixtures';

/**
 * P03-T21 locked state U5, browser path. Context-level API mocks (same shape as `vault-unlock.spec.ts`) plus the real
 * Argon2id/AEAD Worker and the committed js-v1 crypto vectors. The entry bodies are the public demo texts of the preview
 * pages; the Entries API is P04, so the assertion is about WHERE they may exist: only in the page while unlocked, never
 * while locked (text, attributes, `dataset`, serialised markup).
 */
const TEST_VECTOR_PASSPHRASE = 'correct-horse-battery-staple-engram-js-v1';
const TEST_VECTOR_KDF = {
  alg: 'argon2id13' as const,
  ops: 3,
  mem: 67_108_864,
  parallelism: 1 as const,
  salt: 'oKGio6SlpqeoqaqrrK2urw',
};
const TEST_VECTOR_WRAPPED_VK =
  'AbCxsrO0tba3uLm6u7y9vr_AwcLDxMXGxyfYfNv-vuDRS6i3Up5z_wCEX2cLt1xXgujuY7dGa_eirv2y5QQSBXkKR95PrK-ilA';
const TEST_VECTOR_WRAPPED_PRIV =
  'AeDh4uPk5ebn6Onq6-zt7u_w8fLz9PX299I6ypcubNr8Ofy8RwtQE-3gVPZ1cTrHgeO1ZMoyFkOJgqz7gG75ofa4qHejTdUrskM0hqoPmKH-rt_ZLSoHn2BH9MF-TUGyovpu_punj7v-';
const TEST_VECTOR_VAULT_KEY_ID = 'vk:7f3a9b2c4d5e6f7a8b9c0d';

const UI_WAIT_MS = 30_000;
const CRYPTO_WAIT_MS = 60_000;
const BODIES = DEMO_ITEMS.map((item) => item.preview);

async function installApiMocks(context: BrowserContext) {
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
      body: JSON.stringify({ oauth_providers: [], email_verification_required: false, captcha_site_key: null }),
    });
  });
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
        settings: { locale: 'en', theme: 'light', auto_lock_minutes: 15, semantic_suggest: false },
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
  await context.route('**/api/v1/readyz', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', semantic_available: false }),
    });
  });
  await context.route('**/api/v1/vault', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: 1,
        vault_key_id: TEST_VECTOR_VAULT_KEY_ID,
        kdf: TEST_VECTOR_KDF,
        vault_key_wrapped_by_kek: TEST_VECTOR_WRAPPED_VK,
        x25519_public: 'EIT5fcwxJb3Sw8y-V9yHL-JGU5pDVlgw9H5ueCV7OnI',
        ed25519_public: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
        private_keys_wrapped: TEST_VECTOR_WRAPPED_PRIV,
        recovery_keys_remaining: 10,
        passkeys: [],
      }),
    });
  });
}

/** Writes a secret into a controlled React input without the value appearing in a Playwright call log (no fill()). */
async function fillSecret(input: Locator, value: string) {
  await expect(input).toBeEditable({ timeout: CRYPTO_WAIT_MS });
  await input.evaluate((element, next) => {
    const field = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('HTMLInputElement value setter is missing');
    setter.call(field, next);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

/** Where plaintext may never be while locked: any attribute value, `dataset`, visible text, or serialised markup. */
async function findBodyLeaks(page: Page, bodies: readonly string[]): Promise<string[]> {
  return page.evaluate((needles) => {
    const leaks: string[] = [];
    const nodes = [document.documentElement, ...Array.from(document.querySelectorAll<HTMLElement>('*'))];
    for (const node of nodes) {
      for (const attr of Array.from(node.attributes)) {
        if (needles.some((needle) => attr.value.includes(needle))) {
          leaks.push(`attribute ${attr.name} on <${node.tagName.toLowerCase()}>`);
        }
      }
      for (const [key, value] of Object.entries(node.dataset ?? {})) {
        if (needles.some((needle) => (value ?? '').includes(needle))) leaks.push(`dataset.${key}`);
      }
    }
    const markup = document.documentElement.outerHTML;
    const text = document.body.innerText;
    for (const needle of needles) {
      if (markup.includes(needle)) leaks.push('markup');
      if (text.includes(needle)) leaks.push('text');
    }
    return [...new Set(leaks)];
  }, bodies);
}

async function expectLockedList(page: Page) {
  await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
  await expect(page.locator('.vault-pill')).toHaveAttribute('data-vault-state', 'locked', { timeout: UI_WAIT_MS });
  await expect(page.locator('.vault-pill')).toHaveClass(/vault-shut/);
  await expect(page.getByTestId('item-card')).toHaveCount(DEMO_ITEMS.length);
  await expect(page.getByTestId('entry-body-locked')).toHaveCount(DEMO_ITEMS.length);
  await expect(page.getByTestId('entry-body')).toHaveCount(0);
  expect(await findBodyLeaks(page, BODIES)).toEqual([]);
}

async function unlockFromBanner(page: Page) {
  await page.getByTestId('vault-locked-unlock-cta').click({ timeout: UI_WAIT_MS });
  await expect(page.getByTestId('vault-unlock-page')).toBeVisible({ timeout: UI_WAIT_MS });
  await fillSecret(page.getByTestId('unlock-passphrase-input'), TEST_VECTOR_PASSPHRASE);
  await page.getByTestId('unlock-submit-button').click();
  await expect(page.locator('.vault-pill')).toHaveAttribute('data-vault-state', 'unlocked', {
    timeout: CRYPTO_WAIT_MS,
  });
}

test.describe('P03-T21 Locked state U5', () => {
  test('locked list keeps name/tag/type, masks bodies with no plaintext in the DOM; unlock -> bodies; lock -> bodies gone; unlock again -> bodies', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext();
    try {
      await installApiMocks(context);
      const page = await context.newPage();

      // Fresh context = locked vault. The list stays on screen with names, tags and types; bodies are masked.
      await page.goto('/app');
      await expectLockedList(page);
      await expect(page.getByTestId('entry-body-locked').first()).toContainText('🔒 ••••••');
      for (const item of DEMO_ITEMS) {
        await expect(page.getByRole('heading', { name: item.title })).toBeVisible();
      }
      await expect(page.getByTestId('item-card').first()).toContainText(`#${DEMO_ITEMS[0].tags[0]}`);
      await expect(page.getByTestId('item-card').first()).toContainText(DEMO_ITEMS[0].kind.toUpperCase());
      expect(await page.locator('textarea, [contenteditable]:not([contenteditable="false"])').count()).toBe(0);

      // Unlock (real Worker): every body is on screen, and still no attribute or dataset carries a body.
      await unlockFromBanner(page);
      await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('entry-body')).toHaveCount(DEMO_ITEMS.length, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('entry-body-locked')).toHaveCount(0);
      await expect(page.getByTestId('entry-body').first()).toHaveText(DEMO_ITEMS[0].preview);
      await expect(page.getByTestId('vault-locked-banner')).toHaveCount(0);
      const unlockedLeaks = await findBodyLeaks(page, BODIES);
      expect(unlockedLeaks.filter((leak) => leak.startsWith('attribute') || leak.startsWith('dataset'))).toEqual([]);

      // Lock now (header pill): bodies leave the DOM, the list stays.
      await page.getByTestId('vault-lock-button').click();
      await expectLockedList(page);
      await expect(page).toHaveURL(/\/app$/);

      // Unlock again: bodies come back.
      await unlockFromBanner(page);
      await expect(page.getByTestId('entry-body')).toHaveCount(DEMO_ITEMS.length, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('entry-body').first()).toHaveText(DEMO_ITEMS[0].preview);
    } finally {
      await context.close();
    }
  });

  test('locked item page shows title, tags and type with a masked body and no plaintext in the DOM; unlock shows the body', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext();
    try {
      await installApiMocks(context);
      const page = await context.newPage();
      const item = DEMO_ITEMS[0];

      await page.goto(`/app/items/${item.id}`);
      await expect(page.getByRole('heading', { level: 1, name: item.title })).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(page.getByTestId('item-article')).toBeVisible();
      await expect(page.getByTestId('entry-body-locked')).toHaveCount(1);
      await expect(page.getByTestId('entry-body-locked')).toContainText('🔒 ••••••');
      await expect(page.getByTestId('entry-body')).toHaveCount(0);
      await expect(page.locator('.vault-pill')).toHaveAttribute('data-vault-state', 'locked');
      for (const tag of item.tags) {
        await expect(page.getByTestId('item-tags')).toContainText(`#${tag}`);
      }
      expect(await findBodyLeaks(page, BODIES)).toEqual([]);
      expect(await page.locator('textarea, [contenteditable]:not([contenteditable="false"])').count()).toBe(0);

      await unlockFromBanner(page);
      await expect(page).toHaveURL(new RegExp(`/app/items/${item.id}$`), { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('entry-body')).toHaveText(item.preview, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('entry-body-locked')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  // FE1-2: suggestions are another place a body could surface. Locked search is names and tags only, with no preview text.
  for (const [label, path, viewport] of [
    ['list search on /app', '/app', { width: 1280, height: 800 }],
    ['item header search', `/app/items/${DEMO_ITEMS[1].id}`, { width: 1280, height: 800 }],
  ] as const) {
    test(`locked ${label} matches names and tags only and shows no body preview anywhere`, async ({ browser }) => {
      test.setTimeout(120_000);
      const context = await browser.newContext({ viewport });
      try {
        await installApiMocks(context);
        const page = await context.newPage();
        const bodyOnly = DEMO_ITEMS[0]; // "phin" is only in this item's body, never in a title or tag

        await page.goto(path);
        await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
        const input = page.getByRole('combobox');
        await expect(input).toBeVisible({ timeout: UI_WAIT_MS });

        // Name query: the item is suggested, with the popover open the page still holds no body.
        await input.fill('ca phe');
        await expect(page.getByRole('listbox')).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(page.locator(`[data-search-option="${bodyOnly.id}"]`)).toBeVisible();
        expect(await findBodyLeaks(page, BODIES)).toEqual([]);

        // Body-only query: nothing matches while locked, and still nothing leaks.
        await input.fill('phin');
        await expect(page.getByRole('listbox')).toBeVisible();
        await expect(page.locator('[data-search-option]')).toHaveCount(0);
        await expect(page.getByText('Không có mục mẫu phù hợp.')).toBeVisible();
        expect(await findBodyLeaks(page, BODIES)).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});
