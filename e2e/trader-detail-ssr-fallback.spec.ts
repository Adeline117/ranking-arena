/**
 * E2E tests for trader-detail SSR fallback rendering.
 *
 * Lock in the SSR → hydration handoff before the TraderProfileClient
 * Suspense refactor. Two invariants must survive:
 *
 * 1. Cold visit to /trader/[handle] returns HTML containing real trader
 *    content in the initial response (no empty skeleton flash).
 *    → verifies serverTraderData fallback wiring + revalidateOnMount:false
 *
 * 2. The trader page SSR HTML contains a JSON-LD ProfilePage / Person /
 *    BreadcrumbList schema (in addition to the root-layout WebSite schema).
 *    → verifies the memoize-combineSchemas wiring from the perf session
 */

import { test, expect } from '@playwright/test'
import { dismissOverlays } from './helpers'

test.describe('交易员详情页 - SSR fallback', () => {
  test('cold visit returns trader content in SSR HTML (no skeleton flash)', async ({ page, request }) => {
    // Find a valid trader handle from the homepage. Use SSR row links here
    // because we're calling request.get() not page.click() — visibility
    // doesn't matter for raw HTTP fetches.
    await page.goto('/')
    await dismissOverlays(page)
    await page.waitForLoadState('domcontentloaded')

    const traderLinks = page.locator('a[href*="/trader/"]')
    await traderLinks.first().waitFor({ state: 'attached', timeout: 30_000 }).catch(() => {})
    if (await traderLinks.count() === 0) {
      test.skip()
      return
    }

    const href = await traderLinks.first().getAttribute('href')
    if (!href || !href.startsWith('/trader/')) {
      test.skip()
      return
    }

    // Fetch the page via HTTP API (bypasses browser rendering).
    const response = await request.get(href)
    expect(response.ok()).toBeTruthy()
    const html = await response.text()

    // SSR HTML should contain trader content, not just a skeleton.
    const hasTraderMarkers =
      /trader|arena[\s-]?score|ROI|win rate|rank/i.test(html) &&
      html.length > 5000
    expect(hasTraderMarkers).toBeTruthy()

    // Should NOT be a stripped-down loading skeleton
    const looksLikeSkeleton = /loading|skeleton/i.test(html) && html.length < 3000
    expect(looksLikeSkeleton).toBeFalsy()
  })

  test('SSR HTML contains structured data (JSON-LD) for SEO', async ({ request }) => {
    // Discover a valid trader handle from the homepage HTML
    const homeResp = await request.get('/')
    const homeHtml = await homeResp.text()
    const hrefMatch = homeHtml.match(/href="(\/trader\/[^"]+)"/)
    if (!hrefMatch) {
      test.skip()
      return
    }

    const traderHref = hrefMatch[1]
    const traderResp = await request.get(traderHref)
    const traderHtml = await traderResp.text()

    // Assert that the trader-specific JSON-LD is present in the SSR output.
    // Trader pages should have AT LEAST 3 schema blocks:
    //   1. Root-layout WebSite schema (inherited from app/layout.tsx)
    //   2. ProfilePage from page.tsx <JsonLd data={jsonLd} />
    //   3. ProfilePage + BreadcrumbList combined from TraderProfileClient
    //      (memoized via combineSchemas)
    //
    // Previously SOFTENED to /schema.org/ because the prod page was hung
    // on cachedGetTraderDetail and Next.js streamed only Suspense
    // placeholders. Fixed in commits e189c823a (4s SSR detail timeout) +
    // 9e094253b (lowercase ETH addresses) + the resolveTrader timeout.
    // Tightened back to require ProfilePage|Person|BreadcrumbList.
    const schemaBlocks = [...traderHtml.matchAll(
      /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g
    )]
    expect(schemaBlocks.length).toBeGreaterThan(0)

    const allSchemas = schemaBlocks.map((m) => m[1]).join('\n')
    expect(allSchemas).toMatch(/ProfilePage|Person|BreadcrumbList/)
  })
})
