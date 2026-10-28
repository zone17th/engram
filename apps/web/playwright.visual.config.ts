import { defineConfig, devices } from '@playwright/test';

const rawBaseURL = process.env.BASE_URL;
if (!rawBaseURL) {
  throw new Error('Visual QA requires BASE_URL; it never starts a local web server.');
}

const baseURL = new URL(rawBaseURL);
if (!['http:', 'https:'].includes(baseURL.protocol)) {
  throw new Error('BASE_URL must be an absolute http(s) URL.');
}
if (baseURL.port === '3000' || baseURL.port === '8080') {
  throw new Error('Visual QA must use the isolated acceptance stack, not ports 3000 or 8080.');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /visual\.spec\.ts/,
  outputDir: process.env.VISUAL_OUTPUT_DIR ?? 'test-results/acceptance-visual',
  preserveOutput: 'always',
  timeout: 60_000,
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.005,
      scale: 'css',
      threshold: 0.2,
    },
  },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report/acceptance-visual', open: 'never', noSnippets: true }],
  ],
  snapshotPathTemplate: 'e2e/__screenshots__/visual/{platform}/{projectName}/{arg}{ext}',
  use: {
    baseURL: baseURL.origin,
    ...devices['Desktop Chrome'],
    colorScheme: 'light',
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'mobile-390',
      use: { viewport: { width: 390, height: 844 } },
    },
    {
      name: 'tablet-768',
      use: { viewport: { width: 768, height: 1024 } },
    },
    {
      name: 'desktop-1440',
      use: { viewport: { width: 1440, height: 900 } },
    },
  ],
});
