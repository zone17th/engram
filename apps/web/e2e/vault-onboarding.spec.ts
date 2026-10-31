import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const STRONG_PASSPHRASE = 'Tr\u00e0m-H\u01b0\u01a1ng-94!K\u1ef7-V\u1eadt-Xanh';

interface MockServerState {
  vaultStatus: 'absent' | 'present';
  postVaultCalls: Array<{
    idempotencyKey: string | null;
    body: string;
  }>;
  postVaultBehavior: 'succeed' | 'fail_network_once' | 'conflict_vault_exists';
}

async function installOnboardingApiMocks(
  context: BrowserContext,
  state: MockServerState,
  locale: 'en' | 'vi' = 'en',
) {
  const url = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
  await context.addCookies([
    { name: 'sabk_locale', value: locale, url },
    { name: 'sabk_theme', value: 'light', url },
  ]);

  await context.route('**/api/v1/auth/csrf', async (route) => {
    await route.fulfill({
      status: 204,
      headers: {
        'set-cookie': 'sabk_csrf=e2e-csrf-token; Path=/; SameSite=Lax',
      },
    });
  });

  await context.route('**/api/v1/auth/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        email_verification_required: false,
        oauth_providers: ['google', 'github'],
        captcha: { turnstile_site_key: null },
      }),
    });
  });

  await context.route('**/api/v1/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: '22222222-2222-4222-8222-222222222222',
          email: 'onboarding-e2e@example.test',
          email_verified: true,
          created_at: '2026-10-29T00:00:00Z',
        },
        settings: {
          locale,
          theme: 'light',
          auto_lock_minutes: 15,
          semantic_suggest: false,
        },
        identities: [{ provider: 'password', linked_at: '2026-10-29T00:00:00Z' }],
        features: {
          semantic_available: false,
          email_verification_required: false,
          oauth_providers: [],
          oauth_reauth_providers: [],
          password_enrollment_available: false,
          captcha_site_key: null,
        },
        vault: {
          status: state.vaultStatus,
        },
      }),
    });
  });

  await context.route('**/api/v1/readyz', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        semantic_available: false,
      }),
    });
  });

  await context.route('**/api/v1/vault', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'https://key.zone17th.click/problems/vault_absent',
          title: 'vault_absent',
          status: 404,
          code: 'vault_absent',
        }),
      });
      return;
    }

    const headers = req.headers();
    const idempotencyKey = headers['idempotency-key'] ?? null;
    const body = req.postData() ?? '';
    state.postVaultCalls.push({ idempotencyKey, body });

    if (state.postVaultBehavior === 'fail_network_once' && state.postVaultCalls.length === 1) {
      await route.abort('failed');
      return;
    }

    if (state.postVaultBehavior === 'conflict_vault_exists') {
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'https://key.zone17th.click/problems/vault_exists',
          title: 'vault_exists',
          status: 409,
          code: 'vault_exists',
          detail: 'Vault already exists for this user.',
        }),
      });
      return;
    }

    state.vaultStatus = 'present';
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        vault_key_id: 'vk:7f3a9b2c4d5e6f7a8b9c0d',
        version: 1,
      }),
    });
  });
}

async function assertNoSecretInStorageOrUrl(page: Page) {
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
}

