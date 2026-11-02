import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { SuggestResponse } from '../lib/api/search';
import { isolateRateLimit } from './helpers';
import { needleForms } from './content-acceptance-support';

/**
 * Lexical helpers for the P05 Task 22 search specs (`content-search-{suggest,privacy,stable}.spec.ts`, later
 * `content-search-{visual,a11y}.spec.ts`). Everything here talks to the REAL stack (`E2E_STACK=1`, embedding provider
 * `noop`, semantic off): data is seeded through the real API, requests are observed, never stubbed.
 *
 * Out of scope on purpose: semantic helpers. `waitForEmbedded` belongs to PR 20b-1
 * (`content-search-semantic-support.ts`); PR 22-2 only imports it.
 *
 * Privacy: nothing here ever prints a typed query, a pasted secret or an entry body. Leak assertions report a label and
 * a needle-form suffix, never the needle itself.
 */

export const SEARCH_UI_WAIT_MS = 30_000;
/** Per-test budget for the search specs (the `content` project default is 90 s; specs sign up real users). */
export const SEARCH_TEST_TIMEOUT_MS = 240_000;
/** Debounce is 120 ms (plan 2.1 rule 7); the plan's "wait >= 1 s with no request" cases use this window. */
export const SEARCH_QUIET_WINDOW_MS = 1_100;

/** The home omnibox textarea (`#omni`, non-compact instance), the same selector `content-omnibox-capture` uses. */
export const SEARCH_OMNIBOX_SELECTOR = '#omni textarea[data-vault-secret]';
export const SEARCH_LISTBOX_ID = 'omni-listbox';

const API_PREFIX = '/api/v1';

// ---- Corpus ---------------------------------------------------------------------------------------------------------

export interface SearchCorpusItem {
  /** Stable label used by expectations (never a typed query). */
  readonly ref: string;
  readonly name: string;
  readonly hint?: string;
  /** Tag displays to attach right after the item is created (so the item's `last_used_at` order stays creation order). */
  readonly tags?: readonly string[];
}

export interface SearchCorpus {
  readonly tags: readonly string[];
  /** Created strictly in this order, one request at a time: a later item has a later `last_used_at` (plan 2.3 tie-break). */
  readonly items: readonly SearchCorpusItem[];
}

/**
 * User one. The names are chosen so that, per plan 2.2/2.3, each probe query has an unambiguous ranking and no stray fuzzy
 * hit (a word starting like the query elsewhere in a name would add a tier-1 row):
 *
 * - `wi`      all tier 3 (prefix) with word-similarity .67, so the order is `last_used_at DESC`:
 *             `WiFi Khách`, `wifi` (B), `wifi` (A), `window license`; tag `wifi-khách`. A and B are a duplicate name.
 * - `ma`      tier 3 `master key`, then tier 2 (prefix folded) `mã vạch` (the folded word is exactly `ma`, score 1.0) and
 *             `máy in` (.67); tag `mạng` (tier 2). There is deliberately no `manager`/`may` word in any other name.
 * - `duong`   tier 3 `duong dev server`, then tier 2 `Dương Minh` and `đường dẫn` (both score 1.0, newer first).
 * - `pasword` fuzzy only: `password vault` (word-similarity ~.70, `match: fuzzy`); `passport scan` stays below .5.
 * - `#nh`     tags `nhà` and `nhật-ký` (both tier 3, equal score; their mutual order is not asserted).
 * - empty     recent: items = the five newest names, tags = three tags.
 */
export const SEARCH_CORPUS_ONE: SearchCorpus = {
  tags: ['wifi-khách', 'nhà', 'nhật-ký', 'mạng'],
  items: [
    { ref: 'window', name: 'window license' },
    { ref: 'wifiA', name: 'wifi', hint: 'primary', tags: ['wifi-khách', 'nhà'] },
    { ref: 'wifiB', name: 'wifi', hint: 'guest' },
    { ref: 'wifiKhach', name: 'WiFi Khách' },
    { ref: 'master', name: 'master key' },
    { ref: 'mavach', name: 'mã vạch', tags: ['mạng'] },
    { ref: 'may', name: 'máy in' },
    { ref: 'passport', name: 'passport scan' },
    { ref: 'password', name: 'password vault', tags: ['nhật-ký'] },
    { ref: 'duongDan', name: 'đường dẫn' },
    { ref: 'duongMinh', name: 'Dương Minh' },
    { ref: 'duongDev', name: 'duong dev server' },
  ],
};

