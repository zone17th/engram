import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Deterministic JS v1 crypto vectors from `packages/crypto-vectors/vectors/js-v1.json`
 * so the real browser Worker (`worker.ts`) can unlock a real Argon2id-64MiB wrapped VK.
 */
const TEST_VECTOR_PASSPHRASE = 'correct-horse-battery-staple-engram-js-v1';
const TEST_VECTOR_KDF = {
  alg: 'argon2id13' as const,
  ops: 3,
  mem: 67_108_864,
  parallelism: 1,
  salt: 'oKGio6SlpqeoqaqrrK2urw',
};
const TEST_VECTOR_WRAPPED_VK =
  'AbCxsrO0tba3uLm6u7y9vr_AwcLDxMXGxyfYfNv-vuDRS6i3Up5z_wCEX2cLt1xXgujuY7dGa_eirv2y5QQSBXkKR95PrK-ilA';
const TEST_VECTOR_WRAPPED_PRIV =
  'AeDh4uPk5ebn6Onq6-zt7u_w8fLz9PX299I6ypcubNr8Ofy8RwtQE-3gVPZ1cTrHgeO1ZMoyFkOJgqz7gG75ofa4qHejTdUrskM0hqoPmKH-rt_ZLSoHn2BH9MF-TUGyovpu_punj7v-';
const TEST_VECTOR_VAULT_KEY_ID = 'vk:7f3a9b2c4d5e6f7a8b9c0d';

const SECRET_BODY_TEXT = 'engram-t15a-e2e-decrypted-entry-secret-body-987654';

async function installAuthenticatedVaultApiMocks(context: BrowserContext) {
  await context.route('**/api/v1/auth/csrf', async (route) => {
    await route.fulfill({
      status: 204,
      headers: {
        'set-cookie': 'sabk_csrf=e2e-csrf-token; Path=/; SameSite=Lax',
      },
    });
  });

  await context.route('**/api/v1/auth/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        email_verification_required: false,
        oauth_providers: ['google', 'github'],
        captcha: { turnstile_site_key: null },
      }),
    });
  });

  await context.route('**/api/v1/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'lock-e2e@example.test',
          email_verified: true,
          created_at: '2026-10-29T00:00:00Z',
        },
        settings: {
          locale: 'vi',
          theme: 'light',
          auto_lock_minutes: 15,
          semantic_suggest: false,
        },
        identities: [{ provider: 'password', linked_at: '2026-10-29T00:00:00Z' }],
        features: {
          semantic_available: false,
          email_verification_required: false,
          oauth_providers: [],
          oauth_reauth_providers: [],
          password_enrollment_available: false,
          captcha_site_key: null,
        },
        vault: {
          status: 'present',
        },
      }),
    });
  });

  await context.route('**/api/v1/auth/sessions', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    });
  });

  await context.route('**/api/v1/auth/audit*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], next_cursor: null }),
    });
  });

  await context.route('**/api/v1/me/notifications*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], unread_count: 0, next_cursor: null }),
    });
  });

  await context.route('**/api/v1/readyz', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        semantic_available: false,
      }),
    });
  });

  await context.route('**/api/v1/vault', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: 1,
        vault_key_id: TEST_VECTOR_VAULT_KEY_ID,
        kdf: TEST_VECTOR_KDF,
        vault_key_wrapped_by_kek: TEST_VECTOR_WRAPPED_VK,
        private_keys_wrapped: TEST_VECTOR_WRAPPED_PRIV,
        public_keys: {
          x25519: 'EIT5fcwxJb3Sw8y-V9yHL-JGU5pDVlgw9H5ueCV7OnI',
          ed25519: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
        },
        recovery_keys: {
          total: 10,
          remaining: 10,
          used_slots: [],
          low_warning: false,
        },
        passkeys: [],
      }),
    });
  });
}

async function unlockPageViaRealWorkerAndSeedSecret(page: Page, secretId: string) {
  await page.waitForFunction(() => {
    const win = window as unknown as {
      __engramVaultTestBridge?: { state: string };
    };
    return Boolean(win.__engramVaultTestBridge);
  });

  await page.evaluate(
    async ({ passphrase, kdf, wrappedVk, wrappedPriv, bodyText, secretDomId }) => {
      const win = window as unknown as {
        __engramVaultTestBridge: {
          beginOp: () => { opGeneration: number };
          unlockPassphrase: (params: {
            passphrase: string;
            kdf: typeof kdf;
            vaultKeyWrappedByKek: string;
            privateKeysWrapped: string;
            opGeneration: number;
          }) => Promise<{ unlocked: true }>;
          registerSecretFormReset: (fn: () => void) => () => void;
        };
        __engramQueryClient: {
          setQueryData: (key: unknown[], data: unknown) => void;
        };
      };

      const bridge = win.__engramVaultTestBridge;
      const { opGeneration } = bridge.beginOp();
      await bridge.unlockPassphrase({
        passphrase,
        kdf,
        vaultKeyWrappedByKek: wrappedVk,
        privateKeysWrapped: wrappedPriv,
        opGeneration,
      });

      // Seed decrypted entry body cache `['vault', 'body', 'item-1']` and render a live DOM subscriber
      win.__engramQueryClient.setQueryData(['vault', 'body', 'item-1'], {
        plaintext: bodyText,
      });

      let host = document.getElementById(secretDomId);
      if (!host) {
        host = document.createElement('div');
        host.id = secretDomId;
        host.setAttribute('data-testid', secretDomId);
        document.body.appendChild(host);
      }
      host.textContent = bodyText;

      const input = document.createElement('input');
      input.type = 'password';
      input.id = `${secretDomId}-input`;
      input.value = bodyText;
      document.body.appendChild(input);

      bridge.registerSecretFormReset(() => {
        if (host) {
          host.textContent = '[LOCKED]';
        }
      });
    },
    {
      passphrase: TEST_VECTOR_PASSPHRASE,
      kdf: TEST_VECTOR_KDF,
      wrappedVk: TEST_VECTOR_WRAPPED_VK,
      wrappedPriv: TEST_VECTOR_WRAPPED_PRIV,
      bodyText: SECRET_BODY_TEXT,
      secretDomId: secretId,
    },
  );
}

