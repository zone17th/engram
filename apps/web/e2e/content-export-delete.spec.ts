import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { encodeBase64Url } from '../lib/crypto/b64url';
import { openEntryPayload, validateEntryEnvelope, type EntryEnvelopeV1 } from '../lib/crypto/envelope';
import { deriveKek, validateKdfParams } from '../lib/crypto/kdf';
import {
  deriveRecoveryLookupHash,
  deriveRecoveryWrapKey,
  normalizeRecoveryKey,
} from '../lib/crypto/recovery';
import { getSodium } from '../lib/crypto/sodium';
import { openWrap, unpackPrivateKeySeeds, validateWrap } from '../lib/crypto/wrap';
import {
  ACCEPTANCE_UI_WAIT_MS,
  createRequestPlaintextMonitor,
  setQuietInputValue,
  timedJourneyStep,
} from './content-acceptance-support';
import {
  PASSWORD,
  completeFakeOAuth,
  fillSecret,
  newContextWithRateLimit,
  uniqueEmail,
} from './helpers';
import {
  REWRAPPED_PASSPHRASE,
  createVaultViaOnboarding,
  expectUnlockedOnApp,
  signupOauthUser,
  signupPasswordUser,
  submitUnlock,
} from './vault-journey-support';
import { VAULT_PASSPHRASE } from './vault-passkey-support';

// Disable Playwright's automatic error-context DOM snapshot before any test runs.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

const EXPORT_TIMEOUT_MS = 240_000;

interface LookupResult {
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly entry_count: number;
  }>;
  readonly total: number;
}

interface SabkBackupDocument {
  readonly format: string;
  readonly version: number;
  readonly vault: {
    readonly vault_key_id: string;
    readonly kdf: unknown;
    readonly vault_key_wrapped_by_kek: string;
    readonly private_keys_wrapped: string;
    readonly recovery_keys: ReadonlyArray<{
      readonly slot: number;
      readonly lookup_hash: string;
      readonly wrap: string;
    }>;
  };
  readonly entries: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly envelope: EntryEnvelopeV1;
    readonly ciphertext: string;
  }>;
}

async function seedTextAndRawJsonEntries(
  page: Page,
  itemName: string,
  textEntryBody: string,
  rawJsonString: string,
): Promise<string> {
  const omnibox = page.locator('input[type="text"], textarea').first();
  await expect(omnibox).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
  await setQuietInputValue(omnibox, `${itemName} #export: ${textEntryBody}`);
  await omnibox.press('Enter');

  await expect
    .poll(
      async () => {
        const lookup = await page.evaluate(async (name) => {
          const res = await fetch(`/api/v1/items/lookup?name=${encodeURIComponent(name)}`, {
            credentials: 'include',
          });
          return (await res.json()) as LookupResult;
        }, itemName);
        return lookup.items[0]?.id ?? '';
      },
      { timeout: ACCEPTANCE_UI_WAIT_MS },
    )
    .not.toBe('');

  const itemId = await page.evaluate(async (name) => {
    const res = await fetch(`/api/v1/items/lookup?name=${encodeURIComponent(name)}`, {
      credentials: 'include',
    });
    const data = (await res.json()) as LookupResult;
    return data.items[0]!.id;
  }, itemName);

  await page.goto(`/app/items/${itemId}`);
  await page.getByTestId('btn-add-json').click();
  const composer = page.getByTestId('new-json-entry-composer');
  await expect(composer).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
  await composer.getByTestId('new-json-tab-raw').click();
  const composerRawTextarea = composer.getByTestId('json-raw-textarea-new-json');
  await setQuietInputValue(composerRawTextarea, rawJsonString);
  await composer.getByTestId('new-json-save-btn').click();
  await expect(composer).toBeHidden({ timeout: ACCEPTANCE_UI_WAIT_MS });
  return itemId;
}

