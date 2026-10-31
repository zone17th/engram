import { expect, type BrowserContext, type CDPSession, type Locator, type Page, type Response } from '@playwright/test';
import {
  PASSWORD,
  completeFakeOAuth,
  expectSignedIn,
  isolateRateLimit,
  waitForOAuthProviders,
  waitForAuthPageReady,
} from './helpers';
import { fillSecret } from './vault-settings-secret';

// Shared helpers of the passkey (P03-T19) real-API specs: vault-passkey.spec.ts and vault-passkey-visual.spec.ts.
// Nothing here stubs /api/v1/vault* or /api/v1/auth*; the browser talks to the compose stack's real API.
//
// Secrets: the vault passphrase and the login password are written with fillSecret() only (never locator.fill()).
// The recovery key shown by onboarding is never read, asserted on or captured. The PRF output never leaves the page:
// the probe below records booleans about its shape and nothing else.

export const VAULT_PASSPHRASE = 'Tràm-Hương-94!Kỷ-Vật-Xanh';
export const FLOW_TIMEOUT_MS = 420_000;
export const CRYPTO_WAIT_MS = 90_000;
export const UI_WAIT_MS = 30_000;

export const isApiPost = (response: Response, pathname: string) =>
  response.request().method() === 'POST' && new URL(response.url()).pathname === pathname;

export const isApiGet = (response: Response, pathname: string) =>
  response.request().method() === 'GET' && new URL(response.url()).pathname === pathname;

export async function expectVaultOpen(page: Page) {
  await expect(page.locator('.vault-pill').first()).toHaveClass(/vault-open/, { timeout: CRYPTO_WAIT_MS });
}

export async function expectVaultShut(page: Page) {
  await expect(page.locator('.vault-pill').first()).toHaveClass(/vault-shut/, { timeout: UI_WAIT_MS });
}

export async function expectOnUnlockPage(page: Page) {
  await expect(page).toHaveURL(/\/app\/unlock$/, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('vault-unlock-page')).toBeVisible({ timeout: UI_WAIT_MS });
  await expectVaultShut(page);
}

/**
 * Header lock control: the desktop pill button from `sm` up, the round button below it. Settings is left through its
 * Done link first so locking lands on `/app`; under U5 (`advisor-dec-048`), `/app` stays on the locked list and
 * reveals `vault-locked-banner`, whose `vault-locked-unlock-cta` opens plain `/app/unlock` (no `returnTo`).
 */
export async function lockVault(page: Page) {
  if (/\/app\/settings$/.test(page.url())) {
    await page.getByRole('link', { name: 'Done', exact: true }).click();
    await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
  }
  await page.locator('[data-testid^="vault-lock-button"]:visible').first().click();
  await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
  await expectVaultShut(page);
  await page.getByTestId('vault-locked-unlock-cta').click();
  await expectOnUnlockPage(page);
}

export async function unlockWithPassphrase(page: Page) {
  await fillSecret(page.getByTestId('unlock-passphrase-input'), VAULT_PASSPHRASE, CRYPTO_WAIT_MS);
  await page.getByTestId('unlock-submit-button').click();
  await expect(page).toHaveURL(/\/app$/, { timeout: CRYPTO_WAIT_MS });
  await expectVaultOpen(page);
}

async function assertNotRateLimited(page: Page) {
  const alert = page.getByTestId('auth-error-card');
  if (!(await alert.isVisible().catch(() => false))) return;
  const text = await alert.innerText();
  if (/too many attempts|thử quá nhiều|rate_limited/i.test(text)) {
    throw new Error(`rate-limited during auth helper: ${text}`);
  }
}

/**
 * Real UI signup that fills the login password via `fillSecret` (never `locator.fill`), so an actionability timeout
 * can never echo the password into the public CI list-reporter log (PKW-R2-2, advisor-dec-045).
 */
