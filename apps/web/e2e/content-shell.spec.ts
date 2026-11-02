import { expect, test } from '@playwright/test';
import { uniqueEmail } from './helpers';
import { VAULT_PASSPHRASE } from './vault-passkey-support';
import { createVaultViaOnboarding, expectUnlockedOnApp, signupPasswordUser } from './vault-journey-support';

// Disable Playwright's automatic error-context DOM snapshot in this worker before any test runs,
// so a failure while a recovery-key sheet is mounted can never serialize plaintext recovery keys to disk.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

const SHELL_TIMEOUT_MS = 240_000;
const UI_WAIT_MS = 30_000;

test.describe('P04-T11 content shell skeleton', () => {
  test.skip(!process.env.E2E_STACK, 'needs the compose stack (E2E_STACK=1): real API, real database');

  test('signs up, completes onboarding, and renders /app shell with content flag enabled', async ({ page }) => {
    test.setTimeout(SHELL_TIMEOUT_MS);
    // Build-time proof for NEXT_PUBLIC_CONTENT_ENABLED is enforced by scripts/e2e-infra.test.mjs
    // until W3 renders a flag-dependent element on /app (calling contentEnabled() here would only
    // read the Playwright runner's process.env, not the Next bundle built into the container).

    const email = uniqueEmail('content-shell');
    await signupPasswordUser(page, email);
    await createVaultViaOnboarding(page, VAULT_PASSPHRASE, { kind: 'skip' });
    await expectUnlockedOnApp(page);

    await expect(page.locator('main')).toBeVisible({ timeout: UI_WAIT_MS });
    await expect(page.getByRole('textbox', { name: 'Search or save' })).toBeVisible({ timeout: UI_WAIT_MS });
  });
});
