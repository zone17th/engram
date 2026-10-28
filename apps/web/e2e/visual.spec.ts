import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expectSignedIn, patchSettingsViaPage } from './helpers';

const THEMES = ['light', 'dark'] as const;
const LOCALES = ['en', 'vi'] as const;
type Theme = (typeof THEMES)[number];
type Locale = (typeof LOCALES)[number];

const REPO_ROOT = resolve(process.cwd(), '../..');
const MOCKUP_ROOT = join(REPO_ROOT, 'mockups');
const E2E_API_ORIGIN = new URL(process.env.E2E_API_URL ?? 'http://127.0.0.1:18080').origin;
const VISUAL_COMPARE = process.env.VISUAL_COMPARE === '1';

let visualSignupSeq = 0;

type CaptureCase = {
  id: string;
  route: string;
  locale: Locale;
  theme: Theme;
  reference: string;
  referenceState?: string;
};

type ManifestEntry = CaptureCase & {
  project: string;
  viewport: { width: number; height: number } | null;
  production: string;
  mockup: string;
  baseline: string;
  baselineExists: boolean;
  comparison: 'capture-only' | 'toHaveScreenshot';
};

function stablePath(filePath: string): string {
  return relative(REPO_ROOT, filePath).replaceAll('\\', '/');
}

