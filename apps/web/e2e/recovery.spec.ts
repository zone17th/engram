import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Deterministic JS v1 crypto vectors from `packages/crypto-vectors/vectors/js-v1.json`.
 */
const TEST_VECTOR_VAULT_KEY_ID = 'vk:7f3a9b2c4d5e6f7a8b9c0d';
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
const TEST_VECTOR_RK_DISPLAY = 'rk1_014D-2PF2-DBSQ-QG28-T5CY-4TQK-FF';
const TEST_VECTOR_RK_LOOKUP_HASH = 'Tk13ljAuzyznVe3jKHwrjVktSmiO5TfazfbtINCB3xI';
const TEST_VECTOR_RK_WRAP =
  'AcDBwsPExcbHyMnKy8zNzs_Q0dLT1NXW18dWA3zmQXAPuHHij0feHrlM3pVUBUhmQ3zog3pdtAPVR3sl2xkLHUk5qkxO2bwUUQ';

const STRONG_NEW_PASSPHRASE = 'Tr\u00e0m-H\u01b0\u01a1ng-94!K\u1ef7-V\u1eadt-Xanh';

interface RecoveryMockState {
  hasPassword: boolean;
  grantTtlSeconds: number;
  vaultVersion: number;
  lookupBehavior: 'succeed' | 'invalid_key' | 'rate_limited';
  completeBehavior: 'succeed' | 'version_mismatch_once' | 'rate_limited_once';
  lookupCalls: Array<{ lookup_hash: string }>;
  completeCalls: Array<{
    idempotencyKey: string | null;
    ifMatch: string | null;
    reauthToken: string | null;
    body: string;
  }>;
  regenCalls: Array<{
    idempotencyKey: string | null;
    ifMatch: string | null;
    reauthToken: string | null;
    body: string;
  }>;
}

async function installRecoveryApiMocks(
  context: BrowserContext,
  state: RecoveryMockState,
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
        oauth_providers: state.hasPassword ? [] : ['google'],
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
        identities: state.hasPassword
          ? [{ provider: 'password', linked_at: '2026-10-29T00:00:00Z' }]
          : [{ provider: 'google', linked_at: '2026-10-29T00:00:00Z' }],
        features: {
          semantic_available: true,
          email_verification_required: false,
          oauth_providers: state.hasPassword ? [] : ['google'],
          oauth_reauth_providers: state.hasPassword ? [] : ['google'],
          password_enrollment_available: !state.hasPassword,
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

  await context.route('**/api/v1/auth/reauth', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      action: string;
      provider?: string;
    };
    const prefix = body.provider ? 'oauth-grant' : 'grant';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        grant: `${prefix}-${body.action}-token`,
        action: body.action,
        expires_at: new Date(Date.now() + state.grantTtlSeconds * 1000).toISOString(),
      }),
    });
  });

  await context.route('**/api/v1/auth/oauth/google/reauth', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authorization_url: `${url}/app/auth/callback/google?status=reauth_ready`,
      }),
    });
  });

  await context.route('**/api/v1/vault', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: state.vaultVersion,
        vault_key_id: TEST_VECTOR_VAULT_KEY_ID,
        kdf: TEST_VECTOR_KDF,
        vault_key_wrapped_by_kek: TEST_VECTOR_WRAPPED_VK,
        x25519_public: 'EIT5fcwxJb3Sw8y-V9yHL-JGU5pDVlgw9H5ueCV7OnI',
        ed25519_public: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
        private_keys_wrapped: TEST_VECTOR_WRAPPED_PRIV,
        recovery_keys_remaining: 9,
        passkeys: [],
      }),
    });
  });

  await context.route('**/api/v1/vault/unlock/recovery', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { lookup_hash: string };
    state.lookupCalls.push(body);

    if (state.lookupBehavior === 'invalid_key') {
      await route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'https://engram.zone17.click/problems/recovery_key_invalid',
          title: 'recovery_key_invalid',
          status: 401,
          code: 'recovery_key_invalid',
        }),
      });
      return;
    }

    if (state.lookupBehavior === 'rate_limited') {
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
        recovery_key_id: 'rk-id-slot-1',
        slot: 1,
        wrap: TEST_VECTOR_RK_WRAP,
      }),
    });
  });

  await context.route('**/api/v1/vault/recover/complete', async (route) => {
    const req = route.request();
    const rawBody = req.postData() ?? '';
    state.completeCalls.push({
      idempotencyKey: req.headers()['idempotency-key'] ?? null,
      ifMatch: req.headers()['if-match'] ?? null,
      reauthToken: req.headers()['x-reauth-token'] ?? null,
      body: rawBody,
    });

    if (state.completeBehavior === 'version_mismatch_once') {
      state.completeBehavior = 'succeed';
      state.vaultVersion = 4;
      await route.fulfill({
        status: 412,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'https://engram.zone17.click/problems/version_mismatch',
          title: 'version_mismatch',
          status: 412,
          code: 'version_mismatch',
        }),
      });
      return;
    }

    if (state.completeBehavior === 'rate_limited_once') {
      state.completeBehavior = 'succeed';
      await route.fulfill({
        status: 429,
        contentType: 'application/problem+json',
        headers: { 'Retry-After': '12' },
        body: JSON.stringify({
          type: 'https://engram.zone17.click/problems/rate_limited',
          title: 'rate_limited',
          status: 429,
          code: 'rate_limited',
          retry_after: 12,
        }),
      });
      return;
    }

    state.vaultVersion += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: state.vaultVersion }),
    });
  });

  await context.route('**/api/v1/vault/recovery-keys', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        remaining: 9,
        empty_slots: [1],
      }),
    });
  });

  await context.route('**/api/v1/vault/recovery-keys/regenerate', async (route) => {
    const req = route.request();
    state.regenCalls.push({
      idempotencyKey: req.headers()['idempotency-key'] ?? null,
      ifMatch: req.headers()['if-match'] ?? null,
      reauthToken: req.headers()['x-reauth-token'] ?? null,
      body: req.postData() ?? '',
    });
    state.vaultVersion += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: state.vaultVersion,
        remaining: 10,
      }),
    });
  });
}

