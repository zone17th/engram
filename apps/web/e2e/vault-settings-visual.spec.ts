import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  PASSWORD,
  expectSignedIn,
  newContext,
  patchSettingsViaPage,
  signupViaUi,
  tokenFromLink,
  uniqueEmail,
  verifyRequired,
  waitForMail,
} from './helpers';

const INITIAL_VAULT_PASSPHRASE = 'correct-horse-battery-staple-gn-v1';
const THEMES = ['light', 'dark'] as const;
const WIDTHS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const;

type Theme = (typeof THEMES)[number];
type ViewportWidth = (typeof WIDTHS)[number]['width'];

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

    await bridge.reloadVaultMeta();
  }, passphrase);
}

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

async function prepareThemeAndLocale(page: Page, theme: Theme) {
  const origin = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:3000').origin;
  await page.context().setExtraHTTPHeaders({
    'accept-language': 'vi-VN,vi;q=0.9,en;q=0.8',
  });
  await page.context().addCookies([
    { name: 'sabk_locale', value: 'vi', url: `${origin}/` },
    { name: 'sabk_theme', value: theme, url: `${origin}/` },
  ]);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
}

async function settleForCapture(page: Page, email: string, theme: Theme) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 15_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}',
  });
  await page.evaluate((accountEmail) => {
    const root = document.querySelector('main');
    if (!root) return;
    for (const element of root.querySelectorAll<HTMLElement>('*')) {
      if (element.children.length > 0) continue;
      const text = element.textContent?.trim() ?? '';
      if (text === accountEmail) element.textContent = 'visual.user@example.test';
      if (/^(Joined|Tham gia)\s/.test(text)) {
        element.textContent = text.startsWith('Tham gia') ? 'Tham gia 01/01/2026' : 'Joined 01/01/2026';
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) element.textContent = '2026-01-01';
      if (/^(Mozilla|HeadlessChrome|Chrome|Firefox|Safari)/.test(text)) {
        element.textContent = 'Visual browser';
      }
    }
  }, email);
  await page.waitForTimeout(100);
}

async function saveScreenshot(
  page: Page,
  testInfo: TestInfo,
  stateName: string,
  theme: Theme,
  width: ViewportWidth,
  options: {
    fullPage?: boolean;
    mask?: Locator[];
  } = {},
) {
  const fileName = `vault-settings-${stateName}-${theme}-${width}.png`;
  const outputPath = testInfo.outputPath(fileName);
  mkdirSync(dirname(outputPath), { recursive: true });
  const buffer = await page.screenshot({
    path: outputPath,
    fullPage: options.fullPage ?? false,
    animations: 'disabled',
    caret: 'hide',
    ...(options.mask && options.mask.length > 0 ? { mask: options.mask } : {}),
  });
  expect(buffer.byteLength).toBeGreaterThan(0);
}

