/**
 * Shared DOM attribute leak scanner for P04 Tasks 14–18 (plan §2.10, P4FE2-10, user-dec-016).
 *
 * Scans every attribute of every element in a DOM subtree — including `title`, `aria-*`, `data-*`
 * (`dataset`), `placeholder`, `alt`, `href`, and the `value` attribute / DOM property of any
 * element that is NOT an active secret editing field (`[data-vault-secret]` by default) — for any
 * of the supplied sentinel strings.
 */

export interface PlaintextAttrLeak {
  readonly tagName: string;
  readonly id?: string;
  readonly testId?: string;
  readonly attribute: string;
  readonly sentinel: string;
  readonly value: string;
}

export interface AssertNoPlaintextAttrsOptions {
  /**
   * Optional predicate or element list identifying active secret-editing fields whose live `.value`
   * property is allowed to hold the draft while unlocked and editing (plan §1, §2.10).
   *
   * Note: even on an active editing field, HTML attributes such as `title`, `aria-label`,
   * `aria-description`, `data-*`, `placeholder`, and `alt` are NEVER allowed to contain sentinel
   * plaintext; only the live editing `.value` (or `value` attribute when not explicitly prohibited)
   * on an allowed editing element is exempt.
   *
   * Defaults to matching `<input data-vault-secret>` and `<textarea data-vault-secret>`.
   */
  readonly isAllowedEditingElement?: (element: Element) => boolean;
}

function defaultIsAllowedEditingElement(element: Element): boolean {
  const tag = element.tagName.toUpperCase();
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
    return false;
  }
  return element.hasAttribute('data-vault-secret');
}

function collectSubtreeElements(root: Element | Document | DocumentFragment): Element[] {
  const elements: Element[] = [];
  if ('tagName' in root && typeof root.tagName === 'string') {
    elements.push(root);
  }
  const descendants = root.querySelectorAll('*');
  for (let i = 0; i < descendants.length; i += 1) {
    const el = descendants[i];
    if (el) {
      elements.push(el);
    }
  }
  return elements;
}

/**
 * Finds all attribute / dataset / non-editing `.value` leaks of `sentinels` within `root`.
 */
export function findPlaintextAttrLeaks(
  root: Element | Document | DocumentFragment,
  sentinels: readonly string[],
  options?: AssertNoPlaintextAttrsOptions,
): PlaintextAttrLeak[] {
  const activeSentinels = sentinels.filter((s) => typeof s === 'string' && s.length > 0);
  if (activeSentinels.length === 0) {
    return [];
  }

  const isAllowedEditor = options?.isAllowedEditingElement ?? defaultIsAllowedEditingElement;
  const elements = collectSubtreeElements(root);
  const leaks: PlaintextAttrLeak[] = [];
  const recorded = new Set<string>();

  const recordLeak = (el: Element, attribute: string, sentinel: string, value: string): void => {
    const tagName = el.tagName.toLowerCase();
    const id = el.id || undefined;
    const testId = el.getAttribute('data-testid') ?? undefined;
    const dedupKey = `${tagName}#${id ?? ''}[${testId ?? ''}]:${attribute}:${sentinel}`;
    if (recorded.has(dedupKey)) {
      return;
    }
    recorded.add(dedupKey);
    leaks.push({
      tagName,
      ...(id ? { id } : {}),
      ...(testId ? { testId } : {}),
      attribute,
      sentinel,
      value,
    });
  };

  for (let idx = 0; idx < elements.length; idx += 1) {
    const el = elements[idx]!;
    const allowedEditing = isAllowedEditor(el);

    // 1. Scan every HTML attribute on the element (`title`, `aria-*`, `data-*`, `placeholder`, `alt`, `href`, `value`, etc.)
    const attrs = el.attributes;
    for (let i = 0; i < attrs.length; i += 1) {
      const attr = attrs[i];
      if (!attr) continue;
      const attrName = attr.name.toLowerCase();
      // Only the `value` attribute on an allowed editing element is exempt; all other attributes
      // (including title, aria-*, data-*, placeholder, alt) are always scanned.
      if (attrName === 'value' && allowedEditing) {
        continue;
      }
      const attrValue = attr.value;
      for (const sentinel of activeSentinels) {
        if (attrValue.includes(sentinel)) {
          recordLeak(el, attrName, sentinel, attrValue);
        }
      }
    }

    // 2. Scan `HTMLElement.dataset` explicitly in case a property was mutated directly
    if (el instanceof HTMLElement && el.dataset) {
      for (const [key, val] of Object.entries(el.dataset)) {
        if (typeof val !== 'string' || val.length === 0) continue;
        const kebabKey = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
        const attrName = `data-${kebabKey}`;
        for (const sentinel of activeSentinels) {
          if (val.includes(sentinel)) {
            recordLeak(el, attrName, sentinel, val);
          }
        }
      }
    }

    // 3. Scan DOM `.value` property on elements that are NOT the allowed editing field
    if (!allowedEditing && 'value' in el) {
      const propVal = el.value;
      if (typeof propVal === 'string' && propVal.length > 0) {
        for (const sentinel of activeSentinels) {
          if (propVal.includes(sentinel)) {
            recordLeak(el, 'value', sentinel, propVal);
          }
        }
      }
    }
  }

  return leaks;
}

/**
 * Asserts that no DOM attribute (or `.value` of a non-editing element) in `root` contains any of
 * the given `sentinels`. Throws a descriptive `Error` listing every offending element and attribute
 * if a sentinel is found.
 */
export function assertNoPlaintextAttrs(
  root: Element | Document | DocumentFragment,
  sentinels: readonly string[],
  options?: AssertNoPlaintextAttrsOptions,
): void {
  const leaks = findPlaintextAttrLeaks(root, sentinels, options);
  if (leaks.length > 0) {
    const details = leaks
      .map(
        (leak) =>
          `<${leak.tagName}${leak.id ? `#${leak.id}` : ''}${leak.testId ? `[data-testid="${leak.testId}"]` : ''}> attribute "${leak.attribute}" leaked sentinel ${JSON.stringify(leak.sentinel)}`,
      )
      .join('; ');
    throw new Error(`Plaintext leaked in DOM attributes: ${details}`);
  }
}
