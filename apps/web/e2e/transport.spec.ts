import { expect, test, type BrowserContext, type Page, type Response } from '@playwright/test';
import { expectSignedIn, signupViaUi, uniqueEmail } from './helpers';

const BASE_URL = process.env.BASE_URL ?? 'https://127.0.0.1:13443';
const BASE_ORIGIN = new URL(BASE_URL).origin;

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

  test('serves auth and private pages with security metadata', async ({ page }) => {
    const authResponse = await page.goto('/app/auth/login', { waitUntil: 'domcontentloaded' });
    const authHeaders = await responseHeaders(authResponse);
    expect(authHeaders['referrer-policy']).toBe('no-referrer');
    expect(authHeaders['content-security-policy'] ?? '').toContain("default-src 'self'");
    expect(authHeaders['content-security-policy'] ?? '').toContain("frame-ancestors 'none'");
    expect(authHeaders['content-security-policy'] ?? '').toContain('https://challenges.cloudflare.com');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/i);

    await signupViaUi(page, uniqueEmail('transport-headers'));
    await expectSignedIn(page);

    const privateResponse = await page.goto('/app/settings', { waitUntil: 'domcontentloaded' });
    const privateHeaders = await responseHeaders(privateResponse);
    expect(privateHeaders['content-security-policy'] ?? '').toContain("default-src 'self'");
    expect(privateHeaders['content-security-policy'] ?? '').toContain("frame-ancestors 'none'");
    expect(privateHeaders['referrer-policy']).toBe('strict-origin-when-cross-origin');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/i);
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
