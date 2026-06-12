import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright 配置文件
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './e2e',

  /* Global timeout per test — dev server needs more time for compilation */
  timeout: 120_000,

  /* Expect timeout */
  expect: {
    timeout: 10_000,
  },

  /* Run tests in files in parallel */
  fullyParallel: true,

  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,

  /* Retry flaky tests (cookie consent, rate limiting, parallel timing) */
  retries: process.env.CI ? 2 : 1,

  /* Limit workers: CI=1, dev=2 (dev server can't handle many parallel compilations) */
  workers: process.env.CI ? 1 : 2,

  /* Reporter to use */
  reporter: [['html', { open: 'never' }], ['list']],

  /* Shared settings for all the projects below. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',

    /* Navigation timeout — dev server compilation can exceed 30s on first hit */
    navigationTimeout: 60_000,

    /* Action timeout */
    actionTimeout: 15_000,

    /* Collect trace when retrying the failed test. */
    trace: 'on-first-retry',

    /* Screenshot on failure */
    screenshot: 'only-on-failure',

    /* Video recording */
    video: 'on-first-retry',
  },

  /* Multi-device matrix: every E2E test runs on desktop + mobile + tablet.
   * This is the systemic fix for the class of bugs where features work on
   * desktop but break on mobile (quiz freeze, cookie overlap, tab overflow,
   * rankings width, etc.). All caught automatically before merge. */
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-iphone-se',
      use: { ...devices['iPhone SE'] },
    },
    {
      name: 'mobile-iphone-14',
      use: { ...devices['iPhone 14'] },
    },
    {
      name: 'tablet-ipad',
      use: { ...devices['iPad (gen 7)'] },
    },
  ],

  /* Run production server for faster page loads */
  /* In CI the build is done in a prior step, so just `npm start` */
  /* PLAYWRIGHT_BASE_URL 指向外部环境（如生产）时无需本地构建+起服 */
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: process.env.CI ? 'npm start' : 'npm run build && npm start',
        url: 'http://localhost:3000',
        reuseExistingServer: !process.env.CI,
        timeout: 300_000,
      },
})
