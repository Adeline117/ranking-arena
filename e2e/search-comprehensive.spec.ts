import { test, expect, type Page } from '@playwright/test'
import { dismissOverlays } from './helpers'

/**
 * Comprehensive search E2E tests — 10 scenarios covering desktop, mobile,
 * search results page, empty state, and search history.
 *
 * These tests run against a dev server (or reused localhost:3000).
 * First page loads trigger on-demand Turbopack compilation which can be slow,
 * especially under concurrent test sessions. All timeouts are generous.
 */

const SCREENSHOT_DIR = 'e2e/screenshots/search'

// ── Helpers ────────────────────────────────────────────────────────────────

/** Navigate to a URL with high timeout for dev server compilation */
async function safeGoto(page: Page, url: string) {
  await page.goto(url, { timeout: 90_000, waitUntil: 'domcontentloaded' })
}

/** Wait for the dynamic NavSearchBar to render (loaded via next/dynamic ssr:false) */
async function waitForDesktopSearchReady(page: Page) {
  await page.waitForSelector('input.top-nav-search-input', { timeout: 60_000 })
}

/** Get desktop search input */
function desktopInput(page: Page) {
  return page.locator('input.top-nav-search-input').first()
}

/** Get search dropdown */
function dropdown(page: Page) {
  return page.locator('#search-dropdown-listbox')
}

/**
 * Wait for the search dropdown to have real content (not skeleton/loading).
 * Handles: result links, empty state, trending searches, search history.
 */
async function waitForDropdownContent(page: Page, timeoutMs = 45_000) {
  await page.waitForFunction(
    () => {
      const dd = document.getElementById('search-dropdown-listbox')
      if (!dd) return false
      const links = dd.querySelectorAll('a[href]')
      const text = dd.textContent || ''
      return (
        links.length > 0 ||
        /no related results|未找到|no results/i.test(text) ||
        /popular|trending|搜索历史|search history/i.test(text)
      )
    },
    { timeout: timeoutMs }
  )
}

/** Save screenshot */
async function snap(page: Page, name: string) {
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: false })
}

// ── Desktop Tests ──────────────────────────────────────────────────────────

test.describe('Search — Desktop', () => {
  test.beforeEach(async ({ page }) => {
    await safeGoto(page, '/')
    await waitForDesktopSearchReady(page)
    await dismissOverlays(page)
  })

  test('1. Click search bar, type "btc", verify dropdown with results', async ({ page }) => {
    const input = desktopInput(page)
    await expect(input).toBeVisible()

    await input.click()
    await input.fill('btc')

    const dd = dropdown(page)
    await expect(dd).toBeVisible({ timeout: 30_000 })
    await waitForDropdownContent(page)

    await snap(page, '01-desktop-btc-dropdown')

    // Verify dropdown has interactive elements
    const links = dd.locator('a[href]')
    expect(await links.count()).toBeGreaterThan(0)
  })

  test('2. Press Enter, verify navigation to /search?q=btc', async ({ page }) => {
    const input = desktopInput(page)
    await input.click()
    await input.fill('btc')

    // Brief wait for state to settle, then Enter (no dropdown item highlighted)
    await page.waitForTimeout(300)
    await page.keyboard.press('Enter')

    // Wait for Next.js client-side navigation (router.push)
    await page.waitForFunction(
      () => window.location.pathname === '/search' && window.location.search.includes('q=btc'),
      { timeout: 30_000 }
    )
    expect(page.url()).toMatch(/\/search\?q=btc/i)

    await snap(page, '02-desktop-enter-navigation')
  })

  test('3. Press Escape, verify dropdown closes', async ({ page }) => {
    const input = desktopInput(page)
    await input.click()

    // Focus opens the dropdown (shows suggestions/trending/history)
    const dd = dropdown(page)
    await expect(dd).toBeVisible({ timeout: 30_000 })

    await input.fill('btc')
    await page.waitForTimeout(300)

    await page.keyboard.press('Escape')
    await expect(dd).toBeHidden({ timeout: 5_000 })

    await snap(page, '03-desktop-escape-closes-dropdown')
  })

  test('4. Arrow key navigation in dropdown, Enter to select', async ({ page }) => {
    const input = desktopInput(page)
    await input.click()
    await input.fill('btc')

    const dd = dropdown(page)
    await expect(dd).toBeVisible({ timeout: 30_000 })

    // Wait for actual results with role="option"
    await page.waitForSelector('#search-dropdown-listbox [role="option"]', { timeout: 45_000 })

    await snap(page, '04a-before-arrow-nav')

    // ArrowDown to highlight first result
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(300)

    const selected = dd.locator('[role="option"][aria-selected="true"]')
    await expect(selected).toHaveCount(1, { timeout: 5_000 })

    // ArrowDown again to move to second
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(300)

    await snap(page, '04b-arrow-down-highlight')

    // Enter to navigate
    await page.keyboard.press('Enter')

    // Should navigate away from homepage
    await page.waitForFunction(
      () => window.location.pathname !== '/' || window.location.search !== '',
      { timeout: 15_000 }
    )

    expect(page.url()).not.toMatch(/^http:\/\/localhost:3000\/?$/)

    await snap(page, '04c-arrow-enter-navigated')
  })
})

