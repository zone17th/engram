import { expect, test, type Page } from '@playwright/test';

/**
 * P04 uipolish capture (advisor-dec-187 D3): CI evidence only, never a baseline.
 *
 * Writes full-page PNGs of public screens at 390/768/1440, light/dark, en/vi into
 * testInfo.outputPath(), where scripts/sanitize-e2e-artifacts.mjs picks up allowlisted
 * names for the `playwright-results-content-verify-true` artifact. There is no
 * toHaveScreenshot compare: the Tester visual diffs the PNGs of two CI runs.
 *
 * The file name starts with `content-` so the existing `content` Playwright project runs it
 * (playwright.config.ts and ci.yml stay untouched). It needs no API stack: every screen here
 * must be public and static. To add a screen, append to SCREENS and add its 12 PNG names
 * (`<name>-<locale>-<theme>-<width>.png`) to the sanitizer allowlist.
 */

type Locale = 'en' | 'vi';
type Theme = 'light' | 'dark';

type CaptureScreen = {
  name: string;
  path: Record<Locale, string>;
  /** Optional: put the page in the state the capture should show (runs after load). */
  prepare?: (page: Page) => Promise<void>;
};

const SCREENS: readonly CaptureScreen[] = [
  {
    name: 'landing',
    path: { en: '/', vi: '/vi' },
    // Same state as the P01 visual baselines: the hero demo searches the public `ghi` fixture,
    // which also leaves the omnibox focused (shows the focus ring, audit UIA-8).
    prepare: async (page) => {
      await page.getByRole('combobox').fill('ghi');
      await expect(page.getByRole('listbox')).toBeVisible();
    },
  },
];

const LOCALES: readonly Locale[] = ['en', 'vi'];
const THEMES: readonly Theme[] = ['light', 'dark'];
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const;

async function preparePrefs(page: Page, locale: Locale, theme: Theme): Promise<void> {
  const origin = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:3000').origin;
  await page.context().setExtraHTTPHeaders({
    'accept-language': locale === 'vi' ? 'vi-VN,vi;q=0.9,en;q=0.8' : 'en-US,en;q=0.9',
  });
  await page.context().addCookies([
    { name: 'sabk_locale', value: locale, url: `${origin}/` },
    { name: 'sabk_theme', value: theme, url: `${origin}/` },
  ]);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
}

test.describe('P04 uipolish capture (CI artifacts only)', () => {
  for (const screen of SCREENS) {
    for (const locale of LOCALES) {
      for (const theme of THEMES) {
        test(`${screen.name} ${locale} ${theme}`, async ({ page }, testInfo) => {
          test.setTimeout(90_000);
          await preparePrefs(page, locale, theme);
          for (const viewport of VIEWPORTS) {
            await page.setViewportSize(viewport);
            await page.goto(screen.path[locale], { waitUntil: 'networkidle' });
            await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 15_000 });
            await expect(page.locator('html')).toHaveAttribute('lang', locale, { timeout: 15_000 });
            if (screen.prepare) await screen.prepare(page);
            await page.evaluate(async () => {
              await document.fonts.ready;
            });
            await page.addStyleTag({
              content:
                '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}',
            });
            const shot = await page.screenshot({
              path: testInfo.outputPath(`${screen.name}-${locale}-${theme}-${viewport.width}.png`),
              fullPage: true,
            });
            expect(shot.byteLength).toBeGreaterThan(0);
          }
        });
      }
    }
  }
});
