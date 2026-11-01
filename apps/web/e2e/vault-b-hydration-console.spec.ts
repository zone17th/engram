import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  MOCKED_HOME_ITEMS,
  installHomeContentMetadataRoutes,
  installItemPageMetadataRoutes,
} from './content-home-support';
import { LOCKED_ITEM_FIXTURE, installItemPageContentMocks } from './content-itempage-support';
import { UI_WAIT_MS, installApiMocks, installVisualApiMocks } from './vault-locked-support';

/**
 * FU5 REACT-418-HYDRATION diagnostic guard:
 * Visits the main public, auth, and mocked `/app` routes, attaches `page.on('console')` and
 * `page.on('pageerror')` listeners BEFORE navigation, and fails if any message matches
 * `/Minified React error #418|#423|#425|Hydration failed|did not match/i`, printing the full
 * matched route + console/pageerror text in the assertion message so the CI log captures it.
 */
const HYDRATION_ERROR_PATTERN = /Minified React error #418|#423|#425|Hydration failed|did not match/i;

function attachHydrationRecorder(page: Page) {
  const matched: string[] = [];
  const allErrors: string[] = [];

  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    const loc = msg.location();
    const locSuffix = loc?.url ? ` (${loc.url}:${loc.lineNumber ?? 0}:${loc.columnNumber ?? 0})` : '';
    const entry = `[console.${type}] ${text}${locSuffix}`;
    if (type === 'error' || type === 'warning') {
      allErrors.push(entry);
    }
    if (HYDRATION_ERROR_PATTERN.test(text)) {
      matched.push(entry);
    }
  });

  page.on('pageerror', (err) => {
    const text = `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}`;
    const entry = `[pageerror] ${text}`;
    allErrors.push(entry);
    if (HYDRATION_ERROR_PATTERN.test(text)) {
      matched.push(entry);
    }
  });

  return {
    matched,
    allErrors,
    formatReport(routeLabel: string): string {
      if (matched.length === 0) return '';
      return [
        `Hydration mismatch / React error detected on route "${routeLabel}" (${matched.length} matched message(s)):`,
        ...matched.map((m, idx) => `  [${idx + 1}] ${m}`),
        ...(allErrors.length > matched.length
          ? ['  --- All console error/warning & pageerror entries on this route ---', ...allErrors.map((e) => `  * ${e}`)]
          : []),
      ].join('\n');
    },
  };
}

async function installPublicAuthMocks(context: BrowserContext) {
  await context.route('**/api/v1/auth/csrf', async (route) => {
    await route.fulfill({
      status: 204,
      headers: { 'set-cookie': 'sabk_csrf=test-csrf-token; Path=/; SameSite=Lax' },
    });
  });
  await context.route('**/api/v1/auth/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        oauth_providers: ['google'],
        email_verification_required: false,
        captcha_site_key: null,
        mail_delivery_available: true,
      }),
    });
  });
  await context.route('**/api/v1/auth/me', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'https://engram.local/problems/unauthenticated',
        title: 'Unauthenticated',
        status: 401,
        code: 'unauthenticated',
      }),
    });
  });
}

async function checkRouteHydration(
  browser: Browser,
  routeLabel: string,
  options: {
    setupContext?: (context: BrowserContext) => Promise<void>;
    navigateAndWait: (page: Page) => Promise<void>;
  },
): Promise<string[]> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    if (options.setupContext) {
      await options.setupContext(context);
    }
    const page = await context.newPage();
    const recorder = attachHydrationRecorder(page);
    await options.navigateAndWait(page);
    // Allow post-hydration microtasks and effects to flush any queued console errors.
    await page.waitForTimeout(250);
    if (recorder.matched.length > 0) {
      return [recorder.formatReport(routeLabel)];
    }
    return [];
  } finally {
    await context.close();
  }
}

