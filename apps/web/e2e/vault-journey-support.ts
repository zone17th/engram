import { expect, test, type Page, type Response } from '@playwright/test';
import {
  PASSWORD,
  completeFakeOAuth,
  expectSignedIn,
  isolateRateLimit,
  tokenFromLink,
  verifyRequired,
  waitForAuthPageReady,
  waitForMail,
  waitForOAuthProviders,
} from './helpers';
import {
  CRYPTO_WAIT_MS,
  UI_WAIT_MS,
  addDialog,
  expectOnUnlockPage,
  expectVaultOpen,
  expectVaultShut,
  isApiGet,
  isApiPost,
  signupViaUiSecret,
} from './vault-passkey-support';
import { fillSecret } from './vault-settings-secret';

// Helpers of the P03-T23 vault journey (vault-journey.spec.ts, stage J1 + J2). Nothing here stubs /api/**: every request
// goes to the compose stack's real API, through the same-origin Next proxy. Copies of patterns from the accepted specs
// live here on purpose (the originals are owned by closed lanes); each copy names its source.
//
// Secrets: the vault passphrases, the login password, the recovery keys, the grant token and the DevKey never leave a
// local variable. Every secret field is written with fillSecret() (never locator.fill()); recovery keys are only
// compared through boolean expectations so a failing assertion cannot print one; nothing here logs a secret or takes a
// screenshot.

/** Every recovery key the app shows has this shape (copied from vault-real-api.spec.ts). */
const RECOVERY_KEY_SHAPE = /^rk\d{1,2}_[0-7][0-9A-TV-Z]{3}(?:-[0-9A-TV-Z]{4}){5}-[0-9A-TV-Z]{2}$/;
/** Same family as vault-settings.spec.ts R3-5: any RK-looking text in the visible DOM. */
const RECOVERY_KEY_IN_DOM = /rk\d+_[0-9A-Z]{4}-[0-9A-Z]{4}/;

export const REWRAPPED_PASSPHRASE = 'updated-horse-battery-staple-gn-v2!';
export const RECOVERED_PASSPHRASE = 'Zk7$vQm2-Rn9&Tp4w-Lx8#Bd5y';

/**
 * test.step plus one console line, so the raw Actions log (list reporter) names every journey step. The name is a
 * fixed literal of the spec, never data.
 */
export async function journeyStep<T>(name: string, body: () => Promise<T>): Promise<T> {
  console.log(`journey-step: ${name}`);
  return test.step(name, body);
}

/** A fresh untrusted client hop (own 5/min credential bucket) for the next re-auth-heavy step (helpers.isolateRateLimit). */
export async function freshRateBucket(page: Page) {
  await isolateRateLimit(page);
}

// ---- Signup and email verification ---------------------------------------------------------------------------------

/**
 * Under AUTH_REQUIRE_EMAIL_VERIFICATION=true signup lands on /app/auth/verify-email: resend the mail, read it from the
 * mail sink and confirm the token. A no-op when verification is not required.
 *
 * JR1-5/JR1-6: the token never enters a `page.goto()` URL or a `toHaveURL` matcher (which would echo the token-bearing
 * URL into the public CI log on failure). We load the token-free route, set `window.location.hash` inside
 * `page.evaluate()` via an argument, and poll a boolean (`!window.location.hash.includes('token=')`) for fragment
 * removal by `VerifyEmailForm`'s layout effect (`features/auth/forms/verify-email-form.tsx:41-55`).
 */
export async function confirmEmailIfRequired(page: Page, email: string) {
  if (!verifyRequired()) return;
  await expect(page).toHaveURL(/\/app\/auth\/verify-email/, { timeout: UI_WAIT_MS });
  await page.goto('/app/auth/verify-email');
  await page.getByRole('button', { name: /Resend|Gửi lại/ }).click();
  const mail = await waitForMail(email, 'signup');
  const token = tokenFromLink(mail.link);
  await page.evaluate((rawToken) => {
    window.location.hash = `token=${encodeURIComponent(rawToken)}`;
  }, token);
  await expect
    .poll(() => page.evaluate(() => window.location.hash.includes('token=')), {
      timeout: UI_WAIT_MS,
    })
    .toBe(false);
  const confirmation = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/v1/auth/verify-email/confirm'),
    { timeout: UI_WAIT_MS },
  );
  await page.getByRole('button', { name: /Confirm email|Xác minh email/ }).click();
  expect((await confirmation).status()).toBe(200);
  await expect(page).toHaveURL(/\/app\/onboarding/, { timeout: UI_WAIT_MS });
}

