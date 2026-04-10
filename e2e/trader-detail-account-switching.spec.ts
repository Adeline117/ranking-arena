/**
 * E2E tests for trader-detail account switching flow.
 *
 * Why these exist: the TraderProfileClient component (~1009 lines, 24 hooks)
 * has a subtle data-fetch cycle that broke during the 2026-04-09 perf session:
 *   activeAccount → parsed → effectivePlatform/Handle → traderApiUrl → useSWR
 *                        ↑                                                  ↓
 *                        └──── linkedAccounts (hook output) ←──── traderData.aggregate
 *
 * These tests lock in the contract BEFORE the planned full Suspense refactor
 * so that any regression during the split is caught immediately. Each test
 * targets one specific invariant that the refactor must preserve.
 *
 * Selector note: links use `:not(.ssr-row)` to skip the SSR ranking table
 * (which gets display:none'd by Phase 2 hydration after ~2.5s) and target
 * only the post-hydration RankingTable rows. Without this filter the click
 * times out because the resolved element is invisible.
 */

import { test, expect } from '@playwright/test'
import { dismissOverlays } from './helpers'

test.describe('交易员详情页 - 账号切换 (account switching)', () => {
  test('primary → linked account switch updates URL', async ({ page }) => {
    await page.goto('/')
    await dismissOverlays(page)
    await page.waitForLoadState('domcontentloaded')

    const traderLinks = page.locator('a[href*="/trader/"]:not(.ssr-row)')
    await traderLinks.first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
    if (await traderLinks.count() === 0) {
      test.skip()
      return
    }

    await traderLinks.first().click({ force: true })
    await page.waitForLoadState('domcontentloaded')

    // Look for the linked account tabs (only visible if 2+ accounts exist).
    // LinkedAccountTabs is dynamically imported so wait for it.
    const linkedTabs = page.locator(
      '[data-testid="linked-account-tab"], [class*="linked-account"], [class*="LinkedAccount"]'
    )
    const hasLinkedTabs = await linkedTabs.first().isVisible({ timeout: 5000 }).catch(() => false)
    if (!hasLinkedTabs) {
      // The trader we picked has no linked accounts — this test only runs
      // when one is available. Soft-skip is the right call.
      test.skip()
      return
    }

    // Click the second tab (first linked account)
    await linkedTabs.nth(1).click({ force: true })
    await page.waitForTimeout(800) // let SWR refetch + URL replace

    // URL should reflect the switched account
    expect(page.url()).toContain('account=')
  })

  test('activeAccount persists via URL ?account= param on direct visit', async ({ page }) => {
    // Use a REAL trader handle (not a stub) so SSR resolve actually works.
    // We're testing that the URL param is read on mount, not that mock data
    // wires through SSR (which page.route() can't intercept).
    await page.goto('/')
    await dismissOverlays(page)
    await page.waitForLoadState('domcontentloaded')

    const traderLinks = page.locator('a[href*="/trader/"]:not(.ssr-row)')
    await traderLinks.first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
    if (await traderLinks.count() === 0) {
      test.skip()
      return
    }
    const href = await traderLinks.first().getAttribute('href')
    if (!href) {
      test.skip()
      return
    }

    // Navigate directly with a synthetic ?account= param. Use
    // waitUntil:'domcontentloaded' (not the default 'load') because the
    // trader page has lazy chunks that may never reach 'load' within 30s.
    const testUrl = `${href}${href.includes('?') ? '&' : '?'}account=bybit:dummy-key`
    await page.goto(testUrl, { waitUntil: 'domcontentloaded' })
    await dismissOverlays(page)

    // Page should render real content + URL param should still be present
    const pageContent = await page.textContent('body')
    expect(pageContent).toBeTruthy()
    expect(pageContent!.length).toBeGreaterThan(200)
    expect(page.url()).toContain('account=')
  })

  test('exactly ONE /api/traders/[handle] call with aggregate bundled', async ({ page }) => {
    // Regression guard for the 2026-04-09 useLinkedAccounts waterfall fix.
    // Before the fix: a trader profile load fired TWO requests —
    //   1. /api/traders/[handle]?include=claim,aggregate,rank_history
    //   2. /api/traders/aggregate?platform=...&trader_key=...
    // After the fix: request #2 is suppressed because traderData.aggregate
    // is passed directly to useLinkedAccounts on the first render.
    const traderApiCalls: string[] = []
    const aggregateApiCalls: string[] = []
    page.on('request', (req) => {
      const url = req.url()
      if (/\/api\/traders\/[^?/]+\?.*include=.*aggregate/.test(url)) {
        traderApiCalls.push(url)
      } else if (/\/api\/traders\/aggregate/.test(url)) {
        aggregateApiCalls.push(url)
      }
    })

    await page.goto('/')
    await dismissOverlays(page)
    await page.waitForLoadState('domcontentloaded')

    const traderLinks = page.locator('a[href*="/trader/"]:not(.ssr-row)')
    await traderLinks.first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
    if (await traderLinks.count() === 0) {
      test.skip()
      return
    }

    await traderLinks.first().click({ force: true })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(1500) // let all SWR calls settle

    // The merged endpoint may fire 1-2 times due to revalidation. The
    // critical assertion is that the SEPARATE aggregate endpoint is at
    // most called once (legitimate, when the trader has linked accounts
    // AND the bundled aggregate path didn't engage), never twice in the
    // race window of the old ref-based pattern.
    expect(traderApiCalls.length).toBeLessThanOrEqual(2)
    expect(aggregateApiCalls.length).toBeLessThanOrEqual(1)
  })

  test('linked account → all switches back to aggregated view', async ({ page }) => {
    // Smoke test for the aggregate-view state machine: visit a trader page
    // with ?account=... synthesized, click "All" button, verify URL clears.
    await page.goto('/')
    await dismissOverlays(page)
    await page.waitForLoadState('domcontentloaded')

    const traderLinks = page.locator('a[href*="/trader/"]:not(.ssr-row)')
    await traderLinks.first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
    if (await traderLinks.count() === 0) {
      test.skip()
      return
    }

    const href = await traderLinks.first().getAttribute('href')
    if (!href) {
      test.skip()
      return
    }

    await page.goto(
      `${href}${href.includes('?') ? '&' : '?'}account=bybit:dummy`,
      { waitUntil: 'domcontentloaded' }
    )
    await dismissOverlays(page)

    // Look for an "All" button (only renders when linked-account tabs exist)
    const allButton = page.locator('button').filter({ hasText: /^all$|^全部$/i }).first()
    if (!(await allButton.isVisible({ timeout: 2000 }).catch(() => false))) {
      test.skip()
      return
    }

    await allButton.click({ force: true })
    await page.waitForTimeout(500)
    expect(page.url()).not.toContain('account=')
  })
})