test.describe('FU5 React #418 hydration console diagnostic guard', () => {
  test('public and auth routes (/, /vi, /terms, /privacy, /login, /app/auth/*) emit no React hydration errors', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const failures: string[] = [];

    const routes: ReadonlyArray<{
      label: string;
      path: string;
      wait: (page: Page) => Promise<void>;
    }> = [
      {
        label: 'GET /',
        path: '/',
        wait: async (page) => {
          await expect(page.locator('main, nav').first()).toBeVisible({ timeout: UI_WAIT_MS });
        },
      },
      {
        label: 'GET /vi',
        path: '/vi',
        wait: async (page) => {
          await expect(page.locator('main, nav').first()).toBeVisible({ timeout: UI_WAIT_MS });
        },
      },
      {
        label: 'GET /terms',
        path: '/terms',
        wait: async (page) => {
          await expect(page.locator('h1').first()).toBeVisible({ timeout: UI_WAIT_MS });
        },
      },
      {
        label: 'GET /privacy',
        path: '/privacy',
        wait: async (page) => {
          await expect(page.locator('h1').first()).toBeVisible({ timeout: UI_WAIT_MS });
        },
      },
      {
        label: 'GET /login (compat route -> /app/auth/login)',
        path: '/login',
        wait: async (page) => {
          await expect(page.locator('body')).toBeAttached({ timeout: UI_WAIT_MS });
        },
      },
      {
        label: 'GET /app/auth/login',
        path: '/app/auth/login',
        wait: async (page) => {
          await expect(page.locator('#auth-login form[data-hydrated="true"]')).toBeVisible({ timeout: UI_WAIT_MS });
        },
      },
      {
        label: 'GET /app/auth/login?reset=done',
        path: '/app/auth/login?reset=done',
        wait: async (page) => {
          await expect(page.getByTestId('login-reset-banner')).toBeVisible({ timeout: UI_WAIT_MS });
          await expect(page.locator('#auth-login form[data-hydrated="true"]')).toBeVisible({ timeout: UI_WAIT_MS });
        },
      },
      {
        label: 'GET /app/auth/signup',
        path: '/app/auth/signup',
        wait: async (page) => {
          await expect(page.locator('#auth-signup form[data-hydrated="true"]')).toBeVisible({ timeout: UI_WAIT_MS });
        },
      },
      {
        label: 'GET /app/auth/forgot-password',
        path: '/app/auth/forgot-password',
        wait: async (page) => {
          await expect(page.locator('#auth-forgot form[data-hydrated="true"]')).toBeVisible({ timeout: UI_WAIT_MS });
        },
      },
      {
        label: 'GET /app/auth/reset-password',
        path: '/app/auth/reset-password',
        wait: async (page) => {
          await expect(page.getByTestId('reset-invalid-token')).toBeVisible({ timeout: UI_WAIT_MS });
        },
      },
    ];

    for (const route of routes) {
      const routeFailures = await checkRouteHydration(browser, route.label, {
        setupContext: installPublicAuthMocks,
        navigateAndWait: async (page) => {
          await page.goto(route.path);
          await route.wait(page);
        },
      });
      failures.push(...routeFailures);
    }

    expect(failures, failures.join('\n\n')).toEqual([]);
  });

  test('/app and /app/items/<id> with vault-locked-search mocks (installApiMocks) emit no React hydration errors', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const failures: string[] = [];
    const mockedFirstItem = MOCKED_HOME_ITEMS[0]!;

    // 1. Exact setup from e2e/vault-locked-search.spec.ts test 1 (`/app` load with installApiMocks)
    failures.push(
      ...(await checkRouteHydration(browser, 'GET /app (installApiMocks + installHomeContentMetadataRoutes)', {
        setupContext: async (context) => {
          await installApiMocks(context);
          await installHomeContentMetadataRoutes(context);
          await installItemPageMetadataRoutes(context, mockedFirstItem.id);
        },
        navigateAndWait: async (page) => {
          await page.goto('/app');
          await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
          await expect(page.locator('#omni textarea[data-vault-secret]')).toBeVisible({ timeout: UI_WAIT_MS });
        },
      })),
    );

    // 2. Exact setup from e2e/vault-locked-search.spec.ts test 2 (`/app/items/<id>` load with installApiMocks)
    failures.push(
      ...(await checkRouteHydration(
        browser,
        `GET /app/items/${LOCKED_ITEM_FIXTURE.item.id} (installApiMocks + installItemPageContentMocks)`,
        {
          setupContext: async (context) => {
            await installApiMocks(context);
            await installHomeContentMetadataRoutes(context);
            await installItemPageContentMocks(context);
          },
          navigateAndWait: async (page) => {
            await page.goto(`/app/items/${LOCKED_ITEM_FIXTURE.item.id}`);
            await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
            await expect(page.locator('header textarea[data-vault-secret]')).toBeVisible({ timeout: UI_WAIT_MS });
          },
        },
      )),
    );

    // 3. `/app` with Vietnamese browser Accept-Language header vs installApiMocks cookie (`127.0.0.1` vs `localhost`)
    failures.push(
      ...(await checkRouteHydration(
        browser,
        'GET /app (installApiMocks + Accept-Language: vi-VN,vi;q=0.9)',
        {
          setupContext: async (context) => {
            await context.setExtraHTTPHeaders({ 'accept-language': 'vi-VN,vi;q=0.9' });
            await installApiMocks(context);
            await installHomeContentMetadataRoutes(context);
          },
          navigateAndWait: async (page) => {
            await page.goto('/app');
            await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
          },
        },
      )),
    );

    // 4. Other main `/app/*` routes reachable with existing mocks (`/app/unlock`, `/app/unlock/forgot`, `/app/recovery`, `/app/settings`)
    const extraAppRoutes: ReadonlyArray<{
      label: string;
      path: string;
      wait: (page: Page) => Promise<void>;
    }> = [
      {
        label: 'GET /app/unlock (installApiMocks)',
        path: '/app/unlock',
        wait: async (page) => {
          await expect(page.locator('main h1').first()).toBeVisible({ timeout: UI_WAIT_MS });
        },
      },
      {
        label: 'GET /app/unlock/forgot (installApiMocks)',
        path: '/app/unlock/forgot',
        wait: async (page) => {
          await expect(page.locator('main h1').first()).toBeVisible({ timeout: UI_WAIT_MS });
        },
      },
      {
        label: 'GET /app/recovery (installApiMocks)',
        path: '/app/recovery',
        wait: async (page) => {
          await expect(page.locator('main h1').first()).toBeVisible({ timeout: UI_WAIT_MS });
        },
      },
      {
        label: 'GET /app/settings (installVisualApiMocks light)',
        path: '/app/settings',
        wait: async (page) => {
          await expect(page.locator('main h1').first()).toBeVisible({ timeout: UI_WAIT_MS });
        },
      },
    ];

    for (const route of extraAppRoutes) {
      failures.push(
        ...(await checkRouteHydration(browser, route.label, {
          setupContext: async (context) => {
            if (route.path === '/app/settings') {
              await installVisualApiMocks(context, 'light');
              await context.route('**/api/v1/vault', async (r) => {
                await r.fulfill({
                  status: 200,
                  contentType: 'application/json',
                  body: JSON.stringify({
                    version: 1,
                    vault_key_id: 'vk:7f3a9b2c4d5e6f7a8b9c0d',
                    kdf: { alg: 'argon2id13', ops: 3, mem: 67_108_864, parallelism: 1, salt: 'oKGio6SlpqeoqaqrrK2urw' },
                    vault_key_wrapped_by_kek:
                      'AbCxsrO0tba3uLm6u7y9vr_AwcLDxMXGxyfYfNv-vuDRS6i3Up5z_wCEX2cLt1xXgujuY7dGa_eirv2y5QQSBXkKR95PrK-ilA',
                    x25519_public: 'EIT5fcwxJb3Sw8y-V9yHL-JGU5pDVlgw9H5ueCV7OnI',
                    ed25519_public: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
                    private_keys_wrapped:
                      'AeDh4uPk5ebn6Onq6-zt7u_w8fLz9PX299I6ypcubNr8Ofy8RwtQE-3gVPZ1cTrHgeO1ZMoyFkOJgqz7gG75ofa4qHejTdUrskM0hqoPmKH-rt_ZLSoHn2BH9MF-TUGyovpu_punj7v-',
                    recovery_keys_remaining: 10,
                    passkeys: [],
                  }),
                });
              });
              await context.route('**/api/v1/auth/sessions', async (r) => {
                await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [] }) });
              });
              await context.route('**/api/v1/auth/audit*', async (r) => {
                await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ events: [] }) });
              });
            } else {
              await installApiMocks(context);
              await installHomeContentMetadataRoutes(context);
            }
          },
          navigateAndWait: async (page) => {
            await page.goto(route.path);
            await route.wait(page);
          },
        })),
      );
    }

    expect(failures, failures.join('\n\n')).toEqual([]);
  });
});
