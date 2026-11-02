import { randomBytes } from 'node:crypto';
import { expect, test, type Locator, type Page, type Response as PageResponse } from '@playwright/test';
import { uniqueEmail } from './helpers';
import { ACCEPTANCE_UI_WAIT_MS, setQuietInputValue } from './content-acceptance-support';
import {
  documentInput,
  fakeembedReset,
  fakeembedSetAliases,
  fakeembedSetMode,
  fakeembedStats,
  itemDocumentText,
  nextProbeQuery,
  suggestNearContains,
  suggestSemanticViaPage,
  uniqueSemanticQuery,
  waitForEmbedded,
} from './content-search-semantic-support';
import { createVaultViaOnboarding, expectUnlockedOnApp, signupPasswordUser } from './vault-journey-support';
import { VAULT_PASSPHRASE } from './vault-passkey-support';

// A failure while the vault passphrase / recovery sheet is mounted must never serialize secrets into an error-context
// DOM snapshot (same guard as content-omnibox-quick-add.spec.ts).
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

/**
 * P05 Task 20b-1 E2E degrade scenario (plan Task 20b, "E2E degrade (`@semantic`)").
 * Runs ONLY in job `e2e-search-semantic` (real semantic server + CI-only `fakeembed`, g1 bootstrap flipped, no
 * `page.route` for near); `Content e2e` skips it through `--grep-invert @semantic`. fakeembed is never stopped with
 * docker (the Playwright container has no docker CLI/socket): `POST /__control {"mode":"down"}` simulates the outage.
 */

const TEST_TIMEOUT_MS = 300_000;
const UI_WAIT_MS = ACCEPTANCE_UI_WAIT_MS;
/**
 * Recovery bound. The API embedding breaker opens on the FIRST provider failure (threshold 1, `embedding/breaker.go`)
 * and stays open for 60 s counted from that failure; it admits one half-open trial to the first request at or after
 * `T_open + 60 s` (plan 2.21: one half-open probe per process per 60 s). `T_open` is during the `down` typing step, which
 * is EARLIER than the `{"mode":"ok"}` POST (`T_ok`) that starts our clock, so the breaker is closable no later than
 * `T_ok + 60 s`. We poll every 500 ms, so the first poll at/after that instant starts at most one interval later, and
 * it needs one alias POST + one /suggest round trip (cache miss, real fakeembed call) to return. The asserted bound is
 * therefore `RECOVERY_BUDGET_MS (60 s) + RECOVERY_MARGIN_MS (3 s)` measured from the `ok` POST to the first poll that
 * returns `semantic === true` with the near row; the 3 s margin = 500 ms poll interval + request latency headroom.
 */
const RECOVERY_BUDGET_MS = 60_000;
const RECOVERY_MARGIN_MS = 3_000;
const RECOVERY_POLL_MS = 500;
/** Upper cap for the failure-only cleanup poll (breaker window 60 s + margin). */
const CLEANUP_RECOVERY_MS = 65_000;

const NEAR_ROW = '[data-zone="near"] [data-opt-kind="item"]';
const LEXICAL_ITEM_ROW = '[data-zone="items"] [data-opt-kind="item"]';
const NEAR_BADGE = '.sugg-near-badge';

function randomToken(): string {
  return `x${randomBytes(3).toString('hex')}`;
}

async function createItemViaPage(page: Page, name: string, hint: string | null): Promise<string> {
  const result = await page.evaluate(
    async (payload) => {
      let csrf: string | null = null;
      for (const part of document.cookie.split(';')) {
        const trimmed = part.trim();
        if (trimmed.startsWith('sabk_csrf=')) {
          csrf = decodeURIComponent(trimmed.slice('sabk_csrf='.length));
          break;
        }
      }
      const res = await fetch('/api/v1/items', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        body: JSON.stringify(payload),
      });
      const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
      return { status: res.status, body };
    },
    hint === null ? { name } : { name, hint },
  );
  expect(result.status, 'POST /items status').toBe(201);
  const id = (result.body as { id?: unknown } | null)?.id;
  if (typeof id !== 'string') {
    throw new Error('POST /items did not return an id');
  }
  return id;
}

/**
 * Clean typing with real key events (no fill / no code-set value, which would taint the draft and suppress
 * `/suggest`, plan 2.1). Resolves with the `semantic=1` response of the FINAL keystroke (never log its query).
 */
async function typeCleanQuery(page: Page, omnibox: Locator, query: string): Promise<PageResponse> {
  await omnibox.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await expect(omnibox).toHaveValue('');
  const finalSuggest = page.waitForResponse(
    (res) => {
      const url = new URL(res.url());
      return (
        url.pathname === '/api/v1/suggest' &&
        url.searchParams.get('semantic') === '1' &&
        (url.searchParams.get('q') ?? '').toLowerCase() === query
      );
    },
    { timeout: UI_WAIT_MS },
  );
  await omnibox.pressSequentially(query, { delay: 20 });
  return finalSuggest;
}