test.describe('P03-T20A Vault Security Settings Visual Captures (AC VISUAL)', () => {
  test.skip(!process.env.E2E_STACK, 'requires API + worker');

  for (const theme of THEMES) {
    test(`captures vault security section and dialogs (${theme}, 390 + 1440)`, async ({
      browser,
    }, testInfo) => {
      test.setTimeout(180_000);
      const context = await newContext(browser);
      try {
        const page = await context.newPage();
        await prepareThemeAndLocale(page, theme);

        const email = uniqueEmail(`vaultsettings-visual-${theme}`);
        await signupViaUi(page, email, PASSWORD);
        if (verifyRequired()) {
          const mail = await waitForMail(email, 'verify_email');
          await confirmEmailToken(page, tokenFromLink(mail.link));
        }
        await expectSignedIn(page);
        expect((await patchSettingsViaPage(page, { locale: 'vi', theme })).status).toBe(200);
        await prepareThemeAndLocale(page, theme);
        await page.goto('/app/settings', { waitUntil: 'networkidle' });
        await createAndUnlockVaultViaBridge(page, INITIAL_VAULT_PASSPHRASE);
        await page.reload({ waitUntil: 'networkidle' });
        await unlockExistingVaultViaBridge(page, INITIAL_VAULT_PASSPHRASE);

        await expect(page.locator('.vault-pill')).toHaveClass(/vault-open/);
        await expect(page.getByTestId('vault-security-section')).toBeVisible();
        await expect(page.getByTestId('recovery-keys-remaining-badge')).toBeVisible();

        for (const viewport of WIDTHS) {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await settleForCapture(page, email, theme);

          // (a) Settings security section with the vault section (unlocked, RK count shown)
          await page.getByTestId('vault-security-section').scrollIntoViewIfNeeded();
          await page.waitForTimeout(100);
          await saveScreenshot(page, testInfo, 'section', theme, viewport.width, {
            fullPage: false,
          });

          // (b) Change-passphrase dialog (all passphrase/password inputs empty AND masked)
          await page.locator('[data-open-dialog="passDlg"]').click();
          const passDialog = page.getByRole('dialog');
          await expect(passDialog).toBeVisible();
          await expect(passDialog.locator('[data-view="pass-form"]')).toBeVisible();
          await expect(passDialog.locator('#pass-new-pp')).toHaveValue('');
          await expect(passDialog.locator('#pass-confirm-pp')).toHaveValue('');
          await settleForCapture(page, email, theme);
          await saveScreenshot(page, testInfo, 'passphrase-dialog', theme, viewport.width, {
            fullPage: false,
            mask: [
              passDialog.locator('#pass-login-pwd'),
              passDialog.locator('#pass-new-pp'),
              passDialog.locator('#pass-confirm-pp'),
            ],
          });
          await passDialog.getByRole('button', { name: /Cancel|Huỷ/ }).click();
          await expect(passDialog).toBeHidden();

          // (c) Recovery-keys dialog showing a NEW key sheet (all RK slot cells masked)
          await page.locator('[data-open-dialog="rotateDlg"]').click();
          const rkDialog = page.getByRole('dialog');
          await expect(rkDialog).toBeVisible();
          const reauthInput = rkDialog.locator('#rot-reauth-pwd');
          if (await reauthInput.isVisible()) {
            await reauthInput.fill(PASSWORD);
            await rkDialog.getByRole('button', { name: /Continue|Tiếp tục/ }).click();
          }
          const rkGrid = rkDialog.getByTestId('recovery-keys-grid');
          await expect(rkGrid).toBeVisible({ timeout: 20_000 });
          const rkCells = rkDialog.locator('[data-testid^="recovery-key-slot-"]');
          await expect(rkCells).toHaveCount(10);
          await settleForCapture(page, email, theme);
          await saveScreenshot(page, testInfo, 'rk-sheet', theme, viewport.width, {
            fullPage: false,
            mask: [rkCells, rkGrid],
          });
          await rkDialog.getByRole('button', { name: /Cancel|Huỷ/ }).click();
          await expect(rkDialog).toBeHidden();
          await expect(page.locator('body')).not.toHaveText(/rk\d+_[0-9A-Z]{4}-[0-9A-Z]{4}/);

          // (d) Reset-vault dialog (step 1 and the typed-confirmation step)
          await page.locator('[data-open-dialog="resetDlg"]').click();
          const resetDialog = page.getByRole('dialog');
          await expect(resetDialog).toBeVisible();
          await expect(resetDialog.locator('[data-view="rst-s1"]')).toBeVisible();
          await settleForCapture(page, email, theme);
          await saveScreenshot(page, testInfo, 'reset-step1', theme, viewport.width, {
            fullPage: false,
          });

          await resetDialog
            .getByRole('button', { name: /None of these work|Không đường nào dùng được/ })
            .click();
          await expect(resetDialog.locator('[data-view="rst-s2"]')).toBeVisible();
          await resetDialog
            .getByRole('button', { name: /Checked backups|Đã kiểm tra backup/ })
            .click();

          const rstReauthSection = resetDialog.locator('[data-view="rst-s3"]');
          if (await rstReauthSection.isVisible()) {
            await resetDialog.locator('#rst-reauth-pwd').fill(PASSWORD);
            await resetDialog.getByRole('button', { name: /Continue|Tiếp tục/ }).click();
          }

          await expect(resetDialog.locator('[data-view="rst-s4"]')).toBeVisible({
            timeout: 20_000,
          });
          const confirmWordInput = resetDialog.locator('#rst-confirm-word');
          await confirmWordInput.fill('ĐẶT LẠI');
          await expect(resetDialog.locator('#rstConfirmBtn')).toBeEnabled();
          await settleForCapture(page, email, theme);
          await saveScreenshot(page, testInfo, 'reset-confirm', theme, viewport.width, {
            fullPage: false,
          });

          await page.keyboard.press('Escape');
          await expect(resetDialog).toBeHidden();
        }
      } finally {
        await context.close();
      }
    });
  }
});
