import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';

/**
 * Shared helpers for the `@semantic` Playwright specs (P05 Task 20b-1; reused by the Task 22 `@semantic` specs).
 * They run only in the `e2e-search-semantic` CI job, against the real semantic server wired to the CI-only `fakeembed`
 * provider (compose profile `semantic-fake`); nothing here stubs `/suggest` or `/search` with `page.route`.
 *
 * Mandatory order inside every `@semantic` spec (plan Task 20b, N1):
 *   seed -> `waitForEmbedded` -> (if needed) `fakeembedSetMode('slow' | 'down')` -> type.
 * Every `slow`/`down` scenario types a NEW, never-sent query (`uniqueSemanticQuery`) so the server query-vector cache
 * cannot answer it, reads `fakeembedStats()` before and after and asserts `query_requests` grew (the provider path was
 * really called) before it asserts a late/degraded near zone. A probe query (`probeQuery`) is never reused as a
 * scenario query: the probes only warm readiness, never the cache entry a scenario depends on.
 *
 * Breaker contract: `waitForEmbedded` MUST precede any `slow`/`down` step. The API embedding breaker opens on the first
 * provider failure (threshold 1) and stays open for 60 s, so a spec that fails after `down` can leave it open even
 * after `fakeembedReset()`. A successful `waitForEmbedded` proves the breaker is closed (a fresh probe reached the
 * provider and its vector matched), so a retry or the next `@semantic` spec is safe as long as it calls it first.
 */

/**
 * fakeembed control plane (published on 127.0.0.1 by compose profile `semantic-fake`, default port 8090).
 * The `e2e-search-semantic` job pins `FAKEEMBED_CONTROL_URL` explicitly; the default matches compose.
 */
export const FAKEEMBED_CONTROL_URL = (process.env.FAKEEMBED_CONTROL_URL ?? 'http://127.0.0.1:8090').replace(/\/+$/, '');

/**
 * Prefix the TEI client puts in front of every document input (`TEI_INPUT_PREFIX_DOCUMENT`; the `semantic-fake` stack
 * and job `e2e-search-semantic` run with `'passage: '`, ci.yml). fakeembed's alias value must equal the exact document
 * input the provider received, so an alias only reaches cosine 1.0 against the stored vector when this matches the
 * stack. Prefer the stack's own variable (passed into the Playwright container) so the two cannot drift apart;
 * `FAKEEMBED_DOC_PREFIX` is a manual override, `'passage: '` the fallback.
 */
export const FAKEEMBED_DOCUMENT_PREFIX =
  process.env.TEI_INPUT_PREFIX_DOCUMENT ?? process.env.FAKEEMBED_DOC_PREFIX ?? 'passage: ';

/** `near` carries at most 5 rows (plan 2.4), so one `waitForEmbedded` call covers at most 5 targets. */
export const WAIT_FOR_EMBEDDED_MAX_TARGETS = 5;
export const WAIT_FOR_EMBEDDED_TIMEOUT_MS = 60_000;
const WAIT_FOR_EMBEDDED_POLL_MS = 1_000;
const QUERY_MAX_RUNES = 200;

export type FakeembedMode = 'ok' | 'slow' | 'down';

export interface FakeembedStats {
  readonly query_requests: number;
  readonly document_requests: number;
  readonly total_requests: number;
}

export interface EmbeddedTarget {
  /** Item or tag id (the helper reads the item first, then the tag list). */
  readonly id: string;
  /** Lowercase probe query, unique per target and never typed as a scenario query (`nextProbeQuery()`). */
  readonly probeQuery: string;
}

/**
 * `POST /__control` with only `aliases` (no `mode`) resets the fake to `ok` (empty mode = ok), and each POST of
 * `aliases` REPLACES the whole map. Both are traps for a spec that sets `down` and then adds an alias, so this module
 * remembers the mode it last set and the aliases it posted, and re-sends them with every control call. State is per
 * Playwright worker process; specs of the `content` project run serially (`workers: 1` under `E2E_STACK`).
 */
let currentMode: FakeembedMode = 'ok';
const aliasRegistry = new Map<string, string>();

async function controlRequest(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${FAKEEMBED_CONTROL_URL}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`fakeembed ${method} ${path} unreachable (is FAKEEMBED_CONTROL_URL right and the semantic-fake stack up?)`);
  }
  if (!response.ok) {
    throw new Error(`fakeembed ${method} ${path} returned HTTP ${response.status}`);
  }
  return response.json();
}

/** `POST /__control {"mode": ...}`; `slow` takes an optional delay (the fake keeps its previous delay otherwise). */
export async function fakeembedSetMode(mode: FakeembedMode, opts: { readonly delayMs?: number } = {}): Promise<void> {
  const payload: Record<string, unknown> = { mode };
  if (opts.delayMs !== undefined) {
    payload.delay_ms = opts.delayMs;
  }
  await controlRequest('POST', '/__control', payload);
  currentMode = mode;
}

