import { test, expect } from '@playwright/test'
import { dismissOverlays } from './helpers'

/**
 * Core-path Feature Pages E2E Tests
 * Tests: /compare, /market
 *
 * Removed routes are covered by retired-route-contracts.spec.ts. They must
 * not also appear here as successful product pages.
 */

test.describe('Core Feature Pages', () => {
  test('/compare page loads', async ({ page }) => {
    await page.goto('/compare', { timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)

    // Page should have loaded without error
    await expect(page).toHaveURL(/\/compare/)
    const bodyText = await page.textContent('body')
    expect(bodyText!.length).toBeGreaterThan(20)

    // Should have some interactive content (inputs, buttons, or comparison UI)
    const interactiveElements = page.locator('input, button, select, [class*="compare"]')
    const count = await interactiveElements.count()
    expect(count).toBeGreaterThan(0)
  })

  test('/market page loads with prices', async ({ page }) => {
    await page.goto('/market', { timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)

    await expect(page).toHaveURL(/\/market/)

    // Market page should have price data rendered
    const bodyText = await page.textContent('body')
    expect(bodyText!.length).toBeGreaterThan(50)

    // Should contain price-related elements (numbers, currency symbols, charts)
    const priceElements = page.locator(
      '[class*="price"], [class*="market"], [class*="coin"], [class*="token"], td, th'
    )
    await priceElements
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
      .catch(() => {})
    const count = await priceElements.count()
    expect(count).toBeGreaterThan(0)
  })
})
