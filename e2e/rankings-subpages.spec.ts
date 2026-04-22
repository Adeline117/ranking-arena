/**
 * E2E Tests — Rankings Sub-Pages (Bots & Tokens)
 *
 * Tests (combined into fewer page loads to avoid memory pressure):
 *  1. /rankings/bots renders bot rankings
 *  2. Time window buttons (7D/30D/90D) work
 *  3. Category buttons (All/TG Bot/AI Agent/Vault) work
 *  4. Search input filters bots
 *  5. Click a bot row -> navigate to /bot/[id]
 *  6. "Back to Traders" link on bots page works
 *  7. Sub-nav tabs (Traders/Tokens) work
 *  8. /rankings/tokens renders token cards (or handles API 500 gracefully)
 *  9. If tokens page shows error, error boundary renders nicely
 * 10. Mobile viewport test
 * 11. Check for console errors or 500 responses
 */

import { test, expect, type Page, type ConsoleMessage } from '@playwright/test'
import path from 'path'

const SCREENSHOT_DIR = path.resolve(__dirname, 'screenshots')
const LONG_TIMEOUT = 90_000

/** Dismiss overlays (cookie consent / welcome modal) */
async function dismissOverlays(page: Page) {
  for (const text of ['Accept', 'Close']) {
    const btn = page.locator(`button:has-text("${text}")`)
    if (
      await btn
        .first()
        .isVisible({ timeout: 2000 })
        .catch(() => false)
    ) {
      await btn.first().click()
    }
  }
}

/** Collect console errors and failed/500 network requests */
function attachErrorCollectors(page: Page) {
  const consoleErrors: string[] = []
  const networkErrors: string[] = []

  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text())
    }
  })

  page.on('response', (res) => {
    if (res.status() >= 500) {
      networkErrors.push(`${res.status()} ${res.url()}`)
    }
  })

  return { consoleErrors, networkErrors }
}

/* ------------------------------------------------------------------ */
/*  Test Suite                                                         */
/* ------------------------------------------------------------------ */

