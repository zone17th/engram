#!/usr/bin/env node
// P06 Task 19: automates the NFR measurements frozen in docs/benchmarks/P06-nfr/protocol.md
// (landing TTFB, App Shell LCP + WASM-lazy check, G1 quick-add) and writes one JSON result file.
// Exit 0 = every criterion passed, 1 = some criterion failed, 2 = CLI misuse.
// Secrets (login password, vault passphrase, cookies) stay in memory; nothing secret is logged or written.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = join(ROOT, 'docs/benchmarks/P06-nfr/results');

const HELP = `Usage: node scripts/measure-nfr.mjs --target <https-url> [options]

Runs the P06 NFR protocol (docs/benchmarks/P06-nfr/protocol.md) and writes JSON results.

Options:
  --target <https-url>  Base URL to measure (required, https only).
  --insecure-tls        Accept self-signed TLS (Playwright ignoreHTTPSErrors, curl -k).
                        Only for staging "tls internal" or the dry-run.
  --out <dir>           Output directory (default docs/benchmarks/P06-nfr/results).
  --server-perf-log <file>
                        Log holding exactly one framed same-SHA server perf run (protocol §3):
                        NFR_PERF_BEGIN sha=<HEAD> ... go test -tags perf -v ... NFR_PERF_END
                        sha=<HEAD> exit=0; both A10 tests PASS, every population p95 < 150 ms.
  --semantic-metrics <file>
                        Prometheus text scraped on bro (api and worker /metrics, protocol §4);
                        repeatable. Needs openai_compat query latency + embedding_jobs_total.
  --dry-run             Harness check only: few TTFB samples, LCP on "/", no login/G1;
                        browser criteria "skipped", missing inputs "pending". Not NFR evidence.
  --help                Show this help.

Env (optional, G1/LCP account): NFR_EMAIL, NFR_PASSWORD, NFR_PASSPHRASE. Without them a
fresh synthetic account is created through the UI signup + onboarding.

Exit: real run 0 only when every criterion is "pass" (missing/pending/stale/failed evidence
= not met = 1); --dry-run 0 when no criterion "fail"; 2 usage error.`;

// ---- protocol constants (protocol.md; change only with a new protocol commit) ----------------------
const TTFB_PATHS = ['/', '/vi'];
const TTFB_WARMUP = 5;
const TTFB_SAMPLES = 100;
const TTFB_P95_MS = 200;
const LCP_SAMPLES = 15;
const LCP_MS = 2000;
const G1_SAMPLES = 15;
const G1_MEDIAN_MS = 3000;
export const FAST_4G = {
  offline: false,
  latency: 40,
  // 9 Mbps / 3 Mbps in decimal units (plan Task 19): 1,125,000 / 375,000 bytes per second.
  downloadThroughput: 9_000_000 / 8,
  uploadThroughput: 3_000_000 / 8,
};
const SERVER_P95_MS = 150;
const SERVER_POPULATIONS = ['pop1_sequential', 'pop2_burst_no_purge', 'pop3_burst_purge_overlap'];
const CURL_CONNECT_TIMEOUT_S = 10;
const CURL_MAX_TIME_S = 30;
const UI_WAIT_MS = 30_000;
const CRYPTO_WAIT_MS = 90_000;

// ---- CLI --------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { target: null, insecureTls: false, out: DEFAULT_OUT, dryRun: false, help: false, serverPerfLog: null, semanticMetrics: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--target') opts.target = value();
    else if (a === '--out') opts.out = resolve(value());
    else if (a === '--insecure-tls') opts.insecureTls = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--server-perf-log') opts.serverPerfLog = resolve(value());
    else if (a === '--semantic-metrics') opts.semanticMetrics.push(resolve(value()));
    else throw new UsageError(`unknown argument: ${a}`);
  }
  if (opts.help) return opts;
  if (!opts.target) throw new UsageError('--target is required');
  let url;
  try {
    url = new URL(opts.target);
  } catch {
    throw new UsageError(`--target is not a URL: ${opts.target}`);
  }
  if (url.protocol !== 'https:') throw new UsageError('--target must be an https:// URL');
  opts.target = url.origin;
  return opts;
}

class UsageError extends Error {}

// ---- stats ------------------------------------------------------------------------------------------
function nearestRank(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function median(sorted) {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Raw (unrounded) statistics: pass/fail decisions use these; rounding is for console display only.
export function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: median(s),
    p75: nearestRank(s, 75),
    p95: nearestRank(s, 95),
    p99: nearestRank(s, 99),
    max: s.length ? s[s.length - 1] : null,
  };
}

