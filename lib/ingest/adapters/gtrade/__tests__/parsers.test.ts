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
  unmatchedGtradeCloseKeys,
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

const AS_OF = Date.parse(ctx.scrapedAt)
const DAY_MS = 86_400_000

function profileRaw(
  stats: unknown,
  trades: Array<Record<string, unknown>>,
  timeframe: number,
  options: { asOfTimeMs?: number; exhausted?: boolean } = {}
) {
  const asOfTimeMs = options.asOfTimeMs ?? AS_OF
  const exhausted = options.exhausted ?? true
  const lastId = trades.at(-1)?.id
  return {
    stats,
    timeframe,
    tradesFetchState: 'fetched',
    tradesFetchReason: exhausted ? 'exhausted' : 'page_cap',
    tradesSnapshot: {
      schemaVersion: 2,
      rawPages: [
        {
          pageIndex: 1,
          requestCursor: null,
          requestEndTimeMs: asOfTimeMs,
          url: 'https://gtrade.test/history',
          response: {
            data: trades,
            pagination: {
              hasMore: !exhausted,
              nextCursor: exhausted ? null : lastId,
              limit: 1_000,
            },
          },
        },
      ],
      // Deliberately minimal: the parser must replay rawPages, not trust meta.
      meta: { asOfTimeMs },
      trades: [],
    },
  }
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
    const profile = parseGtradeProfile(profileRaw(bundle.stats, bundle.trades.data, 7), ctx)
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
    expect(s.extras.profile_window_metrics_complete).toBe(true)
  })

  it('series: daily-bucketed cumulative USD PnL, ascending', () => {
    const profile = parseGtradeProfile(profileRaw(bundle.stats, bundle.trades.data, 7), ctx)
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
    const profile = parseGtradeProfile(profileRaw(bundle.stats, bundle.trades.data, 7), narrowCtx)
    const wide = profile.stats[0].pnl as number
    const profile30 = parseGtradeProfile(
      profileRaw(bundle.stats, bundle.trades.data, 30),
      narrowCtx
    )
    // 30d ⊇ 7d on this fixture (all trades within 7d) → identical totals
    expect(profile30.stats[0].pnl).toBeCloseTo(wide, 6)
  })

  it('confirmed empty history writes explicit zero window metrics and no series', () => {
    const profile = parseGtradeProfile(profileRaw(bundle.stats, [], 30), ctx)
    expect(profile.stats).toHaveLength(1)
    expect(profile.stats[0].pnl).toBe(0)
    expect(profile.stats[0].winRate).toBeNull()
    expect(profile.stats[0].winPositions).toBe(0)
    expect(profile.stats[0].totalPositions).toBe(0)
    expect(profile.stats[0].extras.profile_window_metrics_complete).toBe(true)
    expect(profile.series).toHaveLength(0)
  })

  it('rejects legacy flattened trades even when they claim not to be truncated', () => {
    const profile = parseGtradeProfile(
      { stats: bundle.stats, trades: { data: bundle.trades.data, truncated: false }, timeframe: 7 },
      ctx
    )
    expect(profile.stats[0]).toMatchObject({ pnl: null, sharpe: null })
    expect(profile.stats[0].extras).toMatchObject({
      profile_window_metrics_complete: false,
      gtrade_trades_incomplete_reason: 'legacy_unverified',
    })
    expect(profile.series).toEqual([])
  })

  it('publishes an independently covered 7d prefix but rejects wider windows', () => {
    const rows = [
      { id: 500, date: new Date(AS_OF - DAY_MS).toISOString(), pnl_net: 10, collateralPriceUsd: 2 },
      {
        id: 499,
        date: new Date(AS_OF - 5 * DAY_MS).toISOString(),
        pnl_net: -4,
        collateralPriceUsd: 1,
      },
      { id: 498, date: new Date(AS_OF - 8 * DAY_MS).toISOString(), pnl_net: 0 },
    ]
    const seven = parseGtradeProfile(profileRaw(null, rows, 7, { exhausted: false }), ctx)
    expect(seven.stats[0]).toMatchObject({
      pnl: 16,
      winPositions: 1,
      totalPositions: 2,
      winRate: 50,
    })
    expect(seven.stats[0].extras.profile_window_metrics_complete).toBe(true)

    const thirty = parseGtradeProfile(profileRaw(null, rows, 30, { exhausted: false }), ctx)
    expect(thirty.stats[0]).toMatchObject({ pnl: null, winPositions: null, totalPositions: null })
    expect(thirty.stats[0].extras).toMatchObject({
      profile_window_metrics_complete: false,
      gtrade_trades_incomplete_reason: 'window_prefix_not_covered',
    })
    expect(thirty.series).toEqual([])
  })

  it('fails only windows containing a realized row without a USD collateral price', () => {
    const rows = [
      { id: 500, date: new Date(AS_OF - DAY_MS).toISOString(), pnl_net: 10, collateralPriceUsd: 2 },
      { id: 499, date: new Date(AS_OF - 10 * DAY_MS).toISOString(), pnl_net: -4 },
      { id: 498, date: new Date(AS_OF - 31 * DAY_MS).toISOString(), pnl_net: 0 },
    ]
    const seven = parseGtradeProfile(profileRaw(null, rows, 7, { exhausted: false }), ctx)
    expect(seven.stats[0].pnl).toBe(20)
    expect(seven.stats[0].extras.profile_window_metrics_complete).toBe(true)

    const thirty = parseGtradeProfile(profileRaw(null, rows, 30, { exhausted: false }), ctx)
    expect(thirty.stats[0].pnl).toBeNull()
    expect(thirty.stats[0].extras).toMatchObject({
      profile_window_metrics_complete: false,
      gtrade_trades_incomplete_reason: 'missing_collateral_price_usd',
    })
  })

  it('does not treat an open prefix ending exactly on the window boundary as complete', () => {
    const rows = [
      { id: 500, date: new Date(AS_OF - DAY_MS).toISOString(), pnl_net: 0 },
      { id: 499, date: new Date(AS_OF - 7 * DAY_MS).toISOString(), pnl_net: 0 },
    ]
    const profile = parseGtradeProfile(profileRaw(null, rows, 7, { exhausted: false }), ctx)
    expect(profile.stats[0].extras).toMatchObject({
      profile_window_metrics_complete: false,
      gtrade_trades_incomplete_reason: 'window_prefix_not_covered',
    })
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

  it('position_history: rebuilds closed positions from open→close pairs (M3-3b)', () => {
    const rows = parseGtradeHistory({ data: bundle.trades.data }, 'position_history', ctx)
    // The 60-row fixture window contains exactly ONE complete open+close pair
    // (BTC/USD tradeIndex 739); closes whose opens fell outside the window are
    // skipped — entry data is never guessed.
    expect(rows).toHaveLength(1)
    const p = rows[0]
    if (p.kind !== 'position_history') throw new Error('wrong kind')
    expect(p.symbol).toBe('BTC/USD')
    expect(p.openedAt).toMatch(/^2026-06-/)
    expect(p.closedAt).toMatch(/^2026-06-11T16:34:44/)
    expect(typeof p.entryPrice).toBe('number')
    expect(p.exitPrice).toBeCloseTo(62638.9056, 3)
    expect(typeof p.realizedPnl).toBe('number')
    expect(p.side === 'long' || p.side === 'short').toBe(true)
    expect(p.dedupeHash).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('parseGtradePositions', () => {
  it('throws — out of v1', () => {
    expect(() => parseGtradePositions({}, ctx)).toThrow('not supported')
  })
})

describe('gTrade position-history completeness', () => {
  const open = {
    id: 10,
    date: '2026-06-01T00:00:00.000Z',
    action: 'TradeOpenedMarket',
    pair: 'ETH/USD',
    tradeIndex: 7,
    pnl_net: 0,
    price: 2_000,
  }
  const close = {
    id: 11,
    date: '2026-06-02T00:00:00.000Z',
    action: 'TradeClosedMarket',
    pair: 'ETH/USD',
    tradeIndex: 7,
    pnl_net: 5,
    collateralPriceUsd: 1,
    price: 2_100,
  }

  it('detects a close whose open fell outside the fetched page prefix', () => {
    expect(unmatchedGtradeCloseKeys([close], null)).toEqual(['ETH/USD#7'])
    expect(unmatchedGtradeCloseKeys([close, open], null)).toEqual([])
  })

  it('ignores old closes at or before the incremental cursor', () => {
    expect(unmatchedGtradeCloseKeys([close], close.date)).toEqual([])
  })

  it('accepts liquidation closes as terminal position events', () => {
    const rows = parseGtradeHistory(
      { data: [{ ...close, action: 'TradeClosedLIQ' }, open] },
      'position_history',
      ctx
    )
    expect(rows).toHaveLength(1)
  })

  it('fails closed when realized collateral cannot be converted to USD', () => {
    const { collateralPriceUsd: _removed, ...missingPrice } = close
    expect(() =>
      parseGtradeHistory({ data: [missingPrice, open] }, 'position_history', ctx)
    ).toThrow('missing collateralPriceUsd')
  })
})

describe('parseGtradeProfile — Tier-0 base-free risk', () => {
  // 10 realizing trades across 10 distinct days → 9 daily deltas (>=7), so the
  // base-free Sharpe/Sortino path activates. gTrade exposes no capital base, so
  // MDD stays NULL by design.
  it('derives daily-approx Sharpe/Sortino but never MDD (no capital base)', () => {
    const deltas = [120, -40, 90, -30, 70, -20, 110, -50, 60, -25]
    const trades = deltas.map((d, i) => ({
      id: i + 1,
      date: `2026-06-${String(i + 2).padStart(2, '0')}T12:00:00.000Z`,
      pair: 'ETH/USD',
      action: 'TradeClose',
      collateralPriceUsd: 1,
      pnl: d,
      pnl_net: d,
    }))
    const s = parseGtradeProfile(profileRaw(null, [...trades].reverse(), 30), ctx).stats[0]
    expect(typeof s.sharpe).toBe('number')
    expect(s.mdd).toBeNull() // base-dependent → honest NULL for gTrade
    expect(typeof s.extras.sortino).toBe('number')
    expect(s.extras.risk_derivation).toBe('daily-approx')
    expect(s.extras.risk_samples).toBe(9) // N-1 deltas from 10 daily points
  })
})