/** User two shares the `wi` prefix with user one but none of user one's names, tags or ids. */
export const SEARCH_CORPUS_TWO: SearchCorpus = {
  tags: ['wiz-team'],
  items: [{ ref: 'wiz', name: 'wiz tracker', tags: ['wiz-team'] }],
};

export interface SeededRow {
  readonly ref: string;
  readonly id: string;
  readonly name: string;
}

export interface SeededCorpus {
  readonly tagIds: ReadonlyMap<string, string>;
  readonly items: readonly SeededRow[];
  /** `item:<id>` / `tag:<id>` keys of everything seeded (used for cross-user isolation checks). */
  readonly allKeys: ReadonlySet<string>;
  itemId(ref: string): string;
  itemKey(ref: string): string;
  tagKey(display: string): string;
}

/**
 * Same-origin write from the page jar (cookies + CSRF + `Idempotency-Key`), the pattern of `content-home.spec`.
 * Bodies carry fixture names only.
 */
export async function searchApiMutate<TResponse>(
  page: Page,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: TResponse }> {
  return page.evaluate(
    async ({ methodArg, pathArg, bodyArg, prefix }) => {
      let csrf: string | null = null;
      for (const part of document.cookie.split(';')) {
        const trimmed = part.trim();
        if (trimmed.startsWith('sabk_csrf=')) {
          csrf = decodeURIComponent(trimmed.slice('sabk_csrf='.length));
          break;
        }
      }
      const res = await fetch(`${prefix}${pathArg}`, {
        method: methodArg,
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          ...(bodyArg !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: bodyArg !== undefined ? JSON.stringify(bodyArg) : undefined,
      });
      const parsed = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
      return { status: res.status, data: parsed as unknown };
    },
    { methodArg: method, pathArg: path, bodyArg: body, prefix: API_PREFIX },
  ) as Promise<{ status: number; data: TResponse }>;
}

/**
 * Seeds `corpus` through the real API (tags first, then items one by one, each item tagged before the next is created).
 * Needs a signed-in page; no vault key is involved (names/tags are plaintext, user-dec-016).
 */
export async function seedSearchCorpus(page: Page, corpus: SearchCorpus): Promise<SeededCorpus> {
  const tagIds = new Map<string, string>();
  for (const display of corpus.tags) {
    const res = await searchApiMutate<{ id: string }>(page, 'POST', '/tags', { display });
    expect(res.status, 'seed tag').toBe(201);
    tagIds.set(display, res.data.id);
  }
  const rows: SeededRow[] = [];
  for (const item of corpus.items) {
    const created = await searchApiMutate<{ id: string }>(page, 'POST', '/items', {
      name: item.name,
      ...(item.hint !== undefined ? { hint: item.hint } : {}),
    });
    expect(created.status, 'seed item').toBe(201);
    if (item.tags && item.tags.length > 0) {
      const tagIdList = item.tags.map((display) => {
        const id = tagIds.get(display);
        if (!id) throw new Error(`seed: tag "${display}" is not in the corpus tag list`);
        return id;
      });
      const attached = await searchApiMutate(page, 'POST', `/items/${created.data.id}/tags`, { tag_ids: tagIdList });
      expect(attached.status, 'seed item tags').toBe(200);
    }
    rows.push({ ref: item.ref, id: created.data.id, name: item.name });
  }
  const allKeys = new Set<string>([
    ...rows.map((r) => `item:${r.id}`),
    ...[...tagIds.values()].map((id) => `tag:${id}`),
  ]);
  const byRef = new Map(rows.map((r) => [r.ref, r] as const));
  const itemId = (ref: string): string => {
    const row = byRef.get(ref);
    if (!row) throw new Error(`seed: unknown item ref "${ref}"`);
    return row.id;
  };
  return {
    tagIds,
    items: rows,
    allKeys,
    itemId,
    itemKey(ref: string): string {
      return `item:${itemId(ref)}`;
    },
    tagKey(display: string): string {
      const id = tagIds.get(display);
      if (!id) throw new Error(`seed: unknown tag "${display}"`);
      return `tag:${id}`;
    },
  };
}

// ---- Request recorder ---------------------------------------------------------------------------------------------

export interface RecordedRequest {
  readonly seq: number;
  readonly method: string;
  readonly url: string;
  readonly pathname: string;
  readonly headersText: string;
  readonly postData: string;
}

export interface NeedleSecret {
  /** Static label used in failure messages, never the value. */
  readonly label: string;
  readonly value: string;
}

export interface SearchRequestRecorder {
  readonly records: readonly RecordedRequest[];
  /** Index to pass to the `*Since` helpers later. */
  mark(): number;
  since(mark: number): readonly RecordedRequest[];
  /** `GET /api/v1/suggest` (any), optionally only those carrying `q`. */
  suggestSince(mark: number, opts?: { readonly withQuery?: boolean }): readonly RecordedRequest[];
  searchSince(mark: number): readonly RecordedRequest[];
  /**
   * Requests a typed or pasted omnibox draft could have produced: `/suggest` WITH `q`, `/search`, `/items/lookup`, any
   * `/items`, `/tags`, `/entries` write. Excludes the `q`-less `recent` suggest of a focus and background list reads.
   */
  omniboxRequestsSince(mark: number): readonly RecordedRequest[];
  /** `q` values of every `/suggest` that carried one since `mark`, in send order. */
  suggestQueriesSince(mark: number): readonly string[];
  /** Resolves headers that arrive after the sync `request` event. Call before asserting on `headersText`. */
  flush(): Promise<void>;
  /** Throws (label + needle-form suffix + surface only) if any request since `mark` carries any form of a secret. */
  assertNeverContains(secrets: readonly NeedleSecret[], mark?: number): Promise<void>;
  /** Throws if an omnibox-relevant request was sent since `mark`. */
  expectNoOmniboxRequestsSince(mark: number, label: string): void;
}

export function queryParamOf(rec: Pick<RecordedRequest, 'url'>, name: string): string | null {
  try {
    return new URL(rec.url).searchParams.get(name);
  } catch {
    return null;
  }
}

export function hasQueryParam(rec: Pick<RecordedRequest, 'url'>, name: string): boolean {
  try {
    return new URL(rec.url).searchParams.has(name);
  } catch {
    return false;
  }
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('?')[0]?.split('#')[0] ?? '';
  }
}