/** Real password signup (fillSecret), plus the verification round trip when the stack requires it. */
export async function signupPasswordUser(page: Page, email: string) {
  await signupViaUiSecret(page, email, PASSWORD);
  await confirmEmailIfRequired(page, email);
  await expectSignedIn(page);
  await expect(page).toHaveURL(/\/app\/onboarding$/, { timeout: UI_WAIT_MS });
}

/**
 * Real OAuth-only signup through the compose stack's fake Google provider (AUTH_FAKE_OAUTH=true); the email arrives
 * verified from the provider. Pattern of vault-passkey-support.oauthSignupAndCreateVault, which cannot hand the
 * recovery keys back.
 */
export async function signupOauthUser(page: Page, email: string, subject: string) {
  await isolateRateLimit(page);
  await page.goto('/app/auth/login');
  await waitForOAuthProviders(page);
  await page.getByRole('link', { name: /Continue with Google|Tiếp tục với Google/ }).click();
  await completeFakeOAuth(page, { email, subject });
  await page.waitForURL(/\/app\/(onboarding|auth\/callback)/, { timeout: UI_WAIT_MS });
  await expectSignedIn(page);
  await expect(page).toHaveURL(/\/app\/onboarding$/, { timeout: UI_WAIT_MS });
}

/** Real password login with the login password written through fillSecret (copy of helpers.loginViaUi). */
export async function loginViaUiSecret(page: Page, email: string, password = PASSWORD) {
  await isolateRateLimit(page);
  await page.goto('/app/auth/login');
  await waitForAuthPageReady(page);
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
  await fillSecret(page.getByLabel(/Login password|Mật khẩu đăng nhập/), password, UI_WAIT_MS);
  const loginResponse = page.waitForResponse(
    (res) => res.request().method() === 'POST' && /\/api\/v1\/auth\/login$/.test(new URL(res.url()).pathname),
    { timeout: UI_WAIT_MS },
  );
  await page.getByRole('button', { name: /Sign in|Đăng nhập/ }).click();
  const response = await loginResponse;
  if (!response.ok()) {
    throw new Error(`login failed (${response.status()})`);
  }
  await expect(page.getByTestId('session-status')).toBeAttached({ timeout: UI_WAIT_MS });
  await expect(page.getByTestId('session-status')).toHaveText(/authenticated_/);
}

// ---- Onboarding ----------------------------------------------------------------------------------------------------

export interface OnboardingKeys {
  /** Recovery key of slot 1: the one the recovery flow consumes. */
  slot1: string;
  /** Recovery key of slot 2: never used before rotation revokes it. */
  slot2: string;
}

export async function readRecoveryKeySlot(page: Page, slot: number): Promise<string> {
  const text = ((await page.getByTestId(`recovery-key-slot-${slot}`).first().textContent()) ?? '').trim();
  // Boolean on purpose: a failing toMatch would print the key into the CI log.
  expect(RECOVERY_KEY_SHAPE.test(text)).toBe(true);
  return text;
}

export type OnboardingStep3Choice = { kind: 'skip' } | { kind: 'add-passkey'; passkeyName: string };

/**
 * Onboarding (step 1 passphrase -> step 2 10-slot recovery-key sheet -> POST /vault -> step 3 passkey/device). Reads two
 * recovery keys from step 2 into local variables, asserts step 3 renders with Remember this device default off, and
 * completes step 3 via either the SKIP path (`onboarding-skip-passkey-button`) or the ADD-PASSKEY path (`PasskeyAddEntry`
 * + `onboarding-finish-button`, pattern of `vault-b-onboarding.spec.ts`).
 */
