import { expect, test, type BrowserContext } from '@playwright/test';
import { resolve } from 'node:path';
import en from '../messages/en.json';
import {
  ACCEPTANCE_UI_WAIT_MS,
  createRequestPlaintextMonitor,
  expectInputEmptyBool,
  inspectSsrHtml,
  scanDirectoriesForSecretsAndStorageState,
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

// Disable Playwright's automatic error-context DOM snapshot in this worker before any test runs,
// so a failure while a recovery-key sheet or decrypted entry is mounted never serializes secrets to disk.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

const ARTIFACTS_TIMEOUT_MS = 300_000;

interface LookupResult {
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly entry_count: number;
  }>;
  readonly total: number;
}

test.describe('P04-T21a SSR HTML leak checks (A4) and in-run disk artifact checks', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  test('(a) A4 SSR HTML of /app and /app/items/<A id> contains no body text of A, no filled data-vault-decrypted node, and for B no name/hint/tag of A; (b) no secret or storageState on disk in testInfo.outputDir or test-results', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(ARTIFACTS_TIMEOUT_MS);

    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const userAItemName = `ssr-userA-item-name-${nonce}`;
    const userAItemHint = `ssr-userA-item-hint-${nonce}`;
    const userATagName = `ssr-usera-tag-${nonce.slice(0, 6)}`;
    const userATextBody = `acceptance-ssr-userA-unique-body-${nonce}`;
    const userAJsonToken = `acceptance-ssr-userA-json-token-${nonce}`;
    const userAJsonRaw = `{"secretKey":"${userAJsonToken}","env":"prod"}`;

    const labeledSecretsForNetwork = [
      { label: 'userATextBody', value: userATextBody },
      { label: 'userAJsonToken', value: userAJsonToken },
      { label: 'vaultPassphrase', value: VAULT_PASSPHRASE },
    ] as const;

    const monitor = createRequestPlaintextMonitor(labeledSecretsForNetwork);
    const contexts: BrowserContext[] = [];

    const emailA = uniqueEmail('content-ssr-a');
    const emailB = uniqueEmail('content-ssr-b');
    let userAItemId = '';
    let userARecoverySlot1 = '';
    let userARecoverySlot2 = '';
    let userBRecoverySlot1 = '';
    let userBRecoverySlot2 = '';

    try {
      const contextA = await newContextWithRateLimit(browser);
      contexts.push(contextA);
      monitor.attachContext(contextA);
      const pageA = await contextA.newPage();

      await timedJourneyStep('1. User A signs up, creates vault via onboarding, and creates an item with name, hint, tag, and unique text + JSON entries', async () => {
        await signupPasswordUser(pageA, emailA);
        const keysA = await createVaultViaOnboarding(pageA, VAULT_PASSPHRASE, { kind: 'skip' });
        userARecoverySlot1 = keysA.slot1;
        userARecoverySlot2 = keysA.slot2;
        monitor.registerSecret('userARecoverySlot1', userARecoverySlot1);
        monitor.registerSecret('userARecoverySlot2', userARecoverySlot2);
        await expectUnlockedOnApp(pageA);

        const omniboxA = pageA.getByRole('textbox', { name: en.content.omnibox.ariaLabel });
        await expect(omniboxA).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await setQuietInputValue(
          omniboxA,
          `${userAItemName} #${userATagName}: ${userATextBody}`,
        );
        await omniboxA.press('Enter');
        await expectInputEmptyBool(omniboxA);
        await expect(
          pageA.getByTestId('undo-toast-item').filter({ hasText: userAItemName }).first(),
        ).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });

        const lookupA = await pageA.evaluate(async (name) => {
          const res = await fetch(`/api/v1/items/lookup?name=${encodeURIComponent(name)}`, {
            credentials: 'include',
          });
          return (await res.json()) as LookupResult;
        }, userAItemName);
        expect(lookupA.total).toBe(1);
        userAItemId = lookupA.items[0]!.id;

        // Open item page, set hint, and add a JSON entry
        await pageA.goto(`/app/items/${userAItemId}`);
        const hintInput = pageA.getByTestId('item-hint-input');
        await expect(hintInput).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await hintInput.fill(userAItemHint);
        await hintInput.press('Enter');
        await expect(hintInput).toHaveValue(userAItemHint);

        await pageA.getByTestId('btn-add-json').click();
        const composer = pageA.getByTestId('new-json-entry-composer');
        await expect(composer).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await composer.getByTestId('new-json-tab-raw').click();
        await setQuietInputValue(composer.getByTestId('json-raw-textarea-new-json'), userAJsonRaw);
        await composer.getByTestId('json-raw-save-btn-new-json').click();
        await expect(composer).toBeHidden({ timeout: ACCEPTANCE_UI_WAIT_MS });

        await expect(pageA.getByTestId('entry-body')).toHaveCount(2, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        monitor.assertNoLeaks();
      });

      const contextB = await newContextWithRateLimit(browser);
      contexts.push(contextB);
      monitor.attachContext(contextB);
      const pageB = await contextB.newPage();

      await timedJourneyStep('2. User B signs up and creates vault in a separate context', async () => {
        await signupPasswordUser(pageB, emailB);
        const keysB = await createVaultViaOnboarding(pageB, VAULT_PASSPHRASE, { kind: 'skip' });
        userBRecoverySlot1 = keysB.slot1;
        userBRecoverySlot2 = keysB.slot2;
        monitor.registerSecret('userBRecoverySlot1', userBRecoverySlot1);
        monitor.registerSecret('userBRecoverySlot2', userBRecoverySlot2);
        await expectUnlockedOnApp(pageB);
        monitor.assertNoLeaks();
      });

      await timedJourneyStep('3. (a) A4 SSR HTML check: fetch raw SSR HTML of /app and /app/items/<A id> with A cookies and with B cookies', async () => {
        const forbiddenInASsr = [
          { label: 'userATextBody', value: userATextBody },
          { label: 'userAJsonToken', value: userAJsonToken },
          { label: 'vaultPassphrase', value: VAULT_PASSPHRASE },
          { label: 'userARecoverySlot1', value: userARecoverySlot1 },
          { label: 'userARecoverySlot2', value: userARecoverySlot2 },
        ] as const;

        const forbiddenInBSsr = [
          ...forbiddenInASsr,
          { label: 'userAItemName', value: userAItemName },
          { label: 'userAItemHint', value: userAItemHint },
          { label: 'userATagName', value: userATagName },
          { label: 'userBRecoverySlot1', value: userBRecoverySlot1 },
          { label: 'userBRecoverySlot2', value: userBRecoverySlot2 },
        ] as const;

        // 1. User A's own SSR HTML for `/app` and `/app/items/<A's id>`
        const resAApp = await contextA.request.get('/app', {
          headers: { accept: 'text/html' },
        });
        expect(resAApp.status()).toBe(200);
        const htmlAApp = await resAApp.text();
        const inspectAApp = inspectSsrHtml(htmlAApp, forbiddenInASsr);
        expect(inspectAApp.matchedLabels).toEqual([]);
        expect(inspectAApp.nonEmptyDecryptedNodes).toBe(0);

        const resAItem = await contextA.request.get(`/app/items/${userAItemId}`, {
          headers: { accept: 'text/html' },
        });
        expect(resAItem.status()).toBe(200);
        const htmlAItem = await resAItem.text();
        const inspectAItem = inspectSsrHtml(htmlAItem, forbiddenInASsr);
        expect(inspectAItem.matchedLabels).toEqual([]);
        expect(inspectAItem.nonEmptyDecryptedNodes).toBe(0);

        // 2. User B's SSR HTML for `/app` and `/app/items/<A's id>` (must not contain A's body, name, hint, or tag)
        const resBApp = await contextB.request.get('/app', {
          headers: { accept: 'text/html' },
        });
        expect(resBApp.status()).toBe(200);
        const htmlBApp = await resBApp.text();
        const inspectBApp = inspectSsrHtml(htmlBApp, forbiddenInBSsr);
        expect(inspectBApp.matchedLabels).toEqual([]);
        expect(inspectBApp.nonEmptyDecryptedNodes).toBe(0);

        const resBItem = await contextB.request.get(`/app/items/${userAItemId}`, {
          headers: { accept: 'text/html' },
        });
        expect(resBItem.status()).toBe(200);
        const htmlBItem = await resBItem.text();
        const inspectBItem = inspectSsrHtml(htmlBItem, forbiddenInBSsr);
        expect(inspectBItem.matchedLabels).toEqual([]);
        expect(inspectBItem.nonEmptyDecryptedNodes).toBe(0);
      });

      await timedJourneyStep('4. (b) Disk artifact scan: testInfo.outputDir and project test-results contain zero secrets (bodies, passphrase, recovery keys) and no *storageState* / *.auth.json files', async () => {
        const allSecretsToScan = [
          { label: 'userATextBody', value: userATextBody },
          { label: 'userAJsonToken', value: userAJsonToken },
          { label: 'vaultPassphrase', value: VAULT_PASSPHRASE },
          { label: 'userARecoverySlot1', value: userARecoverySlot1 },
          { label: 'userARecoverySlot2', value: userARecoverySlot2 },
          { label: 'userBRecoverySlot1', value: userBRecoverySlot1 },
          { label: 'userBRecoverySlot2', value: userBRecoverySlot2 },
        ] as const;

        const dirsToScan = [
          testInfo.outputDir,
          testInfo.project.outputDir,
          resolve(process.cwd(), 'test-results'),
          resolve(process.cwd(), 'playwright-report'),
          resolve(process.cwd(), '..', '..', '.data', 'e2e-artifacts'),
        ];

        const scanResult = scanDirectoriesForSecretsAndStorageState(dirsToScan, allSecretsToScan);
        expect(scanResult.forbiddenStorageFiles).toEqual([]);
        expect(scanResult.secretHits).toEqual([]);
      });
    } finally {
      for (const ctx of contexts) {
        await ctx.close().catch(() => undefined);
      }
    }
  });
});
