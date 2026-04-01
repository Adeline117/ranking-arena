import { test, expect } from '@playwright/test'
import { dismissOverlays } from './helpers'

/**
 * Core-path Feature Pages E2E Tests
 * Tests: /compare, /competitions, /library, /market
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

  test('/competitions page loads', async ({ page }) => {
    await page.goto('/competitions', { timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)

    await expect(page).toHaveURL(/\/competitions/)
    const bodyText = await page.textContent('body')
    expect(bodyText!.length).toBeGreaterThan(20)

    // Page should render content (competition listings or create button)
    const content = page.locator('a, button, [class*="competition"], [class*="card"]')
    const count = await content.count()
    expect(count).toBeGreaterThan(0)
  })

  test('/library page loads with content', async ({ page }) => {
    await page.goto('/library', { timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)

    await expect(page).toHaveURL(/\/library/)

    // Library should have educational content rendered
    const bodyText = await page.textContent('body')
    expect(bodyText!.length).toBeGreaterThan(100)

    // Should have content items (articles, cards, links)
    const contentItems = page.locator('a[href*="/library/"], [class*="card"], article, [class*="item"]')
    await contentItems.first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
    const count = await contentItems.count()
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
    const priceElements = page.locator('[class*="price"], [class*="market"], [class*="coin"], [class*="token"], td, th')
    await priceElements.first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
    const count = await priceElements.count()
    expect(count).toBeGreaterThan(0)
  })
})
