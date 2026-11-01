/**
 * Standard browser-suppression attributes required on every DOM element holding secret/body input
 * (editor text, raw JSON, table cell editor, import dialog, and omnibox — plan §2.10, P4FE1-15).
 *
 * Ensures `[data-vault-secret]` elements always carry:
 * - `spellcheck="false"` (prevents browser cloud spellcheck exfiltration)
 * - `autocomplete="off"`
 * - `autocorrect="off"`
 * - `autocapitalize="off"`
 */
export interface VaultSecretInputProps {
  readonly 'data-vault-secret': '';
  readonly spellCheck: false;
  readonly autoComplete: 'off';
  readonly autoCorrect: 'off';
  readonly autoCapitalize: 'off';
}

export const VAULT_SECRET_INPUT_PROPS: VaultSecretInputProps = Object.freeze({
  'data-vault-secret': '',
  spellCheck: false,
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
});

/**
 * Returns the canonical secret input attributes for `<input>` / `<textarea>` elements holding
 * decrypted or draft entry content (plan §2.10, P4FE1-15).
 */
export function getVaultSecretInputProps(): VaultSecretInputProps {
  return VAULT_SECRET_INPUT_PROPS;
}

export interface SecretElementAttributeViolation {
  readonly tagName: string;
  readonly id?: string;
  readonly testId?: string;
  readonly attribute: 'spellcheck' | 'autocomplete' | 'autocorrect' | 'autocapitalize';
  readonly actualValue: string | null;
  readonly expectedValue: string;
}

/**
 * Inspects every `[data-vault-secret]` element inside `root` and verifies that
 * `spellcheck="false"`, `autocomplete="off"`, `autocorrect="off"`, and `autocapitalize="off"`
 * are all set on the rendered DOM attributes.
 */
export function findVaultSecretAttributeViolations(
  root: ParentNode,
): SecretElementAttributeViolation[] {
  const violations: SecretElementAttributeViolation[] = [];
  const elements = Array.from(root.querySelectorAll<HTMLElement>('[data-vault-secret]'));
  if (
    root instanceof HTMLElement &&
    root.hasAttribute('data-vault-secret') &&
    !elements.includes(root)
  ) {
    elements.unshift(root);
  }

  const requiredAttrs: ReadonlyArray<{
    readonly name: 'spellcheck' | 'autocomplete' | 'autocorrect' | 'autocapitalize';
    readonly expected: string;
  }> = [
    { name: 'spellcheck', expected: 'false' },
    { name: 'autocomplete', expected: 'off' },
    { name: 'autocorrect', expected: 'off' },
    { name: 'autocapitalize', expected: 'off' },
  ];

  for (const el of elements) {
    const tagName = el.tagName.toLowerCase();
    const id = el.id || undefined;
    const testId = el.getAttribute('data-testid') ?? undefined;
    for (const req of requiredAttrs) {
      const actual = el.getAttribute(req.name);
      if (actual !== req.expected) {
        violations.push({
          tagName,
          ...(id ? { id } : {}),
          ...(testId ? { testId } : {}),
          attribute: req.name,
          actualValue: actual,
          expectedValue: req.expected,
        });
      }
    }
  }

  return violations;
}

/**
 * Throws if any `[data-vault-secret]` element inside `root` is missing one of the required
 * browser-suppression attributes (`spellcheck="false"`, `autocomplete="off"`, `autocorrect="off"`, `autocapitalize="off"`).
 */
export function assertVaultSecretElementAttributes(root: ParentNode): void {
  const violations = findVaultSecretAttributeViolations(root);
  if (violations.length > 0) {
    const summary = violations
      .map(
        (v) =>
          `<${v.tagName}${v.testId ? ` data-testid="${v.testId}"` : ''}> expected ${v.attribute}="${v.expectedValue}" but got ${JSON.stringify(v.actualValue)}`,
      )
      .join('; ');
    throw new Error(`Vault secret attribute violation(s): ${summary}`);
  }
}