function writeManifest(testInfo: TestInfo, entry: ManifestEntry): void {
  const manifestPath = testInfo.outputPath('visual-manifest.json');
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        kind: 'engram-visual-qa',
        platform: process.platform,
        browser: testInfo.project.name,
        pinnedPlaywrightImage: 'mcr.microsoft.com/playwright@sha256:35246d87a7c88ea9b771c65d33171b2611b02a8253b4b12ce6f94376c55f99f2',
        entry,
      },
      null,
    )}\n`,
  );
}

function localeHeaders(locale: Locale): Record<string, string> {
  return {
    'accept-language': locale === 'vi' ? 'vi-VN,vi;q=0.9,en;q=0.8' : 'en-US,en;q=0.9',
  };
}

async function prepareContext(context: BrowserContext, locale: Locale, theme: Theme): Promise<void> {
  const origin = new URL(process.env.BASE_URL!).origin;
  await context.setExtraHTTPHeaders(localeHeaders(locale));
  await context.addCookies([
    { name: 'sabk_locale', value: locale, url: `${origin}/` },
    { name: 'sabk_theme', value: theme, url: `${origin}/` },
  ]);
}

async function stabilizePage(page: Page, locale: Locale, theme: Theme, route: string): Promise<void> {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.goto(route, { waitUntil: 'networkidle' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 15_000 });
  await expect(page.locator('html')).toHaveAttribute('lang', locale, { timeout: 15_000 });
  if (route === '/' || route === '/vi') {
    await page.getByRole('combobox').fill('ghi');
    await expect(page.getByRole('listbox')).toBeVisible();
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}',
  });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${route} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(0);
}

async function captureMockup(
  page: Page,
  testInfo: TestInfo,
  capture: CaptureCase,
): Promise<string> {
  const referencePage = await page.context().newPage();
  try {
    await referencePage.emulateMedia({ colorScheme: capture.theme, reducedMotion: 'reduce' });
    await referencePage.goto(pathToFileURL(join(MOCKUP_ROOT, capture.reference)).href, { waitUntil: 'networkidle' });
    await referencePage.evaluate((theme) => {
      document.documentElement.setAttribute('data-theme', theme);
    }, capture.theme);
    await referencePage.addStyleTag({
      content:
        '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}',
    });
    if (capture.referenceState) {
      await referencePage.locator(`[data-target="${capture.referenceState}"]`).click();
      await expect(referencePage.locator(`[data-view="${capture.referenceState}"]`).first()).toBeVisible();
    }
    await referencePage.evaluate(async () => {
      await document.fonts.ready;
    });
    const outputPath = testInfo.outputPath('mockup', `${capture.id}.png`);
    mkdirSync(dirname(outputPath), { recursive: true });
    await referencePage.screenshot({ path: outputPath, fullPage: true, animations: 'disabled', caret: 'hide' });
    return outputPath;
  } finally {
    await referencePage.close();
  }
}

async function capturePair(page: Page, testInfo: TestInfo, capture: CaptureCase): Promise<void> {
  const productionPath = testInfo.outputPath('production', `${capture.id}.png`);
  mkdirSync(dirname(productionPath), { recursive: true });
  await page.screenshot({
    path: productionPath,
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  });
  const mockupPath = await captureMockup(page, testInfo, capture);
  const baselinePath = testInfo.snapshotPath(`${capture.id}.png`);
  const entry: ManifestEntry = {
    ...capture,
    project: testInfo.project.name,
    viewport: page.viewportSize(),
    production: stablePath(productionPath),
    mockup: stablePath(mockupPath),
    baseline: stablePath(baselinePath),
    baselineExists: existsSync(baselinePath),
    comparison: VISUAL_COMPARE ? 'toHaveScreenshot' : 'capture-only',
  };
  writeManifest(testInfo, entry);

  if (!VISUAL_COMPARE) return;
  if (!existsSync(baselinePath)) {
    throw new Error(`VISUAL_COMPARE=1 requires an approved baseline at ${baselinePath}`);
  }
  await expect(page).toHaveScreenshot(`${capture.id}.png`, {
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  });
}

function isSignupRequest(url: string): boolean {
  try {
    return new URL(url).pathname === '/api/v1/auth/signup';
  } catch {
    return false;
  }
}

async function routeVisualSignup(context: BrowserContext): Promise<void> {
  const ip = `198.51.100.${200 + (visualSignupSeq % 50)}`;
  await context.route(
    (url) => isSignupRequest(url.toString()),
    async (route) => {
      const requestUrl = new URL(route.request().url());
      const destination = route.request().url().replace(requestUrl.origin, E2E_API_ORIGIN);
      const response = await route.fetch({
        url: destination,
        headers: { ...route.request().headers(), 'x-forwarded-for': ip },
        maxRedirects: 0,
      });
      await route.fulfill({ response });
    },
  );
}

async function createVisualAccount(page: Page, locale: Locale, theme: Theme): Promise<string> {
  visualSignupSeq += 1;
  await routeVisualSignup(page.context());
  await prepareContext(page.context(), locale, theme);
  const email = `visual.${process.env.TEST_WORKER_INDEX ?? '0'}.${visualSignupSeq}.${Date.now()}@example.test`;
  await page.goto('/app/auth/signup', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: locale === 'vi' ? 'Tạo tài khoản' : 'Create account', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
  await page.getByLabel(locale === 'vi' ? 'Mật khẩu đăng nhập' : 'Login password').fill('visual-password-12');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: locale === 'vi' ? 'Tạo tài khoản' : 'Create account', exact: true }).click();
  await page.waitForURL(/\/app\/(onboarding|auth\/verify-email)/, { timeout: 30_000 });
  await expectSignedIn(page);
  expect((await patchSettingsViaPage(page, { locale, theme })).status).toBe(200);
  return email;
}

async function stabilizeSettings(page: Page, email: string, locale: Locale, theme: Theme): Promise<void> {
  await stabilizePage(page, locale, theme, '/app/settings');
  await expect(page.getByRole('heading', { name: locale === 'vi' ? 'Tài khoản' : 'Account', exact: true })).toBeVisible({ timeout: 30_000 });
  await expectSignedIn(page);
  await expect(
    page.getByText(locale === 'vi' ? 'Chỉ phiên này đang đăng nhập.' : 'Only this session is signed in.', { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await page.evaluate((value) => {
    const root = document.querySelector('main');
    if (!root) return;
    for (const element of root.querySelectorAll<HTMLElement>('*')) {
      if (element.children.length > 0) continue;
      const text = element.textContent?.trim() ?? '';
      if (text === value) element.textContent = 'visual.user@example.test';
      if (/^(Joined|Tham gia)\s/.test(text)) {
        element.textContent = text.startsWith('Tham gia') ? 'Tham gia 01/01/2026' : 'Joined 01/01/2026';
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) element.textContent = '2026-01-01';
      if (/^(Mozilla|HeadlessChrome|Chrome|Firefox|Safari)/.test(text)) element.textContent = 'Visual browser';
    }
  }, email);
  await page.waitForTimeout(100);
}

const landingCases: CaptureCase[] = LOCALES.flatMap((locale) =>
  THEMES.map((theme) => ({
    id: `landing-${locale}-${theme}`,
    route: locale === 'en' ? '/' : '/vi',
    locale,
    theme,
    reference: 'landing.html',
  })),
);

const authCases: CaptureCase[] = ['login', 'signup', 'verify'].flatMap((state) =>
  LOCALES.flatMap((locale) =>
    THEMES.map((theme) => ({
      id: `auth-${state}-${locale}-${theme}`,
      route: `/app/auth/${state === 'verify' ? 'verify-email' : state}`,
      locale,
      theme,
      reference: 'auth.html',
      referenceState: state,
    })),
  ),
);

const settingsCases: CaptureCase[] = LOCALES.flatMap((locale) =>
  THEMES.map((theme) => ({
    id: `settings-${locale}-${theme}`,
    route: '/app/settings',
    locale,
    theme,
    reference: 'settings.html',
  })),
);

for (const capture of landingCases) {
  test(`visual ${capture.id}`, async ({ page }, testInfo) => {
    await prepareContext(page.context(), capture.locale, capture.theme);
    await stabilizePage(page, capture.locale, capture.theme, capture.route);
    await capturePair(page, testInfo, capture);
  });
}

for (const capture of authCases) {
  test(`visual ${capture.id}`, async ({ page }, testInfo) => {
    test.skip(!process.env.E2E_STACK, 'auth captures require a healthy real API stack');
    if (capture.route.endsWith('/verify-email')) {
      await createVisualAccount(page, capture.locale, capture.theme);
    } else {
      await prepareContext(page.context(), capture.locale, capture.theme);
    }
    await stabilizePage(page, capture.locale, capture.theme, capture.route);
    if (capture.route.endsWith('/login')) {
      await expect(page.getByRole('heading', { name: capture.locale === 'vi' ? 'Đăng nhập' : 'Sign in', exact: true })).toBeVisible();
    } else if (capture.route.endsWith('/signup')) {
      await expect(page.getByRole('heading', { name: capture.locale === 'vi' ? 'Tạo tài khoản' : 'Create account', exact: true })).toBeVisible();
    } else {
      await expect(page.getByRole('heading', { name: capture.locale === 'vi' ? 'Xác minh email' : 'Verify email', exact: true })).toBeVisible();
    }
    await capturePair(page, testInfo, capture);
  });
}

for (const capture of settingsCases) {
  test(`visual ${capture.id}`, async ({ page }, testInfo) => {
    test.skip(!process.env.E2E_STACK, 'settings captures require a healthy real API stack');
    const email = await createVisualAccount(page, capture.locale, capture.theme);
    await stabilizeSettings(page, email, capture.locale, capture.theme);
    await capturePair(page, testInfo, capture);
  });
}
