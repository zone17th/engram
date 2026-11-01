import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ItemSummary } from '../lib/api/content';
import { isolateRateLimit, patchSettingsViaPage } from './helpers';
import {
  A11Y_LANGS,
  A11Y_THEMES,
  A11Y_WIDTHS,
  expectAppAnimatesWithoutPreference,
  expectReducedMotion,
  type A11yLang,
  type A11yTheme,
} from './vault-journey-a11y';
import {
  expectLockedListOnApp,
  expectUnlockedOnApp,
  readRecoveryKeySlot,
  signupPasswordUser,
  unlockFromLockedList,
} from './vault-journey-support';
import {
  CRYPTO_WAIT_MS,
  UI_WAIT_MS,
  VAULT_PASSPHRASE,
  expectVaultOpen,
  isApiPost,
} from './vault-passkey-support';
import { fillSecret } from './vault-settings-secret';

// Note: `noCopyPrompt: true` in `playwright.config.ts` and `PLAYWRIGHT_NO_COPY_PROMPT: "1"` in `ci.yml`
// disable Playwright's automatic error-context DOM snapshot before worker startup.

export {
  A11Y_LANGS,
  A11Y_THEMES,
  A11Y_WIDTHS,
  expectAppAnimatesWithoutPreference,
  expectLockedListOnApp,
  expectReducedMotion,
  expectUnlockedOnApp,
  unlockFromLockedList,
  type A11yLang,
  type A11yTheme,
};

export const CONTENT_A11Y_UI_WAIT_MS = 30_000;
export const CONTENT_A11Y_SHOT_TIMEOUT_MS = 30_000;
export const CONTENT_A11Y_TEST_TIMEOUT_MS = 300_000;

export const CONTENT_A11Y_HOME_STATES = [
  'home',
  'omnibox-open',
  'picker',
  'undo-toast',
] as const;

export const CONTENT_A11Y_ITEM_STATES = [
  'item',
  'text-edit',
  'json-table',
  'json-raw',
  'json-error',
  'entry-menu',
  'item-undo-toast',
] as const;

export type ContentA11yHomeState = (typeof CONTENT_A11Y_HOME_STATES)[number];
export type ContentA11yItemState = (typeof CONTENT_A11Y_ITEM_STATES)[number];
export type ContentA11yState = ContentA11yHomeState | ContentA11yItemState;

export interface ContentA11yContext {
  readonly page: Page;
  readonly testInfo: TestInfo;
  readonly lang: A11yLang;
  readonly theme: A11yTheme;
  readonly keyboard: boolean;
}

export interface ContentStateSpec {
  readonly state: ContentA11yState;
  readonly axeInclude?: string;
  readonly motionRoots?: string;
  readonly fullPage?: boolean;
  readonly maskSelectors?: readonly string[];
  readonly allowedHorizontalScrollSelectors?: readonly string[];
}

export function contentA11yScreenshotName(
  state: ContentA11yState,
  lang: A11yLang,
  theme: A11yTheme,
  width: number,
): string {
  return `content-a11y-${state}-${lang}-${theme}-${width}.png`;
}

/**
 * Wraps `test.step` and logs a single timing line (`journey-step: <name> (<ms>ms)`) for CI visibility.
 * `name` must be a static literal, never user/entry data.
 */
export async function a11yStep<T>(name: string, body: () => Promise<T>): Promise<T> {
  const start = Date.now();
  console.log(`journey-step: ${name}`);
  try {
    return await test.step(name, body);
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const firstLine = (rawMessage.split(/\r?\n/)[0] ?? '').slice(0, 300);
    console.log(`journey-step-failed: ${name}: ${firstLine}`);
    throw error;
  } finally {
    const elapsed = Date.now() - start;
    console.log(`journey-step-done: ${name} (${elapsed}ms)`);
  }
}

/**
 * Quietly writes a value into an `<input>` or `<textarea>` via its prototype value setter and dispatches
 * a bubbling `input` event, avoiding `locator.fill()` so values never appear in Playwright timeout logs.
 */