export async function createVaultViaOnboarding(
  page: Page,
  passphrase: string,
  step3: OnboardingStep3Choice = { kind: 'skip' },
): Promise<OnboardingKeys> {
  await expect(page).toHaveURL(/\/app\/onboarding$/, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('onboarding-step-passphrase')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
  await fillSecret(page.getByLabel('Passphrase', { exact: true }), passphrase, CRYPTO_WAIT_MS);
  await fillSecret(page.getByLabel('Confirm passphrase'), passphrase, CRYPTO_WAIT_MS);
  await page.getByTestId('onboarding-continue-button').click();
  await expect(page.getByTestId('onboarding-step-recovery-keys')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
  await expect(page.getByTestId('recovery-keys-grid').getByRole('listitem')).toHaveCount(10);

  const keys: OnboardingKeys = {
    slot1: await readRecoveryKeySlot(page, 1),
    slot2: await readRecoveryKeySlot(page, 2),
  };
  expect(keys.slot1 !== keys.slot2).toBe(true);

  await page.getByTestId('recovery-keys-confirm-checkbox').check();
  const created = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault'), { timeout: CRYPTO_WAIT_MS });
  await page.getByTestId('onboarding-create-vault-button').click();
  expect((await created).status()).toBe(201);

  // Step 3 (T16B): optional passkey + Remember this device toggle (default off).
  await expect(page.getByTestId('onboarding-step-passkey')).toBeVisible({ timeout: UI_WAIT_MS });
  await expect(page.getByTestId('onboarding-remember-device-switch')).toHaveAttribute('aria-checked', 'false');
  // Recovery keys are wiped from the DOM immediately upon leaving step 2 (boolean check so no RK is ever printed).
  const step3BodyText = await page.locator('body').innerText();
  expect(step3BodyText.includes(keys.slot1) || step3BodyText.includes(keys.slot2)).toBe(false);

  if (step3.kind === 'skip') {
    await page.getByTestId('onboarding-skip-passkey-button').click();
  } else {
    await page
      .getByTestId('onboarding-passkey-card')
      .getByRole('button', { name: /Add passkey|Thêm passkey/ })
      .click();
    const dialog = addDialog(page);
    await expect(dialog).toBeVisible({ timeout: UI_WAIT_MS });

    const passwordField = dialog.getByLabel(/Login password|Mật khẩu đăng nhập/);
    const continueBtn = dialog.getByRole('button', { name: /^(Continue|Tiếp tục)$/ });
    await expect(passwordField.or(continueBtn.and(page.locator(':enabled'))).first()).toBeVisible({
      timeout: UI_WAIT_MS,
    });
    if (await passwordField.isVisible()) {
      const reauthed = page.waitForResponse((r) => isApiPost(r, '/api/v1/auth/reauth'), {
        timeout: UI_WAIT_MS,
      });
      await fillSecret(passwordField, PASSWORD, UI_WAIT_MS);
      await dialog.getByRole('button', { name: /^(Confirm|Xác nhận)$/, exact: true }).click();
      expect((await reauthed).ok()).toBe(true);
    }
    await expect(continueBtn).toBeEnabled({ timeout: UI_WAIT_MS });

    const passkeySaved = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault/passkeys'), {
      timeout: CRYPTO_WAIT_MS,
    });
    await dialog.getByLabel(/Passkey name|Tên passkey/).fill(step3.passkeyName);
    await continueBtn.click();
    expect((await passkeySaved).ok()).toBe(true);

    await expect(page.getByTestId('onboarding-passkey-added-status')).toBeVisible({ timeout: UI_WAIT_MS });
    await page.getByTestId('onboarding-finish-button').click();
  }

  await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
  await expectVaultOpen(page);
  const bodyText = await page.locator('body').innerText();
  expect(bodyText.includes(keys.slot1) || bodyText.includes(keys.slot2)).toBe(false);
  return keys;
}

// ---- Locked list and unlock ----------------------------------------------------------------------------------------

