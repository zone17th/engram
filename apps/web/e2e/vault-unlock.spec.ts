import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Deterministic JS v1 crypto vectors from `packages/crypto-vectors/vectors/js-v1.json`
 * so the real browser Worker (`worker.ts`) can unlock a real Argon2id-64MiB wrapped VK.
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

/** `features/vault/unlock/recovery-notice.ts`: the non-secret tab store the recovery flow uses to hand its notice to unlock. */
const RECOVERY_NOTICE_STORAGE_KEY = 'engram.vault.recoveryCompletedNotice';
const MOCK_USER_ID = '11111111-1111-1111-1111-111111111111';

interface UnlockMockState {
  getVaultBehavior: 'succeed' | 'rate_limited_once';
  getVaultCalls: number;
}

async function installUnlockApiMocks(
  context: BrowserContext,
  state: UnlockMockState,
  locale: 'en' | 'vi' = 'en',
) {
  const url = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
  await context.addCookies([
    {
      name: 'sabk_csrf',
      value: 'test-csrf-token',
      url,
    },
  ]);

  await context.route('**/api/v1/auth/csrf', async (route) => {
    await route.fulfill({
      status: 204,
      headers: {
        'set-cookie': 'sabk_csrf=test-csrf-token; Path=/; SameSite=Lax',
      },
    });
  });

  await context.route('**/api/v1/auth/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        oauth_providers: [],
        email_verification_required: false,
        captcha_site_key: null,
      }),
    });
  });

  await context.route('**/api/v1/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: '11111111-1111-1111-1111-111111111111',
          email: 'minh@zone17th.click',
          email_verified: true,
          created_at: '2026-10-29T00:00:00Z',
        },
        settings: {
          locale,
          theme: 'light',
          auto_lock_minutes: 15,
          semantic_suggest: true,
        },
        identities: [{ provider: 'password', linked_at: '2026-10-29T00:00:00Z' }],
        features: {
          semantic_available: true,
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
      body: JSON.stringify({ status: 'ok' }),
    });
  });

  await context.route('**/api/v1/vault', async (route) => {
    state.getVaultCalls += 1;
    if (state.getVaultBehavior === 'rate_limited_once') {
      state.getVaultBehavior = 'succeed';
      await route.fulfill({
        status: 429,
        contentType: 'application/problem+json',
        headers: { 'Retry-After': '15' },
        body: JSON.stringify({
          type: 'https://engram.zone17.click/problems/rate_limited',
          title: 'rate_limited',
          status: 429,
          code: 'rate_limited',
          retry_after: 15,
        }),
      });
      return;
    }

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

async function assertNoPassphraseInStorageOrUrl(page: Page, secret: string) {
  const snapshot = await page.evaluate(async () => {
    const ls: Record<string, string> = {};
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k) ls[k] = window.localStorage.getItem(k) ?? '';
    }
    const ss: Record<string, string> = {};
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const k = window.sessionStorage.key(i);
      if (k) ss[k] = window.sessionStorage.getItem(k) ?? '';
    }
    return {
      href: window.location.href,
      localStorageText: JSON.stringify(ls),
      sessionStorageText: JSON.stringify(ss),
    };
  });

  expect(snapshot.href).not.toContain(secret);
  expect(snapshot.localStorageText).not.toContain(secret);
  expect(snapshot.sessionStorageText).not.toContain(secret);
}

