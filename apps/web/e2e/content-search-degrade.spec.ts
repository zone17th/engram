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
 * Recovery bound, derived from the breaker cooldown (no free-standing budget literal).
 * SPEC §6.6 "breaker 60 s": the API embedding breaker opens on the FIRST provider failure and admits its first half-open
 * probe `embedding.BreakerOpenWindow` later (`apps/api/internal/embedding/breaker.go:18`, fixed, not configurable).
 * So the user-visible contract is "semantic returns within the 60 s breaker window after the provider recovers": once the
 * provider is `ok`, the first request at or after `breakerOpenedAt + 60 s` closes the breaker and returns `semantic: true`.
 *
 * `breakerOpenedAt` is the instant the first down-mode `/suggest` response with `semantic_reason: "degraded"` reached the
 * browser; that is an UPPER bound of the true breaker-open instant (the breaker opened server-side before that response
 * was sent), so the assertion can only be looser than reality by one response latency, never tighter.
 * Asserted: `tRecovered - breakerOpenedAt <= BREAKER_OPEN_WINDOW_MS + RECOVERY_POLL_MS + RECOVERY_REQUEST_SLACK_MS`
 * (first poll at/after the window starts at most one poll interval late, plus one alias POST + /suggest round trip).
 */
/** SPEC §6.6 / `embedding/breaker.go:18` `BreakerOpenWindow` (strict: the spec fixes 60 s). */
const BREAKER_OPEN_WINDOW_MS = 60_000;
const RECOVERY_POLL_MS = 500;
/** One request round-trip allowance: the recovering poll is an alias POST then a /suggest cache-miss provider call. */
const RECOVERY_REQUEST_SLACK_MS = 2_000;
const RECOVERY_BOUND_MS = BREAKER_OPEN_WINDOW_MS + RECOVERY_POLL_MS + RECOVERY_REQUEST_SLACK_MS;
/** Polling continues this long past the bound only so a late recovery fails the explicit assertion with its numbers. */
const RECOVERY_FAILURE_REPORT_MS = 10_000;
/** Upper cap for the failure-only cleanup poll: the breaker window plus the same poll/request allowances. */
const CLEANUP_RECOVERY_MS = RECOVERY_BOUND_MS + RECOVERY_FAILURE_REPORT_MS;

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

    // Upper bound of the breaker-open instant: first down-mode `/suggest?semantic=1` response flagged `degraded`.
    const breaker: { openedAt: number | null } = { openedAt: null };

    await test.step('provider down mid-session; a NEW never-sent query reaches fakeembed (stats counter grows)', async () => {
      const statsBefore = await fakeembedStats();
      const onResponse = (res: PageResponse): void => {
        const receivedAt = Date.now();
        if (breaker.openedAt !== null) {
          return;
        }
        const url = new URL(res.url());
        if (url.pathname !== '/api/v1/suggest' || url.searchParams.get('semantic') !== '1') {
          return;
        }
        res
          .json()
          .then((body: { semantic?: boolean; semantic_reason?: string | null } | null) => {
            if (breaker.openedAt === null && body?.semantic === false && body.semantic_reason === 'degraded') {
              breaker.openedAt = receivedAt;
            }
          })
          .catch(() => {
            // body unavailable (navigation / aborted request): not a degraded observation
          });
      };
      page.on('response', onResponse);
      await fakeembedSetMode('down');
      let downResponse: PageResponse;
      try {
        downResponse = await typeCleanQuery(page, omnibox, downQuery);
      } finally {
        page.off('response', onResponse);
      }
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
      // The provider was really hit (counter grew) and a down-mode response came back degraded: that response instant is
      // the recovery clock's origin. The listener resolves from the response body, so give it a moment to settle.
      await expect
        .poll(() => breaker.openedAt !== null, {
          timeout: UI_WAIT_MS,
          message: 'a down-mode /suggest response with semantic_reason "degraded" must have been observed',
        })
        .toBe(true);
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

    await test.step('provider ok again: semantic returns within the 60 s breaker window (new query per poll)', async () => {
      const breakerOpenedAt = breaker.openedAt;
      if (breakerOpenedAt === null) {
        throw new Error('breaker-open instant was not recorded in the down step');
      }
      await fakeembedSetMode('ok');
      // Clock origin is `breakerOpenedAt` (not the `ok` POST): the cooldown runs from the failure, see RECOVERY_* above.
      let attempts = 0;
      let elapsedMs = Number.POSITIVE_INFINITY;
      // Poll past the bound only to fail with the measured numbers; the assertion below stays strict.
      const pollDeadline = breakerOpenedAt + RECOVERY_BOUND_MS + RECOVERY_FAILURE_REPORT_MS;
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
              elapsedMs = Date.now() - breakerOpenedAt;
            }
            return recovered;
          },
          { timeout: Math.max(pollDeadline - Date.now(), 1_000), intervals: [RECOVERY_POLL_MS] },
        )
        .toBe(true);
      expect(
        elapsedMs,
        `semantic recovered ${elapsedMs} ms after the breaker opened (${attempts} polls); bound ${RECOVERY_BOUND_MS} ms = ` +
          `${BREAKER_OPEN_WINDOW_MS} breaker window + ${RECOVERY_POLL_MS} poll + ${RECOVERY_REQUEST_SLACK_MS} request slack`,
      ).toBeLessThanOrEqual(RECOVERY_BOUND_MS);
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
