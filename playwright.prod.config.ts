/**
 * Playwright config for running e2e tests against PRODUCTION (or any
 * remote URL via PLAYWRIGHT_BASE_URL). Skips the webServer step so we
 * don't have to build + start a local Next.js server.
 *
 * Usage:
 *   PLAYWRIGHT_BASE_URL=https://www.arenafi.org npx playwright test \
 *     --config=playwright.prod.config.ts \
 *     e2e/trader-detail-*.spec.ts
 */
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'https://www.arenafi.org',
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // No webServer — we hit a real remote URL
})