export async function signupViaUiSecret(page: Page, email: string, password = PASSWORD) {
  await isolateRateLimit(page);
  await page.goto('/app/auth/signup');
  await waitForAuthPageReady(page);
  await page.getByLabel('Email').fill(email);
  await fillSecret(page.getByLabel(/Login password|Mật khẩu đăng nhập/), password, UI_WAIT_MS);
  await page.getByRole('checkbox', { name: /agree|terms|điều khoản/i }).check();
  await page.getByRole('button', { name: /Create account|Tạo tài khoản/ }).click();
  const outcome = await Promise.race([
    page.waitForURL(/\/app\/(onboarding|auth\/verify-email)/, { timeout: UI_WAIT_MS }).then(() => 'ok' as const),
    page.getByTestId('auth-error-card').waitFor({ state: 'visible', timeout: UI_WAIT_MS }).then(() => 'err' as const),
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

async function completeOnboardingCreateVault(page: Page) {
  await expect(page).toHaveURL(/\/app\/onboarding$/, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('onboarding-step-passphrase')).toBeVisible({ timeout: CRYPTO_WAIT_MS });

  await fillSecret(page.getByLabel('Passphrase', { exact: true }), VAULT_PASSPHRASE, CRYPTO_WAIT_MS);
  await fillSecret(page.getByLabel('Confirm passphrase'), VAULT_PASSPHRASE, CRYPTO_WAIT_MS);
  await page.getByTestId('onboarding-continue-button').click();
  await expect(page.getByTestId('onboarding-step-recovery-keys')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
  await page.getByTestId('recovery-keys-confirm-checkbox').check();
  const created = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault'), { timeout: CRYPTO_WAIT_MS });
  await page.getByTestId('onboarding-create-vault-button').click();
  expect((await created).ok()).toBe(true);
  await page.getByTestId('onboarding-skip-passkey-button').click({ timeout: UI_WAIT_MS });
  await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
  await expectVaultOpen(page);
}

/** Real signup, then onboarding creates a real vault (POST /vault). Ends unlocked on /app. */
export async function signupAndCreateVault(page: Page, emailPrefix: string, uniqueEmail: (prefix: string) => string) {
  const email = uniqueEmail(emailPrefix);
  await signupViaUiSecret(page, email, PASSWORD);
  await completeOnboardingCreateVault(page);
  return email;
}

/**
 * Real OAuth-only signup via the compose stack's fake Google provider (`AUTH_FAKE_OAUTH=true`), then onboarding
 * creates a real vault (`POST /vault`). Ends unlocked on `/app`.
 */
export async function oauthSignupAndCreateVault(
  page: Page,
  emailPrefix: string,
  uniqueEmail: (prefix: string) => string,
): Promise<{ email: string; subject: string }> {
  const email = uniqueEmail(emailPrefix);
  const subject = `sub-${email}`;
  await isolateRateLimit(page);
  await page.goto('/app/auth/login');
  await waitForOAuthProviders(page);
  await page.getByRole('link', { name: /Continue with Google|Tiếp tục với Google/ }).click();
  await completeFakeOAuth(page, { email, subject });
  await page.waitForURL(/\/app\/(onboarding|auth\/callback)/, { timeout: UI_WAIT_MS });
  await expectSignedIn(page);
  await completeOnboardingCreateVault(page);
  return { email, subject };
}

// ---- Chrome virtual authenticator (CDP WebAuthn domain) ----------------------------------------------------------

export interface VirtualAuthenticatorOptions {
  /** WebAuthn PRF (hmac-secret) support. */
  hasPrf: boolean;
  /** Whether user verification succeeds; false makes a `userVerification: required` prompt fail. */
  isUserVerified?: boolean;
}

export async function enableWebAuthn(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  return cdp;
}

export async function addAuthenticator(cdp: CDPSession, options: VirtualAuthenticatorOptions): Promise<string> {
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: options.isUserVerified ?? true,
      hasPrf: options.hasPrf,
      automaticPresenceSimulation: true,
    },
  });
  return authenticatorId;
}

export async function removeAuthenticator(cdp: CDPSession, authenticatorId: string) {
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
}

export async function setUserVerified(cdp: CDPSession, authenticatorId: string, isUserVerified: boolean) {
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified });
}

// ---- WebAuthn probe ----------------------------------------------------------------------------------------------

export interface ProbeEntry {
  /** DOMException name when the call rejected, else null. */
  error: string | null;
  /** `prf.enabled` of the client extension results (create() only); null when absent. */
  prfEnabled: boolean | null;
  /** True when `prf.results.first` came back. The bytes are never copied. */
  prfFirst: boolean;
}

export interface PasskeyProbe {
  creates: ProbeEntry[];
  gets: ProbeEntry[];
}

declare global {
  interface Window {
    __passkeyProbe?: PasskeyProbe;
  }
}

