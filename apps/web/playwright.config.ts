import { defineConfig, devices } from '@playwright/test';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const baseURL = process.env.BASE_URL ?? DEFAULT_BASE_URL;

function originOf(value: string, name: string): string {
  try {
    return new URL(value).origin;
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
}

const baseOrigin = originOf(baseURL, 'BASE_URL');
const appOrigin = process.env.APP_ORIGIN ?? baseOrigin;
if (originOf(appOrigin, 'APP_ORIGIN') !== baseOrigin) {
  throw new Error(`BASE_URL and APP_ORIGIN must use the same origin (got ${baseOrigin} and ${appOrigin})`);
}

const externalServer = Boolean(process.env.BASE_URL);

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  timeout: 30_000,
  fullyParallel: !process.env.E2E_STACK,
  workers: process.env.E2E_STACK ? 1 : undefined,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never', noSnippets: true, noCopyPrompt: true }],
  ],
  use: {
    baseURL,
    // Browser diagnostics can capture credentials, cookies, and proof tokens.
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'auth',
      testMatch: /auth\.spec\.ts|account\.spec\.ts|oauth\.spec\.ts/,
      fullyParallel: false,
      timeout: 60_000,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        trace: 'off',
        video: 'off',
        screenshot: 'off',
      },
    },
    {
      name: 'mobile-390',
      testMatch: /smoke\.spec\.ts|a11y\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } },
    },
    {
      name: 'tablet-768',
      testMatch: /smoke\.spec\.ts|a11y\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } },
    },
    {
      name: 'desktop-1440',
      testMatch: /smoke\.spec\.ts|a11y\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'vault',
      testMatch:
        /(?:^|[\\/])(?:lock|lock-epoch|vault-onboarding|vault-unlock|vault-web-visual|recovery)\.spec\.ts$/,
      fullyParallel: false,
      timeout: 90_000,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        trace: 'off',
        video: 'off',
        screenshot: 'off',
      },
    },
    ...(process.env.E2E_VAULT_PROD === '1'
      ? [
          {
            name: 'vault-prod',
            testMatch: /(?:^|[\\/])(?:lock|lock-epoch)\.spec\.ts$/,
            fullyParallel: false,
            timeout: 90_000,
            use: {
              ...devices['Desktop Chrome'],
              baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:3060',
              viewport: { width: 1440, height: 900 },
            },
          },
        ]
      : []),
    ...(process.env.E2E_CRYPTO_DEV === '1'
      ? [
          {
            name: 'crypto-dev',
            testMatch: /crypto-worker\.dev\.spec\.ts/,
            use: { ...devices['Desktop Chrome'] },
          },
        ]
      : []),
  ],
  webServer: externalServer
    ? undefined
    : {
        command: 'pnpm --filter @engram/web dev',
        url: 'http://127.0.0.1:3000',
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
