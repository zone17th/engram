/**
 * Dev-only real-browser Crypto Worker e2e spec.
 * Requires `next dev` (`NODE_ENV !== 'production'`, where `/dev/crypto-bench` is enabled)
 * and `E2E_CRYPTO_DEV=1` (`playwright test --project crypto-dev`).
 * Not part of CI (`e2e-browser` runs against the production stack where `/dev/crypto-bench` returns 404).
 */
import { expect, test } from '@playwright/test';

interface HarnessStepResult {
  step: string;
  ok: boolean;
  state: string;
  details: Record<string, string | number | boolean>;
}

interface HarnessSummary {
  status: 'idle' | 'running' | 'done' | 'error';
  allPassed: boolean;
  steps: HarnessStepResult[];
  cspViolations: string[];
  errorMessage?: string;
  errorCode?: string;
}

test.describe('P03-T5 real-browser Crypto Worker e2e (FE1-10, BE1-22, T-5)', () => {
  test('drives real client.ts -> worker.ts in a module Worker (Turbopack blob bootstrap) with 0 CSP violations and no rendered secrets', async ({
    page,
  }) => {
    test.setTimeout(60_000);

    const consoleErrors: string[] = [];
    const cspViolations: string[] = [];

    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error') {
        consoleErrors.push(text);
      }
      if (/Content Security Policy|CSP/i.test(text)) {
        cspViolations.push(text);
      }
    });

    page.on('pageerror', (err) => {
      consoleErrors.push(`pageerror: ${err.message}`);
    });

    // Do not call page.addInitScript() here: Playwright injects init scripts viaRuntime.evaluate (eval),
    // which triggers synthetic `script-src:eval` violation events under our strict CSP (`script-src` without `'unsafe-eval'`).
    const response = await page.goto('/dev/crypto-bench?mode=harness', {
      waitUntil: 'domcontentloaded',
    });
    expect(response).not.toBeNull();
    expect(response?.status()).toBe(200);

    const cspHeader = response?.headers()['content-security-policy'] ?? '';
    expect(cspHeader).toContain("worker-src 'self' blob:");
    expect(cspHeader).toContain("'wasm-unsafe-eval'");

    await expect(page.getByTestId('harness-status')).toHaveText('Status: done', {
      timeout: 45_000,
    });
    await expect(page.getByTestId('harness-all-passed')).toHaveText('All Passed: true');

    const rawJson = (await page.getByTestId('harness-result-json').textContent()) ?? '{}';
    const summary = JSON.parse(rawJson) as HarnessSummary;

    expect(summary.status).toBe('done');
    expect(summary.allPassed).toBe(true);
    expect(summary.cspViolations).toEqual([]);
    expect(summary.steps.map((s) => s.step)).toEqual([
      'createVault',
      'lockAfterCreate',
      'unlockPassphrase',
      'sealAndOpenEntry',
      'lockBeforeWrongPassphrase',
      'wrongPassphrase',
    ]);
    for (const step of summary.steps) {
      expect(step.ok, `step ${step.step} must pass`).toBe(true);
    }

    const createStep = summary.steps.find((s) => s.step === 'createVault');
    expect(createStep?.details).toMatchObject({
      kdfAlg: 'argon2id13',
      kdfOps: 3,
      kdfMem: 67_108_864,
      kdfParallelism: 1,
      recoveryKeysCount: 10,
      hasWrappedVk: true,
      hasWrappedPriv: true,
    });

    const roundTripStep = summary.steps.find((s) => s.step === 'sealAndOpenEntry');
    expect(roundTripStep?.details).toMatchObject({
      envelopeVersion: 1,
      envelopeAlg: 'xchacha20poly1305-ietf',
      roundTripMatched: true,
    });

    const wrongPassStep = summary.steps.find((s) => s.step === 'wrongPassphrase');
    expect(wrongPassStep?.state).toBe('locked');
    expect(wrongPassStep?.details).toMatchObject({
      errorCode: 'AEAD_DECRYPT_FAILED',
    });

    // Verify the page never renders secrets (passphrase, recovery keys, wrapped blobs)
    const bodyText = (await page.locator('body').textContent()) ?? '';
    expect(bodyText).not.toContain('engram-p03-t5-e2e-fixed-test-passphrase-01');
    expect(bodyText).not.toContain('engram-p03-t5-e2e-wrong-test-passphrase-99');
    expect(bodyText).not.toMatch(/\brk(?:[1-9]|10)[_-][0-9A-Za-z-]{20,}/);
    expect(bodyText).not.toContain('vault_key_wrapped_by_kek');

    expect(cspViolations).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