export async function setQuietValue(
  locator: Locator,
  value: string,
  timeout = CONTENT_A11Y_UI_WAIT_MS,
): Promise<void> {
  await expect(locator).toBeEditable({ timeout });
  await locator.evaluate((element, nextValue) => {
    const isTextarea = element.tagName.toUpperCase() === 'TEXTAREA';
    const proto = isTextarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) {
      throw new Error('Value setter missing on element prototype');
    }
    setter.call(element, nextValue);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

/**
 * Boolean check that an input/textarea is empty without printing its current value on failure.
 */
export async function expectInputEmpty(
  locator: Locator,
  timeout = CONTENT_A11Y_UI_WAIT_MS,
): Promise<void> {
  await expect
    .poll(
      async () =>
        locator.evaluate(
          (el) => (el as HTMLInputElement | HTMLTextAreaElement).value.length === 0,
        ),
      { timeout },
    )
    .toBe(true);
}

/**
 * Boolean check that an input/textarea equals `expected` without printing either value on failure.
 */
export async function expectInputEquals(
  locator: Locator,
  expected: string,
  timeout = CONTENT_A11Y_UI_WAIT_MS,
): Promise<void> {
  await expect
    .poll(
      async () =>
        locator.evaluate(
          (el, exp) => (el as HTMLInputElement | HTMLTextAreaElement).value === exp,
          expected,
        ),
      { timeout },
    )
    .toBe(true);
}

/**
 * Attaches a request listener on `context` that asserts none of `forbiddenBodies` ever appears
 * in any request URL, header, or postData (user-dec-016, P04-A4).
 */
export function attachPlaintextLeakGuard(
  context: BrowserContext,
  forbiddenBodies: ReadonlyArray<{ readonly label: string; readonly value: string }>,
): {
  assertNoLeaks: () => void;
  assertSawEntriesPost: () => void;
} {
  const leaks: string[] = [];
  let entriesPostCount = 0;

  context.on('request', (req) => {
    const url = req.url();
    const pathname = new URL(url).pathname;
    if (req.method() === 'POST' && /^\/api\/v1\/items\/[^/]+\/entries$/.test(pathname)) {
      entriesPostCount += 1;
    }
    const headersText = JSON.stringify(req.headers());
    const postData = req.postData() ?? '';
    for (const item of forbiddenBodies) {
      if (!item.value) continue;
      if (url.includes(item.value)) {
        leaks.push(`${req.method()} ${pathname} leaked ${item.label} in URL`);
      }
      if (headersText.includes(item.value)) {
        leaks.push(`${req.method()} ${pathname} leaked ${item.label} in headers`);
      }
      if (postData.includes(item.value)) {
        leaks.push(`${req.method()} ${pathname} leaked ${item.label} in postData`);
      }
    }
  });

  return {
    assertNoLeaks: () => {
      expect(leaks, `Plaintext body leak detected in network requests: ${leaks.join('; ')}`).toEqual(
        [],
      );
    },
    assertSawEntriesPost: () => {
      expect(
        entriesPostCount,
        'Plaintext leak guard positive control: expected at least 1 POST to /api/v1/items/<id>/entries',
      ).toBeGreaterThanOrEqual(1);
    },
  };
}

/**
 * Scans every element attribute across the live DOM to verify that none of `forbiddenPlaintexts`
 * appears in any attribute (`title`, `aria-label`, `aria-description`, `data-*`, `placeholder`,
 * `alt`, `href`, or non-secret `value` attribute) per plan §2.10 (`P4FE2-10`).
 */
export async function expectNoPlaintextInDomAttributes(
  page: Page,
  forbiddenPlaintexts: ReadonlyArray<{ readonly label: string; readonly value: string }>,
): Promise<void> {
  const violations = await page.evaluate((items) => {
    const found: string[] = [];
    const elements = Array.from(document.querySelectorAll('*'));
    for (const el of elements) {
      const isSecretInput = el.hasAttribute('data-vault-secret');
      for (const attr of Array.from(el.attributes)) {
        if (isSecretInput && attr.name === 'value') continue;
        for (const item of items) {
          if (item.value && attr.value.includes(item.value)) {
            found.push(
              `<${el.tagName.toLowerCase()}> attr "${attr.name}" contains ${item.label}`,
            );
          }
        }
      }
    }
    return found;
  }, forbiddenPlaintexts);

  expect(violations, `DOM attribute plaintext leak: ${violations.join('; ')}`).toEqual([]);
}

/**
 * Sets the signed-in user's locale and theme via `PATCH /api/v1/me/settings` and aligns cookies + media.
 */
export async function applyContentLangAndTheme(
  page: Page,
  lang: A11yLang,
  theme: A11yTheme,
): Promise<void> {
  expect((await patchSettingsViaPage(page, { locale: lang, theme })).status).toBe(200);
  const origin = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:3000').origin;
  await page.context().setExtraHTTPHeaders({
    'accept-language': lang === 'vi' ? 'vi-VN,vi;q=0.9,en;q=0.8' : 'en-US,en;q=0.9',
  });
  await page.context().addCookies([
    { name: 'sabk_locale', value: lang, url: `${origin}/` },
    { name: 'sabk_theme', value: theme, url: `${origin}/` },
  ]);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
}

/**
 * Completes onboarding (step 1 passphrase -> step 2 10-slot recovery-key sheet -> POST /vault -> step 3 skip)
 * using stable `#onboarding-*` IDs and `data-testid` selectors so it works in both `en` and `vi` locales.
 */
async function completeOnboardingAnyLocale(page: Page, passphrase: string): Promise<void> {
  await expect(page).toHaveURL(/\/app\/onboarding$/, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('onboarding-step-passphrase')).toBeVisible({
    timeout: CRYPTO_WAIT_MS,
  });
  await fillSecret(page.locator('#onboarding-passphrase'), passphrase, CRYPTO_WAIT_MS);
  await fillSecret(page.locator('#onboarding-confirm-passphrase'), passphrase, CRYPTO_WAIT_MS);
  await page.getByTestId('onboarding-continue-button').click();

  await expect(page.getByTestId('onboarding-step-recovery-keys')).toBeVisible({
    timeout: CRYPTO_WAIT_MS,
  });
  await expect(page.getByTestId('recovery-keys-grid').getByRole('listitem')).toHaveCount(10);
  const slot1 = await readRecoveryKeySlot(page, 1);
  const slot2 = await readRecoveryKeySlot(page, 2);
  expect(slot1 !== slot2).toBe(true);

  await page.getByTestId('recovery-keys-confirm-checkbox').check();
  const created = page.waitForResponse((r) => isApiPost(r, '/api/v1/vault'), {
    timeout: CRYPTO_WAIT_MS,
  });
  await page.getByTestId('onboarding-create-vault-button').click();
  expect((await created).status()).toBe(201);

  await expect(page.getByTestId('onboarding-step-passkey')).toBeVisible({ timeout: UI_WAIT_MS });
  await expect(page.getByTestId('onboarding-remember-device-switch')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.getByTestId('onboarding-skip-passkey-button').click();
  await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
  await expectVaultOpen(page);
}

/**
 * Signs up a fresh password user, applies `lang` and `theme` cookies + settings BEFORE onboarding,
 * reloads `/app/onboarding` so NextIntlClientProvider SSRs `messages/<lang>.json`, and completes
 * onboarding (with passkey skip) so the page lands on `/app` already unlocked in `lang`/`theme`
 * without needing any post-onboarding full navigation that would lock the in-memory vault key.
 */
export async function bootstrapUnlockedUser(
  page: Page,
  email: string,
  lang: A11yLang,
  theme: A11yTheme,
  passphrase = VAULT_PASSPHRASE,
): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await signupPasswordUser(page, email);
  await applyContentLangAndTheme(page, lang, theme);
  await page.goto('/app/onboarding', {
    waitUntil: 'domcontentloaded',
    timeout: CONTENT_A11Y_UI_WAIT_MS,
  });
  await completeOnboardingAnyLocale(page, passphrase);
  await expectUnlockedOnApp(page);
}

/**
 * Unlocks the vault on a page that landed on `/app` in the locked state (e.g. a freshly opened
 * coarse-pointer context page that inherited session cookies but has a fresh Worker without the in-memory key).
 */
export async function unlockLockedAppPage(
  page: Page,
  passphrase = VAULT_PASSPHRASE,
): Promise<void> {
  await expectLockedListOnApp(page);
  await unlockFromLockedList(page, passphrase);
}
export async function apiLookupItems(
  page: Page,
  name: string,
): Promise<{ items: ItemSummary[]; total: number }> {
  return page.evaluate(async (lookupName) => {
    const res = await fetch(`/api/v1/items/lookup?name=${encodeURIComponent(lookupName)}`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    return (await res.json()) as { items: ItemSummary[]; total: number };
  }, name);
}

async function settleViewport(page: Page, lang: A11yLang, theme: A11yTheme): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme, {
    timeout: CONTENT_A11Y_UI_WAIT_MS,
  });
  await expect(page.locator('html')).toHaveAttribute('lang', lang, {
    timeout: CONTENT_A11Y_UI_WAIT_MS,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    const frames = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => frames.resolve()));
    const bound = Promise.withResolvers<void>();
    setTimeout(bound.resolve, 1_000);
    await Promise.race([frames.promise, bound.promise]);
  });
}

