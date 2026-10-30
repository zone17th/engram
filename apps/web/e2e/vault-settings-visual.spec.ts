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
import { fillSecret } from './vault-settings-secret';

const INITIAL_VAULT_PASSPHRASE = 'correct-horse-battery-staple-gn-v1';
const UPDATED_VAULT_PASSPHRASE = 'correct-horse-battery-staple-gn-v2';
const THEMES = ['light', 'dark'] as const;
const WIDTHS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const;

const STEP_TIMEOUT = 15_000;
const CRYPTO_STEP_TIMEOUT = 25_000;

type Theme = (typeof THEMES)[number];
type ViewportWidth = (typeof WIDTHS)[number]['width'];

function logStep(testLabel: string, stepName: string) {
  console.log(`[vault-settings-visual][${testLabel}] ${stepName}`);
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

async function dismissVisibleToasts(page: Page) {
  // Never use Playwright pointer clicks here: while a Radix modal Dialog is open
  // (e.g. `pass-done`), `<div class="dialog-overlay" data-state="open">` intercepts
  // pointer events and `body` has `pointer-events: none`.
  const openDialogs = page.locator('[role="dialog"]');
  if ((await openDialogs.count()) > 0) {
    return;
  }
  await page.evaluate(() => {
    for (const btn of document.querySelectorAll<HTMLButtonElement>('.toast button')) {
      btn.click();
    }
  });
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: STEP_TIMEOUT });
}

async function scrollSecurityHeadingBelowStickyHeader(page: Page) {
  await page.evaluate(() => {
    const heading =
      document.getElementById('security-heading') ??
      document.getElementById('baomat') ??
      document.querySelector('[data-testid="vault-security-section"]');
    if (!heading) return;
    const header = document.querySelector('header');
    const headerHeight = header ? header.getBoundingClientRect().height : 68;
    const rect = heading.getBoundingClientRect();
    const targetTop = Math.max(0, window.scrollY + rect.top - headerHeight - 16);
    window.scrollTo({ top: targetTop, behavior: 'instant' });
  });
}

async function scrollPanelToTop(panel: Locator) {
  await panel.evaluate((el) => {
    el.scrollTop = 0;
  });
}

async function scrollPanelToBottom(panel: Locator) {
  await panel.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
}