function redactedPath(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean);
  return `/${parts.slice(0, 3).join('/')}`;
}

/** Literal / base64 / base64url / hex / URI forms (`needleForms`) plus the form-style `+` for spaces. */
function searchNeedleForms(value: string): Array<{ readonly suffix: string; readonly value: string }> {
  const forms = needleForms(value).map((f) => ({ suffix: f.suffix, value: f.value }));
  if (value.includes(' ')) {
    forms.push({ suffix: '#plus', value: encodeURIComponent(value).replace(/%20/g, '+') });
  }
  return forms;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function isOmniboxRelevant(rec: RecordedRequest): boolean {
  const { method, pathname, url } = rec;
  if (method === 'GET' && pathname === `${API_PREFIX}/search`) return true;
  if (method === 'GET' && pathname === `${API_PREFIX}/suggest` && hasQueryParam({ url }, 'q')) return true;
  if (pathname.startsWith(`${API_PREFIX}/items/lookup`)) return true;
  if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
    return (
      pathname.startsWith(`${API_PREFIX}/items`) ||
      pathname.startsWith(`${API_PREFIX}/tags`) ||
      pathname.startsWith(`${API_PREFIX}/entries`)
    );
  }
  return false;
}

/**
 * Captures URL + headers + post body of EVERY request the context makes. Attach it BEFORE the first navigation so the
 * record starts at page load (plan Task 22: "capture URL, header, body mọi request"). Held in memory only, never logged.
 */
