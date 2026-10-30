import { expect, test, type Page } from '@playwright/test';
import {
  PASSWORD,
  expectSignedIn,
  fetchMeViaPage,
  newContext,
  tokenFromLink,
  uniqueEmail,
  verifyRequired,
  waitForMail,
} from './helpers';
import {
  FLOW_TIMEOUT_MS,
  UI_WAIT_MS,
  addAuthenticator,
  enableWebAuthn,
  expectPasskeyAdded,
  expectVaultOpen,
  gotoSettings,
  openAddPasskeyDialog,
  signupViaUiSecret,
  submitPasskeyName,
} from './vault-passkey-support';
import { fillSecret } from './vault-settings-secret';

const INITIAL_VAULT_PASSPHRASE = 'correct-horse-battery-staple-gn-v1';
const STEP_TIMEOUT = 15_000;

async function confirmEmailToken(page: Page, token: string) {
  await page.goto(`/app/auth/verify-email?token=${encodeURIComponent(token)}`, {
    waitUntil: 'domcontentloaded',
    timeout: STEP_TIMEOUT,
  });
  const respPromise = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/api/v1/auth/verify-email/confirm'),
    { timeout: STEP_TIMEOUT },
  );
  await page.getByRole('button', { name: /Confirm|Xác nhận email/ }).click({ timeout: STEP_TIMEOUT });
  const resp = await respPromise;
  expect(resp.status()).toBe(200);
}

async function waitForVaultBridgeReady(page: Page) {
  await page.waitForFunction(
    () => {
      const win = window as unknown as {
        __engramVaultTestBridge?: {
          beginOp?: unknown;
          reloadVaultMeta?: unknown;
          unlockPassphrase?: unknown;
          createVault?: unknown;
        };
      };
      return typeof win.__engramVaultTestBridge?.beginOp === 'function';
    },
    undefined,
    { timeout: STEP_TIMEOUT },
  );
}

async function createAndUnlockVaultViaBridge(page: Page, passphrase = INITIAL_VAULT_PASSPHRASE) {
  await waitForVaultBridgeReady(page);

  await page.evaluate(async (pp) => {
    const win = window as unknown as {
      __engramVaultTestBridge: {
        beginOp: () => { opGeneration: number };
        createVault: (params: {
          passphrase: string;
          opGeneration: number;
          skipRecoveryKeys?: boolean;
        }) => Promise<{
          kdf: {
            alg: 'argon2id13';
            ops: number;
            mem: number;
            parallelism: 1;
            salt: string;
          };
          vault_key_id: string;
          vault_key_wrapped_by_kek: string;
          x25519_public: string;
          ed25519_public: string;
          private_keys_wrapped: string;
          recovery_keys: Array<{
            slot: number;
            display: string;
            lookup_hash: string;
            wrap: string;
          }>;
        }>;
        reloadVaultMeta: () => Promise<unknown>;
      };
    };

    const bridge = win.__engramVaultTestBridge;
    const { opGeneration } = bridge.beginOp();
    const created = await bridge.createVault({
      passphrase: pp,
      opGeneration,
    });

    let csrf: string | null = null;
    for (const part of document.cookie.split(';')) {
      const trimmed = part.trim();
      if (trimmed.startsWith('sabk_csrf=')) {
        csrf = decodeURIComponent(trimmed.slice('sabk_csrf='.length));
        break;
      }
    }

    const res = await fetch('/api/v1/vault', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      },
      body: JSON.stringify({
        vault_key_id: created.vault_key_id,
        kdf: created.kdf,
        vault_key_wrapped_by_kek: created.vault_key_wrapped_by_kek,
        x25519_public: created.x25519_public,
        ed25519_public: created.ed25519_public,
        private_keys_wrapped: created.private_keys_wrapped,
        recovery_keys: created.recovery_keys.map((rk) => ({
          slot: rk.slot,
          lookup_hash: rk.lookup_hash,
          wrap: rk.wrap,
        })),
      }),
    });
    if (!res.ok && res.status !== 409) {
      throw new Error(`POST /api/v1/vault failed with status ${res.status}`);
    }

    await bridge.reloadVaultMeta();
  }, passphrase);
}