test.describe('P03-T17A Vault Unlock U4 & Forgot Passphrase', () => {
  test('fresh browser context unlocks with the right passphrase, transitions to unlocked, passes axe a11y, and leaves no passphrase in storage/URL', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const context = await browser.newContext();
    try {
      const state: UnlockMockState = {
        getVaultBehavior: 'succeed',
        getVaultCalls: 0,
      };
      await installUnlockApiMocks(context, state, 'en');
      const page = await context.newPage();

      await page.goto('/app/unlock');
      await expect(page.getByTestId('vault-unlock-page')).toBeVisible();

      const axeUnlock = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(axeUnlock.violations, JSON.stringify(axeUnlock.violations, null, 2)).toEqual([]);

      await page.getByTestId('unlock-passphrase-input').fill(TEST_VECTOR_PASSPHRASE);
      await page.getByTestId('unlock-submit-button').click();

      await expect(page).toHaveURL(/\/app$/, { timeout: 30_000 });
      await expect(page.locator('.vault-pill')).toHaveClass(/vault-open/);
      await assertNoPassphraseInStorageOrUrl(page, TEST_VECTOR_PASSPHRASE);
      expect(state.getVaultCalls).toBeGreaterThanOrEqual(1);
    } finally {
      await context.close();
    }
  });

  test('fresh browser context shows "Incorrect passphrase" on wrong passphrase, shows 429 countdown, and navigates to Forgot Passphrase milestone A paths', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const context = await browser.newContext();
    try {
      const state: UnlockMockState = {
        getVaultBehavior: 'succeed',
        getVaultCalls: 0,
      };
      await installUnlockApiMocks(context, state, 'en');
      const page = await context.newPage();

      await page.goto('/app/unlock');
      await expect(page.getByTestId('vault-unlock-page')).toBeVisible();

      // 1. Wrong passphrase -> real Worker Argon2id + AEAD failure -> "Incorrect passphrase"
      const wrongPassphrase = 'wrong-passphrase-in-fresh-context';
      await page.getByTestId('unlock-passphrase-input').fill(wrongPassphrase);
      await page.getByTestId('unlock-submit-button').click();

      await expect(page.getByTestId('unlock-error-incorrect-passphrase')).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId('unlock-error-incorrect-passphrase')).toContainText(
        'Incorrect passphrase',
      );
      await expect(page.getByTestId('unlock-passphrase-input')).toHaveValue('');
      // FE1-4: the field was disabled while the Worker derived the key; after the async failure it is focused again.
      await expect(page.getByTestId('unlock-passphrase-input')).toBeFocused();
      await assertNoPassphraseInStorageOrUrl(page, wrongPassphrase);

      // 2. 429 rate_limited shows countdown
      state.getVaultBehavior = 'rate_limited_once';
      await page.getByTestId('unlock-passphrase-input').fill(TEST_VECTOR_PASSPHRASE);
      await page.getByTestId('unlock-submit-button').click();

      await expect(page.getByTestId('unlock-error-rate-limited')).toBeVisible();
      await expect(page.getByTestId('unlock-error-rate-limited')).toContainText(
        /Too many requests — please wait/i,
      );

      // 3. Click "I forgot my passphrase" -> ForgotPassphraseView with recovery key + reset paths
      await page.getByTestId('unlock-forgot-passphrase-link').click();
      await expect(page).toHaveURL(/\/app\/unlock\/forgot$/);
      await expect(page.getByTestId('forgot-passphrase-page')).toBeVisible();

      const axeForgot = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(axeForgot.violations, JSON.stringify(axeForgot.violations, null, 2)).toEqual([]);

      await expect(page.getByTestId('forgot-use-recovery-key-cta')).toHaveAttribute(
        'href',
        '/app/recovery',
      );
      await expect(page.getByTestId('forgot-reset-vault-link')).toHaveAttribute(
        'href',
        '/app/settings#baomat',
      );
    } finally {
      await context.close();
    }
  });

  test('FE1-7: the recovery-completed notice survives a real client-side route change to the unlock page, is accessible, and is gone after unlocking', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const context = await browser.newContext();
    try {
      const state: UnlockMockState = {
        getVaultBehavior: 'succeed',
        getVaultCalls: 0,
      };
      await installUnlockApiMocks(context, state, 'en');
      const page = await context.newPage();

      // The recovery route hands the notice over right before it navigates; start on another real route of the same tab.
      await page.goto('/app/unlock/forgot');
      await expect(page.getByTestId('forgot-passphrase-page')).toBeVisible();
      await page.evaluate(
        ({ key, userId }) => {
          window.sessionStorage.setItem(key, JSON.stringify({ userId, at: Date.now() }));
        },
        { key: RECOVERY_NOTICE_STORAGE_KEY, userId: MOCK_USER_ID },
      );

      // Real navigation between two separately mounted pages.
      await page.getByTestId('forgot-bottom-back-link').click();
      await expect(page).toHaveURL(/\/app\/unlock$/);
      const notice = page.getByTestId('unlock-recovered-notice');
      await expect(notice).toBeVisible();
      await expect(notice).toHaveAttribute('role', 'status');
      await expect(notice).toContainText('Your new passphrase was saved');

      const axeUnlock = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(axeUnlock.violations, JSON.stringify(axeUnlock.violations, null, 2)).toEqual([]);

      // A reload keeps it until the user actually unlocks with the new passphrase.
      await page.reload();
      await expect(page.getByTestId('unlock-recovered-notice')).toBeVisible();

      await page.getByTestId('unlock-passphrase-input').fill(TEST_VECTOR_PASSPHRASE);
      await page.getByTestId('unlock-submit-button').click();
      await expect(page).toHaveURL(/\/app$/, { timeout: 30_000 });
      const remaining = await page.evaluate(
        (key) => window.sessionStorage.getItem(key),
        RECOVERY_NOTICE_STORAGE_KEY,
      );
      expect(remaining).toBeNull();
    } finally {
      await context.close();
    }
  });
});
