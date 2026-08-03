import { test, expect, type APIRequestContext } from '@playwright/test'

type RankingCategory = 'futures' | 'onchain'

interface RankingSample {
  key: string
  source: string
}

async function loadRankingSample(
  request: APIRequestContext,
  category: RankingCategory
): Promise<RankingSample> {
  const response = await request.get(
    `/api/rankings?window=30d&category=${category}&limit=1&_e2e=${Date.now()}`,
    { timeout: 20_000 }
  )
  expect(response.status(), `${category} ranking sample must be available`).toBe(200)

  const body = await response.json()
  const trader = body?.data?.traders?.[0]
  const key = trader?.trader_key
  const source = trader?.platform
  expect(typeof key === 'string' && key.trim().length > 0).toBeTruthy()
  expect(typeof source === 'string' && source.trim().length > 0).toBeTruthy()

  return { key: key.trim(), source: source.trim() }
}

/**
 * Regression test: /trader/* must never return 500
 *
 * Root cause (2026-04-22):
 *   1. Missing @solana-program/system broke the (app) layout SSR
 *   2. searchParams + generateStaticParams conflict caused DYNAMIC_SERVER_USAGE error
 *
 * These tests hit trader URLs directly (not via navigation) to catch
 * server-side rendering failures that only manifest on cold requests.
 *
 * Run: npx playwright test e2e/trader-detail-500-regression.spec.ts
 */

test.describe('Trader Detail 500 Regression', () => {
  test('direct URL — futures trader loads (not 500)', async ({ page, request }) => {
    const trader = await loadRankingSample(request, 'futures')
    const response = await page.goto(`/trader/${encodeURIComponent(trader.key)}`, {
      timeout: 30_000,
      waitUntil: 'domcontentloaded',
    })

    // Must not be 500
    expect(response?.status()).not.toBe(500)

    // Must have real content (not a generic error page)
    const title = await page.title()
    expect(title).not.toContain("couldn't load")
    expect(title).not.toContain('500')
  })

  test('direct URL — on-chain trader loads (not 500)', async ({ page, request }) => {
    const trader = await loadRankingSample(request, 'onchain')
    const response = await page.goto(
      `/trader/${encodeURIComponent(trader.key)}?source=${encodeURIComponent(trader.source)}`,
      {
        timeout: 30_000,
        waitUntil: 'domcontentloaded',
      }
    )

    expect(response?.status()).not.toBe(500)

    const title = await page.title()
    expect(title).not.toContain("couldn't load")
  })

  test('direct URL with ?source= param loads (not 500)', async ({ page, request }) => {
    const trader = await loadRankingSample(request, 'futures')
    const response = await page.goto(
      `/trader/${encodeURIComponent(trader.key)}?source=${encodeURIComponent(trader.source)}`,
      {
        timeout: 30_000,
        waitUntil: 'domcontentloaded',
      }
    )

    expect(response?.status()).not.toBe(500)

    const title = await page.title()
    expect(title).not.toContain("couldn't load")
  })

  test('non-existent trader returns 404 (not 500)', async ({ page }) => {
    const response = await page.goto('/trader/this-handle-does-not-exist-99999', {
      timeout: 30_000,
      waitUntil: 'domcontentloaded',
    })

    // 404 is correct; 500 means the page crashed
    const status = response?.status() ?? 0
    expect(status).not.toBe(500)
    expect(status === 200 || status === 404).toBeTruthy()
  })
})
