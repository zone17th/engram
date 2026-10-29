import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  PASSWORD,
  newContext,
  signupViaUi,
  tokenFromLink,
  uniqueEmail,
  verifyRequired,
  waitForMail,
} from './helpers';

const INITIAL_VAULT_PASSPHRASE = 'correct-horse-battery-staple-gn-v1';
const UPDATED_VAULT_PASSPHRASE = 'updated-horse-battery-staple-gn-v2!';
const TEST_VECTOR_KDF = {
  alg: 'argon2id13' as const,
  ops: 3,
  mem: 67_108_864,
  parallelism: 1,
  salt: 'oKGio6SlpqeoqaqrrK2urw',
};
const TEST_VECTOR_WRAPPED_VK =
  'AbCxsrO0tba3uLm6u7y9vr_AwcLDxMXGxyfYfNv-vuDRS6i3Up5z_wCEX2cLt1xXgujuY7dGa_eirv2y5QQSBXkKR95PrK-ilA';
const TEST_VECTOR_WRAPPED_PRIV =
  'AeDh4uPk5ebn6Onq6-zt7u_w8fLz9PX299I6ypcubNr8Ofy8RwtQE-3gVPZ1cTrHgeO1ZMoyFkOJgqz7gG75ofa4qHejTdUrskM0hqoPmKH-rt_ZLSoHn2BH9MF-TUGyovpu_punj7v-';
const TEST_VECTOR_VAULT_KEY_ID = 'vk:7f3a9b2c4d5e6f7a8b9c0d';

async function confirmEmailToken(page: Page, token: string) {
  await page.goto(`/app/auth/verify-email?token=${encodeURIComponent(token)}`);
  const respPromise = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/api/v1/auth/verify-email/confirm'),
    { timeout: 20_000 },
  );
  await page.getByRole('button', { name: /Confirm|Xác nhận email/ }).click();
  const resp = await respPromise;
  expect(resp.status()).toBe(200);
}

/**
 * Creates a real vault on the page via the VaultProvider bridge (`__engramVaultTestBridge`)
 * and the real CryptoClient Worker + real `/api/v1/vault` backend endpoint (or mocked backend
 * when running in mocked-API mode).
 */
async function createAndUnlockVaultViaBridge(page: Page, passphrase = INITIAL_VAULT_PASSPHRASE) {
  await page.waitForFunction(
    () => '__engramVaultTestBridge' in window,
    undefined,
    { timeout: 20_000 },
  );

  await page.evaluate(async (pp) => {
    const win = window as unknown as {
      __engramVaultTestBridge: {
        beginOp: () => { opGeneration: number };
        createVault: (params: {
          passphrase: string;
          opGeneration: number;
          skipRecoveryKeys?: boolean;
        }) => Promise<{
          kdf: {
            alg: 'argon2id13';
            ops: number;
            mem: number;
            parallelism: 1;
            salt: string;
          };
          vault_key_id: string;
          vault_key_wrapped_by_kek: string;
          x25519_public: string;
          ed25519_public: string;
          private_keys_wrapped: string;
          recovery_keys: Array<{
            slot: number;
            display: string;
            lookup_hash: string;
            wrap: string;
          }>;
        }>;
        reloadVaultMeta: () => Promise<unknown>;
      };
    };

    const bridge = win.__engramVaultTestBridge;
    const { opGeneration } = bridge.beginOp();
    const created = await bridge.createVault({
      passphrase: pp,
      opGeneration,
    });

    // Read CSRF cookie for POST /api/v1/vault
    let csrf: string | null = null;
    for (const part of document.cookie.split(';')) {
      const trimmed = part.trim();
      if (trimmed.startsWith('sabk_csrf=')) {
        csrf = decodeURIComponent(trimmed.slice('sabk_csrf='.length));
        break;
      }
    }

    const res = await fetch('/api/v1/vault', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      },
      body: JSON.stringify({
        vault_key_id: created.vault_key_id,
        kdf: created.kdf,
        vault_key_wrapped_by_kek: created.vault_key_wrapped_by_kek,
        x25519_public: created.x25519_public,
        ed25519_public: created.ed25519_public,
        private_keys_wrapped: created.private_keys_wrapped,
        recovery_keys: created.recovery_keys.map((rk) => ({
          slot: rk.slot,
          lookup_hash: rk.lookup_hash,
          wrap: rk.wrap,
        })),
      }),
    });
    if (!res.ok && res.status !== 409) {
      throw new Error(`POST /api/v1/vault failed with status ${res.status}`);
    }

    // Refresh /auth/me + /vault metadata
    await bridge.reloadVaultMeta();
  }, passphrase);
}