/**
 * Wraps navigator.credentials.create/get in every page of the context to record the SHAPE of each call's outcome
 * (error name, prf.enabled, whether prf.results.first exists). It passes the original result through untouched and
 * never reads the PRF bytes, so the specs can tell "PRF output directly at create()" from "enabled, then get()".
 */
export async function installPasskeyProbe(context: BrowserContext) {
  await context.addInitScript(() => {
    const container = navigator.credentials;
    if (!container) return;
    const probe: PasskeyProbe = { creates: [], gets: [] };
    window.__passkeyProbe = probe;

    const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'Error');
    const shape = (credential: Credential | null): ProbeEntry => {
      const prf = credential instanceof PublicKeyCredential ? credential.getClientExtensionResults().prf : undefined;
      return {
        error: null,
        prfEnabled: typeof prf?.enabled === 'boolean' ? prf.enabled : null,
        prfFirst: prf?.results?.first !== undefined,
      };
    };

    const originalCreate = container.create.bind(container);
    const originalGet = container.get.bind(container);
    container.create = async (options?: CredentialCreationOptions) => {
      try {
        const credential = await originalCreate(options);
        probe.creates.push(shape(credential));
        return credential;
      } catch (error) {
        probe.creates.push({ error: errorName(error), prfEnabled: null, prfFirst: false });
        throw error;
      }
    };
    container.get = async (options?: CredentialRequestOptions) => {
      try {
        const credential = await originalGet(options);
        probe.gets.push(shape(credential));
        return credential;
      } catch (error) {
        probe.gets.push({ error: errorName(error), prfEnabled: null, prfFirst: false });
        throw error;
      }
    };
  });
}

export async function readProbe(page: Page): Promise<PasskeyProbe> {
  return page.evaluate(() => {
    const probe = window.__passkeyProbe;
    return probe ? { creates: [...probe.creates], gets: [...probe.gets] } : { creates: [], gets: [] };
  });
}

// ---- Settings: Add passkey ---------------------------------------------------------------------------------------

export async function gotoSettings(page: Page) {
  if (!/\/app\/settings$/.test(page.url())) {
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(/\/app\/settings$/, { timeout: UI_WAIT_MS });
  }
  await expect(page.getByTestId('settings-passkey-card')).toBeVisible({ timeout: CRYPTO_WAIT_MS });
}

export function addDialog(page: Page): Locator {
  return page.locator('#passkeyAddDlg');
}

/**
 * Presses Add passkey and brings the dialog to its name step: the grant is taken when the dialog opens, so a password
 * user re-authenticates in place first (the committed helpers PASSWORD, via fillSecret) unless a usable grant exists.
 */
export async function openAddPasskeyDialog(page: Page) {
  await page.getByTestId('settings-passkey-card').getByRole('button', { name: 'Add passkey' }).click();
  const dialog = addDialog(page);
  await expect(dialog).toBeVisible({ timeout: UI_WAIT_MS });

  const password = dialog.getByLabel('Login password');
  const continueButton = dialog.getByRole('button', { name: 'Continue' });
  await expect(password.or(continueButton.and(page.locator(':enabled'))).first()).toBeVisible({
    timeout: UI_WAIT_MS,
  });
  if (await password.isVisible()) {
    const reauthed = page.waitForResponse((r) => isApiPost(r, '/api/v1/auth/reauth'), { timeout: UI_WAIT_MS });
    await fillSecret(password, PASSWORD);
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
    expect((await reauthed).ok()).toBe(true);
  }
  await expect(continueButton).toBeEnabled({ timeout: UI_WAIT_MS });
  return dialog;
}

/**
 * Acquires a real `vault.passkey_register` grant via the OAuth re-auth flow for an OAuth-only user: opens the dialog,
 * clicks `Confirm with Google` (`auth.reauth.google`), completes the fake OAuth redirect (`status=reauth_ready` ->
 * `POST /auth/reauth`), follows the Settings locked-state banner (`vault-security-locked-banner`) to unlock on
 * `/app/unlock?returnTo=%2Fapp%2Fsettings`, and re-opens the Add-passkey dialog at its name step.
 */
