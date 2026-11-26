import type { APIRequestContext } from '@playwright/test'
import { test, expect } from './fixtures'

/**
 * One page of the fixture board holds every kind of row the relaxed eligibility
 * rule publishes (scripts/e2e/fake-supabase.mjs): no win rate, no drawdown,
 * neither (drawdown refused), and an idle window. Every server-rendered entry
 * point that reads the board is requested here the way a crawler would, and
 * must answer with the whole page — not an error, and not an empty board
 * because one row is incomplete. Missing metrics render as "—", never as 0.
 */
const INCOMPLETE = [
  { id: 'e2e-partial', handle: 'E2E Partial Trader' },
  { id: 'e2e-no-winrate', handle: 'E2E No WinRate Trader' },
  { id: 'e2e-no-drawdown', handle: 'E2E No Drawdown Trader' },
] as const
const IDLE = { id: 'e2e-idle', handle: 'E2E Idle Trader' }
// 30 ordinary + shared + null-metrics + alias + the three incomplete rows.
const LISTED_ROWS_PER_PERIOD = 36
const ZERO_PERCENT = /(^|[^\d.+-])0(\.0+)?%/

async function html(request: APIRequestContext, path: string): Promise<string> {
  const response = await request.get(path)
  expect(response.status(), `${path} status`).toBe(200)
  return response.text()
}

/** Visible text of the server-rendered board row that names `handle`. */
function boardRow(page: string, handle: string): string | null {
  const at = page.indexOf(`>${handle}<`)
  if (at === -1) return null
  const start = page.lastIndexOf('<a ', at)
  const end = page.indexOf('</a>', at)
  return page
    .slice(start, end)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
}

test.describe('server-rendered entry points with incomplete rows on the page', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(isMobile, 'raw requests do not depend on the viewport')
  })

  for (const range of ['90D', '30D', '7D'] as const) {
    test(`homepage first paint, ${range}: the whole page renders and missing metrics are "—"`, async ({
      request,
    }) => {
      const page = await html(request, range === '90D' ? '/' : `/?range=${range}`)
      const names = new Set(
        [...page.matchAll(/class="[^"]*ssr-trader-name[^"]*">([^<]+)</g)].map((match) => match[1])
      )
      expect(names.size, 'rows on the server-rendered board').toBe(LISTED_ROWS_PER_PERIOD)
      expect(names.has(IDLE.handle)).toBe(false)

      const both = boardRow(page, 'E2E Partial Trader')
      expect(both).not.toBeNull()
      expect(both!.match(/—/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
      expect(both).not.toMatch(ZERO_PERCENT)

      const noWinRate = boardRow(page, 'E2E No WinRate Trader')
      expect(noWinRate).toContain('—')
      expect(noWinRate).toContain('-12.0%') // its drawdown is still shown
      expect(noWinRate).not.toMatch(ZERO_PERCENT)

      const noDrawdown = boardRow(page, 'E2E No Drawdown Trader')
      expect(noDrawdown).toContain('—')
      expect(noDrawdown).toContain('60.0%') // its win rate is still shown
      expect(noDrawdown).not.toMatch(ZERO_PERCENT)
    })
  }

  test('filtered, exchange-scoped and legacy ranking URLs still answer', async ({ request }) => {
    for (const path of [
      '/?category=futures',
      '/?ex=binance_futures',
      '/?idle=1',
      '/rankings/binance_futures',
      '/rankings/exchanges',
      '/rankings/weekly',
    ]) {
      await html(request, path)
    }
  })

  test('the exchange page renders its board', async ({ request }) => {
    const page = await html(request, '/exchange/binance-futures')
    expect(page).toContain('E2E 90D Trader 1')
    expect(page).not.toContain('no published ranking')
  })

  test('each incomplete or idle trader has a profile that renders without a zero metric', async ({
    request,
  }) => {
    for (const trader of [...INCOMPLETE, IDLE]) {
      const page = await html(request, `/trader/${trader.id}?platform=binance_futures`)
      expect(page, `${trader.id} heading`).toContain(trader.handle)
      const start = page.indexOf('aria-labelledby="trader-summary-heading"')
      if (start === -1) continue // an idle account has no numbers to summarize
      const summary = page.slice(start, page.indexOf('</section>', start)).replace(/<[^>]+>/g, ' ')
      expect(summary, `${trader.id} summary`).not.toMatch(ZERO_PERCENT)
    }
  })

  test('share images render for incomplete and idle traders', async ({ request }) => {
    for (const trader of [...INCOMPLETE, IDLE]) {
      const response = await request.get(
        `/api/og/trader?handle=${trader.id}&source=binance_futures`
      )
      expect(response.status(), `og/trader ${trader.id}`).toBe(200)
      expect(response.headers()['content-type']).toContain('image/')
    }
    // The rank card takes its numbers from the URL; a missing win rate is omitted.
    const rank = await request.get(
      '/api/og/rank?name=E2E&handle=e2e-partial&rank=34&roi=-12.5&window=90d&total=36&platform=binance_futures'
    )
    expect(rank.status()).toBe(200)
    const exchange = await request.get('/api/og/exchange?exchange=binance_futures')
    expect(exchange.status()).toBe(200)
  })

  test('list APIs return the incomplete rows with empty metrics', async ({ request }) => {
    const traders = await request.get('/api/traders?timeRange=90D&limit=200')
    expect(traders.status()).toBe(200)
    const body = (await traders.json()) as {
      traders?: Array<Record<string, unknown>>
      data?: { traders?: Array<Record<string, unknown>> }
    }
    const list = body.traders ?? body.data?.traders ?? []
    expect(list).toHaveLength(LISTED_ROWS_PER_PERIOD)
    const byHandle = (handle: string) => list.find((trader) => trader.handle === handle)
    expect(byHandle('E2E No WinRate Trader')).toMatchObject({ win_rate: null, max_drawdown: 12 })
    expect(byHandle('E2E No Drawdown Trader')).toMatchObject({ win_rate: 60, max_drawdown: null })

    for (const path of ['/api/rankings?window=90D', '/api/sidebar/top-traders']) {
      const response = await request.get(path)
      expect(response.status(), path).toBe(200)
    }
  })

  test('the sitemap lists incomplete traders and leaves the idle one out', async ({ request }) => {
    const shard = await html(request, '/api/sitemap-xml?shard=1')
    for (const trader of INCOMPLETE) expect(shard).toContain(`/trader/${trader.id}?`)
    expect(shard).not.toContain(`/trader/${IDLE.id}?`)
  })
})