test.describe('P03-T16A Vault Onboarding U3 (Steps 1–2)', () => {
  test('Step 1 NFC length/score validation, Step 2 real Worker RK grid + axe a11y + keyboard navigation, no POST before tick, and RKs removed from DOM/storage after completion', async ({
    context,
    page,
  }) => {
    test.setTimeout(90_000);
    const serverState: MockServerState = {
      vaultStatus: 'absent',
      postVaultCalls: [],
      postVaultBehavior: 'succeed',
    };
    await installOnboardingApiMocks(context, serverState, 'en');

    await page.goto('/app/onboarding');
    await expect(page.getByTestId('onboarding-step-passphrase')).toBeVisible();

    // Axe accessibility check on Step 1
    const axeStep1 = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(axeStep1.violations, JSON.stringify(axeStep1.violations, null, 2)).toEqual([]);

    // NFC length check: NFD string with 16 UTF-16 code units but 10 NFC characters -> rejected as too short
    const nfdShortInNfc = 'e\u0301'.repeat(6) + 'X!9a';
    await page.getByLabel('Passphrase', { exact: true }).fill(nfdShortInNfc);
    await page.getByLabel('Confirm passphrase').fill(nfdShortInNfc);
    await page.getByTestId('onboarding-continue-button').click();
    await expect(
      page.getByText(/Passphrase must be at least 12 characters/i),
    ).toBeVisible();

    // NFC score check: 12 decomposed 'a\u0301' (24 NFD code units, 12 NFC repeated chars) -> rejected as too weak
    const nfdWeakInNfc = 'a\u0301'.repeat(12);
    await page.getByLabel('Passphrase', { exact: true }).fill(nfdWeakInNfc);
    await page.getByLabel('Confirm passphrase').fill(nfdWeakInNfc);
    await page.getByTestId('onboarding-continue-button').click();
    await expect(page.getByText(/Passphrase is too easy to guess/i)).toBeVisible();

    // Valid strong passphrase -> derives real Argon2id 64 MiB + 10 Crockford Base32 RKs in the dedicated Worker
    await page.getByLabel('Passphrase', { exact: true }).fill(STRONG_PASSPHRASE);
    await page.getByLabel('Confirm passphrase').fill(STRONG_PASSPHRASE);
    await page.getByTestId('onboarding-continue-button').click();

    await expect(page.getByTestId('onboarding-step-recovery-keys')).toBeVisible({
      timeout: 30_000,
    });

    // Axe accessibility check on Step 2 (10-key grid, actions, checkbox)
    const axeStep2 = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(axeStep2.violations, JSON.stringify(axeStep2.violations, null, 2)).toEqual([]);

    // Screen reader roles/labels and keyboard focusability on the 10-key grid
    const gridList = page.getByRole('list', { name: /10 single-use recovery keys/i });
    await expect(gridList).toBeVisible();
    const listItems = gridList.getByRole('listitem');
    await expect(listItems).toHaveCount(10);
    await expect(listItems.first()).toHaveAttribute('aria-label', 'Recovery key 1 of 10');
    await expect(listItems.nth(9)).toHaveAttribute('aria-label', 'Recovery key 10 of 10');

    const slot1Code = page.getByTestId('recovery-key-slot-1');
    await slot1Code.focus();
    await expect(slot1Code).toBeFocused();
    const slot1Text = (await slot1Code.textContent()) ?? '';
    expect(slot1Text).toMatch(/^rk1_[0-7][0-9A-TV-Z]{3}(?:-[0-9A-TV-Z]{4}){5}-[0-9A-TV-Z]{2}$/);

    // Not ticked -> Create vault button is disabled and no POST /vault was sent
    const createBtn = page.getByTestId('onboarding-create-vault-button');
    await expect(createBtn).toBeDisabled();
    expect(serverState.postVaultCalls).toHaveLength(0);
    await assertNoSecretInStorageOrUrl(page);

    // Tick the confirmation checkbox and submit
    await page.getByTestId('recovery-keys-confirm-checkbox').check();
    await expect(createBtn).toBeEnabled();
    expect(serverState.postVaultCalls).toHaveLength(0);

    await createBtn.click();

    await page.getByTestId('onboarding-skip-passkey-button').click();
    // Navigates to /app, RKs are wiped from DOM and storage, and vault state is unlocked
    await expect(page).toHaveURL(/\/app$/);
    expect(serverState.postVaultCalls).toHaveLength(1);
    expect(serverState.postVaultCalls[0]!.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(serverState.postVaultCalls[0]!.body).not.toContain(slot1Text);
    await expect(page.locator('body')).not.toContainText(slot1Text);
    await assertNoSecretInStorageOrUrl(page);
    await expect(page.locator('.vault-pill')).toHaveClass(/vault-open/);
  });

  test('reload mid-flow leaves no RK in storage, network retry reuses the same Idempotency-Key and body, and 409 vault_exists wipes RKs and shows the discard message', async ({
    context,
    page,
  }) => {
    test.setTimeout(90_000);
    const serverState: MockServerState = {
      vaultStatus: 'absent',
      postVaultCalls: [],
      postVaultBehavior: 'fail_network_once',
    };
    await installOnboardingApiMocks(context, serverState, 'en');

    await page.goto('/app/onboarding');
    await page.getByLabel('Passphrase', { exact: true }).fill(STRONG_PASSPHRASE);
    await page.getByLabel('Confirm passphrase').fill(STRONG_PASSPHRASE);
    await page.getByTestId('onboarding-continue-button').click();

    await expect(page.getByTestId('onboarding-step-recovery-keys')).toBeVisible({
      timeout: 30_000,
    });
    const firstRunRk1 = (await page.getByTestId('recovery-key-slot-1').textContent()) ?? '';
    expect(firstRunRk1).toMatch(/^rk1_/);

    // Reload mid-flow before ticking -> returns to Step 1, no RK in DOM or any storage
    await page.reload();
    await expect(page.getByTestId('onboarding-step-passphrase')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(firstRunRk1);
    await assertNoSecretInStorageOrUrl(page);
    expect(serverState.postVaultCalls).toHaveLength(0);

    // Re-enter passphrase -> Step 2 -> tick -> first POST fails on network -> retry reuses exact Idempotency-Key & body
    await page.getByLabel('Passphrase', { exact: true }).fill(STRONG_PASSPHRASE);
    await page.getByLabel('Confirm passphrase').fill(STRONG_PASSPHRASE);
    await page.getByTestId('onboarding-continue-button').click();
    await expect(page.getByTestId('onboarding-step-recovery-keys')).toBeVisible({
      timeout: 30_000,
    });

    await page.getByTestId('recovery-keys-confirm-checkbox').check();
    await page.getByTestId('onboarding-create-vault-button').click();

    await expect(page.getByTestId('onboarding-step2-error')).toContainText(
      /Could not reach the server/i,
    );
    expect(serverState.postVaultCalls).toHaveLength(1);

    // Now make the second attempt return 409 vault_exists to verify both Idempotency-Key reuse and 409 handling
    serverState.postVaultBehavior = 'conflict_vault_exists';
    const rkBefore409 = (await page.getByTestId('recovery-key-slot-1').textContent()) ?? '';
    await page.getByTestId('onboarding-create-vault-button').click();

    await expect(page.getByTestId('onboarding-step-vault-exists')).toBeVisible();
    expect(serverState.postVaultCalls).toHaveLength(2);
    expect(serverState.postVaultCalls[1]!.idempotencyKey).toBe(
      serverState.postVaultCalls[0]!.idempotencyKey,
    );
    expect(serverState.postVaultCalls[1]!.body).toBe(serverState.postVaultCalls[0]!.body);

    // 409 screen hides the RK grid immediately and instructs user to discard the generated RKs
    await expect(page.getByTestId('recovery-keys-grid')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(rkBefore409);
    const vaultExistsStep = page.getByTestId('onboarding-step-vault-exists');
    await expect(vaultExistsStep.getByRole('alert')).toContainText(
      /Vault was created elsewhere \(another tab or device\)/i,
    );
    await expect(vaultExistsStep.getByRole('alert')).toContainText(/discard them immediately/i);
  });
});
