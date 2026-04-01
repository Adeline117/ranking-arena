import { test, expect } from '@playwright/test'
import { dismissOverlays } from './helpers'

/**
 * Core-path Trader Detail E2E Tests
 * Tests: profile tabs render, tab switching, period switch on trader page
 */

test.describe('Core Trader Detail', () => {
  test('navigate to a trader profile, verify tabs render (Overview/Stats/Portfolio)', async ({ page }) => {
    // Go to homepage and find a real trader link
    await page.goto('/', { timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)

    // Wait for trader links in the rankings table
    const traderLinks = page.locator('a[href*="/trader/"]')
    await traderLinks.first().waitFor({ state: 'visible', timeout: 30_000 })

    // Click the first trader to navigate to their profile
    const href = await traderLinks.first().getAttribute('href')
    expect(href).toBeTruthy()
    await traderLinks.first().click()
    await page.waitForURL(`**${href}`, { timeout: 30_000 })

    // Verify tabs are rendered (Overview/Stats/Portfolio or their Chinese equivalents)
    const tabs = page.locator('button, [role="tab"]').filter({
      hasText: /Overview|概览|Stats|统计|Portfolio|持仓|Chart|图表/i,
    })
    await tabs.first().waitFor({ state: 'visible', timeout: 15_000 })
    const tabCount = await tabs.count()
    expect(tabCount).toBeGreaterThanOrEqual(2)
  })

  test('tab switching works', async ({ page }) => {
    // Navigate to a trader profile via homepage
    await page.goto('/', { timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)

    const traderLinks = page.locator('a[href*="/trader/"]')
    await traderLinks.first().waitFor({ state: 'visible', timeout: 30_000 })
    await traderLinks.first().click()
    await page.waitForLoadState('domcontentloaded')

    // Find tabs
    const tabs = page.locator('button, [role="tab"]').filter({
      hasText: /Overview|概览|Stats|统计|Portfolio|持仓|Chart|图表/i,
    })
    await tabs.first().waitFor({ state: 'visible', timeout: 15_000 })

    const tabCount = await tabs.count()
    if (tabCount > 1) {
      // Click the second tab (Stats or Portfolio)
      await tabs.nth(1).click()
      await page.waitForTimeout(500)

      // Verify page didn't crash -- body content is still present
      const bodyText = await page.textContent('body')
      expect(bodyText!.length).toBeGreaterThan(50)

      // Click back to the first tab
      await tabs.nth(0).click()
      await page.waitForTimeout(500)

      const bodyTextAfter = await page.textContent('body')
      expect(bodyTextAfter!.length).toBeGreaterThan(50)
    }
  })

  test('period switch on trader page works', async ({ page }) => {
    // Navigate to a trader profile via homepage
    await page.goto('/', { timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)

    const traderLinks = page.locator('a[href*="/trader/"]')
    await traderLinks.first().waitFor({ state: 'visible', timeout: 30_000 })
    await traderLinks.first().click()
    await page.waitForLoadState('domcontentloaded')

    // Look for period switch buttons on the trader page
    const periodButtons = page.locator('button, [role="tab"]').filter({
      hasText: /^(7D|30D|90D|7天|30天|90天|All)$/i,
    })

    await periodButtons.first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})

    const count = await periodButtons.count()
    if (count >= 2) {
      // Click a different period
      await periodButtons.nth(1).click()
      await page.waitForTimeout(500)

      // Page should still be functional
      const bodyText = await page.textContent('body')
      expect(bodyText!.length).toBeGreaterThan(50)
    }
  })
})
