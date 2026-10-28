import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PASSWORD = 'login-password-12';
export const MAIL_SINK_DIR = process.env.MAIL_SINK_DIR ?? join(process.cwd(), '..', '..', '.data', 'mail-sink');
const E2E_API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:8080';

const isolatedContexts = new WeakSet<BrowserContext>();
const contextClientIp = new WeakMap<BrowserContext, string>();

// Playwright respawns the worker process after every failure, which resets module
// state. A plain counter therefore hands the next test the same hops the previous
// worker already spent, and the reused 5/min bucket surfaces as a bogus 429 one
// test later. Seed from TEST_WORKER_INDEX (it increments on every respawn) so each
// worker owns a disjoint block.
const CLIENT_IP_BLOCK = 4096;
let clientIpSeq = (Number(process.env.TEST_WORKER_INDEX ?? 0) % 32) * CLIENT_IP_BLOCK;

/**
 * Untrusted hop so each helper keeps its own 5/min cred bucket (plan Task 24: do
 * not raise the product quota for tests). 198.18.0.0/15 is the RFC 2544
 * benchmarking range — outside the dev AUTH_TRUSTED_PROXY_CIDRS default
 * (loopback + RFC 1918), so httpx.ClientIP keys the limiter on it.
 */
export function uniqueClientIp(): string {
  clientIpSeq = (clientIpSeq + 1) % (CLIENT_IP_BLOCK * 32);
  const host = clientIpSeq & 0xff;
  const third = (clientIpSeq >>> 8) & 0xff;
  const second = 18 + ((clientIpSeq >>> 16) & 0x1);
  return `198.${second}.${third}.${host}`;
}

function isCredLimitedPath(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    // Must cover every handler guarded by credLimit (5/min/IP) in
    // apps/api/internal/auth/authhttp/handlers.go. A path missing here keeps the
    // shared loopback bucket and starves later tests.
    return (
      path === '/api/v1/auth/signup' ||
      path === '/api/v1/auth/login' ||
      path === '/api/v1/auth/refresh' ||
      path === '/api/v1/auth/reauth' ||
      path === '/api/v1/auth/verify-email/confirm' ||
      /\/api\/v1\/auth\/oauth\/[^/]+\/link$/.test(path) ||
      /\/api\/v1\/auth\/oauth\/[^/]+\/start$/.test(path) ||
      /\/api\/v1\/auth\/oauth\/[^/]+\/reauth$/.test(path)
    );
  } catch {
    return false;
  }
}

async function fulfillCredViaApi(route: Route, ip: string) {
  const req = route.request();
  const requestUrl = new URL(req.url());
  const apiUrl = new URL(E2E_API_URL);
  const apiOrigin = apiUrl.origin;
  const dest = req.url().replace(requestUrl.origin, apiOrigin);
  // Drop hop-by-hop headers: a stale content-length / host aimed at :3000 can
  // stall route.fetch to the API and leave loginViaUi stuck on "submitting"
  // with neither a navigation nor an auth-error-card (multi-context flake).
  const headers: Record<string, string> = { ...req.headers(), 'x-forwarded-for': ip };
  delete headers['content-length'];
  delete headers['host'];
  headers['host'] = apiUrl.host;
  if (dest === req.url() || requestUrl.origin === apiOrigin) {
    await route.continue({ headers });
    return;
  }
  const response = await route.fetch({ url: dest, headers, maxRedirects: 0 });
  await route.fulfill({ response });
}

export async function isolateRateLimit(target: Page | BrowserContext) {
  const ctx = 'newPage' in target ? target : target.context();
  const ip = uniqueClientIp();
  contextClientIp.set(ctx, ip);
  await ctx.setExtraHTTPHeaders({ 'X-Forwarded-For': ip });
  if (isolatedContexts.has(ctx)) return;
  isolatedContexts.add(ctx);
  await ctx.route(
    (url) => isCredLimitedPath(url.toString()),
    (route) => fulfillCredViaApi(route, contextClientIp.get(ctx) ?? ip),
  );
}

