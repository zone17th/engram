import { expect, test, type BrowserContext } from '@playwright/test';
import en from '../messages/en.json';
import {
  ACCEPTANCE_UI_WAIT_MS,
  createRequestPlaintextMonitor,
  expectInputEmptyBool,
  expectInputValueEqualsBool,
  findLabeledDomBodyLeaks,
  setQuietInputValue,
  timedJourneyStep,
} from './content-acceptance-support';
import { newContextWithRateLimit, uniqueEmail } from './helpers';
import {
  createVaultViaOnboarding,
  expectLockedListOnApp,
  expectUnlockedOnApp,
  loginViaUiSecret,
  signupPasswordUser,
  submitUnlock,
  unlockFromLockedList,
} from './vault-journey-support';
import { CRYPTO_WAIT_MS, VAULT_PASSPHRASE, expectOnUnlockPage, expectVaultShut } from './vault-passkey-support';

// Disable Playwright's automatic error-context DOM snapshot in this worker before any test runs,
// so a failure while a recovery-key sheet or decrypted entry is mounted never serializes secrets to disk.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

const JOURNEY_TIMEOUT_MS = 480_000;

interface LookupResult {
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly entry_count: number;
    readonly tags: ReadonlyArray<{ readonly id: string; readonly display: string }>;
  }>;
  readonly total: number;
}

interface EntriesListResult {
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly type: 'text' | 'json';
    readonly position: number;
    readonly version: number;
  }>;
}