test.describe('P03-T15A Vault lock propagation and History Back protection', () => {
  test('locking in Page A propagates via BroadcastChannel + IndexedDB lockEpoch to Page B, and History Back after lock never reveals plaintext', async ({
    context,
  }) => {
    test.setTimeout(90_000);
    await installAuthenticatedVaultApiMocks(context);

    const pageA = await context.newPage();
    const pageB = await context.newPage();

    // Navigate both pages to `/app/settings` (accessible while vault is locked or unlocked)
    await pageA.goto('/app/settings');
    await pageB.goto('/app/settings');

    // Verify both pages start with locked vault pill (`vault-shut` / `Vault đang khoá`)
    await expect(pageA.locator('.vault-pill')).toHaveClass(/vault-shut/);
    await expect(pageB.locator('.vault-pill')).toHaveClass(/vault-shut/);

    // Unlock both pages via the real CryptoClient Worker (real Argon2id 64 MiB) and seed decrypted entry cache
    await unlockPageViaRealWorkerAndSeedSecret(pageA, 'secret-preview-a');
    await unlockPageViaRealWorkerAndSeedSecret(pageB, 'secret-preview-b');

    // Both pages now show `vault-open` (`Vault mở`) in the header pill and render the header lock button
    await expect(pageA.locator('.vault-pill')).toHaveClass(/vault-open/);
    await expect(pageB.locator('.vault-pill')).toHaveClass(/vault-open/);
    await expect(pageA.getByTestId('vault-lock-button')).toBeVisible();
    await expect(pageB.getByTestId('vault-lock-button')).toBeVisible();
    await expect(pageA.getByTestId('secret-preview-a')).toHaveText(SECRET_BODY_TEXT);
    await expect(pageB.getByTestId('secret-preview-b')).toHaveText(SECRET_BODY_TEXT);

    // Client-side navigate Page A to `/app` via the header logo link so the single-page app keeps its Worker unlocked
    // and pushes a browser History entry to press Back on after locking
    await pageA.locator('header a[href="/app"]').first().click();
    await expect(pageA).toHaveURL(/\/app$/);
    await expect(pageA.locator('.vault-pill')).toHaveClass(/vault-open/);
    await expect(pageA.getByTestId('secret-preview-a')).toHaveText(SECRET_BODY_TEXT);

    // Trigger lock in Page A via the keyboard shortcut `L` outside inputs (or header lock button)
    await pageA.keyboard.press('L');

    // Page A locks immediately, clears its decrypted entry body cache, and resets secret form/DOM state
    await expect(pageA.getByTestId('secret-preview-a')).toHaveText('[LOCKED]');
    await expect(pageA.locator('body')).not.toContainText(SECRET_BODY_TEXT);

    // Page B receives the lock via BroadcastChannel('sabk.vault') + IndexedDB `lock_epoch` marker and locks automatically
    await expect(pageB.locator('.vault-pill')).toHaveClass(/vault-shut/);
    await expect(pageB.getByTestId('secret-preview-b')).toHaveText('[LOCKED]');
    await expect(pageB.locator('body')).not.toContainText(SECRET_BODY_TEXT);

    // Verify `sabk.device` IndexedDB `lock_epoch` marker was persisted under Web Lock
    const persistedEpoch = await pageB.evaluate(async () => {
      return new Promise<{ epochIncarnation: string; lockEpoch: number } | null>((resolve) => {
        const req = indexedDB.open('sabk.device', 1);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('lock_epoch', 'readonly');
          const getReq = tx.objectStore('lock_epoch').get('__lock_epoch__');
          getReq.onsuccess = () => {
            db.close();
            resolve(getReq.result ?? null);
          };
          getReq.onerror = () => {
            db.close();
            resolve(null);
          };
        };
        req.onerror = () => resolve(null);
      });
    });
    expect(persistedEpoch).not.toBeNull();
    expect(persistedEpoch?.lockEpoch).toBeGreaterThanOrEqual(1);
    expect(persistedEpoch?.epochIncarnation).toMatch(/^[0-9a-f]{32}$/);

    // Press browser Back in Page A -> must NOT show any plaintext and must remain locked
    await pageA.goBack();
    await expect(pageA.locator('body')).not.toContainText(SECRET_BODY_TEXT);
    const cacheHasPlaintextA = await pageA.evaluate(() => {
      const win = window as unknown as {
        __engramQueryClient?: {
          getQueryData: (key: unknown[]) => unknown;
        };
      };
      return win.__engramQueryClient?.getQueryData(['vault', 'body', 'item-1']) ?? null;
    });
    expect(cacheHasPlaintextA).toBeNull();

    await pageA.close();
    await pageB.close();
  });
});
