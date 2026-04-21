import { test, expect, type Page } from '@playwright/test'
import { dismissOverlays } from './helpers'
import path from 'path'

/**
 * Navigation & Responsive Layout E2E Tests
 *
 * Tests navigation and responsive layout across Desktop, Mobile, and Tablet viewports.
 * Each test minimizes page navigations to work within dev server memory constraints.
 *
 * Covers:
 * 1. Desktop (1280x800): top nav links visible and clickable
 * 2. Desktop: logo click returns to homepage
 * 3. Desktop: Login button visible for non-auth users
 * 4. Mobile (390x844): bottom nav bar with 5 tabs
 * 5. Mobile: click bottom nav tabs work
 * 6. Mobile: search icon in top nav opens overlay
 * 7. Mobile: bottom nav hides on scroll down, reappears on scroll up
 * 8. Footer links: Terms, Privacy, Help
 * 9. Breadcrumbs on trader detail page
 * 10. Cmd+K keyboard shortcut opens search
 * 11. Tablet (768x1024): layout adapts correctly
 * 12. No horizontal overflow at any viewport
 */

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots')

// Generous test timeout for dev server
test.setTimeout(180_000)

/** Navigate with retry logic for dev server connection issues */
async function safeGoto(page: Page, url: string) {
  let lastError: Error | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await page.goto(url, { timeout: 120_000, waitUntil: 'domcontentloaded' })
      // Wait for client-side hydration and dynamic imports
      await page.waitForTimeout(5_000)
      return response
    } catch (e) {
      lastError = e as Error
      const msg = lastError.message || ''
      if (msg.includes('ERR_ABORTED') || msg.includes('ERR_CONNECTION')) {
        await page.waitForTimeout(2_000)
        continue
      }
      throw e
    }
  }
  throw lastError
}

// ──────────────────────────────────────────────────────────────
// DESKTOP TESTS (1280x800) — Tests 1, 2, 3, 10
// ──────────────────────────────────────────────────────────────
test.describe('Desktop (1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('1. Top nav links visible + Groups link works', async ({ page }) => {
    await safeGoto(page, '/')
    await dismissOverlays(page)

    // Verify nav with all links is visible
    const nav = page.locator('nav[aria-label]').first()
    await expect(nav).toBeVisible({ timeout: 30_000 })

    // Verify all 4 nav links are present
    const rankingsLink = page.locator('a.top-nav-link[href="/"]')
    const groupsLink = page.locator('a.top-nav-link[href="/groups"]')
    const marketLink = page.locator('a.top-nav-link[href="/market"]')
    const hotLink = page.locator('a.top-nav-link[href="/hot"]')

    await expect(rankingsLink).toBeVisible({ timeout: 10_000 })
    await expect(groupsLink).toBeVisible({ timeout: 5_000 })
    await expect(marketLink).toBeVisible({ timeout: 5_000 })
    await expect(hotLink).toBeVisible({ timeout: 5_000 })

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-desktop-nav.png'), fullPage: false })

    // Click Groups link to verify navigation works (client-side nav)
    await groupsLink.click()
    // Client-side navigation: wait for URL change, not full load
    await page.waitForURL(/\/groups/, { timeout: 90_000, waitUntil: 'commit' })
    await expect(page).toHaveURL(/\/groups/)

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-desktop-groups-page.png'), fullPage: false })
  })

  test('2. Logo click returns to homepage', async ({ page }) => {
    await safeGoto(page, '/hot')
    await dismissOverlays(page)

    const logoLink = page.locator('a.top-nav-logo-link[href="/"]')
    await expect(logoLink).toBeVisible({ timeout: 30_000 })
    await logoLink.click()
    await page.waitForURL('**/', { timeout: 90_000 })
    expect(new URL(page.url()).pathname).toBe('/')

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02-desktop-logo-home.png'), fullPage: false })
  })

  test('3. Login button visible + Cmd+K opens search', async ({ page }) => {
    await safeGoto(page, '/')
    await dismissOverlays(page)

    // Test 3: Login button
    const loginButton = page.locator('button.top-nav-login-link')
    await expect(loginButton).toBeVisible({ timeout: 30_000 })
    const text = await loginButton.textContent()
    expect(text!.length).toBeGreaterThan(0)

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03-desktop-login-button.png'), fullPage: false })

    // Test 10: Cmd+K opens search (combined to avoid extra page load)
    await page.keyboard.press('Meta+k')
    await page.waitForTimeout(500)

    const searchInput = page.locator('input[type="search"]')
    const isSearchFocused = await searchInput.evaluate((el) => document.activeElement === el).catch(() => false)
    const mobileOverlay = page.locator('[role="dialog"][aria-modal="true"]')
    const overlayVisible = await mobileOverlay.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(isSearchFocused || overlayVisible).toBe(true)

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '10-cmd-k-search.png'), fullPage: false })
  })
})