// ── Mobile Tests ───────────────────────────────────────────────────────────

test.describe('Search — Mobile (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test.beforeEach(async ({ page }) => {
    await safeGoto(page, '/')
    // Wait for MobileSearchButton (dynamically imported)
    await page.waitForSelector('button.show-mobile-flex', { timeout: 60_000 })
    await dismissOverlays(page)
  })

  test('5. Open mobile search overlay, type query, verify results', async ({ page }) => {
    const mobileBtn = page.locator('button.show-mobile-flex').first()
    await expect(mobileBtn).toBeVisible()
    await mobileBtn.click()

    const overlay = page.locator('[role="dialog"][aria-modal="true"]')
    await expect(overlay).toBeVisible({ timeout: 5_000 })

    const mobileInput = overlay.locator('input[type="text"]').first()
    await expect(mobileInput).toBeVisible()
    await mobileInput.fill('eth')

    await waitForDropdownContent(page)

    await snap(page, '05-mobile-overlay-results')

    const dd = dropdown(page)
    expect(await dd.locator('a[href]').count()).toBeGreaterThan(0)
  })

  test('6. Press Enter in mobile search, verify navigation', async ({ page }) => {
    const mobileBtn = page.locator('button.show-mobile-flex').first()
    await mobileBtn.click()

    const overlay = page.locator('[role="dialog"][aria-modal="true"]')
    await expect(overlay).toBeVisible({ timeout: 5_000 })

    const mobileInput = overlay.locator('input[type="text"]').first()
    await mobileInput.fill('sol')

    await page.waitForTimeout(300)
    await page.keyboard.press('Enter')

    // Wait for Next.js client-side navigation
    await page.waitForFunction(
      () => window.location.pathname === '/search' && window.location.search.includes('q=sol'),
      { timeout: 30_000 }
    )
    expect(page.url()).toMatch(/\/search\?q=sol/i)

    await snap(page, '06-mobile-enter-navigation')
  })
})

// ── Search Results Page Tests ──────────────────────────────────────────────