export function verifyRequired(): boolean {
  return process.env.E2E_VERIFY === 'true' || process.env.AUTH_REQUIRE_EMAIL_VERIFICATION === 'true';
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}.${process.env.TEST_WORKER_INDEX ?? '0'}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.test`;
}

type SinkEntry = { recipient: string; purpose: string; link: string };

export function readMailSink(recipient: string, purpose: string): SinkEntry[] {
  let names: string[];
  try {
    names = readdirSync(MAIL_SINK_DIR);
  } catch {
    return [];
  }
  const out: SinkEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(MAIL_SINK_DIR, name), 'utf8')) as SinkEntry;
      if (parsed.recipient === recipient && parsed.purpose === purpose) out.push(parsed);
    } catch {
      // skip unreadable or partial writes
    }
  }
  return out;
}

export async function waitForMail(recipient: string, purpose: string, timeoutMs = 15_000): Promise<SinkEntry> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const entries = readMailSink(recipient, purpose);
    if (entries.length > 0) return entries[entries.length - 1]!;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`mail sink empty for ${recipient} / ${purpose} under ${MAIL_SINK_DIR}`);
}

export function tokenFromLink(link: string): string {
  const hash = link.split('#')[1] ?? '';
  const params = new URLSearchParams(hash);
  const token = params.get('token');
  if (!token) throw new Error('mail link did not contain a token');
  return token;
}

/** Only explicit rate-limit copy. Do not match lockout/vault "locked" or the substring "rate". */
async function assertNotRateLimited(page: Page) {
  const alert = page.getByTestId('auth-error-card');
  if (!(await alert.isVisible().catch(() => false))) return;
  const text = await alert.innerText();
  if (/too many attempts|thử quá nhiều|rate_limited/i.test(text)) {
    throw new Error(`rate-limited during auth helper (run auth e2e serially): ${text}`);
  }
}

/** RouteGuard + session bootstrap can show a loading shell before auth forms or session-status exist. */
export async function waitForAuthPageReady(page: Page) {
  // Login/signup show Email and OAuth together — never union those locators (strict mode).
  const email = page.getByRole('textbox', { name: 'Email', exact: true });
  const newPassword = page.getByLabel(/New password|Mật khẩu mới/);
  const confirmEmail = page.getByRole('button', { name: /Confirm email|Xác minh email/ });
  const enrollSend = page.getByRole('button', { name: /Send setup email|Gửi email đặt mật khẩu/ });
  await expect
    .poll(
      async () => {
        if (await email.isVisible().catch(() => false)) return 'email';
        if (await newPassword.isVisible().catch(() => false)) return 'new-password';
        if (await confirmEmail.isVisible().catch(() => false)) return 'confirm-email';
        if (await enrollSend.isVisible().catch(() => false)) return 'enroll-send';
        return '';
      },
      { timeout: 45_000 },
    )
    .not.toBe('');
}

export async function waitForOAuthProviders(page: Page) {
  await waitForAuthPageReady(page);
  await expect(page.getByRole('link', { name: /Continue with Google|Tiếp tục với Google/ })).toBeVisible({
    timeout: 45_000,
  });
}

export async function signupViaUi(page: Page, email: string, password = PASSWORD) {
  await isolateRateLimit(page);
  await page.goto('/app/auth/signup');
  await waitForAuthPageReady(page);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/Login password|Mật khẩu đăng nhập/).fill(password);
  await page.getByRole('checkbox', { name: /agree|terms|điều khoản/i }).check();
  await page.getByRole('button', { name: /Create account|Tạo tài khoản/ }).click();
  const outcome = await Promise.race([
    page.waitForURL(/\/app\/(onboarding|auth\/verify-email)/, { timeout: 30_000 }).then(() => 'ok' as const),
    page.getByTestId('auth-error-card').waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'err' as const),
  ]).catch(() => 'timeout' as const);
  await assertNotRateLimited(page);
  if (outcome === 'err') {
    const text = await page.getByTestId('auth-error-card').innerText();
    throw new Error(`signup failed: ${text}`);
  }
  if (outcome !== 'ok') {
    throw new Error('signup did not reach onboarding or verify-email');
  }
}

export async function loginViaUi(page: Page, email: string, password = PASSWORD) {
  await isolateRateLimit(page);
  await page.goto('/app/auth/login');
  await waitForAuthPageReady(page);
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
  await page.getByLabel(/Login password|Mật khẩu đăng nhập/).fill(password);
  const loginResponsePromise = page.waitForResponse(
    (res) =>
      res.request().method() === 'POST' && /\/api\/v1\/auth\/login$/.test(new URL(res.url()).pathname),
    { timeout: 15_000 },
  );
  await page.getByRole('button', { name: /Sign in|Đăng nhập/ }).click();
  const loginResponse = await loginResponsePromise.catch(() => null);
  await assertNotRateLimited(page);
  if (!loginResponse) {
    throw new Error(`login request did not complete (url=${page.url()})`);
  }
  if (!loginResponse.ok()) {
    await expect(page.getByTestId('auth-error-card')).toBeVisible({ timeout: 5_000 });
    const text = await page.getByTestId('auth-error-card').innerText();
    throw new Error(`login failed (${loginResponse.status()}): ${text}`);
  }
  // Login replace() goes to /app then RouteGuard may send onboarding — assert session, not a single path.
  await expect(page.getByTestId('session-status')).toBeAttached({ timeout: 15_000 });
  await expect(page.getByTestId('session-status')).toHaveText(/authenticated_/);
}

export async function expectSignedIn(page: Page) {
  const status = page.getByTestId('session-status');
  // sr-only is not "visible" to Playwright; assert presence + signed-in text.
  await expect(status).toBeAttached({ timeout: 20_000 });
  await expect(status).toHaveText(/authenticated_/);
}

export async function completeFakeOAuth(
  page: Page,
  opts: { email?: string; subject?: string; outcome?: 'ok' | 'cancel' | 'error' } = {},
) {
  await page.waitForURL(/\/api\/v1\/__fake\/oauth\//, { timeout: 15_000 });
  await expect(page.getByText(/Local fake provider/)).toBeVisible();
  if (opts.email) await page.locator('input[name="email"]').fill(opts.email);
  if (opts.subject) await page.locator('input[name="subject"]').fill(opts.subject);
  const label = opts.outcome === 'cancel' ? 'Cancel' : opts.outcome === 'error' ? 'Provider error' : 'Continue';
  await page.getByRole('button', { name: label }).click();
}

export async function cookieMap(context: BrowserContext): Promise<Map<string, { httpOnly: boolean; path: string; secure: boolean }>> {
  const cookies = await context.cookies();
  return new Map(cookies.map((c) => [c.name, { httpOnly: c.httpOnly, path: c.path, secure: c.secure }]));
}

export async function newContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:3000' });
  await isolateRateLimit(ctx);
  return ctx;
}

export async function apiHealth(request: APIRequestContext) {
  const health = await request.get('/api/v1/healthz');
  expect(health.status()).toBe(200);
}

/** Same-origin API from the page cookie jar (not APIRequestContext). */
export async function fetchMeViaPage(page: Page): Promise<{ status: number; body: unknown }> {
  return page.evaluate(async () => {
    const res = await fetch('/api/v1/auth/me', { credentials: 'same-origin' });
    const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    return { status: res.status, body };
  });
}

export async function postRefreshViaPage(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const parts = document.cookie.split(';');
    let csrf: string | null = null;
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.startsWith('sabk_csrf=')) {
        csrf = decodeURIComponent(trimmed.slice('sabk_csrf='.length));
        break;
      }
    }
    const res = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      },
      body: '{}',
    });
    return res.status;
  });
}

export async function patchSettingsViaPage(
  page: Page,
  patch: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(async (body) => {
    const parts = document.cookie.split(';');
    let csrf: string | null = null;
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.startsWith('sabk_csrf=')) {
        csrf = decodeURIComponent(trimmed.slice('sabk_csrf='.length));
        break;
      }
    }
    const res = await fetch('/api/v1/me/settings', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      },
      body: JSON.stringify(body),
    });
    const parsed = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    return { status: res.status, body: parsed };
  }, patch);
}

export async function newContextWithRateLimit(browser: Browser): Promise<BrowserContext> {
  return newContext(browser);
}