function display(v) {
  return typeof v === 'number' ? Math.round(v * 10) / 10 : v;
}

// ---- environment ------------------------------------------------------------------------------------
async function cmdLine(cmd, args) {
  try {
    const { stdout } = await execFileP(cmd, args, { cwd: ROOT });
    return stdout.split('\n')[0].trim();
  } catch {
    return null;
  }
}

async function environment(playwrightVersion, browserVersion) {
  const cpus = os.cpus();
  return {
    // safe.directory: inside $PLAYWRIGHT_IMAGE the bind-mounted checkout has another owner.
    sha: await cmdLine('git', ['-c', `safe.directory=${ROOT}`, 'rev-parse', 'HEAD']),
    cpu_model: cpus[0]?.model ?? null,
    cpu_count: cpus.length,
    mem_total_mb: Math.round(os.totalmem() / 1048576),
    arch: os.arch(),
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
    playwright: playwrightVersion,
    chromium: browserVersion,
    curl: await cmdLine('curl', ['--version']),
  };
}

function loadPlaywright() {
  const req = createRequire(join(ROOT, 'apps/web/package.json'));
  const pw = req('@playwright/test');
  let version = null;
  try {
    version = req('@playwright/test/package.json').version;
  } catch {
    // version is informational only
  }
  return { chromium: pw.chromium, version };
}

// ---- (1) TTFB ---------------------------------------------------------------------------------------
// Every curl call is bounded (connect + total deadline, plus a process timeout) so a stalled peer
// becomes a failed observation instead of hanging the run.
function curlArgs(insecure) {
  const args = ['-s', '--connect-timeout', String(CURL_CONNECT_TIMEOUT_S), '--max-time', String(CURL_MAX_TIME_S), '-H', 'Cache-Control: no-cache'];
  if (insecure) args.push('-k');
  return args;
}

const CURL_EXEC = { timeout: (CURL_MAX_TIME_S + 5) * 1000, killSignal: 'SIGKILL' };

async function curlOnce(url, insecure) {
  const args = [...curlArgs(insecure), '-o', '/dev/null', '-w', '%{http_code} %{time_starttransfer}', url];
  try {
    const { stdout } = await execFileP('curl', args, CURL_EXEC);
    const [code, t] = stdout.trim().split(' ');
    return { status: Number(code), ms: Number(t) * 1000 };
  } catch (err) {
    return { status: 0, ms: null, error: String(err.code ?? err.signal ?? 'curl_failed') };
  }
}

