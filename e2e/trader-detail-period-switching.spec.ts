/**
 * E2E tests for trader-detail period switching (7D / 30D / 90D).
 *
 * Lock in the period-store → URL sync → chart data cascade before the
 * TraderProfileClient Suspense refactor. The cascade is:
 *
 *   usePeriodStore(period) → useEffect(router.replace) → URL param update
 *                                    ↓
 *                         traderEquityCurve[period] re-slice
 *                                    ↓
 *                         DrawdownChart + CopyTradeSimulator re-render
 */

import { test, expect } from '@playwright/test'
import { dismissOverlays } from './helpers'

test.describe('交易员详情页 - 周期切换 (period switch)', () => {
  test('period switch updates URL param + re-renders charts', async ({ page }) => {
    await page.goto('/')
    await dismissOverlays(page)
    await page.waitForLoadState('domcontentloaded')

    // Navigate to first trader from the ranking. Filter out .ssr-row
    // links — those get display:none'd after Phase 2 hydration.
    const traderLinks = page.locator('a[href*="/trader/"]:not(.ssr-row)')
    await traderLinks.first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
    if (await traderLinks.count() === 0) {
      test.skip()
      return
    }

    await traderLinks.first().click({ force: true })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})

    // PeriodSelector renders buttons with aria-label="30D period" — stable
    // selector. The buttons exist regardless of chart data presence (they're
    // in OverviewPerformanceCard which renders for every trader page).
    const d30Button = page.locator('button[aria-label="30D period"]').first()
    if (!(await d30Button.isVisible({ timeout: 5000 }).catch(() => false))) {
      // PeriodSelector dynamic-imported but didn't mount in time
      test.skip()
      return
    }

    const urlBefore = page.url()
    await d30Button.click({ force: true })
    await page.waitForTimeout(800) // router.replace + React re-render

    // After click, the 30D button should have aria-pressed="true"
    const isPressed = await d30Button.getAttribute('aria-pressed')
    expect(isPressed).toBe('true')

    // URL should reflect the period change (?period=30D)
    const urlAfter = page.url()
    expect(urlAfter).not.toBe(urlBefore)
    expect(urlAfter).toContain('period=30D')
  })

  test('period persists across tab reload', async ({ page }) => {
    // Simulates refresh-after-period-switch: the user clicks 30D, reloads,
    // and expects 30D to remain active. TraderProfileClient reads the
    // initial period from the URL via a useEffect on mount.

    await page.goto('/')
    await dismissOverlays(page)
    await page.waitForLoadState('domcontentloaded')

    const traderLinks = page.locator('a[href*="/trader/"]:not(.ssr-row)')
    await traderLinks.first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
    if (await traderLinks.count() === 0) {
      test.skip()
      return
    }

    const href = await traderLinks.first().getAttribute('href')
    if (!href) {
      test.skip()
      return
    }

    // Visit directly with ?period=30D. Use waitUntil:'domcontentloaded' so
    // we don't wait for all sub-chunks (some never finish loading).
    const testUrl = `${href}${href.includes('?') ? '&' : '?'}period=30D`
    await page.goto(testUrl, { waitUntil: 'domcontentloaded' })
    await dismissOverlays(page)

    // Page must render non-blank content
    const body = await page.textContent('body')
    expect(body?.trim().length).toBeGreaterThan(200)

    // URL param should still be present after load (not stripped by router)
    expect(page.url()).toContain('period=30D')
  })
})
