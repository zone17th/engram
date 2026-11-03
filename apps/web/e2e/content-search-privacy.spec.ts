import { expect, test, type Locator, type Page } from '@playwright/test';
import enMessages from '../messages/en.json';
import { uniqueEmail } from './helpers';
import { bootstrapUnlockedUser } from './content-a11y-support';
import { expectOnUnlockPageAllowingReturnTo } from './content-acceptance-support';
import { expectLockedListOnApp, loginViaUiSecret, unlockFromLockedList } from './vault-journey-support';
import { VAULT_PASSPHRASE } from './vault-passkey-support';
import {
  SEARCH_QUIET_WINDOW_MS,
  SEARCH_TEST_TIMEOUT_MS,
  SEARCH_UI_WAIT_MS,
  attachSearchRequestRecorder,
  clearDraft,
  expectDraftEquals,
  expectDraftStartsWith,
  expectedKeysFromSuggest,
  expectRowKeys,
  grantClipboard,
  newClipboardContext,
  pasteIntoOmnibox,
  rowKeys,
  readListbox,
  searchOmnibox,
  seedSearchCorpus,
  typeKeys,
  waitForSuggestResponse,
  type NeedleSecret,
  type RecordedRequest,
  type SearchCorpus,
  type SearchRequestRecorder,
} from './content-search-support';

// Disable Playwright's automatic error-context DOM snapshot in this worker before any test runs: the omnibox holds
// pasted and typed fixture secrets and a failure snapshot must never serialize them to disk.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

const help = enMessages.search.help;

/**
 * P05 Task 22 (22-1a) privacy capture, lexical, real stack. The recorder is attached before the first navigation and keeps
 * URL + headers + post body of EVERY request. Fixture "secrets" are literals that exist only in this file; assertion
 * messages carry labels and booleans, never the values (so a failure cannot print one into the CI log).
 *
 * Cases (a)-(d) paste/delete, (b) typed, (f)-(i) colon-lock negatives (advisor-dec-244, plan 2.1 rule 3) run in one
 * signed-in session; (e) logout -> another user is its own test because it needs two accounts.
 *
 * A note on "no request" vs "only a safe prefix": keystrokes are typed back to back, so the 120 ms debounce normally never
 * fires before the colon arrives and nothing is sent. On a slow runner a pre-colon prefix MAY legitimately go out
 * (`wifi` of `wifi: SECRET`). The colon cases therefore assert that every `/suggest` `q` is a prefix of the text before
 * the colon, which is exactly the contract, instead of asserting zero requests.
 */

const SECRET_BODY = 'secret-body-123';
const SECRET_UPPER = 'SECRET';
const SECRET_PASTED_COLON = 'a:SECRET';
const SECRET_TAG_COLON = 'secretbody';
const SECRET_TAG_SPACE = 'secret:x';
const SECRET_FULLWIDTH = 'mật khẩu';

/** Distinctive enough to be scanned in every request, including page-navigation URLs. */
const DISTINCTIVE_SECRETS: readonly NeedleSecret[] = [
  { label: 'pasted-body', value: SECRET_BODY },
  { label: 'pasted-colon-draft', value: SECRET_PASTED_COLON },
  { label: 'tag-after-colon', value: SECRET_TAG_COLON },
  { label: 'tag-after-space', value: SECRET_TAG_SPACE },
  { label: 'fullwidth-after-colon', value: SECRET_FULLWIDTH },
];

/** Short or generic words: scanned only in `/api/` requests (a chunk URL could contain them by chance). */
const GENERIC_SECRETS: readonly NeedleSecret[] = [
  { label: 'upper-secret', value: SECRET_UPPER },
  { label: 'lower-secret', value: 'secret' },
];

const isApiRequest = (rec: RecordedRequest): boolean => rec.pathname.startsWith('/api/');

function isPrefixOf(whole: string, candidate: string): boolean {
  return whole.startsWith(candidate);
}

/** Boolean-only: never echoes a `q`. */
function onlySafePrefixes(queries: readonly string[], safeText: string): boolean {
  return queries.every((q) => isPrefixOf(safeText, q));
}

async function moveCaretToStart(page: Page): Promise<void> {
  await page.keyboard.press('Home');
}

/** Deletes the character at `index` (0-based) of a single-line draft with real keys: Home, Right x index, Delete. */
async function deleteCharAt(page: Page, index: number): Promise<void> {
  await page.keyboard.press('Home');
  for (let i = 0; i < index; i += 1) {
    await page.keyboard.press('ArrowRight');
  }
  await page.keyboard.press('Delete');
}