async function curlHeaders(url, insecure) {
  const args = [...curlArgs(insecure), '-D', '-', '-o', '/dev/null', url];
  const headers = {};
  try {
    const { stdout } = await execFileP('curl', args, CURL_EXEC);
    for (const line of stdout.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
  } catch {
    // empty headers -> header criteria fail
  }
  return headers;
}

function isSsg(h) {
  return (
    /^(HIT|STALE)$/i.test(h['x-nextjs-cache'] ?? '') ||
    h['x-nextjs-prerender'] === '1' ||
    /s-maxage/i.test(h['cache-control'] ?? '')
  );
}

async function measureTtfb(opts, criteria) {
  const warmup = opts.dryRun ? 1 : TTFB_WARMUP;
  const samples = opts.dryRun ? 3 : TTFB_SAMPLES;
  const out = {};
  for (const path of TTFB_PATHS) {
    const url = opts.target + path;
    for (let i = 0; i < warmup; i += 1) await curlOnce(url, opts.insecureTls);
    const raw = [];
    for (let i = 0; i < samples; i += 1) raw.push(await curlOnce(url, opts.insecureTls));
    const ok = raw.filter((r) => r.status === 200 && r.ms !== null);
    const errors = raw.length - ok.length;
    const st = stats(ok.map((r) => r.ms));
    const headers = await curlHeaders(url, opts.insecureTls);
    const picked = {
      'x-nextjs-cache': headers['x-nextjs-cache'] ?? null,
      'x-nextjs-prerender': headers['x-nextjs-prerender'] ?? null,
      'cache-control': headers['cache-control'] ?? null,
      'content-security-policy': headers['content-security-policy'] ? 'present' : null,
      'strict-transport-security': headers['strict-transport-security'] ?? null,
    };
    out[path] = { warmup, samples_ms: raw.map((r) => r.ms), statuses: raw.map((r) => r.status), errors, stats: st, headers: picked };
    // Harness criterion: curl reached the target over TLS at least once.
    criteria.push(crit(`ttfb${path}.reachable`, ok.length > 0, ok.length, `>0 HTTP 200 of ${samples}`));
    criteria.push(crit(`ttfb${path}.p95`, st.p95 !== null && st.p95 < TTFB_P95_MS, st.p95, `< ${TTFB_P95_MS} ms`, opts.dryRun));
    criteria.push(crit(`ttfb${path}.errors`, errors === 0, errors, '0', opts.dryRun));
    criteria.push(crit(`ttfb${path}.ssg_header`, isSsg(headers), picked['x-nextjs-cache'] ?? picked['x-nextjs-prerender'] ?? picked['cache-control'], 'x-nextjs-cache HIT|STALE, x-nextjs-prerender 1 or s-maxage', opts.dryRun));
    criteria.push(crit(`ttfb${path}.csp`, Boolean(headers['content-security-policy']), picked['content-security-policy'], 'present', opts.dryRun));
    criteria.push(crit(`ttfb${path}.hsts`, Boolean(headers['strict-transport-security']), picked['strict-transport-security'], 'present', opts.dryRun));
  }
  return out;
}

function crit(id, pass, value, threshold, skipped = false) {
  return { id, status: skipped ? 'skipped' : pass ? 'pass' : 'fail', value: value ?? null, threshold };
}

function pending(id, value, threshold) {
  return { id, status: 'pending', value: value ?? null, threshold };
}

// ---- (3b) server p95 from the same-SHA perf log -----------------------------------------------------
// Go prints durations like "812.4µs", "12.3ms", "1.2s".
export function goDurationMs(text) {
  const m = /^([0-9.]+)(ns|µs|us|ms|s|m)$/.exec(text);
  if (!m) return null;
  const scale = { ns: 1e-6, µs: 1e-3, us: 1e-3, ms: 1, s: 1000, m: 60000 }[m[2]];
  return Number(m[1]) * scale;
}

// The perf log must hold exactly one framed run (protocol §3):
//   NFR_PERF_BEGIN sha=<40 hex>
//   ... go test -tags perf ./internal/perf/... -v output ...
//   NFR_PERF_END sha=<40 hex> exit=<go test exit code>
// Only text inside the frame is read. Both markers must name the tested SHA, the run must exit 0 and
// end with the package "ok" line, no test may FAIL/SKIP/panic, both A10 tests must PASS exactly once and
// each required population (base and SEMANTIC-ON) must appear exactly once with p95 < 150 ms.
export function evaluateServerPerf(logText, headSha) {
  if (logText === null) return { state: 'missing', pass: false, reason: '--server-perf-log not given or unreadable' };
  const out = { state: 'parsed', log_sha: null, populations: {}, semantic_on_populations: {} };
  const reasons = [];
  const fail = () => {
    out.pass = false;
    out.reason = reasons.join('; ');
    out.max_p95_ms = null;
    return out;
  };
  const begins = [...logText.matchAll(/^NFR_PERF_BEGIN sha=(\S+)\s*$/gm)];
  const ends = [...logText.matchAll(/^NFR_PERF_END sha=(\S+) exit=(\S+)\s*$/gm)];
  if (begins.length !== 1 || ends.length !== 1) {
    reasons.push(`expected exactly one NFR_PERF_BEGIN/END frame, got ${begins.length}/${ends.length}`);
    return fail();
  }
  const [begin] = begins;
  const [end] = ends;
  out.log_sha = begin[1];
  if (end.index < begin.index) reasons.push('NFR_PERF_END before NFR_PERF_BEGIN');
  if (begin[1] !== headSha || end[1] !== headSha) reasons.push(`frame sha ${begin[1]}/${end[1]} != head ${headSha}`);
  if (end[2] !== '0') reasons.push(`perf command exit=${end[2]}`);
  if (reasons.length) return fail();

  const seg = logText.slice(begin.index + begin[0].length, end.index);
  // Provenance inside the frame: no legacy/nested markers, and every SHA-like field must name the tested SHA.
  if (/NFR_PERF_(SHA|BEGIN|END)/.test(seg)) reasons.push('legacy or nested NFR_PERF marker inside the frame');
  for (const m of seg.matchAll(/\b[A-Za-z_]*(?:sha|commit)\s*[=:]\s*([0-9a-f]{7,40})\b/gi)) {
    if (!headSha.startsWith(m[1].toLowerCase())) reasons.push(`foreign sha ${m[1]} inside the frame`);
  }
  if (/^\s*(--- FAIL|--- SKIP|FAIL\b|panic:)/m.test(seg)) reasons.push('FAIL/SKIP/panic inside the run');
  if (!/^ok\s+\S+\/internal\/perf\b/m.test(seg)) reasons.push('no "ok .../internal/perf" package line (truncated run)');
  for (const test of ['TestEntryCreatePerformanceA10', 'TestEntryCreatePerformanceA10SemanticOn']) {
    const n = [...seg.matchAll(new RegExp(`^\\s*--- PASS: ${test} \\(`, 'gm'))].length;
    if (n !== 1) reasons.push(`${test} PASS lines = ${n} (want 1)`);
  }
  const onceP95 = (prefix, name, into) => {
    const all = [...seg.matchAll(new RegExp(`${prefix}POPULATION ${name}: .*? p95=(\\S+)`, 'g'))];
    if (all.length !== 1) {
      reasons.push(`${prefix}POPULATION ${name} p95 lines = ${all.length} (want 1)`);
      into[name] = null;
      return;
    }
    into[name] = goDurationMs(all[0][1]);
    if (into[name] === null) reasons.push(`unparsable p95 for ${prefix}${name}`);
  };
  for (const name of SERVER_POPULATIONS) {
    onceP95('(?<!SEMANTIC-ON )', name, out.populations);
    onceP95('SEMANTIC-ON ', name, out.semantic_on_populations);
  }
  const all = [...Object.values(out.populations), ...Object.values(out.semantic_on_populations)];
  if (all.some((v) => v !== null && !(v < SERVER_P95_MS))) reasons.push(`population p95 >= ${SERVER_P95_MS} ms`);
  if (reasons.length) return fail();
  out.max_p95_ms = Math.max(...all);
  out.pass = true;
  return out;
}

// ---- (4) semantic observation from scraped Prometheus text ------------------------------------------
function parseLabels(s) {
  const labels = {};
  for (const m of (s ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[m[1]] = m[2];
  return labels;
}

export function parsePrometheus(text) {
  const samples = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    const value = m ? Number(m[3]) : NaN;
    if (m && Number.isFinite(value)) samples.push({ name: m[1], labels: parseLabels(m[2]), value });
  }
  return samples;
}

// histogram_quantile over cumulative buckets (linear interpolation inside the bucket, Prometheus rules).
export function histogramQuantile(q, buckets) {
  const sorted = [...buckets].sort((a, b) => a.le - b.le);
  const total = sorted.length ? sorted[sorted.length - 1].count : 0;
  if (!total) return null;
  const rank = q * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const b of sorted) {
    if (b.count >= rank) {
      if (b.le === Infinity) return prevLe;
      return prevLe + ((b.le - prevLe) * (rank - prevCount)) / (b.count - prevCount || 1);
    }
    prevLe = b.le;
    prevCount = b.count;
  }
  return prevLe;
}

// Only aggregate numbers leave this function: metric names/labels of the allowlisted families, never query text.
export function evaluateSemantic(texts) {
  if (texts.length === 0) return { state: 'pending', reason: 'no --semantic-metrics given (post-deploy bro scrape, protocol §4)' };
  const samples = texts.flatMap((t) => parsePrometheus(t));
  if (samples.length === 0) return { state: 'invalid', reason: 'no Prometheus samples parsed' };
  // Only provider="openai_compat", op="query" (a real cache miss calls the provider; TEI is not the production path).
  const isMiss = (s) => s.labels.provider === 'openai_compat' && s.labels.op === 'query';
  const byLe = new Map();
  let queryCount = 0;
  for (const s of samples) {
    if (s.name === 'embedding_provider_latency_seconds_bucket' && isMiss(s)) {
      const le = s.labels.le === '+Inf' ? Infinity : Number(s.labels.le);
      if (!Number.isNaN(le)) byLe.set(le, (byLe.get(le) ?? 0) + s.value);
    }
    if (s.name === 'embedding_provider_latency_seconds_count' && isMiss(s)) queryCount += s.value;
  }
  const buckets = [...byLe].map(([le, count]) => ({ le, count }));
  const sortedCounts = [...buckets].sort((a, b) => a.le - b.le).map((b) => b.count);
  const histogramValid =
    Number.isFinite(queryCount) &&
    queryCount > 0 &&
    byLe.has(Infinity) &&
    byLe.get(Infinity) === queryCount &&
    buckets.some((b) => b.le !== Infinity) &&
    buckets.every((b) => Number.isFinite(b.count) && b.count >= 0 && (b.le === Infinity || (Number.isFinite(b.le) && b.le >= 0))) &&
    sortedCounts.every((c, i) => i === 0 || c >= sortedCounts[i - 1]);
  const sum = (name, key) => {
    const out = {};
    for (const s of samples.filter((x) => x.name === name)) {
      const k = key(s.labels);
      out[k] = (out[k] ?? 0) + s.value;
    }
    return out;
  };
  const jobs = sum('embedding_jobs_total', (l) => `${l.kind ?? '?'}/${l.outcome ?? '?'}`);
  const cache = sum('semantic_query_cache_total', (l) => l.result ?? '?');
  const toMs = (v) => (v === null ? null : v * 1000);
  const p50 = histogramValid ? toMs(histogramQuantile(0.5, buckets)) : null;
  const p95 = histogramValid ? toMs(histogramQuantile(0.95, buckets)) : null;
  const result = {
    provider_query_latency_ms: { provider: 'openai_compat', cache_miss_calls: queryCount, p50, p95 },
    query_cache: cache,
    embedding_jobs_total: jobs,
  };
  if (queryCount === 0) return { state: 'no_cache_miss_observed', ...result, reason: 'no openai_compat query call (real cache miss) in the scrape' };
  if (!histogramValid || !Number.isFinite(p50) || !Number.isFinite(p95)) {
    return { state: 'invalid_latency', ...result, reason: 'openai_compat query histogram missing or inconsistent with its count' };
  }
  if (Object.keys(jobs).length === 0) return { state: 'partial', ...result, reason: 'embedding_jobs_total absent (worker /metrics not scraped)' };
  return { state: 'collected', ...result };
}

// ---- browser helpers --------------------------------------------------------------------------------
async function newContext(browser, opts, storageState) {
  return browser.newContext({
    ignoreHTTPSErrors: opts.insecureTls,
    viewport: { width: 1440, height: 900 },
    baseURL: opts.target,
    ...(storageState ? { storageState } : {}),
  });
}

async function throttle(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', FAST_4G);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  return cdp;
}

async function installLcpObserver(page) {
  await page.addInitScript(() => {
    window.__nfrLcp = null;
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) window.__nfrLcp = last.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
}

async function readLcp(page, path) {
  await page.goto(path, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForTimeout(1000);
  return page.evaluate(() => window.__nfrLcp);
}

async function waitFor(fn, timeout, what) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// Writes a value without Playwright's fill() call log (secrets never reach logs).
async function quietFill(locator, value) {
  await locator.waitFor({ state: 'visible', timeout: CRYPTO_WAIT_MS });
  await locator.evaluate((el, next) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function waitHydrated(page) {
  await page.getByRole('textbox', { name: 'Email', exact: true }).waitFor({ state: 'visible', timeout: 45_000 });
  const gated = page.locator('form[data-hydrated]');
  if ((await gated.count()) > 0) {
    await waitFor(async () => (await gated.first().getAttribute('data-hydrated')) === 'true', 45_000, 'form hydration');
  }
}

async function vaultOpen(page) {
  await waitFor(
    async () => /vault-open/.test((await page.locator('.vault-pill').first().getAttribute('class')) ?? ''),
    CRYPTO_WAIT_MS,
    'vault open',
  );
}

async function signupAndOnboard(page, creds) {
  await page.goto('/app/auth/signup');
  await waitHydrated(page);
  await page.getByLabel('Email').fill(creds.email);
  await quietFill(page.getByLabel(/^(Login password|Mật khẩu đăng nhập)$/), creds.password);
  const confirm = page.getByLabel(/^(Confirm password|Nhập lại mật khẩu|Confirm login password|Nhập lại mật khẩu đăng nhập)$/);
  if ((await confirm.count()) > 0) await quietFill(confirm, creds.password);
  await page.getByRole('checkbox', { name: /agree|terms|điều khoản/i }).check();
  await page.getByRole('button', { name: /Create account|Tạo tài khoản/ }).click();
  await page.waitForURL(/\/app\/(onboarding|auth\/verify-email)/, { timeout: UI_WAIT_MS });
  if (/verify-email/.test(page.url())) {
    throw new Error('target requires email verification: set NFR_EMAIL/NFR_PASSWORD/NFR_PASSPHRASE');
  }
  await page.getByTestId('onboarding-step-passphrase').waitFor({ timeout: CRYPTO_WAIT_MS });
  await quietFill(page.getByLabel('Passphrase', { exact: true }), creds.passphrase);
  await quietFill(page.getByLabel('Confirm passphrase'), creds.passphrase);
  await page.getByTestId('onboarding-continue-button').click();
  await page.getByTestId('onboarding-step-recovery-keys').waitFor({ timeout: CRYPTO_WAIT_MS });
  await page.getByTestId('recovery-keys-confirm-checkbox').check();
  await page.getByTestId('onboarding-create-vault-button').click();
  await page.getByTestId('onboarding-skip-passkey-button').click({ timeout: CRYPTO_WAIT_MS });
  await page.waitForURL(/\/app$/, { timeout: UI_WAIT_MS });
  await vaultOpen(page);
}

async function loginAndUnlock(page, creds) {
  await page.goto('/app/auth/login');
  await waitHydrated(page);
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(creds.email);
  await quietFill(page.getByLabel(/^(Login password|Mật khẩu đăng nhập)$/), creds.password);
  const resp = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/auth/login',
    { timeout: UI_WAIT_MS },
  );
  await page.getByRole('button', { name: /Sign in|Đăng nhập/ }).click();
  if (!(await resp).ok()) throw new Error(`login failed (${(await resp).status()})`);
  await page.waitForURL(/\/app$/, { timeout: UI_WAIT_MS });
  await unlock(page, creds);
}

async function unlock(page, creds) {
  await page.getByTestId('vault-locked-unlock-cta').click({ timeout: UI_WAIT_MS });
  await quietFill(page.getByTestId('unlock-passphrase-input'), creds.passphrase);
  await page.getByTestId('unlock-submit-button').click();
  await page.waitForURL(/\/app$/, { timeout: CRYPTO_WAIT_MS });
  await vaultOpen(page);
}

function accountCreds() {
  if (process.env.NFR_EMAIL && process.env.NFR_PASSWORD && process.env.NFR_PASSPHRASE) {
    return { provided: true, email: process.env.NFR_EMAIL, password: process.env.NFR_PASSWORD, passphrase: process.env.NFR_PASSPHRASE };
  }
  const tag = `${Date.now()}.${randomBytes(4).toString('hex')}`;
  return {
    provided: false,
    email: `nfr.${tag}@example.test`,
    password: `nfr-login-${randomBytes(9).toString('base64url')}`,
    passphrase: `nfr-vault-${randomBytes(12).toString('base64url')}`,
  };
}

// ---- (2) LCP + WASM lazy ------------------------------------------------------------------------------
async function measureWasmOnLanding(browser, opts, criteria) {
  const ctx = await newContext(browser, opts);
  const page = await ctx.newPage();
  // Counted at the request event so a blocked/failed .wasm fetch still fails the gate; the response
  // MIME check catches extensionless WASM. A Set avoids double-counting one request.
  const wasm = new Set();
  page.on('request', (r) => {
    if (/\.wasm$/i.test(new URL(r.url()).pathname)) wasm.add(r);
  });
  page.on('response', (r) => {
    if ((r.headers()['content-type'] ?? '').includes('application/wasm')) wasm.add(r.request());
  });
  await installLcpObserver(page);
  await throttle(page);
  await page.goto('/', { waitUntil: 'networkidle', timeout: 90_000 });
  await page.waitForTimeout(1000);
  const lcp = await page.evaluate(() => window.__nfrLcp);
  await ctx.close();
  const wasmPaths = [...wasm].map((r) => new URL(r.url()).pathname);
  criteria.push(crit('landing.no_wasm', wasmPaths.length === 0, wasmPaths.length, '0 .wasm requests on /'));
  // Harness criterion: the LCP observer produced a value on a real page.
  criteria.push(crit('landing.lcp_observed', typeof lcp === 'number', lcp, 'LCP entry observed on /'));
  return { wasm_requests: wasmPaths, lcp_ms: lcp };
}

// Each sample must land on /app with the App Shell omnibox; a redirect to login would otherwise be measured silently.
// The session cookies are chained context to context: refresh rotation has no grace window, so reusing an
// already-rotated refresh cookie would revoke the session (reuse detection) halfway through the samples.
async function appSample(page) {
  const lcp = await readLcp(page, '/app');
  const onApp = new URL(page.url()).pathname === '/app' && (await page.locator('#omni').count()) > 0;
  return onApp ? lcp : null;
}

async function measureAppLcp(browser, opts, storageState, criteria) {
  let state = storageState;
  const cold = [];
  for (let i = 0; i < LCP_SAMPLES; i += 1) {
    const ctx = await newContext(browser, opts, state);
    const page = await ctx.newPage();
    await installLcpObserver(page);
    await throttle(page);
    cold.push(await appSample(page));
    state = await ctx.storageState(); // in memory only
    await ctx.close();
  }
  const warm = [];
  const ctx = await newContext(browser, opts, state);
  const page = await ctx.newPage();
  await installLcpObserver(page);
  await throttle(page);
  await readLcp(page, '/app'); // primes the HTTP cache, not a sample
  for (let i = 0; i < LCP_SAMPLES; i += 1) warm.push(await appSample(page));
  await ctx.close();

  const result = {};
  for (const [name, raw] of [['cold', cold], ['warm', warm]]) {
    const valid = raw.filter((v) => typeof v === 'number');
    const st = stats(valid);
    result[name] = { samples_ms: raw, stats: st };
    criteria.push(crit(`app_lcp.${name}.samples`, valid.length === LCP_SAMPLES, valid.length, `${LCP_SAMPLES} LCP values`));
    criteria.push(crit(`app_lcp.${name}.p75`, st.p75 !== null && st.p75 < LCP_MS, st.p75, `< ${LCP_MS} ms`));
    criteria.push(crit(`app_lcp.${name}.median`, st.p50 !== null && st.p50 < LCP_MS, st.p50, `< ${LCP_MS} ms`));
  }
  return result;
}

// ---- (3) G1 quick-add ---------------------------------------------------------------------------------
async function measureG1(page, criteria) {
  const omnibox = page.locator('#omni textarea[data-vault-secret]');
  await omnibox.waitFor({ state: 'visible', timeout: UI_WAIT_MS });
  const run = randomBytes(3).toString('hex');
  const samples = [];
  const serverMs = [];
  let failures = 0;
  for (let i = 1; i <= G1_SAMPLES; i += 1) {
    const name = `g1-${run}-${i}`;
    const posts = [];
    const onResponse = (r) => {
      const p = new URL(r.url()).pathname;
      if (r.request().method() === 'POST' && (p === '/api/v1/items' || /^\/api\/v1\/items\/[^/]+\/entries$/.test(p))) {
        posts.push(r);
      }
    };
    page.on('response', onResponse);
    try {
      await quietFill(omnibox, `${name} #g1: payload-${i}`);
      const start = Date.now();
      await omnibox.press('Enter');
      await page.getByTestId('undo-toast-item').filter({ hasText: name }).first().waitFor({ state: 'visible', timeout: UI_WAIT_MS });
      const elapsed = Date.now() - start;
      await waitFor(async () => (await omnibox.inputValue()) === '', UI_WAIT_MS, 'omnibox cleared');
      const statuses = posts.map((r) => r.status());
      if (statuses.length < 2 || statuses.some((s) => s !== 201)) throw new Error(`unexpected POST statuses ${statuses.join(',')}`);
      for (const r of posts) {
        const t = r.request().timing();
        if (t.responseEnd > 0 && t.requestStart >= 0) serverMs.push(t.responseEnd - t.requestStart);
      }
      samples.push(elapsed);
    } catch (err) {
      failures += 1;
      samples.push(null);
      console.error(`G1 sample ${i} failed: ${err.message.split('\n')[0]}`);
    } finally {
      page.off('response', onResponse);
    }
  }
  const st = stats(samples.filter((v) => v !== null));
  criteria.push(crit('g1.median', st.p50 !== null && st.p50 <= G1_MEDIAN_MS, st.p50, `<= ${G1_MEDIAN_MS} ms`));
  criteria.push(crit('g1.failures', failures === 0, failures, '0'));
  return { samples_ms: samples, stats: st, failures, browser_post_ms_informational: stats(serverMs) };
}

// ---- main -------------------------------------------------------------------------------------------
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`error: ${err.message}\n\n${HELP}`);
      return 2;
    }
    throw err;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const startedAt = new Date();
  const criteria = [];
  const result = { protocol: 'docs/benchmarks/P06-nfr/protocol.md', target: opts.target, insecure_tls: opts.insecureTls, dry_run: opts.dryRun, started_at: startedAt.toISOString() };
  const { chromium, version } = loadPlaywright();
  const browser = await chromium.launch();
  try {
    result.environment = await environment(version, browser.version());
    console.log(`measure-nfr: target=${opts.target} sha=${result.environment.sha} dry_run=${opts.dryRun}`);

    result.ttfb = await measureTtfb(opts, criteria);
    result.landing = await measureWasmOnLanding(browser, opts, criteria);

    if (!opts.dryRun) {
      const creds = accountCreds();
      result.account = { mode: creds.provided ? 'env' : 'fresh_signup' };
      const ctx = await newContext(browser, opts);
      const page = await ctx.newPage();
      try {
        if (creds.provided) await loginAndUnlock(page, creds);
        else await signupAndOnboard(page, creds);
        const storageState = await ctx.storageState(); // in memory only
        result.g1 = await measureG1(page, criteria);
        result.app_lcp = await measureAppLcp(browser, opts, storageState, criteria);
      } catch (err) {
        result.account.error = err.message.split('\n')[0];
        criteria.push(crit('account.ready', false, result.account.error, 'signed in with open vault'));
      } finally {
        await ctx.close();
      }
    } else {
      for (const id of ['app_lcp.cold', 'app_lcp.warm', 'g1.median']) criteria.push(crit(id, false, null, 'not run in --dry-run', true));
    }
  } finally {
    await browser.close();
  }

  // (3b) server p95: real mode needs the same-SHA perf log; dry-run evaluates it only when given.
  if (opts.serverPerfLog || !opts.dryRun) {
    let text = null;
    if (opts.serverPerfLog) {
      try {
        text = readFileSync(opts.serverPerfLog, 'utf8');
      } catch {
        text = null;
      }
    }
    result.server_perf = evaluateServerPerf(text, result.environment.sha);
    criteria.push(crit('server.p95', result.server_perf.pass, result.server_perf.max_p95_ms ?? result.server_perf.reason, `< ${SERVER_P95_MS} ms every population, same SHA, test PASS`));
  } else {
    criteria.push(crit('server.p95', false, null, 'no --server-perf-log in --dry-run', true));
  }

  // (4) semantic observation: observation only (P05 targets unchanged); real run needs "collected".
  if (opts.semanticMetrics.length || !opts.dryRun) {
    let sem;
    try {
      sem = evaluateSemantic(opts.semanticMetrics.map((f) => readFileSync(f, 'utf8')));
    } catch (err) {
      sem = { state: 'invalid', reason: `cannot read --semantic-metrics: ${err.code ?? 'error'}` };
    }
    result.semantic = sem;
    criteria.push(semanticCriterion(sem, opts.dryRun));
  } else {
    criteria.push(crit('semantic.observed', false, null, 'no --semantic-metrics in --dry-run', true));
  }

  result.finished_at = new Date().toISOString();
  result.criteria = criteria;
  const { pass, complete, notMet } = decide(criteria, opts.dryRun);
  result.pass = pass;
  result.complete = complete;
  if (notMet.length) result.not_met = notMet;
  const failed = notMet;

  mkdirSync(opts.out, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const file = join(opts.out, `nfr-${stamp}-${(result.environment.sha ?? 'nosha').slice(0, 7)}${opts.dryRun ? '-dryrun' : ''}.json`);
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);

  for (const c of criteria) console.log(`${c.status.padEnd(7)} ${c.id} value=${JSON.stringify(display(c.value))} (${c.threshold})`);
  console.log(`measure-nfr: ${result.pass ? 'PASS' : `FAIL (${failed.length})`} complete=${result.complete} -> ${file}`);
  return result.pass ? 0 : 1;
}

// advisor-dec-P06-054: in a real run every criterion must be "pass"; missing/pending/stale/foreign/failed
// evidence is "not met" and the run exits != 0. Only --dry-run may carry pending/skipped and still pass.
export function semanticCriterion(sem, dryRun) {
  const id = 'semantic.observed';
  const threshold = 'openai_compat cache-miss latency + embedding_jobs_total collected (protocol §4)';
  if (sem.state === 'collected') return crit(id, true, sem.state, threshold);
  if (dryRun && sem.state !== 'invalid') return pending(id, `${sem.state}: ${sem.reason}`, threshold);
  return crit(id, false, `${sem.state}: ${sem.reason}`, threshold);
}

export function decide(criteria, dryRun) {
  const notMet = criteria
    .filter((c) => (dryRun ? c.status === 'fail' : c.status !== 'pass'))
    .map((c) => ({ id: c.id, status: c.status, value: c.value }));
  const pass = notMet.length === 0;
  return { pass, complete: pass && !dryRun, notMet };
}

// Importable for the self-test (docs/benchmarks/P06-nfr/measure-nfr.selftest.mjs) without running.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`measure-nfr: error: ${err.stack ?? err}`);
      process.exit(1);
    },
  );
}
