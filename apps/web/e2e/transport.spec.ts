import { expect, test, type BrowserContext, type Page, type Response } from '@playwright/test';
import { expectSignedIn, fillSecret, signupViaUi, uniqueEmail } from './helpers';

const BASE_URL = process.env.BASE_URL ?? 'https://127.0.0.1:13443';
const BASE_ORIGIN = new URL(BASE_URL).origin;
const VAULT_PASSPHRASE = 'Tràm-Hương-94!Kỷ-Vật-Xanh';
const EXPECTED_HSTS = 'max-age=31536000; includeSubDomains';
const EXPECTED_PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)';
type CookieSnapshot = {
  httpOnly: boolean;
  path: string;
  sameSite: string;
  secure: boolean;
};

type DeletionCookieSnapshot = CookieSnapshot & {
  maxAge: string;
  name: string;
};

const AUTH_COOKIE_DELETIONS = [
  { name: 'sabk_session', httpOnly: true, path: '/api' },
  { name: 'sabk_refresh', httpOnly: true, path: '/api/v1/auth' },
  { name: 'sabk_csrf', httpOnly: false, path: '/' },
  { name: 'sabk_anon', httpOnly: true, path: '/api/v1/auth' },
  { name: 'sabk_oauth', httpOnly: true, path: '/api/v1/auth' },
  { name: 'sabk_reauth', httpOnly: true, path: '/api/v1/auth' },
] as const;

function cookieSnapshot(context: BrowserContext): Promise<Map<string, CookieSnapshot>> {
  return context.cookies().then(
    (cookies) =>
      new Map(
        cookies.map((cookie) => [
          cookie.name,
          {
            httpOnly: cookie.httpOnly,
            path: cookie.path,
            sameSite: cookie.sameSite,
            secure: cookie.secure,
          },
        ]),
      ),
  );
}

async function responseHeaders(response: Response | null): Promise<Record<string, string>> {
  expect(response, 'expected a document response').not.toBeNull();
  return response?.headers() ?? {};
}

function parseSetCookieDeletion(header: string): DeletionCookieSnapshot {
  const [pair, ...rawAttributes] = header.split(';');
  const separator = pair?.indexOf('=') ?? -1;
  const attributes = new Map(
    rawAttributes.map((attribute) => {
      const [rawName, ...rawValue] = attribute.trim().split('=');
      return [rawName?.toLowerCase() ?? '', rawValue.join('=').toLowerCase()];
    }),
  );
  return {
    httpOnly: attributes.has('httponly'),
    maxAge: attributes.get('max-age') ?? '',
    name: separator >= 0 ? pair!.slice(0, separator) : '',
    path: attributes.get('path') ?? '',
    sameSite: attributes.get('samesite') ?? '',
    secure: attributes.has('secure'),
  };
}

async function logoutDeletions(response: Response): Promise<Map<string, DeletionCookieSnapshot>> {
  const headers = await response.headerValues('set-cookie');
  return new Map(headers.map((header) => {
    const parsed = parseSetCookieDeletion(header);
    return [parsed.name, parsed];
  }));
}

async function visibleCookieNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    document.cookie
      .split(';')
      .map((part) => part.trim().split('=', 1)[0])
      .filter((name): name is string => Boolean(name)),
  );
}

function expectNoStore(headers: Record<string, string>) {
  expect(headers['cache-control'] ?? '').toMatch(/(?:^|,)\s*no-store\b/i);
}

function extractScriptSrc(csp: string): string {
  const directive = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('script-src '));
  expect(directive, `expected script-src directive in CSP: ${csp}`).toBeDefined();
  return directive!;
}

function extractNonce(csp: string): string {
  const scriptSrc = extractScriptSrc(csp);
  const match = scriptSrc.match(/'nonce-([A-Za-z0-9+/=]+)'/);
  expect(match, `expected nonce in script-src: ${scriptSrc}`).not.toBeNull();
  return match![1]!;
}

