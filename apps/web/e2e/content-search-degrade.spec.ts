import { randomBytes } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
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
const RECOVERY_BUDGET_MS = 60_000;
const RECOVERY_POLL_MS = 2_000;

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
 * `/suggest`, plan 2.1). Resolves after the `semantic=1` response of the FINAL keystroke arrived.
 */
async function typeCleanQuery(page: Page, omnibox: Locator, query: string): Promise<void> {
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
  await finalSuggest;
}

test.describe('P05-T20b @semantic degrade: provider down mid-session', () => {
  // Local runs without the stack skip. In CI the spec never skips: if the semantic job were misconfigured (no stack env),
  // the job must go red at signup/fakeembed instead of staying green with every test skipped.
  test.skip(
    !process.env.E2E_STACK && !process.env.CI,
    'needs the compose stack (E2E_STACK=1) with profile semantic-fake: real API, real fakeembed provider',
  );

  // Never leave the shared fake in `down`/`slow`: later @semantic specs of the same job reuse it.
  test.afterEach(async () => {
    await fakeembedReset();
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
      await typeCleanQuery(page, omnibox, baselineQuery);
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
      await typeCleanQuery(page, omnibox, downQuery);
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
      const recoveryStart = Date.now();
      let recovered = false;
      let attempts = 0;
      while (!recovered && Date.now() - recoveryStart < RECOVERY_BUDGET_MS) {
        attempts += 1;
        const pollQuery = uniqueSemanticQuery('rec');
        await fakeembedSetAliases({ [pollQuery]: nearDocumentInput });
        const response = await suggestSemanticViaPage(page, pollQuery);
        recovered =
          response.status === 200 &&
          (response.body as { semantic?: boolean } | null)?.semantic === true &&
          suggestNearContains(response.body, nearId);
        if (!recovered) {
          await new Promise((resolve) => setTimeout(resolve, RECOVERY_POLL_MS));
        }
      }
      expect(recovered, `semantic did not come back within ${RECOVERY_BUDGET_MS} ms (${attempts} polls)`).toBe(true);
    });

    await test.step('after recovery another NEW query shows near + ≈ badge again, degraded line gone', async () => {
      const backQuery = uniqueSemanticQuery('back');
      await fakeembedSetAliases({ [backQuery]: nearDocumentInput });
      await typeCleanQuery(page, omnibox, backQuery);
      const nearRow = page.locator(NEAR_ROW).filter({ hasText: nearName });
      await expect(nearRow).toHaveCount(1, { timeout: UI_WAIT_MS });
      await expect(nearRow.locator(NEAR_BADGE)).toBeVisible();
      await expect(page.getByTestId('omnibox-status-degraded')).toHaveCount(0);
    });
  });
});