/**
 * Tags any non-empty `<input>` (excluding the public item name/hint inputs), `<textarea>`,
 * or `[contenteditable]` element with `data-visual-mask="true"` so `saveContentScreenshot`
 * masks secret/body inputs and editors if any exist on screen (ACC-A11Y1-1).
 */
async function tagSecretInputsForMask(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('input'))) {
      if (input.type === 'checkbox' || input.type === 'radio' || input.type === 'hidden') continue;
      if (input.id === 'item-name-input' || input.id === 'item-hint-input') {
        input.removeAttribute('data-visual-mask');
        continue;
      }
      if (input.hasAttribute('data-vault-secret') && input.value !== '') {
        input.setAttribute('data-visual-mask', 'true');
      } else {
        input.removeAttribute('data-visual-mask');
      }
    }
    for (const ta of Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea'))) {
      if (ta.value !== '' || (ta.hasAttribute('data-vault-secret') && !ta.hasAttribute('data-omnibox-input'))) {
        ta.setAttribute('data-visual-mask', 'true');
      } else {
        ta.removeAttribute('data-visual-mask');
      }
    }
    for (const ce of Array.from(document.querySelectorAll<HTMLElement>('[contenteditable]'))) {
      const attr = ce.getAttribute('contenteditable');
      if (attr !== 'false' && (ce.textContent ?? '').length > 0) {
        ce.setAttribute('data-visual-mask', 'true');
      } else {
        ce.removeAttribute('data-visual-mask');
      }
    }
  });
}

async function saveContentScreenshot(
  ctx: ContentA11yContext,
  spec: ContentStateSpec,
  width: number,
): Promise<void> {
  const { page, testInfo, lang, theme } = ctx;
  const fullPage = spec.fullPage ?? true;
  await tagSecretInputsForMask(page);

  if (fullPage) {
    await page.evaluate(async () => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      const frames = Promise.withResolvers<void>();
      requestAnimationFrame(() => requestAnimationFrame(() => frames.resolve()));
      const bound = Promise.withResolvers<void>();
      setTimeout(bound.resolve, 1_000);
      await Promise.race([frames.promise, bound.promise]);
    });
  }

  const fileName = contentA11yScreenshotName(spec.state, lang, theme, width);
  const outputPath = testInfo.outputPath(fileName);
  mkdirSync(dirname(outputPath), { recursive: true });
  const buffer = await page.screenshot({
    path: outputPath,
    timeout: CONTENT_A11Y_SHOT_TIMEOUT_MS,
    fullPage,
    animations: 'disabled',
    caret: 'hide',
    mask: [
      page.locator('[data-visual-mask]'),
      page.getByTestId('recovery-keys-grid'),
      page.locator('[data-testid^="recovery-key-slot-"]'),
      page.locator('p[data-testid="entry-body"], pre[data-testid="entry-body"]'),
      page.locator('textarea[data-vault-secret]:not([data-omnibox-input])'),
      page.locator('input[data-vault-secret]'),
      page.locator('[data-testid^="json-cell-btn-"]'),
      page.locator('[data-testid^="json-cell-input-"]'),
      page.locator('[data-testid^="json-readonly-cell-"]'),
      page.locator('[data-testid^="json-raw-textarea-"]'),
      page.locator('#omni textarea[data-vault-secret][data-visual-mask]'),
      ...(spec.maskSelectors ?? []).map((sel) => page.locator(sel)),
    ],
  });
  expect.soft(buffer.byteLength, `screenshot ${fileName}`).toBeGreaterThan(0);
}

