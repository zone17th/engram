import { expect, test, type BrowserContext } from '@playwright/test';
import { resolve } from 'node:path';
import en from '../messages/en.json';
import {
  ACCEPTANCE_UI_WAIT_MS,
  createRequestPlaintextMonitor,
  expectInputEmptyBool,
  inspectSsrHtml,
  saveAndVerifyItemHintPersisted,
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

// Note: `noCopyPrompt: true` in `playwright.config.ts` and `PLAYWRIGHT_NO_COPY_PROMPT: "1"` in `ci.yml`
// disable Playwright's automatic error-context DOM snapshot before worker startup.

const ARTIFACTS_TIMEOUT_MS = 300_000;

interface LookupResult {
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly entry_count: number;
  }>;
  readonly total: number;
}

test.describe('P04-T21a SSR HTML leak checks (A4) and earlier test output disk scan', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  test('(a) A4 SSR HTML of /app and /app/items/<A id> contains no body text of A, no filled data-vault-decrypted node, and for B no name/hint/tag of A (with positive & negative controls); (b) no storageState file name and no constant passphrase in earlier test output', async ({
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

        // Open item page via client-side card click (keeps vault unlocked in memory), set hint, and add a JSON entry
        const cardA = pageA.locator(`[data-item-card="${userAItemId}"]`);
        await expect(cardA).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await cardA.click();
        await expect(pageA).toHaveURL(new RegExp(`/app/items/${userAItemId}$`), {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await saveAndVerifyItemHintPersisted(pageA, userAItemId, userAItemHint);

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

      await timedJourneyStep('3. (a) A4 SSR HTML check: fetch raw SSR HTML of /app and /app/items/<A id> with A cookies and with B cookies (plus positive shell markers and unauthenticated negative control)', async () => {
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

        const expectedItemPathname = `/app/items/${userAItemId}`;

        // 1. User A's own SSR HTML for `/app` and `/app/items/<A's id>`
        const resAApp = await contextA.request.get('/app', {
          headers: { accept: 'text/html' },
        });
        expect(resAApp.status()).toBe(200);
        expect(new URL(resAApp.url()).pathname).toBe('/app');
        const htmlAApp = await resAApp.text();
        const inspectAApp = inspectSsrHtml(htmlAApp, forbiddenInASsr);
        expect(inspectAApp.hasHtmlRootAndTheme).toBe(true);
        expect(inspectAApp.hasAuthLoginShellMarker).toBe(false);
        expect(inspectAApp.matchedLabels).toEqual([]);
        expect(inspectAApp.nonEmptyDecryptedNodes).toBe(0);

        const resAItem = await contextA.request.get(expectedItemPathname, {
          headers: { accept: 'text/html' },
        });
        expect(resAItem.status()).toBe(200);
        expect(new URL(resAItem.url()).pathname).toBe(expectedItemPathname);
        const htmlAItem = await resAItem.text();
        const inspectAItem = inspectSsrHtml(htmlAItem, forbiddenInASsr);
        expect(inspectAItem.hasHtmlRootAndTheme).toBe(true);
        expect(inspectAItem.hasAuthLoginShellMarker).toBe(false);
        expect(inspectAItem.matchedLabels).toEqual([]);
        expect(inspectAItem.nonEmptyDecryptedNodes).toBe(0);

        // 2. User B's SSR HTML for `/app` and `/app/items/<A's id>` (must not contain A's body, name, hint, or tag)
        const resBApp = await contextB.request.get('/app', {
          headers: { accept: 'text/html' },
        });
        expect(resBApp.status()).toBe(200);
        expect(new URL(resBApp.url()).pathname).toBe('/app');
        const htmlBApp = await resBApp.text();
        const inspectBApp = inspectSsrHtml(htmlBApp, forbiddenInBSsr);
        expect(inspectBApp.hasHtmlRootAndTheme).toBe(true);
        expect(inspectBApp.hasAuthLoginShellMarker).toBe(false);
        expect(inspectBApp.matchedLabels).toEqual([]);
        expect(inspectBApp.nonEmptyDecryptedNodes).toBe(0);

        const resBItem = await contextB.request.get(expectedItemPathname, {
          headers: { accept: 'text/html' },
        });
        expect(resBItem.status()).toBe(200);
        expect(new URL(resBItem.url()).pathname).toBe(expectedItemPathname);
        const htmlBItem = await resBItem.text();
        const inspectBItem = inspectSsrHtml(htmlBItem, forbiddenInBSsr);
        expect(inspectBItem.hasHtmlRootAndTheme).toBe(true);
        expect(inspectBItem.hasAuthLoginShellMarker).toBe(false);
        expect(inspectBItem.matchedLabels).toEqual([]);
        expect(inspectBItem.nonEmptyDecryptedNodes).toBe(0);

        // 3. Negative controls (ACC-FE1-3):
        // (i) SSR HTML of `/app/auth/login` DOES contain the login shell marker (`hasAuthLoginShellMarker === true`),
        //     proving the positive marker check above actually distinguishes `/app` from `/app/auth/login`.
        // (ii) An unauthenticated browser context receives 401 on the item API and is redirected to `/app/auth/login`
        //      when navigating to `/app/items/<A's id>`.
        const contextUnauth = await newContextWithRateLimit(browser);
        contexts.push(contextUnauth);
        const resLoginSsr = await contextUnauth.request.get('/app/auth/login', {
          headers: { accept: 'text/html' },
        });
        expect(resLoginSsr.status()).toBe(200);
        expect(new URL(resLoginSsr.url()).pathname).toBe('/app/auth/login');
        const inspectLoginSsr = inspectSsrHtml(await resLoginSsr.text(), forbiddenInBSsr);
        expect(inspectLoginSsr.hasHtmlRootAndTheme).toBe(true);
        expect(inspectLoginSsr.hasAuthLoginShellMarker).toBe(true);

        const unauthItemApi = await contextUnauth.request.get(`/api/v1/items/${userAItemId}`);
        expect(unauthItemApi.status()).toBe(401);
        const pageUnauth = await contextUnauth.newPage();
        await pageUnauth.goto(expectedItemPathname);
        await expect(pageUnauth).toHaveURL(/\/app\/auth\/login/, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
      });

      await timedJourneyStep('4. (b) In-run check: no storageState file name and no constant passphrase in earlier test output (no automated post-run scan exists: the post-run artifact check is a manual lead procedure documented in docs/phases/evidence/P04.md)', async () => {
        const allSecretsToScan = [
          { label: 'vaultPassphrase', value: VAULT_PASSPHRASE },
          { label: 'userATextBody', value: userATextBody },
          { label: 'userAJsonToken', value: userAJsonToken },
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