async function quietWindow(page: Page): Promise<void> {
  // The one allowed fixed wait (plan Task 22, "wait >= 1 s with no request"): proves the debounce had time to fire.
  await page.waitForTimeout(SEARCH_QUIET_WINDOW_MS);
}

test.describe('P05-T22 search privacy (lexical, real stack)', () => {
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  test('(a)-(d), (f)-(i): pasted, colon-locked and tag-mode drafts never leave the browser beyond the safe token', async ({
    page,
  }) => {
    test.setTimeout(SEARCH_TEST_TIMEOUT_MS);
    const context = page.context();
    const recorder: SearchRequestRecorder = attachSearchRequestRecorder(context);
    await grantClipboard(context);

    await bootstrapUnlockedUser(page, uniqueEmail('content-search-privacy'), 'en', 'light');
    const omnibox: Locator = searchOmnibox(page);
    await expect(omnibox).toBeVisible({ timeout: SEARCH_UI_WAIT_MS });
    const hint = page.getByTestId('omnibox-hint');

    // ---- (a) paste `secret-body-123` (real Control+V), wait >= 1 s, Home, type `name: ` (FE-25) ----
    await test.step('(a) paste body, wait 1 s, prepend name:', async () => {
      const mark = recorder.mark();
      await pasteIntoOmnibox(page, omnibox, SECRET_BODY);
      await expectDraftEquals(omnibox, SECRET_BODY);
      // Positive evidence that the paste really was `insertFromPaste` and tainted the draft: the generic help text.
      await expect(hint).toContainText(help.enterToSearch);
      await quietWindow(page);
      recorder.expectNoOmniboxRequestsSince(mark, '(a) after paste');

      await moveCaretToStart(page);
      await typeKeys(page, 'name: ');
      await expectDraftStartsWith(omnibox, `name: ${SECRET_BODY}`);
      await quietWindow(page);
      await recorder.flush();
      recorder.expectNoOmniboxRequestsSince(mark, '(a) after prepending name:');
      await recorder.assertNeverContains([{ label: 'pasted-body', value: SECRET_BODY }], mark);
    });

    // ---- (b) type `wifi: SECRET` key by key: the last /suggest carries only `wifi` ----
    await test.step('(b) typed wifi: SECRET', async () => {
      await clearDraft(page, omnibox);
      const mark = recorder.mark();
      const wifiSent = waitForSuggestResponse(page, { q: 'wifi', scope: 'all' });
      await typeKeys(page, 'wifi');
      const capture = await wifiSent;
      expect(capture.status).toBe(200);
      // Positive control: a clean typed draft shows the "sent to the server" help, not the tainted one.
      await expect(hint).toContainText(help.sentToServer.split(',')[0] ?? '');

      await typeKeys(page, ': SECRET', { delay: 25 });
      await quietWindow(page);
      await recorder.flush();
      const queries = recorder.suggestQueriesSince(mark);
      expect(queries.length, '(b) the typed prefix must reach /suggest').toBeGreaterThanOrEqual(1);
      expect(onlySafePrefixes(queries, 'wifi'), '(b) a /suggest q went beyond `wifi`').toBe(true);
      expect(queries[queries.length - 1] === 'wifi', '(b) the last /suggest q must be `wifi`').toBe(true);
      expect(recorder.searchSince(mark)).toHaveLength(0);
      await recorder.assertNeverContains([{ label: 'upper-secret', value: SECRET_UPPER }], mark, {
        filter: isApiRequest,
      });

      // ---- (d, typed) deleting the colon of a clean typed draft does not re-open sending ----
      const markDelete = recorder.mark();
      await expectDraftEquals(omnibox, `wifi: ${SECRET_UPPER}`);
      await deleteCharAt(page, 4);
      await expectDraftEquals(omnibox, `wifi ${SECRET_UPPER}`);
      await quietWindow(page);
      await recorder.flush();
      recorder.expectNoOmniboxRequestsSince(markDelete, '(d) typed: delete the colon');
    });

    // ---- (c) paste `a:SECRET`: no request; (d) delete the `:`: still no request ----
    await test.step('(c) paste a:SECRET, (d) delete the colon', async () => {
      await clearDraft(page, omnibox);
      const mark = recorder.mark();
      await pasteIntoOmnibox(page, omnibox, SECRET_PASTED_COLON);
      await expectDraftEquals(omnibox, SECRET_PASTED_COLON);
      await quietWindow(page);
      await recorder.flush();
      recorder.expectNoOmniboxRequestsSince(mark, '(c) after paste');

      await deleteCharAt(page, 1);
      await expectDraftEquals(omnibox, `a${SECRET_UPPER}`);
      await quietWindow(page);
      await recorder.flush();
      recorder.expectNoOmniboxRequestsSince(mark, '(d) paste: delete the colon');
      await recorder.assertNeverContains(
        [
          { label: 'pasted-colon-draft', value: SECRET_PASTED_COLON },
          { label: 'upper-secret', value: SECRET_UPPER },
        ],
        mark,
        { filter: isApiRequest },
      );
    });

    // ---- (f) `#home:secretbody`: only the token before the colon may ever be sent ----
    await test.step('(f) #home:secretbody', async () => {
      await clearDraft(page, omnibox);
      const mark = recorder.mark();
      await typeKeys(page, `#home:${SECRET_TAG_COLON}`);
      await quietWindow(page);
      await recorder.flush();
      const queries = recorder.suggestQueriesSince(mark);
      expect(onlySafePrefixes(queries, 'home'), '(f) a /suggest q went beyond the `home` token').toBe(true);
      expect(recorder.searchSince(mark)).toHaveLength(0);
      await recorder.assertNeverContains([{ label: 'tag-after-colon', value: SECRET_TAG_COLON }], mark);
    });

    // ---- (g) `#home secret:x`: the token IS sent (positive control), nothing after the space is ----
    await test.step('(g) #home secret:x', async () => {
      await clearDraft(page, omnibox);
      const mark = recorder.mark();
      const tokenSent = waitForSuggestResponse(page, { q: 'home', scope: 'tag' });
      await typeKeys(page, '#home');
      expect((await tokenSent).status).toBe(200);

      await typeKeys(page, ' secret:x');
      await quietWindow(page);
      await recorder.flush();
      const queries = recorder.suggestQueriesSince(mark);
      expect(queries.length).toBeGreaterThanOrEqual(1);
      expect(onlySafePrefixes(queries, 'home'), '(g) a /suggest q went beyond the `home` token').toBe(true);
      expect(recorder.searchSince(mark)).toHaveLength(0);
      await recorder.assertNeverContains([{ label: 'tag-after-space', value: SECRET_TAG_SPACE }], mark);
      await recorder.assertNeverContains([{ label: 'lower-secret', value: 'secret' }], mark, {
        filter: isApiRequest,
      });
    });

    // ---- (h) `name: body`: nothing after the colon ----
    await test.step('(h) name: body', async () => {
      await clearDraft(page, omnibox);
      const mark = recorder.mark();
      await typeKeys(page, 'name: body');
      await quietWindow(page);
      await recorder.flush();
      const queries = recorder.suggestQueriesSince(mark);
      expect(onlySafePrefixes(queries, 'name'), '(h) a /suggest q went beyond `name`').toBe(true);
      expect(recorder.searchSince(mark)).toHaveLength(0);
      // The only text after the colon is " body"; a q carrying it would also fail the prefix check above. The plus form
      // (`name:+body`) is covered by `searchNeedleForms` for the full draft.
      await recorder.assertNeverContains([{ label: 'name-colon-body', value: 'name: body' }], mark);
      // Plan (h): no request may carry `body`. Scan the bare text after the colon too (API requests only: a chunk URL could
      // hold a short word by chance; there are no API POSTs inside this mark, so a JSON key cannot collide).
      await recorder.assertNeverContains([{ label: 'after-colon-body', value: ' body' }], mark, {
        filter: isApiRequest,
      });
    });

    // ---- (i) full-width colon and `http://x`: nothing after the colon (FE-8) ----
    await test.step('(i) full-width colon and http://x', async () => {
      await clearDraft(page, omnibox);
      const markFull = recorder.mark();
      await typeKeys(page, `wifi： ${SECRET_FULLWIDTH}`);
      await quietWindow(page);
      await recorder.flush();
      expect(onlySafePrefixes(recorder.suggestQueriesSince(markFull), 'wifi'), '(i) a q went beyond `wifi`').toBe(true);
      expect(recorder.searchSince(markFull)).toHaveLength(0);
      await recorder.assertNeverContains([{ label: 'fullwidth-after-colon', value: SECRET_FULLWIDTH }], markFull);

      await clearDraft(page, omnibox);
      const markUrl = recorder.mark();
      await typeKeys(page, 'http://x');
      await quietWindow(page);
      await recorder.flush();
      expect(onlySafePrefixes(recorder.suggestQueriesSince(markUrl), 'http'), '(i) a q went beyond `http`').toBe(true);
      expect(recorder.searchSince(markUrl)).toHaveLength(0);
      await recorder.assertNeverContains([{ label: 'url-after-colon', value: 'http://x' }], markUrl);
    });

    // ---- every request since page load ----
    await recorder.assertNeverContains(DISTINCTIVE_SECRETS);
    await recorder.assertNeverContains(GENERIC_SECRETS, 0, { filter: isApiRequest });
    // Navigation and history: the URL never carries a query (results live in the listbox, no `/app?q=`).
    expect(new URL(page.url()).search).toBe('');
  });

  test('(e) logout, then login as another user with the same q: no row of the previous user, no q in URL or history', async ({
    page,
    browser,
  }) => {
    test.setTimeout(SEARCH_TEST_TIMEOUT_MS);
    const recorder = attachSearchRequestRecorder(page.context());
    const Q = 'orbit';
    const corpusOne: SearchCorpus = {
      tags: ['orbit-one'],
      items: [{ ref: 'orbitOne', name: 'orbit alpha', tags: ['orbit-one'] }],
    };
    const corpusTwo: SearchCorpus = {
      tags: ['orbit-two'],
      items: [{ ref: 'orbitTwo', name: 'orbit beta', tags: ['orbit-two'] }],
    };
    const emailOne = uniqueEmail('content-search-privacy-e1');
    const emailTwo = uniqueEmail('content-search-privacy-e2');

    // User two is created first in a second context (own vault, own rows) and then left alone.
    const seededTwoKeys = await (async (): Promise<ReadonlySet<string>> => {
      const context2 = await newClipboardContext(browser);
      try {
        const page2 = await context2.newPage();
        await bootstrapUnlockedUser(page2, emailTwo, 'en', 'light');
        return (await seedSearchCorpus(page2, corpusTwo)).allKeys;
      } finally {
        await context2.close();
      }
    })();

    await bootstrapUnlockedUser(page, emailOne, 'en', 'light');
    const seededOne = await seedSearchCorpus(page, corpusOne);
    const omnibox = searchOmnibox(page);
    await expect(omnibox).toBeVisible({ timeout: SEARCH_UI_WAIT_MS });

    // User one sees their own rows for `orbit`.
    await omnibox.focus();
    const firstResponse = waitForSuggestResponse(page, { q: Q, scope: 'all' });
    await typeKeys(page, Q);
    const first = await firstResponse;
    expect(first.body.items.map((i) => i.name)).toEqual(['orbit alpha']);
    await expectRowKeys(page, expectedKeysFromSuggest(first.body));
    expect(rowKeys(await readListbox(page))).toContain(seededOne.itemKey('orbitOne'));

    // Logout through the app shell button, then log in as user two (full navigation, fresh client state).
    await page.getByRole('button', { name: /^(Sign out|Đăng xuất)$/ }).first().click();
    await expect(page).toHaveURL(/\/app\/auth\/login/, { timeout: SEARCH_UI_WAIT_MS });
    await loginViaUiSecret(page, emailTwo);
    await expectOnUnlockPageAllowingReturnTo(page);
    await page.goto('/app');
    await expectLockedListOnApp(page);
    await unlockFromLockedList(page, VAULT_PASSPHRASE);
    await expect(omnibox).toBeVisible({ timeout: SEARCH_UI_WAIT_MS });

    // Same `q`: user two's rows only. Nothing of user one is in the listbox or in the response body.
    const markTwo = recorder.mark();
    await omnibox.focus();
    const secondResponse = waitForSuggestResponse(page, { q: Q, scope: 'all' });
    await typeKeys(page, Q);
    const second = await secondResponse;
    expect(second.body.items.map((i) => i.name)).toEqual(['orbit beta']);
    expect(second.body.tags.map((t) => t.display)).toEqual(['orbit-two']);
    await expectRowKeys(page, expectedKeysFromSuggest(second.body));
    const keysAfter = new Set(rowKeys(await readListbox(page)));
    for (const key of seededOne.allKeys) {
      expect(keysAfter.has(key), 'user two must not see a user one row').toBe(false);
    }
    expect([...keysAfter].every((k) => seededTwoKeys.has(k))).toBe(true);
    expect(JSON.stringify(second.body)).not.toContain('alpha');
    await recorder.flush();
    expect(recorder.suggestQueriesSince(markTwo).every((q) => q === Q || isPrefixOf(Q, q))).toBe(true);

    // URL and history: the query never appears in the current location nor in any other GET (navigation, lists, assets).
    // Only `/suggest` and `/search` carry it (as `q=`); the seeding POSTs carry the fixture names and are not GETs.
    expect(page.url().includes(Q)).toBe(false);
    expect(await page.evaluate(() => window.location.search + window.location.hash)).not.toContain('orbit');
    await recorder.assertNeverContains([{ label: 'search-q', value: Q }], 0, {
      filter: (rec) => rec.method === 'GET' && !/^\/api\/v1\/(suggest|search)$/.test(rec.pathname),
    });
  });
});
