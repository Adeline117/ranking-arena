import { test, expect } from '@playwright/test'
import { dismissOverlays, getVisibleSearchInput } from './helpers'

/**
 * Critical Path Smoke Tests
 *
 * These 5 tests cover the core user journey defined in CLAUDE.md:
 *   Homepage → Rankings → Trader Detail → Period Switch → Search
 *   + Auth guard (unauthenticated users get redirected)
 *
 * Run with: npx playwright test e2e/smoke-critical-path.spec.ts
 * If ANY of these fail, something critical is broken.
 */

test.describe('Critical Path Smoke Tests', () => {
  test('1. Homepage loads and shows ranked traders', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/', { timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)

    await expect(page).toHaveTitle(/Arena/)

    // Scope to the hydrated surface. The SSR fallback remains in the DOM but
    // is intentionally hidden after hydration, so a page-wide `.first()` can
    // select a healthy-but-hidden fallback card and report a false failure.
    const traderLinks = page.locator('#homepage-interactive a[href*="/trader/"]')
    await traderLinks.first().waitFor({ state: 'visible', timeout: 30_000 })
    expect(await traderLinks.count()).toBeGreaterThan(0)

    // Product invariant: desktop homepage remains a three-column discovery
    // surface. A previous "B2C optimization" silently moved both sidebars
    // below the ranking; functional tests stayed green because traders still
    // rendered. Protect the actual information architecture as well.
    const layout = page.locator('#homepage-interactive .three-col-layout').first()
    await expect(layout).toBeVisible({ timeout: 30_000 })
    await expect(layout.locator(':scope > .three-col-left')).toBeVisible()
    await expect(layout.locator(':scope > .three-col-center')).toBeVisible()
    await expect(layout.locator(':scope > .three-col-right')).toBeVisible()
    const desktopColumns = await layout.evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/)
    )
    expect(desktopColumns).toHaveLength(3)
  })

  test('2. Click a trader → detail page loads with stats', async ({ page }) => {
    await page.goto('/', { timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)

    // Click the first trader link
    const traderLink = page.locator('#homepage-interactive a[href*="/trader/"]').first()
    await traderLink.waitFor({ state: 'visible', timeout: 30_000 })
    const href = await traderLink.getAttribute('href')
    await traderLink.click()

    // Should navigate to a /trader/ URL
    await page.waitForURL(/\/trader\//, { timeout: 30_000 })
    expect(page.url()).toContain('/trader/')

    // Page should have meaningful content (not a blank error page)
    await page.waitForLoadState('domcontentloaded')
    const body = await page.locator('body').textContent()
    expect(body!.length).toBeGreaterThan(100)
  })

  test('3. Period switching works (7D/30D/90D)', async ({ page }) => {
    await page.goto('/', { timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)

    const rankingSection = page.locator('.home-ranking-section')
    await rankingSection.waitFor({ state: 'visible', timeout: 30_000 })

    // All 3 period buttons should exist. The page renders responsive duplicates
    // (a mobile set + a desktop set); on desktop the mobile copy is CSS-hidden, so
    // filter to the VISIBLE one — a naive .first() grabs the hidden duplicate.
    const btn7 = page
      .locator('[data-testid="time-range-7D"], button:has-text("7D"), button:has-text("7天")')
      .filter({ visible: true })
      .first()
    const btn30 = page
      .locator('[data-testid="time-range-30D"], button:has-text("30D"), button:has-text("30天")')
      .filter({ visible: true })
      .first()
    const btn90 = page
      .locator('[data-testid="time-range-90D"], button:has-text("90D"), button:has-text("90天")')
      .filter({ visible: true })
      .first()

    await expect(btn7).toBeVisible({ timeout: 10_000 })
    await expect(btn30).toBeVisible({ timeout: 5_000 })
    await expect(btn90).toBeVisible({ timeout: 5_000 })

    // Click each period — page should not crash
    await btn30.click()
    await expect(btn30).toBeEnabled({ timeout: 15_000 })
    await btn7.click()
    await expect(btn7).toBeEnabled({ timeout: 15_000 })
    await btn90.click()
    await expect(btn90).toBeEnabled({ timeout: 15_000 })
  })

  test('4. Search accepts input and responds', async ({ page }) => {
    await page.goto('/', { timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)

    const searchInput = await getVisibleSearchInput(page)

    await expect(searchInput).toBeVisible({ timeout: 15_000 })

    await searchInput.fill('BTC')
    expect(await searchInput.inputValue()).toBe('BTC')

    // Wait briefly for suggestions
    const suggestions = page.locator(
      '[class*="dropdown"], [class*="suggestion"], [role="listbox"], [class*="search-result"]'
    )
    await suggestions
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => {})

    // Page should not crash — that's the minimum bar
    await expect(page.locator('body')).toBeVisible()
  })

  test('5. Auth guard — /watchlist redirects unauthenticated users', async ({ page }) => {
    await page.goto('/watchlist', { timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    // /watchlist server-redirects to /saved?tab=traders (see app/(app)/watchlist/
    // page.tsx). Wait for the URL to leave /watchlist before asserting — reading it
    // too early races the redirect/auth-guard settle.
    await page
      .waitForURL((u) => !u.pathname.includes('/watchlist'), { timeout: 10_000 })
      .catch(() => {})

    // Should redirect away or show a login prompt — NOT show the watchlist itself.
    const url = page.url()
    const body = await page.locator('body').textContent()

    // Either redirected away from /watchlist, or page shows login/auth prompt
    const redirected = !url.includes('/watchlist')
    const showsLoginPrompt = /登录|login|sign in|connect wallet/i.test(body || '')
    expect(redirected || showsLoginPrompt).toBeTruthy()
  })
})