export async function acquireOauthPasskeyGrantAndOpenDialog(
  page: Page,
  identity: { email: string; subject: string },
): Promise<{ dialog: Locator; expiresAtMs: number }> {
  await gotoSettings(page);
  await page.getByTestId('settings-passkey-card').getByRole('button', { name: 'Add passkey' }).click();
  const dialog = addDialog(page);
  await expect(dialog).toBeVisible({ timeout: UI_WAIT_MS });
  const googleButton = dialog.getByRole('button', { name: /Confirm with Google|Xác nhận bằng Google/ });
  await expect(googleButton).toBeVisible({ timeout: UI_WAIT_MS });

  const reauthResponsePromise = page.waitForResponse((r) => isApiPost(r, '/api/v1/auth/reauth'), {
    timeout: UI_WAIT_MS,
  });
  await googleButton.click();
  await completeFakeOAuth(page, { email: identity.email, subject: identity.subject });
  const reauthResponse = await reauthResponsePromise;
  expect(reauthResponse.ok()).toBe(true);
  const grantBody = (await reauthResponse.json()) as { expires_at: string };
  const expiresAtMs = Date.parse(grantBody.expires_at);
  expect(Number.isFinite(expiresAtMs)).toBe(true);

  // The full-page OAuth redirect destroyed the Worker; RouteGuard allows /app/settings while locked and
  // VaultSecurityPanel renders vault-security-locked-banner with its link to /app/unlock?returnTo=%2Fapp%2Fsettings.
  await expect(page).toHaveURL(/\/app\/settings$/, { timeout: UI_WAIT_MS });
  await expectVaultShut(page);
  const lockedBanner = page.getByTestId('vault-security-locked-banner');
  await expect(lockedBanner).toBeVisible({ timeout: UI_WAIT_MS });
  await lockedBanner.getByRole('link').click();
  await expect(page).toHaveURL(/\/app\/unlock\?returnTo=%2Fapp%2Fsettings$/, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('vault-unlock-page')).toBeVisible({ timeout: UI_WAIT_MS });
  await fillSecret(page.getByTestId('unlock-passphrase-input'), VAULT_PASSPHRASE, CRYPTO_WAIT_MS);
  await page.getByTestId('unlock-submit-button').click();
  await expect(page).toHaveURL(/\/app\/settings$/, { timeout: CRYPTO_WAIT_MS });
  await expectVaultOpen(page);
  await expect(page.getByTestId('settings-passkey-card')).toBeVisible({ timeout: CRYPTO_WAIT_MS });

  await page.getByTestId('settings-passkey-card').getByRole('button', { name: 'Add passkey' }).click();
  await expect(dialog).toBeVisible({ timeout: UI_WAIT_MS });
  await expect(dialog.getByLabel('Login password')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /Confirm with Google|Xác nhận bằng Google/ })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Continue' })).toBeEnabled({ timeout: UI_WAIT_MS });
  return { dialog, expiresAtMs };
}

/** Names the credential and presses Continue; the outcome is asserted by the caller. */
export async function submitPasskeyName(page: Page, name: string) {
  const dialog = addDialog(page);
  await dialog.getByLabel('Passkey name').fill(name);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  return dialog;
}

export async function expectPasskeyAdded(page: Page) {
  const dialog = addDialog(page);
  const alert = dialog.getByRole('alert');
  const outcome = await Promise.race([
    dialog.waitFor({ state: 'hidden', timeout: CRYPTO_WAIT_MS }).then(() => 'hidden' as const),
    alert.waitFor({ state: 'visible', timeout: CRYPTO_WAIT_MS }).then(() => 'alert' as const),
  ]).catch(() => 'timeout' as const);

  if (outcome !== 'hidden') {
    const alertText = (await alert.isVisible().catch(() => false))
      ? (await alert.innerText().catch(() => '')).trim()
      : '';
    const statusText = (await dialog.getByRole('status').isVisible().catch(() => false))
      ? (await dialog.getByRole('status').innerText().catch(() => '')).trim()
      : '';
    const probe = await readProbe(page).catch(() => ({ creates: [], gets: [] }));
    throw new Error(
      `expectPasskeyAdded failed (${outcome}): alert=${JSON.stringify(alertText)} status=${JSON.stringify(statusText)} probe=${JSON.stringify(probe)}`,
    );
  }

  await expect(dialog).toBeHidden({ timeout: UI_WAIT_MS });
  await expect(page.getByTestId('settings-passkey-added')).toBeVisible({ timeout: UI_WAIT_MS });
}