export function attachSearchRequestRecorder(context: BrowserContext): SearchRequestRecorder {
  const records: RecordedRequest[] = [];
  const pending = new Set<Promise<void>>();

  const keep = (hdrs: Record<string, string>): string =>
    Object.entries(hdrs)
      .filter(([k]) => !k.toLowerCase().startsWith('sec-'))
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');

  context.on('request', (req) => {
    const url = req.url();
    const base: RecordedRequest = {
      seq: records.length,
      method: req.method(),
      url,
      pathname: pathnameOf(url),
      headersText: keep(req.headers()),
      postData: req.postData() ?? '',
    };
    const index = records.length;
    records.push(base);
    const task: Promise<void> = req
      .allHeaders()
      .then((all) => {
        records[index] = { ...base, headersText: keep(all) };
      })
      .catch(() => undefined)
      .finally(() => {
        pending.delete(task);
      });
    pending.add(task);
  });

  const recorder: SearchRequestRecorder = {
    records,
    mark: () => records.length,
    since: (mark) => records.slice(mark),
    suggestSince: (mark, opts) =>
      records
        .slice(mark)
        .filter(
          (r) =>
            r.method === 'GET' &&
            r.pathname === `${API_PREFIX}/suggest` &&
            (opts?.withQuery === undefined || hasQueryParam(r, 'q') === opts.withQuery),
        ),
    searchSince: (mark) =>
      records.slice(mark).filter((r) => r.method === 'GET' && r.pathname === `${API_PREFIX}/search`),
    omniboxRequestsSince: (mark) => records.slice(mark).filter(isOmniboxRelevant),
    suggestQueriesSince: (mark) =>
      records
        .slice(mark)
        .filter((r) => r.method === 'GET' && r.pathname === `${API_PREFIX}/suggest` && hasQueryParam(r, 'q'))
        .map((r) => queryParamOf(r, 'q') ?? ''),
    async flush() {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },
    async assertNeverContains(secrets, mark = 0) {
      await recorder.flush();
      const leaks: string[] = [];
      for (const rec of records.slice(mark)) {
        const surfaces: ReadonlyArray<readonly [string, string]> = [
          ['url', rec.url],
          ['url-decoded', safeDecode(rec.url)],
          ['headers', rec.headersText],
          ['postData', rec.postData],
        ];
        for (const secret of secrets) {
          if (!secret.value) continue;
          for (const form of searchNeedleForms(secret.value)) {
            for (const [surface, text] of surfaces) {
              if (text.includes(form.value)) {
                leaks.push(
                  `${rec.method} ${redactedPath(rec.pathname)} leaks ${secret.label}${form.suffix} in ${surface}`,
                );
              }
            }
          }
        }
      }
      expect(leaks, `request carried a registered secret: ${leaks.join('; ')}`).toEqual([]);
    },
    expectNoOmniboxRequestsSince(mark, label) {
      const matched = records.slice(mark).filter(isOmniboxRelevant);
      expect(
        matched.map((r) => `${r.method} ${redactedPath(r.pathname)}`),
        `${label}: expected no omnibox request`,
      ).toEqual([]);
    },
  };
  return recorder;
}

// ---- Waiting for / reading /suggest ---------------------------------------------------------------------------------

export interface SuggestCapture {
  readonly url: string;
  readonly status: number;
  readonly body: SuggestResponse;
}

export interface SuggestMatcher {
  /** Exact `q` the request must carry; `null` = the request must carry none (focus / recent). Omit = any. */
  readonly q?: string | null;
  readonly scope?: string;
}

/**
 * Resolves with the next completed `GET /api/v1/suggest` response matching `matcher`. Create the promise BEFORE the
 * action that triggers it (typing, focus), then await it, so the wait is on the response, never on a timer.
 */
export function waitForSuggestResponse(
  page: Page,
  matcher: SuggestMatcher = {},
  timeout = SEARCH_UI_WAIT_MS,
): Promise<SuggestCapture> {
  return page
    .waitForResponse(
      (res) => {
        const req = res.request();
        if (req.method() !== 'GET' || pathnameOf(res.url()) !== `${API_PREFIX}/suggest`) return false;
        const params = new URL(res.url()).searchParams;
        if (matcher.q === null && params.has('q')) return false;
        if (typeof matcher.q === 'string' && params.get('q') !== matcher.q) return false;
        if (matcher.scope !== undefined && params.get('scope') !== matcher.scope) return false;
        return true;
      },
      { timeout },
    )
    .then(async (res) => ({
      url: res.url(),
      status: res.status(),
      body: (await res.json()) as SuggestResponse,
    }));
}

/** `GET /api/v1/search` response (Enter search) matching an optional exact `q` / `scope`. */
export function waitForSearchResponse(
  page: Page,
  matcher: SuggestMatcher = {},
  timeout = SEARCH_UI_WAIT_MS,
): Promise<{ readonly url: string; readonly status: number }> {
  return page
    .waitForResponse(
      (res) => {
        if (res.request().method() !== 'GET' || pathnameOf(res.url()) !== `${API_PREFIX}/search`) return false;
        const params = new URL(res.url()).searchParams;
        if (typeof matcher.q === 'string' && params.get('q') !== matcher.q) return false;
        if (matcher.scope !== undefined && params.get('scope') !== matcher.scope) return false;
        return true;
      },
      { timeout },
    )
    .then((res) => ({ url: res.url(), status: res.status() }));
}

