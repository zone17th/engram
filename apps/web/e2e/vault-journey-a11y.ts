import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fillSecret } from './vault-settings-secret';

// Helpers of e2e/vault-a11y-sweep.spec.ts (P03-T23 Part 2, bullet 2): axe + overflow + sanitized screenshot per screen
// state and viewport, plus the once-per-screen keyboard, focus-trap and reduced-motion assertions.
//
// Secrets: nothing here reads, logs or asserts on a secret. Secret fields are written with fillSecret() and checked with
// boolean evaluate()s only; axe failures print rule id, impact and CSS selectors (never node HTML); every screenshot masks
// each input that holds a value and every recovery-key cell/grid.

export const A11Y_LANGS = ['en', 'vi'] as const;
export const A11Y_THEMES = ['light', 'dark'] as const;
export const A11Y_WIDTHS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  // Last on purpose: the flow continues at the desktop width, where the header shows the lock pill and Settings link.
  { width: 1440, height: 900 },
] as const;

// One entry per screen state. The names are the middle part of `vault-a11y-<screen>-<lang>-<theme>-<w>.png`; the
// allowlist block in scripts/sanitize-e2e-artifacts.mjs lists exactly these names x lang x theme x width.
export const A11Y_SCREENS = [
  // U3 onboarding
  'onboarding-step1',
  'onboarding-rk-sheet',
  'onboarding-confirm',
  'onboarding-step3',
  // U5 locked state on /app
  'locked-list',
  // U4 unlock, forgot passphrase, recovery
  'unlock-empty',
  'unlock-incorrect',
  'forgot-passphrase',
  'recovery-reauth',
  'recovery-enter-key',
  'recovery-new-passphrase',
  // U7 Settings vault security section and its dialogs / J2 controls
  'settings-section',
  'settings-passphrase-dialog',
  'settings-rk-regenerate-reauth',
  'settings-rk-rotate-reauth',
  'settings-rk-rotate-sheet',
  'settings-reset-step1',
  'settings-reset-reauth',
  'settings-passkey-reauth',
  'settings-passkey-name',
  'settings-passkey-list',
  'settings-passkey-rename',
  'settings-passkey-revoke',
  'settings-auto-lock',
  'settings-remember-device',
] as const;

export type A11yLang = (typeof A11Y_LANGS)[number];
export type A11yTheme = (typeof A11Y_THEMES)[number];
export type A11yScreen = (typeof A11Y_SCREENS)[number];

export interface A11yContext {
  page: Page;
  testInfo: TestInfo;
  lang: A11yLang;
  theme: A11yTheme;
  /**
   * The once-per-screen pass (en, light, 1440): keyboard activation of every primary action, Tab-order walk, focus trap,
   * focus return and reduced-motion assertions. The other three lang/theme groups click.
   */
  keyboard: boolean;
}

export interface StateSpec {
  screen: A11yScreen;
  /** CSS selector that limits axe (dialog states: the dialog). Omitted: the whole page. */
  axeInclude?: string;
  /** CSS selector(s) whose subtree the reduced-motion assertion sweeps (keyboard pass only). */
  motionRoots: string;
  fullPage: boolean;
}

export interface KeyboardWalkOptions {
  /** Dialog focus trap: Tab from last wraps to first and Shift+Tab from first wraps to last. */
  trap?: boolean;
  /**
   * Optional selector (relative to the scope root) of the primary action for this screen state. When given, the walk
   * ends by Tab-traversing onto that control so the caller can activate it via `page.keyboard.press` without `locator.press`.
   */
  leaveFocusedSelector?: string;
}

const UI_TIMEOUT_MS = 30_000;
const SHOT_TIMEOUT_MS = 30_000;
const FOCUS_TIMEOUT_MS = 10_000;
const MAX_DURATION_SECONDS = 0.001;

export function a11yScreenshotName(screen: A11yScreen, lang: A11yLang, theme: A11yTheme, width: number): string {
  return `vault-a11y-${screen}-${lang}-${theme}-${width}.png`;
}

