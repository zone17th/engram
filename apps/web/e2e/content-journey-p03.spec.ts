import { expect, test, type BrowserContext } from '@playwright/test';
import en from '../messages/en.json';
import {
  ACCEPTANCE_UI_WAIT_MS,
  createRequestPlaintextMonitor,
  expectInputEmptyBool,
  expectInputValueEqualsBool,
  expectNoDomOrStorageBodyLeaks,
  expectOnUnlockPageAllowingReturnTo,
  expectTextEqualsBool,
  saveAndVerifyItemHintPersisted,
  setQuietInputValue,
  timedJourneyStep,
} from './content-acceptance-support';
import { newContextWithRateLimit, uniqueEmail } from './helpers';
import {
  RECOVERED_PASSPHRASE,
  autoLockMinutesOf,
  completeRecoveryWithNewPassphrase,
  createVaultViaOnboarding,
  expectLockedListOnApp,
  expectUnlockedOnApp,
  fetchVaultMetaViaPage,
  freshRateBucket,
  loginViaUiSecret,
  openRecoveryFromUnlock,
  readVaultObservables,
  signupPasswordUser,
  submitRecoveryKey,
  submitUnlock,
  unlockFromLockedList,
} from './vault-journey-support';
import {
  CRYPTO_WAIT_MS,
  VAULT_PASSPHRASE,
  expectVaultOpen,
  expectVaultShut,
  gotoSettings,
  lockVault,
} from './vault-passkey-support';

// Note: `noCopyPrompt: true` in `playwright.config.ts` and `PLAYWRIGHT_NO_COPY_PROMPT: "1"` in `ci.yml`
// disable Playwright's automatic error-context DOM snapshot before worker startup.

const P03_REAL_ENTRIES_TIMEOUT_MS = 480_000;
const AUTO_LOCK_MINUTES = 5;

interface LookupResult {
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly entry_count: number;
  }>;
  readonly total: number;
}

interface EntriesListResult {
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly type: 'text' | 'json';
  }>;
}