/** advisor-dec-048: a locked vault stays on /app, shows the locked banner and no entry bodies. */
export async function expectLockedListOnApp(page: Page) {
  await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
  await expect(page.locator('.vault-pill').first()).toHaveAttribute('data-vault-state', 'locked', {
    timeout: UI_WAIT_MS,
  });
  await expectVaultShut(page);
  await expect(page.getByTestId('entry-body')).toHaveCount(0);
}

export async function openUnlockFromLockedList(page: Page) {
  await page.getByTestId('vault-locked-unlock-cta').click();
  await expectOnUnlockPage(page);
}

export async function submitUnlock(page: Page, passphrase: string) {
  await fillSecret(page.getByTestId('unlock-passphrase-input'), passphrase, CRYPTO_WAIT_MS);
  await page.getByTestId('unlock-submit-button').click();
}

export async function expectUnlockedOnApp(page: Page) {
  await expect(page).toHaveURL(/\/app$/, { timeout: CRYPTO_WAIT_MS });
  await expectVaultOpen(page);
}

/** From the locked list: open the unlock page and unlock with the passphrase. */
export async function unlockFromLockedList(page: Page, passphrase: string) {
  await openUnlockFromLockedList(page);
  await submitUnlock(page, passphrase);
  await expectUnlockedOnApp(page);
}

/** A wrong passphrase is refused locally and the vault stays shut on the unlock page. */
export async function expectPassphraseRejected(page: Page, passphrase: string) {
  await submitUnlock(page, passphrase);
  await expect(page.getByTestId('unlock-error-incorrect-passphrase')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
  await expect(page).toHaveURL(/\/app\/unlock$/);
  await expectVaultShut(page);
}

/** Reloads the unlock page and waits for the real GET /vault, so the unlock uses the server's current wrap. */
export async function reloadUnlockPage(page: Page) {
  const metaLoaded = page.waitForResponse((r) => isApiGet(r, '/api/v1/vault'), { timeout: UI_WAIT_MS });
  await page.reload();
  await metaLoaded;
  await expectOnUnlockPage(page);
}

// ---- Recovery (forgot-passphrase flow) -----------------------------------------------------------------------------

export type RecoveryReauth = { kind: 'password' } | { kind: 'oauth'; email: string; subject: string };

/**
 * From the unlock page: forgot passphrase -> use recovery key -> re-authenticate (login password, or the fake Google
 * provider for an OAuth-only user) -> the enter-key step. Pattern of vault-real-api.spec.ts step 5.
 */
export async function openRecoveryFromUnlock(page: Page, reauth: RecoveryReauth) {
  await page.getByTestId('unlock-forgot-passphrase-link').click();
  await expect(page).toHaveURL(/\/app\/unlock\/forgot$/, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('forgot-passphrase-page')).toBeVisible({ timeout: UI_WAIT_MS });
  await page.getByTestId('forgot-use-recovery-key-cta').click();
  await expect(page).toHaveURL(/\/app\/recovery$/, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('recovery-step-reauth')).toBeVisible({ timeout: UI_WAIT_MS });

  const reauthed = page.waitForResponse((r) => isApiPost(r, '/api/v1/auth/reauth'), { timeout: UI_WAIT_MS });
  if (reauth.kind === 'password') {
    await fillSecret(page.getByTestId('recovery-reauth-password-input'), PASSWORD, UI_WAIT_MS);
    await page.getByTestId('recovery-reauth-password-submit').click();
  } else {
    await page.getByTestId('recovery-reauth-google-button').click();
    await completeFakeOAuth(page, { email: reauth.email, subject: reauth.subject });
  }
  expect((await reauthed).ok()).toBe(true);
  await expect(page).toHaveURL(/\/app\/recovery$/, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('recovery-step-enter-key')).toBeVisible({ timeout: UI_WAIT_MS });
}

/** Enters a recovery key and returns the real POST /vault/unlock/recovery response (the caller asserts its status). */
export async function submitRecoveryKey(page: Page, recoveryKey: string): Promise<Response> {
  const lookedUp = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault/unlock/recovery'), {
    timeout: CRYPTO_WAIT_MS,
  });
  await fillSecret(page.getByTestId('recovery-key-input'), recoveryKey, UI_WAIT_MS);
  await page.getByTestId('recovery-key-submit').click();
  return lookedUp;
}