/**
 * A retried secret fill: the SSR input is visible before React hydrates and hydration resets a controlled value. The
 * check is a boolean evaluate() so a failure never prints the value; fillSecret's own evaluate() argument is not echoed.
 */
export async function fillSecretVerified(input: Locator, value: string, timeout = UI_TIMEOUT_MS) {
  await expect(async () => {
    await fillSecret(input, value, timeout);
    const same = await input.evaluate((el, expected) => (el as HTMLInputElement).value === expected, value);
    expect(same).toBe(true);
  }).toPass({ timeout });
}

/**
 * Keyboard group: activates the control from focus reached by sequential Tab traversal (`page.keyboard.press(key)`),
 * never calling `locator.press()` (which would focus its target independently of Tab reachability, JR1-7). If a prior
 * `keyboardWalk(..., { leaveFocusedSelector })` already parked focus on `target`, presses `key` immediately; otherwise
 * Tab-traverses within `scopeSelector` until `document.activeElement` is `target` (asserting containment on each step,
 * JR1-8) and then presses `key`. Non-keyboard groups use a plain click.
 */
export async function activate(
  ctx: A11yContext,
  target: Locator,
  key: 'Enter' | 'Space' = 'Enter',
  scopeSelector = 'body',
) {
  if (!ctx.keyboard) {
    await target.click();
    return;
  }
  const alreadyFocused = await target.evaluate((el) => document.activeElement === el);
  if (!alreadyFocused) {
    await tabToTargetInScope(ctx.page, scopeSelector, target);
  }
  await expect(target).toBeFocused({ timeout: FOCUS_TIMEOUT_MS });
  await ctx.page.keyboard.press(key);
}

/**
 * Sequential Tab traversal inside `scopeSelector` until `document.activeElement === target`, asserting on every Tab step
 * that focus remains inside `scopeSelector` (JR1-7, JR1-8).
 */
export async function tabToTargetInScope(page: Page, scopeSelector: string, target: Locator) {
  const targetElHandle = await target.elementHandle({ timeout: FOCUS_TIMEOUT_MS });
  const needsRootFocus = await page.evaluate(
    ({ selector, targetEl }) => {
      const root = document.querySelector<HTMLElement>(selector);
      if (!root) return false;
      const active = document.activeElement;
      if (!active || active === document.body || !root.contains(active)) return true;
      if (!targetEl || active === targetEl) return false;
      const trapped = root.getAttribute('role') === 'dialog' || Boolean(root.closest('[role="dialog"]'));
      if (trapped) return false;
      // DOCUMENT_POSITION_PRECEDING (2): target is before activeElement in DOM order and non-dialog scopes do not wrap.
      return Boolean(active.compareDocumentPosition(targetEl) & Node.DOCUMENT_POSITION_PRECEDING);
    },
    { selector: scopeSelector, targetEl: targetElHandle },
  );
  await targetElHandle?.dispose();

  let hadTabindex: string | null = null;
  let mutatedRoot = false;
  if (needsRootFocus) {
    mutatedRoot = true;
    hadTabindex = await page.evaluate((selector) => {
      const root = document.querySelector<HTMLElement>(selector);
      if (!root) return null;
      const prev = root.getAttribute('tabindex');
      root.setAttribute('tabindex', '-1');
      root.focus();
      return prev;
    }, scopeSelector);
  }
  try {
    const maxSteps = 80;
    for (let step = 0; step < maxSteps; step += 1) {
      if (await target.evaluate((el) => document.activeElement === el)) {
        return;
      }
      await page.keyboard.press('Tab');
      const contained = await page.evaluate((selector) => {
        const root = document.querySelector(selector);
        const active = document.activeElement;
        return Boolean(root && active && active !== document.body && root.contains(active));
      }, scopeSelector);
      expect(contained, `tabToTargetInScope(${scopeSelector}): activeElement escaped scope on step ${step + 1}`).toBe(
        true,
      );
    }
    expect(await target.evaluate((el) => document.activeElement === el), `target reached by Tab in ${scopeSelector}`).toBe(
      true,
    );
  } finally {
    if (mutatedRoot) {
      await page.evaluate(
        ({ selector, previous }) => {
          const root = document.querySelector<HTMLElement>(selector);
          if (!root) return;
          if (previous === null) root.removeAttribute('tabindex');
          else root.setAttribute('tabindex', previous);
        },
        { selector: scopeSelector, previous: hadTabindex },
      );
    }
  }
}

