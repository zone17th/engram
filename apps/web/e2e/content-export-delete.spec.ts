import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PASSWORD } from './helpers';
import {
  ACCEPTANCE_UI_WAIT_MS,
  setQuietInputValue,
  timedJourneyStep,
} from './content-acceptance-support';
import { newContextWithRateLimit, uniqueEmail } from './helpers';
import {
  createVaultViaOnboarding,
  expectUnlockedOnApp,
  signupPasswordUser,
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

test.describe('P06-T12 content export E2E (U17a: .sabk.json + Readable decrypted export)', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, worker, and database');

  test('encrypted .sabk.json export + readable decrypted JSON export preserve raw JSON string (9007199254740993), reuse ready source job (0 quota), and record export_encrypted + export_decrypted audit events', async ({
    browser,
  }) => {
    test.setTimeout(EXPORT_TIMEOUT_MS);

    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const textEntryBody = `export-text-body-${nonce}`;
    const rawJsonString = `{\n  "service": "export-json-${nonce}",\n  "snowflake_id": 9007199254740993,\n  "neg_zero": -0\n}`;
    const itemName = `export-item-${nonce.slice(0, 8)}`;
    const email = uniqueEmail('content-export');

    const context = await newContextWithRateLimit(browser);
    try {
      const page = await context.newPage();

      await timedJourneyStep('1. signup, create vault via onboarding, and create 1 item with 1 text entry + 1 raw JSON entry', async () => {
        await signupPasswordUser(page, email);
        await createVaultViaOnboarding(page, VAULT_PASSPHRASE, { kind: 'skip' });
        await expectUnlockedOnApp(page);

        // Quick-add 1 text entry with tag #export
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

        const item1Id = await page.evaluate(async (name) => {
          const res = await fetch(`/api/v1/items/lookup?name=${encodeURIComponent(name)}`, {
            credentials: 'include',
          });
          const data = (await res.json()) as LookupResult;
          return data.items[0]!.id;
        }, itemName);

        await page.goto(`/app/items/${item1Id}`);
        await page.getByTestId('btn-add-json').click();
        const composer = page.getByTestId('new-json-entry-composer');
        await expect(composer).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await composer.getByTestId('new-json-tab-raw').click();
        const composerRawTextarea = composer.getByTestId('json-raw-textarea-new-json');
        await setQuietInputValue(composerRawTextarea, rawJsonString);
        await composer.getByTestId('new-json-save-btn').click();
        await expect(composer).toBeHidden({ timeout: ACCEPTANCE_UI_WAIT_MS });
      });

      let sabkExportJobId = '';

      await timedJourneyStep('2. navigate to /app/settings#dulieu, create encrypted .sabk.json backup, and download it', async () => {
        await page.goto('/app/settings#dulieu');
        const startBtn = page.getByTestId('export-encrypted-start-btn');
        await expect(startBtn).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await startBtn.click();

        const downloadBtn = page.getByTestId('export-encrypted-download-btn');
        await expect(downloadBtn).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });

        const latestRes = await page.evaluate(async () => {
          const res = await fetch('/api/v1/exports/latest', { credentials: 'include' });
          return (await res.json()) as { job: { id: string; status: string } | null };
        });
        expect(latestRes.job?.status).toBe('ready');
        sabkExportJobId = latestRes.job?.id ?? '';
        expect(sabkExportJobId).not.toBe('');

        const downloadPromise = page.waitForEvent('download', { timeout: ACCEPTANCE_UI_WAIT_MS });
        await downloadBtn.click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toMatch(/^engram-backup-\d{4}-\d{2}-\d{2}\.sabk\.json$/);
        const filePath = await download.path();
        expect(filePath).toBeTruthy();
        const rawSabk = readFileSync(filePath!, 'utf8');
        const parsedSabk = JSON.parse(rawSabk) as {
          format: string;
          version: number;
          entries: Array<{ id: string; ciphertext: string }>;
        };
        expect(parsedSabk.format).toBe('engram.sabk');
        expect(parsedSabk.version).toBe(1);
        expect(parsedSabk.entries.length).toBe(2);
      });

      await timedJourneyStep('3. open Readable Export (#plainDlg), re-authenticate with account password, reuse ready source job (0 POST /exports), and verify raw JSON string is preserved', async () => {
        let createExportCalls = 0;
        const onReq = (req: { method: () => string; url: () => string }) => {
          if (req.method() === 'POST' && req.url().endsWith('/api/v1/exports')) {
            createExportCalls += 1;
          }
        };
        page.on('request', onReq);

        try {
          await page.getByTestId('export-readable-open-btn').click();
          const dialog = page.locator('#plainDlg');
          await expect(dialog).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });

          const pwdInput = page.getByTestId('plain-reauth-password-input');
          await expect(pwdInput).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
          await setQuietInputValue(pwdInput, PASSWORD);

          const downloadPromise = page.waitForEvent('download', { timeout: ACCEPTANCE_UI_WAIT_MS });
          await page.getByTestId('plain-confirm-submit-btn').click();
          const download = await downloadPromise;

          expect(download.suggestedFilename()).toMatch(/^engram-readable-\d{4}-\d{2}-\d{2}\.json$/);
          const filePath = await download.path();
          expect(filePath).toBeTruthy();
          const readableContent = readFileSync(filePath!, 'utf8');
          const parsedReadable = JSON.parse(readableContent) as {
            format: string;
            version: number;
            snapshot: { source_export_id: string };
            entries: Array<{ type: string; plaintext: string }>;
          };
          expect(parsedReadable.format).toBe('engram.decrypted');
          expect(parsedReadable.version).toBe(1);
          expect(parsedReadable.snapshot.source_export_id).toBe(sabkExportJobId);
          expect(createExportCalls).toBe(0);

          const jsonEntry = parsedReadable.entries.find((e) => e.type === 'json');
          expect(jsonEntry?.plaintext).toBe(rawJsonString);
          expect(jsonEntry?.plaintext).toContain('9007199254740993');

          await expect(dialog.locator('[data-view="pl-done"]')).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });
          await page.getByTestId('plain-done-close-btn').click();
          await expect(dialog).toBeHidden({ timeout: ACCEPTANCE_UI_WAIT_MS });
        } finally {
          page.off('request', onReq);
        }
      });

      await timedJourneyStep('4. verify security audit trail lists both export.encrypted and export.decrypted', async () => {
        const auditRes = await page.evaluate(async () => {
          const res = await fetch('/api/v1/auth/audit', { credentials: 'include' });
          return (await res.json()) as { items: Array<{ event: string }> };
        });
        const events = auditRes.items.map((item) => item.event);
        expect(events).toContain('export.encrypted');
        expect(events).toContain('export.decrypted');
      });
    } finally {
      await context.close();
    }
  });
});