/**
 * Runs `@axe-core/playwright` with the P02/P03 WCAG 2A + 2AA tag set and asserts 0 violations
 * (all impacts: critical, serious, moderate, minor). No rules are disabled.
 */
async function runContentAxe(
  ctx: ContentA11yContext,
  spec: ContentStateSpec,
  width: number,
): Promise<void> {
  const { page, lang, theme } = ctx;
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']);
  if (spec.axeInclude) {
    builder = builder.include(spec.axeInclude);
  }
  const results = await builder.analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious');
  const critical = results.violations.filter((v) => v.impact === 'critical');
  console.log(
    `axe ${spec.state} ${lang} ${theme} ${width}: serious=${serious.length} critical=${critical.length} (total=${results.violations.length})`,
  );
  const detail = results.violations
    .map(
      (v) =>
        `${v.id} (${String(v.impact)}): ${v.nodes.map((n) => JSON.stringify(n.target)).join(' | ')}`,
    )
    .join('; ');
  expect
    .soft(results.violations.length, `axe ${spec.state} ${lang} ${theme} ${width}: ${detail}`)
    .toBe(0);
}

async function expectNoHorizontalOverflowAtWidth(
  ctx: ContentA11yContext,
  spec: ContentStateSpec,
  width: number,
  extraSelectors: readonly string[] = [],
): Promise<void> {
  const allowedScrollSelectors = spec.allowedHorizontalScrollSelectors ?? [];
  const metrics = await ctx.page.evaluate(
    ({ selectors, allowedScrollSels }) => {
      const scrollWidth = document.documentElement.scrollWidth;
      const clientWidth = document.documentElement.clientWidth;
      const innerWidth = window.innerWidth;
      const overflowingContainers: string[] = [];
      const hasEllipsisOrLineClamp = (st: CSSStyleDeclaration): boolean => {
        const ox = st.overflowX;
        const isHiddenOrClip = ox === 'hidden' || ox === 'clip';
        if (!isHiddenOrClip) return false;
        if (st.textOverflow === 'ellipsis' && st.whiteSpace === 'nowrap') {
          return true;
        }
        const clamp = st.getPropertyValue('-webkit-line-clamp').trim();
        return Boolean(clamp && clamp !== 'none' && Number.parseInt(clamp, 10) > 0);
      };

      const isIntentionalTruncation = (el: HTMLElement, st: CSSStyleDeclaration): boolean => {
        if (hasEllipsisOrLineClamp(st)) return true;
        const children = Array.from(el.children).filter((child): child is HTMLElement => {
          if (!(child instanceof HTMLElement)) return false;
          if (child.classList.contains('sr-only') || child.getAttribute('aria-hidden') === 'true') {
            return false;
          }
          const cs = getComputedStyle(child);
          return cs.display !== 'none' && cs.visibility !== 'hidden';
        });
        if (children.length === 1) {
          const onlyChild = children[0]!;
          const hasNonEmptyDirectTextSibling = Array.from(el.childNodes).some(
            (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length > 0,
          );
          if (!hasNonEmptyDirectTextSibling && hasEllipsisOrLineClamp(getComputedStyle(onlyChild))) {
            return true;
          }
        }
        return false;
      };

      for (const sel of selectors) {
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const rect = el.getBoundingClientRect();
          const overflowX = style.overflowX;
          const isExplicitScrollHost = allowedScrollSels.some((allowSel) => el.matches(allowSel));
          if ((overflowX === 'auto' || overflowX === 'scroll') && isExplicitScrollHost) {
            // Explicitly allowlisted horizontal scroll container (e.g. `json-table-host-<id>`):
            // its box itself must stay within the viewport, while inner `scrollWidth > clientWidth` is valid.
            if (rect.left < -1 || rect.right > clientWidth + 1) {
              overflowingContainers.push(
                `${sel} (scroll container spills past viewport: left=${Math.round(rect.left)} right=${Math.round(rect.right)} > clientWidth=${clientWidth})`,
              );
            }
            continue;
          }
          if (rect.left < -1 || rect.right > clientWidth + 1) {
            overflowingContainers.push(
              `${sel} (overflow-x=${overflowX} spills past viewport: left=${Math.round(rect.left)} right=${Math.round(rect.right)} > clientWidth=${clientWidth})`,
            );
          } else if (el.scrollWidth > el.clientWidth + 1) {
            if (isIntentionalTruncation(el, style)) {
              continue;
            }
            overflowingContainers.push(
              `${sel} (overflow-x=${overflowX} cuts off or overflows content: scrollWidth=${el.scrollWidth} > clientWidth=${el.clientWidth})`,
            );
          }
        }
      }
      return { scrollWidth, clientWidth, innerWidth, overflowingContainers };
    },
    { selectors: extraSelectors, allowedScrollSels: allowedScrollSelectors },
  );

  console.log(
    `overflow ${spec.state} ${ctx.lang} ${ctx.theme} ${width}: scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth} innerWidth=${metrics.innerWidth}`,
  );
  expect
    .soft(
      metrics.scrollWidth,
      `horizontal overflow ${spec.state} ${ctx.lang} ${ctx.theme} ${width}: scrollWidth ${metrics.scrollWidth} > clientWidth ${metrics.clientWidth}`,
    )
    .toBeLessThanOrEqual(metrics.clientWidth);
  expect
    .soft(
      metrics.overflowingContainers,
      `container overflow ${spec.state} ${ctx.lang} ${ctx.theme} ${width}`,
    )
    .toEqual([]);
}