async function assertNoSecretInStorageOrUrl(page: Page, passphraseSecret?: string) {
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

  expect(snapshot.href).not.toMatch(/rk(?:10|[1-9])_/);
  expect(snapshot.localStorageText).not.toMatch(/rk(?:10|[1-9])_/);
  expect(snapshot.sessionStorageText).not.toMatch(/rk(?:10|[1-9])_/);
  if (passphraseSecret) {
    expect(snapshot.href).not.toContain(passphraseSecret);
    expect(snapshot.localStorageText).not.toContain(passphraseSecret);
    expect(snapshot.sessionStorageText).not.toContain(passphraseSecret);
  }
}

test.describe('P03-T17A Vault Recovery by Recovery Key', () => {
  test('completes end-to-end RK recovery + regenerates empty slot 1 (showing only the new key), passes axe a11y, and leaves no RK or passphrase in DOM/storage', async ({
    context,
    page,
  }) => {
    test.setTimeout(90_000);
    const state: RecoveryMockState = {
      hasPassword: true,
      grantTtlSeconds: 300,
      vaultVersion: 1,
      lookupBehavior: 'succeed',
      completeBehavior: 'succeed',
      lookupCalls: [],
      completeCalls: [],
      regenCalls: [],
    };
    await installRecoveryApiMocks(context, state, 'en');

    await page.goto('/app/recovery');
    await expect(page.getByTestId('recovery-step-reauth')).toBeVisible();

    const axeStep1 = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(axeStep1.violations, JSON.stringify(axeStep1.violations, null, 2)).toEqual([]);

    // Step 1: Confirm account first (`vault.recover`)
    await page.getByTestId('recovery-reauth-password-input').fill('login-password-123');
    await page.getByTestId('recovery-reauth-password-submit').click();

    // Step 2: Paste RK -> cleared right after unlockRecovery is called
    await expect(page.getByTestId('recovery-step-enter-key')).toBeVisible();
    await page.getByTestId('recovery-key-input').fill(TEST_VECTOR_RK_DISPLAY);
    await page.getByTestId('recovery-key-submit').click();

    // Step 3: Set new passphrase while in `recovering` state
    await expect(page.getByTestId('recovery-step-new-passphrase')).toBeVisible({
      timeout: 30_000,
    });
    expect(state.lookupCalls).toEqual([{ lookup_hash: TEST_VECTOR_RK_LOOKUP_HASH }]);
    await assertNoSecretInStorageOrUrl(page);

    const axeStep3 = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(axeStep3.violations, JSON.stringify(axeStep3.violations, null, 2)).toEqual([]);

    await page.getByTestId('recovery-new-passphrase-input').fill(STRONG_NEW_PASSPHRASE);
    await page.getByTestId('recovery-confirm-passphrase-input').fill(STRONG_NEW_PASSPHRASE);
    await page.getByTestId('recovery-step3-submit').click();

    // Step 4A: Vault unlocked, suggests regenerating empty slot 1
    await expect(page.getByTestId('recovery-step-regenerate-reauth')).toBeVisible({
      timeout: 30_000,
    });
    expect(state.completeCalls).toHaveLength(1);
    expect(state.completeCalls[0]!.ifMatch).toBe(`"${TEST_VECTOR_VAULT_KEY_ID}:1"`);

    await page.getByTestId('recovery-step4-reauth-password-input').fill('login-password-123');
    await page.getByTestId('recovery-step4-reauth-password-submit').click();

    // Step 4B: Replacement key shown ONLY for empty slot 1
    await expect(page.getByTestId('recovery-step-regenerate-keys')).toBeVisible({
      timeout: 30_000,
    });
    const gridItems = page.getByTestId('recovery-keys-grid').getByRole('listitem');
    await expect(gridItems).toHaveCount(1);
    const newSlot1Text = (await page.getByTestId('recovery-key-slot-1').textContent()) ?? '';
    expect(newSlot1Text).toMatch(/^rk1_[0-7][0-9A-TV-Z]{3}(?:-[0-9A-TV-Z]{4}){5}-[0-9A-TV-Z]{2}$/);

    const saveBtn = page.getByTestId('recovery-step4-save-button');
    await expect(saveBtn).toBeDisabled();
    await page.getByTestId('recovery-keys-confirm-checkbox').check();
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    await expect(page).toHaveURL(/\/app$/, { timeout: 30_000 });
    expect(state.regenCalls).toHaveLength(1);
    expect(state.regenCalls[0]!.ifMatch).toBe(`"${TEST_VECTOR_VAULT_KEY_ID}:2"`);
    await expect(page.locator('body')).not.toContainText(newSlot1Text);
    await assertNoSecretInStorageOrUrl(page, STRONG_NEW_PASSPHRASE);
  });

  test('shows identical message for wrong/used RK, handles 412 version_mismatch reload, and handles OAuth expired grant mid-recovery without burning a lookup', async ({
    context,
    page,
  }) => {
    test.setTimeout(90_000);
    const state: RecoveryMockState = {
      hasPassword: true,
      grantTtlSeconds: 300,
      vaultVersion: 1,
      lookupBehavior: 'invalid_key',
      completeBehavior: 'version_mismatch_once',
      lookupCalls: [],
      completeCalls: [],
      regenCalls: [],
    };
    await installRecoveryApiMocks(context, state, 'en');

    await page.goto('/app/recovery');
    await page.getByTestId('recovery-reauth-password-input').fill('login-password-123');
    await page.getByTestId('recovery-reauth-password-submit').click();
    await expect(page.getByTestId('recovery-step-enter-key')).toBeVisible();

    // 1. Malformed RK (local Worker rejection) vs used/other-vault RK (server 401) -> same message
    await page.getByTestId('recovery-key-input').fill('rk1_014D-2PF2-DBSQ-QG28-T5CY-4TQK-00');
    await page.getByTestId('recovery-key-submit').click();
    await expect(page.getByTestId('recovery-error-invalid-key')).toBeVisible();
    // FE1-4: the field was disabled while the Worker checked the key; after the async failure it is focused again.
    await expect(page.getByTestId('recovery-key-input')).toBeFocused();
    const localInvalidText = await page.getByTestId('recovery-error-invalid-key').textContent();

    await page.getByTestId('recovery-key-input').fill(TEST_VECTOR_RK_DISPLAY);
    await page.getByTestId('recovery-key-submit').click();
    await expect(page.getByTestId('recovery-error-invalid-key')).toBeVisible();
    await expect(page.getByTestId('recovery-key-input')).toBeFocused();
    const serverInvalidText = await page.getByTestId('recovery-error-invalid-key').textContent();
    expect(serverInvalidText).toBe(localInvalidText);

    // 2. Proceed to Step 3 -> 412 version_mismatch -> asks to reload vault & restart step
    state.lookupBehavior = 'succeed';
    await page.getByTestId('recovery-key-input').fill(TEST_VECTOR_RK_DISPLAY);
    await page.getByTestId('recovery-key-submit').click();
    await expect(page.getByTestId('recovery-step-new-passphrase')).toBeVisible({
      timeout: 30_000,
    });

    await page.getByTestId('recovery-new-passphrase-input').fill(STRONG_NEW_PASSPHRASE);
    await page.getByTestId('recovery-confirm-passphrase-input').fill(STRONG_NEW_PASSPHRASE);
    await page.getByTestId('recovery-step3-submit').click();

    await expect(page.getByTestId('recovery-error-version-mismatch')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('recovery-error-version-mismatch')).toContainText(
      /Vault was updated in another tab or device/i,
    );

    await page.getByTestId('recovery-version-mismatch-reload-button').click();
    await expect(page.getByTestId('recovery-step-enter-key')).toBeVisible();

    // 3. Cancel / abandon recovery mid-way -> wipes Worker VK and returns to forgot passphrase
    await page.getByTestId('recovery-key-input').fill(TEST_VECTOR_RK_DISPLAY);
    await page.getByTestId('recovery-key-submit').click();
    await expect(page.getByTestId('recovery-step-new-passphrase')).toBeVisible({
      timeout: 30_000,
    });
    await page.getByTestId('recovery-step3-cancel').click();
    await expect(page).toHaveURL(/\/app\/unlock\/forgot$/);
    await assertNoSecretInStorageOrUrl(page);
  });

  test('OAuth-only user whose grant expires mid-recovery is told to restart from Step 1 without redirecting or burning a lookup', async ({
    context,
    page,
  }) => {
    test.setTimeout(90_000);
    const state: RecoveryMockState = {
      hasPassword: false,
      // 45s is > 0s for Step 2 lookup (`grantStillValid`), but < 60s for Step 3 first-attempt preflight
      grantTtlSeconds: 45,
      vaultVersion: 1,
      lookupBehavior: 'succeed',
      completeBehavior: 'succeed',
      lookupCalls: [],
      completeCalls: [],
      regenCalls: [],
    };
    await installRecoveryApiMocks(context, state, 'en');

    // Click "Confirm with Google" on Step 1 -> redirects through OAuth callback -> returns to /app/recovery at Step 2
    await page.goto('/app/recovery');
    await expect(page.getByTestId('recovery-step-reauth')).toBeVisible();
    await page.getByTestId('recovery-reauth-google-button').click();
    await expect(page).toHaveURL(/\/app\/recovery$/);
    await expect(page.getByTestId('recovery-step-enter-key')).toBeVisible();

    // Step 2: Enter RK -> 1 lookup call
    await page.getByTestId('recovery-key-input').fill(TEST_VECTOR_RK_DISPLAY);
    await page.getByTestId('recovery-key-submit').click();
    await expect(page.getByTestId('recovery-step-new-passphrase')).toBeVisible({
      timeout: 30_000,
    });
    expect(state.lookupCalls).toHaveLength(1);

    // Step 3: Submit new passphrase while grant has < 60s remaining -> shows OAuth restart prompt without redirecting
    await page.getByTestId('recovery-new-passphrase-input').fill(STRONG_NEW_PASSPHRASE);
    await page.getByTestId('recovery-confirm-passphrase-input').fill(STRONG_NEW_PASSPHRASE);
    await page.getByTestId('recovery-step3-submit').click();

    await expect(page.getByTestId('recovery-error-reauth-expired-oauth')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('recovery-error-reauth-expired-oauth')).toContainText(
      /Time ran out — please start again/i,
    );
    expect(state.lookupCalls).toHaveLength(1);
    expect(state.completeCalls).toHaveLength(0);

    await page.getByTestId('recovery-step3-oauth-restart-button').click();
    await expect(page.getByTestId('recovery-step-reauth')).toBeVisible();
    expect(state.lookupCalls).toHaveLength(1);
  });
});