async function settle(page: Page, lang: A11yLang, theme: A11yTheme) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: UI_TIMEOUT_MS });
  await expect(page.locator('html')).toHaveAttribute('lang', lang, { timeout: UI_TIMEOUT_MS });
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Two frames so a resize has laid out and painted; bounded so a throttled frame clock cannot hang the check.
    const frames = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => frames.resolve()));
    const bound = Promise.withResolvers<void>();
    setTimeout(bound.resolve, 1_000);
    await Promise.race([frames.promise, bound.promise]);
  });
}

/** Tag every text-like input that holds a value so the frame masks it (empty inputs stay unmasked). */
async function tagFilledInputs(page: Page) {
  await page.evaluate(() => {
    for (const input of document.querySelectorAll<HTMLInputElement>('input')) {
      if (input.type === 'checkbox' || input.type === 'radio' || input.type === 'hidden') continue;
      if (input.value !== '') input.setAttribute('data-visual-mask', 'true');
      else input.removeAttribute('data-visual-mask');
    }
  });
}

async function saveScreenshot(ctx: A11yContext, spec: StateSpec, width: number) {
  const { page, testInfo, lang, theme } = ctx;
  await tagFilledInputs(page);
  const outputPath = testInfo.outputPath(a11yScreenshotName(spec.screen, lang, theme, width));
  mkdirSync(dirname(outputPath), { recursive: true });
  const buffer = await page.screenshot({
    path: outputPath,
    timeout: SHOT_TIMEOUT_MS,
    fullPage: spec.fullPage,
    animations: 'disabled',
    caret: 'hide',
    // The recovery-key grid and every cell are always masked, whichever screen is captured; never a frame with an RK.
    mask: [
      page.locator('[data-visual-mask]'),
      page.getByTestId('recovery-keys-grid'),
      page.locator('[data-testid^="recovery-key-slot-"]'),
    ],
  });
  expect.soft(buffer.byteLength, `screenshot ${spec.screen} ${lang} ${theme} ${width}`).toBeGreaterThan(0);
}