/** Merges `aliases` (`query -> exact document input`) into the registry and posts the whole map in the current mode. */
export async function fakeembedSetAliases(aliases: Readonly<Record<string, string>>): Promise<void> {
  for (const [query, documentInput] of Object.entries(aliases)) {
    aliasRegistry.set(query, documentInput);
  }
  await controlRequest('POST', '/__control', { mode: currentMode, aliases: Object.fromEntries(aliasRegistry) });
}

/** `GET /__control/stats`: counters only (never inputs). `query_requests` counts query-prefixed provider calls. */
export async function fakeembedStats(): Promise<FakeembedStats> {
  const raw = (await controlRequest('GET', '/__control/stats')) as Partial<FakeembedStats>;
  const { query_requests: query, document_requests: documents, total_requests: total } = raw;
  if (typeof query !== 'number' || typeof documents !== 'number' || typeof total !== 'number') {
    throw new Error('fakeembed /__control/stats returned an unexpected shape');
  }
  return { query_requests: query, document_requests: documents, total_requests: total };
}

/** Puts the fake back in `ok` (call from `afterEach` so a failed `down`/`slow` scenario cannot poison later specs). */
export async function fakeembedReset(): Promise<void> {
  await fakeembedSetMode('ok');
}

/**
 * A query that no other test of the job has ever sent: lowercase `[a-z0-9-]` with alphanumeric edges, so its
 * normalised form `qn` (lowercase, collapsed spaces, edge punctuation stripped; plan 2.2) equals the string itself and
 * it can be used as an alias key as typed. `label` is a short lowercase word for readable failures (letters only).
 */
export function uniqueSemanticQuery(label: string): string {
  if (!/^[a-z]{1,16}$/.test(label)) {
    throw new Error('uniqueSemanticQuery label must be 1-16 lowercase letters');
  }
  return `zz${label}-${randomBytes(6).toString('hex')}`;
}

let probeSequence = 0;
const probeRunTag = randomBytes(3).toString('hex');

/** Next probe query for `waitForEmbedded`: `zzprobe-<n>-<run tag>`; never use it as a scenario query. */
export function nextProbeQuery(): string {
  probeSequence += 1;
  return `zzprobe-${probeSequence}-${probeRunTag}`;
}

/** Plan 2.14: item = `name` trimmed + (`" — " + hint` when hint is non-empty); tag = `display` verbatim. */
export function itemDocumentText(name: string, hint: string | null | undefined): string {
  const trimmedName = name.trim();
  const trimmedHint = (hint ?? '').trim();
  return trimmedHint === '' ? trimmedName : `${trimmedName} — ${trimmedHint}`;
}

/** The exact provider input for a stored document (document prefix + plan 2.14 text); the value an alias must carry. */
export function documentInput(text: string): string {
  return `${FAKEEMBED_DOCUMENT_PREFIX}${text}`;
}

interface PageJson {
  readonly status: number;
  readonly body: unknown;
}