/**
 * Asserts that a horizontal scroll region (such as `[data-testid="json-table-host-<id>"]` at 390 px)
 * has `overflow-x` set to `auto` or `scroll`, has `scrollWidth > clientWidth`, and actually scrolls
 * horizontally (`scrollLeft > 0`) while the document itself stays within the viewport width.
 */
export async function expectHorizontallyScrollable(
  page: Page,
  selector: string,
  label: string,
): Promise<void> {
  const result = await page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return null;
    const style = getComputedStyle(el);
    const overflowX = style.overflowX;
    const scrollWidth = el.scrollWidth;
    const clientWidth = el.clientWidth;
    const docScrollWidth = document.documentElement.scrollWidth;
    const docClientWidth = document.documentElement.clientWidth;
    const prevScrollLeft = el.scrollLeft;
    el.scrollLeft = Math.min(48, Math.max(1, scrollWidth - clientWidth));
    const scrolledLeft = el.scrollLeft;
    el.scrollLeft = prevScrollLeft;
    return {
      overflowX,
      scrollWidth,
      clientWidth,
      scrolledLeft,
      docScrollWidth,
      docClientWidth,
    };
  }, selector);

  expect(result, `horizontal scroll region (${label}): ${selector} not found`).not.toBeNull();
  expect(
    ['auto', 'scroll'],
    `horizontal scroll region (${label}): ${selector} overflow-x=${result?.overflowX}`,
  ).toContain(result!.overflowX);
  expect(
    result!.scrollWidth,
    `horizontal scroll region (${label}): ${selector} scrollWidth=${result?.scrollWidth} must exceed clientWidth=${result?.clientWidth}`,
  ).toBeGreaterThan(result!.clientWidth);
  expect(
    result!.scrolledLeft,
    `horizontal scroll region (${label}): ${selector} failed to advance scrollLeft`,
  ).toBeGreaterThan(0);
  expect(
    result!.docScrollWidth,
    `horizontal scroll region (${label}): document scrollWidth=${result?.docScrollWidth} must not exceed clientWidth=${result?.docClientWidth}`,
  ).toBeLessThanOrEqual(result!.docClientWidth);
}

/**
 * Sweeps a screen state across 390 / 768 / 1440 on the current page:
 * - resizes viewport and waits for fonts + 2 animation frames
 * - asserts no horizontal overflow (`document.documentElement.scrollWidth <= clientWidth` + container checks)
 * - runs axe (`wcag2a`, `wcag2aa`, 0 violations)
 * - saves allowlisted screenshot `content-a11y-<state>-<lang>-<theme>-<width>.png`
 * - in the keyboard pass (`en`, `light`) at 1440, asserts `expectReducedMotion`
 */
export async function checkContentState(
  ctx: ContentA11yContext,
  spec: ContentStateSpec,
  overflowSelectors: readonly string[] = [],
): Promise<void> {
  for (const { width, height } of A11Y_WIDTHS) {
    await ctx.page.setViewportSize({ width, height });
    await settleViewport(ctx.page, ctx.lang, ctx.theme);
    await expectNoHorizontalOverflowAtWidth(ctx, spec, width, overflowSelectors);
    await runContentAxe(ctx, spec, width);
    await saveContentScreenshot(ctx, spec, width);
    if (ctx.keyboard && width === 1440) {
      await expectReducedMotion(ctx.page, spec.motionRoots ?? 'body', spec.state);
    }
  }
}

export const GENERIC_COARSE_INTERACTIVE_SELECTOR =
  'button, [role="button"], [role="menuitem"], [role="tab"], a[href], input, select, textarea';

export interface TouchTargetMeasurement {
  readonly selector: string;
  readonly count: number;
  readonly minWidth: number;
  readonly minHeight: number;
  readonly effectiveHeight: number;
  readonly effectiveWidth: number;
  readonly below44: ReadonlyArray<{
    readonly selector: string;
    readonly index: number;
    readonly descriptor: string;
    readonly width: number;
    readonly height: number;
    readonly effectiveWidth: number;
    readonly effectiveHeight: number;
    readonly pseudoHitOk: boolean;
    readonly pseudoCornerMisses?: string;
  }>;
}

/**
 * Creates a mobile coarse-pointer context (`hasTouch: true, isMobile: true`, viewport 390x844)
 * with rate-limit isolation and the current page's cookies copied over so the session is already signed in.
 */