test.describe('P04-T21a content real-stack journey (A3, A4, A5, A6, A8, A9, A10)', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  test('signup -> onboarding (skip passkey) -> omnibox quick-add 0/1/n (picker keyboard) -> item text edit (incl. offline draft retention + Retry) -> JSON composer & lossless cell edit (incl. offline Retry) -> new context unlock -> delete & Undo (entry toast + Ctrl+Z, item delete + Undo without resurrecting prior-deleted entry) -> lock wipes DOM', async ({
    browser,
  }) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS);

    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const bodyMatch0 = `acceptance-body-match0-${nonce}`;
    const bodyMatch1 = `acceptance-body-match1-${nonce}`;
    const bodyDupItem2Init = `acceptance-body-dup2-init-${nonce}`;
    const bodyMatchNPicked = `acceptance-body-matchN-picked-${nonce}`;
    const bodyMatch0Edited = `acceptance-body-match0-edited-${nonce}`;
    const jsonSecretTokenInit = `acceptance-json-token-init-${nonce}`;
    const jsonSecretTokenEdited = `acceptance-json-token-edited-${nonce}`;
    const jsonSiblingKeep = `acceptance-json-sibling-keep-${nonce}`;

    // Deliberately irregular whitespace, key ordering, escapes, and 64-bit integer lexeme outside the edited cell span
    // so byte-for-byte comparison proves lossless span splicing (P04-A6).
    const jsonInitialRaw = `{\n  "service" :  "${jsonSecretTokenInit}" ,\n    "port": 5432,\n\t"snowflake_id": 9007199254740993,\n  "escaped_path": "a\\/b\\u00e9",\n  "sibling": "${jsonSiblingKeep}"\n}`;
    const jsonExpectedAfterEdit = `{\n  "service" :  "${jsonSecretTokenEdited}" ,\n    "port": 5432,\n\t"snowflake_id": 9007199254740993,\n  "escaped_path": "a\\/b\\u00e9",\n  "sibling": "${jsonSiblingKeep}"\n}`;

    const labeledSecrets = [
      { label: 'bodyMatch0', value: bodyMatch0 },
      { label: 'bodyMatch1', value: bodyMatch1 },
      { label: 'bodyDupItem2Init', value: bodyDupItem2Init },
      { label: 'bodyMatchNPicked', value: bodyMatchNPicked },
      { label: 'bodyMatch0Edited', value: bodyMatch0Edited },
      { label: 'jsonSecretTokenInit', value: jsonSecretTokenInit },
      { label: 'jsonSecretTokenEdited', value: jsonSecretTokenEdited },
      { label: 'jsonSiblingKeep', value: jsonSiblingKeep },
      { label: 'vaultPassphrase', value: VAULT_PASSPHRASE },
    ] as const;

    const monitor = createRequestPlaintextMonitor(labeledSecrets);
    const contexts: BrowserContext[] = [];

    const email = uniqueEmail('content-journey');
    const itemName = `journey-item-${nonce.slice(0, 8)}`;
    let item1Id = '';
    let item2Id = '';
    let entry0Id = '';
    let entry1Id = '';
    let entry2Id = '';
    let jsonEntryId = '';

    try {
      const contextA = await newContextWithRateLimit(browser);
      contexts.push(contextA);
      monitor.attachContext(contextA);
      const pageA = await contextA.newPage();

      await timedJourneyStep('1. signup (email confirm via mail sink when required) and create vault via onboarding with step 3 passkey skip', async () => {
        await signupPasswordUser(pageA, email);
        const keys = await createVaultViaOnboarding(pageA, VAULT_PASSPHRASE, { kind: 'skip' });
        monitor.registerSecret('recoveryKeySlot1', keys.slot1);
        monitor.registerSecret('recoveryKeySlot2', keys.slot2);
        await expectUnlockedOnApp(pageA);
        monitor.assertNoLeaks();
      });

      await timedJourneyStep('2. quick-add 0 matches (first save right after onboarding skip posts via advisor-dec-200 reloadVaultMeta), then 1 match, then n matches via U9 picker keyboard', async () => {
        const omnibox = pageA.getByRole('textbox', { name: en.content.omnibox.ariaLabel });
        await expect(omnibox).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });

        // 0 matches: creates item1 + tag #ops + entry0
        await setQuietInputValue(omnibox, `${itemName} #ops: ${bodyMatch0}`);
        await omnibox.press('Enter');
        await expectInputEmptyBool(omnibox);
        await expect(
          pageA.getByTestId('undo-toast-item').filter({ hasText: itemName }).first(),
        ).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });

        const lookupAfter0 = await pageA.evaluate(async (name) => {
          const res = await fetch(`/api/v1/items/lookup?name=${encodeURIComponent(name)}`, {
            credentials: 'include',
          });
          return (await res.json()) as LookupResult;
        }, itemName);
        expect(lookupAfter0.total).toBe(1);
        expect(lookupAfter0.items[0]?.entry_count).toBe(1);
        item1Id = lookupAfter0.items[0]!.id;

        // 1 match: appends entry1 to the existing item1
        await setQuietInputValue(omnibox, `${itemName}: ${bodyMatch1}`);
        await omnibox.press('Enter');
        await expectInputEmptyBool(omnibox);

        const lookupAfter1 = await pageA.evaluate(async (name) => {
          const res = await fetch(`/api/v1/items/lookup?name=${encodeURIComponent(name)}`, {
            credentials: 'include',
          });
          return (await res.json()) as LookupResult;
        }, itemName);
        expect(lookupAfter1.total).toBe(1);
        expect(lookupAfter1.items[0]?.id).toBe(item1Id);
        expect(lookupAfter1.items[0]?.entry_count).toBe(2);

        // Create a 2nd item with the exact same name via Control+Enter so lookup returns n=2 matches
        await setQuietInputValue(omnibox, `${itemName} #home: ${bodyDupItem2Init}`);
        await omnibox.press('Control+Enter');
        await expectInputEmptyBool(omnibox);

        const lookupTwo = await pageA.evaluate(async (name) => {
          const res = await fetch(`/api/v1/items/lookup?name=${encodeURIComponent(name)}`, {
            credentials: 'include',
          });
          return (await res.json()) as LookupResult;
        }, itemName);
        expect(lookupTwo.total).toBe(2);
        // Lookup orders by `created_at DESC, id`: index 0 is the newer item2, index 1 is the older item1
        const foundItem1Idx = lookupTwo.items.findIndex((it) => it.id === item1Id);
        const foundItem2Idx = lookupTwo.items.findIndex((it) => it.id !== item1Id);
        expect(foundItem1Idx).toBeGreaterThanOrEqual(0);
        expect(foundItem2Idx).toBeGreaterThanOrEqual(0);
        item2Id = lookupTwo.items[foundItem2Idx]!.id;

        // n matches: press Enter -> U9 duplicate picker opens -> choose item1 by keyboard (ArrowDown + Enter)
        await setQuietInputValue(omnibox, `${itemName}: ${bodyMatchNPicked}`);
        await omnibox.press('Enter');

        const pickerDialog = pageA.getByTestId('dup-picker-dialog');
        await expect(pickerDialog).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        const listbox = pickerDialog.getByRole('listbox');
        await expect(listbox).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });

        // Navigate with ArrowDown until `item1Id` option has `aria-selected="true"`, then press Enter
        for (let step = 0; step < lookupTwo.items.length + 1; step += 1) {
          const isTargetSelected = await pageA
            .locator(`#dup-opt-${item1Id}`)
            .getAttribute('aria-selected');
          if (isTargetSelected === 'true') break;
          await pageA.keyboard.press('ArrowDown');
        }
        await expect(pageA.locator(`#dup-opt-${item1Id}`)).toHaveAttribute('aria-selected', 'true');
        await pageA.keyboard.press('Enter');

        await expect(pickerDialog).toBeHidden({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await expectInputEmptyBool(omnibox);
        await expect(omnibox).toBeFocused({ timeout: ACCEPTANCE_UI_WAIT_MS });

        // Assert the entry landed in the chosen item1 (entry_count 2 -> 3) and NOT in item2 (entry_count stays 1)
        const lookupAfterPick = await pageA.evaluate(async (name) => {
          const res = await fetch(`/api/v1/items/lookup?name=${encodeURIComponent(name)}`, {
            credentials: 'include',
          });
          return (await res.json()) as LookupResult;
        }, itemName);
        expect(lookupAfterPick.total).toBe(2);
        const item1After = lookupAfterPick.items.find((it) => it.id === item1Id);
        const item2After = lookupAfterPick.items.find((it) => it.id === item2Id);
        expect(item1After?.entry_count).toBe(3);
        expect(item2After?.entry_count).toBe(1);
        monitor.assertNoLeaks();
      });

      await timedJourneyStep('3. open item page, edit a text entry while offline (draft preserved + Retry box shown, A10), go online + Retry to save, reload, unlock, and see the updated text', async () => {
        const cardItem1OnHome = pageA.locator(`[data-item-card="${item1Id}"]`);
        await expect(cardItem1OnHome).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await cardItem1OnHome.click();
        await expect(pageA).toHaveURL(new RegExp(`/app/items/${item1Id}$`), {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expect(pageA.getByTestId('item-name-input')).toHaveValue(itemName, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expect(pageA.getByTestId('entry-body')).toHaveCount(3, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });

        const entriesMeta = await pageA.evaluate(async (id) => {
          const res = await fetch(`/api/v1/items/${encodeURIComponent(id)}/entries`, {
            credentials: 'include',
          });
          return (await res.json()) as EntriesListResult;
        }, item1Id);
        expect(entriesMeta.items).toHaveLength(3);
        entry0Id = entriesMeta.items[0]!.id;
        entry1Id = entriesMeta.items[1]!.id;
        entry2Id = entriesMeta.items[2]!.id;

        const card0 = pageA.getByTestId(`entry-card-${entry0Id}`);
        await expect(card0.getByTestId('entry-body')).toHaveText(bodyMatch0, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });

        await card0.getByTestId(`entry-edit-btn-${entry0Id}`).click();
        const editTextarea = card0.getByTestId(`entry-edit-textarea-${entry0Id}`);
        await expect(editTextarea).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await setQuietInputValue(editTextarea, bodyMatch0Edited);

        // P04-A10 offline/network error keeps draft: go offline -> press Save -> error/Retry box appears and textarea still holds draft
        await contextA.setOffline(true);
        try {
          await card0.getByTestId(`entry-save-btn-${entry0Id}`).click();
          const retryBox = card0.getByTestId(`entry-save-retry-box-${entry0Id}`);
          await expect(retryBox).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
          await expectInputValueEqualsBool(editTextarea, bodyMatch0Edited);
          monitor.assertNoLeaks();
        } finally {
          await contextA.setOffline(false);
        }

        // Go back online and press Retry -> save completes with the exact sealed payload
        await card0.getByTestId(`entry-retry-save-${entry0Id}`).click();
        await expect(card0.getByTestId('entry-body')).toHaveText(bodyMatch0Edited, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });

        // Reload page -> vault locks on full reload (in-memory key cleared) -> unlock from banner -> returns to item page and shows edited text
        await pageA.reload();
        await expect(pageA.getByTestId('vault-locked-banner')).toBeVisible({
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await pageA.getByTestId('vault-locked-unlock-cta').click();
        await expectOnUnlockPage(pageA);
        await submitUnlock(pageA, VAULT_PASSPHRASE);
        await expect(pageA).toHaveURL(new RegExp(`/app/items/${item1Id}$`), {
          timeout: CRYPTO_WAIT_MS,
        });
        await expect(pageA.getByTestId(`entry-card-${entry0Id}`).getByTestId('entry-body')).toHaveText(
          bodyMatch0Edited,
          { timeout: ACCEPTANCE_UI_WAIT_MS },
        );
        monitor.assertNoLeaks();
      });

      // T17: import JSON step goes here

      await timedJourneyStep('4. create a JSON entry via the item-page composer, edit one cell in Table view (U13), test offline Retry (A10), save, reload, and verify lossless raw byte preservation outside the edited span (A6)', async () => {
        await pageA.getByTestId('btn-add-json').click();
        const composer = pageA.getByTestId('new-json-entry-composer');
        await expect(composer).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });

        // Switch composer to Raw JSON tab and enter the unformatted/irregular-whitespace JSON source
        await composer.getByTestId('new-json-tab-raw').click();
        const composerRawTextarea = composer.getByTestId('json-raw-textarea-new-json');
        await setQuietInputValue(composerRawTextarea, jsonInitialRaw);
        await composer.getByTestId('json-raw-save-btn-new-json').click();
        await expect(composer).toBeHidden({ timeout: ACCEPTANCE_UI_WAIT_MS });

        const entriesAfterJsonCreate = await pageA.evaluate(async (id) => {
          const res = await fetch(`/api/v1/items/${encodeURIComponent(id)}/entries`, {
            credentials: 'include',
          });
          return (await res.json()) as EntriesListResult;
        }, item1Id);
        expect(entriesAfterJsonCreate.items).toHaveLength(4);
        const createdJsonMeta = entriesAfterJsonCreate.items.find((e) => e.type === 'json');
        expect(createdJsonMeta).toBeDefined();
        jsonEntryId = createdJsonMeta!.id;

        const jsonCard = pageA.getByTestId(`entry-card-${jsonEntryId}`);
        await expect(jsonCard).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await expect(jsonCard.getByRole('treegrid')).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });

        // Edit one cell (`root.p0`, the value of `"service"`) in Table view
        const serviceCellBtn = jsonCard.getByTestId('json-cell-btn-root.p0');
        await expect(serviceCellBtn).toHaveText(jsonSecretTokenInit, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await serviceCellBtn.click();

        const cellInput = jsonCard.getByTestId('json-cell-input-root.p0');
        await expect(cellInput).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await setQuietInputValue(cellInput, jsonSecretTokenEdited);
        await cellInput.press('Enter');

        await expect(serviceCellBtn).toHaveText(jsonSecretTokenEdited, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });

        // P04-A10 offline draft retention on JSON card: go offline -> press Save -> Retry box appears and edited cell stays intact
        await contextA.setOffline(true);
        try {
          await jsonCard.getByTestId(`entry-save-btn-${jsonEntryId}`).click();
          const jsonRetryBox = jsonCard.getByTestId(`entry-save-retry-box-${jsonEntryId}`);
          await expect(jsonRetryBox).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
          await expect(serviceCellBtn).toHaveText(jsonSecretTokenEdited);
          monitor.assertNoLeaks();
        } finally {
          await contextA.setOffline(false);
        }

        // Go back online and press Retry on JSON card -> save succeeds
        await jsonCard.getByTestId(`entry-retry-save-btn-${jsonEntryId}`).click();
        await expect(jsonCard.getByTestId('entry-saved-badge')).toBeVisible({
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });

        // Reload -> unlock -> switch to Raw JSON view and compare every byte outside the edited span
        await pageA.reload();
        await expect(pageA.getByTestId('vault-locked-banner')).toBeVisible({
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await pageA.getByTestId('vault-locked-unlock-cta').click();
        await expectOnUnlockPage(pageA);
        await submitUnlock(pageA, VAULT_PASSPHRASE);
        await expect(pageA).toHaveURL(new RegExp(`/app/items/${item1Id}$`), {
          timeout: CRYPTO_WAIT_MS,
        });

        const reloadedJsonCard = pageA.getByTestId(`entry-card-${jsonEntryId}`);
        await expect(reloadedJsonCard.getByTestId('json-cell-btn-root.p0')).toHaveText(
          jsonSecretTokenEdited,
          { timeout: ACCEPTANCE_UI_WAIT_MS },
        );
        await expect(reloadedJsonCard.getByTestId('json-cell-btn-root.p2')).toHaveText(
          '9007199254740993',
          { timeout: ACCEPTANCE_UI_WAIT_MS },
        );

        await reloadedJsonCard.getByTestId(`json-tab-raw-${jsonEntryId}`).click();
        const rawTextarea = reloadedJsonCard.getByTestId(`json-raw-textarea-${jsonEntryId}`);
        await expect(rawTextarea).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await expectInputValueEqualsBool(rawTextarea, jsonExpectedAfterEdit);
        await reloadedJsonCard.getByTestId(`json-tab-table-${jsonEntryId}`).click();
        monitor.assertNoLeaks();
      });

      await contextA.close();

      const contextB = await newContextWithRateLimit(browser);
      contexts.push(contextB);
      monitor.attachContext(contextB);
      const pageB = await contextB.newPage();

      await timedJourneyStep('5. open a new browser context, log in, unlock with passphrase, and verify every item, tag, and entry body decrypts accurately', async () => {
        await loginViaUiSecret(pageB, email);
        await expectOnUnlockPage(pageB);
        await pageB.goto('/app');
        await expectLockedListOnApp(pageB);
        await unlockFromLockedList(pageB, VAULT_PASSPHRASE);

        // Home page shows both items and their tags (#ops and #home)
        await expect(pageB.getByTestId('item-card')).toHaveCount(2, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        const cardItem1 = pageB.locator(`[data-item-card="${item1Id}"]`);
        const cardItem2 = pageB.locator(`[data-item-card="${item2Id}"]`);
        await expect(cardItem1).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await expect(cardItem1).toContainText('#ops');
        await expect(cardItem2).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await expect(cardItem2).toContainText('#home');

        // Navigate to item1 page and check all 4 decrypted entries (3 text + 1 JSON)
        await cardItem1.click();
        await expect(pageB).toHaveURL(new RegExp(`/app/items/${item1Id}$`), {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expect(pageB.getByTestId('item-tags')).toContainText('#ops');
        await expect(pageB.getByTestId('entry-body')).toHaveCount(4, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });

        await expect(pageB.getByTestId(`entry-card-${entry0Id}`).getByTestId('entry-body')).toHaveText(
          bodyMatch0Edited,
          { timeout: ACCEPTANCE_UI_WAIT_MS },
        );
        await expect(pageB.getByTestId(`entry-card-${entry1Id}`).getByTestId('entry-body')).toHaveText(
          bodyMatch1,
          { timeout: ACCEPTANCE_UI_WAIT_MS },
        );
        await expect(pageB.getByTestId(`entry-card-${entry2Id}`).getByTestId('entry-body')).toHaveText(
          bodyMatchNPicked,
          { timeout: ACCEPTANCE_UI_WAIT_MS },
        );
        await expect(
          pageB.getByTestId(`entry-card-${jsonEntryId}`).getByTestId('json-cell-btn-root.p0'),
        ).toHaveText(jsonSecretTokenEdited, { timeout: ACCEPTANCE_UI_WAIT_MS });
        monitor.assertNoLeaks();
      });

      await timedJourneyStep('6. delete an entry and Undo via toast button, delete a second time and Undo via Ctrl+Z, then delete an entry permanently followed by whole-item delete + Undo (restores item, tags, and live entries without resurrecting the separately deleted entry: A8)', async () => {
        const card1 = pageB.getByTestId(`entry-card-${entry1Id}`);
        await expect(card1).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });

        // First delete -> Undo via toast button click
        await card1.getByTestId(`entry-menu-trigger-${entry1Id}`).click();
        await card1.getByTestId(`entry-menu-delete-${entry1Id}`).click();
        await expect(card1).toHaveCount(0, { timeout: ACCEPTANCE_UI_WAIT_MS });

        const undoToastBtn = pageB
          .getByTestId('undo-toast-stack')
          .getByRole('button', { name: new RegExp(en.content.item.undoAction, 'i') })
          .first();
        await expect(undoToastBtn).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await undoToastBtn.click();

        await expect(pageB.getByTestId(`entry-card-${entry1Id}`)).toBeVisible({
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expect(pageB.getByTestId(`entry-card-${entry1Id}`).getByTestId('entry-body')).toHaveText(
          bodyMatch1,
          { timeout: ACCEPTANCE_UI_WAIT_MS },
        );

        // Second delete -> Undo via Ctrl+Z keyboard shortcut
        await card1.getByTestId(`entry-menu-trigger-${entry1Id}`).click();
        await card1.getByTestId(`entry-menu-delete-${entry1Id}`).click();
        await expect(card1).toHaveCount(0, { timeout: ACCEPTANCE_UI_WAIT_MS });
        await expect(pageB.getByTestId('undo-toast-item').first()).toBeVisible({
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });

        await pageB.keyboard.press('Control+z');
        await expect(pageB.getByTestId(`entry-card-${entry1Id}`)).toBeVisible({
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expect(pageB.getByTestId(`entry-card-${entry1Id}`).getByTestId('entry-body')).toHaveText(
          bodyMatch1,
          { timeout: ACCEPTANCE_UI_WAIT_MS },
        );

        // Delete `entry2Id` on its own and do NOT undo it (leaving 3 live entries: entry0Id, entry1Id, jsonEntryId)
        const card2 = pageB.getByTestId(`entry-card-${entry2Id}`);
        await card2.getByTestId(`entry-menu-trigger-${entry2Id}`).click();
        await card2.getByTestId(`entry-menu-delete-${entry2Id}`).click();
        await expect(card2).toHaveCount(0, { timeout: ACCEPTANCE_UI_WAIT_MS });
        await expect(pageB.getByTestId('entry-body')).toHaveCount(3, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });

        // Delete the whole item via `btn-delete-item` -> navigates to `/app` and shows item-deleted Undo toast
        await pageB.getByTestId('btn-delete-item').click();
        await expect(pageB).toHaveURL(/\/app$/, { timeout: ACCEPTANCE_UI_WAIT_MS });
        await expect(pageB.locator(`[data-item-card="${item1Id}"]`)).toHaveCount(0, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });

        const itemDeletedToast = pageB
          .getByTestId('undo-toast-item')
          .filter({ hasText: itemName })
          .first();
        await expect(itemDeletedToast).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await itemDeletedToast
          .getByRole('button', { name: new RegExp(en.content.item.undoAction, 'i') })
          .click();

        // Undo navigates back to `/app/items/<item1Id>` with its tag `#ops` and the 3 live entries restored,
        // while `entry2Id` (deleted separately before the item delete) remains deleted (P04-A8 provenance rule).
        await expect(pageB).toHaveURL(new RegExp(`/app/items/${item1Id}$`), {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expect(pageB.getByTestId('item-name-input')).toHaveValue(itemName, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expect(pageB.getByTestId('item-tags')).toContainText('#ops');
        await expect(pageB.getByTestId('entry-body')).toHaveCount(3, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expect(pageB.getByTestId(`entry-card-${entry0Id}`).getByTestId('entry-body')).toHaveText(
          bodyMatch0Edited,
          { timeout: ACCEPTANCE_UI_WAIT_MS },
        );
        await expect(pageB.getByTestId(`entry-card-${entry1Id}`).getByTestId('entry-body')).toHaveText(
          bodyMatch1,
          { timeout: ACCEPTANCE_UI_WAIT_MS },
        );
        await expect(
          pageB.getByTestId(`entry-card-${jsonEntryId}`).getByTestId('json-cell-btn-root.p0'),
        ).toHaveText(jsonSecretTokenEdited, { timeout: ACCEPTANCE_UI_WAIT_MS });
        await expect(pageB.getByTestId(`entry-card-${entry2Id}`)).toHaveCount(0);
        monitor.assertNoLeaks();
      });

      await timedJourneyStep('7. lock vault -> no decrypted entry body in the DOM (A9)', async () => {
        await pageB.getByTestId('vault-lock-button').click();
        await expectVaultShut(pageB);
        await expect(pageB.getByTestId('vault-locked-banner')).toBeVisible({
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expect(pageB.getByTestId('entry-body')).toHaveCount(0);
        await expect(pageB.getByTestId('entry-body-locked')).toHaveCount(3);

        const domLeaksOnItem = await findLabeledDomBodyLeaks(pageB, labeledSecrets);
        expect(domLeaksOnItem).toEqual([]);

        // Navigate back to /app locked list via the breadcrumb link and confirm zero DOM leaks there too
        await pageB.getByRole('link', { name: en.content.item.allItems, exact: true }).click();
        await expectLockedListOnApp(pageB);
        const domLeaksOnHome = await findLabeledDomBodyLeaks(pageB, labeledSecrets);
        expect(domLeaksOnHome).toEqual([]);

        expect(monitor.getRequestCount()).toBeGreaterThan(0);
        monitor.assertNoLeaks();
      });

      // T20: reset step goes here
    } finally {
      for (const ctx of contexts) {
        await ctx.close().catch(() => undefined);
      }
    }
  });
});