/**
 * Reads one top-level field of a JSON response body by runtime narrowing (no assumed shape). `undefined` when the body
 * is not an object carrying the key.
 */
export async function jsonField(response: Response, key: string): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === 'object' && key in body) return body[key as keyof typeof body];
  return undefined;
}

/** `settings.auto_lock_minutes` of a /me/settings response body, or null when absent. */
export function autoLockMinutesOf(body: unknown): number | null {
  if (!body || typeof body !== 'object' || !('settings' in body)) return null;
  const settings = body.settings;
  if (!settings || typeof settings !== 'object' || !('auto_lock_minutes' in settings)) return null;
  return typeof settings.auto_lock_minutes === 'number' ? settings.auto_lock_minutes : null;
}

/**
 * After an accepted key: set the new passphrase, complete the recovery (real POST /vault/recover/complete) and skip
 * the replacement-key step. Ends unlocked on /app. Returns the vault version the server reports.
 */
export async function completeRecoveryWithNewPassphrase(page: Page, newPassphrase: string): Promise<number> {
  await expect(page.getByTestId('recovery-step-new-passphrase')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
  await fillSecret(page.getByTestId('recovery-new-passphrase-input'), newPassphrase, CRYPTO_WAIT_MS);
  await fillSecret(page.getByTestId('recovery-confirm-passphrase-input'), newPassphrase, CRYPTO_WAIT_MS);
  const completed = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault/recover/complete'), {
    timeout: CRYPTO_WAIT_MS,
  });
  await page.getByTestId('recovery-step3-submit').click();
  const response = await completed;
  expect(response.ok()).toBe(true);
  const version = await jsonField(response, 'version');

  // The consumed key's slot is empty, so the flow now offers a replacement key; the vault is already open.
  await expect(page.getByTestId('recovery-step-regenerate-reauth')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
  await expectVaultOpen(page);
  await page.getByTestId('recovery-step4-skip-button').click();
  await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
  await expectVaultOpen(page);
  if (typeof version !== 'number') throw new Error('recover/complete did not report a numeric version');
  return version;
}

// ---- Recovery keys visible in the DOM ------------------------------------------------------------------------------

/** Boolean poll so a failure never prints RK text to the CI log (vault-settings.spec.ts R3-5). */
export async function expectNoRecoveryKeyInDom(page: Page) {
  await expect
    .poll(() => page.evaluate((source) => new RegExp(source).test(document.body.innerText), RECOVERY_KEY_IN_DOM.source), {
      timeout: UI_WAIT_MS,
    })
    .toBe(false);
}

export function isRecoveryKeyShape(value: string): boolean {
  return RECOVERY_KEY_SHAPE.test(value);
}

// ---- Remember device (DevKey) and Vault observables ----------------------------------------------------------------
// In J2, Remember / Forget device is driven through the Settings UI (`settings-remember-device-switch` and
// `settings-forget-device-button`). The read-only bridges below inspect the IndexedDB record count (`snapshot()`) and
// the provider's idle timeout / state observables (`__engramVaultTestBridge`); they never expose DevKey material, VK
// or wraps.

interface DeviceBridge {
  snapshot: () => Promise<{ userRecordCount: number; allRecordCount: number }>;
}

interface VaultBridge {
  reloadVaultMeta: () => Promise<unknown>;
  autoLockMinutes: number;
  state: string;
  workerState: string;
}

type BridgeWindow = Window & {
  __engramDeviceTestBridge?: DeviceBridge;
  __engramVaultTestBridge?: VaultBridge;
};