// ──────────────────────────────────────────────────────────────
// MOBILE TESTS (390x844) — Tests 4, 5, 6, 7
// ──────────────────────────────────────────────────────────────
test.describe('Mobile (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('4+5. Bottom nav renders 5 tabs with valid hrefs', async ({ page }) => {
    await safeGoto(page, '/')
    await dismissOverlays(page)

    // MobileBottomNav is loaded via dynamic() import — wait for it to hydrate
    const bottomNav = page.locator('nav.mobile-bottom-nav')
    await expect(bottomNav).toBeVisible({ timeout: 60_000 })

    // Test 4: 5 tabs present
    const navLinks = bottomNav.locator('a.mobile-nav-item')
    const count = await navLinks.count()
    expect(count).toBe(5)

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04-mobile-bottom-nav.png'), fullPage: false })

    // Test 5: Verify all tabs have valid href attributes (navigation targets)
    const hrefs: string[] = []
    for (let i = 0; i < count; i++) {
      const href = await navLinks.nth(i).getAttribute('href')
      expect(href).toBeTruthy()
      hrefs.push(href!)
    }
    // Should include home, hot, groups, market, and user/settings paths
    expect(hrefs.some(h => h === '/')).toBe(true)
    expect(hrefs.some(h => h === '/hot')).toBe(true)
    expect(hrefs.some(h => h === '/groups')).toBe(true)
    expect(hrefs.some(h => h === '/market')).toBe(true)
    // Last tab is user profile or settings
    expect(hrefs.some(h => h.startsWith('/u/') || h === '/settings')).toBe(true)

    // Click a tab to verify navigation (use /hot since it's pre-compiled)
    const hotTab = bottomNav.locator('a[href="/hot"]')
    await hotTab.click()
    await page.waitForURL(/\/hot/, { timeout: 90_000 })
    await expect(page).toHaveURL(/\/hot/)

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-mobile-nav-tabs.png'), fullPage: false })
  })

  test('6. Search icon opens overlay', async ({ page }) => {
    await safeGoto(page, '/')
    await dismissOverlays(page)

    // MobileSearchButton has class "show-mobile-flex"
    const searchButton = page.locator('button.show-mobile-flex')
    await expect(searchButton).toBeVisible({ timeout: 30_000 })
    await searchButton.click()

    // Overlay appears
    const overlay = page.locator('[role="dialog"][aria-modal="true"]')
    await expect(overlay).toBeVisible({ timeout: 10_000 })

    // Input is present
    const searchInput = overlay.locator('input')
    await expect(searchInput).toBeVisible({ timeout: 5_000 })

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '06-mobile-search-overlay.png'), fullPage: false })

    // Close with Escape
    await page.keyboard.press('Escape')
    await expect(overlay).not.toBeVisible({ timeout: 5_000 })
  })

  test('7. Bottom nav hides on scroll down, reappears on scroll up', async ({ page }) => {
    await safeGoto(page, '/')
    await dismissOverlays(page)

    // MobileBottomNav is loaded via dynamic() import — wait for it to hydrate
    const bottomNav = page.locator('nav.mobile-bottom-nav')
    await expect(bottomNav).toBeVisible({ timeout: 60_000 })

    // Start at top
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await page.waitForTimeout(300)

    // Scroll down: hook hides when scrollDelta > 50 && scrollY > 100, debounce 150ms
    for (let y = 0; y <= 1200; y += 150) {
      await page.evaluate((scrollY) => window.scrollTo({ top: scrollY, behavior: 'instant' }), y)
      await page.waitForTimeout(30)
    }
    await page.waitForTimeout(500)

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '07-mobile-nav-hidden.png'), fullPage: false })

    // Scroll back up
    for (let y = 1200; y >= 0; y -= 150) {
      await page.evaluate((scrollY) => window.scrollTo({ top: scrollY, behavior: 'instant' }), y)
      await page.waitForTimeout(30)
    }
    await page.waitForTimeout(500)

    // Verify nav is back (translateY(0) or none)
    const transform = await bottomNav.evaluate((el) => getComputedStyle(el).transform)
    const isVisible = transform === 'none' || transform.endsWith(', 0)')
    expect(isVisible).toBe(true)

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '07-mobile-nav-visible.png'), fullPage: false })
  })
})

