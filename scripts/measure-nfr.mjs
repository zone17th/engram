#!/usr/bin/env node
// P06 Task 19: automates the NFR measurements frozen in docs/benchmarks/P06-nfr/protocol.md
// (landing TTFB, App Shell LCP + WASM-lazy check, G1 quick-add) and writes one JSON result file.
// Exit 0 = every criterion passed, 1 = some criterion failed, 2 = CLI misuse.
// Secrets (login password, vault passphrase, cookies) stay in memory; nothing secret is logged or written.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  --dry-run             Harness check only: few TTFB samples, LCP on "/", no login/G1;
                        threshold criteria are "skipped". Not NFR evidence.
  --help                Show this help.

Env (optional, G1/LCP account): NFR_EMAIL, NFR_PASSWORD, NFR_PASSPHRASE. Without them a
fresh synthetic account is created through the UI signup + onboarding.

Exit: 0 all criteria pass, 1 a criterion failed, 2 usage error.`;

// ---- protocol constants (protocol.md; change only with a new protocol commit) ----------------------
const TTFB_PATHS = ['/', '/vi'];
const TTFB_WARMUP = 5;
const TTFB_SAMPLES = 100;
const TTFB_P95_MS = 200;
const LCP_SAMPLES = 15;
const LCP_MS = 2000;
const G1_SAMPLES = 15;
const G1_MEDIAN_MS = 3000;
const FAST_4G = {
  offline: false,
  latency: 40,
  downloadThroughput: (9 * 1024 * 1024) / 8,
  uploadThroughput: (3 * 1024 * 1024) / 8,
};
const UI_WAIT_MS = 30_000;
const CRYPTO_WAIT_MS = 90_000;

// ---- CLI --------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { target: null, insecureTls: false, out: DEFAULT_OUT, dryRun: false, help: false };
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

function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  const round = (v) => (v === null ? null : Math.round(v * 10) / 10);
  return {
    n: s.length,
    p50: round(median(s)),
    p75: round(nearestRank(s, 75)),
    p95: round(nearestRank(s, 95)),
    p99: round(nearestRank(s, 99)),
    max: round(s.length ? s[s.length - 1] : null),
  };
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
    sha: await cmdLine('git', ['rev-parse', 'HEAD']),
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
async function curlOnce(url, insecure) {
  const args = ['-s', '-o', '/dev/null', '-H', 'Cache-Control: no-cache', '-w', '%{http_code} %{time_starttransfer}'];
  if (insecure) args.push('-k');
  args.push(url);
  try {
    const { stdout } = await execFileP('curl', args);
    const [code, t] = stdout.trim().split(' ');
    return { status: Number(code), ms: Number(t) * 1000 };
  } catch (err) {
    return { status: 0, ms: null, error: String(err.code ?? 'curl_failed') };
  }
}

async function curlHeaders(url, insecure) {
  const args = ['-s', '-D', '-', '-o', '/dev/null', '-H', 'Cache-Control: no-cache'];
  if (insecure) args.push('-k');
  args.push(url);
  const headers = {};
  try {
    const { stdout } = await execFileP('curl', args);
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
  const wasm = [];
  page.on('response', (r) => {
    const ct = r.headers()['content-type'] ?? '';
    if (/\.wasm(\?|$)/.test(new URL(r.url()).pathname) || ct.includes('application/wasm')) wasm.push(new URL(r.url()).pathname);
  });
  await installLcpObserver(page);
  await throttle(page);
  await page.goto('/', { waitUntil: 'networkidle', timeout: 90_000 });
  await page.waitForTimeout(1000);
  const lcp = await page.evaluate(() => window.__nfrLcp);
  await ctx.close();
  criteria.push(crit('landing.no_wasm', wasm.length === 0, wasm.length, '0 .wasm requests on /'));
  // Harness criterion: the LCP observer produced a value on a real page.
  criteria.push(crit('landing.lcp_observed', typeof lcp === 'number', lcp, 'LCP entry observed on /'));
  return { wasm_requests: wasm, lcp_ms: lcp };
}

async function measureAppLcp(browser, opts, storageState, criteria) {
  const cold = [];
  for (let i = 0; i < LCP_SAMPLES; i += 1) {
    const ctx = await newContext(browser, opts, storageState);
    const page = await ctx.newPage();
    await installLcpObserver(page);
    await throttle(page);
    cold.push(await readLcp(page, '/app'));
    await ctx.close();
  }
  const warm = [];
  const ctx = await newContext(browser, opts, storageState);
  const page = await ctx.newPage();
  await installLcpObserver(page);
  await throttle(page);
  await readLcp(page, '/app'); // primes the HTTP cache, not a sample
  for (let i = 0; i < LCP_SAMPLES; i += 1) warm.push(await readLcp(page, '/app'));
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

  result.finished_at = new Date().toISOString();
  result.criteria = criteria;
  const failed = criteria.filter((c) => c.status === 'fail');
  result.pass = failed.length === 0;

  mkdirSync(opts.out, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const file = join(opts.out, `nfr-${stamp}-${(result.environment.sha ?? 'nosha').slice(0, 7)}${opts.dryRun ? '-dryrun' : ''}.json`);
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);

  for (const c of criteria) console.log(`${c.status.padEnd(7)} ${c.id} value=${JSON.stringify(c.value)} (${c.threshold})`);
  console.log(`measure-nfr: ${result.pass ? 'PASS' : `FAIL (${failed.length})`} -> ${file}`);
  return result.pass ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`measure-nfr: error: ${err.stack ?? err}`);
    process.exit(1);
  },
);