/** Keys the dropdown must show for a lexical `/suggest` body: tags, items, then near; recent shows items then tags. */
export function expectedKeysFromSuggest(body: SuggestResponse, opts: { readonly recent?: boolean } = {}): string[] {
  const tags = body.tags.map((t) => `tag:${t.id}`);
  const items = body.items.map((i) => `item:${i.id}`);
  const near = body.near.map((n) => `${n.kind}:${n.id}`);
  return opts.recent ? [...items, ...tags, ...near] : [...tags, ...items, ...near];
}

// ---- Reading the dropdown -------------------------------------------------------------------------------------------

export interface ListboxOptionInfo {
  /** `kind:id` for rows, `action:more` / `action:create` for actions. */
  readonly key: string;
  readonly kind: 'item' | 'tag' | 'more' | 'create' | string;
  /** `data-zone` of the enclosing `role=group`, or `null` if the option sits outside any group (a markup bug). */
  readonly zone: string | null;
  /** Row title text for item/tag rows only; `null` for action rows (the CTA text carries the draft and is never read). */
  readonly title: string | null;
  readonly chipCount: number;
  readonly meta: string | null;
  readonly hasDate: boolean;
  readonly badge: string | null;
}

export interface ListboxZoneInfo {
  readonly id: string;
  readonly heading: string;
  readonly keys: readonly string[];
}

export interface ListboxInfo {
  readonly present: boolean;
  readonly ariaLabel: string | null;
  readonly busy: boolean;
  readonly zones: readonly ListboxZoneInfo[];
  readonly options: readonly ListboxOptionInfo[];
  /** `data-opt-key` of the option `aria-activedescendant` points to, `null` when unset or dangling. */
  readonly activeKey: string | null;
  readonly activeDescendantId: string | null;
}

/** One DOM read of `#omni-listbox` (structure only; never returns the CTA label or any attribute holding the draft). */
export async function readListbox(page: Page): Promise<ListboxInfo> {
  return page.evaluate(
    ({ listboxId, inputSelector }) => {
      const input = document.querySelector<HTMLElement>(inputSelector);
      const activeId = input?.getAttribute('aria-activedescendant') ?? null;
      const activeEl = activeId ? document.getElementById(activeId) : null;
      const root = document.getElementById(listboxId);
      if (!root) {
        return {
          present: false,
          ariaLabel: null,
          busy: false,
          zones: [],
          options: [],
          activeKey: activeEl?.getAttribute('data-opt-key') ?? null,
          activeDescendantId: activeId,
        };
      }
      const zones = Array.from(root.querySelectorAll<HTMLElement>('[role="group"]')).map((group) => {
        const headingId = group.getAttribute('aria-labelledby');
        const heading = headingId ? (document.getElementById(headingId)?.textContent ?? '') : '';
        return {
          id: group.getAttribute('data-zone') ?? '',
          heading: heading.trim(),
          keys: Array.from(group.querySelectorAll<HTMLElement>('[role="option"]')).map(
            (o) => o.getAttribute('data-opt-key') ?? '',
          ),
        };
      });
      const options = Array.from(root.querySelectorAll<HTMLElement>('[role="option"]')).map((opt) => {
        const kind = opt.getAttribute('data-opt-kind') ?? '';
        const rowLike = kind === 'item' || kind === 'tag';
        const meta = rowLike ? (opt.querySelector('.sugg-meta')?.textContent ?? '').trim() : null;
        return {
          key: opt.getAttribute('data-opt-key') ?? '',
          kind,
          zone: opt.closest('[role="group"]')?.getAttribute('data-zone') ?? null,
          title: rowLike ? (opt.querySelector('.omni-opt-title')?.textContent ?? '').trim() : null,
          chipCount: opt.querySelectorAll('.chip.dup-chip').length,
          meta,
          hasDate: meta !== null && /\d{4}-\d{2}-\d{2}/.test(meta),
          badge: rowLike ? (opt.querySelector('.sugg-match-badge')?.textContent ?? '').trim() || null : null,
        };
      });
      return {
        present: true,
        ariaLabel: root.getAttribute('aria-label'),
        busy: root.getAttribute('aria-busy') === 'true',
        zones,
        options,
        activeKey: activeEl?.getAttribute('data-opt-key') ?? null,
        activeDescendantId: activeId,
      };
    },
    { listboxId: SEARCH_LISTBOX_ID, inputSelector: SEARCH_OMNIBOX_SELECTOR },
  );
}

