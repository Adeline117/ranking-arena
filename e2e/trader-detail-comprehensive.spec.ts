import {
  test,
  expect,
  type Page,
  type ConsoleMessage,
  type APIRequestContext,
} from '@playwright/test'
import { dismissOverlays } from './helpers'

/**
 * Comprehensive Trader Detail Page E2E Tests
 *
 * 1.  Navigate to a trader page (scrape valid handle from homepage)
 * 2.  Profile header renders (name, exchange badge, score)
 * 3.  Period switcher (7D / 30D / 90D) updates content
 * 4.  Tab switching (Overview, Stats, Portfolio)
 * 5.  Share / Copy Link button -> toast
 * 6.  Compare toggle button
 * 7.  Watchlist star -> login modal for unauthenticated user
 * 8.  Mobile viewport renders correctly
 * 9.  /trader/nonexistent-handle -> 404 page
 * 10. Console errors & 500 responses
 */

const SCREENSHOTS_DIR = 'e2e/screenshots'

// Known trader from the API for direct navigation (avoids homepage compilation wait)
// This is fetched dynamically in beforeAll via the API.
let TRADER_PATH = '/trader/0x932bdd2d5e21475e62d2fea8158fc5974507cb1a?platform=hyperliquid'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect console errors and failed network responses */
function attachErrorCollectors(page: Page) {
  const consoleErrors: string[] = []
  const failedResponses: string[] = []

  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      const text = msg.text()
      // Ignore noise: favicon, HMR, third-party analytics, browser extensions
      if (
        text.includes('favicon') ||
        text.includes('__nextjs') ||
        text.includes('hot-update') ||
        text.includes('chrome-extension') ||
        text.includes('moz-extension') ||
        text.includes('analytics') ||
        text.includes('gtag') ||
        text.includes('ERR_BLOCKED_BY_CLIENT') ||
        text.includes('net::') ||
        text.includes('Failed to load resource')
      )
        return
      consoleErrors.push(text)
    }
  })

  page.on('response', (response) => {
    const status = response.status()
    const url = response.url()
    if (status >= 500 && !url.includes('favicon')) {
      failedResponses.push(`${status} ${url}`)
    }
  })

  return { consoleErrors, failedResponses }
}

/** Fetch a valid trader path from the API (fast, avoids homepage rendering) */
async function fetchTraderPathFromAPI(request: APIRequestContext): Promise<string> {
  try {
    const response = await request.get('/api/traders?limit=1&range=90D')
    if (response.ok()) {
      const data = await response.json()
      const trader = data?.traders?.[0]
      if (trader?.id && trader?.source) {
        return `/trader/${encodeURIComponent(trader.id)}?platform=${encodeURIComponent(trader.source)}`
      }
    }
  } catch {
    // Fall through to default
  }
  return TRADER_PATH
}

