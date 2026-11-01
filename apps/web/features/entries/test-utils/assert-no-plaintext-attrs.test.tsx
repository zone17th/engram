import { cleanup, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertNoPlaintextAttrs,
  findPlaintextAttrLeaks,
} from '@/features/entries/test-utils/assert-no-plaintext-attrs';
import {
  VAULT_SECRET_INPUT_PROPS,
  assertVaultSecretElementAttributes,
  findVaultSecretAttributeViolations,
  getVaultSecretInputProps,
} from '@/features/entries/secret-input-props';

describe('features/entries/test-utils/assert-no-plaintext-attrs', () => {
  const SENTINEL = 'SENTINEL-SECRET-BODY-9921';
  const SECOND_SENTINEL = 'SENTINEL-JSON-VALUE-4410';

  afterEach(() => {
    cleanup();
  });

  it('passes when sentinel appears ONLY as a text node or inside an active [data-vault-secret] editor value', () => {
    render(
      <div data-testid="card-root">
        <p data-testid="entry-body">{SENTINEL}</p>
        <textarea
          data-testid="secret-editor"
          {...getVaultSecretInputProps()}
          defaultValue={SECOND_SENTINEL}
        />
      </div>,
    );

    expect(screen.getByTestId('entry-body')).toHaveTextContent(SENTINEL);
    expect(() =>
      assertNoPlaintextAttrs(document.body, [SENTINEL, SECOND_SENTINEL]),
    ).not.toThrow();
    expect(findPlaintextAttrLeaks(document.body, [SENTINEL, SECOND_SENTINEL])).toEqual([]);

    // IP14-FE1-7: With `{ locked: true }`, even a `[data-vault-secret]` textarea's `.value` is flagged.
    const lockedLeaks = findPlaintextAttrLeaks(document.body, [SENTINEL, SECOND_SENTINEL], {
      locked: true,
    });
    expect(lockedLeaks).toEqual([
      expect.objectContaining({
        tagName: 'textarea',
        testId: 'secret-editor',
        attribute: 'value',
        sentinel: SECOND_SENTINEL,
      }),
    ]);
    expect(() =>
      assertNoPlaintextAttrs(document.body, [SENTINEL, SECOND_SENTINEL], { locked: true }),
    ).toThrow(/Plaintext leaked in DOM attributes/);
  });
  it('catches a sentinel leaked in title, aria-label, data-*, placeholder, alt, href, and non-editing input value', () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly renderNode: () => ReactElement;
      readonly expectedAttr: string;
    }> = [
      {
        label: 'title',
        renderNode: () => <div title={`Tooltip: ${SENTINEL}`}>Safe text</div>,
        expectedAttr: 'title',
      },
      {
        label: 'aria-label',
        renderNode: () => <button aria-label={`Copy ${SENTINEL}`}>Copy</button>,
        expectedAttr: 'aria-label',
      },
      {
        label: 'aria-description',
        renderNode: () => <div aria-description={`Desc ${SENTINEL}`}>Row</div>,
        expectedAttr: 'aria-description',
      },
      {
        label: 'data-x',
        renderNode: () => <span data-x={SENTINEL}>Cell</span>,
        expectedAttr: 'data-x',
      },
      {
        label: 'placeholder',
        renderNode: () => <input placeholder={SENTINEL} readOnly />,
        expectedAttr: 'placeholder',
      },
      {
        label: 'alt',
        renderNode: () => <input type="image" alt={SENTINEL} src="/icon.svg" />,
        expectedAttr: 'alt',
      },
      {
        label: 'href',
        renderNode: () => <a href={`https://example.test/?q=${SENTINEL}`}>Link</a>,
        expectedAttr: 'href',
      },
      {
        label: 'value on non-secret input',
        renderNode: () => <input defaultValue={SENTINEL} readOnly />,
        expectedAttr: 'value',
      },
    ];

    for (const testCase of cases) {
      cleanup();
      const { container } = render(testCase.renderNode());
      const leaks = findPlaintextAttrLeaks(container, [SENTINEL]);
      expect(leaks.length, `expected leak for ${testCase.label}`).toBeGreaterThan(0);
      expect(leaks.some((l) => l.attribute === testCase.expectedAttr)).toBe(true);
      expect(() => assertNoPlaintextAttrs(container, [SENTINEL])).toThrow(
        /Plaintext leaked in DOM attributes/,
      );
    }
  });

  it('still catches title / aria-label / data-* / placeholder leaks EVEN on a [data-vault-secret] element', () => {
    const { container } = render(
      <textarea
        {...VAULT_SECRET_INPUT_PROPS}
        title={SENTINEL}
        aria-label={SECOND_SENTINEL}
        data-raw={SENTINEL}
        placeholder={SECOND_SENTINEL}
        defaultValue="safe-draft"
      />,
    );

    const leaks = findPlaintextAttrLeaks(container, [SENTINEL, SECOND_SENTINEL]);
    expect(leaks.map((l) => l.attribute).sort()).toEqual([
      'aria-label',
      'data-raw',
      'placeholder',
      'title',
    ]);
    expect(() => assertNoPlaintextAttrs(container, [SENTINEL, SECOND_SENTINEL])).toThrow(
      /Plaintext leaked in DOM attributes/,
    );
  });

  it('catches programmatic DOM .value and .dataset mutations on non-secret elements', () => {
    const { container } = render(
      <div>
        <input data-testid="plain-input" />
        <div data-testid="plain-div" />
      </div>,
    );

    const input = screen.getByTestId<HTMLInputElement>('plain-input');
    input.value = `prefix-${SENTINEL}-suffix`;

    const div = screen.getByTestId<HTMLDivElement>('plain-div');
    div.dataset.secretPreview = SECOND_SENTINEL;

    const leaks = findPlaintextAttrLeaks(container, [SENTINEL, SECOND_SENTINEL]);
    expect(leaks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tagName: 'input',
          testId: 'plain-input',
          attribute: 'value',
          sentinel: SENTINEL,
        }),
        expect.objectContaining({
          tagName: 'div',
          testId: 'plain-div',
          attribute: 'data-secret-preview',
          sentinel: SECOND_SENTINEL,
        }),
      ]),
    );
  });
});