/**
 * Unlocks an existing vault on the page via the real CryptoClient Worker using the current GET /vault metadata.
 */
async function unlockExistingVaultViaBridge(page: Page, passphrase: string) {
  await page.waitForFunction(
    () => '__engramVaultTestBridge' in window,
    undefined,
    { timeout: 20_000 },
  );

  await page.evaluate(async (pp) => {
    const win = window as unknown as {
      __engramVaultTestBridge: {
        beginOp: () => { opGeneration: number };
        reloadVaultMeta: () => Promise<{
          kdf: {
            alg: 'argon2id13';
            ops: number;
            mem: number;
            parallelism: 1;
            salt: string;
          };
          vault_key_wrapped_by_kek: string;
          private_keys_wrapped: string;
        } | null>;
        unlockPassphrase: (params: {
          passphrase: string;
          kdf: {
            alg: 'argon2id13';
            ops: number;
            mem: number;
            parallelism: 1;
            salt: string;
          };
          vaultKeyWrappedByKek: string;
          privateKeysWrapped: string;
          opGeneration: number;
        }) => Promise<unknown>;
      };
    };

    const bridge = win.__engramVaultTestBridge;
    const { opGeneration } = bridge.beginOp();
    const meta = await bridge.reloadVaultMeta();
    if (!meta) {
      throw new Error('Expected GET /api/v1/vault metadata to exist');
    }
    await bridge.unlockPassphrase({
      passphrase: pp,
      kdf: meta.kdf,
      vaultKeyWrappedByKek: meta.vault_key_wrapped_by_kek,
      privateKeysWrapped: meta.private_keys_wrapped,
      opGeneration,
    });
  }, passphrase);
}

/**
 * Installs stateful in-memory `/api/v1/*` route handlers when running without an external backend
 * (`E2E_API_URL` not set), while exercising the real browser CryptoClient Worker (`Argon2id 64 MiB`).
 */
