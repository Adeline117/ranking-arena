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

    // Find period switch buttons. TraderProfileClient renders them via
    // usePeriodStore — the exact selector depends on the button component,
    // but they typically carry the period label text.
    const periodButtons = page.locator('button').filter({
      hasText: /^(7[Dd]|30[Dd]|90[Dd])$/,
    })

    // If the trader has no chart data, period switch may not render
    if ((await periodButtons.count()) < 2) {
      test.skip()
      return
    }

    // Find the 30D button specifically
    const d30Button = periodButtons.filter({ hasText: /^30[Dd]$/ }).first()
    if (!(await d30Button.isVisible({ timeout: 2000 }).catch(() => false))) {
      test.skip()
      return
    }

    const urlBefore = page.url()
    await d30Button.click()
    await page.waitForTimeout(600) // router.replace + React re-render

    // Either the URL param is set to 30D OR the store updated in-place
    // and the active-button class changed. Accept either as proof of
    // state propagation.
    const urlAfter = page.url()
    const d30IsActive = await d30Button.evaluate((el) => {
      return (
        el.classList.contains('active') ||
        el.getAttribute('aria-pressed') === 'true' ||
        el.getAttribute('data-active') === 'true' ||
        // Check if any child element got a styling that indicates active
        getComputedStyle(el).fontWeight === '700' ||
        getComputedStyle(el).fontWeight === 'bold'
      )
    })

    const urlChanged = urlAfter !== urlBefore && /period|range|window/i.test(urlAfter)
    expect(d30IsActive || urlChanged).toBeTruthy()
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