/** Same-origin GET from the page cookie jar (the helpers.ts pattern); the page must already be on the app origin. */
async function getJsonViaPage(page: Page, path: string): Promise<PageJson> {
  if (!/^https?:/.test(page.url())) {
    throw new Error('page must be on the app origin before calling a semantic helper');
  }
  return page.evaluate(async (target) => {
    const res = await fetch(target, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    return { status: res.status, body };
  }, path);
}

/** `GET /suggest?semantic=1&q=<query>` as the test user (used for probes and for recovery polling). */
export async function suggestSemanticViaPage(page: Page, query: string): Promise<PageJson> {
  const qs = new URLSearchParams({ q: query, semantic: '1' });
  return getJsonViaPage(page, `/api/v1/suggest?${qs.toString()}`);
}

interface SuggestBody {
  readonly semantic?: boolean;
  readonly semantic_reason?: string | null;
  readonly near?: ReadonlyArray<{ readonly id?: string }>;
}

/** `true` when `body` is a `/suggest` response whose `near` zone contains `id`. */
export function suggestNearContains(body: unknown, id: string): boolean {
  const near = (body as SuggestBody | null)?.near;
  return Array.isArray(near) && near.some((row) => row?.id === id);
}

/**
 * Reads the target by id and returns its plan 2.14 document text: `GET /items/{id}` (name + optional hint), else the
 * tag list (`display`; there is no `GET /tags/{id}`).
 */
export async function readTargetDocumentText(page: Page, id: string): Promise<string> {
  const encoded = encodeURIComponent(id);
  const item = await getJsonViaPage(page, `/api/v1/items/${encoded}`);
  if (item.status === 200) {
    const body = item.body as { name?: unknown; hint?: unknown } | null;
    if (typeof body?.name !== 'string') {
      throw new Error('GET /items/{id} returned an item without a name');
    }
    return itemDocumentText(body.name, typeof body.hint === 'string' ? body.hint : null);
  }
  if (item.status !== 404) {
    throw new Error(`GET /items/{id} returned HTTP ${item.status}`);
  }

  let cursor: string | null = null;
  for (let pageNo = 0; pageNo < 50; pageNo += 1) {
    const qs: URLSearchParams = new URLSearchParams();
    if (cursor !== null) {
      qs.set('cursor', cursor);
    }
    const suffix = qs.toString() === '' ? '' : `?${qs.toString()}`;
    const tags = await getJsonViaPage(page, `/api/v1/tags${suffix}`);
    if (tags.status !== 200) {
      throw new Error(`GET /tags returned HTTP ${tags.status}`);
    }
    const list = tags.body as { items?: ReadonlyArray<{ id?: string; display?: string }>; next_cursor?: string | null } | null;
    const found = list?.items?.find((tag) => tag.id === id);
    if (found !== undefined) {
      if (typeof found.display !== 'string') {
        throw new Error('GET /tags returned a tag without a display');
      }
      return found.display;
    }
    cursor = list?.next_cursor ?? null;
    if (cursor === null) {
      break;
    }
  }
  throw new Error('target id is neither a live item nor a live tag of the test user');
}

function assertProbeQuery(query: string): void {
  const runes = Array.from(query).length;
  const wellFormed =
    runes >= 3 &&
    runes <= QUERY_MAX_RUNES &&
    query === query.toLowerCase() &&
    query === query.trim() &&
    !/\s{2,}/.test(query) &&
    !/^\p{P}|\p{P}$/u.test(query);
  if (!wellFormed) {
    throw new Error('probeQuery must be 3-200 lowercase runes with no edge punctuation (use nextProbeQuery())');
  }
}

/**
 * Waits until every target is in the `near` zone of its own probe query, i.e. its vector exists in the active
 * generation and the real server returns it (plan Task 20b, N1/M3; signature fixed by FS-36).
 *
 * 1. Builds each document text from the target read by id (plan 2.14) and POSTs `aliases` for every probe BEFORE the
 *    first poll (without the alias the probe's query vector would be cached for 24 h as a non-matching vector).
 * 2. Polls `GET /api/v1/suggest?semantic=1&q=<probeQuery>` as the test user until each id is in `near`
 *    (alias -> cosine 1 >= `min_cos`; no lexical row, so no dedup). The query-vector cache stores vectors only, so
 *    repeated polls still see the target as soon as it is embedded.
 * 3. Times out after 60 s with the count of missing targets only (never names, ids or queries).
 */
export async function waitForEmbedded(page: Page, targets: ReadonlyArray<EmbeddedTarget>): Promise<void> {
  if (targets.length > WAIT_FOR_EMBEDDED_MAX_TARGETS) {
    throw new Error(`waitForEmbedded accepts at most ${WAIT_FOR_EMBEDDED_MAX_TARGETS} targets per call`);
  }
  if (targets.length === 0) {
    return;
  }
  if (new Set(targets.map((target) => target.probeQuery)).size !== targets.length) {
    throw new Error('waitForEmbedded needs one distinct probeQuery per target');
  }
  for (const target of targets) {
    assertProbeQuery(target.probeQuery);
  }

  const aliases: Record<string, string> = {};
  for (const target of targets) {
    aliases[target.probeQuery] = documentInput(await readTargetDocumentText(page, target.id));
  }
  await fakeembedSetAliases(aliases);

  const deadline = Date.now() + WAIT_FOR_EMBEDDED_TIMEOUT_MS;
  const pending = new Set(targets);
  const lastReasons = new Set<string>();
  for (;;) {
    for (const target of Array.from(pending)) {
      const response = await suggestSemanticViaPage(page, target.probeQuery);
      if (response.status === 200 && suggestNearContains(response.body, target.id)) {
        pending.delete(target);
        continue;
      }
      const reason = (response.body as SuggestBody | null)?.semantic_reason;
      lastReasons.add(response.status === 200 ? String(reason ?? 'none') : `http_${response.status}`);
    }
    if (pending.size === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForEmbedded: ${pending.size} of ${targets.length} target(s) not in near after ${WAIT_FOR_EMBEDDED_TIMEOUT_MS} ms ` +
          `(last semantic_reason: ${Array.from(lastReasons).sort().join(',') || 'n/a'})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_FOR_EMBEDDED_POLL_MS));
  }
}