async function installStatefulVaultSettingsMocksIfNoBackend(context: BrowserContext) {
  if (process.env.E2E_API_URL) {
    return { isMocked: false };
  }

  let vaultPresent = true;
  let currentVersion = 1;
  let currentKdf = { ...TEST_VECTOR_KDF };
  let currentWrappedVk = TEST_VECTOR_WRAPPED_VK;
  const currentWrappedPriv = TEST_VECTOR_WRAPPED_PRIV;
  const currentVaultKeyId = TEST_VECTOR_VAULT_KEY_ID;
  let remainingRk = 8;
  let emptySlots = [9, 10];

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
        oauth_providers: ['google'],
        email_verification_required: false,
        captcha_site_key: null,
        hibp_enabled: false,
      }),
    });
  });

  await context.route('**/api/v1/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: '11111111-2222-3333-4444-555555555555',
          email: 'vaultsettings-e2e@example.com',
          email_verified: true,
          locale: 'vi',
          theme: 'light',
          auto_lock_minutes: 15,
          semantic_suggest: true,
          created_at: '2026-10-29T00:00:00Z',
        },
        identities: [{ provider: 'password', created_at: '2026-10-29T00:00:00Z' }],
        session: {
          id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          created_at: '2026-10-29T00:00:00Z',
          last_seen_at: '2026-10-29T00:00:00Z',
        },
        features: {
          semantic_available: false,
          email_verification_required: false,
          oauth_providers: ['google'],
          oauth_reauth_providers: [],
          password_enrollment_available: false,
          captcha_site_key: null,
        },
        vault: {
          status: vaultPresent ? 'present' : 'absent',
        },
      }),
    });
  });

  await context.route('**/api/v1/auth/reauth', async (route) => {
    const reqBody = route.request().postDataJSON() as { action?: string };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        grant: `grant-${reqBody?.action ?? 'vault'}-${Date.now()}`,
        action: reqBody?.action ?? 'vault.rewrap',
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      }),
    });
  });

  await context.route('**/api/v1/vault/kek', async (route) => {
    const reqBody = route.request().postDataJSON() as {
      kdf: typeof TEST_VECTOR_KDF;
      vault_key_wrapped_by_kek: string;
    };
    currentKdf = reqBody.kdf;
    currentWrappedVk = reqBody.vault_key_wrapped_by_kek;
    currentVersion += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ vault_key_id: currentVaultKeyId, version: currentVersion }),
    });
  });

  await context.route('**/api/v1/vault/recovery-keys/regenerate', async (route) => {
    currentVersion += 1;
    remainingRk = 10;
    emptySlots = [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ remaining: 10, version: currentVersion }),
    });
  });

  await context.route('**/api/v1/vault/recovery-keys/rotate', async (route) => {
    currentVersion += 1;
    remainingRk = 10;
    emptySlots = [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ remaining: 10, version: currentVersion }),
    });
  });

  await context.route('**/api/v1/vault/recovery-keys', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        remaining: remainingRk,
        slots: 10,
        empty_slots: emptySlots,
      }),
    });
  });

  await context.route('**/api/v1/vault', async (route) => {
    const method = route.request().method().toUpperCase();
    if (method === 'DELETE') {
      vaultPresent = false;
      await route.fulfill({ status: 204 });
      return;
    }
    if (!vaultPresent) {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'https://key.zone17th.click/problems/vault_absent',
          title: 'Vault not found',
          status: 404,
          code: 'vault_absent',
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        vault_key_id: currentVaultKeyId,
        version: currentVersion,
        kdf: currentKdf,
        vault_key_wrapped_by_kek: currentWrappedVk,
        x25519_public: 'EIT5fcwxJb3Sw8y-V9yHL-JGU5pDVlgw9H5ueCV7OnI',
        ed25519_public: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
        private_keys_wrapped: currentWrappedPriv,
        recovery_keys_remaining: remainingRk,
        passkeys: [],
      }),
    });
  });

  await context.route('**/api/v1/auth/sessions**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            created_at: '2026-10-29T00:00:00Z',
            last_seen_at: '2026-10-29T00:00:00Z',
            ip_prefix: '127.0.0.1/32',
            user_agent_summary: 'Chromium',
            current: true,
          },
        ],
      }),
    });
  });

  await context.route('**/api/v1/auth/audit**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    });
  });

  await context.route('**/api/v1/me/notifications**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    });
  });

  return { isMocked: true };
}

