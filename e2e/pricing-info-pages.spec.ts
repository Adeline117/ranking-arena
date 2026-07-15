/**
 * E2E Tests — Pricing & Info Pages
 *
 * Tests:
 * 1. /pricing — plans render (Free, Pro, Lifetime)
 * 2. /pricing — monthly/yearly toggle switch
 * 3. /pricing — CTA buttons exist and link correctly
 * 4. /pricing — FAQ section expands/collapses
 * 5. /methodology — content renders
 * 6. /help — content renders
 * 7. /terms, /privacy, /disclaimer, /dmca — each renders
 * 8. /status — content renders
 * 9. /claim — claim form renders
 * 10. /pricing — mobile viewport
 * 11. /xyz123 — 404 page
 */

import { test, expect } from '@playwright/test'
import { dismissOverlays } from './helpers'

const SCREENSHOT_DIR = 'e2e/screenshots'

// Dev server Turbopack may need extra time for on-demand compilation
test.setTimeout(180_000)

test.describe('Pricing Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pricing', { timeout: 90_000 })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)
  })

  test('1. Plans render — Free, Pro, Lifetime', async ({ page }) => {
    // Wait for pricing page client to hydrate
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })

    // Free plan
    const freePlan = page.locator('h3:has-text("Free")')
    await expect(freePlan.first()).toBeVisible()

    // Pro plan
    const proPlan = page.locator('h3:has-text("Pro")')
    await expect(proPlan.first()).toBeVisible()

    // Lifetime plan — check for "Lifetime Pro" or the founding member text
    const lifetimePlan = page.locator('text=/Lifetime|终身会员/')
    await expect(lifetimePlan.first()).toBeVisible()

    // Verify price amounts appear
    await expect(page.getByText(/^\$0\/mo$/).filter({ visible: true })).toBeVisible()
    await expect(page.getByText('$49.99', { exact: true }).filter({ visible: true })).toBeVisible()

    await page.screenshot({ path: `${SCREENSHOT_DIR}/pricing-plans.png`, fullPage: true })
  })

  test('2. Monthly/yearly toggle switch', async ({ page }) => {
    // Find the billing toggle buttons
    const monthlyBtn = page.getByRole('button', { name: /Monthly|月付|月間|월간/i })
    const yearlyBtn = page.getByRole('button', { name: /Yearly|年付|年間|연간/i })

    await expect(monthlyBtn.first()).toBeVisible()
    await expect(yearlyBtn.first()).toBeVisible()

    // Click monthly
    await monthlyBtn.first().click()
    await expect(monthlyBtn.first()).toHaveAttribute('aria-pressed', 'true')

    // In monthly mode, Pro price should show $4.99
    await expect(page.getByText(/^\$4\.99\/mo$/).filter({ visible: true })).toBeVisible()

    await page.screenshot({ path: `${SCREENSHOT_DIR}/pricing-monthly.png`, fullPage: false })

    // Click yearly
    await yearlyBtn.first().click()
    await expect(yearlyBtn.first()).toHaveAttribute('aria-pressed', 'true')

    // In yearly mode, per-month price should show $2.50 (29.99/12)
    await expect(page.getByText(/^\$2\.50\/mo/).filter({ visible: true })).toBeVisible()
    // Yearly total should show $29.99
    await expect(page.getByText(/^\$29\.99\/year/).filter({ visible: true })).toBeVisible()

    await page.screenshot({ path: `${SCREENSHOT_DIR}/pricing-yearly.png`, fullPage: false })
  })

  test('3. CTA buttons exist and link correctly', async ({ page }) => {
    // Free plan CTA — should link to /login or /user-center
    const freeCta = page.locator('a[href="/login"], a[href*="/user-center"]').first()
    await expect(freeCta).toBeVisible()

    // Pro plan CTA — should also link to /login or /user-center
    const allCtas = page.locator('a[href="/login"], a[href*="/user-center"]')
    expect(await allCtas.count()).toBeGreaterThanOrEqual(2)

    // Lifetime CTA
    const lifetimeCta = page.locator('a:has-text("Founding Member"), a:has-text("创始会员")')
    await expect(lifetimeCta.first()).toBeVisible()
    const lifetimeHref = await lifetimeCta.first().getAttribute('href')
    expect(lifetimeHref).toMatch(/\/(login|user-center)/)
  })

  test('4. FAQ section expands/collapses', async ({ page }) => {
    // Wait for page hydration — plans should be visible first
    await expect(page.locator('h3:has-text("Pro")').first()).toBeVisible({ timeout: 30_000 })

    // Scroll to FAQ section
    const faqHeading = page.locator('h2:has-text("FAQ")')
    await expect(faqHeading).toBeVisible({ timeout: 15_000 })
    await faqHeading.scrollIntoViewIfNeeded()

    // Find first FAQ details element
    const firstFaq = page.locator('details').first()
    await expect(firstFaq).toBeVisible()

    // Initially collapsed — the <p> inside should NOT be visible
    const firstFaqAnswer = firstFaq.locator('p')
    await expect(firstFaqAnswer).not.toBeVisible()

    // Click to expand
    const firstFaqSummary = firstFaq.locator('summary')
    await firstFaqSummary.click()
    await page.waitForTimeout(300)

    // Answer should now be visible
    await expect(firstFaqAnswer).toBeVisible()

    await page.screenshot({ path: `${SCREENSHOT_DIR}/pricing-faq-expanded.png`, fullPage: false })

    // Click again to collapse
    await firstFaqSummary.click()
    await page.waitForTimeout(300)

    // Answer should be hidden again
    await expect(firstFaqAnswer).not.toBeVisible()
  })
})