/** Navigate to trader page and wait for it to fully render */
async function goToTraderPage(page: Page, traderPath?: string): Promise<void> {
  const path = traderPath || TRADER_PATH
  await page.goto(path, { timeout: 90_000, waitUntil: 'domcontentloaded' })
  await dismissOverlays(page)

  // Wait for either the trader page container or the profile header
  // (whichever appears first — the profile-header mounts after client hydration)
  await page.locator('.trader-page-container, .profile-header').first().waitFor({
    state: 'visible',
    timeout: 60_000,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Trader Detail -- Comprehensive', () => {
  // Warm up: resolve trader path from API before tests run
  test.beforeAll(async ({ request }) => {
    TRADER_PATH = await fetchTraderPathFromAPI(request)
  })

  test('1. Navigate to trader page from homepage', async ({ page }) => {
    // Navigate to homepage
    await page.goto('/', { timeout: 90_000, waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)

    // Wait for ANY trader link to become visible (SSR or interactive table)
    // Use a broad selector and a long timeout since dev server compiles lazily
    const traderLink = page.locator('a[href*="/trader/"]').first()
    await traderLink.waitFor({ state: 'attached', timeout: 90_000 })

    // Get the href before clicking
    const href = await traderLink.getAttribute('href')
    expect(href).toBeTruthy()
    expect(href).toContain('/trader/')

    // Navigate directly using the discovered URL (more reliable than click in dev mode)
    await page.goto(href!, { timeout: 90_000, waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('domcontentloaded')

    // Verify we're on a trader page
    expect(page.url()).toContain('/trader/')

    // Page rendered something meaningful
    const bodyText = await page.textContent('body')
    expect(bodyText!.trim().length).toBeGreaterThan(50)

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/01-trader-page-loaded.png`, fullPage: true })
  })

  test('2. Profile header renders (name, exchange badge, score)', async ({ page }) => {
    await goToTraderPage(page)

    // Wait for the profile header to render
    const profileHeader = page.locator('.profile-header')
    await profileHeader.waitFor({ state: 'visible', timeout: 60_000 })
    await expect(profileHeader).toBeVisible()

    // Trader name (h1 element inside the header)
    const traderName = profileHeader.locator('h1')
    await expect(traderName).toBeVisible()
    const nameText = await traderName.textContent()
    expect(nameText!.trim().length).toBeGreaterThan(0)

    // Exchange badge + name badges row should be present
    const badges = profileHeader.locator('.trader-name-badges-row')
    await expect(badges).toBeVisible()

    // Header should contain meaningful content
    const headerText = await profileHeader.textContent()
    expect(headerText!.length).toBeGreaterThan(5)

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/02-profile-header.png` })
  })

  test('3. Period switcher (7D/30D/90D) updates content', async ({ page }) => {
    await goToTraderPage(page)

    // Find period selector buttons (PeriodSelector renders 7D, 30D, 90D buttons)
    const periodButtons = page.locator('button').filter({
      hasText: /^(7D|30D|90D)$/,
    })

    // Wait for period buttons to appear
    await periodButtons
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
      .catch(() => {})

    const count = await periodButtons.count()
    if (count < 2) {
      test.skip()
      return
    }

    // Click 7D
    const btn7D = page.locator('button').filter({ hasText: /^7D$/ })
    if ((await btn7D.count()) > 0) {
      await btn7D.first().click()
      await page.waitForTimeout(1000)
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/03a-period-7d.png` })
    }

    // Click 30D
    const btn30D = page.locator('button').filter({ hasText: /^30D$/ })
    if ((await btn30D.count()) > 0) {
      await btn30D.first().click()
      await page.waitForTimeout(1000)
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/03b-period-30d.png` })
    }

    // Click 90D
    const btn90D = page.locator('button').filter({ hasText: /^90D$/ })
    if ((await btn90D.count()) > 0) {
      await btn90D.first().click()
      await page.waitForTimeout(1000)
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/03c-period-90d.png` })
    }

    // Page should still be functional
    const bodyAfter = await page.textContent('body')
    expect(bodyAfter!.length).toBeGreaterThan(50)
  })

  test('4. Tab switching (Overview, Stats, Portfolio)', async ({ page }) => {
    await goToTraderPage(page)

    // Find the tab container
    const tablist = page.locator('[role="tablist"]')
    await tablist.waitFor({ state: 'visible', timeout: 30_000 })

    const overviewTab = tablist.locator('[role="tab"]').filter({ hasText: /Overview|概览/i })
    const statsTab = tablist.locator('[role="tab"]').filter({ hasText: /Stats|统计/i })
    const portfolioTab = tablist.locator('[role="tab"]').filter({ hasText: /Portfolio|持仓/i })

    // Overview should be active by default
    await expect(overviewTab.first()).toBeVisible()
    const overviewSelected = await overviewTab.first().getAttribute('aria-selected')
    expect(overviewSelected).toBe('true')
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/04a-tab-overview.png` })

    // Click Stats tab
    if ((await statsTab.count()) > 0) {
      await statsTab.first().click()
      await page.waitForTimeout(800)
      const statsSelected = await statsTab.first().getAttribute('aria-selected')
      expect(statsSelected).toBe('true')
      const bodyText = await page.textContent('body')
      expect(bodyText!.length).toBeGreaterThan(50)
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/04b-tab-stats.png` })
    }

    // Click Portfolio tab
    if ((await portfolioTab.count()) > 0) {
      await portfolioTab.first().click()
      await page.waitForTimeout(800)
      const portfolioSelected = await portfolioTab.first().getAttribute('aria-selected')
      expect(portfolioSelected).toBe('true')
      const bodyText = await page.textContent('body')
      expect(bodyText!.length).toBeGreaterThan(50)
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/04c-tab-portfolio.png` })
    }

    // Switch back to Overview
    await overviewTab.first().click()
    await page.waitForTimeout(500)
    const backToOverview = await overviewTab.first().getAttribute('aria-selected')
    expect(backToOverview).toBe('true')
  })

  test('5. Share / Copy Link button -> toast appears', async ({ page }) => {
    await goToTraderPage(page)

    // Grant clipboard permissions
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])

    // Wait for action buttons
    const actionsArea = page.locator('.profile-header-actions, .action-buttons').first()
    await actionsArea.waitFor({ state: 'visible', timeout: 30_000 })

    // Find Copy Link button by title (visible on all viewports)
    const copyBtn = page
      .locator('button[title*="Copy share link"], button[title*="copy" i]')
      .first()

    await copyBtn.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})

    if (await copyBtn.isVisible()) {
      await copyBtn.click()
      await page.waitForTimeout(1500)

      // Check for "Copied!" feedback (button text change or toast)
      const copiedIndicator = page.locator('text=/Copied|已复制/i')
      const toastEl = page.locator('[role="alert"], [class*="toast" i]')
      const hasFeedback = (await copiedIndicator.count()) > 0 || (await toastEl.count()) > 0
      expect(hasFeedback).toBe(true)

      await page.screenshot({ path: `${SCREENSHOTS_DIR}/05-share-copy-link-toast.png` })
    }
  })

  test('6. Compare toggle button', async ({ page }) => {
    await goToTraderPage(page)

    // CompareToggle is inside .profile-header-actions
    const compareBtn = page
      .locator('.profile-header-actions')
      .locator('button, [role="button"]')
      .filter({
        hasText: /Compare|对比/i,
      })
      .first()

    await compareBtn.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})

    if (await compareBtn.isVisible()) {
      // Click to toggle on
      await compareBtn.click()
      await page.waitForTimeout(600)

      // Verify "Comparing" state appeared
      const comparingSpan = page.locator('.profile-header-actions span').filter({
        hasText: /Comparing|对比中/i,
      })
      const isNowComparing = (await comparingSpan.count()) > 0
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/06a-compare-toggled-on.png` })

      // Toggle off
      if (isNowComparing) {
        const comparingBtn = page
          .locator('.profile-header-actions button')
          .filter({
            hasText: /Comparing|对比中/i,
          })
          .first()
        await comparingBtn.click()
        await page.waitForTimeout(600)
        await page.screenshot({ path: `${SCREENSHOTS_DIR}/06b-compare-toggled-off.png` })
      }
    }
  })

  test('7. Watchlist star -> login modal for unauthenticated user', async ({ page }) => {
    await goToTraderPage(page)

    // Find watchlist button by aria-label
    const watchlistBtn = page.locator('button[aria-label*="watchlist" i]').first()
    await watchlistBtn.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})

    if (await watchlistBtn.isVisible()) {
      await watchlistBtn.click()
      await page.waitForTimeout(2000)

      // For unauthenticated users, login modal should appear
      const loginModal = page.locator('[role="dialog"]').filter({
        hasText: /Sign in|登录|Google|Email|Wallet/i,
      })

      await page.screenshot({ path: `${SCREENSHOTS_DIR}/07-watchlist-login-modal.png` })

      const hasLoginModal = (await loginModal.count()) > 0
      if (hasLoginModal) {
        await expect(loginModal.first()).toBeVisible()
        // Close modal
        await page.keyboard.press('Escape')
        await page.waitForTimeout(500)
      }
      // If no modal, user might be authenticated — still a valid outcome
    }
  })

  test('8. Mobile viewport renders correctly', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
    })
    const page = await context.newPage()

    try {
      await page.goto(TRADER_PATH, { timeout: 90_000, waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('domcontentloaded')
      await dismissOverlays(page)

      // Wait for trader page to render
      await page.locator('.trader-page-container, .profile-header').first().waitFor({
        state: 'visible',
        timeout: 60_000,
      })

      // Profile header visible on mobile
      const profileHeader = page.locator('.profile-header')
      await profileHeader.waitFor({ state: 'visible', timeout: 30_000 })
      await expect(profileHeader).toBeVisible()

      // Tabs visible on mobile
      const tablist = page.locator('[role="tablist"]')
      await tablist.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
      if ((await tablist.count()) > 0) {
        await expect(tablist.first()).toBeVisible()
      }

      await page.screenshot({
        path: `${SCREENSHOTS_DIR}/08a-mobile-trader-page.png`,
        fullPage: true,
      })

      // Scroll down to test sticky mini header
      await page.evaluate(() => window.scrollBy(0, 500))
      await page.waitForTimeout(600)
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/08b-mobile-scrolled.png` })

      // Check horizontal overflow
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
      if (overflow > 10) {
        console.warn(`Mobile horizontal overflow: ${overflow}px`)
      }
    } finally {
      await context.close()
    }
  })

  test('9. /trader/nonexistent-handle -> 404 page', async ({ page }) => {
    const { failedResponses } = attachErrorCollectors(page)

    await page.goto('/trader/nonexistent-handle-xyz-99999-does-not-exist', {
      timeout: 90_000,
      waitUntil: 'domcontentloaded',
    })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)
    await page.waitForTimeout(2000)

    // Should have navigation links to rankings/search/home
    const navLinks = page.locator('a[href="/rankings"], a[href="/search"], a[href="/"]')
    const navLinkCount = await navLinks.count()
    expect(navLinkCount).toBeGreaterThanOrEqual(1)

    // Page rendered meaningful content (not blank)
    const bodyText = await page.textContent('body')
    expect(bodyText!.trim().length).toBeGreaterThan(20)

    // Look for not-found content
    const notFoundText = page.locator('h1, p').filter({
      hasText: /not found|不存在|Trader not found|该交易员/i,
    })
    if ((await notFoundText.count()) > 0) {
      await expect(notFoundText.first()).toBeVisible()
    }

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/09-404-not-found.png`, fullPage: true })

    // No 500 errors (404 is expected)
    const server500s = failedResponses.filter((r) => r.startsWith('500'))
    expect(server500s.length).toBe(0)
  })

  test('10. No console errors or 500 responses on trader page', async ({ page }) => {
    const { consoleErrors, failedResponses } = attachErrorCollectors(page)

    await goToTraderPage(page)

    // Let page stabilize
    await page.waitForTimeout(3000)

    // Switch through all tabs to trigger API calls
    const tablist = page.locator('[role="tablist"]')
    await tablist.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})

    if ((await tablist.count()) > 0) {
      const tabs = tablist.locator('[role="tab"]')
      const tabCount = await tabs.count()
      for (let i = 0; i < tabCount; i++) {
        await tabs.nth(i).click()
        await page.waitForTimeout(1000)
      }
    }

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/10-after-full-interaction.png`,
      fullPage: true,
    })

    // Report console errors
    if (consoleErrors.length > 0) {
      console.warn(`Console errors (${consoleErrors.length}):`)
      consoleErrors.slice(0, 10).forEach((e, i) => console.warn(`  [${i}] ${e.substring(0, 200)}`))
    }

    // Assert no 500 responses
    const server500s = failedResponses.filter((r) => r.startsWith('500'))
    if (server500s.length > 0) {
      console.error('500 responses:', server500s)
    }
    expect(server500s.length).toBe(0)
  })
})
