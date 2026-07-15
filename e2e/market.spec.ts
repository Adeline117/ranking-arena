/**
 * E2E Test — Market Page (/market)
 *
 * Tests the market overview page across desktop and mobile viewports:
 * 1. Overview tab with Top Gainers/Losers
 * 2. Movers tab content (mobile)
 * 3. Sectors tab content (mobile)
 * 4. Watchlist tab (login prompt / empty state) (mobile)
 * 5. Crypto price ticker scrolling
 * 6. Auto-refresh "Updated Xs ago" indicator
 * 7. Mobile viewport (390x844) tab accessibility
 * 8. Fund Flow section rendering
 * 9. Console errors / 500 responses
 * 10. Tab switching without flicker or error boundaries
 */

import { test, expect, type ConsoleMessage, type Page } from '@playwright/test'
import { dismissOverlays } from './helpers'

// ── Shared error collector ───────────────────────────────────────────────────

function collectPageErrors(page: Page) {
  const consoleErrors: string[] = []
  const failedResponses: { url: string; status: number }[] = []

  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      const text = msg.text()
      // Ignore known noise: favicon, third-party, HMR, aborted fetches
      if (
        text.includes('favicon') ||
        text.includes('ERR_BLOCKED_BY_CLIENT') ||
        text.includes('hot-update') ||
        text.includes('webpack') ||
        text.includes('net::ERR') ||
        text.includes('404 (Not Found)') ||
        text.includes('AbortError') ||
        text.includes('signal is aborted')
      )
        return
      consoleErrors.push(text)
    }
  }

  const onResponse = (response: { url: () => string; status: () => number }) => {
    const status = response.status()
    if (status >= 500) {
      failedResponses.push({ url: response.url(), status })
    }
  }

  page.on('console', onConsole)
  page.on('response', onResponse)

  return {
    consoleErrors,
    failedResponses,
    cleanup: () => {
      page.off('console', onConsole)
      page.off('response', onResponse)
    },
  }
}

// ── Screenshot helper ────────────────────────────────────────────────────────

const SCREENSHOT_DIR = 'e2e/screenshots/market'

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: false })
}

// ── Desktop Tests ────────────────────────────────────────────────────────────
// Consolidated into a single test to avoid repeated slow navigations.

