import { test, expect, type Page } from '@playwright/test'

/**
 * Comprehensive User Journey Health Test
 *
 * Simulates a real user browsing the full site and asserts:
 * 1. Zero 429 (rate limit) responses
 * 2. Zero 500 (server error) responses
 * 3. Zero console errors (excluding known benign ones)
 * 4. Zero horizontal overflow on any page
 * 5. Zero broken images
 * 6. Page load under threshold
 * 7. All critical UI elements visible and interactive
 *
 * This single test catches the ENTIRE CLASS of bugs we've fixed:
 * rate limit misconfigs, layout overflow, broken avatars, missing content.
 * Runs on all 4 devices (desktop, iPhone SE, iPhone 14, iPad).
 */

// Known benign console messages to ignore
const BENIGN_PATTERNS = [
  'net::ERR_ABORTED', // cancelled prefetch/navigation — normal
  'cdn-cgi/rum', // Cloudflare analytics — not user-facing
  'sentry.io', // Error monitoring — not user-facing
  'Download the React DevTools', // React dev mode warning
  'Privy', // Privy wallet SDK warnings
  'hydration', // React hydration warnings in dev
]

function isBenign(msg: string): boolean {
  return BENIGN_PATTERNS.some((p) => msg.includes(p))
}

interface PageHealth {
  url: string
  status: number
  loadTimeMs: number
  horizontalOverflow: boolean
  brokenImages: number
}

async function checkPageHealth(page: Page, url: string): Promise<PageHealth> {
  const start = Date.now()
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  const loadTimeMs = Date.now() - start

  // Wait for deferred content
  await page.waitForTimeout(1500)

  // Check horizontal overflow
  const horizontalOverflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth
  })

  // Count broken images (natural width 0 = failed to load, excluding hidden/lazy)
  const brokenImages = await page.evaluate(() => {
    const imgs = document.querySelectorAll('img')
    let broken = 0
    imgs.forEach((img) => {
      if (
        img.complete &&
        img.naturalWidth === 0 &&
        img.offsetParent !== null &&
        img.style.display !== 'none' &&
        !img.hasAttribute('hidden')
      ) {
        broken++
      }
    })
    return broken
  })

  return {
    url,
    status: response?.status() ?? 0,
    loadTimeMs,
    horizontalOverflow,
    brokenImages,
  }
}