async function unlockExistingVaultViaBridge(page: Page, passphrase = INITIAL_VAULT_PASSPHRASE) {
  await waitForVaultBridgeReady(page);

  await page.evaluate(async (pp) => {
    const win = window as unknown as {
      __engramVaultTestBridge: {
        beginOp: () => { opGeneration: number };
        reloadVaultMeta: () => Promise<{
          kdf: {
            alg: 'argon2id13';
            ops: number;
            mem: number;
            parallelism: 1;
            salt: string;
          };
          vault_key_wrapped_by_kek: string;
          private_keys_wrapped: string;
        } | null>;
        unlockPassphrase: (params: {
          passphrase: string;
          kdf: {
            alg: 'argon2id13';
            ops: number;
            mem: number;
            parallelism: 1;
            salt: string;
          };
          vaultKeyWrappedByKek: string;
          privateKeysWrapped: string;
          opGeneration: number;
        }) => Promise<unknown>;
      };
    };

    const bridge = win.__engramVaultTestBridge;
    const { opGeneration } = bridge.beginOp();
    const meta = await bridge.reloadVaultMeta();
    if (!meta) {
      throw new Error('Expected GET /api/v1/vault metadata to exist');
    }
    await bridge.unlockPassphrase({
      passphrase: pp,
      kdf: meta.kdf,
      vaultKeyWrappedByKek: meta.vault_key_wrapped_by_kek,
      privateKeysWrapped: meta.private_keys_wrapped,
      opGeneration,
    });
  }, passphrase);
}

async function signupAndOpenUnlockedSettings(page: Page, emailPrefix: string) {
  const email = uniqueEmail(emailPrefix);
  await signupViaUiSecret(page, email, PASSWORD);
  if (verifyRequired()) {
    const mail = await waitForMail(email, 'verify_email');
    await confirmEmailToken(page, tokenFromLink(mail.link));
  }
  await expectSignedIn(page);
  await page.goto('/app/settings', { waitUntil: 'domcontentloaded', timeout: UI_WAIT_MS });
  await createAndUnlockVaultViaBridge(page, INITIAL_VAULT_PASSPHRASE);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: UI_WAIT_MS });
  await unlockExistingVaultViaBridge(page, INITIAL_VAULT_PASSPHRASE);
  await expectVaultOpen(page);
  await gotoSettings(page);
  return email;
}

