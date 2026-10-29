import { expect, test, type Page } from '@playwright/test';
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

async function waitForVaultBridgeReady(page: Page) {
  await page.waitForFunction(
    () => {
      const win = window as unknown as {
        __engramVaultTestBridge?: {
          beginOp?: unknown;
          reloadVaultMeta?: unknown;
          unlockPassphrase?: unknown;
          createVault?: unknown;
        };
      };
      return typeof win.__engramVaultTestBridge?.beginOp === 'function';
    },
    undefined,
    { timeout: 20_000 },
  );
}

/**
 * Creates a real vault on the page via the VaultProvider bridge (`__engramVaultTestBridge`)
 * and the real CryptoClient Worker + real `/api/v1/vault` backend endpoint.
 */
async function createAndUnlockVaultViaBridge(page: Page, passphrase = INITIAL_VAULT_PASSPHRASE) {
  await waitForVaultBridgeReady(page);

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
  await waitForVaultBridgeReady(page);

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

test.describe('P03-T20A Vault Security Settings E2E (Change Passphrase, Recovery Keys, Reset Vault)', () => {
  test.skip(!process.env.E2E_STACK, 'requires API + worker');

  test('cancel re-auth -> no request (Change Passphrase, Rotate Recovery Keys, and Reset Vault)', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const context = await newContext(browser);
    const page = await context.newPage();

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
    const pageA = await context.newPage();
    const pageB = await context.newPage();

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

    await expect(passDialog.locator('[data-view="pass-done"]')).toBeVisible({ timeout: 30_000 });
    await passDialog.getByRole('button', { name: /Done|Xong/ }).click();
    await expect(passDialog).toBeHidden({ timeout: 10_000 });

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

    await expect(rkDialog.getByTestId('recovery-keys-grid')).toBeVisible({ timeout: 20_000 });
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
    const pageA = await context.newPage();
    const pageB = await context.newPage();

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

    await pageB.goto('/app/settings');
    await unlockExistingVaultViaBridge(pageB, INITIAL_VAULT_PASSPHRASE);

    await expect(pageA.locator('.vault-pill')).toHaveClass(/vault-open/);
    await expect(pageB.locator('.vault-pill')).toHaveClass(/vault-open/);

    // Reset Vault in Page A -> Page B immediately locks, clears vaultMeta, and transitions to absent (`no_vault`)
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

    // Step 5 Done view appears in Page A and header pill transitions to absent (`Chưa tạo kho` / `No vault yet`)
    await expect(resetDialog.locator('[data-view="rst-s5"]')).toBeVisible({ timeout: 20_000 });
    await expect(
      resetDialog.getByRole('link', { name: /Create new vault|Tạo vault mới/ }),
    ).toHaveAttribute('href', '/app/onboarding');
    await expect(pageA.locator('.vault-pill')).toContainText(/Chưa tạo kho|No vault yet/);

    // Verify Page B locked immediately on receiving `vault_changed { version: null }` and transitioned to `no_vault`
    await expect
      .poll(
        async () =>
          pageB.evaluate(() => {
            const win = window as unknown as {
              __engramVaultTestBridge?: {
                state?: string;
                workerState?: string;
                vaultMeta?: unknown;
              };
            };
            return {
              state: win.__engramVaultTestBridge?.state ?? null,
              workerState: win.__engramVaultTestBridge?.workerState ?? null,
              vaultMeta: win.__engramVaultTestBridge?.vaultMeta ?? null,
            };
          }),
        { timeout: 15_000 },
      )
      .toEqual({ state: 'no_vault', workerState: 'locked', vaultMeta: null });
    await expect(pageB.getByTestId('vault-security-absent-banner')).toBeVisible({ timeout: 15_000 });
    await expect(pageB.locator('.vault-pill')).toHaveClass(/vault-shut/);

    await context.close();
  });
});
