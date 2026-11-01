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
import type { ItemSummary, Tag } from '../lib/api/content';
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

// Disable Playwright's automatic error-context DOM snapshot in this worker before any test runs,
// so a failure while a recovery-key sheet or secret input is mounted can never serialize secrets to disk.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

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
): { assertNoLeaks: () => void } {
  const leaks: string[] = [];

  context.on('request', (req) => {
    const url = req.url();
    const headersText = JSON.stringify(req.headers());
    const postData = req.postData() ?? '';
    for (const item of forbiddenBodies) {
      if (!item.value) continue;
      if (url.includes(item.value)) {
        leaks.push(`${req.method()} ${new URL(url).pathname} leaked ${item.label} in URL`);
      }
      if (headersText.includes(item.value)) {
        leaks.push(`${req.method()} ${new URL(url).pathname} leaked ${item.label} in headers`);
      }
      if (postData.includes(item.value)) {
        leaks.push(`${req.method()} ${new URL(url).pathname} leaked ${item.label} in postData`);
      }
    }
  });

  return {
    assertNoLeaks: () => {
      expect(leaks, `Plaintext body leak detected in network requests: ${leaks.join('; ')}`).toEqual(
        [],
      );
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
/**
 * Performs an authenticated JSON mutation from the page context using the active session and `sabk_csrf` cookie.
 * Never used to send entry plaintext (entry bodies must be created through the real UI).
 */
export async function apiMutateMetadata<TResponse>(
  page: Page,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: TResponse }> {
  return page.evaluate(
    async ({ methodArg, pathArg, bodyArg }) => {
      const parts = document.cookie.split(';');
      let csrf: string | null = null;
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith('sabk_csrf=')) {
          csrf = decodeURIComponent(trimmed.slice('sabk_csrf='.length));
          break;
        }
      }
      const res = await fetch(`/api/v1${pathArg}`, {
        method: methodArg,
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          ...(bodyArg !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: bodyArg !== undefined ? JSON.stringify(bodyArg) : undefined,
      });
      const parsed = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
      return { status: res.status, data: parsed as TResponse };
    },
    { methodArg: method, pathArg: path, bodyArg: body },
  );
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

export async function apiListTags(page: Page): Promise<{ items: Tag[] }> {
  return page.evaluate(async () => {
    const res = await fetch('/api/v1/tags?sort=recent', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    return (await res.json()) as { items: Tag[] };
  });
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
 * Tags any text-like `<input>` holding a non-empty value other than the public item name/hint inputs
 * so `mask` hides secret inputs if any exist on screen.
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
  const metrics = await ctx.page.evaluate((selectors) => {
    const scrollWidth = document.documentElement.scrollWidth;
    const clientWidth = document.documentElement.clientWidth;
    const innerWidth = window.innerWidth;
    const overflowingContainers: string[] = [];
    for (const sel of selectors) {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        const overflowX = style.overflowX;
        if (overflowX === 'auto' || overflowX === 'scroll') {
          // Intentional horizontal scroll container (e.g. `json-table-host-<id>` with `overflow-x-auto`):
          // its box itself must stay within the viewport, while inner `scrollWidth > clientWidth` is valid.
          if (rect.left < -1 || rect.right > clientWidth + 1) {
            overflowingContainers.push(
              `${sel} (scroll container spills past viewport: left=${Math.round(rect.left)} right=${Math.round(rect.right)} > clientWidth=${clientWidth})`,
            );
          }
          continue;
        }
        if (el.scrollWidth > el.clientWidth + 1) {
          overflowingContainers.push(
            `${sel} (overflow-x=${overflowX} cuts off or overflows content: scrollWidth=${el.scrollWidth} > clientWidth=${el.clientWidth})`,
          );
        } else if (rect.left < -1 || rect.right > clientWidth + 1) {
          overflowingContainers.push(
            `${sel} (overflow-x=${overflowX} spills past viewport: left=${Math.round(rect.left)} right=${Math.round(rect.right)} > clientWidth=${clientWidth})`,
          );
        }
      }
    }
    return { scrollWidth, clientWidth, innerWidth, overflowingContainers };
  }, extraSelectors);

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
    readonly width: number;
    readonly height: number;
    readonly afterWidth: number;
    readonly afterHeight: number;
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
 * Accounts for `::after` hit-target expansion (such as `.chip-x::after` which is 44x44 centered).
 */
export async function measureCoarseTouchTargets(
  page: Page,
  selectors: readonly string[],
): Promise<TouchTargetMeasurement[]> {
  const pointerCoarseMatches = await page.evaluate(
    () => window.matchMedia('(pointer: coarse)').matches,
  );
  expect(pointerCoarseMatches, 'context must match (pointer: coarse)').toBe(true);

  return page.evaluate((selList) => {
    const results: TouchTargetMeasurement[] = [];
    for (const selector of selList) {
      const elements = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
        (el) => {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            !el.hasAttribute('hidden') &&
            rect.width > 0 &&
            rect.height > 0
          );
        },
      );

      let minWidth = Infinity;
      let minHeight = Infinity;
      let minEffWidth = Infinity;
      let minEffHeight = Infinity;
      const below44: Array<{
        selector: string;
        index: number;
        width: number;
        height: number;
        afterWidth: number;
        afterHeight: number;
      }> = [];

      elements.forEach((el, index) => {
        const rect = el.getBoundingClientRect();
        const afterStyle = getComputedStyle(el, '::after');
        const hasAfter =
          afterStyle.content !== 'none' &&
          afterStyle.content !== 'normal' &&
          afterStyle.display !== 'none';
        const afterW = hasAfter ? Number.parseFloat(afterStyle.width) || 0 : 0;
        const afterH = hasAfter ? Number.parseFloat(afterStyle.height) || 0 : 0;

        const w = Math.round(rect.width * 100) / 100;
        const h = Math.round(rect.height * 100) / 100;
        const effW = Math.max(w, afterW);
        const effH = Math.max(h, afterH);

        minWidth = Math.min(minWidth, w);
        minHeight = Math.min(minHeight, h);
        minEffWidth = Math.min(minEffWidth, effW);
        minEffHeight = Math.min(minEffHeight, effH);

        if (effH < 43.5) {
          below44.push({
            selector,
            index,
            width: w,
            height: h,
            afterWidth: afterW,
            afterHeight: afterH,
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
 * Asserts that every measured control selector on a coarse-pointer mobile page matched at least one visible control
 * and has an effective hit target height >= 44 px (and icon/menu triggers have width >= 44 px).
 */
export async function expectCoarseTouchTargetsAtLeast44(
  page: Page,
  stateLabel: string,
  selectors: readonly string[],
  minWidth44Selectors: readonly string[] = [],
): Promise<void> {
  const measurements = await measureCoarseTouchTargets(page, selectors);
  const widthSet = new Set(minWidth44Selectors);

  for (const m of measurements) {
    console.log(
      `touch-target ${stateLabel} ${m.selector}: count=${m.count} effW=${m.effectiveWidth} effH=${m.effectiveHeight}`,
    );
    expect(
      m.count,
      `touch target (${stateLabel}): expected at least 1 visible element for ${m.selector}`,
    ).toBeGreaterThan(0);
    expect(
      m.below44,
      `touch target (${stateLabel}): ${m.selector} has controls below 44px height: ${JSON.stringify(m.below44)}`,
    ).toEqual([]);
    expect(
      m.effectiveHeight,
      `touch target (${stateLabel}): ${m.selector} height ${m.effectiveHeight}px < 44px`,
    ).toBeGreaterThanOrEqual(43.5);
    if (widthSet.has(m.selector)) {
      expect(
        m.effectiveWidth,
        `touch target (${stateLabel}): ${m.selector} width ${m.effectiveWidth}px < 44px`,
      ).toBeGreaterThanOrEqual(43.5);
    }
  }
}
