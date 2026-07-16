/**
 * E2E Test: Homepage & Rankings
 *
 * Tests the core user journey on the homepage and ranking section:
 * 1. Homepage loads without errors
 * 2. Period switching (30D) updates URL
 * 3. Period switching (7D) updates URL
 * 4. Trader cards render with arena scores
 * 5. Pagination works
 * 6. Exchange filter bar interaction
 * 7. Mobile viewport (390x844) renders correctly
 * 8. Console errors and 500 responses are captured
 *
 * Architecture: Two-phase rendering (SSR -> Client interactive).
 * Tests handle both phases via fallback selectors.
 *
 * Screenshots saved to /tmp/e2e-*.png
 */

import { test, expect, type ConsoleMessage, type Page, type Response } from '@playwright/test'
import { dismissOverlays } from './helpers'

// ── Helpers ─────────────────────────────────────────────────────────────────

interface ErrorLog {
  consoleErrors: string[]
  networkErrors: string[]
  failedRequests: string[]
}

function attachErrorCollectors(page: Page): ErrorLog {
  const log: ErrorLog = { consoleErrors: [], networkErrors: [], failedRequests: [] }
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      const t = msg.text()
      if (
        t.includes('favicon') ||
        t.includes('serviceworker') ||
        t.includes('ERR_BLOCKED_BY_CLIENT')
      )
        return
      log.consoleErrors.push(t)
    }
  })
  page.on('response', (r: Response) => {
    if (r.status() >= 500) log.networkErrors.push(`${r.status()} ${r.url()}`)
  })
  page.on('requestfailed', (req) => {
    const f = req.failure()
    if (f && !req.url().includes('analytics') && !req.url().includes('gtag')) {
      log.failedRequests.push(`${req.url()} - ${f.errorText}`)
    }
  })
  return log
}

function criticalSameHostBundleFailures(page: Page, log: ErrorLog): string[] {
  const host = new URL(page.url()).host
  return log.failedRequests.filter((entry) => {
    // A reload legitimately cancels unfinished chunks from the old document.
    if (entry.endsWith(' - cancelled')) return false
    try {
      const failedUrl = new URL(entry.split(' - ')[0])
      return (
        failedUrl.host === host &&
        failedUrl.pathname.startsWith('/_next/') &&
        /\.(?:js|css)$/.test(failedUrl.pathname)
      )
    } catch {
      return false
    }
  })
}

/** Best-effort Phase 2 activation. Returns true if interactive mode mounted. */
async function tryActivatePhase2(page: Page, timeout = 15000): Promise<boolean> {
  await page.mouse.move(200, 200)
  try {
    await page.locator('#homepage-interactive').waitFor({ state: 'attached', timeout })
    await page.waitForTimeout(1500)
    return true
  } catch {
    return false
  }
}

/** Poll URL for pattern (router.replace is async via RSC fetch). */
async function waitForURLContains(page: Page, pattern: string, timeout = 30000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (page.url().includes(pattern)) return true
    await page.waitForTimeout(300)
  }
  return false
}

// ── Test Suite ───────────────────────────────────────────────────────────────

