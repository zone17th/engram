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

    // P04-T5 (itemtag): required-arrays contract for items and tags with OAuth off.
    const suffix = `${process.env.TEST_WORKER_INDEX ?? '0'}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const tagDisplay = `oauth-off-tag-${suffix}`;
    const itemName = `oauth-off-item-${suffix}`;

    // 1-2. Empty ItemList and TagList serialize `items` as `[]` (never null) for a new user.
    const emptyItemsRes = await request.get('/api/v1/items', {
      headers: { cookie: cookieHeader },
    });
    expect(emptyItemsRes.status()).toBe(200);
    const emptyItemsBody = (await emptyItemsRes.json()) as {
      items?: unknown;
      next_cursor?: unknown;
    };
    expect(Array.isArray(emptyItemsBody.items)).toBe(true);
    expect(emptyItemsBody.items).toEqual([]);
    expect(emptyItemsBody.next_cursor).toBeNull();

    const emptyTagsRes = await request.get('/api/v1/tags', {
      headers: { cookie: cookieHeader },
    });
    expect(emptyTagsRes.status()).toBe(200);
    const emptyTagsBody = (await emptyTagsRes.json()) as {
      items?: unknown;
      next_cursor?: unknown;
    };
    expect(Array.isArray(emptyTagsBody.items)).toBe(true);
    expect(emptyTagsBody.items).toEqual([]);
    expect(emptyTagsBody.next_cursor).toBeNull();

    // 2b. No-match lookup (before any write) serializes `items` as `[]`, total 0, next_cursor null (IT5-FE1-1).
    const emptyLookupRes = await request.get(
      `/api/v1/items/lookup?name=${encodeURIComponent(itemName)}`,
      { headers: { cookie: cookieHeader } },
    );
    expect(emptyLookupRes.status()).toBe(200);
    const emptyLookupBody = (await emptyLookupRes.json()) as {
      items?: unknown;
      total?: unknown;
      next_cursor?: unknown;
    };
    expect(Array.isArray(emptyLookupBody.items)).toBe(true);
    expect(emptyLookupBody.items).toEqual([]);
    expect(emptyLookupBody.total).toBe(0);
    expect(emptyLookupBody.next_cursor).toBeNull();

    // 3. Create a tag, create an item, and attach the tag via same-origin page fetch (carries cookies + CSRF + Idempotency-Key).
    const itemtagWriteProbe = await page.evaluate(
      async (input) => {
        let csrf: string | null = null;
        for (const part of document.cookie.split(';')) {
          const trimmed = part.trim();
          if (trimmed.startsWith('sabk_csrf=')) {
            csrf = decodeURIComponent(trimmed.slice('sabk_csrf='.length));
            break;
          }
        }
        const makeHeaders = () => ({
          accept: 'application/json',
          'content-type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        });

        const tagRes = await fetch('/api/v1/tags', {
          method: 'POST',
          credentials: 'same-origin',
          headers: makeHeaders(),
          body: JSON.stringify({ display: input.tagDisplay }),
        });
        const tagBody = (await tagRes.json().catch(() => null)) as {
          id?: unknown;
          display?: unknown;
        } | null;

        const itemRes = await fetch('/api/v1/items', {
          method: 'POST',
          credentials: 'same-origin',
          headers: makeHeaders(),
          body: JSON.stringify({ name: input.itemName }),
        });
        const itemBody = (await itemRes.json().catch(() => null)) as {
          id?: unknown;
          name?: unknown;
          tags?: unknown;
        } | null;

        const tagId = typeof tagBody?.id === 'string' ? tagBody.id : '';
        const itemId = typeof itemBody?.id === 'string' ? itemBody.id : '';

        let attachStatus = 0;
        let attachTags: unknown = null;
        if (tagId && itemId) {
          const attachRes = await fetch(`/api/v1/items/${encodeURIComponent(itemId)}/tags`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: makeHeaders(),
            body: JSON.stringify({ tag_ids: [tagId] }),
          });
          attachStatus = attachRes.status;
          const attachBody = (await attachRes.json().catch(() => null)) as {
            tags?: unknown;
          } | null;
          attachTags = attachBody?.tags ?? null;
        }

        return {
          tagStatus: tagRes.status,
          tagId,
          tagDisplayReturned: typeof tagBody?.display === 'string' ? tagBody.display : null,
          itemStatus: itemRes.status,
          itemId,
          itemInitialTags: itemBody?.tags ?? null,
          attachStatus,
          attachTags,
        };
      },
      { tagDisplay, itemName },
    );

    expect(itemtagWriteProbe.tagStatus).toBe(201);
    expect(itemtagWriteProbe.tagId).toBeTruthy();
    expect(itemtagWriteProbe.tagDisplayReturned).toBe(tagDisplay);
    expect(itemtagWriteProbe.itemStatus).toBe(201);
    expect(itemtagWriteProbe.itemId).toBeTruthy();
    expect(Array.isArray(itemtagWriteProbe.itemInitialTags)).toBe(true);
    expect(itemtagWriteProbe.itemInitialTags).toEqual([]);
    expect(itemtagWriteProbe.attachStatus).toBe(200);
    expect(Array.isArray(itemtagWriteProbe.attachTags)).toBe(true);
    expect(itemtagWriteProbe.attachTags).toEqual([
      { id: itemtagWriteProbe.tagId, display: tagDisplay },
    ]);

    // 4. GET /api/v1/items -> items array with 1 entry whose `tags` is an array containing {id, display}.
    const itemsRes = await request.get('/api/v1/items', {
      headers: { cookie: cookieHeader },
    });
    expect(itemsRes.status()).toBe(200);
    const itemsBody = (await itemsRes.json()) as {
      items?: Array<{ id?: unknown; name?: unknown; tags?: unknown }>;
      next_cursor?: unknown;
    };
    expect(Array.isArray(itemsBody.items)).toBe(true);
    expect(itemsBody.items).toHaveLength(1);
    expect(itemsBody.next_cursor).toBeNull();
    expect(itemsBody.items?.[0]?.id).toBe(itemtagWriteProbe.itemId);
    expect(itemsBody.items?.[0]?.name).toBe(itemName);
    expect(Array.isArray(itemsBody.items?.[0]?.tags)).toBe(true);
    expect(itemsBody.items?.[0]?.tags).toEqual([
      { id: itemtagWriteProbe.tagId, display: tagDisplay },
    ]);

    // 5. GET /api/v1/items/lookup?name=<itemName> -> items array (length 1) and total 1.
    const lookupRes = await request.get(
      `/api/v1/items/lookup?name=${encodeURIComponent(itemName)}`,
      { headers: { cookie: cookieHeader } },
    );
    expect(lookupRes.status()).toBe(200);
    const lookupBody = (await lookupRes.json()) as {
      items?: Array<{ id?: unknown; name?: unknown; tags?: unknown }>;
      total?: unknown;
      next_cursor?: unknown;
    };
    expect(Array.isArray(lookupBody.items)).toBe(true);
    expect(lookupBody.items).toHaveLength(1);
    expect(lookupBody.total).toBe(1);
    expect(lookupBody.next_cursor).toBeNull();
    expect(lookupBody.items?.[0]?.id).toBe(itemtagWriteProbe.itemId);
    expect(Array.isArray(lookupBody.items?.[0]?.tags)).toBe(true);
    expect(lookupBody.items?.[0]?.tags).toEqual([
      { id: itemtagWriteProbe.tagId, display: tagDisplay },
    ]);

    // 6. GET /api/v1/tags -> items array length 1.
    const tagsRes = await request.get('/api/v1/tags', {
      headers: { cookie: cookieHeader },
    });
    expect(tagsRes.status()).toBe(200);
    const tagsBody = (await tagsRes.json()) as {
      items?: Array<{ id?: unknown; display?: unknown; item_count?: unknown }>;
      next_cursor?: unknown;
    };
    expect(Array.isArray(tagsBody.items)).toBe(true);
    expect(tagsBody.items).toHaveLength(1);
    expect(tagsBody.next_cursor).toBeNull();
    expect(tagsBody.items?.[0]?.id).toBe(itemtagWriteProbe.tagId);
    expect(tagsBody.items?.[0]?.display).toBe(tagDisplay);
    expect(tagsBody.items?.[0]?.item_count).toBe(1);

    // Follow-up ownership (advisor-dec-127 Q4):
    // - W2 lane `itemtag`: covered above (`GET /api/v1/items`, `GET /api/v1/items/lookup`, `GET /api/v1/tags`, and `ItemSummary.tags`).
    // - W2 lane `entryapi` extends this spec with entries/changes arrays when its endpoints land:
    //   GET /api/v1/items/{id}/entries -> EntryMetaList.items,
    //   GET /api/v1/entries/changes?since=<now> -> EntryChangesPage.changes.
    // - Task 21a verifies full required-array coverage across all merged content endpoints.
  });
});