describe('features/entries/secret-input-props', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders [data-vault-secret] with spellcheck="false", autocomplete="off", autocorrect="off", autocapitalize="off"', () => {
    const { container } = render(
      <div>
        <textarea data-testid="secret-textarea" {...getVaultSecretInputProps()} />
        <input data-testid="secret-input" {...VAULT_SECRET_INPUT_PROPS} />
      </div>,
    );

    for (const testId of ['secret-textarea', 'secret-input']) {
      const el = screen.getByTestId(testId);
      expect(el).toHaveAttribute('data-vault-secret', '');
      expect(el).toHaveAttribute('spellcheck', 'false');
      expect(el).toHaveAttribute('autocomplete', 'off');
      expect(el).toHaveAttribute('autocorrect', 'off');
      expect(el).toHaveAttribute('autocapitalize', 'off');
    }

    expect(findVaultSecretAttributeViolations(container)).toEqual([]);
    expect(() => assertVaultSecretElementAttributes(container)).not.toThrow();
  });

  it('detects missing or wrong browser-suppression attributes on [data-vault-secret]', () => {
    const { container } = render(
      <textarea data-testid="bad-secret" data-vault-secret="" spellCheck={true} />,
    );

    const violations = findVaultSecretAttributeViolations(container);
    expect(violations.map((v) => v.attribute)).toEqual([
      'spellcheck',
      'autocomplete',
      'autocorrect',
      'autocapitalize',
    ]);
    expect(() => assertVaultSecretElementAttributes(container)).toThrow(
      /Vault secret attribute violation/,
    );
  });
});