export async function newCoarseTouchContext(
  browser: Browser,
  sourceContext?: BrowserContext,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  await isolateRateLimit(context);
  if (sourceContext) {
    const cookies = await sourceContext.cookies();
    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }
  }
  return context;
}

/**
 * Measures the hit area of interactive controls matching `selectors` under `(pointer: coarse)` at 390 px.
 * Width rule: 44 x 44 px (plan §606, ACC-A11Y1-5).
 * For elements with bounding box < 44 px, accepts a `::after` / `::before` pseudo-element expansion
 * ONLY when an `elementFromPoint` hit test at all 4 corners of the claimed box (inset 1 px) returns
 * the element itself or a descendant (scrolling the element into the viewport first so `elementFromPoint` can sample it).
 */
export async function measureCoarseTouchTargets(
  page: Page,
  selectors: readonly string[] = [GENERIC_COARSE_INTERACTIVE_SELECTOR],
): Promise<TouchTargetMeasurement[]> {
  const pointerCoarseMatches = await page.evaluate(
    () => window.matchMedia('(pointer: coarse)').matches,
  );
  expect(pointerCoarseMatches, 'context must match (pointer: coarse)').toBe(true);

  return page.evaluate((selList) => {
    const results: TouchTargetMeasurement[] = [];
    const openModals = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]'));
    const activeModal = openModals.length > 0 ? openModals[openModals.length - 1]! : null;

    const describeElement = (el: HTMLElement): string => {
      const tag = el.tagName.toLowerCase();
      const testId = el.getAttribute('data-testid');
      const id = el.id ? `#${el.id}` : '';
      const role = el.getAttribute('role') ? `[role="${el.getAttribute('role')}"]` : '';
      const cls =
        typeof el.className === 'string' && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
          : '';
      const href = tag === 'a' ? el.getAttribute('href') : null;
      return `${tag}${id}${testId ? `[data-testid="${testId}"]` : ''}${href ? `[href="${href}"]` : ''}${role}${cls}`;
    };

    for (const selector of selList) {
      const elements = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((el) => {
        if (activeModal && !activeModal.contains(el)) return false;
        if (el.closest('[hidden], [aria-hidden="true"]')) return false;
        if ((el as HTMLInputElement).type === 'hidden') return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        );
      });

      let minWidth = Infinity;
      let minHeight = Infinity;
      let minEffWidth = Infinity;
      let minEffHeight = Infinity;
      const below44: Array<{
        selector: string;
        index: number;
        descriptor: string;
        width: number;
        height: number;
        effectiveWidth: number;
        effectiveHeight: number;
        pseudoHitOk: boolean;
        pseudoCornerMisses?: string;
      }> = [];

      elements.forEach((el, index) => {
        let rect = el.getBoundingClientRect();
        const w = Math.round(rect.width * 100) / 100;
        const h = Math.round(rect.height * 100) / 100;

        let effW = w;
        let effH = h;
        let pseudoHitOk = false;
        let pseudoCornerMisses: string | undefined;

        if (w < 43.5 || h < 43.5) {
          const parsePx = (val: string): number => {
            const n = Number.parseFloat(val);
            return Number.isFinite(n) ? n : 0;
          };
          const expandWithPseudo = (
            r: DOMRect,
            st: CSSStyleDeclaration,
          ): { left: number; top: number; right: number; bottom: number } => {
            if (
              !st.content ||
              st.content === 'none' ||
              st.content === 'normal' ||
              st.display === 'none'
            ) {
              return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
            }
            const wPx = parsePx(st.width);
            const hPx = parsePx(st.height);
            const topInset = parsePx(st.top);
            const rightInset = parsePx(st.right);
            const bottomInset = parsePx(st.bottom);
            const leftInset = parsePx(st.left);
            const effWFromBox = Math.max(r.width, wPx, r.width - leftInset - rightInset);
            const effHFromBox = Math.max(r.height, hPx, r.height - topInset - bottomInset);
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            return {
              left: Math.min(r.left, r.left + leftInset, cx - effWFromBox / 2),
              top: Math.min(r.top, r.top + topInset, cy - effHFromBox / 2),
              right: Math.max(r.right, r.right - rightInset, cx + effWFromBox / 2),
              bottom: Math.max(r.bottom, r.bottom - bottomInset, cy + effHFromBox / 2),
            };
          };

          el.scrollIntoView({ block: 'center', inline: 'center' });
          rect = el.getBoundingClientRect();
          const afterBounds = expandWithPseudo(rect, getComputedStyle(el, '::after'));
          const beforeBounds = expandWithPseudo(rect, getComputedStyle(el, '::before'));
          const effLeft = Math.min(rect.left, afterBounds.left, beforeBounds.left);
          const effTop = Math.min(rect.top, afterBounds.top, beforeBounds.top);
          const effRight = Math.max(rect.right, afterBounds.right, beforeBounds.right);
          const effBottom = Math.max(rect.bottom, afterBounds.bottom, beforeBounds.bottom);
          const candW = effRight - effLeft;
          const candH = effBottom - effTop;

          if (candW >= 43.5 && candH >= 43.5) {
            const cx = (effLeft + effRight) / 2;
            const cy = (effTop + effBottom) / 2;
            // Inset 1.5 px from the 44x44 effective box edges so subpixel flex centering
            // (e.g. cy = 33.5 in the 68px sticky header) stays strictly inside the control's hit box.
            const halfW = candW / 2 - 1.5;
            const halfH = candH / 2 - 1.5;
            const corners: Array<[number, number]> = [
              [cx - halfW, cy - halfH],
              [cx + halfW, cy - halfH],
              [cx - halfW, cy + halfH],
              [cx + halfW, cy + halfH],
            ];
            // Diagnostics only (structure, never text): which element each missed corner hits.
            const misses: string[] = [];
            corners.forEach(([px, py], ci) => {
              if (px < 0 || py < 0 || px >= window.innerWidth || py >= window.innerHeight) {
                misses.push(`c${ci}:offscreen`);
                return;
              }
              const hit = document.elementFromPoint(px, py);
              if (!(hit && (hit === el || el.contains(hit)))) {
                misses.push(`c${ci}:${hit instanceof HTMLElement ? describeElement(hit) : hit ? hit.nodeName.toLowerCase() : 'null'}`);
              }
            });
            const allHit = misses.length === 0;
            if (!allHit) pseudoCornerMisses = misses.join(' ');
            if (allHit) {
              effW = Math.round(candW * 100) / 100;
              effH = Math.round(candH * 100) / 100;
              pseudoHitOk = true;
            }
          }

          // Generic label/wrapper hit target for a text field (`input`, `textarea`, `select`) whose
          // associated `<label>` wrapper focuses it on click/tap (`label.control === el`):
          // verify with the 4-corner `elementFromPoint` hit test on the label's bounding box that every
          // corner reaches `label` or a descendant without hitting a separate nested interactive control.
          if (
            (effW < 43.5 || effH < 43.5) &&
            (el instanceof HTMLTextAreaElement ||
              el instanceof HTMLInputElement ||
              el instanceof HTMLSelectElement)
          ) {
            const labelWrapper = el.closest('label');
            if (labelWrapper && labelWrapper.control === el) {
              labelWrapper.scrollIntoView({ block: 'center', inline: 'center' });
              const lRect = labelWrapper.getBoundingClientRect();
              const lw = Math.round(lRect.width * 100) / 100;
              const lh = Math.round(lRect.height * 100) / 100;
              if (lw >= 43.5 && lh >= 43.5) {
                // Hit testing follows border-radius, so a point 1 px inside a rounded corner misses the box.
                // Inset each corner by 30% of its radius (a point on the 45-degree arc is at ~0.29 r) plus 1 px.
                const ls = getComputedStyle(labelWrapper);
                const rad = (v: string) => Math.ceil((parseFloat(v) || 0) * 0.3) + 1;
                const tl = rad(ls.borderTopLeftRadius);
                const tr = rad(ls.borderTopRightRadius);
                const bl = rad(ls.borderBottomLeftRadius);
                const br = rad(ls.borderBottomRightRadius);
                const corners: Array<[number, number]> = [
                  [lRect.left + tl, lRect.top + tl],
                  [lRect.right - tr, lRect.top + tr],
                  [lRect.left + bl, lRect.bottom - bl],
                  [lRect.right - br, lRect.bottom - br],
                ];
                const labelCornersHit = corners.every(([px, py]) => {
                  if (px < 0 || py < 0 || px >= window.innerWidth || py >= window.innerHeight) {
                    return false;
                  }
                  const hit = document.elementFromPoint(px, py);
                  if (!hit || !labelWrapper.contains(hit)) return false;
                  const interactiveHit = hit.closest(
                    'button, a[href], input, select, textarea, [role="button"], [role="menuitem"], [role="tab"]',
                  );
                  return !interactiveHit || interactiveHit === el;
                });
                if (labelCornersHit) {
                  effW = lw;
                  effH = lh;
                }
              }
            }
          }
        }

        minWidth = Math.min(minWidth, w);
        minHeight = Math.min(minHeight, h);
        minEffWidth = Math.min(minEffWidth, effW);
        minEffHeight = Math.min(minEffHeight, effH);

        if (effW < 43.5 || effH < 43.5) {
          below44.push({
            selector,
            index,
            descriptor: describeElement(el),
            width: w,
            height: h,
            effectiveWidth: effW,
            effectiveHeight: effH,
            pseudoHitOk,
            pseudoCornerMisses,
          });
        }
      });

      results.push({
        selector,
        count: elements.length,
        minWidth: elements.length > 0 ? minWidth : 0,
        minHeight: elements.length > 0 ? minHeight : 0,
        effectiveWidth: elements.length > 0 ? minEffWidth : 0,
        effectiveHeight: elements.length > 0 ? minEffHeight : 0,
        below44,
      });
    }
    return results;
  }, selectors);
}

