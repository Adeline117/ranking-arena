import { readFileSync } from 'fs'
import { join } from 'path'
import { parseBlofinLeaderboardPage, parseBlofinProfile } from '../parsers'
import type { ParseCtx } from '../../../core/types'
import { resolveHeadlineLineage } from '../../../testing/headline-lineage'
import { validateLeaderboardRows } from '../../../staging/validate'

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
  it.each([
    ['blofin_futures', 'board-fut-30.json'],
    ['blofin_spot', 'board-spot-30.json'],
  ])('%s: lineage resolves against the registered board contract', (slug, file) => {
    const page = parseBlofinLeaderboardPage(fixture(file), ctx)
    expect(page.rows.length).toBeGreaterThan(0)
    expect(resolveHeadlineLineage(page.rows, slug)).toEqual({
      resolved: page.rows.length * 2,
      unresolved: [],
    })
  })

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
    // Board-level stats backfilled into trader_stats (no profile endpoint):
    // mdd (decimal ×100), sharpe, aum, copier_count all promoted off the board.
    expect(typeof first.headlineMdd).toBe('number')
    expect(typeof first.headlineSharpe).toBe('number')
    expect(typeof first.headlineAum).toBe('number')
    expect(typeof first.headlineCopierCount).toBe('number')
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

  // Public probe 2026-11-20 (30D spot board, one active and one idle trader).
  // Every spot board row carries `mdd`; an idle account reports the literal
  // "0" (90 of 129 rows on the 7D board), which is a value, not a gap.
  it('blofin_spot: the board row drawdown survives staging, including an idle 0', () => {
    const page = parseBlofinLeaderboardPage(fixture('board-spot-30-20261120.json'), {
      ...ctx,
      sourceSlug: 'blofin_spot',
    })
    const { valid, rejects } = validateLeaderboardRows(page.rows)
    expect(rejects).toEqual([])
    const [active, idle] = valid
    expect(active.exchangeTraderId).toBe('4187422152')
    expect(active.headlineMdd).toBeCloseTo(14.7976082140442, 9)
    expect(active.headlineWinRate).toBeNull() // the board row has no win rate
    expect(idle.headlineRoi).toBe(0)
    expect(idle.headlinePnl).toBe(0)
    expect(idle.headlineMdd).toBe(0)
  })

  it('blofin_spot: the detail drawdown of a period is the board drawdown of that range', () => {
    const board = parseBlofinLeaderboardPage(fixture('board-spot-30-20261120.json'), ctx).rows[0]
    const recorded = fixture('profile-capture-spot-4187422152.json') as {
      responses: Record<string, unknown>
    }
    const profile = parseBlofinProfile(
      {
        info: recorded.responses['trader/info|'],
        indicators: recorded.responses['trader/stat/indicators|D30'],
        symbolPerf: null,
        performance: recorded.responses['trader/stat/performance|D30'],
        timeframe: 30,
      },
      { ...ctx, sourceSlug: 'blofin_spot' }
    )
    expect(profile.stats[0].mdd).toBe(board.headlineMdd)
    expect(profile.stats[0].roi).toBe(board.headlineRoi)
  })

  it('returns empty on malformed payloads', () => {
    expect(parseBlofinLeaderboardPage({}, ctx).rows).toHaveLength(0)
    expect(parseBlofinLeaderboardPage({ data: { trader_info: 'x' } }, ctx).rows).toHaveLength(0)
  })
})