test.describe('P04-T21a P03 suites re-run with real UI-created entries (locked state, lock lifecycle, recovery)', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  test('(a) locked state on /app and /app/items/<id>, (b) manual + auto-lock lifecycle wipes bodies and unlock restores them, (c) recovery with onboarding recovery key opens entry created BEFORE recovery', async ({
    browser,
  }) => {
    test.setTimeout(P03_REAL_ENTRIES_TIMEOUT_MS);

    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const itemName = `p03-real-item-${nonce.slice(0, 8)}`;
    const itemHint = `p03-real-hint-${nonce.slice(0, 8)}`;
    const textBodyBeforeRecovery = `acceptance-p03-text-before-recovery-${nonce}`;
    const jsonSecretTokenBeforeRecovery = `acceptance-p03-json-before-recovery-${nonce}`;
    const jsonRawBeforeRecovery = `{"service":"${jsonSecretTokenBeforeRecovery}","port":6379}`;
    const unsavedDraftOnP03Lock = `acceptance-p03-unsaved-draft-before-lock-${nonce}`;

    const labeledSecrets = [
      { label: 'textBodyBeforeRecovery', value: textBodyBeforeRecovery },
      { label: 'jsonSecretTokenBeforeRecovery', value: jsonSecretTokenBeforeRecovery },
      { label: 'unsavedDraftOnP03Lock', value: unsavedDraftOnP03Lock },
      { label: 'vaultPassphrase', value: VAULT_PASSPHRASE },
      { label: 'recoveredPassphrase', value: RECOVERED_PASSPHRASE },
    ] as const;
    const monitor = createRequestPlaintextMonitor(labeledSecrets);
    const contexts: BrowserContext[] = [];

    const email = uniqueEmail('content-p03-real');
    let recoveryKeySlot1 = '';
    let itemId = '';
    let textEntryId = '';
    let jsonEntryId = '';

    try {
      const contextA = await newContextWithRateLimit(browser);
      contexts.push(contextA);
      // Install fake clock before opening the page so step (b) can also exercise idle auto-lock on the item page
      await contextA.clock.install();
      monitor.attachContext(contextA);
      const page = await contextA.newPage();

      await timedJourneyStep('1. signup, onboarding (skip passkey), and create real text + JSON entries through the UI', async () => {
        await signupPasswordUser(page, email);
        const keys = await createVaultViaOnboarding(page, VAULT_PASSPHRASE, { kind: 'skip' });
        recoveryKeySlot1 = keys.slot1;
        monitor.registerSecret('recoveryKeySlot1', keys.slot1);
        monitor.registerSecret('recoveryKeySlot2', keys.slot2);
        await expectUnlockedOnApp(page);

        // Quick-add creates the item, tag #infra, and the first text entry
        const omnibox = page.getByRole('textbox', { name: en.content.omnibox.ariaLabel });
        await expect(omnibox).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await setQuietInputValue(omnibox, `${itemName} #infra: ${textBodyBeforeRecovery}`);
        await omnibox.press('Enter');
        await expectInputEmptyBool(omnibox);
        await expect(
          page.getByTestId('undo-toast-item').filter({ hasText: itemName }).first(),
        ).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });

        const lookup = await page.evaluate(async (name) => {
          const res = await fetch(`/api/v1/items/lookup?name=${encodeURIComponent(name)}`, {
            credentials: 'include',
          });
          return (await res.json()) as LookupResult;
        }, itemName);
        expect(lookup.total).toBe(1);
        itemId = lookup.items[0]!.id;

        // Open item page via client-side card click (keeps vault unlocked in memory), set a hint via UI, and create a JSON entry via the item-page composer
        const cardOnHome = page.locator(`[data-item-card="${itemId}"]`);
        await expect(cardOnHome).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await cardOnHome.click();
        await expect(page).toHaveURL(new RegExp(`/app/items/${itemId}$`), {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await saveAndVerifyItemHintPersisted(page, itemId, itemHint);
        await page.getByTestId('btn-add-json').click();
        const composer = page.getByTestId('new-json-entry-composer');
        await expect(composer).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await composer.getByTestId('new-json-tab-raw').click();
        await setQuietInputValue(
          composer.getByTestId('json-raw-textarea-new-json'),
          jsonRawBeforeRecovery,
        );
        await composer.getByTestId('json-raw-save-btn-new-json').click();
        await expect(composer).toBeHidden({ timeout: ACCEPTANCE_UI_WAIT_MS });

        await expect(page.getByTestId('entry-body')).toHaveCount(2, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });

        const entriesList = await page.evaluate(async (id) => {
          const res = await fetch(`/api/v1/items/${encodeURIComponent(id)}/entries`, {
            credentials: 'include',
          });
          return (await res.json()) as EntriesListResult;
        }, itemId);
        expect(entriesList.items).toHaveLength(2);
        textEntryId = entriesList.items.find((e) => e.type === 'text')!.id;
        jsonEntryId = entriesList.items.find((e) => e.type === 'json')!.id;
        monitor.assertNoLeaks();
      });

      await timedJourneyStep('2. (a) locked state with real entries: lock -> /app and /app/items/<id> show names, tags, and hints only, with zero entry body plaintext in the DOM', async () => {
        // Lock from the header button while on `/app/items/<id>`
        await page.getByTestId('vault-lock-button').click();
        await expectVaultShut(page);
        await expect(page.getByTestId('vault-locked-banner')).toBeVisible({
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });

        // On `/app/items/<id>`: item name, hint, tag #infra, and entry type badges stay visible; bodies are masked
        await expect(page.getByTestId('item-name-input')).toHaveValue(itemName, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expectInputValueEqualsBool(page.getByTestId('item-hint-input'), itemHint);
        await expect(page.getByTestId('item-tags')).toContainText('#infra');
        await expect(page.getByTestId('entry-body')).toHaveCount(0);
        await expect(page.getByTestId('entry-body-locked')).toHaveCount(2);
        await expect(page.getByTestId('entry-body-locked').first()).toContainText('🔒 ••••••');
        await expectNoDomOrStorageBodyLeaks(page, labeledSecrets);

        // On `/app`: locked banner + item card with name, hint, and tag #infra; zero entry bodies in DOM or storage
        await page.getByRole('link', { name: en.content.item.allItems, exact: true }).click();
        await expectLockedListOnApp(page);
        const itemCard = page.locator(`[data-item-card="${itemId}"]`);
        await expect(itemCard).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await expect(itemCard).toContainText(itemName, { timeout: ACCEPTANCE_UI_WAIT_MS });
        await expect(itemCard).toContainText(itemHint, { timeout: ACCEPTANCE_UI_WAIT_MS });
        await expect(itemCard).toContainText('#infra', { timeout: ACCEPTANCE_UI_WAIT_MS });
        await expectNoDomOrStorageBodyLeaks(page, labeledSecrets);
        monitor.assertNoLeaks();
      });

      await timedJourneyStep('3. (b) lock lifecycle: unlock restores decrypted bodies -> idle auto-lock and manual lock wipe bodies -> unlock shows them again', async () => {
        // Unlock from locked list and configure 5-minute auto-lock in Settings
        await unlockFromLockedList(page, VAULT_PASSPHRASE);
        await gotoSettings(page);
        const autoLockCard = page.getByTestId('settings-auto-lock-card');
        await expect(autoLockCard).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        const patch5 = page.waitForResponse(
          (r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === '/api/v1/me/settings',
          { timeout: ACCEPTANCE_UI_WAIT_MS },
        );
        await autoLockCard.getByRole('radio', { name: en.vault.b.settings.autoLock.opt5, exact: true }).click();
        const patch5Res = await patch5;
        expect(patch5Res.status()).toBe(200);
        expect(autoLockMinutesOf(await patch5Res.json().catch(() => null))).toBe(AUTO_LOCK_MINUTES);
        await expect
          .poll(async () => (await readVaultObservables(page)).autoLockMinutes, {
            timeout: ACCEPTANCE_UI_WAIT_MS,
          })
          .toBe(AUTO_LOCK_MINUTES);

        // Leave Settings via the Done link and open the item page via client-side card click so the vault stays unlocked
        await page.getByRole('link', { name: en.app.header.settingsDone, exact: true }).click();
        await expect(page).toHaveURL(/\/app$/, { timeout: ACCEPTANCE_UI_WAIT_MS });
        const cardAfterSettings = page.locator(`[data-item-card="${itemId}"]`);
        await expect(cardAfterSettings).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await cardAfterSettings.click();
        await expect(page).toHaveURL(new RegExp(`/app/items/${itemId}$`), {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expectVaultOpen(page);
        await expectTextEqualsBool(
          page.getByTestId(`entry-card-${textEntryId}`).getByTestId('entry-body'),
          textBodyBeforeRecovery,
        );
        await expectTextEqualsBool(
          page.getByTestId(`entry-card-${jsonEntryId}`).getByTestId('json-cell-btn-root.p0'),
          jsonSecretTokenBeforeRecovery,
        );

        // Advance clock past the 5-minute auto-lock deadline -> vault auto-locks and wipes entry bodies from DOM and storage
        await contextA.clock.fastForward(AUTO_LOCK_MINUTES * 60_000 + 30_000);
        await contextA.clock.runFor(1_000);
        await expectVaultShut(page);
        await expect(page.getByTestId('vault-locked-banner')).toBeVisible({
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expect(page.getByTestId('entry-body')).toHaveCount(0);
        await expect(page.getByTestId('entry-body-locked')).toHaveCount(2);
        await expectNoDomOrStorageBodyLeaks(page, labeledSecrets);

        // Unlock from the item-page locked banner -> bodies decrypt again
        await page.getByTestId('vault-locked-unlock-cta').click();
        await expectOnUnlockPageAllowingReturnTo(page);
        await submitUnlock(page, VAULT_PASSPHRASE);
        await expect(page).toHaveURL(new RegExp(`/app/items/${itemId}$`), {
          timeout: CRYPTO_WAIT_MS,
        });
        await expectTextEqualsBool(
          page.getByTestId(`entry-card-${textEntryId}`).getByTestId('entry-body'),
          textBodyBeforeRecovery,
        );
        await expectTextEqualsBool(
          page.getByTestId(`entry-card-${jsonEntryId}`).getByTestId('json-cell-btn-root.p0'),
          jsonSecretTokenBeforeRecovery,
        );

        // Open a text editor with an unsaved draft, then manual lock -> editor unmounts and draft + bodies are wiped from DOM and storage (ACC-FE1-4)
        const textCard = page.getByTestId(`entry-card-${textEntryId}`);
        await textCard.getByTestId(`entry-edit-btn-${textEntryId}`).click();
        const draftTextarea = textCard.getByTestId(`entry-edit-textarea-${textEntryId}`);
        await expect(draftTextarea).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await setQuietInputValue(draftTextarea, unsavedDraftOnP03Lock);
        await expectInputValueEqualsBool(draftTextarea, unsavedDraftOnP03Lock);

        await page.getByTestId('vault-lock-button').click();
        await expectVaultShut(page);
        await expect(draftTextarea).toHaveCount(0);
        // The omnibox textarea stays mounted while locked; it must be empty. Every other textarea (editors) must be gone.
        await expect(page.locator('textarea:not([data-omnibox-input])')).toHaveCount(0);
        expect(
          await page.locator('textarea[data-omnibox-input]').evaluateAll((els) => els.every((el) => (el as HTMLTextAreaElement).value === '')),
        ).toBe(true);
        await expect(page.getByTestId('entry-body')).toHaveCount(0);
        await expectNoDomOrStorageBodyLeaks(page, labeledSecrets);
        monitor.assertNoLeaks();
      });

      await timedJourneyStep('4. (c) recovery with onboarding recovery key -> unlock with new passphrase -> entry created BEFORE recovery decrypts with the exact same body', async () => {
        await freshRateBucket(page);
        await page.getByTestId('vault-locked-unlock-cta').click();
        await expectOnUnlockPageAllowingReturnTo(page);

        const metaBeforeRecovery = await fetchVaultMetaViaPage(page);
        expect(metaBeforeRecovery.status).toBe(200);
        expect(typeof metaBeforeRecovery.version).toBe('number');

        await openRecoveryFromUnlock(page, { kind: 'password' });
        const lookupRes = await submitRecoveryKey(page, recoveryKeySlot1);
        expect(lookupRes.ok()).toBe(true);
        const newVaultVersion = await completeRecoveryWithNewPassphrase(page, RECOVERED_PASSPHRASE);
        expect(newVaultVersion).toBe((metaBeforeRecovery.version ?? 1) + 1);

        // Lock and explicitly unlock with the new passphrase in a fresh browser context to prove end-to-end persistence
        await lockVault(page);
        await contextA.close();

        const contextB = await newContextWithRateLimit(browser);
        contexts.push(contextB);
        monitor.attachContext(contextB);
        const pageB = await contextB.newPage();

        await loginViaUiSecret(pageB, email);
        await expectOnUnlockPageAllowingReturnTo(pageB);
        await submitUnlock(pageB, RECOVERED_PASSPHRASE);
        await expectUnlockedOnApp(pageB);

        // Open the item via client-side card click (keeps vault unlocked) and verify both entries created BEFORE recovery open with the exact same plaintext
        const cardOnPageB = pageB.locator(`[data-item-card="${itemId}"]`);
        await expect(cardOnPageB).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await cardOnPageB.click();
        await expect(pageB).toHaveURL(new RegExp(`/app/items/${itemId}$`), {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expectTextEqualsBool(
          pageB.getByTestId(`entry-card-${textEntryId}`).getByTestId('entry-body'),
          textBodyBeforeRecovery,
        );
        await expectTextEqualsBool(
          pageB.getByTestId(`entry-card-${jsonEntryId}`).getByTestId('json-cell-btn-root.p0'),
          jsonSecretTokenBeforeRecovery,
        );
        monitor.assertNoLeaks();
      });

      // T20: reset step with real entries goes here
    } finally {
      for (const ctx of contexts) {
        await ctx.close().catch(() => undefined);
      }
    }
  });
});