/**
 * Known product controls below 44x44 px under a coarse pointer (advisor-dec-217, ACC-FE2-1). Each entry is an anchored
 * pattern on the exact element descriptor, carries `minW`/`minH` size floors (minimum observed CI size rounded down per
 * axis; 43.5 where observed height is already 44), and names the unit that fixes it; remove the entry when that unit merges.
 * Any listed control that falls below its `minW`/`minH` floor, or any unlisted control below 44x44 px, fails the sweep.
 */
export const KNOWN_UI_TOUCH_44: ReadonlyArray<{
  readonly unit: string;
  readonly control: string;
  readonly descriptor: RegExp;
  readonly minW: number;
  readonly minH: number;
}> = [
  {
    unit: 'w4fix FU11',
    control: 'item tag chip #tag link',
    descriptor: /^a\[href="\/app\?tag=[^"]+"\]\.text-body\.no-underline$/,
    minW: 38,
    minH: 21,
  },
  {
    unit: 'w4fix FU11',
    control: 'breadcrumb All items link',
    descriptor: /^a\[href="\/app"\]\.font-medium\.text-body\.no-underline$/,
    minW: 49,
    minH: 16,
  },
  {
    unit: 'w4fix FU11',
    control: 'json cell button (short value)',
    descriptor: /^button\[data-testid="json-cell-btn-[^"]+"\]\.json-cell-btn\.rounded\.border$/,
    minW: 29,
    minH: 43.5,
  },
  {
    unit: 'w4fix FU11',
    control: 'json field delete x',
    descriptor: /^button\[data-testid="json-remove-field-[^"]+"\]\.btn\.btn-tertiary\.btn-sm$/,
    minW: 26,
    minH: 43.5,
  },
  {
    unit: 'w4fix FU11',
    control: 'json row delete x',
    descriptor: /^button\[data-testid="json-remove-row-[^"]+"\]\.btn\.btn-tertiary\.btn-sm$/,
    minW: 26,
    minH: 43.5,
  },
  // advisor-dec-223: the inline JSON cell editor input is 28 px tall under a coarse pointer (CI 41351378645).
  {
    unit: 'w4fix FU11',
    control: 'json cell editor input',
    descriptor: /^input\[data-testid="json-cell-input-[^"]+"\]\.field-input\.json-cell-input\.px-2$/,
    minW: 281,
    minH: 27,
  },
  // advisor-dec-224: the cell editor commit button is 41.75 px wide (btn-sm has no coarse min-width; CI 41352191394).
  // json-cancel-cell-* and json-type-select-* are pre-approved under FU11 but listed only once a run shows them < 44.
  {
    unit: 'w4fix FU11',
    control: 'json cell editor commit button',
    descriptor: /^button\[data-testid="json-commit-cell-[^"]+"\]\.btn\.btn-primary\.btn-sm$/,
    minW: 41,
    minH: 43.5,
  },
  // advisor-dec-221: the 44x44 ::after of the item tag remove x overlaps the #tag link and the tag group (CI 41350488609).
  {
    unit: 'w4fix FU11',
    control: 'item tag remove x',
    descriptor: /^button\[data-testid="item-tag-remove-[^"]+"\]\.chip-x\.cursor-pointer\.border-0$/,
    minW: 8,
    minH: 15,
  },
];

