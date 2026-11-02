import { expect, test, type BrowserContext } from '@playwright/test';
import en from '../messages/en.json';
import {
  ACCEPTANCE_UI_WAIT_MS,
  createRequestPlaintextMonitor,
  executeVaultResetAndClickCreateNewVault,
  expectInputEmptyBool,
  expectInputValueEqualsBool,
  expectNoDomOrStorageBodyLeaks,
  expectOnUnlockPageAllowingReturnTo,
  expectServerItemAndLiveEntryIds,
  expectServerHoldsOpaqueCiphertext,
  expectServerItemsHaveZeroEntries,
  expectTextEqualsBool,
  fetchServerItemsAndTagsSnapshot,
  retryReplaysSameRequest,
  setQuietInputValue,
  setQuietJsonFileInput,
  timedJourneyStep,
  triggerFocusWake,
  verifyRetryReplayCheckNegativeControl,
  verifyStorageAndCacheScannerPositiveControl,
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
import { CRYPTO_WAIT_MS, VAULT_PASSPHRASE, expectVaultShut } from './vault-passkey-support';

// Note: `noCopyPrompt: true` in `playwright.config.ts` and `PLAYWRIGHT_NO_COPY_PROMPT: "1"` in `ci.yml`
// disable Playwright's automatic error-context DOM snapshot before worker startup.

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

  test('signup -> onboarding (skip passkey) -> omnibox quick-add 0/1/n (picker keyboard) -> item text edit (incl. offline draft retention + Retry) -> import JSON (CRLF file + nested objects + newline string + offline Retry idempotency) -> JSON composer & lossless cell edit (incl. offline Retry) -> new context unlock -> delete & Undo (entry toast + Ctrl+Z, item delete + Undo proven via server API) -> lock wipes open draft, DOM, and storage -> multi-context focus sync + vault reset keeps items/tags and deletes all entries', async ({
    browser,
  }) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS);

    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const bodyMatch0 = `acceptance-body-match0-${nonce}`;
    const bodyMatch1 = `acceptance-body-match1-${nonce}`;
    const bodyDupItem2Init = `acceptance-body-dup2-init-${nonce}`;
    const bodyMatchNPicked = `acceptance-body-matchN-picked-${nonce}`;
    const bodyMatch0Edited = `acceptance-body-match0-edited-${nonce}`;
    const bodyMatch0SyncedFromA = `acceptance-body-match0-synced-from-A-${nonce}`;
    const postResetVaultPassphrase = `acceptance-reset-vault-passphrase-${nonce}!`;
    const unsavedDraftBeforeLock = `acceptance-unsaved-draft-before-lock-${nonce}`;
    const omniboxDraftBeforeLock = `acceptance-omnibox-draft-before-lock-${nonce}`;
    const jsonSecretTokenInit = `acceptance-json-token-init-${nonce}`;
    const jsonSecretTokenEdited = `acceptance-json-token-edited-${nonce}`;
    const jsonSiblingKeep = `acceptance-json-sibling-keep-${nonce}`;
    const importJsonToken = `acceptance-import-json-token-${nonce}`;
    const importJsonNestedSecret = `acceptance-import-nested-secret-${nonce}`;
    const importJsonNoteLine1 = `acceptance-import-note-line1-${nonce}`;
    const importJsonNoteLine2 = `acceptance-import-note-line2-${nonce}`;

    // Deliberately irregular whitespace, key ordering, escapes (including \n in sibling), and 64-bit integer lexeme
    // outside the edited cell span so byte-for-byte comparison proves lossless span splicing (P04-A6, ACC-FE1-7).
    const jsonInitialRaw = `{\n  "service" :  "${jsonSecretTokenInit}" ,\n    "port": 5432,\n\t"snowflake_id": 9007199254740993,\n  "escaped_path": "a\\/b\\u00e9",\n  "sibling": "${jsonSiblingKeep}\\nline2"\n}`;
    const jsonExpectedAfterEdit = `{\n  "service" :  "${jsonSecretTokenEdited}" ,\n    "port": 5432,\n\t"snowflake_id": 9007199254740993,\n  "escaped_path": "a\\/b\\u00e9",\n  "sibling": "${jsonSiblingKeep}\\nline2"\n}`;


    // T17 import JSON fixture: nested objects, a string with \n, and CRLF (\r\n) line endings (P04-A6 file path byte-exact).
    const importJsonCrlfFixture = `{\r\n  "cluster": "${importJsonToken}",\r\n  "nested": {\r\n    "endpoint": "https://db.internal:5432",\r\n    "credentials": {\r\n      "secret": "${importJsonNestedSecret}",\r\n      "retries": 3\r\n    }\r\n  },\r\n  "multiline_note": "${importJsonNoteLine1}\\n${importJsonNoteLine2}"\r\n}\r\n`;
    const importJsonDisplayNormalized = importJsonCrlfFixture.replace(/\r\n/g, '\n');
    const labeledSecrets = [
      { label: 'bodyMatch0', value: bodyMatch0 },
      { label: 'bodyMatch1', value: bodyMatch1 },
      { label: 'bodyDupItem2Init', value: bodyDupItem2Init },
      { label: 'bodyMatchNPicked', value: bodyMatchNPicked },
      { label: 'bodyMatch0Edited', value: bodyMatch0Edited },
      { label: 'bodyMatch0SyncedFromA', value: bodyMatch0SyncedFromA },
      { label: 'unsavedDraftBeforeLock', value: unsavedDraftBeforeLock },
      { label: 'omniboxDraftBeforeLock', value: omniboxDraftBeforeLock },
      { label: 'jsonSecretTokenInit', value: jsonSecretTokenInit },
      { label: 'jsonSecretTokenEdited', value: jsonSecretTokenEdited },
      { label: 'jsonSiblingKeep', value: jsonSiblingKeep },
      { label: 'importJsonToken', value: importJsonToken },
      { label: 'importJsonNestedSecret', value: importJsonNestedSecret },
      { label: 'importJsonNoteLine1', value: importJsonNoteLine1 },
      { label: 'importJsonNoteLine2', value: importJsonNoteLine2 },
      { label: 'vaultPassphrase', value: VAULT_PASSPHRASE },
      { label: 'postResetVaultPassphrase', value: postResetVaultPassphrase },
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
    let importedJsonEntryId = '';
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
        await verifyStorageAndCacheScannerPositiveControl(pageA, nonce);
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
        await expectTextEqualsBool(card0.getByTestId('entry-body'), bodyMatch0);

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
        await expectTextEqualsBool(card0.getByTestId('entry-body'), bodyMatch0Edited);

        // Reload page -> vault locks on full reload (in-memory key cleared) -> unlock from banner -> returns to item page and shows edited text
        await pageA.reload();
        await expect(pageA.getByTestId('vault-locked-banner')).toBeVisible({
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await pageA.getByTestId('vault-locked-unlock-cta').click();
        await expectOnUnlockPageAllowingReturnTo(pageA);
        await submitUnlock(pageA, VAULT_PASSPHRASE);
        await expect(pageA).toHaveURL(new RegExp(`/app/items/${item1Id}$`), {
          timeout: CRYPTO_WAIT_MS,
        });
        await expectTextEqualsBool(
          pageA.getByTestId(`entry-card-${entry0Id}`).getByTestId('entry-body'),
          bodyMatch0Edited,
        );
        monitor.assertNoLeaks();
      });

      await timedJourneyStep('3b. (T17) open Import JSON dialog from the item page, load CRLF JSON fixture (nested objects + string with \\n) via the file input, verify offline Retry idempotency (A11), import, and prove 1 new server entry, byte-identical decrypted CRLF content (A6), and zero plaintext in network requests (A4)', async () => {
        const importTrigger = pageA.getByTestId('btn-import-json');
        await expect(importTrigger).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await importTrigger.click();

        const importDialog = pageA.getByTestId('import-json-dialog');
        await expect(importDialog).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await expect(importDialog.getByTestId('import-json-destination')).toContainText(itemName);

        // Load the CRLF JSON fixture via the real file input using DataTransfer (no locator.fill with body)
        await setQuietJsonFileInput(
          importDialog.getByTestId('import-json-file-input'),
          importJsonCrlfFixture,
          'journey-crlf-fixture.json',
        );

        await expect(importDialog.getByTestId('import-json-source-badge')).toContainText(
          'file (.json)',
          { timeout: ACCEPTANCE_UI_WAIT_MS },
        );
        await expect(
          importDialog.getByTestId('json-table-host-import-preview').getByRole('treegrid'),
        ).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });

        // Switch preview to Raw JSON tab and verify read-only `<pre>` holds the exact CRLF bytes (`===`, P04-A6)
        await importDialog.getByTestId('import-json-preview-tab-raw').click();
        const previewRawPre = importDialog.getByTestId('import-json-preview-raw');
        await expect(previewRawPre).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        expect(
          await previewRawPre.evaluate((el, expected) => el.textContent === expected, importJsonCrlfFixture),
        ).toBe(true);
        await importDialog.getByTestId('import-json-preview-tab-table').click();

        const submitImportBtn = importDialog.getByTestId('import-json-submit-btn');
        await expect(submitImportBtn).toBeEnabled({ timeout: ACCEPTANCE_UI_WAIT_MS });

        // (d) Exercise the product's unconfirmed-save Retry path (`import-json-retry-banner` / `import-json-retry-btn`, P04-A11):
        // go offline -> click Encrypt and save -> retry banner appears with draft locked -> go online -> click Retry ->
        // the Retry replays the SAME Idempotency-Key and the SAME sealed payload as the failed offline attempt (ACC-FE3-2).
        // The listener is attached BEFORE `setOffline(true)`: Playwright still emits `request` (then `requestfailed`) for the
        // offline attempt, so its key and body are recorded and compared with the Retry's. Key/body values are never logged.
        interface ImportPostRecord {
          readonly phase: 'offline' | 'retry';
          readonly idemKey: string;
          readonly postData: string;
        }
        const importPosts: ImportPostRecord[] = [];
        let importPostPhase: 'offline' | 'retry' = 'offline';
        const onImportReq = (req: {
          method: () => string;
          url: () => string;
          headers: () => Record<string, string>;
          postData: () => string | null;
        }) => {
          if (req.method() === 'POST' && req.url().includes(`/api/v1/items/${item1Id}/entries/import-json`)) {
            importPosts.push({
              phase: importPostPhase,
              idemKey: req.headers()['idempotency-key'] ?? '',
              postData: req.postData() ?? '',
            });
          }
        };
        contextA.on('request', onImportReq);
        try {
          await contextA.setOffline(true);
          try {
            await submitImportBtn.click();
            await expect(importDialog.getByTestId('import-json-retry-banner')).toBeVisible({
              timeout: ACCEPTANCE_UI_WAIT_MS,
            });
            await expect(importDialog.getByTestId('import-json-source-textarea')).toBeDisabled();
            monitor.assertNoLeaks();
          } finally {
            await contextA.setOffline(false);
          }

          importPostPhase = 'retry';
          await importDialog.getByTestId('import-json-retry-btn').click();
          await expect(importDialog).toBeHidden({ timeout: ACCEPTANCE_UI_WAIT_MS });
        } finally {
          contextA.off('request', onImportReq);
        }
        const offlineAttempts = importPosts.filter((r) => r.phase === 'offline');
        const retryAttempts = importPosts.filter((r) => r.phase === 'retry');
        expect(offlineAttempts.length).toBeGreaterThanOrEqual(1);
        expect(retryAttempts.length).toBeGreaterThanOrEqual(1);
        // Booleans only: key and body values never reach an assertion message. The negative control proves the
        // comparator rejects a fresh key, a re-sealed body and an empty key before it judges the real pair.
        verifyRetryReplayCheckNegativeControl();
        expect(retryReplaysSameRequest(offlineAttempts[0]!, retryAttempts[0]!)).toBe(true);

        // (a) Prove the server has exactly one new entry in the exact ID set via page fetch of `/api/v1/items/<id>/entries`
        const entriesAfterImport = await pageA.evaluate(async (id) => {
          const res = await fetch(`/api/v1/items/${encodeURIComponent(id)}/entries`, {
            credentials: 'include',
          });
          return (await res.json()) as EntriesListResult;
        }, item1Id);
        expect(entriesAfterImport.items).toHaveLength(4);
        const priorIds = new Set([entry0Id, entry1Id, entry2Id]);
        const newImportEntries = entriesAfterImport.items.filter((e) => !priorIds.has(e.id));
        expect(newImportEntries).toHaveLength(1);
        expect(newImportEntries[0]!.type).toBe('json');
        importedJsonEntryId = newImportEntries[0]!.id;
        await expectServerItemAndLiveEntryIds(pageA, item1Id, [
          entry0Id,
          entry1Id,
          entry2Id,
          importedJsonEntryId,
        ]);

        // The server holds only opaque ciphertext for the imported entry: neither the fixture nor any registered body
        // needle appears in the base64url-decoded bytes (user-dec-016). This does not prove the decrypted plaintext;
        // that is carried by (b) below (cell texts, `json-raw-bytes` count, Raw textarea, zero-PUT no-op save).
        await expectServerHoldsOpaqueCiphertext(pageA, importedJsonEntryId, importJsonCrlfFixture, [
          importJsonToken,
          importJsonNestedSecret,
          importJsonNoteLine1,
          importJsonNoteLine2,
        ]);

        // (b) Prove the rendered JSON card decrypts to byte-identical content (boolean compare, CRLF preserved per A6):
        // Table view renders `"cluster"` (`root.p0`) and `"multiline_note"` (`root.p2`, containing `\n`);
        // switching to Raw JSON and clicking Save without editing sends 0 PUTs (`JsonEntryCard` no-op round-trip rule);
        // editing 1 cell in Table view (`"cluster"`) and reverting it back to `importJsonToken` via lossless span splice
        // preserves the surrounding CRLF bytes byte-for-byte (`=== importJsonCrlfFixture`).
        const importedCard = pageA.getByTestId(`entry-card-${importedJsonEntryId}`);
        await expect(importedCard).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await expectTextEqualsBool(
          importedCard.getByTestId('json-cell-btn-root.p0'),
          importJsonToken,
        );
        await expectTextEqualsBool(
          importedCard.getByTestId('json-cell-btn-root.p2'),
          `${importJsonNoteLine1}\n${importJsonNoteLine2}`,
        );

        // Expand nested object `nested` (`root.p1`) and `nested.credentials` (`root.p1.p1`) to verify nested structure
        const nestedToggle = importedCard.getByTestId('json-toggle-root.p1');
        await expect(nestedToggle).toHaveAttribute('aria-expanded', 'false');
        await nestedToggle.click();
        await expect(nestedToggle).toHaveAttribute('aria-expanded', 'true');
        const credsToggle = importedCard.getByTestId('json-toggle-root.p1.p1');
        await expect(credsToggle).toHaveAttribute('aria-expanded', 'false');
        await credsToggle.click();
        await expect(credsToggle).toHaveAttribute('aria-expanded', 'true');
        await expectTextEqualsBool(
          importedCard.getByTestId('json-cell-btn-root.p1.p1.p0'),
          importJsonNestedSecret,
        );

        // Switch to Raw JSON tab -> verify textarea value equals the LF-normalized display while the card's
        // underlying source preserves CRLF: clicking Save without edits sends 0 PUT requests and returns to Table view.
        await importedCard.getByTestId(`json-tab-raw-${importedJsonEntryId}`).click();
        const importedRawTextarea = importedCard.getByTestId(
          `json-raw-textarea-${importedJsonEntryId}`,
        );
        await expect(importedRawTextarea).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await expectInputValueEqualsBool(importedRawTextarea, importJsonDisplayNormalized);

        // Prove CRLF is preserved in the decrypted card source (P04-A6):
        // 1) `json-raw-bytes-<id>` measures `tableSource` (the decrypted body in memory) and includes all 9 CRLF `\r` bytes
        //    (`importJsonCrlfFixture.length` > `importJsonDisplayNormalized.length`);
        // 2) clicking Save (`json-raw-save-btn-<id>`) in Raw JSON without editing compares `applyTextareaEol(originalSource, draftValue)`
        //    against `originalSource` (`=== importJsonCrlfFixture`), sends 0 PUT requests, and switches back to Table view.
        const expectedCrlfByteCount = new TextEncoder().encode(importJsonCrlfFixture).byteLength;
        const lfOnlyByteCount = new TextEncoder().encode(importJsonDisplayNormalized).byteLength;
        expect(expectedCrlfByteCount).toBeGreaterThan(lfOnlyByteCount);
        // Exact match (ACC-FE3-8): `byteCounter` is "{bytes} / 262,144 B" (en; the fixture is < 1,000 bytes so no
        // thousands separator). A substring match would also accept e.g. "1400 ...".
        await expect(importedCard.getByTestId(`json-raw-bytes-${importedJsonEntryId}`)).toHaveText(
          new RegExp(`^${expectedCrlfByteCount} / 262,144 B$`),
        );

        let putCountOnNoOp = 0;
        const onPutReq = (req: { method: () => string; url: () => string }) => {
          if (req.method() === 'PUT' && req.url().includes(`/api/v1/entries/${importedJsonEntryId}`)) {
            putCountOnNoOp += 1;
          }
        };
        contextA.on('request', onPutReq);
        try {
          await importedCard.getByTestId(`json-raw-save-btn-${importedJsonEntryId}`).click();
          await expect(importedCard.getByTestId(`json-table-host-${importedJsonEntryId}`)).toBeVisible({
            timeout: ACCEPTANCE_UI_WAIT_MS,
          });
        } finally {
          contextA.off('request', onPutReq);
        }
        expect(putCountOnNoOp).toBe(0);

        // (c) Verify the request monitor saw zero plaintext leaks (A4: POST /entries/import-json carried ciphertext only)
        monitor.assertNoLeaks();
      });

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
        expect(entriesAfterJsonCreate.items).toHaveLength(5);
        const createdJsonMeta = entriesAfterJsonCreate.items.find(
          (e) => e.type === 'json' && e.id !== importedJsonEntryId,
        );
        jsonEntryId = createdJsonMeta!.id;

        const jsonCard = pageA.getByTestId(`entry-card-${jsonEntryId}`);
        await expect(jsonCard).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await expect(jsonCard.getByRole('treegrid')).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });

        // Edit one cell (`root.p0`, the value of `"service"`) in Table view
        const serviceCellBtn = jsonCard.getByTestId('json-cell-btn-root.p0');
        await expectTextEqualsBool(serviceCellBtn, jsonSecretTokenInit);
        await serviceCellBtn.click();

        const cellInput = jsonCard.getByTestId('json-cell-input-root.p0');
        await expect(cellInput).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await setQuietInputValue(cellInput, jsonSecretTokenEdited);
        await cellInput.press('Enter');

        await expectTextEqualsBool(serviceCellBtn, jsonSecretTokenEdited);

        // P04-A10 offline draft retention on JSON card: go offline -> press Save -> Retry box appears and edited cell stays intact
        await contextA.setOffline(true);
        try {
          await jsonCard.getByTestId(`entry-save-btn-${jsonEntryId}`).click();
          const jsonRetryBox = jsonCard.getByTestId(`entry-save-retry-box-${jsonEntryId}`);
          await expect(jsonRetryBox).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
          await expectTextEqualsBool(serviceCellBtn, jsonSecretTokenEdited);
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
        await expectOnUnlockPageAllowingReturnTo(pageA);
        await submitUnlock(pageA, VAULT_PASSPHRASE);
        await expect(pageA).toHaveURL(new RegExp(`/app/items/${item1Id}$`), {
          timeout: CRYPTO_WAIT_MS,
        });

        const reloadedJsonCard = pageA.getByTestId(`entry-card-${jsonEntryId}`);
        await expectTextEqualsBool(
          reloadedJsonCard.getByTestId('json-cell-btn-root.p0'),
          jsonSecretTokenEdited,
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
        await expectOnUnlockPageAllowingReturnTo(pageB);
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

        // Navigate to item1 page and check all 5 decrypted entries (3 text + 2 JSON)
        await cardItem1.click();
        await expect(pageB).toHaveURL(new RegExp(`/app/items/${item1Id}$`), {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expect(pageB.getByTestId('item-tags')).toContainText('#ops');
        await expect(pageB.getByTestId('entry-body')).toHaveCount(5, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expectTextEqualsBool(
          pageB.getByTestId(`entry-card-${entry0Id}`).getByTestId('entry-body'),
          bodyMatch0Edited,
        );
        await expectTextEqualsBool(
          pageB.getByTestId(`entry-card-${entry1Id}`).getByTestId('entry-body'),
          bodyMatch1,
        );
        await expectTextEqualsBool(
          pageB.getByTestId(`entry-card-${entry2Id}`).getByTestId('entry-body'),
          bodyMatchNPicked,
        );
        await expectTextEqualsBool(
          pageB.getByTestId(`entry-card-${importedJsonEntryId}`).getByTestId('json-cell-btn-root.p0'),
          importJsonToken,
        );
        await expectTextEqualsBool(
          pageB.getByTestId(`entry-card-${jsonEntryId}`).getByTestId('json-cell-btn-root.p0'),
          jsonSecretTokenEdited,
        );
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
        await expectTextEqualsBool(
          pageB.getByTestId(`entry-card-${entry1Id}`).getByTestId('entry-body'),
          bodyMatch1,
        );
        await expectServerItemAndLiveEntryIds(pageB, item1Id, [
          entry0Id,
          entry1Id,
          entry2Id,
          importedJsonEntryId,
          jsonEntryId,
        ]);

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
        await expectTextEqualsBool(
          pageB.getByTestId(`entry-card-${entry1Id}`).getByTestId('entry-body'),
          bodyMatch1,
        );
        await expectServerItemAndLiveEntryIds(pageB, item1Id, [
          entry0Id,
          entry1Id,
          entry2Id,
          importedJsonEntryId,
          jsonEntryId,
        ]);

        // Delete `entry2Id` on its own and do NOT undo it (leaving 4 live entries: entry0Id, entry1Id, importedJsonEntryId, jsonEntryId)
        const card2 = pageB.getByTestId(`entry-card-${entry2Id}`);
        await card2.getByTestId(`entry-menu-trigger-${entry2Id}`).click();
        await card2.getByTestId(`entry-menu-delete-${entry2Id}`).click();
        await expect(card2).toHaveCount(0, { timeout: ACCEPTANCE_UI_WAIT_MS });
        await expect(pageB.getByTestId('entry-body')).toHaveCount(4, {
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

        // Undo navigates back to `/app/items/<item1Id>` with its tag `#ops` and the 4 live entries restored,
        // while `entry2Id` (deleted separately before the item delete) remains deleted (P04-A8 provenance rule).
        await expect(pageB).toHaveURL(new RegExp(`/app/items/${item1Id}$`), {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expect(pageB.getByTestId('item-name-input')).toHaveValue(itemName, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expect(pageB.getByTestId('item-tags')).toContainText('#ops');
        await expect(pageB.getByTestId('entry-body')).toHaveCount(4, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expectTextEqualsBool(
          pageB.getByTestId(`entry-card-${entry0Id}`).getByTestId('entry-body'),
          bodyMatch0Edited,
        );
        await expectTextEqualsBool(
          pageB.getByTestId(`entry-card-${entry1Id}`).getByTestId('entry-body'),
          bodyMatch1,
        );
        await expectTextEqualsBool(
          pageB.getByTestId(`entry-card-${importedJsonEntryId}`).getByTestId('json-cell-btn-root.p0'),
          importJsonToken,
        );
        await expectTextEqualsBool(
          pageB.getByTestId(`entry-card-${jsonEntryId}`).getByTestId('json-cell-btn-root.p0'),
          jsonSecretTokenEdited,
        );
        await expect(pageB.getByTestId(`entry-card-${entry2Id}`)).toHaveCount(0);
        // Prove the restored item and live entry set via the server API (independent of TanStack cache, ACC-FE1-1)
        await expectServerItemAndLiveEntryIds(
          pageB,
          item1Id,
          [entry0Id, entry1Id, importedJsonEntryId, jsonEntryId],
          [entry2Id],
        );
        monitor.assertNoLeaks();
      });

      await timedJourneyStep('7. open a text editor with an unsaved draft and put a nonce draft in the omnibox, lock vault -> editor unmounts, omnibox draft is cleared, and no draft or body remains in DOM or storage/caches (A9, ACC-FE1-4, ACC-FE2-2)', async () => {
        const card0 = pageB.getByTestId(`entry-card-${entry0Id}`);
        await card0.getByTestId(`entry-edit-btn-${entry0Id}`).click();
        const draftTextarea = card0.getByTestId(`entry-edit-textarea-${entry0Id}`);
        await expect(draftTextarea).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await setQuietInputValue(draftTextarea, unsavedDraftBeforeLock);
        await expectInputValueEqualsBool(draftTextarea, unsavedDraftBeforeLock);

        const omniboxTextarea = pageB.locator('textarea[data-omnibox-input]').first();
        await expect(omniboxTextarea).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await setQuietInputValue(omniboxTextarea, omniboxDraftBeforeLock);
        await expectInputValueEqualsBool(omniboxTextarea, omniboxDraftBeforeLock);

        await pageB.getByTestId('vault-lock-button').click();
        await expectVaultShut(pageB);
        await expect(pageB.getByTestId('vault-locked-banner')).toBeVisible({
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expect(draftTextarea).toHaveCount(0);
        // The omnibox textarea stays mounted while locked; its draft must be cleared to '' (ACC-FE2-2). Every other textarea (editors) must be gone.
        await expect(pageB.locator('textarea:not([data-omnibox-input])')).toHaveCount(0);
        await expectInputEmptyBool(omniboxTextarea);
        expect(
          await pageB.locator('textarea[data-omnibox-input]').evaluateAll((els) => els.every((el) => (el as HTMLTextAreaElement).value === '')),
        ).toBe(true);
        await expect(pageB.getByTestId('entry-body')).toHaveCount(0);
        await expect(pageB.getByTestId('entry-body-locked')).toHaveCount(4);

        await expectNoDomOrStorageBodyLeaks(pageB, labeledSecrets);
        // Navigate back to /app locked list via the breadcrumb link and confirm zero DOM and storage/cache leaks there too
        await pageB.getByRole('link', { name: en.content.item.allItems, exact: true }).click();
        await expectLockedListOnApp(pageB);
        await expectNoDomOrStorageBodyLeaks(pageB, labeledSecrets);

        expect(monitor.getRequestCount()).toBeGreaterThan(0);
        monitor.assertNoLeaks();
      });

      await timedJourneyStep('8. (T20) multi-context sync on focus + vault reset in context A while context B has the item open -> B locks on focus with no old body -> create new vault in A -> exact item/tag ID sets preserved and zero entries on server & UI (A5, A8, A9)', async () => {
        // Unlock context B from `/app` locked list and open `item1Id` via client-side card click
        await unlockFromLockedList(pageB, VAULT_PASSPHRASE);
        const cardItem1OnB = pageB.locator(`[data-item-card="${item1Id}"]`);
        await expect(cardItem1OnB).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await cardItem1OnB.click();
        await expect(pageB).toHaveURL(new RegExp(`/app/items/${item1Id}$`), {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expect(pageB.getByTestId('entry-body')).toHaveCount(4, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expectTextEqualsBool(
          pageB.getByTestId(`entry-card-${entry0Id}`).getByTestId('entry-body'),
          bodyMatch0Edited,
        );

        // Bootstrap B's changes watermark on the open item page
        const bootstrapChangesOnB = pageB.waitForResponse(
          (res) =>
            res.request().method() === 'GET' &&
            new URL(res.url()).pathname === '/api/v1/entries/changes' &&
            res.status() === 200,
          { timeout: ACCEPTANCE_UI_WAIT_MS },
        );
        await triggerFocusWake(pageB);
        await bootstrapChangesOnB;

        // Open a fresh context (`contextSyncA`) for the same user, unlock, and open `item1Id`
        const contextSyncA = await newContextWithRateLimit(browser);
        contexts.push(contextSyncA);
        monitor.attachContext(contextSyncA);
        const pageSyncA = await contextSyncA.newPage();

        await loginViaUiSecret(pageSyncA, email);
        await expectOnUnlockPageAllowingReturnTo(pageSyncA);
        await submitUnlock(pageSyncA, VAULT_PASSPHRASE);
        await expectUnlockedOnApp(pageSyncA);

        const cardItem1OnSyncA = pageSyncA.locator(`[data-item-card="${item1Id}"]`);
        await expect(cardItem1OnSyncA).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await cardItem1OnSyncA.click();
        await expect(pageSyncA).toHaveURL(new RegExp(`/app/items/${item1Id}$`), {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        const card0OnSyncA = pageSyncA.getByTestId(`entry-card-${entry0Id}`);
        await expectTextEqualsBool(card0OnSyncA.getByTestId('entry-body'), bodyMatch0Edited);

        // (a) Sync before reset: edit `entry0Id` in context A -> becomes visible in open context B after focus/visibility change (no reload, no goto)
        await card0OnSyncA.getByTestId(`entry-edit-btn-${entry0Id}`).click();
        const editTextareaSyncA = card0OnSyncA.getByTestId(`entry-edit-textarea-${entry0Id}`);
        await expect(editTextareaSyncA).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await setQuietInputValue(editTextareaSyncA, bodyMatch0SyncedFromA);
        const syncPutResPromise = pageSyncA.waitForResponse(
          (res) =>
            res.request().method() === 'PUT' &&
            new URL(res.url()).pathname === `/api/v1/entries/${entry0Id}`,
          { timeout: CRYPTO_WAIT_MS },
        );
        await card0OnSyncA.getByTestId(`entry-save-btn-${entry0Id}`).click();
        expect((await syncPutResPromise).status()).toBe(200);
        await expectTextEqualsBool(card0OnSyncA.getByTestId('entry-body'), bodyMatch0SyncedFromA);

        await triggerFocusWake(pageB);
        await expectTextEqualsBool(
          pageB.getByTestId(`entry-card-${entry0Id}`).getByTestId('entry-body'),
          bodyMatch0SyncedFromA,
        );

        // Record the pre-reset server item and tag ID sets via page fetch
        const preResetSnapshot = await fetchServerItemsAndTagsSnapshot(pageSyncA);
        expect(preResetSnapshot.itemsStatus).toBe(200);
        expect(preResetSnapshot.tagsStatus).toBe(200);
        expect(preResetSnapshot.itemIds).toEqual([item1Id, item2Id].sort());
        expect(preResetSnapshot.tagIds.length).toBe(2);

        // (b) Reset vault through the real Settings > Security reset dialog in context A while context B has `item1Id` open,
        // and click the dialog's "Create new vault" link (`content-sync.spec.ts:458-569`)
        await executeVaultResetAndClickCreateNewVault(pageSyncA);

        // (c) Context B on focus is locked (P03) and shows no old body
        await triggerFocusWake(pageB);
        await expect(pageB).toHaveURL(new RegExp(`/app/items/${item1Id}$`), {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expect(pageB.locator('.vault-pill').first()).toHaveAttribute(
          'data-vault-state',
          'locked',
          { timeout: ACCEPTANCE_UI_WAIT_MS },
        );
        await expectVaultShut(pageB);
        await expect(pageB.getByTestId('vault-locked-banner')).toBeVisible({
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expect(pageB.getByTestId('entry-body')).toHaveCount(0);
        await expect(
          pageB.locator('[data-testid^="entry-card-"]:not([data-testid="entry-card-list"])'),
        ).toHaveCount(0, { timeout: ACCEPTANCE_UI_WAIT_MS });
        await expectNoDomOrStorageBodyLeaks(pageB, labeledSecrets);

        // (d) Complete creating the new vault in A from `/app/onboarding` (skip passkey)
        const postResetKeys = await createVaultViaOnboarding(
          pageSyncA,
          postResetVaultPassphrase,
          { kind: 'skip' },
        );
        monitor.registerSecret('postResetRecoveryKeySlot1', postResetKeys.slot1);
        monitor.registerSecret('postResetRecoveryKeySlot2', postResetKeys.slot2);
        await expectUnlockedOnApp(pageSyncA);

        // (e) Prove items and tags still exist with exact ID sets equal to pre-reset sets, and server has zero entries
        const postResetSnapshot = await fetchServerItemsAndTagsSnapshot(pageSyncA);
        expect(postResetSnapshot.itemsStatus).toBe(200);
        expect(postResetSnapshot.tagsStatus).toBe(200);
        expect(postResetSnapshot.itemIds).toEqual(preResetSnapshot.itemIds);
        expect(postResetSnapshot.tagIds).toEqual(preResetSnapshot.tagIds);
        expect(postResetSnapshot.itemTagIdsByItem).toEqual(preResetSnapshot.itemTagIdsByItem);
        expect(postResetSnapshot.entryCountsByItem[item1Id]).toBe(0);
        expect(postResetSnapshot.entryCountsByItem[item2Id]).toBe(0);

        await expectServerItemsHaveZeroEntries(
          pageSyncA,
          [item1Id, item2Id],
          [entry0Id, entry1Id, entry2Id, importedJsonEntryId, jsonEntryId],
        );

        // Navigate to `item1Id` via client-side card click in A and verify UI shows the empty entry state and no old bodies
        const cardItem1PostReset = pageSyncA.locator(`[data-item-card="${item1Id}"]`);
        await expect(cardItem1PostReset).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
        await expect(cardItem1PostReset).toContainText('#ops');
        await cardItem1PostReset.click();
        await expect(pageSyncA).toHaveURL(new RegExp(`/app/items/${item1Id}$`), {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expect(pageSyncA.getByTestId('item-name-input')).toHaveValue(itemName, {
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expect(pageSyncA.getByTestId('item-tags')).toContainText('#ops');
        await expect(pageSyncA.getByTestId('item-entries-empty')).toBeVisible({
          timeout: ACCEPTANCE_UI_WAIT_MS,
        });
        await expect(
          pageSyncA.locator('[data-testid^="entry-card-"]:not([data-testid="entry-card-list"])'),
        ).toHaveCount(0);
        await expect(pageSyncA.getByTestId('entry-body')).toHaveCount(0);

        await expectNoDomOrStorageBodyLeaks(pageSyncA, labeledSecrets);
        await expectNoDomOrStorageBodyLeaks(pageB, labeledSecrets);
        monitor.assertNoLeaks();
      });
    } finally {
      for (const ctx of contexts) {
        await ctx.close().catch(() => undefined);
      }
    }
  });
});