test.describe('Market Page — Desktop', () => {
  test('1,5,6,8,9,10: Full desktop verification', async ({ page }) => {
    const errors = collectPageErrors(page)

    // Navigate to market page
    await page.goto('/market', { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await dismissOverlays(page)

    // ── Test 5: Crypto price ticker renders at top ──
    const ticker = page.locator('.price-ticker-container')
    await expect(ticker).toBeVisible({ timeout: 30_000 })
    const tickerText = await ticker.textContent()
    expect(tickerText).toBeTruthy()
    expect(tickerText).toContain('$')
    await screenshot(page, '05-price-ticker')

    // ── Test 1: Overview tab renders — Top Gainers / Losers ──
    const gainersCard = page.locator('text=Top 5 Gainers').or(page.locator('text=涨幅榜')).first()
    const losersCard = page.locator('text=Top 5 Losers').or(page.locator('text=跌幅榜')).first()
    await expect(gainersCard).toBeVisible({ timeout: 30_000 })
    await expect(losersCard).toBeVisible({ timeout: 15_000 })
    await screenshot(page, '01-overview-desktop')

    // ── Test 8: Fund Flow section renders ──
    const fundFlow = page.locator('text=Fund Flow').or(page.locator('text=资金流向')).first()
    await expect(fundFlow).toBeVisible({ timeout: 30_000 })
    await screenshot(page, '08-fund-flow')

    // ── Test 6: Auto-refresh indicator scopes freshness to the price feed ──
    // Wait for CoreCards to fetch data and set lastFetchedAt timestamp
    const updatedLabel = page
      .locator('text=/Price feed checked \\d+/i')
      .or(page.locator('text=/价格源检查于 \\d+/'))
      .or(page.locator('text=/価格フィード確認 \\d+/'))
      .or(page.locator('text=/가격 피드 확인 \\d+/'))
    await expect(updatedLabel.first()).toBeVisible({ timeout: 20_000 })
    await screenshot(page, '06-auto-refresh-indicator')

    // ── Test 9: No 500 responses ──
    await page.waitForTimeout(3000) // let remaining async calls complete
    const market500s = errors.failedResponses.filter(
      (r) => r.url.includes('/market') || r.url.includes('/api/')
    )
    if (market500s.length > 0) {
      console.warn('500 responses found:', market500s)
    }
    expect(market500s).toHaveLength(0)

    // ── Test 10: No "Something went wrong" error boundary ──
    const criticalErrors = page.locator('text=/Something went wrong|出了点问题/i')
    expect(await criticalErrors.count()).toBe(0)
    await screenshot(page, '10-no-error-boundary')

    errors.cleanup()
  })
})

// ── Mobile Tests ─────────────────────────────────────────────────────────────
// Consolidated into two tests to minimize navigations.

test.describe('Market Page — Mobile (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('2,3,4: Tab content verification (Movers, Sectors, Watchlist)', async ({ page }) => {
    await page.goto('/market', { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await dismissOverlays(page)
    // Wait for client hydration: useIsMobile() starts false, switches to true in useEffect
    await page.waitForTimeout(3000)

    const errors = collectPageErrors(page)

    // ── Test 2: Click Movers tab — verify content loads ──
    const moversTab = page
      .locator('button')
      .filter({ hasText: /Movers|涨跌|値動き|급등락/i })
      .first()
    await expect(moversTab).toBeVisible({ timeout: 30_000 })
    await moversTab.click()

    // SpotMarket is lazy-loaded — wait for it to appear.
    // It renders a search input (type="text") and a MarketTable with coin data.
    // The table will have rows with coin symbols and $ prices.
    const spotMarketContent = page
      .locator('input[type="text"][aria-label]')
      .or(page.locator('table'))
      .or(page.locator('[role="row"]'))
    await expect(spotMarketContent.first()).toBeVisible({ timeout: 30_000 })
    await screenshot(page, '02-movers-tab-mobile')

    // ── Test 3: Click Sectors tab — verify content loads ──
    const sectorsTab = page
      .locator('button')
      .filter({ hasText: /Sectors|板块|セクター|섹터/i })
      .first()
    await sectorsTab.click()
    await page.waitForTimeout(2000)

    // Sectors tab renders sector cards (L1, DeFi, etc.) or loading skeleton
    const sectorContent = page
      .locator('text=/L1|DeFi|Meme|AI|L2|GameFi/i')
      .first()
      .or(page.locator('.skeleton').first())
      .or(page.locator('text=/No sector|no data|noData/i').first())
    await expect(sectorContent).toBeVisible({ timeout: 15_000 })
    await screenshot(page, '03-sectors-tab-mobile')

    // ── Test 4: Click Watchlist tab — shows empty state ──
    const watchlistTab = page
      .locator('button')
      .filter({ hasText: /Watchlist|自选|ウォッチリスト|관심/i })
      .first()
    await watchlistTab.click()
    await page.waitForTimeout(1000)

    // Watchlist shows "coming soon" placeholder
    const placeholder = page.locator('text=/coming soon|即将推出|近日公開|출시 예정/i').first()
    const starIcon = page.locator('svg polygon').first()
    await expect(placeholder.or(starIcon)).toBeVisible({ timeout: 10_000 })
    await screenshot(page, '04-watchlist-tab-mobile')

    errors.cleanup()
    expect(errors.failedResponses.filter((r) => r.status >= 500)).toHaveLength(0)
  })

  test('7,10m: Tab accessibility and flicker-free switching', async ({ page }) => {
    await page.goto('/market', { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await dismissOverlays(page)
    // Wait for client hydration: useIsMobile() starts false, switches to true in useEffect
    await page.waitForTimeout(3000)

    const errors = collectPageErrors(page)

    // ── Test 7: Verify all 4 tab buttons exist and are accessible ──
    const tabPatterns = [
      /Overview|概览|概要|개요/i,
      /Movers|涨跌|値動き|급등락/i,
      /Sectors|板块|セクター|섹터/i,
      /Watchlist|自选|ウォッチリスト|관심/i,
    ]
    const tabNames = ['overview', 'movers', 'sectors', 'watchlist']

    for (let i = 0; i < tabPatterns.length; i++) {
      const tab = page.locator('button').filter({ hasText: tabPatterns[i] }).first()
      await expect(tab).toBeVisible({ timeout: 10_000 })
      await tab.click()
      await page.waitForTimeout(800)

      // Verify no "Something went wrong" after switching
      const errorBoundary = page.locator('text=/Something went wrong|出了点问题/i')
      expect(await errorBoundary.count()).toBe(0)

      await screenshot(page, `07-mobile-tab-${tabNames[i]}`)
    }

    // ── Test 10m: Rapid tab switching — no flicker ──
    const moversTab = page.locator('button').filter({ hasText: tabPatterns[1] }).first()
    const overviewTab = page.locator('button').filter({ hasText: tabPatterns[0] }).first()
    const sectorsTab = page.locator('button').filter({ hasText: tabPatterns[2] }).first()

    // Rapid cycle: Movers → Sectors → Movers → Overview
    await moversTab.click()
    await page.waitForTimeout(200)
    await sectorsTab.click()
    await page.waitForTimeout(200)
    await moversTab.click()
    await page.waitForTimeout(200)
    await overviewTab.click()
    await page.waitForTimeout(1000)

    // No error boundaries should appear
    const errorBoundary = page.locator('text=/Something went wrong|出了点问题/i')
    expect(await errorBoundary.count()).toBe(0)
    await screenshot(page, '10m-no-flicker-after-rapid-switching')

    errors.cleanup()

    // No critical console errors during tab switching
    const criticalErrors = errors.consoleErrors.filter(
      (e) =>
        e.includes('Uncaught') ||
        e.includes('Unhandled') ||
        e.includes('TypeError') ||
        e.includes('ReferenceError')
    )
    if (criticalErrors.length > 0) {
      console.warn('Critical console errors during tab switching:', criticalErrors)
    }
    expect(criticalErrors).toHaveLength(0)
  })
})