/** Only the two semantic flags of a `/suggest` response (never the query, ids or names). */
async function semanticFlags(response: PageResponse): Promise<{ semantic?: boolean; semantic_reason?: string | null }> {
  expect(response.status(), 'final /suggest status').toBe(200);
  return (await response.json()) as { semantic?: boolean; semantic_reason?: string | null };
}

test.describe('P05-T20b @semantic degrade: provider down mid-session', () => {
  // Local runs without the stack skip. In CI the spec never skips: if the semantic job were misconfigured (no stack env),
  // the job must go red at signup/fakeembed instead of staying green with every test skipped.
  test.skip(
    !process.env.E2E_STACK && !process.env.CI,
    'needs the compose stack (E2E_STACK=1) with profile semantic-fake: real API, real fakeembed provider',
  );

  // Never leave the shared fake in `down`/`slow`: later @semantic specs of the same job reuse it.
  // After a FAILED run the API breaker (threshold 1, 60 s open window) can still be open even though the fake is `ok`
  // again; wait it out with fresh queries so the retry / next @semantic spec starts closed. Errors are swallowed so the
  // original failure stays the reported one.
  test.afterEach(async ({ page }, testInfo) => {
    await fakeembedReset();
    if (testInfo.status === testInfo.expectedStatus) {
      return;
    }
    const deadline = Date.now() + CLEANUP_RECOVERY_MS;
    try {
      while (Date.now() < deadline) {
        const response = await suggestSemanticViaPage(page, uniqueSemanticQuery('reset'));
        if (response.status === 200 && (response.body as { semantic?: boolean } | null)?.semantic === true) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, RECOVERY_POLL_MS));
      }
    } catch {
      // page gone or not on the app origin: nothing to recover
    }
  });

  test('@semantic provider down: new query still serves lexical + quick-add, no toast, no near/badge, muted degraded line; ok again restores near within 60 s', async ({
    page,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);

    const nearToken = randomToken();
    const lexToken = randomToken();
    const quickAddToken = randomToken();
    const nearName = `${nearToken}-router`;
    const nearHint = 'closet shelf';
    const lexName = `${lexToken}-bank account`;
    // Plan 2.14: item document text = name (trimmed) + " — " + hint; the alias value is that text behind the document prefix.
    const nearDocumentInput = documentInput(itemDocumentText(nearName, nearHint));

    const omnibox = page.locator('#omni textarea[data-vault-secret]');
    let nearId = '';
    let lexId = '';

    await test.step('signup, create vault, seed two items through the real API', async () => {
      await signupPasswordUser(page, uniqueEmail('content-degrade'));
      await createVaultViaOnboarding(page, VAULT_PASSPHRASE, { kind: 'skip' });
      await expectUnlockedOnApp(page);
      await expect(omnibox).toBeVisible({ timeout: UI_WAIT_MS });
      nearId = await createItemViaPage(page, nearName, nearHint);
      lexId = await createItemViaPage(page, lexName, null);
    });

    await test.step('waitForEmbedded: both seeded items have vectors (probe queries are never reused below)', async () => {
      await waitForEmbedded(page, [
        { id: nearId, probeQuery: nextProbeQuery() },
        { id: lexId, probeQuery: nextProbeQuery() },
      ]);
    });

    await test.step('baseline (provider ok): a first new query shows >= 1 near row with the ≈ badge', async () => {
      const baselineQuery = uniqueSemanticQuery('near');
      await fakeembedSetAliases({ [baselineQuery]: nearDocumentInput });
      const baselineResponse = await typeCleanQuery(page, omnibox, baselineQuery);
      expect((await semanticFlags(baselineResponse)).semantic, 'baseline final /suggest semantic flag').toBe(true);
      await expect(page.getByTestId('omnibox-semantic-toggle')).toHaveAttribute('aria-pressed', 'true', {
        timeout: UI_WAIT_MS,
      });
      const nearRow = page.locator(NEAR_ROW).filter({ hasText: nearName });
      await expect(nearRow).toHaveCount(1, { timeout: UI_WAIT_MS });
      await expect(nearRow.locator(NEAR_BADGE)).toBeVisible();
      await expect(page.getByTestId('omnibox-status-degraded')).toHaveCount(0);
    });

    // A query that differs from the baseline one, was never sent in this job (unique name token), and matches the
    // lexical item by prefix, so lexical must keep working while the provider is down.
    const downQuery = `${lexToken}-bank`;

    await test.step('provider down mid-session; a NEW never-sent query reaches fakeembed (stats counter grows)', async () => {
      const statsBefore = await fakeembedStats();
      await fakeembedSetMode('down');
      const downResponse = await typeCleanQuery(page, omnibox, downQuery);
      // The final request is what the user sees: degraded by reason code (breaker open after a prefix failure, or the
      // provider failing on this very query), never a silent `semantic: true`.
      const downFlags = await semanticFlags(downResponse);
      expect(downFlags.semantic, 'down: final /suggest semantic flag').toBe(false);
      expect(downFlags.semantic_reason, 'down: final /suggest semantic_reason').toBe('degraded');
      await expect
        .poll(async () => (await fakeembedStats()).query_requests, {
          timeout: UI_WAIT_MS,
          message: 'fakeembed query_requests must grow: the provider path was really called (cache miss)',
        })
        .toBeGreaterThan(statsBefore.query_requests);
    });

    await test.step('degraded: lexical row served, no near/≈ badge, no toast, muted degraded line outside the listbox', async () => {
      const lexicalRow = page.locator(LEXICAL_ITEM_ROW).filter({ hasText: lexName });
      await expect(lexicalRow).toHaveCount(1, { timeout: UI_WAIT_MS });
      const degraded = page.getByTestId('omnibox-status-degraded');
      await expect(degraded).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(page.locator('[data-zone="near"]')).toHaveCount(0);
      await expect(page.locator(NEAR_BADGE)).toHaveCount(0);
      // No toast of any kind for the degradation: the undo stack stays empty and no omnibox error surface appears.
      await expect(page.getByTestId('undo-toast-item')).toHaveCount(0);
      for (const errorTestId of ['omnibox-plan-error', 'omnibox-action-error', 'omnibox-add-error']) {
        await expect(page.getByTestId(errorTestId)).toHaveCount(0);
      }

      // Plan 2.10: muted inline line, outside the listbox, no role=status/alert (FE-23).
      const structure = await degraded.evaluate((el) => ({
        outsideListbox: el.closest('[role="listbox"]') === null,
        noLiveRole: el.closest('[role="status"], [role="alert"]') === null && !el.hasAttribute('role'),
      }));
      expect(structure).toEqual({ outsideListbox: true, noLiveRole: true });
      const isMuted = await degraded.evaluate((el) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--muted)';
        document.body.appendChild(probe);
        const expected = getComputedStyle(probe).color;
        probe.remove();
        return getComputedStyle(el).color === expected;
      });
      expect(isMuted, 'degraded line uses the --muted token color').toBe(true);
    });

    await test.step('quick-add still works while the provider is down (no error toast, item persisted)', async () => {
      const quickAddName = `${quickAddToken}-quickadd`;
      await setQuietInputValue(omnibox, `${quickAddName}: degrade-note-${randomToken()}`);
      await omnibox.press('Enter');
      await expect(page.getByTestId('undo-toast-item').filter({ hasText: quickAddName }).first()).toBeVisible({
        timeout: UI_WAIT_MS,
      });
      for (const errorTestId of ['omnibox-plan-error', 'omnibox-action-error', 'omnibox-add-error']) {
        await expect(page.getByTestId(errorTestId)).toHaveCount(0);
      }
      const lookup = await page.evaluate(async (name) => {
        const res = await fetch(`/api/v1/items/lookup?name=${encodeURIComponent(name)}`, { credentials: 'include' });
        return (await res.json()) as { total: number };
      }, quickAddName);
      expect(lookup.total).toBe(1);
    });

    await test.step('provider ok again: semantic returns within 60 s (new query per poll)', async () => {
      await fakeembedSetMode('ok');
      // Clock starts when the `ok` POST has returned; see RECOVERY_* above for why 60 s + 3 s is the exact bound.
      const recoveryStart = Date.now();
      let attempts = 0;
      let elapsedMs = Number.POSITIVE_INFINITY;
      await expect
        .poll(
          async () => {
            attempts += 1;
            const pollQuery = uniqueSemanticQuery('rec');
            await fakeembedSetAliases({ [pollQuery]: nearDocumentInput });
            const response = await suggestSemanticViaPage(page, pollQuery);
            const recovered =
              response.status === 200 &&
              (response.body as { semantic?: boolean } | null)?.semantic === true &&
              suggestNearContains(response.body, nearId);
            if (recovered) {
              elapsedMs = Date.now() - recoveryStart;
            }
            return recovered;
          },
          // Longer than the asserted bound so a late recovery fails the explicit elapsed assertion below with the number.
          { timeout: RECOVERY_BUDGET_MS + RECOVERY_MARGIN_MS + 10_000, intervals: [RECOVERY_POLL_MS] },
        )
        .toBe(true);
      expect(
        elapsedMs,
        `semantic recovered after ${elapsedMs} ms (${attempts} polls); bound ${RECOVERY_BUDGET_MS + RECOVERY_MARGIN_MS} ms`,
      ).toBeLessThanOrEqual(RECOVERY_BUDGET_MS + RECOVERY_MARGIN_MS);
    });

    await test.step('after recovery another NEW query shows near + ≈ badge again, degraded line gone', async () => {
      const backQuery = uniqueSemanticQuery('back');
      await fakeembedSetAliases({ [backQuery]: nearDocumentInput });
      const backResponse = await typeCleanQuery(page, omnibox, backQuery);
      expect((await semanticFlags(backResponse)).semantic, 'back final /suggest semantic flag').toBe(true);
      const nearRow = page.locator(NEAR_ROW).filter({ hasText: nearName });
      await expect(nearRow).toHaveCount(1, { timeout: UI_WAIT_MS });
      await expect(nearRow.locator(NEAR_BADGE)).toBeVisible();
      await expect(page.getByTestId('omnibox-status-degraded')).toHaveCount(0);
    });
  });
});