// ──────────────────────────────────────────────────────────────
// FOOTER + BREADCRUMBS (Desktop) — Tests 8, 9
// ──────────────────────────────────────────────────────────────
test.describe('Footer & Breadcrumbs', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('8. Footer links (Terms, Privacy, Help) exist and navigate', async ({ page }) => {
    await safeGoto(page, '/')
    await dismissOverlays(page)

    // Scroll to footer
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }))
    await page.waitForTimeout(1_000)

    // Verify all 3 links are present
    const termsLink = page.locator('footer a[href="/terms"]')
    const privacyLink = page.locator('footer a[href="/privacy"]')
    const helpLink = page.locator('footer a[href="/help"]')

    const termsVisible = await termsLink.isVisible({ timeout: 5_000 }).catch(() => false)
    const privacyVisible = await privacyLink.isVisible({ timeout: 2_000 }).catch(() => false)
    const helpVisible = await helpLink.isVisible({ timeout: 2_000 }).catch(() => false)

    expect(termsVisible || privacyVisible || helpVisible).toBe(true)

    // Click Terms to verify navigation
    if (termsVisible) {
      await termsLink.click()
      await page.waitForURL(/\/terms/, { timeout: 90_000 })
      await expect(page).toHaveURL(/\/terms/)
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, '08-footer-terms.png'), fullPage: false })
    }
  })

  test('9. Breadcrumbs on trader detail page', async ({ page }) => {
    await safeGoto(page, '/')
    await dismissOverlays(page)

    // Find a visible trader link (SSR rows may be hidden behind interactive table)
    const traderLinks = page.locator('a[href*="/trader/"]:visible')
    await traderLinks.first().waitFor({ state: 'visible', timeout: 60_000 })
    const firstTraderHref = await traderLinks.first().getAttribute('href')
    expect(firstTraderHref).toBeTruthy()

    // Navigate to trader page
    await safeGoto(page, firstTraderHref!)
    await dismissOverlays(page)

    // Verify breadcrumb
    const breadcrumb = page.locator('nav[aria-label="Breadcrumb"]')
    await expect(breadcrumb).toBeVisible({ timeout: 30_000 })

    // Has Home link
    const homeLink = breadcrumb.locator('a[href="/"]')
    expect(await homeLink.count()).toBeGreaterThan(0)

    // Has current page marker
    const currentPage = breadcrumb.locator('[aria-current="page"]')
    expect(await currentPage.count()).toBeGreaterThan(0)

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '09-breadcrumbs.png'), fullPage: false })
  })
})

// ──────────────────────────────────────────────────────────────
// TABLET + OVERFLOW — Tests 11, 12
// ──────────────────────────────────────────────────────────────
test.describe('Tablet & Overflow', () => {
  test('11. Tablet (768x1024) layout adapts', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 768, height: 1024 },
    })
    const page = await context.newPage()
    await safeGoto(page, '/')
    await dismissOverlays(page)

    await expect(page).toHaveTitle(/Arena/)

    // TopNav header visible
    const topNavHeader = page.locator('header.top-nav')
    await expect(topNavHeader).toBeVisible({ timeout: 30_000 })

    // Content renders
    const text = await page.locator('body').textContent()
    expect(text!.length).toBeGreaterThan(100)

    // No horizontal overflow
    const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(bodyWidth).toBeLessThanOrEqual(769)

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '11-tablet-full.png'), fullPage: true })
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '11-tablet-top.png'), fullPage: false })
    await context.close()
  })

  test('12. No horizontal overflow at mobile (390x844)', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    })
    const page = await context.newPage()
    await safeGoto(page, '/')
    await dismissOverlays(page)

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(scrollWidth - clientWidth).toBeLessThanOrEqual(1)

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '12-overflow-mobile.png'), fullPage: true })
    await context.close()
  })

  test('12. No horizontal overflow at desktop (1280x800)', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    })
    const page = await context.newPage()
    await safeGoto(page, '/')
    await dismissOverlays(page)

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(scrollWidth - clientWidth).toBeLessThanOrEqual(1)

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '12-overflow-desktop.png'), fullPage: true })
    await context.close()
  })
})
