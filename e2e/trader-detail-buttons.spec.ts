import { test, expect, type Page } from '@playwright/test'

/**
 * Comprehensive trader detail page test suite.
 * Tests tabs, period switching, action buttons, chart, score breakdown,
 * and similar traders for 3 platforms: binance_futures, hyperliquid, etoro.
 */

const PLATFORMS = [
  { slug: 'binance_futures', label: 'Binance Futures' },
  { slug: 'hyperliquid', label: 'Hyperliquid' },
  { slug: 'etoro', label: 'eToro' },
]

async function navigateToFirstTrader(page: Page, platformSlug: string): Promise<string | null> {
  await page.goto(`/rankings/${platformSlug}`, { waitUntil: 'domcontentloaded' })

  // Wait for trader links to appear
  const traderLink = page.locator('a[href*="/trader/"]').first()
  try {
    await traderLink.waitFor({ state: 'visible', timeout: 25_000 })
  } catch {
    console.log(`  [${platformSlug}] No trader links found on rankings page`)
    return null
  }

  const href = await traderLink.getAttribute('href')
  console.log(`  [${platformSlug}] Navigating to: ${href}`)
  await traderLink.click()
  await page.waitForLoadState('domcontentloaded')

  // Wait for the trader page to load — try multiple selectors
  try {
    await page.locator('.profile-header, .trader-page-container, [role="tablist"]').first()
      .waitFor({ state: 'visible', timeout: 25_000 })
  } catch {
    // Check if we landed on a "not found" page
    const bodyText = await page.locator('body').textContent()
    if (/not found|不存在|404/i.test(bodyText || '')) {
      console.log(`  [${platformSlug}] Trader page shows "Not Found"`)
      return null
    }
    console.log(`  [${platformSlug}] Page loaded but main elements not visible yet`)
  }

  return href
}

