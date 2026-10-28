import { defineConfig, devices } from '@playwright/test';

const DEFAULT_BASE_URL = 'https://127.0.0.1:13443';
const baseURL = process.env.BASE_URL ?? DEFAULT_BASE_URL;

try {
  if (new URL(baseURL).protocol !== 'https:') {
    throw new Error('transport acceptance tests require an HTTPS BASE_URL');
  }
} catch (error) {
  throw new Error(`BASE_URL must be an absolute HTTPS URL: ${String(error)}`);
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /transport\.spec\.ts/,
  outputDir: 'test-results/transport',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report/transport', open: 'never', noSnippets: true, noCopyPrompt: true }],
  ],
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'transport-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  // The HTTPS proxy and API are owned by the acceptance harness.
  webServer: undefined,
});