test.describe('P03-T20A Vault Security Settings E2E (Change Passphrase, Recovery Keys, Reset Vault)', () => {
  test('cancel re-auth -> no request (Change Passphrase, Rotate Recovery Keys, and Reset Vault)', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const context = await newContext(browser);
    const { isMocked } = await installStatefulVaultSettingsMocksIfNoBackend(context);
    const page = await context.newPage();

    if (!isMocked) {
      const email = uniqueEmail('vaultsettings-cancel');
      await signupViaUi(page, email, PASSWORD);
      if (verifyRequired()) {
        const mail = await waitForMail(email, 'verify_email');
        await confirmEmailToken(page, tokenFromLink(mail.link));
      }
      await page.goto('/app/settings');
      await createAndUnlockVaultViaBridge(page, INITIAL_VAULT_PASSPHRASE);
      await page.reload();
      await unlockExistingVaultViaBridge(page, INITIAL_VAULT_PASSPHRASE);
    } else {
      await page.goto('/app/settings');
      await unlockExistingVaultViaBridge(page, INITIAL_VAULT_PASSPHRASE);
    }

    await expect(page.locator('.vault-pill')).toHaveClass(/vault-open/);
    await expect(page.getByTestId('vault-security-section')).toBeVisible();

    const apiMutationRequests: Array<{ method: string; url: string }> = [];
    page.on('request', (req) => {
      const method = req.method().toUpperCase();
      const url = req.url();
      if (
        url.includes('/api/v1/auth/reauth') ||
        (url.includes('/api/v1/vault/kek') && method === 'PUT') ||
        (url.includes('/api/v1/vault/recovery-keys/') && method === 'POST') ||
        (url.includes('/api/v1/vault') && method === 'DELETE')
      ) {
        apiMutationRequests.push({ method, url });
      }
    });

    // 1. Open Change Passphrase dialog and cancel -> zero requests
    await page.locator('[data-open-dialog="passDlg"]').click();
    const passDialog = page.getByRole('dialog');
    await expect(passDialog).toBeVisible();
    await passDialog.getByRole('button', { name: /Cancel|Huỷ/ }).click();
    await expect(passDialog).toBeHidden();

    // 2. Open Rotate Recovery Keys dialog and cancel -> zero requests
    await page.locator('[data-open-dialog="rotateDlg"]').click();
    const rkDialog = page.getByRole('dialog');
    await expect(rkDialog).toBeVisible();
    await rkDialog.getByRole('button', { name: /Cancel|Huỷ/ }).click();
    await expect(rkDialog).toBeHidden();

    // 3. Open Reset Vault dialog, advance to step 3 re-auth, and close/cancel -> zero requests
    await page.locator('[data-open-dialog="resetDlg"]').click();
    const resetDialog = page.getByRole('dialog');
    await expect(resetDialog).toBeVisible();
    await resetDialog
      .getByRole('button', { name: /None of these work|Không đường nào dùng được/ })
      .click();
    await resetDialog
      .getByRole('button', { name: /Checked backups|Đã kiểm tra backup/ })
      .click();
    await expect(resetDialog.locator('[data-view="rst-s3"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(resetDialog).toBeHidden();

    expect(apiMutationRequests).toHaveLength(0);
    await context.close();
  });

  test('two pages — rewrap in Page A -> Page B reloads the new version; old passphrase fails with AEAD_DECRYPT_FAILED; Rotate all 10 RKs shows once & wipes from DOM', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const context = await newContext(browser);
    const { isMocked } = await installStatefulVaultSettingsMocksIfNoBackend(context);
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    if (!isMocked) {
      const email = uniqueEmail('vaultsettings-rewrap');
      await signupViaUi(pageA, email, PASSWORD);
      if (verifyRequired()) {
        const mail = await waitForMail(email, 'verify_email');
        await confirmEmailToken(pageA, tokenFromLink(mail.link));
      }
      await pageA.goto('/app/settings');
      await createAndUnlockVaultViaBridge(pageA, INITIAL_VAULT_PASSPHRASE);
      await pageA.reload();
      await unlockExistingVaultViaBridge(pageA, INITIAL_VAULT_PASSPHRASE);
    } else {
      await pageA.goto('/app/settings');
      await unlockExistingVaultViaBridge(pageA, INITIAL_VAULT_PASSPHRASE);
    }

    await pageB.goto('/app/settings');
    await unlockExistingVaultViaBridge(pageB, INITIAL_VAULT_PASSPHRASE);

    await expect(pageA.locator('.vault-pill')).toHaveClass(/vault-open/);
    await expect(pageB.locator('.vault-pill')).toHaveClass(/vault-open/);

    const initialPageBVersion = await pageB.evaluate(() => {
      const win = window as unknown as {
        __engramVaultTestBridge?: { vaultMeta?: { version: number } | null };
      };
      return win.__engramVaultTestBridge?.vaultMeta?.version ?? null;
    });
    expect(initialPageBVersion).toBe(1);

    // 1. Change Passphrase (rewrap) in Page A: does NOT ask for old passphrase;
    //    re-authenticates login password -> Worker rewrap -> PUT /vault/kek;
    //    Page B receives vault_changed over BroadcastChannel and reloads version 2.
    await pageA.locator('[data-open-dialog="passDlg"]').click();
    const passDialog = pageA.getByRole('dialog');
    await expect(passDialog).toBeVisible();
    await expect(passDialog.getByLabel(/Old passphrase|Passphrase cũ/i)).toHaveCount(0);

    await passDialog.locator('#pass-login-pwd').fill(PASSWORD);
    await passDialog.locator('#pass-new-pp').fill(UPDATED_VAULT_PASSPHRASE);
    await passDialog.locator('#pass-confirm-pp').fill(UPDATED_VAULT_PASSPHRASE);
    await passDialog.getByRole('button', { name: /Change passphrase|Đổi passphrase/ }).click();

    await expect(passDialog).toBeHidden({ timeout: 30_000 });

    // Verify Page B reloaded GET /api/v1/vault and updated its version to 2 while remaining unlocked
    await expect
      .poll(
        async () =>
          pageB.evaluate(() => {
            const win = window as unknown as {
              __engramVaultTestBridge?: {
                vaultMeta?: { version: number } | null;
                workerState?: string;
              };
            };
            return {
              version: win.__engramVaultTestBridge?.vaultMeta?.version ?? null,
              workerState: win.__engramVaultTestBridge?.workerState ?? null,
            };
          }),
        { timeout: 15_000 },
      )
      .toEqual({ version: 2, workerState: 'unlocked' });

    // Lock vault in Page A and verify old passphrase fails with AEAD_DECRYPT_FAILED while new passphrase unlocks
    await pageA.getByTestId('vault-lock-button').click();
    await expect(pageA.locator('.vault-pill')).toHaveClass(/vault-shut/);
    await expect(pageB.locator('.vault-pill')).toHaveClass(/vault-shut/);

    const oldUnlockError = await pageA.evaluate(async (oldPp) => {
      const win = window as unknown as {
        __engramVaultTestBridge: {
          beginOp: () => { opGeneration: number };
          reloadVaultMeta: () => Promise<{
            kdf: {
              alg: 'argon2id13';
              ops: number;
              mem: number;
              parallelism: 1;
              salt: string;
            };
            vault_key_wrapped_by_kek: string;
            private_keys_wrapped: string;
          } | null>;
          unlockPassphrase: (params: unknown) => Promise<unknown>;
        };
      };
      const bridge = win.__engramVaultTestBridge;
      const { opGeneration } = bridge.beginOp();
      const meta = await bridge.reloadVaultMeta();
      try {
        await bridge.unlockPassphrase({
          passphrase: oldPp,
          kdf: meta!.kdf,
          vaultKeyWrappedByKek: meta!.vault_key_wrapped_by_kek,
          privateKeysWrapped: meta!.private_keys_wrapped,
          opGeneration,
        });
        return null;
      } catch (err) {
        if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
          return err.code;
        }
        return 'ERROR';
      }
    }, INITIAL_VAULT_PASSPHRASE);
    expect(oldUnlockError).toBe('AEAD_DECRYPT_FAILED');

    await unlockExistingVaultViaBridge(pageA, UPDATED_VAULT_PASSPHRASE);
    await unlockExistingVaultViaBridge(pageB, UPDATED_VAULT_PASSPHRASE);
    await expect(pageA.locator('.vault-pill')).toHaveClass(/vault-open/);
    await expect(pageB.locator('.vault-pill')).toHaveClass(/vault-open/);

    // 2. Rotate all 10 recovery keys in Page A -> display 10 keys once -> ack + save -> keys wiped from DOM; Page B reloads version 3
    await pageA.locator('[data-open-dialog="rotateDlg"]').click();
    const rkDialog = pageA.getByRole('dialog');
    await expect(rkDialog).toBeVisible();

    await rkDialog.locator('#rot-reauth-pwd').fill(PASSWORD);
    await rkDialog.getByRole('button', { name: /Continue|Tiếp tục/ }).click();

    await expect(
      rkDialog.locator('[data-testid="recovery-key-grid"], [data-testid="recovery-keys-grid"]'),
    ).toBeVisible({ timeout: 20_000 });
    await expect(rkDialog.getByRole('listitem')).toHaveCount(10);

    await rkDialog.getByRole('checkbox').check();
    await rkDialog.locator('#rkRotateConfirmBtn').click();

    await expect(rkDialog).toBeHidden({ timeout: 20_000 });
    await expect(pageA.getByTestId('recovery-keys-remaining-badge')).toContainText('10');
    await expect(pageA.locator('body')).not.toHaveText(/rk\d+_[0-9A-Z]{4}-[0-9A-Z]{4}/);

    await expect
      .poll(
        async () =>
          pageB.evaluate(() => {
            const win = window as unknown as {
              __engramVaultTestBridge?: { vaultMeta?: { version: number } | null };
            };
            return win.__engramVaultTestBridge?.vaultMeta?.version ?? null;
          }),
        { timeout: 15_000 },
      )
      .toBe(3);

    await context.close();
  });

  test('two pages — reset in Page A -> Page B locked and Page A transitions to absent', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const context = await newContext(browser);
    const { isMocked } = await installStatefulVaultSettingsMocksIfNoBackend(context);
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    if (!isMocked) {
      const email = uniqueEmail('vaultsettings-reset');
      await signupViaUi(pageA, email, PASSWORD);
      if (verifyRequired()) {
        const mail = await waitForMail(email, 'verify_email');
        await confirmEmailToken(pageA, tokenFromLink(mail.link));
      }
      await pageA.goto('/app/settings');
      await createAndUnlockVaultViaBridge(pageA, INITIAL_VAULT_PASSPHRASE);
      await pageA.reload();
      await unlockExistingVaultViaBridge(pageA, INITIAL_VAULT_PASSPHRASE);
    } else {
      await pageA.goto('/app/settings');
      await unlockExistingVaultViaBridge(pageA, INITIAL_VAULT_PASSPHRASE);
    }

    await pageB.goto('/app/settings');
    await unlockExistingVaultViaBridge(pageB, INITIAL_VAULT_PASSPHRASE);

    await expect(pageA.locator('.vault-pill')).toHaveClass(/vault-open/);
    await expect(pageB.locator('.vault-pill')).toHaveClass(/vault-open/);

    // Reset Vault in Page A -> Page B immediately locks and clears vaultMeta; Page A transitions to absent (`Chưa tạo kho`)
    await pageA.locator('[data-open-dialog="resetDlg"]').click();
    const resetDialog = pageA.getByRole('dialog');
    await expect(resetDialog).toBeVisible();

    await resetDialog
      .getByRole('button', { name: /None of these work|Không đường nào dùng được/ })
      .click();
    await resetDialog
      .getByRole('button', { name: /Checked backups|Đã kiểm tra backup/ })
      .click();

    await resetDialog.locator('#rst-reauth-pwd').fill(PASSWORD);
    await resetDialog.getByRole('button', { name: /Continue|Tiếp tục/ }).click();

    const confirmInput = resetDialog.locator('#rst-confirm-word');
    const resetSubmitBtn = resetDialog.locator('#rstConfirmBtn');
    await expect(resetSubmitBtn).toBeDisabled();

    // Lowercase 'reset' keeps button disabled
    await confirmInput.fill('reset');
    await expect(resetSubmitBtn).toBeDisabled();

    // Exact uppercase 'RESET' enables submit
    await confirmInput.fill('RESET');
    await expect(resetSubmitBtn).toBeEnabled();
    await resetSubmitBtn.click();

    // Step 5 Done view appears in Page A and header pill transitions to absent (`Chưa tạo kho`)
    await expect(resetDialog.locator('[data-view="rst-s5"]')).toBeVisible({ timeout: 20_000 });
    await expect(
      resetDialog.getByRole('link', { name: /Create new vault|Tạo vault mới/ }),
    ).toHaveAttribute('href', '/app/onboarding');
    await expect(pageA.locator('.vault-pill')).toContainText(/Chưa tạo kho/);

    // Verify Page B locked immediately on receiving `vault_changed { version: null }`
    await expect
      .poll(
        async () =>
          pageB.evaluate(() => {
            const win = window as unknown as {
              __engramVaultTestBridge?: {
                workerState?: string;
                vaultMeta?: unknown;
              };
            };
            return {
              workerState: win.__engramVaultTestBridge?.workerState ?? null,
              vaultMeta: win.__engramVaultTestBridge?.vaultMeta ?? null,
            };
          }),
        { timeout: 15_000 },
      )
      .toEqual({ workerState: 'locked', vaultMeta: null });
    await expect(pageB.locator('.vault-pill')).toHaveClass(/vault-shut/);

    await context.close();
  });
});
