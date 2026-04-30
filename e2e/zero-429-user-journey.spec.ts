import { test, expect } from '@playwright/test'

/**
 * Zero-429 User Journey Test
 *
 * THE root-cause test: simulates a real user browsing the site and asserts
 * that ZERO 429 (rate limit) responses occur during normal usage.
 *
 * Every rate limit misconfiguration we've ever shipped was caught AFTER
 * users hit it in production. This test catches them BEFORE merge:
 * - Avatar proxy too restrictive? Caught here.
 * - Translate endpoint at 15/min? Caught here.
 * - React Query retrying 429s? Caught here.
 * - New endpoint with wrong preset? Caught here.
 *
 * If this test fails, it means a normal user browsing the site would
 * encounter rate limiting — which is ALWAYS a bug, never expected.
 */

test.describe('Zero 429 — rate limits must never hit normal users', () => {
  // Collect all 429 responses during the test
  let responses429: string[] = []

  test.beforeEach(async ({ page }) => {
    responses429 = []
    page.on('response', (response) => {
      if (response.status() === 429) {
        responses429.push(`${response.status()} ${response.url()}`)
      }
    })
  })

  test('full user journey: homepage → trader → groups → search → market → quiz', async ({
    page,
  }) => {
    // 1. Homepage — loads 50 trader cards with avatars + sidebar widgets
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000) // let deferred widgets fire

    // 2. Scroll rankings — triggers lazy-loaded content
    await page.evaluate(() => window.scrollTo(0, 1500))
    await page.waitForTimeout(1000)

    // 3. Click first trader → detail page with charts + similar traders
    const firstTrader = page.locator('a[href*="/trader/"]').first()
    if (await firstTrader.isVisible({ timeout: 5000 }).catch(() => false)) {
      await firstTrader.click()
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(1000)
    }

    // 4. Switch period tab (triggers data refetch)
    const periodTab = page.locator('button:has-text("30D"), button:has-text("7D")').first()
    if (await periodTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await periodTab.click()
      await page.waitForTimeout(1500)
    }

    // 5. Navigate to groups — loads posts + triggers translate calls
    await page.goto('/groups')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // 6. Open search — loads hot posts
    await page.goto('/search')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)

    // 7. Search for something — triggers trader search API
    const searchInput = page
      .locator('input[type="search"], input[placeholder*="Search"], input[placeholder*="search"]')
      .first()
    if (await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await searchInput.fill('BTC')
      await page.waitForTimeout(1500)
    }

    // 8. Market page — loads price data + live trades
    await page.goto('/market')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)

    // 9. Quiz — loads start page + questions
    await page.goto('/quiz')
    await page.waitForLoadState('networkidle')

    // ASSERT: zero 429s across the entire journey
    if (responses429.length > 0) {
      const summary = responses429.slice(0, 10).join('\n  ')
      const extra = responses429.length > 10 ? `\n  ... and ${responses429.length - 10} more` : ''
      expect
        .soft(
          responses429.length,
          `Found ${responses429.length} rate-limited (429) responses during normal browsing:\n  ${summary}${extra}`
        )
        .toBe(0)
    }
    expect(responses429.length).toBe(0)
  })
})