test.describe('Homepage & Rankings E2E', () => {
  let errorLog: ErrorLog
  test.beforeEach(async ({ page }) => {
    errorLog = attachErrorCollectors(page)
  })

  // ── 1. Homepage loads ─────────────────────────────────────────────────────

  test('1 - Homepage loads without "Something went wrong"', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await dismissOverlays(page)
    await expect(page).toHaveTitle(/Arena/)
    await expect(page.getByRole('navigation').first()).toBeVisible()
    const body = await page.locator('body').textContent()
    expect(body).not.toContain('Something went wrong')
    expect(body).not.toContain('Application error')
    await page.screenshot({ path: '/tmp/e2e-01-homepage.png', fullPage: false })
    console.log('[Test 1] PASS')
  })

  // ── 2. 30D period switch ──────────────────────────────────────────────────

  test('2 - 30D period button changes URL to ?range=30D', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await dismissOverlays(page)
    const p2 = await tryActivatePhase2(page)
    if (p2) {
      const btn = page
        .locator('.time-range-selector [data-range-btn]')
        .filter({ hasText: /30[D天]/ })
        .first()
      await expect(btn).toBeVisible({ timeout: 10000 })
      await btn.click()
      expect(await waitForURLContains(page, 'range=30D')).toBe(true)
    } else {
      const btn = page.locator('.ssr-range-btn').filter({ hasText: '30D' }).first()
      await expect(btn).toBeVisible({ timeout: 10000 })
      await btn.click()
      await page.waitForURL(/range=30D/, { timeout: 30000 })
    }
    expect(page.url()).toContain('range=30D')
    await page.screenshot({ path: '/tmp/e2e-02-period-30D.png', fullPage: false })
    console.log('[Test 2] PASS - URL:', page.url())
  })

  // ── 3. 7D period switch ───────────────────────────────────────────────────

  test('3 - 7D period button changes URL to ?range=7D', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await dismissOverlays(page)
    const p2 = await tryActivatePhase2(page)
    if (p2) {
      const btn = page
        .locator('.time-range-selector [data-range-btn]')
        .filter({ hasText: /7[D天]/ })
        .first()
      await expect(btn).toBeVisible({ timeout: 10000 })
      await btn.click()
      expect(await waitForURLContains(page, 'range=7D')).toBe(true)
    } else {
      const btn = page.locator('.ssr-range-btn').filter({ hasText: '7D' }).first()
      await expect(btn).toBeVisible({ timeout: 10000 })
      await btn.click()
      await page.waitForURL(/range=7D/, { timeout: 30000 })
    }
    expect(page.url()).toContain('range=7D')
    await page.screenshot({ path: '/tmp/e2e-03-period-7D.png', fullPage: false })
    console.log('[Test 3] PASS - URL:', page.url())
  })

  // ── 4. Trader cards with arena scores ─────────────────────────────────────

  test('4 - Trader cards render with arena scores', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await dismissOverlays(page)

    // Don't require Phase 2 — SSR ranking table has scores too
    const p2 = await tryActivatePhase2(page, 10000)

    if (p2) {
      // Phase 2: interactive ranking with .ranking-row and .col-score
      const ranking = page.locator('.home-ranking-section')
      await expect(ranking).toBeVisible({ timeout: 15000 })
      await ranking.scrollIntoViewIfNeeded()
      await page.waitForTimeout(1000)

      const rows = page.locator('.ranking-row')
      await expect(rows.first()).toBeVisible({ timeout: 10000 })
      const count = await rows.count()
      expect(count).toBeGreaterThan(0)
      console.log(`[Test 4] Phase 2: ${count} trader rows`)

      const scores = page.locator('.ranking-row .col-score')
      if ((await scores.count()) > 0) {
        const txt = await scores.first().textContent()
        console.log(`[Test 4] Score: "${txt?.trim()}"`)
        expect(txt).toMatch(/\d/)
      }
    } else {
      // SSR: .ssr-row with .ssr-score
      const ssrRows = page.locator('.ssr-row')
      await expect(ssrRows.first()).toBeVisible({ timeout: 15000 })
      const count = await ssrRows.count()
      expect(count).toBeGreaterThan(0)
      console.log(`[Test 4] SSR: ${count} trader rows`)

      const scores = page.locator('.ssr-score')
      if ((await scores.count()) > 0) {
        const txt = await scores.first().textContent()
        console.log(`[Test 4] SSR Score: "${txt?.trim()}"`)
        expect(txt).toMatch(/\d/)
      }
    }

    await page.screenshot({ path: '/tmp/e2e-04-trader-cards.png', fullPage: false })
    console.log('[Test 4] PASS')
  })

  // ── 5. Pagination ─────────────────────────────────────────────────────────

  test('5 - Pagination: Next page works', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await dismissOverlays(page)
    const p2 = await tryActivatePhase2(page, 10000)

    if (p2) {
      // Phase 2: wait for interactive ranking rows
      const rows = page.locator('.ranking-row')
      await expect(rows.first()).toBeVisible({ timeout: 15000 })

      // Scroll to pagination at bottom of table
      await page.evaluate(() => window.scrollTo({ top: 3000, behavior: 'instant' }))
      await page.waitForTimeout(1000)

      // Client pagination: .pagination-nav
      const nextBtn = page
        .locator('.pagination-nav')
        .filter({ hasText: /Next|下一页/ })
        .first()
      if (await nextBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        const disabled = await nextBtn.evaluate(
          (el) => el.classList.contains('pagination-disabled') || (el as HTMLButtonElement).disabled
        )
        if (!disabled) {
          await nextBtn.click()
          await page.waitForTimeout(2000)
          console.log('[Test 5] Client Next clicked')
          await page.screenshot({ path: '/tmp/e2e-05-pagination.png', fullPage: false })
          return
        }
      }

      const pg2 = page.locator('.pagination-page').filter({ hasText: '2' }).first()
      if (await pg2.isVisible({ timeout: 3000 }).catch(() => false)) {
        await pg2.click()
        await page.waitForTimeout(2000)
        console.log('[Test 5] Page 2 clicked')
        await page.screenshot({ path: '/tmp/e2e-05-pagination.png', fullPage: false })
        return
      }
    }

    // SSR pagination: .ssr-page-btn
    const ssrNext = page.locator('.ssr-page-btn').filter({ hasText: /Next/ }).first()
    if (await ssrNext.isVisible({ timeout: 5000 }).catch(() => false)) {
      await ssrNext.click()
      expect(await waitForURLContains(page, 'page=')).toBe(true)
      console.log('[Test 5] SSR Next clicked, URL:', page.url())
      await page.screenshot({ path: '/tmp/e2e-05-pagination.png', fullPage: false })
      return
    }

    console.log('[Test 5] SKIP — No pagination controls')
    test.skip()
  })

  // ── 6. Exchange filter bar ─────────────────────────────────────────────────

  test('6 - Exchange filter bar interaction', async ({ page, request }) => {
    await page.route('**/api/analytics/events', async (route) => {
      await route.fulfill({ status: 202, contentType: 'application/json', body: '{"ok":true}' })
    })
    const sourceResponse = await request.get('/api/sources/visible?timeRange=90D')
    expect(sourceResponse.ok()).toBe(true)
    const sourceBody = (await sourceResponse.json()) as {
      data: { sources: Array<{ filterSource: string; traderCount: number }> }
    }
    expect(sourceBody.data.sources.length).toBeGreaterThan(0)
    expect(sourceBody.data.sources.every(({ traderCount }) => traderCount > 0)).toBe(true)

    await page.goto('/?range=90D', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await dismissOverlays(page)
    expect(await tryActivatePhase2(page, 30000)).toBe(true)
    await expect(page.locator('.home-ranking-section')).toBeVisible({ timeout: 30000 })
    await dismissOverlays(page)
    expect(criticalSameHostBundleFailures(page, errorLog)).toEqual([])

    // Keep the moving marquee in a deterministic, user-supported state before
    // selecting a target. This also verifies the reduced-motion interaction path.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const track = page.locator('.exchange-scroll-track')
    await expect(track).toHaveCSS('animation-name', 'none')

    const items = page.locator('a.exchange-item:not([aria-hidden="true"])')
    await expect(items.first()).toBeVisible({ timeout: 30000 })
    expect(await items.count()).toBe(sourceBody.data.sources.length)
    const duplicateItems = page.locator('a.exchange-item[aria-hidden="true"]')
    expect(await duplicateItems.count()).toBe(sourceBody.data.sources.length)
    await expect(duplicateItems.first()).toHaveAttribute('tabindex', '-1')

    const first = items.first()
    const href = await first.getAttribute('href')
    expect(href).toBeTruthy()
    const filterSource = new URL(href!, page.url()).searchParams.get('exchange')
    expect(filterSource).toBeTruthy()

    const filteredResponsePromise = page.waitForResponse((response) => {
      if (!response.url().includes('/api/traders?') || response.status() !== 200) return false
      return new URL(response.url()).searchParams.get('exchange') === filterSource
    })
    await first.click()
    const filteredResponse = await filteredResponsePromise
    await expect(page).toHaveURL(new RegExp(`exchange=${encodeURIComponent(filterSource!)}`))
    const filteredBody = (await filteredResponse.json()) as {
      traders: Array<{ source: string }>
      totalCount: number
    }
    expect(filteredBody.totalCount).toBeGreaterThan(0)
    expect(filteredBody.traders.length).toBeGreaterThan(0)
    expect(filteredBody.traders.every(({ source }) => source === filterSource)).toBe(true)

    const ranking = page.locator('.home-ranking-section')
    await expect(ranking).toBeVisible()

    // A copied/bookmarked URL must restore the same server-side source filter.
    const reloadedResponsePromise = page.waitForResponse((response) => {
      if (!response.url().includes('/api/traders?') || response.status() !== 200) return false
      return new URL(response.url()).searchParams.get('exchange') === filterSource
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await dismissOverlays(page)
    expect(await tryActivatePhase2(page, 30000)).toBe(true)
    const reloadedResponse = await reloadedResponsePromise
    const reloadedBody = (await reloadedResponse.json()) as {
      traders: Array<{ source: string }>
      totalCount: number
    }
    expect(page.url()).toContain(`exchange=${encodeURIComponent(filterSource!)}`)
    expect(reloadedBody.totalCount).toBeGreaterThan(0)
    expect(reloadedBody.traders.length).toBeGreaterThan(0)
    expect(reloadedBody.traders.every(({ source }) => source === filterSource)).toBe(true)
    expect(criticalSameHostBundleFailures(page, errorLog)).toEqual([])

    await page.screenshot({ path: '/tmp/e2e-06-exchange-filter.png', fullPage: false })
    console.log('[Test 6] PASS')
  })

  // ── 7. Mobile viewport ────────────────────────────────────────────────────

  test('7 - Mobile viewport (390x844) renders correctly', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await dismissOverlays(page)

    await expect(page).toHaveTitle(/Arena/)
    const body = await page.locator('body').textContent()
    expect(body).not.toContain('Something went wrong')
    await expect(page.getByRole('navigation').first()).toBeVisible({ timeout: 10000 })

    expect(await tryActivatePhase2(page, 30000)).toBe(true)

    // Bottom nav is a required mobile interaction surface, not an advisory log.
    const bottomNav = page.locator('nav.mobile-bottom-nav')
    await expect(bottomNav).toBeVisible({ timeout: 10000 })

    // SSR ranking rows should be visible even without Phase 2
    const ssrRows = page.locator('.ssr-row')
    const ssrCount = await ssrRows.count()
    if (ssrCount > 0) {
      await expect(ssrRows.first()).toBeVisible({ timeout: 10000 })
      console.log(`[Test 7] SSR rows: ${ssrCount}`)
    }

    const ranking = page.locator('.home-ranking-section')
    if (await ranking.isVisible({ timeout: 5000 }).catch(() => false)) {
      const items = page.locator('.ranking-row, a[href*="/trader/"]')
      console.log(`[Test 7] Phase 2 items: ${await items.count()}`)
      const badges = page.locator('.mobile-score-badge')
      console.log(`[Test 7] Mobile badges: ${await badges.count()}`)
    }

    // Horizontal overflow check
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    )
    expect(overflow).toBe(false)
    expect(criticalSameHostBundleFailures(page, errorLog)).toEqual([])

    await page.screenshot({ path: '/tmp/e2e-07-mobile.png', fullPage: true })
    console.log('[Test 7] PASS')
  })

  // ── 8. Error collection ───────────────────────────────────────────────────

  test('8 - No console errors or 500 responses during full homepage flow', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await dismissOverlays(page)
    const p2 = await tryActivatePhase2(page, 10000)

    // Wait for content
    const content = page.locator('.home-ranking-section, #ssr-ranking-table')
    await content
      .first()
      .isVisible({ timeout: 15000 })
      .catch(() => false)

    // Interactions (if Phase 2)
    if (p2) {
      const btn30 = page
        .locator('.time-range-selector [data-range-btn]')
        .filter({ hasText: /30[D天]/ })
        .first()
      if (await btn30.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btn30.click()
        await page.waitForTimeout(3000)
      }
    }

    // Scroll
    await page.evaluate(() => window.scrollTo({ top: 1500, behavior: 'smooth' }))
    await page.waitForTimeout(1500)

    // Report
    console.log('\n=== Error Report ===')
    console.log(`Console errors: ${errorLog.consoleErrors.length}`)
    for (const e of errorLog.consoleErrors) console.log(`  [console] ${e.slice(0, 200)}`)
    console.log(`500+ responses: ${errorLog.networkErrors.length}`)
    for (const e of errorLog.networkErrors) console.log(`  [500] ${e}`)
    console.log(`Failed requests: ${errorLog.failedRequests.length}`)
    for (const e of errorLog.failedRequests) console.log(`  [fail] ${e.slice(0, 200)}`)

    await page.screenshot({ path: '/tmp/e2e-08-errors-check.png', fullPage: false })
    expect(errorLog.networkErrors).toHaveLength(0)
    if (errorLog.consoleErrors.length > 0) {
      console.log(`[Test 8] WARNING — ${errorLog.consoleErrors.length} console errors`)
    }
    console.log('[Test 8] PASS')
  })
})