test.describe('Rankings Sub-Pages — Bots & Tokens', () => {
  test.setTimeout(300_000) // 5 min per test

  /* ============================================================== */
  /*  BOTS PAGE: Tests 1-6                                          */
  /* ============================================================== */
  test('bots page: renders, filters, search, navigation', async ({ page }) => {
    const { consoleErrors, networkErrors } = attachErrorCollectors(page)

    // --- 1. Load /rankings/bots and verify it renders ---
    await page.goto('/rankings/bots', { waitUntil: 'domcontentloaded', timeout: LONG_TIMEOUT })
    await dismissOverlays(page)

    await expect(page.locator('h1')).toBeVisible({ timeout: LONG_TIMEOUT })
    const botRows = page.locator('a[href^="/bot/"]')
    await botRows.first().waitFor({ state: 'visible', timeout: LONG_TIMEOUT })

    const rowCount = await botRows.count()
    expect(rowCount).toBeGreaterThan(0)
    console.log(`  [1] Bot rows rendered: ${rowCount}`)

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-bots-page.png'), fullPage: true })

    // Wait for hydration to fully complete before interacting
    await page.waitForTimeout(8000)

    // --- 2. Time window buttons (7D/30D/90D) ---
    for (const w of ['7D', '30D', '90D']) {
      const btn = page.getByRole('button', { name: w, exact: true })
      await expect(btn).toBeVisible()
      await btn.click()

      // Wait for router.replace to settle
      await page.waitForTimeout(2000)

      await expect(async () => {
        expect(page.url()).toContain(`window=${w}`)
      }).toPass({ timeout: 15_000 })

      // Extra wait before clicking next button
      await page.waitForTimeout(2000)
    }
    console.log('  [2] Time window buttons work')
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '02-bots-time-windows.png'),
      fullPage: true,
    })

    // --- 3. Category buttons ---
    const categoryTexts = ['TG Bot', 'AI Agent', 'Vault']
    for (const text of categoryTexts) {
      const btn = page.locator('button.ranking-filter-btn', { hasText: new RegExp(text, 'i') })
      if ((await btn.count()) > 0) {
        await btn.first().click()
        await page.waitForTimeout(1500)
        console.log(`  [3] Clicked category: ${text}`)
      }
    }

    // Reset to All
    const allCatBtn = page.locator('button.ranking-filter-btn', { hasText: /^All$|^全部$/i })
    if ((await allCatBtn.count()) > 0) {
      await allCatBtn.first().click()
      await page.waitForTimeout(1000)
    }
    console.log('  [3] Category buttons work')
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '03-bots-categories.png'),
      fullPage: true,
    })

    // --- 4. Search filters bots ---
    // Reset to clean URL
    await page.goto('/rankings/bots', { waitUntil: 'domcontentloaded', timeout: LONG_TIMEOUT })
    await botRows.first().waitFor({ state: 'visible', timeout: LONG_TIMEOUT })
    await page.waitForTimeout(3000)

    const initialCount = await page.locator('a[href^="/bot/"]').count()
    const searchInput = page.locator('input[type="text"]').first()
    await expect(searchInput).toBeVisible()

    await searchInput.fill('aaa_unlikely_match_zzz')
    await page.waitForTimeout(500)
    const filteredCount = await page.locator('a[href^="/bot/"]').count()
    console.log(`  [4] Before search: ${initialCount}, after nonsense: ${filteredCount}`)
    expect(filteredCount).toBeLessThan(initialCount)

    await searchInput.clear()
    await page.waitForTimeout(500)
    const restoredCount = await page.locator('a[href^="/bot/"]').count()
    expect(restoredCount).toBe(initialCount)
    console.log('  [4] Search filter works')
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04-bots-search.png'), fullPage: true })

    // --- 5. Click a bot row -> /bot/[id] ---
    const href = await botRows.first().getAttribute('href')
    expect(href).toBeTruthy()
    console.log(`  [5] Clicking bot link: ${href}`)

    await botRows.first().click()
    await page.waitForURL('**/bot/**', { timeout: LONG_TIMEOUT })
    await page.waitForLoadState('domcontentloaded')

    const bodyText = await page.locator('body').textContent()
    expect((bodyText || '').trim().length).toBeGreaterThan(50)
    console.log('  [5] Bot detail page loaded')
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-bot-detail.png'), fullPage: true })

    // --- 6. "Back to Traders" link ---
    await page.goto('/rankings/bots', { waitUntil: 'domcontentloaded', timeout: LONG_TIMEOUT })
    await page.locator('h1').waitFor({ state: 'visible', timeout: LONG_TIMEOUT })
    await page.waitForTimeout(3000)

    // The "Back to Traders" link now points to "/"
    const backLink = page.locator('a[href="/"]', { hasText: /Traders|Back|排行/i })
    if ((await backLink.count()) > 0) {
      await backLink.first().click()
      await expect(async () => {
        const url = page.url()
        expect(url.endsWith('/') || url.endsWith(':3000')).toBe(true)
      }).toPass({ timeout: 15_000 })
      console.log('  [6] Back to Traders link works')
    } else {
      console.log('  [6] Back to Traders link not found (may be in sub-nav)')
    }
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '06-back-to-traders.png'),
      fullPage: true,
    })

    // Report errors
    if (consoleErrors.length) console.log(`  Console errors: ${consoleErrors.length}`)
    if (networkErrors.length) console.log(`  500 responses: ${networkErrors.join(', ')}`)
  })

  /* ============================================================== */
  /*  TOKENS PAGE + SUB-NAV: Tests 7-9                              */
  /* ============================================================== */
  test('tokens page + sub-nav: renders, error handling, navigation', async ({ page }) => {
    const { consoleErrors, networkErrors } = attachErrorCollectors(page)

    // --- 7. Sub-nav tabs ---
    // Sub-nav is in the rankings layout, visible on /rankings/bots and /rankings/tokens
    await page.goto('/rankings/bots', { waitUntil: 'domcontentloaded', timeout: LONG_TIMEOUT })
    await dismissOverlays(page)
    await page.locator('h1').waitFor({ state: 'visible', timeout: LONG_TIMEOUT })
    await page.waitForTimeout(3000)

    // The sub-nav should have "Traders" (-> /) and "Tokens" (-> /rankings/tokens)
    const tokensTab = page.locator('a[href="/rankings/tokens"]')
    const tradersTab = page.locator('a[href="/"]')

    const tokensVisible = (await tokensTab.count()) > 0
    console.log(`  [7] Tokens tab visible: ${tokensVisible}`)
    expect(tokensVisible).toBe(true)

    // Click Tokens tab
    await tokensTab.first().click()
    await expect(async () => {
      expect(page.url()).toContain('/rankings/tokens')
    }).toPass({ timeout: 15_000 })
    console.log('  [7] Navigated to Tokens via sub-nav')
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '07a-tokens-tab.png'), fullPage: true })

    // Click Traders tab to go back to homepage
    const tradersTabOnTokens = page.locator('a[href="/"]').first()
    if ((await tradersTabOnTokens.count()) > 0) {
      await tradersTabOnTokens.click()
      await expect(async () => {
        const url = page.url()
        expect(url.endsWith('/') || url.endsWith(':3000')).toBe(true)
      }).toPass({ timeout: 15_000 })
      console.log('  [7] Navigated back to Traders (homepage)')
    }
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '07b-traders-tab.png'),
      fullPage: true,
    })

    // --- 8. /rankings/tokens renders token cards ---
    await page.goto('/rankings/tokens', { waitUntil: 'domcontentloaded', timeout: LONG_TIMEOUT })
    await dismissOverlays(page)
    await page.waitForTimeout(8000) // Wait for client-side data fetch

    const tokenCards = page.locator('a[href^="/rankings/tokens/"]')
    const cardCount = await tokenCards.count()

    if (cardCount > 0) {
      console.log(`  [8] Token cards rendered: ${cardCount}`)
      const btcCard = page.locator('a[href="/rankings/tokens/BTC"]')
      if ((await btcCard.count()) > 0) {
        await expect(btcCard).toBeVisible()
      }
    } else {
      console.log('  [8] No token cards — checking graceful fallback')
      const bodyContent = await page.locator('body').textContent()
      expect((bodyContent || '').trim().length).toBeGreaterThan(20)
    }
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '08-tokens-page.png'), fullPage: true })

    // --- 9. Error boundary (if active) ---
    const errorIndicators = page.locator('text=/Error|something went wrong|Try again/i')
    if ((await errorIndicators.count()) > 0) {
      console.log('  [9] Error boundary detected')
      const retryBtn = page.locator('button', { hasText: /try again|retry|reset/i })
      if ((await retryBtn.count()) > 0) {
        await expect(retryBtn.first()).toBeVisible()
        console.log('  [9] Retry button found')
      }
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, '09-tokens-error-boundary.png'),
        fullPage: true,
      })
    } else {
      console.log('  [9] No error boundary — tokens loaded OK')
    }

    if (networkErrors.length) console.log(`  500 errors: ${networkErrors.join(', ')}`)
    if (consoleErrors.length) console.log(`  Console errors: ${consoleErrors.length}`)
  })

  /* ============================================================== */
  /*  MOBILE + ERROR AUDIT: Tests 10-11                              */
  /* ============================================================== */
  test('mobile viewport + error audit', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
    })
    const page = await context.newPage()
    const { consoleErrors, networkErrors } = attachErrorCollectors(page)

    // --- 10. Mobile bots page ---
    await page.goto('/rankings/bots', { waitUntil: 'domcontentloaded', timeout: LONG_TIMEOUT })
    await dismissOverlays(page)
    await page.locator('h1').waitFor({ state: 'visible', timeout: LONG_TIMEOUT })

    const botRows = page.locator('a[href^="/bot/"]')
    await botRows.first().waitFor({ state: 'visible', timeout: LONG_TIMEOUT })
    const mobileRowCount = await botRows.count()
    console.log(`  [10] Mobile bot rows: ${mobileRowCount}`)
    expect(mobileRowCount).toBeGreaterThan(0)

    // Time window buttons visible
    const windowBtns = page.locator('button', { hasText: /^(7D|30D|90D)$/ })
    expect(await windowBtns.count()).toBeGreaterThanOrEqual(3)

    // Check horizontal overflow
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth)
    if (bodyWidth > 395) {
      console.log(`  [10] WARNING: Horizontal overflow (body=${bodyWidth}px, viewport=375px)`)
    } else {
      console.log('  [10] No horizontal overflow')
    }

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '10-mobile-bots.png'), fullPage: true })

    // --- 11. Error audit ---
    const criticalErrors = consoleErrors.filter((e) => {
      const lower = e.toLowerCase()
      if (lower.includes('favicon')) return false
      if (lower.includes('cors')) return false
      if (lower.includes('extension')) return false
      if (lower.includes('devtools')) return false
      if (lower.includes('websocket')) return false
      if (lower.includes('hydration')) return false
      if (lower.includes('failed to load resource') && lower.includes('404')) return false
      return true
    })

    console.log(`\n  === [11] Error Audit ===`)
    console.log(`  Total console errors: ${consoleErrors.length}`)
    console.log(`  Critical console errors: ${criticalErrors.length}`)
    console.log(`  500 network responses: ${networkErrors.length}`)

    if (criticalErrors.length) {
      console.log('  Critical errors:')
      criticalErrors.slice(0, 5).forEach((e) => console.log(`    - ${e.slice(0, 150)}`))
    }
    if (networkErrors.length) {
      console.log('  500 responses:')
      networkErrors.forEach((e) => console.log(`    - ${e}`))
    }

    await context.close()
  })
})