/** `kind:id` keys of row options (items and tags) in on-screen order, actions excluded. */
export function rowKeys(info: ListboxInfo): string[] {
  return info.options.filter((o) => o.kind === 'item' || o.kind === 'tag').map((o) => o.key);
}

/** Polls the dropdown until its row keys equal `expected` (react renders after the response resolves). */
export async function expectRowKeys(page: Page, expected: readonly string[], timeout = SEARCH_UI_WAIT_MS): Promise<void> {
  await expect.poll(async () => rowKeys(await readListbox(page)), { timeout }).toEqual([...expected]);
}

// ---- Input mechanics (L13, FE-3) ------------------------------------------------------------------------------------

export function searchOmnibox(page: Page): Locator {
  return page.locator(SEARCH_OMNIBOX_SELECTOR);
}

/** Real key events (`keyboard.type`): each char reaches the native `beforeinput` as `insertText`, so the draft stays clean. */
export async function typeKeys(page: Page, text: string, opts: { readonly delay?: number } = {}): Promise<void> {
  await page.keyboard.type(text, opts);
}

/** Boolean check that the textarea equals `expected`, without echoing either value on failure. */
export async function expectDraftEquals(omnibox: Locator, expected: string, timeout = SEARCH_UI_WAIT_MS): Promise<void> {
  await expect
    .poll(async () => omnibox.evaluate((el, exp) => (el as HTMLTextAreaElement).value === exp, expected), { timeout })
    .toBe(true);
}

/** Boolean check on the draft prefix (FE-25), no value echo. */
export async function expectDraftStartsWith(
  omnibox: Locator,
  prefix: string,
  timeout = SEARCH_UI_WAIT_MS,
): Promise<void> {
  await expect
    .poll(async () => omnibox.evaluate((el, p) => (el as HTMLTextAreaElement).value.startsWith(p), prefix), { timeout })
    .toBe(true);
}

export async function expectDraftEmpty(omnibox: Locator, timeout = SEARCH_UI_WAIT_MS): Promise<void> {
  await expect
    .poll(async () => omnibox.evaluate((el) => (el as HTMLTextAreaElement).value.length === 0), { timeout })
    .toBe(true);
}

export async function clearDraft(page: Page, omnibox: Locator): Promise<void> {
  await omnibox.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await expectDraftEmpty(omnibox);
}

// ---- Clipboard (paste = writeText + real Control+V) -----------------------------------------------------------------

export function baseOrigin(): string {
  return new URL(process.env.BASE_URL ?? 'http://127.0.0.1:3000').origin;
}

/** Grants `clipboard-read`/`clipboard-write` to an existing context (e.g. the fixture's `page.context()`). */
export async function grantClipboard(context: BrowserContext): Promise<void> {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseOrigin() });
}

/**
 * New isolated context (own rate-limit hop, 1440x900) that already has the clipboard permissions. Use it for a second
 * user or for a context that is created before any navigation.
 */
export async function newClipboardContext(
  browser: Browser,
  opts: { readonly viewport?: { readonly width: number; readonly height: number } } = {},
): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: baseOrigin(),
    viewport: opts.viewport ?? { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await isolateRateLimit(context);
  return context;
}

/**
 * Paste, the way a user does: write the clipboard, focus the omnibox, press the real `Control+V`. Chromium then fires
 * `beforeinput`/`input` with `inputType: 'insertFromPaste'`, which taints the draft (plan 2.1 rule 1). Never use
 * `locator.fill()` for a paste case: it fires `insertText`.
 *
 * The context must have clipboard permissions (`grantClipboard` / `newClipboardContext`). The text appears only as an
 * `evaluate` argument and is never logged.
 */
export async function pasteIntoOmnibox(page: Page, omnibox: Locator, text: string): Promise<void> {
  await page.evaluate(async (value) => {
    await navigator.clipboard.writeText(value);
  }, text);
  await omnibox.focus();
  await page.keyboard.press('Control+V');
}
