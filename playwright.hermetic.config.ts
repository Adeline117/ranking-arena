import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'

/**
 * Core-path E2E against a production build and scripts/e2e/fake-supabase.mjs.
 * It needs no secret and contacts no real service, so it can run on every pull
 * request. Retries stay at zero: a flaky core-path test should fail visibly.
 */
const PORT = 3111
const FAKE_SUPABASE_PORT = 54399
const FAKE_SUPABASE_URL = `http://127.0.0.1:${FAKE_SUPABASE_PORT}`
const BLOCK_OUTBOUND = path.resolve(__dirname, 'scripts/e2e/block-outbound.cjs')
// Outside outputDir, which Playwright wipes at startup; .next is git-ignored.
const BLOCKED_LOG = path.resolve(__dirname, '.next/hermetic-blocked-outbound-hosts.txt')

export default defineConfig({
  testDir: './e2e/hermetic',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-hermetic' }]],
  outputDir: 'test-results-hermetic',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // The production CSP only allows real Supabase hosts, not the local fake.
    bypassCSP: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 14'], defaultBrowserType: 'chromium' } },
  ],
  webServer: [
    {
      command: 'node scripts/e2e/fake-supabase.mjs',
      url: `${FAKE_SUPABASE_URL}/rest/v1/health`,
      reuseExistingServer: !process.env.CI,
      env: { FAKE_SUPABASE_PORT: String(FAKE_SUPABASE_PORT) },
    },
    {
      // Expects an existing `.next` built with the same public Supabase URL.
      command: `npx next start -p ${PORT}`,
      url: `http://127.0.0.1:${PORT}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        NODE_ENV: 'production',
        // Server-side outbound requests to non-loopback hosts fail fast (see script).
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${BLOCK_OUTBOUND}`.trim(),
        HERMETIC_BLOCKED_LOG: BLOCKED_LOG,
        NEXT_PUBLIC_SUPABASE_URL: FAKE_SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'ci-build-anon-placeholder',
        SUPABASE_URL: FAKE_SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: 'ci-build-service-placeholder',
        CRON_SECRET: 'ci-build-placeholder-cron-secret-0000000000',
        UPSTASH_REDIS_REST_URL: `${FAKE_SUPABASE_URL}/upstash`,
        UPSTASH_REDIS_REST_TOKEN: 'ci-build-upstash-placeholder',
      },
    },
  ],
})
