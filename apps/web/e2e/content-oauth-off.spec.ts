import { expect, test } from '@playwright/test';
import { uniqueEmail } from './helpers';
import { signupPasswordUser } from './vault-journey-support';

const OAUTH_OFF_TIMEOUT_MS = 120_000;

test.describe('P04-T11 OAuth-off required arrays contract (CI-OAUTH-OFF, advisor-dec-089/121)', () => {
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  test('signs up with email/password when OAuth is off and serializes required arrays as arrays', async ({
    page,
    request,
  }) => {
    test.setTimeout(OAUTH_OFF_TIMEOUT_MS);

    const email = uniqueEmail('content-oauth-off');
    await signupPasswordUser(page, email);

    // OpenAPI schema AuthConfig: required array `oauth_providers` (empty `[]` when OAuth is disabled).
    const configRes = await request.get('/api/v1/auth/config');
    expect(configRes.status()).toBe(200);
    const configBody = (await configRes.json()) as {
      oauth_providers?: unknown;
      email_verification_required?: unknown;
    };
    expect(Array.isArray(configBody.oauth_providers)).toBe(true);
    expect(configBody.oauth_providers).toEqual([]);

    // Share the authenticated session cookies from the browser context with Playwright's APIRequestContext.
    const storageState = await page.context().storageState();
    const cookieHeader = storageState.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    // OpenAPI schema Me: required arrays `identities`, `features.oauth_providers`, `features.oauth_reauth_providers`.
    const meRes = await request.get('/api/v1/auth/me', {
      headers: { cookie: cookieHeader },
    });
    expect(meRes.status()).toBe(200);
    const meBody = (await meRes.json()) as {
      identities?: unknown;
      features?: {
        oauth_providers?: unknown;
        oauth_reauth_providers?: unknown;
      };
    };
    expect(Array.isArray(meBody.identities)).toBe(true);
    expect(Array.isArray(meBody.features?.oauth_providers)).toBe(true);
    expect(meBody.features?.oauth_providers).toEqual([]);
    expect(Array.isArray(meBody.features?.oauth_reauth_providers)).toBe(true);
    expect(meBody.features?.oauth_reauth_providers).toEqual([]);

    // Follow-up ownership (advisor-dec-127 Q4):
    // - W2 lane `itemtag` extends this spec with items/tags list arrays when its endpoints land:
    //   GET /api/v1/items -> ItemList.items (and ItemSummary.tags on returned items),
    //   GET /api/v1/items/lookup?name=x -> ItemLookupResult.items,
    //   GET /api/v1/tags -> TagList.items.
    // - W2 lane `entryapi` extends this spec with entries/changes arrays when its endpoints land:
    //   GET /api/v1/items/{id}/entries -> EntryMetaList.items,
    //   GET /api/v1/entries/changes?since=<now> -> EntryChangesPage.changes.
    // - Task 21a verifies full required-array coverage across all merged content endpoints.
  });
});