test.describe('P06-T12 content export E2E (U17a: .sabk.json + Readable decrypted export)', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    !process.env.E2E_STACK,
    'needs the compose stack (E2E_STACK=1): real API, worker, and database',
  );

  test('export journey 1: encrypted .sabk.json backup + rotate KEK & recovery keys -> offline independent restore; readable export within 10m reuses ready source job (0 POST /exports), preserves raw JSON string (9007199254740993), and network log has no plaintext', async ({
    browser,
  }) => {
    test.setTimeout(EXPORT_TIMEOUT_MS);

    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const textEntryBody = `export-text-canary-${nonce}`;
    const rawJsonCanary = `export-json-canary-${nonce}`;
    const rawJsonString = `{\n  "service": "${rawJsonCanary}",\n  "snowflake_id": 9007199254740993,\n  "neg_zero": -0\n}`;
    const itemName = `export-item-${nonce.slice(0, 8)}`;
    const email = uniqueEmail('content-export');

    const context = await newContextWithRateLimit(browser);
    const netMonitor = createRequestPlaintextMonitor([
      { label: 'textEntryBody', value: textEntryBody },
      { label: 'rawJsonCanary', value: rawJsonCanary },
      { label: 'rawJsonString', value: rawJsonString },
    ]);
    netMonitor.attachContext(context);

    try {
      const page = await context.newPage();
      let onboardingRkSlot1 = '';

      await timedJourneyStep(
        '1. signup, create vault via onboarding, and create 1 item with 1 text entry + 1 raw JSON entry',
        async () => {
          await signupPasswordUser(page, email);
          const keys = await createVaultViaOnboarding(page, VAULT_PASSPHRASE, { kind: 'skip' });
          onboardingRkSlot1 = keys.slot1;
          await expectUnlockedOnApp(page);
          await seedTextAndRawJsonEntries(page, itemName, textEntryBody, rawJsonString);
        },
      );

      let sabkExportJobId = '';
      let parsedSabkDoc: SabkBackupDocument | null = null;

      await timedJourneyStep(
        '2. navigate to /app/settings#dulieu, create encrypted .sabk.json backup, and download it via export-encrypted-download-link',
        async () => {
          await page.goto('/app/settings#dulieu');
          const startBtn = page.getByTestId('export-encrypted-start-btn');
          await expect(startBtn).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
          await startBtn.click();

          const downloadLink = page.getByTestId('export-encrypted-download-link');
          await expect(downloadLink).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });

          const latestRes = await page.evaluate(async () => {
            const res = await fetch('/api/v1/exports/latest', { credentials: 'include' });
            return (await res.json()) as { job: { id: string; status: string } | null };
          });
          expect(latestRes.job?.status).toBe('ready');
          sabkExportJobId = latestRes.job?.id ?? '';
          expect(sabkExportJobId).not.toBe('');

          const downloadPromise = page.waitForEvent('download', { timeout: ACCEPTANCE_UI_WAIT_MS });
          await downloadLink.click();
          const download = await downloadPromise;
          expect(download.suggestedFilename()).toMatch(
            /^engram-backup-\d{4}-\d{2}-\d{2}\.sabk\.json$/,
          );
          const filePath = await download.path();
          expect(filePath).toBeTruthy();
          const rawSabk = readFileSync(filePath!, 'utf8');
          parsedSabkDoc = JSON.parse(rawSabk) as SabkBackupDocument;
          expect(parsedSabkDoc.format).toBe('engram.sabk');
          expect(parsedSabkDoc.version).toBe(1);
          expect(parsedSabkDoc.entries.length).toBe(2);
        },
      );

      await timedJourneyStep(
        '3. open Readable Export (#plainDlg), re-authenticate with account password (#plain-export-password + readable-export-submit-btn), reuse ready source job within 10m (0 POST /exports), and verify format engram.readable + entries[].body raw JSON',
        async () => {
          let createExportCalls = 0;
          const onReq = (req: { method: () => string; url: () => string }) => {
            if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/v1/exports') {
              createExportCalls += 1;
            }
          };
          page.on('request', onReq);

          try {
            await page.getByTestId('export-readable-open-btn').click();
            const dialog = page.locator('#plainDlg');
            await expect(dialog).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });

            const pwdInput = dialog.locator('#plain-export-password');
            await expect(pwdInput).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
            await setQuietInputValue(pwdInput, PASSWORD);

            const downloadPromise = page.waitForEvent('download', {
              timeout: ACCEPTANCE_UI_WAIT_MS,
            });
            await page.getByTestId('readable-export-submit-btn').click();
            const download = await downloadPromise;

            expect(download.suggestedFilename()).toMatch(
              /^engram-readable-\d{4}-\d{2}-\d{2}\.json$/,
            );
            const filePath = await download.path();
            expect(filePath).toBeTruthy();
            const readableContent = readFileSync(filePath!, 'utf8');
            const parsedReadable = JSON.parse(readableContent) as {
              format: string;
              version: number;
              snapshot: { source_export_id: string };
              entries: Array<{ type: string; body: string }>;
            };
            expect(parsedReadable.format).toBe('engram.readable');
            expect(parsedReadable.version).toBe(1);
            expect(parsedReadable.snapshot.source_export_id).toBe(sabkExportJobId);
            expect(createExportCalls).toBe(0);

            const jsonEntry = parsedReadable.entries.find((e) => e.type === 'json');
            expect(jsonEntry?.body === rawJsonString).toBe(true);
            expect(jsonEntry?.body.includes('9007199254740993')).toBe(true);

            const textEntry = parsedReadable.entries.find((e) => e.type === 'text');
            expect(textEntry?.body === textEntryBody).toBe(true);

            await expect(dialog.locator('[data-view="pl-done"]')).toBeVisible({
              timeout: ACCEPTANCE_UI_WAIT_MS,
            });
            await page.getByTestId('readable-export-done-btn').click();
            await expect(dialog).toBeHidden({ timeout: ACCEPTANCE_UI_WAIT_MS });
          } finally {
            page.off('request', onReq);
          }
        },
      );

      await timedJourneyStep(
        '4. rotate vault passphrase (KEK) and rotate recovery keys on the server, then verify offline .sabk.json restore still opens VK and entries with the snapshot passphrase and snapshot RK',
        async () => {
          // Rotate passphrase (KEK) via Settings #baomat
          await page.locator('[data-open-dialog="passDlg"]').click();
          const passDialog = page.getByRole('dialog');
          await expect(passDialog).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
          await fillSecret(passDialog.locator('#pass-login-pwd'), PASSWORD, ACCEPTANCE_UI_WAIT_MS);
          await fillSecret(
            passDialog.locator('#pass-new-pp'),
            REWRAPPED_PASSPHRASE,
            ACCEPTANCE_UI_WAIT_MS,
          );
          await fillSecret(
            passDialog.locator('#pass-confirm-pp'),
            REWRAPPED_PASSPHRASE,
            ACCEPTANCE_UI_WAIT_MS,
          );
          await passDialog
            .getByRole('button', { name: /Change passphrase|Đổi passphrase/ })
            .click();
          await expect(passDialog.locator('[data-view="pass-done"]')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });
          await passDialog.getByRole('button', { name: /Done|Xong/ }).click();
          await expect(passDialog).toBeHidden({ timeout: ACCEPTANCE_UI_WAIT_MS });

          // Rotate all 10 recovery keys on the server so old RKs are revoked on server
          await page.locator('[data-open-dialog="rotateDlg"]').click();
          const rkDialog = page.getByRole('dialog');
          await expect(rkDialog).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
          await fillSecret(rkDialog.locator('#rot-reauth-pwd'), PASSWORD, ACCEPTANCE_UI_WAIT_MS);
          await rkDialog.getByRole('button', { name: /Continue|Tiếp tục/ }).click();
          await expect(rkDialog.getByTestId('recovery-keys-grid')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });
          await rkDialog.getByRole('checkbox').check();
          await rkDialog.locator('#rkRotateConfirmBtn').click();
          await expect(rkDialog).toBeHidden({ timeout: ACCEPTANCE_UI_WAIT_MS });

          // Offline restore from the previously downloaded .sabk.json using original VAULT_PASSPHRASE and onboardingRkSlot1
          expect(parsedSabkDoc).not.toBeNull();
          const sabk = parsedSabkDoc!;
          const sodium = await getSodium();

          validateKdfParams(sabk.vault.kdf);
          validateWrap(sabk.vault.vault_key_wrapped_by_kek, 'kek');
          validateWrap(sabk.vault.private_keys_wrapped, 'priv');

          const kek = await deriveKek(
            sodium,
            new TextEncoder().encode(VAULT_PASSPHRASE),
            sabk.vault.kdf,
          );
          const vkFromPassphrase = openWrap(
            sodium,
            'kek',
            sabk.vault.vault_key_wrapped_by_kek,
            kek,
          );
          expect(vkFromPassphrase.byteLength).toBe(32);

          const rkNorm = normalizeRecoveryKey(onboardingRkSlot1);
          const lookupHash = encodeBase64Url(deriveRecoveryLookupHash(sodium, rkNorm));
          const rkSlot = sabk.vault.recovery_keys.find((r) => r.lookup_hash === lookupHash);
          expect(rkSlot).toBeDefined();
          const rkWrapKey = deriveRecoveryWrapKey(sodium, rkNorm);
          const vkFromRk = openWrap(sodium, 'rk', rkSlot!.wrap, rkWrapKey);
          expect(Buffer.from(vkFromRk).equals(Buffer.from(vkFromPassphrase))).toBe(true);

          const privPlain = openWrap(
            sodium,
            'priv',
            sabk.vault.private_keys_wrapped,
            vkFromPassphrase,
          );
          const seeds = unpackPrivateKeySeeds(privPlain);
          expect(seeds.x25519Seed.byteLength).toBe(32);
          expect(seeds.ed25519Seed.byteLength).toBe(32);

          const decryptedBodies: string[] = [];
          for (const entry of sabk.entries) {
            const env = validateEntryEnvelope(entry.envelope);
            const opened = openEntryPayload(sodium, {
              entryId: entry.id,
              envelope: env,
              ciphertext: entry.ciphertext,
              vk: vkFromPassphrase,
            });
            decryptedBodies.push(opened.plaintext);
          }
          expect(decryptedBodies.includes(textEntryBody)).toBe(true);
          expect(decryptedBodies.includes(rawJsonString)).toBe(true);
        },
      );

      await timedJourneyStep(
        '5. verify audit log contains export.encrypted + export.decrypted and network log contains zero plaintext leaks',
        async () => {
          const auditRes = await page.evaluate(async () => {
            const res = await fetch('/api/v1/auth/audit', { credentials: 'include' });
            return (await res.json()) as { items: Array<{ event: string }> };
          });
          const events = auditRes.items.map((item) => item.event);
          expect(events).toContain('export.encrypted');
          expect(events).toContain('export.decrypted');

          netMonitor.assertNoLeaks();
        },
      );
    } finally {
      await context.close();
    }
  });

  test('export journey 2: reload mid-job still shows progress (exp-preparing) and 3 export jobs (including 1 cancelled) cause the 4th POST /api/v1/exports to return 429 exp-limit', async ({
    browser,
  }) => {
    test.setTimeout(EXPORT_TIMEOUT_MS);

    const email = uniqueEmail('export-quota-reload');
    const context = await newContextWithRateLimit(browser);

    try {
      const page = await context.newPage();

      await timedJourneyStep('1. signup and create vault', async () => {
        await signupPasswordUser(page, email);
        await createVaultViaOnboarding(page, VAULT_PASSPHRASE, { kind: 'skip' });
        await expectUnlockedOnApp(page);
      });

      await timedJourneyStep(
        '2. start job #1, cancel it (counts toward 3/hour quota), and verify reload mid-job on job #2 shows exp-preparing progress before completing',
        async () => {
          await page.goto('/app/settings#dulieu');
          const startBtn = page.getByTestId('export-encrypted-start-btn');
          await expect(startBtn).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });

          // Create Job #1 via API and immediately cancel it so it deterministically counts as 1 cancelled job
          const job1 = await page.evaluate(async () => {
            let csrf = '';
            for (const part of document.cookie.split(';')) {
              const t = part.trim();
              if (t.startsWith('sabk_csrf=')) {
                csrf = decodeURIComponent(t.slice('sabk_csrf='.length));
              }
            }
            const createRes = await fetch('/api/v1/exports', {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                'Idempotency-Key': crypto.randomUUID(),
                'X-CSRF-Token': csrf,
              },
              body: JSON.stringify({ kind: 'encrypted' }),
            });
            const created = (await createRes.json()) as { id: string; status: string };
            await fetch(`/api/v1/exports/${created.id}/cancel`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                accept: 'application/json',
                'Idempotency-Key': crypto.randomUUID(),
                'X-CSRF-Token': csrf,
              },
            });
            return created.id;
          });
          expect(job1).not.toBe('');

          // Intercept GET /api/v1/exports/latest once on reload so the card deterministically observes an in-progress job on mount (reload mid-job)
          let interceptedReloadLatest = false;
          let activeJob2Id = '';
          await page.route('**/api/v1/exports/latest', async (route) => {
            if (!interceptedReloadLatest && activeJob2Id) {
              interceptedReloadLatest = true;
              await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                  job: {
                    id: activeJob2Id,
                    kind: 'encrypted',
                    status: 'running',
                    created_at: new Date().toISOString(),
                    items_processed: 1,
                    items_total: 2,
                  },
                }),
              });
              return;
            }
            await route.continue();
          });

          // Create Job #2
          activeJob2Id = await page.evaluate(async () => {
            let csrf = '';
            for (const part of document.cookie.split(';')) {
              const t = part.trim();
              if (t.startsWith('sabk_csrf=')) {
                csrf = decodeURIComponent(t.slice('sabk_csrf='.length));
              }
            }
            const res = await fetch('/api/v1/exports', {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                'Idempotency-Key': crypto.randomUUID(),
                'X-CSRF-Token': csrf,
              },
              body: JSON.stringify({ kind: 'encrypted' }),
            });
            const body = (await res.json()) as { id: string };
            return body.id;
          });
          expect(activeJob2Id).not.toBe('');

          // Reload page mid-job -> card mounts, sees running job, shows exp-preparing progress bar, then polls real GET /exports/{id} to exp-ready
          await page.reload();
          await expect(page.locator('[data-view="exp-preparing"]')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });
          await expect(page.locator('[data-view="exp-ready"]')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });
          await page.unroute('**/api/v1/exports/latest');
        },
      );

      await timedJourneyStep(
        '3. create job #3, then trigger 4th export via UI and verify 429 rate_limited transitions card to exp-limit',
        async () => {
          // Wait for job #2 to be ready, then create Job #3 via API and wait for it to finish
          const job3Id = await page.evaluate(async () => {
            let csrf = '';
            for (const part of document.cookie.split(';')) {
              const t = part.trim();
              if (t.startsWith('sabk_csrf=')) {
                csrf = decodeURIComponent(t.slice('sabk_csrf='.length));
              }
            }
            const res = await fetch('/api/v1/exports', {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                'Idempotency-Key': crypto.randomUUID(),
                'X-CSRF-Token': csrf,
              },
              body: JSON.stringify({ kind: 'encrypted' }),
            });
            const body = (await res.json()) as { id: string };
            return body.id;
          });
          expect(job3Id).not.toBe('');

          // Cancel job #3 so the card is back in exp-idle on reload and 3 jobs have been created in the past hour
          await page.evaluate(async (id) => {
            let csrf = '';
            for (const part of document.cookie.split(';')) {
              const t = part.trim();
              if (t.startsWith('sabk_csrf=')) {
                csrf = decodeURIComponent(t.slice('sabk_csrf='.length));
              }
            }
            await fetch(`/api/v1/exports/${id}/cancel`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                accept: 'application/json',
                'Idempotency-Key': crypto.randomUUID(),
                'X-CSRF-Token': csrf,
              },
            });
          }, job3Id);

          await page.reload();
          const startBtn = page.getByTestId('export-encrypted-start-btn');
          await expect(startBtn).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
          await expect(startBtn).toBeEnabled({ timeout: ACCEPTANCE_UI_WAIT_MS });

          // 4th POST /api/v1/exports -> 429 rate_limited -> exp-limit
          const fourthPostPromise = page.waitForResponse(
            (res) =>
              res.request().method() === 'POST' &&
              new URL(res.url()).pathname === '/api/v1/exports',
            { timeout: ACCEPTANCE_UI_WAIT_MS },
          );
          await startBtn.click();
          const fourthRes = await fourthPostPromise;
          expect(fourthRes.status()).toBe(429);

          await expect(page.locator('[data-view="exp-limit"]')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });
          await expect(page.getByTestId('export-encrypted-start-btn')).toBeDisabled();
        },
      );
    } finally {
      await context.close();
    }
  });

  test('export journey 3: OAuth-only readable export re-auth returnTo (/app/settings?reauth=export.decrypted#dulieu) -> auto-opens #plainDlg in pl-locked -> unlock vault -> completes readable export', async ({
    browser,
  }) => {
    test.setTimeout(EXPORT_TIMEOUT_MS);

    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const email = uniqueEmail('oauth-export');
    const subject = `google-export-sub-${nonce}`;
    const textBody = `oauth-export-body-${nonce}`;
    const rawJson = `{"oauth_export":true,"id":9007199254740993}`;
    const itemName = `oauth-item-${nonce.slice(0, 8)}`;

    const context = await newContextWithRateLimit(browser);
    try {
      const page = await context.newPage();

      await timedJourneyStep(
        '1. OAuth-only signup via fake Google provider, onboarding vault creation, and entry creation',
        async () => {
          await signupOauthUser(page, email, subject);
          await createVaultViaOnboarding(page, VAULT_PASSPHRASE, { kind: 'skip' });
          await expectUnlockedOnApp(page);
          await seedTextAndRawJsonEntries(page, itemName, textBody, rawJson);
        },
      );

      await timedJourneyStep(
        '2. open Readable Export in /app/settings#dulieu, click Verify with Google, complete fake OAuth re-auth, return to /app/settings?reauth=export.decrypted -> #plainDlg auto-opens in pl-locked',
        async () => {
          await page.goto('/app/settings#dulieu');
          await page.getByTestId('export-readable-open-btn').click();
          const dialog = page.locator('#plainDlg');
          await expect(dialog).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
          await expect(dialog.locator('[data-view="pl-confirm"]')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });

          await page.getByTestId('readable-export-oauth-btn').click();
          await completeFakeOAuth(page, { email, subject });

          // Full-page OAuth redirect clears in-memory VK -> vault is locked on return, and #plainDlg auto-opens in pl-locked
          await expect(page).toHaveURL(/\/app\/settings/, { timeout: ACCEPTANCE_UI_WAIT_MS });
          await expect(dialog).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
          await expect(dialog.locator('[data-view="pl-locked"]')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });
        },
      );

      await timedJourneyStep(
        '3. click Unlock vault from pl-locked, unlock with passphrase, and verify returnTo auto-resumes #plainDlg with valid grant to pl-done + downloads engram.readable file',
        async () => {
          const downloadPromise = page.waitForEvent('download', { timeout: ACCEPTANCE_UI_WAIT_MS });

          await page.getByTestId('readable-export-unlock-link').click();
          await expect(page).toHaveURL(/\/app\/unlock/, { timeout: ACCEPTANCE_UI_WAIT_MS });
          await submitUnlock(page, VAULT_PASSPHRASE);

          await expect(page).toHaveURL(/\/app\/settings/, { timeout: ACCEPTANCE_UI_WAIT_MS });
          const dialog = page.locator('#plainDlg');
          await expect(dialog).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });

          const download = await downloadPromise;
          expect(download.suggestedFilename()).toMatch(
            /^engram-readable-\d{4}-\d{2}-\d{2}\.json$/,
          );
          const filePath = await download.path();
          expect(filePath).toBeTruthy();
          const readableJson = JSON.parse(readFileSync(filePath!, 'utf8')) as {
            format: string;
            entries: Array<{ type: string; body: string }>;
          };
          expect(readableJson.format).toBe('engram.readable');
          expect(readableJson.entries.some((e) => e.body === rawJson)).toBe(true);

          await expect(dialog.locator('[data-view="pl-done"]')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });
        },
      );
    } finally {
      await context.close();
    }
  });

  test('delete journey 1 (P06-A1 / P06-A4): Reset Vault step 2 "Download backup first" scrolls/focuses #dulieu -> 2-step Delete Account (#deleteDlg) -> typed email + password reauth -> DELETE /api/v1/me 204 -> session revoked + #login-account-deleted-banner (?deleted=1) + dogfood cleanup', async ({
    browser,
  }) => {
    test.setTimeout(EXPORT_TIMEOUT_MS);

    const nonce = uniqueEmail('p06-t13-delete').split('@')[0];
    const email = `${nonce}@example.com`;
    const dogfoodSecret = `dogfood-secret-${nonce}`;
    const context = await newContextWithRateLimit(browser);
    const netMonitor = createRequestPlaintextMonitor([
      { label: 'vaultPassphrase', value: VAULT_PASSPHRASE },
      { label: 'dogfoodSecret', value: dogfoodSecret },
    ]);
    netMonitor.attachContext(context);

    try {
      const page = await context.newPage();

      await timedJourneyStep(
        '1. signup password user, create vault + 1 item + 1 entry, and navigate to /app/settings',
        async () => {
          await signupPasswordUser(page, email);
          await createVaultViaOnboarding(page, VAULT_PASSPHRASE, { kind: 'skip' });
          await expectUnlockedOnApp(page);

          await seedTextAndRawJsonEntries(
            page,
            `Delete-Dogfood-Item-${nonce.slice(0, 8)}`,
            dogfoodSecret,
            `{"dogfood":true}`,
          );

          await page.goto('/app/settings', { waitUntil: 'domcontentloaded' });
          await expect(page.locator('#dulieu')).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
          await expect(page.locator('#xoataikhoan')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });
        },
      );

      await timedJourneyStep(
        '2. Reset Vault step 2 "Download backup first" (F-42 / F-27) closes #resetDlg, scrolls #dulieu into view, and focuses the Download backup button',
        async () => {
          await page.locator('[data-open-dialog="resetDlg"]').click();
          const resetDialog = page.locator('#resetDlg');
          await expect(resetDialog).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
          await expect(resetDialog.locator('[data-view="rst-s1"]')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });

          await resetDialog
            .getByRole('button', { name: /None of these work|Không đường nào dùng được/ })
            .click();
          await expect(resetDialog.locator('[data-view="rst-s2"]')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });

          await page.getByTestId('reset-vault-download-backup-link').click();
          await expect(resetDialog).toBeHidden({ timeout: ACCEPTANCE_UI_WAIT_MS });
          await expect(page.getByTestId('export-encrypted-start-btn')).toBeFocused({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });
        },
      );

      await timedJourneyStep(
        '3. open 2-step Delete Account (#deleteDlg) -> verify step 1 focus on Keep account -> step 2 email mismatch validation + wrong password error -> valid confirm_email + password -> DELETE /api/v1/me 204 -> redirect to /app/auth/login?deleted=1 with #login-account-deleted-banner and revoked session',
        async () => {
          await page.getByTestId('delete-account-open-btn').click();
          const deleteDlg = page.locator('#deleteDlg');
          await expect(deleteDlg).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
          await expect(deleteDlg.locator('[data-view="del-s1"]')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });
          await expect(page.getByTestId('delete-account-keep-btn')).toBeFocused({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });

          await page.getByTestId('delete-account-continue-btn').click();
          await expect(deleteDlg.locator('[data-view="del-s2"]')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });

          const pwdInput = page.locator('#delete-account-password');
          const emailInput = page.getByTestId('delete-account-email-input');
          const submitBtn = page.getByTestId('delete-account-submit-btn');
          await expect(pwdInput).toBeFocused({ timeout: ACCEPTANCE_UI_WAIT_MS });
          await expect(submitBtn).toBeDisabled();

          // Mismatched email shows #delEmailErr and keeps submit disabled
          await emailInput.fill('wrong-email@example.com');
          await fillSecret(pwdInput, 'wrong-password-12345', ACCEPTANCE_UI_WAIT_MS);
          await expect(page.locator('#delEmailErr')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });
          await expect(submitBtn).toBeDisabled();

          // Matching email (case-insensitive) enables submit; wrong password keeps dialog on del-s2 and focuses password input
          await emailInput.fill(`  ${email.toUpperCase()}  `);
          await expect(page.locator('#delEmailErr')).toBeHidden({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });
          await expect(submitBtn).toBeEnabled({ timeout: ACCEPTANCE_UI_WAIT_MS });

          await submitBtn.click();
          await expect(page.locator('#delete-account-password-error')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });
          await expect(pwdInput).toBeFocused({ timeout: ACCEPTANCE_UI_WAIT_MS });

          // Enter valid password and submit -> 204 DELETE /api/v1/me -> lands on /app/auth/login with #login-account-deleted-banner
          const deleteResponsePromise = page.waitForResponse(
            (res) =>
              res.request().method() === 'DELETE' && new URL(res.url()).pathname === '/api/v1/me',
            { timeout: ACCEPTANCE_UI_WAIT_MS },
          );
          await fillSecret(pwdInput, PASSWORD, ACCEPTANCE_UI_WAIT_MS);
          await submitBtn.click();

          const deleteRes = await deleteResponsePromise;
          expect(deleteRes.status()).toBe(204);

          await expect(page).toHaveURL(/\/app\/auth\/login$/, {
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });
          const deletedBanner = page.locator('#login-account-deleted-banner');
          await expect(deletedBanner).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
          await expect(deletedBanner).toHaveAttribute('role', 'status');

          // Verify session is revoked on server (GET /api/v1/auth/me returns 401)
          const meStatus = await page.evaluate(async () => {
            const res = await fetch('/api/v1/auth/me', {
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
            });
            return res.status;
          });
          expect(meStatus).toBe(401);
        },
      );

      netMonitor.assertNoLeaks();
    } finally {
      await context.close();
    }
  });

  test('delete journey 2: OAuth-only account delete re-auth returnTo (/app/settings?reauth=account.delete#xoataikhoan) -> auto-opens #deleteDlg at del-s2 -> typed email -> DELETE /api/v1/me 204 -> #login-account-deleted-banner', async ({
    browser,
  }) => {
    test.setTimeout(EXPORT_TIMEOUT_MS);

    const nonce = uniqueEmail('p06-t13-oauth-delete').split('@')[0];
    const email = `${nonce}@example.com`;
    const subject = `sub-p06-t13-del-${nonce}`;
    const context = await newContextWithRateLimit(browser);

    try {
      const page = await context.newPage();

      await timedJourneyStep(
        '1. signup OAuth-only user, create vault via onboarding, and navigate to /app/settings#xoataikhoan',
        async () => {
          await signupOauthUser(page, email, subject);
          await createVaultViaOnboarding(page, VAULT_PASSPHRASE, { kind: 'skip' });
          await expectUnlockedOnApp(page);

          await page.goto('/app/settings#xoataikhoan', { waitUntil: 'domcontentloaded' });
          await expect(page.locator('#xoataikhoan')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });
        },
      );

      await timedJourneyStep(
        '2. open #deleteDlg -> advance to del-s2 -> click Verify with Google -> complete OAuth -> auto-opens #deleteDlg at del-s2 on return -> enter confirm_email -> DELETE /api/v1/me 204 -> #login-account-deleted-banner',
        async () => {
          await page.getByTestId('delete-account-open-btn').click();
          const deleteDlg = page.locator('#deleteDlg');
          await expect(deleteDlg).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
          await expect(deleteDlg.locator('[data-view="del-s1"]')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });

          await page.getByTestId('delete-account-continue-btn').click();
          await expect(deleteDlg.locator('[data-view="del-s2"]')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });

          await page.getByTestId('delete-account-oauth-btn').click();
          await completeFakeOAuth(page, { email, subject });

          await expect(page).toHaveURL(/\/app\/settings/, { timeout: ACCEPTANCE_UI_WAIT_MS });
          await expect(deleteDlg).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
          await expect(deleteDlg.locator('[data-view="del-s2"]')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });
          await expect(page.getByTestId('delete-account-oauth-verified-status')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });

          const emailInput = page.getByTestId('delete-account-email-input');
          const submitBtn = page.getByTestId('delete-account-submit-btn');
          await expect(emailInput).toBeFocused({ timeout: ACCEPTANCE_UI_WAIT_MS });
          await expect(submitBtn).toBeDisabled();

          const deleteResponsePromise = page.waitForResponse(
            (res) =>
              res.request().method() === 'DELETE' && new URL(res.url()).pathname === '/api/v1/me',
            { timeout: ACCEPTANCE_UI_WAIT_MS },
          );
          await emailInput.fill(email);
          await expect(submitBtn).toBeEnabled({ timeout: ACCEPTANCE_UI_WAIT_MS });
          await submitBtn.click();

          const deleteRes = await deleteResponsePromise;
          expect(deleteRes.status()).toBe(204);

          await expect(page).toHaveURL(/\/app\/auth\/login$/, {
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });
          await expect(page.locator('#login-account-deleted-banner')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });
        },
      );
    } finally {
      await context.close();
    }
  });
});