async function attachCspViolationMonitor(page: Page) {
  const violations: string[] = [];

  await page.addInitScript(() => {
    window.addEventListener('securitypolicyviolation', (event) => {
      // Ignore synthetic CDP UtilityScript.evaluate events triggered by Playwright's own locator.evaluate
      if (event.blockedURI === 'eval' && !event.sourceFile) return;
      console.error(
        `[CSP_VIOLATION] ${event.violatedDirective} blocked ${event.blockedURI || 'inline'} on ${window.location.pathname} (${event.sourceFile || 'document'}:${event.lineNumber})`,
      );
    });
  });

  page.on('console', (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    const text = msg.text();
    if (
      /Content Security Policy|securitypolicyviolation|\[CSP_VIOLATION\]|Refused to (?:execute|load|connect|frame|apply)/i.test(
        text,
      )
    ) {
      violations.push(`${msg.type()}: ${text}`);
    }
  });

  return {
    assertClean(contextLabel: string) {
      expect(violations, `CSP console / securitypolicyviolation errors on ${contextLabel}`).toEqual([]);
    },
  };
}
test.describe('HTTPS auth transport', () => {
  test.skip(!process.env.E2E_STACK, 'requires the HTTPS proxy and real API stack');

  test('sets scoped secure cookies and uses only CSRF from page JavaScript', async ({ page, context }) => {
    await signupViaUi(page, uniqueEmail('transport-cookies'));
    await expectSignedIn(page);

    const cookies = await cookieSnapshot(context);
    expect(cookies.get('sabk_session')).toEqual({
      httpOnly: true,
      path: '/api',
      sameSite: 'Lax',
      secure: true,
    });
    expect(cookies.get('sabk_refresh')).toEqual({
      httpOnly: true,
      path: '/api/v1/auth',
      sameSite: 'Lax',
      secure: true,
    });
    expect(cookies.get('sabk_csrf')).toEqual({
      httpOnly: false,
      path: '/',
      sameSite: 'Lax',
      secure: true,
    });

    // Use an API-path document so path matching cannot hide HttpOnly cookies.
    await page.goto('/api/v1/auth/me');
    const visible = await visibleCookieNames(page);
    expect(visible).toContain('sabk_csrf');
    expect(visible).not.toContain('sabk_session');
    expect(visible).not.toContain('sabk_refresh');

    const refreshResponse = await page.evaluate(async () => {
      const csrf = document.cookie
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith('sabk_csrf='))
        ?.slice('sabk_csrf='.length);
      const response = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : {}),
        },
        body: '{}',
      });
      return { cacheControl: response.headers.get('cache-control') ?? '', status: response.status };
    });
    expect(refreshResponse.status).toBe(204);
    expectNoStore({ 'cache-control': refreshResponse.cacheControl });

    const meResponse = await page.evaluate(async () => {
      const response = await fetch('/api/v1/auth/me', { credentials: 'same-origin' });
      return { cacheControl: response.headers.get('cache-control') ?? '', status: response.status };
    });
    expect(meResponse.status).toBe(200);
    expectNoStore({ 'cache-control': meResponse.cacheControl });
  });

  test('serves SSG hash CSP, per-request /app/* nonce CSP (Turnstile, Worker+WASM unlock, settings dialog), and hardened edge headers with 0 CSP violations', async ({
    page,
  }) => {
    const cspMonitor = await attachCspViolationMonitor(page);

    // 1. Marketing SSG routes: `/` and `/vi/privacy` use sha256-<base64> from manifest, no unsafe-inline
    const landingResponse = await page.goto('/', { waitUntil: 'networkidle' });
    expect(landingResponse?.status()).toBe(200);
    const landingHeaders = await responseHeaders(landingResponse);
    expect(landingHeaders['x-powered-by']).toBeUndefined();
    expect(landingHeaders['strict-transport-security']).toBe(EXPECTED_HSTS);
    expect(landingHeaders['permissions-policy']).toBe(EXPECTED_PERMISSIONS_POLICY);
    expect(landingHeaders['referrer-policy']).toBe('strict-origin-when-cross-origin');
    const landingCsp = landingHeaders['content-security-policy'] ?? '';
    expect(landingCsp).toContain("default-src 'self'");
    expect(landingCsp).toContain("frame-ancestors 'none'");
    expect(landingCsp).toContain("worker-src 'self' blob:");
    const landingScriptSrc = extractScriptSrc(landingCsp);
    expect(landingScriptSrc).toMatch(/'sha256-[A-Za-z0-9+/=]+'/);
    expect(landingScriptSrc).not.toContain("'unsafe-inline'");
    expect(landingScriptSrc).not.toContain("'unsafe-eval'");
    expect(landingScriptSrc).not.toContain("'nonce-");
    cspMonitor.assertClean('/');

    const viPrivacyResponse = await page.goto('/vi/privacy', { waitUntil: 'networkidle' });
    expect(viPrivacyResponse?.status()).toBe(200);
    const viPrivacyHeaders = await responseHeaders(viPrivacyResponse);
    const viPrivacyScriptSrc = extractScriptSrc(viPrivacyHeaders['content-security-policy'] ?? '');
    expect(viPrivacyScriptSrc).toMatch(/'sha256-[A-Za-z0-9+/=]+'/);
    expect(viPrivacyScriptSrc).not.toContain("'unsafe-inline'");
    expect(viPrivacyScriptSrc).not.toContain("'unsafe-eval'");
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
    cspMonitor.assertClean('/vi/privacy');

    // 2. Build manifest & CSP hash manifest are served under /.well-known/
    const buildManifestRes = await page.request.get('/.well-known/build-manifest.json');
    expect(buildManifestRes.status()).toBe(200);
    const buildManifestJson = (await buildManifestRes.json()) as { chunks?: Record<string, string> };
    expect(Object.keys(buildManifestJson.chunks ?? {}).length).toBeGreaterThan(0);
    // 3. `/app/auth/login` (Turnstile nonce) across 2 requests -> distinct nonces, no unsafe-inline
    const authResponse1 = await page.goto('/app/auth/login', { waitUntil: 'domcontentloaded' });
    expect(authResponse1?.status()).toBe(200);
    const authHeaders1 = await responseHeaders(authResponse1);
    expect(authHeaders1['referrer-policy']).toBe('no-referrer');
    expect(authHeaders1['x-powered-by']).toBeUndefined();
    expect(authHeaders1['strict-transport-security']).toBe(EXPECTED_HSTS);
    expect(authHeaders1['permissions-policy']).toBe(EXPECTED_PERMISSIONS_POLICY);
    const authCsp1 = authHeaders1['content-security-policy'] ?? '';
    expect(authCsp1).toContain("default-src 'self'");
    expect(authCsp1).toContain("frame-ancestors 'none'");
    expect(authCsp1).toContain('https://challenges.cloudflare.com');
    expect(extractScriptSrc(authCsp1)).not.toContain("'unsafe-inline'");
    expect(extractScriptSrc(authCsp1)).not.toContain("'unsafe-eval'");
    const nonce1 = extractNonce(authCsp1);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/i);

    const authResponse2 = await page.goto('/app/auth/login', { waitUntil: 'domcontentloaded' });
    const authHeaders2 = await responseHeaders(authResponse2);
    const nonce2 = extractNonce(authHeaders2['content-security-policy'] ?? '');
    expect(nonce2).not.toBe(nonce1);
    cspMonitor.assertClean('/app/auth/login');

    // 4. `/app/auth/reset-password` omits Turnstile origin and sets Cache-Control: no-store
    const resetResponse = await page.goto('/app/auth/reset-password', { waitUntil: 'domcontentloaded' });
    const resetHeaders = await responseHeaders(resetResponse);
    expect(resetHeaders['referrer-policy']).toBe('no-referrer');
    expectNoStore(resetHeaders);
    const resetCsp = resetHeaders['content-security-policy'] ?? '';
    expect(resetCsp).not.toContain('challenges.cloudflare.com');
    expect(extractNonce(resetCsp)).toBeTruthy();
    cspMonitor.assertClean('/app/auth/reset-password');

    // 5. Signup -> onboarding (Worker+WASM) -> lock -> `/app/unlock` (Worker+WASM) -> `/app/settings` account dialog
    await signupViaUi(page, uniqueEmail('transport-headers'));
    await expectSignedIn(page);
    await expect(page.getByTestId('onboarding-step-passphrase')).toBeVisible({ timeout: 60_000 });
    await fillSecret(page.getByLabel('Passphrase', { exact: true }), VAULT_PASSPHRASE);
    await fillSecret(page.getByLabel('Confirm passphrase'), VAULT_PASSPHRASE);
    await page.getByTestId('onboarding-continue-button').click();
    await expect(page.getByTestId('onboarding-step-recovery-keys')).toBeVisible({ timeout: 90_000 });
    await page.getByTestId('recovery-keys-confirm-checkbox').check();
    await page.getByTestId('onboarding-create-vault-button').click();
    await page.getByTestId('onboarding-skip-passkey-button').click({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/app$/, { timeout: 30_000 });

    await page.getByTestId('vault-lock-button').click();
    await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: 30_000 });
    const unlockResponse = await page.goto('/app/unlock', { waitUntil: 'domcontentloaded' });
    expect(unlockResponse?.status()).toBe(200);
    const unlockHeaders = await responseHeaders(unlockResponse);
    const unlockCsp = unlockHeaders['content-security-policy'] ?? '';
    expect(extractNonce(unlockCsp)).not.toBe(nonce2);
    expect(extractScriptSrc(unlockCsp)).toContain("'wasm-unsafe-eval'");
    expect(extractScriptSrc(unlockCsp)).not.toContain("'unsafe-inline'");
    await expect(page.getByTestId('vault-unlock-page')).toBeVisible({ timeout: 30_000 });
    await fillSecret(page.getByTestId('unlock-passphrase-input'), VAULT_PASSPHRASE);
    await page.getByTestId('unlock-submit-button').click();
    await expect(page).toHaveURL(/\/app$/, { timeout: 90_000 });
    cspMonitor.assertClean('/app/unlock');

    const privateResponse = await page.goto('/app/settings', { waitUntil: 'domcontentloaded' });
    expect(privateResponse?.status()).toBe(200);
    const privateHeaders = await responseHeaders(privateResponse);
    expect(privateHeaders['content-security-policy'] ?? '').toContain("default-src 'self'");
    expect(privateHeaders['content-security-policy'] ?? '').toContain("frame-ancestors 'none'");
    expect(extractNonce(privateHeaders['content-security-policy'] ?? '')).toBeTruthy();
    expect(privateHeaders['referrer-policy']).toBe('strict-origin-when-cross-origin');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/i);

    const changePwBtn = page.getByRole('button', { name: /Change password|Đổi mật khẩu/ });
    await expect(changePwBtn).toBeVisible();
    await changePwBtn.click();
    const passwordDlg = page.locator('#passwordChangeDlg');
    await expect(passwordDlg).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(passwordDlg).toBeHidden();
    cspMonitor.assertClean('/app/settings');
  });

  test('logout clears auth cookies while retaining preferences', async ({ page, context }) => {
    await signupViaUi(page, uniqueEmail('transport-logout'));
    await expectSignedIn(page);
    await page.goto('/app/settings');

    await context.addCookies([
      { name: 'sabk_locale', value: 'vi', url: `${BASE_ORIGIN}/`, secure: true, sameSite: 'Lax' },
      { name: 'sabk_theme', value: 'dark', url: `${BASE_ORIGIN}/`, secure: true, sameSite: 'Lax' },
    ]);
    const before = await cookieSnapshot(context);
    expect(before.has('sabk_locale')).toBe(true);
    expect(before.has('sabk_theme')).toBe(true);

    const logoutResponsePromise = page.waitForResponse(
      (response) => response.url().endsWith('/api/v1/auth/logout') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: /^(Sign out|Đăng xuất)$/ }).click();
    const logoutResponse = await logoutResponsePromise;
    expect(logoutResponse.status()).toBe(204);
    expectNoStore(await logoutResponse.headers());
    const deletions = await logoutDeletions(logoutResponse);
    for (const expected of AUTH_COOKIE_DELETIONS) {
      expect(deletions.get(expected.name)).toEqual({
        ...expected,
        maxAge: '0',
        sameSite: 'lax',
        secure: true,
      });
    }
    await expect(page).toHaveURL(/\/app\/auth\/login/, { timeout: 15_000 });

    const after = await cookieSnapshot(context);
    // The login page may bootstrap a fresh anonymous CSRF cookie after logout.
    for (const name of ['sabk_session', 'sabk_refresh']) {
      expect(after.has(name), `${name} should be cleared`).toBe(false);
    }
    expect(after.has('sabk_locale')).toBe(true);
    expect(after.has('sabk_theme')).toBe(true);
  });
});