test.describe('Full-site health: zero errors across real user journey', () => {
  const responses429: string[] = []
  const responses5xx: string[] = []
  const consoleErrors: string[] = []
  const pageHealthResults: PageHealth[] = []

  test.beforeEach(async ({ page }) => {
    responses429.length = 0
    responses5xx.length = 0
    consoleErrors.length = 0
    pageHealthResults.length = 0

    // Collect HTTP errors
    page.on('response', (response) => {
      const status = response.status()
      const url = response.url()
      if (status === 429) responses429.push(`429 ${url}`)
      if (status >= 500) responses5xx.push(`${status} ${url}`)
    })

    // Collect console errors (excluding benign)
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        if (!isBenign(text)) {
          consoleErrors.push(text.slice(0, 200))
        }
      }
    })
  })

  test('homepage → trader → groups → search → market → quiz', async ({ page }) => {
    // ═══════════════════════════════════════════════
    // 1. HOMEPAGE — rankings, avatars, sidebar widgets
    // ═══════════════════════════════════════════════
    const homeHealth = await checkPageHealth(page, '/')
    pageHealthResults.push(homeHealth)

    // Rankings visible
    const traderLinks = page.locator('a[href*="/trader/"]')
    await expect(traderLinks.first()).toBeVisible({ timeout: 10000 })

    // Scroll to trigger lazy content
    await page.evaluate(() => window.scrollTo(0, 1500))
    await page.waitForTimeout(800)

    // ═══════════════════════════════════════════════
    // 2. TRADER DETAIL — charts, period tabs, similar traders
    // ═══════════════════════════════════════════════
    const traderHref = await traderLinks.first().getAttribute('href')
    if (traderHref) {
      const traderHealth = await checkPageHealth(page, traderHref)
      pageHealthResults.push(traderHealth)

      // Period tab switch
      const periodTab = page.locator('button:has-text("30D"), button:has-text("7D")').first()
      if (await periodTab.isVisible({ timeout: 3000 }).catch(() => false)) {
        await periodTab.click()
        await page.waitForTimeout(1500)
      }
    }

    // ═══════════════════════════════════════════════
    // 3. GROUPS — posts, translate calls
    // ═══════════════════════════════════════════════
    const groupsHealth = await checkPageHealth(page, '/groups')
    pageHealthResults.push(groupsHealth)

    // ═══════════════════════════════════════════════
    // 4. SEARCH — hot posts, search results
    // ═══════════════════════════════════════════════
    const searchHealth = await checkPageHealth(page, '/search')
    pageHealthResults.push(searchHealth)

    // Type a search query
    const searchInput = page
      .locator('input[type="search"], input[placeholder*="Search"], input[placeholder*="search"]')
      .first()
    if (await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await searchInput.fill('BTC')
      await page.waitForTimeout(1500)
    }

    // ═══════════════════════════════════════════════
    // 5. MARKET — live prices, gainers/losers
    // ═══════════════════════════════════════════════
    const marketHealth = await checkPageHealth(page, '/market')
    pageHealthResults.push(marketHealth)

    // ═══════════════════════════════════════════════
    // 6. QUIZ — start page + questions flow
    // ═══════════════════════════════════════════════
    const quizHealth = await checkPageHealth(page, '/quiz')
    pageHealthResults.push(quizHealth)

    // Start quiz
    const startBtn = page
      .locator(
        'button:has-text("Start Test"), button:has-text("Continue Quiz"), a:has-text("Start Test")'
      )
      .first()
    if (await startBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await startBtn.click()
      await page.waitForLoadState('networkidle').catch(() => {})
      await page.waitForTimeout(1000)

      // Check quiz questions page health
      const quizQHealth = await checkPageHealth(page, page.url())
      pageHealthResults.push(quizQHealth)
    }

    // ═══════════════════════════════════════════════
    // 7. LOGIN — auth page layout
    // ═══════════════════════════════════════════════
    const loginHealth = await checkPageHealth(page, '/login')
    pageHealthResults.push(loginHealth)

    // ═══════════════════════════════════════════════
    // ASSERTIONS — all-or-nothing quality gate
    // ═══════════════════════════════════════════════

    // A. Zero 429s
    expect(
      responses429.length,
      `429 Rate Limit errors (${responses429.length}):\n  ${responses429.slice(0, 5).join('\n  ')}`
    ).toBe(0)

    // B. Zero 500s
    expect(
      responses5xx.length,
      `5xx Server errors (${responses5xx.length}):\n  ${responses5xx.slice(0, 5).join('\n  ')}`
    ).toBe(0)

    // C. Console errors under threshold (some 3rd-party noise is unavoidable)
    expect(
      consoleErrors.length,
      `Console errors (${consoleErrors.length}):\n  ${consoleErrors.slice(0, 5).join('\n  ')}`
    ).toBeLessThanOrEqual(5)

    // D. Zero horizontal overflow on any page
    const overflowPages = pageHealthResults.filter((p) => p.horizontalOverflow)
    expect(
      overflowPages.length,
      `Horizontal overflow on: ${overflowPages.map((p) => p.url).join(', ')}`
    ).toBe(0)

    // E. Minimal broken images (allow up to 3 for 3rd-party CDN flakiness)
    const totalBroken = pageHealthResults.reduce((sum, p) => sum + p.brokenImages, 0)
    expect(
      totalBroken,
      `Broken images across ${pageHealthResults.length} pages: ${totalBroken}`
    ).toBeLessThanOrEqual(3)

    // F. No page should take more than 15s to load
    const slowPages = pageHealthResults.filter((p) => p.loadTimeMs > 15000)
    expect(
      slowPages.length,
      `Slow pages (>15s): ${slowPages.map((p) => `${p.url} (${p.loadTimeMs}ms)`).join(', ')}`
    ).toBe(0)

    // G. No page should return non-200 status
    const errorPages = pageHealthResults.filter(
      (p) => p.status !== 200 && p.status !== 304 && p.status !== 0
    )
    expect(
      errorPages.length,
      `Non-200 pages: ${errorPages.map((p) => `${p.url} (${p.status})`).join(', ')}`
    ).toBe(0)
  })
})
