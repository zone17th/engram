import { expect, type BrowserContext, type CDPSession, type Locator, type Page, type Response } from '@playwright/test';
import { PASSWORD, isolateRateLimit, waitForAuthPageReady } from './helpers';
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
 * Done link first so the unlock screen is reached at plain /app/unlock (no returnTo) and unlocks land on /app.
 */
export async function lockVault(page: Page) {
  if (/\/app\/settings$/.test(page.url())) {
    await page.getByRole('link', { name: 'Done', exact: true }).click();
    await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
  }
  await page.locator('[data-testid^="vault-lock-button"]:visible').first().click();
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

/** Real signup, then onboarding creates a real vault (POST /vault). Ends unlocked on /app. */
export async function signupAndCreateVault(page: Page, emailPrefix: string, uniqueEmail: (prefix: string) => string) {
  const email = uniqueEmail(emailPrefix);
  await signupViaUiSecret(page, email, PASSWORD);
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
  await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
  await expectVaultOpen(page);
  return email;
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

/** Names the credential and presses Continue; the outcome is asserted by the caller. */
export async function submitPasskeyName(page: Page, name: string) {
  const dialog = addDialog(page);
  await dialog.getByLabel('Passkey name').fill(name);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  return dialog;
}

export async function expectPasskeyAdded(page: Page) {
  await expect(addDialog(page)).toBeHidden({ timeout: CRYPTO_WAIT_MS });
  await expect(page.getByTestId('settings-passkey-added')).toBeVisible({ timeout: UI_WAIT_MS });
}
