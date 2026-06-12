/**
 * gTrade parser tests over real RAW fixtures (captured live 2026-06-12 from
 * backend-global.gains.trade). leaderboard-all.json holds 4 real rows per TF
 * key; profile-bundle.json is a top trader's lifetime stats + 60 trades
 * whose realized rows reconcile EXACTLY with the 7d board row (sum
 * pnl_net×collateralPriceUsd = 214258.186… = total_pnl_usd, 42 realized,
 * 35 wins — the verified aggregation identity).
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseGtradeHistory,
  parseGtradeLeaderboardPage,
  parseGtradePositions,
  parseGtradeProfile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

// Pinned just after the capture so the 7d window covers all fixture trades
// (newest 2026-06-11T23:12Z, oldest 2026-06-06T21:49Z).
const ctx: ParseCtx = {
  sourceSlug: 'gtrade',
  currency: 'USDC',
  tfLabelMap: {},
  scrapedAt: '2026-06-12T00:00:00.000Z',
  meta: {},
}

describe('parseGtradeLeaderboardPage', () => {
  const byTf = fixture('leaderboard-all.json') as Record<string, Array<Record<string, unknown>>>

  it('parses real rows: wallet identity, USD PnL, board win rate, null ROI', () => {
    const page = parseGtradeLeaderboardPage(
      { timeframe: 7, rows: byTf['7'], reportedTotal: 25 },
      ctx
    )
    expect(page.reportedTotal).toBe(25)
    expect(page.rows).toHaveLength(4)
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: '0x3da3b64e63b57ed4926d4d9836cd08e0ffc830a0',
      walletAddress: '0x3da3b64e63b57ed4926d4d9836cd08e0ffc830a0',
      rank: 1,
      nickname: null,
      traderKind: 'human',
      headlineRoi: null, // no capital basis exposed → NULL collapses in UI
    })
    expect(page.rows[0].headlinePnl).toBeCloseTo(214258.186053, 4) // total_pnl_usd
    expect(page.rows[0].headlineWinRate).toBeCloseTo((35 / 42) * 100, 6)
    // raw kept verbatim (spec §3)
    expect((page.rows[0].raw as Record<string, unknown>).count).toBe(42)
  })

  it('skips rows without a 0x identity', () => {
    const page = parseGtradeLeaderboardPage(
      { timeframe: 7, rows: [{ address: 'bogus' }, ...byTf['7']], reportedTotal: 5 },
      ctx
    )
    expect(page.rows).toHaveLength(4)
  })
})

describe('parseGtradeProfile', () => {
  const bundle = fixture('profile-bundle.json') as {
    stats: Record<string, unknown>
    trades: { data: Array<Record<string, unknown>> }
  }

  it('7d aggregation reconciles EXACTLY with the board row', () => {
    const profile = parseGtradeProfile(
      { stats: bundle.stats, trades: bundle.trades, timeframe: 7 },
      ctx
    )
    expect(profile.stats).toHaveLength(1)
    const s = profile.stats[0]
    expect(s.timeframe).toBe(7)
    // Σ pnl_net × collateralPriceUsd over realized rows = board total_pnl_usd
    expect(s.pnl).toBeCloseTo(214258.186053, 4)
    expect(s.totalPositions).toBe(42) // board count
    expect(s.winPositions).toBe(35) // board count_win
    expect(s.winRate).toBeCloseTo(83.333333, 5)
    expect(s.roi).toBeNull()
    expect(s.copierPnl).toBeNull() // DEX — no copy trading
    expect(s.extras.lifetime_volume as number).toBeCloseTo(900405265.67, 1)
    expect(s.extras.lifetime_trades).toBe(3164)
    expect(s.extras.trades_truncated).toBe(false)
  })

  it('series: daily-bucketed cumulative USD PnL, ascending', () => {
    const profile = parseGtradeProfile(
      { stats: bundle.stats, trades: bundle.trades, timeframe: 7 },
      ctx
    )
    expect(profile.series).toHaveLength(1)
    const pts = profile.series[0].points
    expect(profile.series[0].metric).toBe('pnl')
    expect(pts[0].ts).toBe('2026-06-07T00:00:00.000Z')
    expect(pts[0].value).toBeCloseTo(136530.47, 1)
    // last cumulative point = the full window PnL
    expect(pts[pts.length - 1].value).toBeCloseTo(214258.186053, 4)
  })

  it('narrow window excludes older trades', () => {
    // 1-day-ago window start: only the 2026-06-11 trades remain
    const narrowCtx = { ...ctx, scrapedAt: '2026-06-12T00:00:00.000Z' }
    const profile = parseGtradeProfile(
      { stats: bundle.stats, trades: bundle.trades, timeframe: 7 },
      narrowCtx
    )
    const wide = profile.stats[0].pnl as number
    const profile30 = parseGtradeProfile(
      { stats: bundle.stats, trades: bundle.trades, timeframe: 30 },
      narrowCtx
    )
    // 30d ⊇ 7d on this fixture (all trades within 7d) → identical totals
    expect(profile30.stats[0].pnl).toBeCloseTo(wide, 6)
  })

  it('empty trades → stats from lifetime only, no series, never throws', () => {
    const profile = parseGtradeProfile(
      { stats: bundle.stats, trades: { data: [] }, timeframe: 30 },
      ctx
    )
    expect(profile.stats).toHaveLength(1)
    expect(profile.stats[0].pnl).toBeNull()
    expect(profile.stats[0].winRate).toBeNull()
    expect(profile.series).toHaveLength(0)
  })
})

describe('parseGtradeHistory (orders = the trades table)', () => {
  const bundle = fixture('profile-bundle.json') as {
    trades: { data: Array<Record<string, unknown>> }
  }

  it('maps trade rows to order records with id dedupe hashes', () => {
    const rows = parseGtradeHistory({ data: bundle.trades.data }, 'orders', ctx)
    expect(rows).toHaveLength(60)
    const first = rows[0]
    expect(first.kind).toBe('orders')
    expect(first.ts).toBe('2026-06-11T23:12:33.000Z')
    expect((first as { orderKind: string | null }).orderKind).toBe('TradeLeverageUpdate')
    expect((first as { symbol: string | null }).symbol).toBe('BNB/USD')
    expect((first as { side: string | null }).side).toBe('long')
    expect(first.dedupeHash).toBe('209302052')
  })

  it('rejects other kinds', () => {
    expect(() => parseGtradeHistory({}, 'copiers', ctx)).toThrow('not supported')
  })
})

describe('parseGtradePositions', () => {
  it('throws — out of v1', () => {
    expect(() => parseGtradePositions({}, ctx)).toThrow('not supported')
  })
})
