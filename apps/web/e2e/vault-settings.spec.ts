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
import { fillSecret } from './vault-settings-secret';

const INITIAL_VAULT_PASSPHRASE = 'correct-horse-battery-staple-gn-v1';
const UPDATED_VAULT_PASSPHRASE = 'updated-horse-battery-staple-gn-v2!';

const STEP_TIMEOUT = 15_000;
const CRYPTO_STEP_TIMEOUT = 30_000;

function logStep(testLabel: string, stepName: string) {
  console.log(`[vault-settings][${testLabel}] ${stepName}`);
}

async function confirmEmailToken(page: Page, token: string) {
  await page.goto(`/app/auth/verify-email?token=${encodeURIComponent(token)}`, {
    waitUntil: 'domcontentloaded',
    timeout: STEP_TIMEOUT,
  });
  const respPromise = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/api/v1/auth/verify-email/confirm'),
    { timeout: STEP_TIMEOUT },
  );
  await page
    .getByRole('button', { name: /Confirm|Xác nhận email/ })
    .click({ timeout: STEP_TIMEOUT });
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
    { timeout: STEP_TIMEOUT },
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
    const testLabel = 'cancel-reauth';
    const context = await newContext(browser);
    try {
      const page = await context.newPage();

      logStep(testLabel, 'signup');
      const email = uniqueEmail('vaultsettings-cancel');
      await signupViaUi(page, email, PASSWORD);
      if (verifyRequired()) {
        logStep(testLabel, 'verify-email');
        const mail = await waitForMail(email, 'verify_email');
        await confirmEmailToken(page, tokenFromLink(mail.link));
      }

      logStep(testLabel, 'goto-settings-and-create-vault');
      await page.goto('/app/settings', {
        waitUntil: 'domcontentloaded',
        timeout: STEP_TIMEOUT,
      });
      await createAndUnlockVaultViaBridge(page, INITIAL_VAULT_PASSPHRASE);

      logStep(testLabel, 'reload-and-unlock');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT });
      await unlockExistingVaultViaBridge(page, INITIAL_VAULT_PASSPHRASE);

      await expect(page.locator('.vault-pill')).toHaveClass(/vault-open/, {
        timeout: STEP_TIMEOUT,
      });
      await expect(page.getByTestId('vault-security-section')).toBeVisible({
        timeout: STEP_TIMEOUT,
      });

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
      logStep(testLabel, 'cancel-change-passphrase');
      await page.locator('[data-open-dialog="passDlg"]').click({ timeout: STEP_TIMEOUT });
      const passDialog = page.getByRole('dialog');
      await expect(passDialog).toBeVisible({ timeout: STEP_TIMEOUT });
      await passDialog
        .getByRole('button', { name: /Cancel|Huỷ/ })
        .click({ timeout: STEP_TIMEOUT });
      await expect(passDialog).toBeHidden({ timeout: STEP_TIMEOUT });

      // 2. Open Rotate Recovery Keys dialog and cancel -> zero requests
      logStep(testLabel, 'cancel-rotate-recovery-keys');
      await page.locator('[data-open-dialog="rotateDlg"]').click({ timeout: STEP_TIMEOUT });
      const rkDialog = page.getByRole('dialog');
      await expect(rkDialog).toBeVisible({ timeout: STEP_TIMEOUT });
      await rkDialog
        .getByRole('button', { name: /Cancel|Huỷ/ })
        .click({ timeout: STEP_TIMEOUT });
      await expect(rkDialog).toBeHidden({ timeout: STEP_TIMEOUT });

      // 3. Open Reset Vault dialog, advance to step 3 re-auth, and close/cancel -> zero requests
      logStep(testLabel, 'cancel-reset-vault');
      await page.locator('[data-open-dialog="resetDlg"]').click({ timeout: STEP_TIMEOUT });
      const resetDialog = page.getByRole('dialog');
      await expect(resetDialog).toBeVisible({ timeout: STEP_TIMEOUT });
      await resetDialog
        .getByRole('button', { name: /None of these work|Không đường nào dùng được/ })
        .click({ timeout: STEP_TIMEOUT });
      await resetDialog
        .getByRole('button', { name: /Checked backups|Đã kiểm tra backup/ })
        .click({ timeout: STEP_TIMEOUT });
      await expect(resetDialog.locator('[data-view="rst-s3"]')).toBeVisible({
        timeout: STEP_TIMEOUT,
      });
      await page.keyboard.press('Escape');
      await expect(resetDialog).toBeHidden({ timeout: STEP_TIMEOUT });

      expect(apiMutationRequests).toHaveLength(0);
      logStep(testLabel, 'done');
    } finally {
      await context.close();
    }
  });

  test('two pages — rewrap in Page A -> Page B reloads the new version; old passphrase fails with AEAD_DECRYPT_FAILED; Rotate all 10 RKs shows once & wipes from DOM', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const testLabel = 'two-pages-rewrap-rotate';
    const context = await newContext(browser);
    try {
      const pageA = await context.newPage();
      const pageB = await context.newPage();

      logStep(testLabel, 'signup');
      const email = uniqueEmail('vaultsettings-rewrap');
      await signupViaUi(pageA, email, PASSWORD);
      if (verifyRequired()) {
        logStep(testLabel, 'verify-email');
        const mail = await waitForMail(email, 'verify_email');
        await confirmEmailToken(pageA, tokenFromLink(mail.link));
      }

      logStep(testLabel, 'pageA-create-and-unlock');
      await pageA.goto('/app/settings', {
        waitUntil: 'domcontentloaded',
        timeout: STEP_TIMEOUT,
      });
      await createAndUnlockVaultViaBridge(pageA, INITIAL_VAULT_PASSPHRASE);
      await pageA.reload({ waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT });
      await unlockExistingVaultViaBridge(pageA, INITIAL_VAULT_PASSPHRASE);

      logStep(testLabel, 'pageB-goto-and-unlock');
      await pageB.goto('/app/settings', {
        waitUntil: 'domcontentloaded',
        timeout: STEP_TIMEOUT,
      });
      await unlockExistingVaultViaBridge(pageB, INITIAL_VAULT_PASSPHRASE);

      await expect(pageA.locator('.vault-pill')).toHaveClass(/vault-open/, {
        timeout: STEP_TIMEOUT,
      });
      await expect(pageB.locator('.vault-pill')).toHaveClass(/vault-open/, {
        timeout: STEP_TIMEOUT,
      });

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
      logStep(testLabel, 'pageA-change-passphrase');
      await pageA.locator('[data-open-dialog="passDlg"]').click({ timeout: STEP_TIMEOUT });
      const passDialog = pageA.getByRole('dialog');
      await expect(passDialog).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(passDialog.getByLabel(/Old passphrase|Passphrase cũ/i)).toHaveCount(0);

      await fillSecret(passDialog.locator('#pass-login-pwd'), PASSWORD, STEP_TIMEOUT);
      await fillSecret(passDialog.locator('#pass-new-pp'), UPDATED_VAULT_PASSPHRASE, STEP_TIMEOUT);
      await fillSecret(
        passDialog.locator('#pass-confirm-pp'),
        UPDATED_VAULT_PASSPHRASE,
        STEP_TIMEOUT,
      );
      await passDialog
        .getByRole('button', { name: /Change passphrase|Đổi passphrase/ })
        .click({ timeout: STEP_TIMEOUT });

      await expect(passDialog.locator('[data-view="pass-done"]')).toBeVisible({
        timeout: CRYPTO_STEP_TIMEOUT,
      });
      await passDialog
        .getByRole('button', { name: /Done|Xong/ })
        .click({ timeout: STEP_TIMEOUT });
      await expect(passDialog).toBeHidden({ timeout: STEP_TIMEOUT });

      // Verify Page B reloaded GET /api/v1/vault and updated its version to 2 while remaining unlocked
      logStep(testLabel, 'pageB-poll-version-2');
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
          { timeout: STEP_TIMEOUT },
        )
        .toEqual({ version: 2, workerState: 'unlocked' });

      // Lock vault in Page A and verify old passphrase fails with AEAD_DECRYPT_FAILED while new passphrase unlocks
      logStep(testLabel, 'lock-and-verify-old-passphrase-fails');
      await pageA.getByTestId('vault-lock-button').click({ timeout: STEP_TIMEOUT });
      await expect(pageA.locator('.vault-pill')).toHaveClass(/vault-shut/, {
        timeout: STEP_TIMEOUT,
      });
      await expect(pageB.locator('.vault-pill')).toHaveClass(/vault-shut/, {
        timeout: STEP_TIMEOUT,
      });

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

      logStep(testLabel, 'unlock-both-with-updated-passphrase');
      await unlockExistingVaultViaBridge(pageA, UPDATED_VAULT_PASSPHRASE);
      await unlockExistingVaultViaBridge(pageB, UPDATED_VAULT_PASSPHRASE);
      await expect(pageA.locator('.vault-pill')).toHaveClass(/vault-open/, {
        timeout: STEP_TIMEOUT,
      });
      await expect(pageB.locator('.vault-pill')).toHaveClass(/vault-open/, {
        timeout: STEP_TIMEOUT,
      });

      // 2. Rotate all 10 recovery keys in Page A -> display 10 keys once -> ack + save -> keys wiped from DOM; Page B reloads version 3
      logStep(testLabel, 'pageA-rotate-recovery-keys');
      await pageA.locator('[data-open-dialog="rotateDlg"]').click({ timeout: STEP_TIMEOUT });
      const rkDialog = pageA.getByRole('dialog');
      await expect(rkDialog).toBeVisible({ timeout: STEP_TIMEOUT });

      await fillSecret(rkDialog.locator('#rot-reauth-pwd'), PASSWORD, STEP_TIMEOUT);
      await rkDialog
        .getByRole('button', { name: /Continue|Tiếp tục/ })
        .click({ timeout: STEP_TIMEOUT });

      await expect(rkDialog.getByTestId('recovery-keys-grid')).toBeVisible({
        timeout: CRYPTO_STEP_TIMEOUT,
      });
      await expect(rkDialog.getByRole('listitem')).toHaveCount(10, {
        timeout: STEP_TIMEOUT,
      });

      await rkDialog.getByRole('checkbox').check({ timeout: STEP_TIMEOUT });
      await rkDialog.locator('#rkRotateConfirmBtn').click({ timeout: STEP_TIMEOUT });

      await expect(rkDialog).toBeHidden({ timeout: CRYPTO_STEP_TIMEOUT });
      await expect(pageA.getByTestId('recovery-keys-remaining-badge')).toContainText('10', {
        timeout: STEP_TIMEOUT,
      });
      // R3-5: Use boolean evaluate instead of `not.toHaveText` on `body` so a failure never prints RK text to the CI log
      await expect
        .poll(
          async () =>
            pageA.evaluate(() =>
              /rk\d+_[0-9A-Z]{4}-[0-9A-Z]{4}/.test(document.body.innerText),
            ),
          { timeout: STEP_TIMEOUT },
        )
        .toBe(false);

      logStep(testLabel, 'pageB-poll-version-3');
      await expect
        .poll(
          async () =>
            pageB.evaluate(() => {
              const win = window as unknown as {
                __engramVaultTestBridge?: { vaultMeta?: { version: number } | null };
              };
              return win.__engramVaultTestBridge?.vaultMeta?.version ?? null;
            }),
          { timeout: STEP_TIMEOUT },
        )
        .toBe(3);

      logStep(testLabel, 'done');
    } finally {
      await context.close();
    }
  });

  test('two pages — reset in Page A -> Page B locked and Page A transitions to absent', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const testLabel = 'two-pages-reset';
    const context = await newContext(browser);
    try {
      const pageA = await context.newPage();
      const pageB = await context.newPage();

      logStep(testLabel, 'signup');
      const email = uniqueEmail('vaultsettings-reset');
      await signupViaUi(pageA, email, PASSWORD);
      if (verifyRequired()) {
        logStep(testLabel, 'verify-email');
        const mail = await waitForMail(email, 'verify_email');
        await confirmEmailToken(pageA, tokenFromLink(mail.link));
      }

      logStep(testLabel, 'pageA-create-and-unlock');
      await pageA.goto('/app/settings', {
        waitUntil: 'domcontentloaded',
        timeout: STEP_TIMEOUT,
      });
      await createAndUnlockVaultViaBridge(pageA, INITIAL_VAULT_PASSPHRASE);
      await pageA.reload({ waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT });
      await unlockExistingVaultViaBridge(pageA, INITIAL_VAULT_PASSPHRASE);

      logStep(testLabel, 'pageB-goto-and-unlock');
      await pageB.goto('/app/settings', {
        waitUntil: 'domcontentloaded',
        timeout: STEP_TIMEOUT,
      });
      await unlockExistingVaultViaBridge(pageB, INITIAL_VAULT_PASSPHRASE);

      await expect(pageA.locator('.vault-pill')).toHaveClass(/vault-open/, {
        timeout: STEP_TIMEOUT,
      });
      await expect(pageB.locator('.vault-pill')).toHaveClass(/vault-open/, {
        timeout: STEP_TIMEOUT,
      });

      // Reset Vault in Page A -> Page B immediately locks, clears vaultMeta, and transitions to absent (`no_vault`)
      logStep(testLabel, 'pageA-open-reset-dialog');
      await pageA.locator('[data-open-dialog="resetDlg"]').click({ timeout: STEP_TIMEOUT });
      const resetDialog = pageA.getByRole('dialog');
      await expect(resetDialog).toBeVisible({ timeout: STEP_TIMEOUT });

      await resetDialog
        .getByRole('button', { name: /None of these work|Không đường nào dùng được/ })
        .click({ timeout: STEP_TIMEOUT });
      await resetDialog
        .getByRole('button', { name: /Checked backups|Đã kiểm tra backup/ })
        .click({ timeout: STEP_TIMEOUT });

      logStep(testLabel, 'pageA-reset-reauth');
      await fillSecret(resetDialog.locator('#rst-reauth-pwd'), PASSWORD, STEP_TIMEOUT);
      await resetDialog
        .getByRole('button', { name: /Continue|Tiếp tục/ })
        .click({ timeout: STEP_TIMEOUT });

      const confirmInput = resetDialog.locator('#rst-confirm-word');
      const resetSubmitBtn = resetDialog.locator('#rstConfirmBtn');
      await expect(resetSubmitBtn).toBeDisabled({ timeout: STEP_TIMEOUT });

      // Lowercase 'reset' keeps button disabled
      await confirmInput.fill('reset', { timeout: STEP_TIMEOUT });
      await expect(resetSubmitBtn).toBeDisabled({ timeout: STEP_TIMEOUT });

      // Exact uppercase 'RESET' enables submit
      logStep(testLabel, 'pageA-submit-reset');
      await confirmInput.fill('RESET', { timeout: STEP_TIMEOUT });
      await expect(resetSubmitBtn).toBeEnabled({ timeout: STEP_TIMEOUT });
      await resetSubmitBtn.click({ timeout: STEP_TIMEOUT });

      // Step 5 Done view appears in Page A and header pill transitions to absent (`Chưa tạo kho` / `No vault yet`)
      logStep(testLabel, 'pageA-verify-rst-s5-done');
      await expect(resetDialog.locator('[data-view="rst-s5"]')).toBeVisible({
        timeout: CRYPTO_STEP_TIMEOUT,
      });
      await expect(
        resetDialog.getByRole('link', { name: /Create new vault|Tạo vault mới/ }),
      ).toHaveAttribute('href', '/app/onboarding', { timeout: STEP_TIMEOUT });
      await expect(pageA.locator('.vault-pill')).toContainText(/Chưa tạo kho|No vault yet/, {
        timeout: STEP_TIMEOUT,
      });

      // Verify Page B locked immediately on receiving `vault_changed { version: null }` and transitioned to `no_vault`
      logStep(testLabel, 'pageB-verify-absent-locked');
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
          { timeout: STEP_TIMEOUT },
        )
        .toEqual({ state: 'no_vault', workerState: 'locked', vaultMeta: null });
      await expect(pageB.getByTestId('vault-security-absent-banner')).toBeVisible({
        timeout: STEP_TIMEOUT,
      });
      await expect(pageB.locator('.vault-pill')).toHaveClass(/vault-shut/, {
        timeout: STEP_TIMEOUT,
      });

      logStep(testLabel, 'done');
    } finally {
      await context.close();
    }
  });
});