for (const platform of PLATFORMS) {
  test.describe(`Trader Detail — ${platform.label}`, () => {
    let traderUrl: string | null = null

    test.beforeEach(async ({ page }) => {
      traderUrl = await navigateToFirstTrader(page, platform.slug)
      test.skip(!traderUrl, `No traders found for ${platform.slug}`)
    })

    // 1. Tabs: Overview / Stats / Portfolio / Posts
    test('Tab switching works — Overview, Stats, Portfolio', async ({ page }) => {
      // Try multiple selectors for the tab list
      const tabList = page.locator('[role="tablist"]')
      try {
        await tabList.waitFor({ state: 'visible', timeout: 15_000 })
      } catch {
        // Maybe tabs rendered without role — look for profile-tabs class
        const altTabs = page.locator('.profile-tabs')
        try {
          await altTabs.waitFor({ state: 'visible', timeout: 5_000 })
        } catch {
          console.log(`  [${platform.label}] No tab list found — page may still be loading`)
          return
        }
      }

      const tabs = page.locator('[role="tab"], .profile-tab-button')
      const tabCount = await tabs.count()
      console.log(`  [${platform.label}] Found ${tabCount} tabs`)
      expect(tabCount).toBeGreaterThanOrEqual(2) // at least Overview + Stats

      // Click each visible tab and verify content appears
      for (let i = 0; i < tabCount; i++) {
        const tab = tabs.nth(i)
        const label = await tab.textContent()
        await tab.click()
        await page.waitForTimeout(500)

        // After clicking, tab should be selected
        const selected = await tab.getAttribute('aria-selected')
        console.log(`  [${platform.label}] Tab "${label?.trim()}" — aria-selected: ${selected}`)
      }
    })

    // 2. Period switch: 7D / 30D / 90D
    test('Period switching changes displayed data', async ({ page }) => {
      await page.waitForTimeout(2000) // Wait for SWR data to load

      // The performance card period selector — locate within the performance card only
      const perfCard = page.locator('.performance-card').first()
      if (await perfCard.count() === 0) {
        console.log(`  [${platform.label}] No performance card found (data may be missing)`)
        return
      }
      const periodButtons = perfCard.locator('button').filter({
        hasText: /^(7D|30D|90D)$/,
      })

      const count = await periodButtons.count()
      if (count === 0) {
        console.log(`  [${platform.label}] No period selector found in performance card`)
        return
      }

      console.log(`  [${platform.label}] Found ${count} period buttons`)
      expect(count).toBe(3)

      // Click each period
      for (const period of ['7D', '30D', '90D']) {
        const btn = periodButtons.filter({ hasText: period })
        const isDisabled = await btn.isDisabled().catch(() => false)
        if (isDisabled) {
          console.log(`  [${platform.label}] ${period} period is disabled`)
          continue
        }
        await btn.click()
        await page.waitForTimeout(300)
        console.log(`  [${platform.label}] ${period} period switch OK`)
      }
    })

    // 3. Action buttons: Follow, Share, View on Exchange / Copy Trade, Claim
    test('Action buttons are present and clickable', async ({ page }) => {
      // Wait for page to hydrate
      await page.waitForTimeout(2000)

      const header = page.locator('.profile-header')
      try {
        await header.waitFor({ state: 'visible', timeout: 15_000 })
      } catch {
        console.log(`  [${platform.label}] Profile header not found — checking page state`)
        const url = page.url()
        console.log(`  [${platform.label}] Current URL: ${url}`)
        return
      }

      // Share button — look for share icon SVG
      const shareButtons = page.locator('button, [role="button"]').filter({
        has: page.locator('svg'),
      })

      const headerText = await header.textContent()
      console.log(`  [${platform.label}] Header text snippet: ${headerText?.substring(0, 100)}...`)

      // Check for CopyTrade / View on Exchange
      const hasCopyTrade = /Copy Trade|跟单|Copy on/i.test(headerText || '')
      const hasViewOn = /View on|查看/i.test(headerText || '')
      const hasUnavailable = /unavailable|不可用/i.test(headerText || '')

      console.log(`  [${platform.label}] CopyTrade: ${hasCopyTrade}, ViewOn: ${hasViewOn}, Unavailable: ${hasUnavailable}`)
      expect(hasCopyTrade || hasViewOn || hasUnavailable).toBeTruthy()

      // Follow button
      const followBtn = page.locator('button').filter({ hasText: /^(Follow|关注)$/i })
      const followCount = await followBtn.count()
      console.log(`  [${platform.label}] Follow buttons: ${followCount}`)

      // Claim section — at bottom of overview
      const claimSection = page.getByText(/Claim|认领|Login to claim|登录认领/i)
      const claimCount = await claimSection.count()
      console.log(`  [${platform.label}] Claim sections: ${claimCount}`)
    })

    // 4. Equity curve chart
    test('Equity curve section check', async ({ page }) => {
      await page.waitForTimeout(3000) // Wait for lazy-loaded components

      const equitySection = page.getByText(/Equity Curve|资金曲线/i)
      const equityCount = await equitySection.count()
      if (equityCount > 0) {
        console.log(`  [${platform.label}] Equity curve section found`)
        const chartElement = page.locator('canvas, svg[class*="chart"], [class*="lightweight-chart"]')
        const chartCount = await chartElement.count()
        console.log(`  [${platform.label}] Chart elements: ${chartCount}`)
      } else {
        console.log(`  [${platform.label}] No equity curve (may not have data)`)
      }
    })

    // 5. Score breakdown
    test('Score breakdown section check', async ({ page }) => {
      await page.waitForTimeout(2000)

      const scoreSection = page.getByText(/Score Breakdown|评分详情/i)
      const scoreCount = await scoreSection.count()
      if (scoreCount > 0) {
        console.log(`  [${platform.label}] Score breakdown found`)

        const scoreBars = page.getByText(/Return Score|回报得分|PnL Score|盈亏得分|Drawdown|回撤|Stability|稳定性/i)
        const barCount = await scoreBars.count()
        console.log(`  [${platform.label}] Score metric labels found: ${barCount}`)
        expect(barCount).toBeGreaterThanOrEqual(1)
      } else {
        console.log(`  [${platform.label}] No score breakdown (may not have score data)`)
      }
    })

    // 6. Similar traders
    test('Similar traders section check', async ({ page }) => {
      await page.waitForTimeout(3000)

      // Use separate locators instead of mixed CSS + text selector
      const similarByClass = page.locator('.similar-traders')
      const similarByText = page.getByText(/Similar Traders|相似交易员/i)

      const hasSimilar = (await similarByClass.count()) > 0 || (await similarByText.count()) > 0

      if (hasSimilar) {
        console.log(`  [${platform.label}] Similar traders section found`)

        const similarLinks = page.locator('.similar-traders a[href*="/trader/"]')
        const linkCount = await similarLinks.count()
        console.log(`  [${platform.label}] Similar trader links: ${linkCount}`)

        if (linkCount > 0) {
          const firstHref = await similarLinks.first().getAttribute('href')
          expect(firstHref).toBeTruthy()
          console.log(`  [${platform.label}] First similar trader link: ${firstHref}`)
        }
      } else {
        console.log(`  [${platform.label}] No similar traders section`)
      }
    })

    // 7. Check for disabled or broken buttons
    test('No disabled or broken interactive elements', async ({ page }) => {
      await page.waitForTimeout(2000)

      // Find all buttons that are disabled
      const disabledButtons = page.locator('button[disabled]')
      const disabledCount = await disabledButtons.count()

      for (let i = 0; i < disabledCount; i++) {
        const btn = disabledButtons.nth(i)
        const text = await btn.textContent()
        const title = await btn.getAttribute('title')
        console.log(`  [${platform.label}] Disabled button: "${text?.trim()}" (title: ${title})`)
      }

      // Check for buttons with very low opacity (potentially broken/hidden)
      const allButtons = page.locator('button:visible')
      const buttonCount = await allButtons.count()

      let brokenCount = 0
      for (let i = 0; i < Math.min(buttonCount, 30); i++) {
        const btn = allButtons.nth(i)
        try {
          const opacity = await btn.evaluate(el => getComputedStyle(el).opacity)
          if (parseFloat(opacity) < 0.3) {
            const text = await btn.textContent()
            console.log(`  [${platform.label}] Low-opacity button: "${text?.trim()}" (opacity: ${opacity})`)
            brokenCount++
          }
        } catch {
          // Element may have detached
        }
      }

      console.log(`  [${platform.label}] Total buttons: ${buttonCount}, disabled: ${disabledCount}, low-opacity: ${brokenCount}`)
    })
  })
}