test.describe('P03-T20B Settings passkey list and auto-lock E2E (real API)', () => {
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  test("20B: another user's passkey id rejected + list add + rename round trip in the UI", async ({
    browser,
  }) => {
    test.setTimeout(FLOW_TIMEOUT_MS);

    const ctxA = await newContext(browser);
    const ctxB = await newContext(browser);
    try {
      const pageA = await ctxA.newPage();
      const cdpA = await enableWebAuthn(pageA);
      await addAuthenticator(cdpA, { hasPrf: true, isUserVerified: true });

      await signupAndOpenUnlockedSettings(pageA, 't20b-user-a');

      // Empty state before registration
      await expect(pageA.getByTestId('settings-passkey-empty')).toBeVisible({ timeout: UI_WAIT_MS });

      // Add a passkey via the UI
      await openAddPasskeyDialog(pageA);
      await submitPasskeyName(pageA, 'User A Primary Key');
      await expectPasskeyAdded(pageA);

      const listA = pageA.getByTestId('settings-passkey-list');
      await expect(listA).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(listA).toContainText('User A Primary Key');

      // Read user A's passkey id from the real API
      const listBodyA = await pageA.evaluate(async () => {
        const res = await fetch('/api/v1/vault/passkeys', { credentials: 'same-origin' });
        return (await res.json()) as { items: Array<{ id: string; name: string }> };
      });
      expect(listBodyA.items).toHaveLength(1);
      const passkeyIdA = listBodyA.items[0]!.id;

      // Rename round trip in the UI
      await pageA.getByTestId(`settings-passkey-rename-${passkeyIdA}`).click();
      const renameInput = pageA.getByTestId(`settings-passkey-rename-input-${passkeyIdA}`);
      await expect(renameInput).toBeVisible({ timeout: UI_WAIT_MS });
      await renameInput.fill('User A Renamed Key');
      await pageA.getByTestId(`settings-passkey-rename-save-${passkeyIdA}`).click();
      await expect(pageA.getByTestId(`settings-passkey-name-${passkeyIdA}`)).toHaveText('User A Renamed Key', {
        timeout: UI_WAIT_MS,
      });
      await expect(pageA.getByTestId('settings-passkey-status')).toHaveText('Passkey renamed.');

      // User B in a separate context and session tries to rename and DELETE user A's passkey id through the real API
      const pageB = await ctxB.newPage();
      await signupAndOpenUnlockedSettings(pageB, 't20b-user-b');

      const attackResult = await pageB.evaluate(
        async ({ targetId, pwd }) => {
          let csrf: string | null = null;
          for (const part of document.cookie.split(';')) {
            const trimmed = part.trim();
            if (trimmed.startsWith('sabk_csrf=')) {
              csrf = decodeURIComponent(trimmed.slice('sabk_csrf='.length));
              break;
            }
          }
          const headers: Record<string, string> = {
            accept: 'application/json',
            'content-type': 'application/json',
            ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          };

          const renameRes = await fetch(`/api/v1/vault/passkeys/${encodeURIComponent(targetId)}`, {
            method: 'PATCH',
            credentials: 'same-origin',
            headers,
            body: JSON.stringify({ name: 'Hijacked Name' }),
          });
          const renameBody = (await renameRes.json().catch(() => null)) as { code?: string } | null;

          const reauthRes = await fetch('/api/v1/auth/reauth', {
            method: 'POST',
            credentials: 'same-origin',
            headers,
            body: JSON.stringify({ action: 'vault.passkey_revoke', password: pwd }),
          });
          const grantBody = (await reauthRes.json()) as { grant: string };

          const deleteHeaders: Record<string, string> = {
            accept: 'application/json',
            'X-Reauth-Token': grantBody.grant,
            ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          };
          const deleteRes = await fetch(`/api/v1/vault/passkeys/${encodeURIComponent(targetId)}`, {
            method: 'DELETE',
            credentials: 'same-origin',
            headers: deleteHeaders,
          });
          const deleteBody = (await deleteRes.json().catch(() => null)) as { code?: string } | null;

          return {
            renameStatus: renameRes.status,
            renameCode: renameBody?.code ?? null,
            deleteStatus: deleteRes.status,
            deleteCode: deleteBody?.code ?? null,
          };
        },
        { targetId: passkeyIdA, pwd: PASSWORD },
      );

      expect(attackResult.renameStatus).toBe(404);
      expect(attackResult.renameCode).toBe('passkey_not_found');
      expect(attackResult.deleteStatus).toBe(404);
      expect(attackResult.deleteCode).toBe('passkey_not_found');

      // User A's passkey list is unchanged on the server and after reload in the UI
      await pageA.reload({ waitUntil: 'domcontentloaded', timeout: UI_WAIT_MS });
      await unlockExistingVaultViaBridge(pageA, INITIAL_VAULT_PASSPHRASE);
      await gotoSettings(pageA);
      await expect(pageA.getByTestId(`settings-passkey-name-${passkeyIdA}`)).toHaveText('User A Renamed Key', {
        timeout: UI_WAIT_MS,
      });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('20B: revoke lost response then retry does not report an error', async ({ page }) => {
    test.setTimeout(FLOW_TIMEOUT_MS);

    const cdp = await enableWebAuthn(page);
    await addAuthenticator(cdp, { hasPrf: true, isUserVerified: true });

    await signupAndOpenUnlockedSettings(page, 't20b-revoke-retry');

    await openAddPasskeyDialog(page);
    await submitPasskeyName(page, 'Retry Revoke Key');
    await expectPasskeyAdded(page);

    const listBody = await page.evaluate(async () => {
      const res = await fetch('/api/v1/vault/passkeys', { credentials: 'same-origin' });
      return (await res.json()) as { items: Array<{ id: string; name: string }> };
    });
    expect(listBody.items).toHaveLength(1);
    const passkeyId = listBody.items[0]!.id;

    // Deliberately drop the response of the FIRST DELETE after it reaches the real server and commits
    let deleteAttempts = 0;
    await page.route(
      (url) => new URL(url.toString()).pathname === `/api/v1/vault/passkeys/${passkeyId}`,
      async (route) => {
        if (route.request().method() !== 'DELETE') {
          await route.continue();
          return;
        }
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          const realResponse = await route.fetch();
          expect(realResponse.status()).toBe(204);
          await route.abort('failed');
          return;
        }
        await route.continue();
      },
    );

    await page.getByTestId(`settings-passkey-revoke-${passkeyId}`).click();
    const revokeDialog = page.locator('#passkeyRevokeDlg');
    await expect(revokeDialog).toBeVisible({ timeout: UI_WAIT_MS });

    const pwdField = revokeDialog.getByLabel('Login password');
    const confirmBtn = revokeDialog.getByTestId('settings-passkey-revoke-confirm');
    await expect(pwdField.or(confirmBtn).first()).toBeVisible({ timeout: UI_WAIT_MS });
    if (await pwdField.isVisible()) {
      await fillSecret(pwdField, PASSWORD, UI_WAIT_MS);
    }

    const secondDeleteResponse = page.waitForResponse(
      (r) =>
        r.request().method() === 'DELETE' &&
        new URL(r.url()).pathname === `/api/v1/vault/passkeys/${passkeyId}` &&
        r.status() === 404,
      { timeout: UI_WAIT_MS },
    );

    await revokeDialog.getByTestId('settings-passkey-revoke-confirm').click();
    await secondDeleteResponse;

    expect(deleteAttempts).toBe(2);
    await expect(page.getByTestId(`settings-passkey-row-${passkeyId}`)).toHaveCount(0, { timeout: UI_WAIT_MS });
    await expect(page.getByTestId('settings-passkey-empty')).toBeVisible({ timeout: UI_WAIT_MS });
    await expect(page.getByTestId('settings-passkey-error')).toHaveCount(0);
    await expect(page.getByTestId('settings-passkey-status')).toHaveText('Passkey removed.');
  });

  test('20B: auto-lock change propagates to other tabs', async ({ browser }) => {
    test.setTimeout(FLOW_TIMEOUT_MS);

    const context = await newContext(browser);
    try {
      const pageA = await context.newPage();
      await signupAndOpenUnlockedSettings(pageA, 't20b-autolock-tabs');

      const pageB = await context.newPage();
      await pageB.goto('/app/settings', { waitUntil: 'domcontentloaded', timeout: UI_WAIT_MS });
      await unlockExistingVaultViaBridge(pageB, INITIAL_VAULT_PASSPHRASE);
      await expectVaultOpen(pageB);

      const cardA = pageA.getByTestId('settings-auto-lock-card');
      const cardB = pageB.getByTestId('settings-auto-lock-card');
      await expect(cardA).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(cardB).toBeVisible({ timeout: UI_WAIT_MS });

      // Both pages start at default 15 min
      await expect(cardA.getByRole('radio', { name: '15 min', exact: true })).toHaveAttribute('data-state', 'on');
      await expect(cardB.getByRole('radio', { name: '15 min', exact: true })).toHaveAttribute('data-state', 'on');

      // Change to 5 min in page A -> page B's selector and Me update
      const patch5 = pageA.waitForResponse(
        (r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === '/api/v1/me/settings',
        { timeout: UI_WAIT_MS },
      );
      await cardA.getByRole('radio', { name: '5 min', exact: true }).click();
      expect((await patch5).status()).toBe(200);

      await expect(cardA.getByRole('radio', { name: '5 min', exact: true })).toHaveAttribute('data-state', 'on', {
        timeout: UI_WAIT_MS,
      });
      await expect(cardB.getByRole('radio', { name: '5 min', exact: true })).toHaveAttribute('data-state', 'on', {
        timeout: UI_WAIT_MS,
      });

      const meAfter5 = (await fetchMeViaPage(pageB)).body as { settings?: { auto_lock_minutes?: number } };
      expect(meAfter5.settings?.auto_lock_minutes).toBe(5);

      // Change to Never (0) in page A -> page B's selector and Me update
      const patchNever = pageA.waitForResponse(
        (r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === '/api/v1/me/settings',
        { timeout: UI_WAIT_MS },
      );
      await cardA.getByRole('radio', { name: 'Never', exact: true }).click();
      expect((await patchNever).status()).toBe(200);

      await expect(cardA.getByRole('radio', { name: 'Never', exact: true })).toHaveAttribute('data-state', 'on', {
        timeout: UI_WAIT_MS,
      });
      await expect(cardB.getByRole('radio', { name: 'Never', exact: true })).toHaveAttribute('data-state', 'on', {
        timeout: UI_WAIT_MS,
      });
      const meAfterNever = (await fetchMeViaPage(pageB)).body as { settings?: { auto_lock_minutes?: number } };
      expect(meAfterNever.settings?.auto_lock_minutes).toBe(0);
    } finally {
      await context.close();
    }
  });
});