async function runAxe(ctx: A11yContext, spec: StateSpec, width: number) {
  const { page, lang, theme } = ctx;
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']);
  if (spec.axeInclude) builder = builder.include(spec.axeInclude);
  const results = await builder.analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious');
  const critical = results.violations.filter((v) => v.impact === 'critical');
  // One raw line per state and viewport: this log is the evidence.
  console.log(
    `axe ${spec.screen} ${lang} ${theme} ${width}: serious=${serious.length} critical=${critical.length} (total=${results.violations.length})`,
  );
  const detail = [...critical, ...serious]
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => JSON.stringify(n.target)).join(' | ')}`)
    .join('; ');
  expect
    .soft(serious.length + critical.length, `axe ${spec.screen} ${lang} ${theme} ${width}: ${detail}`)
    .toBe(0);
}

async function expectNoHorizontalOverflow(ctx: A11yContext, spec: StateSpec, width: number) {
  const { scrollWidth, innerWidth } = await ctx.page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  console.log(
    `overflow ${spec.screen} ${ctx.lang} ${ctx.theme} ${width}: scrollWidth=${scrollWidth} innerWidth=${innerWidth}`,
  );
  expect
    .soft(
      scrollWidth,
      `horizontal overflow ${spec.screen} ${ctx.lang} ${ctx.theme} ${width}: scrollWidth ${scrollWidth} > innerWidth ${innerWidth}`,
    )
    .toBeLessThanOrEqual(innerWidth);
}

/**
 * Reduced motion: under `prefers-reduced-motion: reduce` every element (and ::before/::after) under the roots has an
 * effectively zero transition and animation duration, and no smooth scrolling. The page is already emulated `reduce`.
 */
export async function expectReducedMotion(page: Page, rootsSelector: string, label: string) {
  const offenders = await page.evaluate(
    ({ selector, max }) => {
      const toSeconds = (list: string) =>
        list.split(',').map((part) => {
          const value = Number.parseFloat(part);
          return part.trim().endsWith('ms') ? value / 1000 : value;
        });
      const found: string[] = [];
      const roots = Array.from(document.querySelectorAll(selector));
      for (const root of roots) {
        for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
          for (const pseudo of [null, '::before', '::after']) {
            const style = getComputedStyle(element, pseudo);
            const tag = `${element.tagName.toLowerCase()}${pseudo ?? ''}`;
            if (toSeconds(style.transitionDuration).some((s) => s > max))
              found.push(`${tag} transition ${style.transitionDuration}`);
            if (toSeconds(style.animationDuration).some((s) => s > max))
              found.push(`${tag} animation ${style.animationDuration}`);
          }
          if (getComputedStyle(element).scrollBehavior === 'smooth')
            found.push(`${element.tagName.toLowerCase()} scroll-behavior smooth`);
        }
      }
      return { roots: roots.length, found: found.slice(0, 8) };
    },
    { selector: rootsSelector, max: MAX_DURATION_SECONDS },
  );
  expect.soft(offenders.roots, `reduced motion ${label}: no element matches ${rootsSelector}`).toBeGreaterThan(0);
  expect.soft(offenders.found, `reduced motion ${label}`).toEqual([]);
}

/**
 * Proves the reduced-motion assertion is not vacuous: without the preference the app really animates (the shared
 * 0.15s transitions of tokens.css), with it the same elements drop to ~0 (checked by expectReducedMotion afterwards).
 */
export async function expectAppAnimatesWithoutPreference(page: Page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  try {
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            let longest = 0;
            for (const element of Array.from(document.querySelectorAll('button, input, a'))) {
              for (const part of getComputedStyle(element).transitionDuration.split(',')) {
                const value = Number.parseFloat(part);
                longest = Math.max(longest, part.trim().endsWith('ms') ? value / 1000 : value);
              }
            }
            return longest;
          }),
        { timeout: UI_TIMEOUT_MS },
      )
      .toBeGreaterThan(0.05);
  } finally {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  }
}

interface Tabbable {
  index: number;
  label: string;
  centerY: number;
  left: number;
  unfocusedOutlineStyle: string;
  unfocusedOutlineWidth: number;
  unfocusedOutlineColor: string;
  unfocusedBoxShadow: string;
  unfocusedBorderTopColor: string;
}

/**
 * Numbers every required enabled control under `scopeSelector` in DOM order (`data-a11y-tab`) and records its geometry
 * and unfocused style baseline.
 *
 * JR1-7: required controls are defined independently of their current `tabIndex` (every visible, enabled interactive
 * control `a[href], button, input, select, textarea, summary` plus intended keyboard stops `code[data-testid^="recovery-key-slot-"]`,
 * excluding only Radix roving-tabindex inactive items `[role="radio"][data-radix-collection-item][tabindex="-1"]` whose
 * group tab stop is the active radio). If an enabled control accidentally has `tabIndex < 0`, it stays in the required
 * sequence and the Tab traversal fails when Tab skips over it.
 *
 * JR1-8: clears all previous `data-a11y-tab` markers across the entire `document` first so background markers from an
 * earlier screen or underlying Settings section can never alias a dialog or current scope index.
 *
 * JR1-9: blurs any currently focused element inside `root` before sampling each control's unfocused outline and
 * `box-shadow` baseline.
 */
async function markTabbables(page: Page, scopeSelector: string): Promise<Tabbable[]> {
  return page.evaluate((selector) => {
    for (const stale of Array.from(document.querySelectorAll('[data-a11y-tab]'))) {
      stale.removeAttribute('data-a11y-tab');
    }
    const root = document.querySelector<HTMLElement>(selector);
    if (!root) return [];
    if (document.activeElement instanceof HTMLElement && root.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    const candidates = Array.from(
      root.querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, summary, code[data-testid^="recovery-key-slot-"]',
      ),
    );
    const found: {
      index: number;
      label: string;
      centerY: number;
      left: number;
      unfocusedOutlineStyle: string;
      unfocusedOutlineWidth: number;
      unfocusedOutlineColor: string;
      unfocusedBoxShadow: string;
      unfocusedBorderTopColor: string;
    }[] = [];
    for (const element of candidates) {
      if ((element as HTMLButtonElement).disabled) continue;
      if (element.getAttribute('aria-disabled') === 'true') continue;
      if (element instanceof HTMLInputElement && element.type === 'hidden') continue;
      if (
        element.getAttribute('role') === 'radio' &&
        element.hasAttribute('data-radix-collection-item') &&
        element.tabIndex < 0
      ) {
        continue;
      }
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) continue;
      if (element.closest('[inert], [aria-hidden="true"]')) continue;
      const index = found.length;
      element.setAttribute('data-a11y-tab', String(index));
      const label =
        element.getAttribute('data-testid') ??
        element.getAttribute('aria-label') ??
        (element.id || element.tagName.toLowerCase());
      found.push({
        index,
        label,
        centerY: rect.top + rect.height / 2,
        left: rect.left,
        unfocusedOutlineStyle: style.outlineStyle,
        unfocusedOutlineWidth: Number.parseFloat(style.outlineWidth) || 0,
        unfocusedOutlineColor: style.outlineColor,
        unfocusedBoxShadow: style.boxShadow,
        unfocusedBorderTopColor: style.borderTopColor,
      });
    }
    return found;
  }, scopeSelector);
}

/**
 * JR1-8: returns whether `document.activeElement` is contained inside `scopeSelector` and, only when contained, its
 * `data-a11y-tab` index.
 */
async function activeTabState(
  page: Page,
  scopeSelector: string,
): Promise<{ contained: boolean; index: number | null }> {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    const active = document.activeElement;
    if (!root || !active || active === document.body || !root.contains(active)) {
      return { contained: false, index: null };
    }
    const value = active.getAttribute('data-a11y-tab');
    return {
      contained: true,
      index: value === null || value === undefined ? null : Number(value),
    };
  }, scopeSelector);
}

/**
 * JR1-9: visible focus requires a focus-specific visible change compared against the same element's unfocused baseline:
 * either a non-transparent outline (`outlineStyle !== 'none'`, `outlineWidth > 0` or `outlineStyle === 'auto'`, alpha > 0)
 * that differs from the unfocused outline, a visible `box-shadow` (`!== 'none'`, non-transparent) that differs from
 * `unfocusedBoxShadow`, or a visible border color change against `unfocusedBorderTopColor`.
 * Transparent outlines and unchanged decorative shadows fail.
 */
async function activeHasVisibleFocus(page: Page, baseline: Tabbable): Promise<boolean> {
  return page.evaluate((base) => {
    const active = document.activeElement;
    if (!active || active === document.body) return false;
    const isVisibleColor = (color: string): boolean => {
      const normalized = color.trim().toLowerCase();
      if (!normalized || normalized === 'transparent') return false;
      const rgba = normalized.match(/^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*[,/]\s*([\d.]+))?\s*\)$/);
      if (rgba) {
        return rgba[1] === undefined ? true : Number.parseFloat(rgba[1]) > 0;
      }
      const srgb = normalized.match(/^color\([^)]*\/\s*([\d.]+)\s*\)$/);
      if (srgb) {
        return Number.parseFloat(srgb[1]) > 0;
      }
      return true;
    };
    const style = getComputedStyle(active);
    const outlineWidth = Number.parseFloat(style.outlineWidth) || 0;
    const hasVisibleOutline =
      style.outlineStyle !== 'none' &&
      (style.outlineStyle === 'auto' || outlineWidth > 0) &&
      isVisibleColor(style.outlineColor);
    const outlineChanged =
      style.outlineStyle !== base.unfocusedOutlineStyle ||
      outlineWidth !== base.unfocusedOutlineWidth ||
      style.outlineColor !== base.unfocusedOutlineColor;
    const shadow = style.boxShadow;
    const hasVisibleShadow =
      shadow !== 'none' &&
      shadow.trim() !== '' &&
      !/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(shadow.trim());
    const shadowChanged = shadow !== base.unfocusedBoxShadow;
    const borderWidth = Number.parseFloat(style.borderTopWidth) || 0;
    const hasVisibleBorder =
      style.borderTopStyle !== 'none' && borderWidth > 0 && isVisibleColor(style.borderTopColor);
    const borderChanged = style.borderTopColor !== base.unfocusedBorderTopColor;
    return (
      (hasVisibleOutline && outlineChanged) ||
      (hasVisibleShadow && shadowChanged) ||
      (hasVisibleBorder && borderChanged)
    );
  }, baseline);
}

/**
 * Keyboard path of one screen state: every required enabled control under the scope is reached by Tab, in DOM order,
 * that order matches the visual reading order (rows top to bottom, left to right within a row), and each focused control
 * shows a focus-specific visible focus indicator versus its unfocused baseline (JR1-7, JR1-8, JR1-9). With `trap`
 * (dialogs) Tab past the last control wraps to the first and Shift+Tab from the first wraps to the last, so focus never
 * leaves the scope. When `leaveFocusedSelector` is provided, Tab-walks from the current position onto that target so
 * the caller can activate it directly via `page.keyboard.press`.
 */
export async function keyboardWalk(
  page: Page,
  scopeSelector: string,
  label: string,
  options: KeyboardWalkOptions = {},
) {
  const tabbables = await markTabbables(page, scopeSelector);
  expect(tabbables.length, `keyboard ${label}: required controls under ${scopeSelector}`).toBeGreaterThan(0);

  for (let k = 1; k < tabbables.length; k += 1) {
    const prev = tabbables[k - 1];
    const cur = tabbables[k];
    const sameRow = Math.abs(cur.centerY - prev.centerY) <= 6;
    const inVisualOrder = sameRow ? cur.left >= prev.left - 2 : cur.centerY > prev.centerY;
    if (!inVisualOrder) {
      console.log(`keyboard ${label}: ${prev.label} then ${cur.label} is not in visual order`);
    }
    expect.soft(inVisualOrder, `keyboard ${label}: ${prev.label} then ${cur.label} is not in visual order`).toBe(true);
  }

  const focusRoot = async () =>
    page.evaluate((selector) => {
      const root = document.querySelector<HTMLElement>(selector);
      if (!root) return null;
      const previous = root.getAttribute('tabindex');
      root.setAttribute('tabindex', '-1');
      root.focus();
      return previous;
    }, scopeSelector);

  // Start right before the first control: a tabindex=-1 scope root becomes the sequential-focus starting point.
  const hadTabindex = await focusRoot();

  try {
    const press = async (key: 'Tab' | 'Shift+Tab', expected: number, what: string) => {
      await page.keyboard.press(key);
      const state = await activeTabState(page, scopeSelector);
      if (!state.contained) {
        console.log(`keyboard ${label}: ${what} (activeElement escaped ${scopeSelector})`);
      } else if (state.index !== expected) {
        console.log(`keyboard ${label}: ${what} (expected index ${expected}, got ${String(state.index)})`);
      }
      expect.soft(state.contained, `keyboard ${label}: ${what} (activeElement escaped ${scopeSelector})`).toBe(true);
      expect.soft(state.index, `keyboard ${label}: ${what}`).toBe(expected);
    };

    await press('Tab', 0, `first Tab reaches ${tabbables[0].label}`);
    for (let k = 0; k < tabbables.length; k += 1) {
      if (k > 0) await press('Tab', k, `Tab reaches ${tabbables[k].label}`);
      // Wait up to two animation frames so focus-visible styles settle under heavy parallel load before sampling.
      let hasFocus = await activeHasVisibleFocus(page, tabbables[k]);
      if (!hasFocus) {
        await page.evaluate(async () => {
          const { promise, resolve } = Promise.withResolvers<void>();
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          setTimeout(resolve, 100);
          await promise;
        });
        hasFocus = await activeHasVisibleFocus(page, tabbables[k]);
      }
      if (!hasFocus) {
        console.log(`keyboard ${label}: no visible focus change on ${tabbables[k].label}`);
      }
      expect
        .soft(hasFocus, `keyboard ${label}: no visible focus change on ${tabbables[k].label}`)
        .toBe(true);
    }
    if (options.trap) {
      await press('Tab', 0, `Tab after the last control wraps to ${tabbables[0].label}`);
      await press(
        'Shift+Tab',
        tabbables.length - 1,
        `Shift+Tab from the first wraps to ${tabbables[tabbables.length - 1].label}`,
      );
    }

    if (options.leaveFocusedSelector) {
      const targetIndex = await page.evaluate(
        ({ scope, targetSel }) => {
          const root = document.querySelector(scope);
          const target = root?.querySelector<HTMLElement>(targetSel);
          const raw = target?.getAttribute('data-a11y-tab');
          return raw === null || raw === undefined ? null : Number(raw);
        },
        { scope: scopeSelector, targetSel: options.leaveFocusedSelector },
      );
      expect(
        targetIndex,
        `keyboard ${label}: leaveFocusedSelector ${options.leaveFocusedSelector} not among required controls`,
      ).not.toBeNull();
      if (targetIndex !== null) {
        let current = (await activeTabState(page, scopeSelector)).index ?? -1;
        // Non-trapped scopes do not wrap on Tab after the last control; if targetIndex < current, reset to scope root.
        if (!options.trap && (current < 0 || targetIndex < current)) {
          await focusRoot();
          current = -1;
        }
        for (let guard = 0; guard < tabbables.length + 2 && current !== targetIndex; guard += 1) {
          const nextExpected = options.trap ? (current + 1) % tabbables.length : current + 1;
          await press('Tab', nextExpected, `Tab toward primary action ${tabbables[nextExpected]?.label ?? String(nextExpected)}`);
          current = nextExpected;
        }
        expect(current, `keyboard ${label}: parked focus on ${options.leaveFocusedSelector}`).toBe(targetIndex);
      }
    }
  } finally {
    await page.evaluate(
      ({ selector, previous }) => {
        const root = document.querySelector<HTMLElement>(selector);
        if (!root) return;
        if (previous === null) root.removeAttribute('tabindex');
        else root.setAttribute('tabindex', previous);
      },
      { selector: scopeSelector, previous: hadTabindex },
    );
  }
}

/**
 * Every screen state goes through here: for each of 390 / 768 / 1440 the viewport is resized (same page, same user), then
 * horizontal overflow, axe (wcag2a + wcag2aa, serious and critical must be 0) and the sanitized screenshot are taken.
 * Soft assertions: one CI run reports every offending state, not only the first.
 */
export async function checkState(ctx: A11yContext, spec: StateSpec) {
  for (const { width, height } of A11Y_WIDTHS) {
    await ctx.page.setViewportSize({ width, height });
    await settle(ctx.page, ctx.lang, ctx.theme);
    await expectNoHorizontalOverflow(ctx, spec, width);
    await runAxe(ctx, spec, width);
    await saveScreenshot(ctx, spec, width);
    if (ctx.keyboard && width === 1440) {
      await expectReducedMotion(ctx.page, spec.motionRoots, spec.screen);
    }
  }
}