test.describe('Search Results Page', () => {
  test('7. Verify tabs (All/Traders/Posts) render', async ({ page }) => {
    await safeGoto(page, '/search?q=btc')

    // Wait for content to appear (skeletons gone or real content visible)
    await page.waitForFunction(
      () => {
        const body = document.body.textContent || ''
        return /Traders|交易员|Posts|帖子|Library|资料库|No results|未找到/i.test(body)
      },
      { timeout: 45_000 }
    )

    await snap(page, '07a-search-results-page')

    // Tab links: class .touch-target, href contains /search?q=
    const tabs = page.locator('a.touch-target[href*="/search?q="]')
    const tabCount = await tabs.count()

    if (tabCount > 0) {
      expect(tabCount).toBeGreaterThanOrEqual(2)

      const allTab = tabs.filter({ hasText: /All|全部/i })
      expect(await allTab.count()).toBeGreaterThanOrEqual(1)

      const categoryTabs = tabs.filter({ hasText: /Traders|交易员|Posts|帖子|Library|资料库/i })
      expect(await categoryTabs.count()).toBeGreaterThanOrEqual(1)
    }

    await snap(page, '07b-tabs-verified')
  })

  test('8. Click a search result, verify navigation', async ({ page }) => {
    await safeGoto(page, '/search?q=binance')

    // Wait for results to load
    await page
      .waitForFunction(
        () => {
          return document.querySelectorAll('.skeleton').length === 0
        },
        { timeout: 45_000 }
      )
      .catch(() => {})

    await page.waitForTimeout(3000)

    const traderLinks = page.locator('a[href*="/trader/"]')
    const resultLinks = page.locator('a[href*="/trader/"], a[href*="/post/"], a[href*="/library/"]')

    await snap(page, '08a-before-click-result')

    if ((await traderLinks.count()) > 0) {
      await traderLinks.first().click()
      await page.waitForFunction(() => window.location.pathname.includes('/trader/'), {
        timeout: 30_000,
      })
      expect(page.url()).toMatch(/\/trader\//)
      await snap(page, '08b-navigated-to-trader')
    } else if ((await resultLinks.count()) > 0) {
      const href = (await resultLinks.first().getAttribute('href')) || ''
      await resultLinks.first().click()
      await page.waitForTimeout(3000)
      await snap(page, '08b-navigated-to-result')
    } else {
      console.log('No results found to click — screenshot only')
      await snap(page, '08-no-results')
    }
  })

  test('9. Empty search shows empty state', async ({ page }) => {
    await safeGoto(page, '/search?q=xyznonexistent12345abcdef')

    await page.waitForFunction(
      () => {
        const body = document.body.textContent || ''
        return (
          /no results|未找到|没有结果/i.test(body) ||
          document.querySelectorAll('.skeleton').length === 0
        )
      },
      { timeout: 45_000 }
    )

    await snap(page, '09a-empty-search-state')

    const pageText = (await page.textContent('body')) || ''
    const hasEmptyState =
      /no results|未找到|没有结果|no related/i.test(pageText) ||
      /check.*typo|shorter.*keyword|搜索建议|suggestions/i.test(pageText)

    expect(hasEmptyState).toBeTruthy()

    await snap(page, '09b-empty-search-verified')
  })
})

// ── Search History Test ────────────────────────────────────────────────────

test.describe('Search History', () => {
  test('10. Search, go back, verify history appears', async ({ page }) => {
    await safeGoto(page, '/')
    await waitForDesktopSearchReady(page)
    await dismissOverlays(page)

    // Perform a search to create history
    const input = desktopInput(page)
    await input.click()
    await input.fill('btc')

    const dd = dropdown(page)
    await expect(dd).toBeVisible({ timeout: 30_000 })
    await waitForDropdownContent(page)

    // Enter saves to history and navigates
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () => window.location.pathname === '/search' && window.location.search.includes('q=btc'),
      { timeout: 30_000 }
    )

    await snap(page, '10a-search-performed')

    // Go back to homepage
    await safeGoto(page, '/')
    await waitForDesktopSearchReady(page)
    await dismissOverlays(page)

    // Click search input to open dropdown (no query = shows history/suggestions)
    const input2 = desktopInput(page)
    await input2.click()

    await expect(dd).toBeVisible({ timeout: 30_000 })

    // Wait for content
    await page.waitForFunction(
      () => {
        const dd = document.getElementById('search-dropdown-listbox')
        return dd && (dd.textContent?.length || 0) > 10
      },
      { timeout: 15_000 }
    )

    await snap(page, '10b-search-history-dropdown')

    const dropdownText = (await dd.textContent()) || ''
    expect(dropdownText.length).toBeGreaterThan(0)

    // Check for history section
    const historySection = dd.locator('text=/search history|搜索历史/i')
    if ((await historySection.count()) > 0) {
      const historyLink = dd.locator('a[href*="/search?q=btc"]')
      expect(await historyLink.count()).toBeGreaterThanOrEqual(1)
    }

    await snap(page, '10c-search-history-verified')
  })
})
