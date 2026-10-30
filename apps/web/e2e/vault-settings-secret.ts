import { expect, type Locator } from '@playwright/test';

// Lane-owned helper for the vault-settings E2E specs (FE10-1, advisor-dec-045).
//
// Why: pinned Playwright progress-logs the argument of locator.fill(), and the list reporter prints that log on an
// actionability timeout into the PUBLIC CI log. Every vault passphrase / login password written by the
// vault-settings specs therefore goes through fillSecret(), whose evaluate() argument is not echoed in a call log.
//
// TODO(dedupe): this is a copy of fillSecret in vault-real-api.spec.ts (vaultweb-owned). Dedupe with that one when a
// shared helper exists.

const DEFAULT_EDITABLE_TIMEOUT_MS = 30_000;

/**
 * Types a secret into a controlled React input without the value appearing in a Playwright call log. The field is
 * waited for first (visible, enabled, editable) so a failure still diagnoses.
 */
export async function fillSecret(
  input: Locator,
  value: string,
  timeout: number = DEFAULT_EDITABLE_TIMEOUT_MS,
) {
  await expect(input).toBeEditable({ timeout });
  await input.evaluate((element, next) => {
    const field = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('HTMLInputElement value setter is missing');
    setter.call(field, next);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
