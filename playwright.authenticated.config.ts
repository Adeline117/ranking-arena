import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'https://www.arenafi.org'
const storageState = process.env.QA_STORAGE_STATE_PATH || '/tmp/arena-playwright-auth/qa-a.json'

export default defineConfig({
  testDir: './e2e',
  testMatch: ['authenticated-qa.spec.ts'],
  globalSetup: './e2e/authenticated.global-setup.mjs',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    storageState,
    navigationTimeout: 45_000,
    actionTimeout: 15_000,
    // Traces and videos contain request headers/storage state. Never upload a
    // live QA token as an Actions artifact.
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'authenticated-qa' }],
})
