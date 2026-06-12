import { readFileSync } from 'fs'
import { join } from 'path'
import { parseBlofinLeaderboardPage } from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'blofin_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-11T00:00:00.000Z',
  meta: {},
}

describe('parseBlofinLeaderboardPage', () => {
  it('parses the futures board (decimal roi → percent, page_total)', () => {
    const page = parseBlofinLeaderboardPage(fixture('board-fut-30.json'), ctx)
    expect(page.reportedTotal).toBe(1662)
    expect(page.rows.length).toBe(3)
    const first = page.rows[0]
    expect(first.exchangeTraderId).toBe('27374913988')
    expect(first.rank).toBe(1)
    expect(first.nickname).toBeTruthy()
    expect(first.traderKind).toBe('human')
    // roi 4.5583 (decimal) → 455.83%
    expect(first.headlineRoi).toBeCloseTo(455.83, 1)
    expect(first.headlinePnl).toBeCloseTo(29.63, 2)
    expect(first.headlineWinRate).toBeNull()
    // deep per-TF stats + chart preserved in raw
    expect(first.raw).toMatchObject({ sharpe_ratio: expect.anything(), aum: expect.anything() })
    expect(Array.isArray((first.raw as { chart_data?: { roi?: unknown[] } }).chart_data?.roi)).toBe(
      true
    )
  })

  it('re-anchors rank from page position', () => {
    const page = parseBlofinLeaderboardPage(fixture('board-fut-7.json'), ctx)
    expect(page.rows.map((r) => r.rank)).toEqual([1, 2])
  })

  it('parses the spot board (same shape, spot_copy endpoint)', () => {
    const page = parseBlofinLeaderboardPage(fixture('board-spot-30.json'), {
      ...ctx,
      sourceSlug: 'blofin_spot',
    })
    expect(page.rows.length).toBeGreaterThan(0)
    expect(page.reportedTotal).toBeGreaterThan(0)
    expect(page.rows[0].exchangeTraderId).toBeTruthy()
  })

  it('returns empty on malformed payloads', () => {
    expect(parseBlofinLeaderboardPage({}, ctx).rows).toHaveLength(0)
    expect(parseBlofinLeaderboardPage({ data: { trader_info: 'x' } }, ctx).rows).toHaveLength(0)
  })
})