test.describe('Info Pages', () => {
  test('5. /methodology — content renders', async ({ page }) => {
    await page.goto('/methodology', { timeout: 90_000 })
    await page.waitForLoadState('domcontentloaded')

    // Main heading
    await expect(page.locator('h1:has-text("Methodology")')).toBeVisible({ timeout: 30_000 })

    // Key sections should be present
    await expect(page.locator('h2:has-text("Data Sources")')).toBeVisible()
    await expect(page.locator('h2:has-text("Arena Score Algorithm")')).toBeVisible()
    await expect(page.locator('h2:has-text("Time Windows")')).toBeVisible()
    await expect(page.locator('h2:has-text("Anti-Gaming")')).toBeVisible()

    // The current v4 formula and its two factors should render in the active locale.
    const scoreSection = page.locator('section').filter({ has: page.locator('#arena-score') })
    await expect(scoreSection.getByText(/100.*(?:Quality|质量|品質|품질)/i)).toBeVisible()
    await expect(scoreSection.getByText(/Confidence|置信度|信頼度|신뢰도/i).first()).toBeVisible()

    await page.screenshot({ path: `${SCREENSHOT_DIR}/methodology.png`, fullPage: true })
  })

  test('6. /help — content renders', async ({ page }) => {
    await page.goto('/help', { timeout: 90_000 })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)

    // Help center heading (English or Chinese)
    const helpHeading = page.locator('h1')
    await expect(helpHeading.first()).toBeVisible({ timeout: 30_000 })

    // FAQ sections should load — check for category titles
    const faqItems = page.locator(
      'text=/Getting Started|Subscription|Features|Account|Contact|入门|订阅|功能|账户|联系/'
    )
    await expect(faqItems.first()).toBeVisible({ timeout: 15_000 })

    // Search input should exist
    const searchInput = page.locator('input[type="text"]')
    await expect(searchInput.first()).toBeVisible()

    // Quick action cards (Upgrade to Pro, Account Settings, Contact Support)
    const quickActions = page.locator('a[href="/pricing"], a[href="/settings"]')
    expect(await quickActions.count()).toBeGreaterThanOrEqual(1)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/help.png`, fullPage: true })
  })

  test('7a. /terms — content renders', async ({ page }) => {
    await page.goto('/terms', { timeout: 90_000 })
    await page.waitForLoadState('domcontentloaded')

    await expect(page.locator('h1')).toHaveText(/Terms of Service|服务条款|利用規約|이용약관/, {
      timeout: 30_000,
    })
    await expect(page.locator('#service-description')).toBeVisible()
    await expect(page.locator('#disclaimer')).toBeVisible()

    await page.screenshot({ path: `${SCREENSHOT_DIR}/terms.png`, fullPage: true })
  })

  test('7b. /privacy — content renders', async ({ page }) => {
    await page.goto('/privacy', { timeout: 90_000 })
    await page.waitForLoadState('domcontentloaded')

    // Privacy page should have a heading
    const heading = page.locator('h1').first()
    await expect(heading).toBeVisible({ timeout: 30_000 })
    const headingText = await heading.textContent()
    expect(headingText).toMatch(/Privacy|隐私/)

    // Should have substantive content
    const bodyText = await page.locator('body').textContent()
    expect((bodyText || '').length).toBeGreaterThan(500)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/privacy.png`, fullPage: true })
  })

  test('7c. /disclaimer — content renders', async ({ page }) => {
    await page.goto('/disclaimer', { timeout: 90_000 })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)

    // Disclaimer heading — 'use client' page uses t() keys
    const heading = page.locator('h1').first()
    await expect(heading).toBeVisible({ timeout: 30_000 })

    // Should have sections with content
    const sections = page.locator('section, h2')
    expect(await sections.count()).toBeGreaterThan(0)

    const bodyText = await page.locator('body').textContent()
    expect((bodyText || '').length).toBeGreaterThan(200)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/disclaimer.png`, fullPage: true })
  })

  test('7d. /dmca — content renders', async ({ page }) => {
    await page.goto('/dmca', { timeout: 90_000 })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)

    // DMCA page heading — uses t('dmcaTitle')
    const heading = page.locator('h1').first()
    await expect(heading).toBeVisible({ timeout: 60_000 })

    const bodyText = await page.locator('body').textContent()
    expect((bodyText || '').length).toBeGreaterThan(200)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/dmca.png`, fullPage: true })
  })

  test('8. /status — content renders', async ({ page }) => {
    await page.goto('/status', { timeout: 90_000 })
    await page.waitForLoadState('domcontentloaded')

    // System Status heading
    await expect(page.locator('h1:has-text("System Status")')).toBeVisible({ timeout: 60_000 })

    // Should show loading state, error, or actual status text
    const statusText = page.locator(
      'text=/Checking|All Systems Operational|Degraded|Service Disruption|Health endpoint|Failed to fetch/'
    )
    await expect(statusText.first()).toBeVisible({ timeout: 30_000 })

    await page.screenshot({ path: `${SCREENSHOT_DIR}/status.png`, fullPage: true })
  })

  test('9. /claim — claim form renders', async ({ page }) => {
    await page.goto('/claim', { timeout: 90_000 })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)

    // Hero section should be visible — page has HeroSection component with headings
    const heroOrHeading = page.locator('h1, h2').first()
    await expect(heroOrHeading).toBeVisible({ timeout: 60_000 })

    // Search section for finding trader should be present
    const searchInput = page
      .locator('input[type="text"], input[type="search"], input[placeholder]')
      .filter({ visible: true })
    await expect(searchInput.first()).toBeVisible({ timeout: 15_000 })

    // Should have meaningful content
    const bodyText = await page.locator('body').textContent()
    expect((bodyText || '').length).toBeGreaterThan(200)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/claim.png`, fullPage: true })
  })
})

test.describe('Responsive & Error Pages', () => {
  test('10. Mobile viewport for pricing page', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    })
    const page = await context.newPage()

    await page.goto('/pricing', { timeout: 90_000 })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)

    // Page should still render all plans
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('h3:has-text("Free")').first()).toBeVisible()
    await expect(page.locator('h3:has-text("Pro")').first()).toBeVisible()
    await expect(page.locator('text=/Lifetime|终身会员/').first()).toBeVisible()

    // Toggle should still work
    const monthlyBtn = page.locator('button:has-text("Monthly"), button:has-text("monthly")')
    await expect(monthlyBtn.first()).toBeVisible()
    await monthlyBtn.first().click()

    // Pro is the conversion plan, so its price must be visible in the first fold;
    // Free still renders below it for a complete comparison.
    const freePlan = page.locator('h3:has-text("Free")').first()
    const proPlan = page.locator('h3:has-text("Pro")').first()
    const [freeBox, proBox] = await Promise.all([freePlan.boundingBox(), proPlan.boundingBox()])
    expect(freeBox).toBeTruthy()
    expect(proBox).toBeTruthy()
    if (freeBox && proBox) {
      expect(proBox.y).toBeLessThan(freeBox.y)
      expect(proBox.y).toBeLessThan(812)
      expect(proBox.x).toBeGreaterThanOrEqual(0)
      expect(proBox.x + proBox.width).toBeLessThanOrEqual(400)
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/pricing-mobile.png`, fullPage: true })

    await context.close()
  })

  test('11. Non-existent URL shows 404 page', async ({ page }) => {
    const response = await page.goto('/xyz123', { timeout: 90_000 })
    await page.waitForLoadState('domcontentloaded')

    // Should return 404 status
    expect(response?.status()).toBe(404)

    // 404 text should be visible
    await expect(page.locator('text=404')).toBeVisible({ timeout: 30_000 })

    // Should have navigation links back to home or rankings
    const homeLink = page.locator('a[href="/"]')
    await expect(homeLink.first()).toBeVisible()

    const rankingsLink = page.locator('a[href="/rankings"]')
    await expect(rankingsLink.first()).toBeVisible()

    await page.screenshot({ path: `${SCREENSHOT_DIR}/404-page.png`, fullPage: true })
  })
})