async function settleForCapture(page: Page, email: string, theme: Theme) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: STEP_TIMEOUT });
  await dismissVisibleToasts(page);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}.toast{display:none!important;}',
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
    target?: Locator;
  } = {},
) {
  const fileName = `vault-settings-${stateName}-${theme}-${width}.png`;
  const outputPath = testInfo.outputPath(fileName);
  mkdirSync(dirname(outputPath), { recursive: true });
  const buffer = options.target
    ? await options.target.screenshot({
        path: outputPath,
        timeout: STEP_TIMEOUT,
        animations: 'disabled',
        caret: 'hide',
        ...(options.mask && options.mask.length > 0 ? { mask: options.mask } : {}),
      })
    : await page.screenshot({
        path: outputPath,
        timeout: STEP_TIMEOUT,
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
    for (const viewport of WIDTHS) {
      const testLabel = `${theme}-${viewport.width}`;

      test(`captures vault security section and dialogs (${theme}, ${viewport.width})`, async ({
        browser,
      }, testInfo) => {
        test.setTimeout(120_000);
        const context = await newContext(browser);
        try {
          const page = await context.newPage();
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await prepareThemeAndLocale(page, theme);

          logStep(testLabel, 'signup');
          const email = uniqueEmail(`vaultsettings-visual-${theme}-${viewport.width}`);
          await signupViaUi(page, email, PASSWORD);
          if (verifyRequired()) {
            logStep(testLabel, 'verify-email');
            const mail = await waitForMail(email, 'verify_email');
            await confirmEmailToken(page, tokenFromLink(mail.link));
          }
          await expectSignedIn(page);

          logStep(testLabel, 'patch-settings-locale-theme');
          expect((await patchSettingsViaPage(page, { locale: 'vi', theme })).status).toBe(200);
          await prepareThemeAndLocale(page, theme);

          logStep(testLabel, 'goto-settings-and-create-vault');
          await page.goto('/app/settings', {
            waitUntil: 'domcontentloaded',
            timeout: STEP_TIMEOUT,
          });
          await createAndUnlockVaultViaBridge(page, INITIAL_VAULT_PASSPHRASE);

          logStep(testLabel, 'reload-settings-and-unlock-vault');
          await page.reload({ waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT });
          await unlockExistingVaultViaBridge(page, INITIAL_VAULT_PASSPHRASE);

          if (viewport.width >= 640) {
            await expect(page.locator('.vault-pill')).toHaveClass(/vault-open/, {
              timeout: STEP_TIMEOUT,
            });
          } else {
            await expect(page.getByTestId('vault-lock-button-mobile')).toBeVisible({
              timeout: STEP_TIMEOUT,
            });
          }
          await expect(page.getByTestId('vault-security-section')).toBeVisible({
            timeout: STEP_TIMEOUT,
          });
          await expect(page.getByTestId('recovery-keys-remaining-badge')).toBeVisible({
            timeout: STEP_TIMEOUT,
          });
          await expect(page.getByTestId('recovery-keys-slot-chips')).toBeVisible({
            timeout: STEP_TIMEOUT,
          });

          // (a) Settings security section with the vault section (unlocked, RK count shown)
          logStep(testLabel, 'capture:section');
          await settleForCapture(page, email, theme);
          await scrollSecurityHeadingBelowStickyHeader(page);
          await page.waitForTimeout(100);
          await saveScreenshot(page, testInfo, 'section', theme, viewport.width, {
            fullPage: false,
          });

          // (b) Change-passphrase dialog (all passphrase/password inputs empty AND masked)
          logStep(testLabel, 'capture:passphrase-dialog');
          await page.locator('[data-open-dialog="passDlg"]').click({ timeout: STEP_TIMEOUT });
          const passDialog = page.getByRole('dialog');
          await expect(passDialog).toBeVisible({ timeout: STEP_TIMEOUT });
          await expect(passDialog.locator('[data-view="pass-form"]')).toBeVisible({
            timeout: STEP_TIMEOUT,
          });
          await expect(passDialog.locator('#pass-new-pp')).toHaveValue('', {
            timeout: STEP_TIMEOUT,
          });
          await expect(passDialog.locator('#pass-confirm-pp')).toHaveValue('', {
            timeout: STEP_TIMEOUT,
          });
          const passPanel = passDialog.locator('.panel');
          await scrollPanelToTop(passPanel);
          await settleForCapture(page, email, theme);
          const passInputMasks = [
            passDialog.locator('#pass-login-pwd'),
            passDialog.locator('#pass-new-pp'),
            passDialog.locator('#pass-confirm-pp'),
          ];
          await saveScreenshot(page, testInfo, 'passphrase-dialog', theme, viewport.width, {
            target: passPanel,
            mask: passInputMasks,
          });
          await scrollPanelToBottom(passPanel);
          await page.waitForTimeout(50);
          await saveScreenshot(page, testInfo, 'passphrase-dialog-bottom', theme, viewport.width, {
            target: passPanel,
            mask: passInputMasks,
          });
          // (b.2) Change-passphrase done step (`data-view="pass-done"`)
          logStep(testLabel, 'capture:passphrase-done');
          const passLoginInput = passDialog.locator('#pass-login-pwd');
          if ((await passLoginInput.count()) > 0) {
            await fillSecret(passLoginInput, PASSWORD, STEP_TIMEOUT);
          }
          await fillSecret(
            passDialog.locator('#pass-new-pp'),
            UPDATED_VAULT_PASSPHRASE,
            STEP_TIMEOUT,
          );
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
          await settleForCapture(page, email, theme);
          await saveScreenshot(page, testInfo, 'passphrase-done', theme, viewport.width, {
            target: passDialog.locator('.panel'),
          });
          await passDialog
            .getByRole('button', { name: /Done|Xong/ })
            .click({ timeout: STEP_TIMEOUT });
          await expect(passDialog).toBeHidden({ timeout: STEP_TIMEOUT });
          await dismissVisibleToasts(page);

          // (c) Recovery-keys dialog showing a NEW key sheet (all RK slot cells masked)
          logStep(testLabel, 'capture:rk-sheet');
          await page.locator('[data-open-dialog="rotateDlg"]').click({ timeout: STEP_TIMEOUT });
          const rkDialog = page.getByRole('dialog');
          await expect(rkDialog).toBeVisible({ timeout: STEP_TIMEOUT });
          const rkStage = rkDialog.locator('[data-view="rot-reauth"], [data-view="rot-keys"]');
          await expect(rkStage).toBeVisible({ timeout: STEP_TIMEOUT });
          if ((await rkStage.getAttribute('data-view')) === 'rot-reauth') {
            await fillSecret(rkDialog.locator('#rot-reauth-pwd'), PASSWORD, STEP_TIMEOUT);
            await rkDialog
              .getByRole('button', { name: /Continue|Tiếp tục/ })
              .click({ timeout: STEP_TIMEOUT });
          }
          await expect(rkDialog.locator('[data-view="rot-keys"]')).toBeVisible({
            timeout: CRYPTO_STEP_TIMEOUT,
          });
          const rkGrid = rkDialog.getByTestId('recovery-keys-grid');
          await expect(rkGrid).toBeVisible({ timeout: CRYPTO_STEP_TIMEOUT });
          const rkCells = rkDialog.locator('[data-testid^="recovery-key-slot-"]');
          await expect(rkCells).toHaveCount(10, { timeout: STEP_TIMEOUT });
          const rkPanel = rkDialog.locator('.panel');
          await scrollPanelToTop(rkPanel);
          await settleForCapture(page, email, theme);
          await saveScreenshot(page, testInfo, 'rk-sheet', theme, viewport.width, {
            target: rkPanel,
            mask: [rkCells, rkGrid],
          });
          await scrollPanelToBottom(rkPanel);
          await page.waitForTimeout(50);
          await saveScreenshot(page, testInfo, 'rk-sheet-bottom', theme, viewport.width, {
            target: rkPanel,
            mask: [rkCells, rkGrid],
          });
          await rkDialog
            .getByRole('button', { name: /Cancel|Huỷ/ })
            .click({ timeout: STEP_TIMEOUT });
          await expect(rkDialog).toBeHidden({ timeout: STEP_TIMEOUT });
          // R3-5: Use boolean evaluate instead of `not.toHaveText` on `body` so a failure never prints RK text to the CI log
          await expect
            .poll(
              async () =>
                page.evaluate(() =>
                  /rk\d+_[0-9A-Z]{4}-[0-9A-Z]{4}/.test(document.body.innerText),
                ),
              { timeout: STEP_TIMEOUT },
            )
            .toBe(false);

          // (d) Reset-vault dialog (step 1 and the typed-confirmation step)
          logStep(testLabel, 'capture:reset-step1');
          await page.locator('[data-open-dialog="resetDlg"]').click({ timeout: STEP_TIMEOUT });
          const resetDialog = page.getByRole('dialog');
          await expect(resetDialog).toBeVisible({ timeout: STEP_TIMEOUT });
          await expect(resetDialog.locator('[data-view="rst-s1"]')).toBeVisible({
            timeout: STEP_TIMEOUT,
          });
          const resetPanel = resetDialog.locator('.panel');
          await scrollPanelToTop(resetPanel);
          await settleForCapture(page, email, theme);
          await saveScreenshot(page, testInfo, 'reset-step1', theme, viewport.width, {
            target: resetPanel,
          });
          await scrollPanelToBottom(resetPanel);
          await page.waitForTimeout(50);
          await saveScreenshot(page, testInfo, 'reset-step1-bottom', theme, viewport.width, {
            target: resetPanel,
          });
          logStep(testLabel, 'capture:reset-confirm');
          await resetDialog
            .getByRole('button', { name: /None of these work|Không đường nào dùng được/ })
            .click({ timeout: STEP_TIMEOUT });
          await expect(resetDialog.locator('[data-view="rst-s2"]')).toBeVisible({
            timeout: STEP_TIMEOUT,
          });
          await resetDialog
            .getByRole('button', { name: /Checked backups|Đã kiểm tra backup/ })
            .click({ timeout: STEP_TIMEOUT });

          const rstStage = resetDialog.locator('[data-view="rst-s3"], [data-view="rst-s4"]');
          await expect(rstStage).toBeVisible({ timeout: STEP_TIMEOUT });
          if ((await rstStage.getAttribute('data-view')) === 'rst-s3') {
            await fillSecret(resetDialog.locator('#rst-reauth-pwd'), PASSWORD, STEP_TIMEOUT);
            await resetDialog
              .getByRole('button', { name: /Continue|Tiếp tục/ })
              .click({ timeout: STEP_TIMEOUT });
          }

          await expect(resetDialog.locator('[data-view="rst-s4"]')).toBeVisible({
            timeout: STEP_TIMEOUT,
          });
          const confirmWordInput = resetDialog.locator('#rst-confirm-word');
          await confirmWordInput.fill('ĐẶT LẠI', { timeout: STEP_TIMEOUT });
          const rstConfirmBtn = resetDialog.locator('#rstConfirmBtn');
          await expect(rstConfirmBtn).toBeEnabled({ timeout: STEP_TIMEOUT });
          await rstConfirmBtn.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT });
          await settleForCapture(page, email, theme);
          await saveScreenshot(page, testInfo, 'reset-confirm', theme, viewport.width, {
            target: resetDialog.locator('.panel'),
          });

          await page.keyboard.press('Escape');
          await expect(resetDialog).toBeHidden({ timeout: STEP_TIMEOUT });

          // (e) Locked panel banner (`vault-security-locked-banner`)
          logStep(testLabel, 'capture:locked-banner');
          await page.evaluate(async () => {
            const win = window as unknown as {
              __engramVaultTestBridge: { lockNow: () => Promise<void> };
            };
            await win.__engramVaultTestBridge.lockNow();
          });
          await expect(page.getByTestId('vault-security-locked-banner')).toBeVisible({
            timeout: STEP_TIMEOUT,
          });
          await settleForCapture(page, email, theme);
          await scrollSecurityHeadingBelowStickyHeader(page);
          await page.waitForTimeout(100);
          await saveScreenshot(page, testInfo, 'locked-banner', theme, viewport.width, {
            fullPage: false,
          });

          // (f) Complete Reset Vault to transition to absent, then capture absent panel banner (`vault-security-absent-banner`)
          logStep(testLabel, 'capture:absent-banner');
          await page.locator('[data-open-dialog="resetDlg"]').click({ timeout: STEP_TIMEOUT });
          const resetDlgForAbsent = page.getByRole('dialog');
          await expect(resetDlgForAbsent.locator('[data-view="rst-s1"]')).toBeVisible({
            timeout: STEP_TIMEOUT,
          });
          await resetDlgForAbsent
            .getByRole('button', { name: /None of these work|Không đường nào dùng được/ })
            .click({ timeout: STEP_TIMEOUT });
          await expect(resetDlgForAbsent.locator('[data-view="rst-s2"]')).toBeVisible({
            timeout: STEP_TIMEOUT,
          });
          await resetDlgForAbsent
            .getByRole('button', { name: /Checked backups|Đã kiểm tra backup/ })
            .click({ timeout: STEP_TIMEOUT });
          const rstAbsentStage = resetDlgForAbsent.locator(
            '[data-view="rst-s3"], [data-view="rst-s4"]',
          );
          await expect(rstAbsentStage).toBeVisible({ timeout: STEP_TIMEOUT });
          if ((await rstAbsentStage.getAttribute('data-view')) === 'rst-s3') {
            await fillSecret(
              resetDlgForAbsent.locator('#rst-reauth-pwd'),
              PASSWORD,
              STEP_TIMEOUT,
            );
            await resetDlgForAbsent
              .getByRole('button', { name: /Continue|Tiếp tục/ })
              .click({ timeout: STEP_TIMEOUT });
          }
          await expect(resetDlgForAbsent.locator('[data-view="rst-s4"]')).toBeVisible({
            timeout: STEP_TIMEOUT,
          });
          await resetDlgForAbsent
            .locator('#rst-confirm-word')
            .fill('ĐẶT LẠI', { timeout: STEP_TIMEOUT });
          await resetDlgForAbsent.locator('#rstConfirmBtn').click({ timeout: STEP_TIMEOUT });
          await expect(resetDlgForAbsent.locator('[data-view="rst-s5"]')).toBeVisible({
            timeout: STEP_TIMEOUT,
          });
          await resetDlgForAbsent
            .getByRole('button', { name: /Close|Đóng/ })
            .click({ timeout: STEP_TIMEOUT });
          await expect(resetDlgForAbsent).toBeHidden({ timeout: STEP_TIMEOUT });
          await dismissVisibleToasts(page);
          await expect(page.getByTestId('vault-security-absent-banner')).toBeVisible({
            timeout: STEP_TIMEOUT,
          });
          await settleForCapture(page, email, theme);
          await scrollSecurityHeadingBelowStickyHeader(page);
          await page.waitForTimeout(100);
          await saveScreenshot(page, testInfo, 'absent-banner', theme, viewport.width, {
            fullPage: false,
          });

          logStep(testLabel, 'done');
        } finally {
          await context.close();
        }
      });
    }
  }
});