export async function waitForDeviceBridge(page: Page) {
  await page.waitForFunction(() => {
    const bridgeWindow: BridgeWindow = window;
    return Boolean(bridgeWindow.__engramDeviceTestBridge && bridgeWindow.__engramVaultTestBridge);
  });
}
export async function deviceRecordCount(page: Page): Promise<{ userRecordCount: number; allRecordCount: number }> {
  await waitForDeviceBridge(page);
  return page.evaluate(() => (window as BridgeWindow).__engramDeviceTestBridge!.snapshot());
}

/** What the provider currently uses as idle timeout and where the Worker stands (read-only observables). */
export async function readVaultObservables(page: Page) {
  return page.evaluate(() => {
    const bridge = (window as BridgeWindow).__engramVaultTestBridge;
    return {
      autoLockMinutes: bridge?.autoLockMinutes ?? null,
      state: bridge?.state ?? null,
      workerState: bridge?.workerState ?? null,
    };
  });
}

// ---- Same-origin vault requests through the production Next proxy --------------------------------------------------
// Used for the If-Match check: the requests are plain fetch() calls of the page, so they carry the session cookies and
// the CSRF header exactly like the app's own authMutate(), and travel /api/v1/... through the Next proxy of the
// production build. No route is stubbed.

export interface VaultMetaProbe {
  status: number;
  vaultKeyId: string | null;
  version: number | null;
  recoveryKeysRemaining: number | null;
  passkeyCount: number | null;
  code: string | null;
}

export async function fetchVaultMetaViaPage(page: Page): Promise<VaultMetaProbe> {
  return page.evaluate(async () => {
    const res = await fetch('/api/v1/vault', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const text = await res.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return {
      status: res.status,
      vaultKeyId: typeof body?.vault_key_id === 'string' ? body.vault_key_id : null,
      version: typeof body?.version === 'number' ? body.version : null,
      recoveryKeysRemaining: typeof body?.recovery_keys_remaining === 'number' ? body.recovery_keys_remaining : null,
      passkeyCount: Array.isArray(body?.passkeys) ? body.passkeys.length : null,
      code: typeof body?.code === 'string' ? body.code : null,
    };
  });
}

/** Real POST /auth/reauth for one vault action; the grant token stays in a local variable. */
export async function acquireGrantViaPage(
  page: Page,
  action: string,
  password: string,
): Promise<{ status: number; grant: string | null }> {
  return page.evaluate(
    async (input) => {
      let csrf: string | null = null;
      for (const part of document.cookie.split(';')) {
        const trimmed = part.trim();
        if (trimmed.startsWith('sabk_csrf=')) {
          csrf = decodeURIComponent(trimmed.slice('sabk_csrf='.length));
          break;
        }
      }
      const res = await fetch('/api/v1/auth/reauth', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        body: JSON.stringify({ action: input.action, password: input.password }),
      });
      const parsed = (await res.json().catch(() => null)) as { grant?: unknown } | null;
      return { status: res.status, grant: typeof parsed?.grant === 'string' ? parsed.grant : null };
    },
    { action, password },
  );
}

export interface VaultDeleteProbe {
  status: number;
  code: string | null;
  currentVersion: number | null;
}

/** DELETE /api/v1/vault with an explicit If-Match, the way the Reset dialog sends it (authMutate: grant + CSRF + Idempotency-Key). */
export async function deleteVaultViaPage(
  page: Page,
  input: { grant: string; ifMatch: string },
): Promise<VaultDeleteProbe> {
  return page.evaluate(async (args) => {
    let csrf: string | null = null;
    for (const part of document.cookie.split(';')) {
      const trimmed = part.trim();
      if (trimmed.startsWith('sabk_csrf=')) {
        csrf = decodeURIComponent(trimmed.slice('sabk_csrf='.length));
        break;
      }
    }
    const res = await fetch('/api/v1/vault', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'If-Match': args.ifMatch,
        'X-Reauth-Token': args.grant,
        'Idempotency-Key': crypto.randomUUID(),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      },
    });
    const text = await res.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return {
      status: res.status,
      code: typeof body?.code === 'string' ? body.code : null,
      currentVersion: typeof body?.current_version === 'number' ? body.current_version : null,
    };
  }, input);
}