const knownTouchGap = (descriptor: string) =>
  KNOWN_UI_TOUCH_44.find((k) => k.descriptor.test(descriptor));

/**
 * Generic 44x44 px touch-target sweep on a coarse-pointer mobile state (ACC-A11Y1-5, ACC-FE2-1).
 * Sweeps all visible interactive controls (`GENERIC_COARSE_INTERACTIVE_SELECTOR` plus any explicit `selectors`)
 * and asserts both effective width >= 44 px and effective height >= 44 px (using soft assertions so every
 * coarse state in the test is swept and any product control below 44x44 is logged in full).
 */
export async function expectCoarseTouchTargetsAtLeast44(
  page: Page,
  stateLabel: string,
  selectors: readonly string[] = [GENERIC_COARSE_INTERACTIVE_SELECTOR],
): Promise<void> {
  const combinedSelectors = selectors.includes(GENERIC_COARSE_INTERACTIVE_SELECTOR)
    ? selectors
    : [GENERIC_COARSE_INTERACTIVE_SELECTOR, ...selectors];
  const measurements = await measureCoarseTouchTargets(page, combinedSelectors);
  console.log(
    `touch-target-known-list ${stateLabel}: ${KNOWN_UI_TOUCH_44.map((k) => `[${k.unit}] ${k.control} (min ${k.minW}x${k.minH})`).join('; ')}`,
  );

  for (const m of measurements) {
    console.log(
      `touch-target ${stateLabel} ${m.selector}: count=${m.count} effW=${m.effectiveWidth} effH=${m.effectiveHeight} below44=${m.below44.length}`,
    );
    expect
      .soft(
        m.count,
        `touch target (${stateLabel}): expected at least 1 visible element for ${m.selector}`,
      )
      .toBeGreaterThan(0);
    const known = m.below44.filter((b) => knownTouchGap(b.descriptor));
    const unknown = m.below44.filter((b) => !knownTouchGap(b.descriptor));
    for (const b of known) {
      const k = knownTouchGap(b.descriptor)!;
      console.log(
        `touch-target-known-gap ${stateLabel} [${k.unit}] ${k.control}: ${b.descriptor} ${b.effectiveWidth}x${b.effectiveHeight} (floor ${k.minW}x${k.minH})`,
      );
      expect
        .soft(
          b.effectiveWidth >= k.minW && b.effectiveHeight >= k.minH,
          `touch target known gap below floor (${stateLabel}) [${k.unit}] ${k.control}: ${b.descriptor} is ${b.effectiveWidth}x${b.effectiveHeight}, floor is ${k.minW}x${k.minH}`,
        )
        .toBe(true);
    }
    // Every control below 44x44 px that is not a listed known gap fails (min width/height over all controls is implied).
    expect
      .soft(
        unknown,
        `touch target (${stateLabel}): ${m.selector} has controls below 44x44px: ${JSON.stringify(unknown)}`,
      )
      .toEqual([]);
  }
}
