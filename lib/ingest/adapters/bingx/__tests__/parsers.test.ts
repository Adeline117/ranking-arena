import { readFileSync } from 'fs'
import { join } from 'path'
import { bingxPerTfExtras, parseBingxLeaderboardPage } from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'bingx_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-11T00:00:00.000Z',
  meta: {},
}

/** The adapter stores RAW as {search, timeframe}; tests mirror that envelope. */
const wrapped = (tf: number): unknown => ({ search: fixture('search.json'), timeframe: tf })

describe('parseBingxLeaderboardPage', () => {
  it('parses trader/search rows for the 30d timeframe', () => {
    const page = parseBingxLeaderboardPage(wrapped(30), ctx)
    expect(page.reportedTotal).toBe(2008)
    expect(page.rows.length).toBe(3)
    const first = page.rows[0]
    expect(first.exchangeTraderId).toBe('1998800000134045')
    expect(first.rank).toBe(1)
    expect(first.nickname).toBeTruthy()
    expect(first.traderKind).toBe('human')
    // strRecent30DaysRate "+1,052.28%" → 1052.28
    expect(first.headlineRoi).toBeCloseTo(1052.28, 2)
    // cumulativeProfitLoss30d
    expect(first.headlinePnl).toBeCloseTo(126.27, 2)
    // winRate30d 1 → 100%
    expect(first.headlineWinRate).toBeCloseTo(100, 5)
    // Board-backfill: per-TF mdd/sharpe + TF-independent AUM/copiers → trader_stats
    expect(typeof first.headlineMdd).toBe('number')
    expect(typeof first.headlineSharpe).toBe('number')
    expect(typeof first.headlineAum).toBe('number')
    expect(typeof first.headlineCopierCount).toBe('number')
    // Rich rankStat extras → trader_stats.extras (registry/meta-strip surfaced)
    expect(first.headlineExtras && typeof first.headlineExtras).toBe('object')
    expect(Object.keys(first.headlineExtras ?? {}).length).toBeGreaterThan(0)
    // apiIdentity routing fact on traderMeta (TF-independent)
    expect(first.traderMeta).toMatchObject({ bingx_api_identity: '1579905006518878200' })
    // per-TF risk rating: NOT on traderMeta (TF-independent), but IS wired into
    // per-TF headlineExtras (spec §11.12 — was previously dropped, only in raw)
    expect(first.traderMeta?.risk_rating).toBeUndefined()
    expect((first.headlineExtras as { risk_rating?: number })?.risk_rating).toBe(7)
    expect((first.raw as { rankStat: { riskLevel30Days: string } }).rankStat.riskLevel30Days).toBe(
      '7'
    )
    // Phase A: lifetime_trades from totalTransactions; pnl_ratio omitted when
    // pnlRateU is "+∞" (no-loss trader) — NULL-collapse, never a bad value.
    const fe = first.headlineExtras as Record<string, number | undefined>
    expect(fe.lifetime_trades).toBe(8)
    expect(fe.pnl_ratio).toBeUndefined() // row0 pnlRateU = "+∞"
    // 逐图核对 image62: profile-block fields promoted from board rankStat.
    expect(fe.principal).toBeCloseTo(138.27, 2) // equity
    expect(fe.avg_hold_time_hours).toBeCloseTo(9.06, 1) // avgHoldTime 32614s / 3600
    expect(fe.copier_count_history).toBe(14) // strAccFollowerNum (cumulative)
    expect(fe.trader_tenure_days).toBe(9) // daysSinceBecameTrader
    expect(fe.loss_trades).toBe(1) // lossCount
    expect(fe.max_copier_slots).toBe(2000) // maxFollowerNum
    expect(fe.copier_growth_30d).toBe(2) // recent30DayFollowerNumChange
    expect(fe.total_earnings).toBeCloseTo(108.33, 2) // totalEarnings "+108.33"
    // row1 has a finite pnlRateU → pnl_ratio surfaces
    expect((page.rows[1].headlineExtras as { pnl_ratio?: number }).pnl_ratio).toBeCloseTo(0.8997, 3)
  })

  it('selects the correct TF fields for 7d vs 90d', () => {
    const p7 = parseBingxLeaderboardPage(wrapped(7), ctx)
    const p90 = parseBingxLeaderboardPage(wrapped(90), ctx)
    // strRecent7DaysRate "+31.08%" vs strRecent90DaysRate "+1,052.28%"
    expect(p7.rows[0].headlineRoi).toBeCloseTo(31.08, 2)
    expect(p90.rows[0].headlineRoi).toBeCloseTo(1052.28, 2)
  })

  it('returns empty on malformed payloads', () => {
    expect(parseBingxLeaderboardPage({}, ctx).rows).toHaveLength(0)
    expect(
      parseBingxLeaderboardPage({ search: { data: { result: 'x' } }, timeframe: 30 }, ctx).rows
    ).toHaveLength(0)
  })

  it('recovers EXACT 19-digit uid + apiIdentity from uidAndApi (not the float-truncated numbers)', () => {
    // Real snowflake IDs > 2^53: the bare JSON numbers arrive already truncated
    // (…299 → …300). uidAndApi carries the exact string form.
    const search = {
      data: {
        total: 1,
        result: [
          {
            trader: {
              uid: 1316650541126967300, // truncated (real ends …299)
              uidAndApi: '1316650541126967299_1413302534032539651',
              nickName: 'Precise',
            },
            rankStat: { apiIdentity: 1413302534032539600, strRecent30DaysRate: '+1%' }, // truncated
          },
        ],
      },
    }
    const page = parseBingxLeaderboardPage({ search, timeframe: 30 }, ctx)
    expect(page.rows[0].exchangeTraderId).toBe('1316650541126967299') // exact, not …300
    expect(page.rows[0].traderMeta).toMatchObject({
      bingx_api_identity: '1413302534032539651', // exact, not …600
    })
  })

  it('falls back to uidStr / apiIdentity when uidAndApi is absent', () => {
    const search = {
      data: {
        result: [
          { trader: { uid: 123, uidStr: '123', nickName: 'X' }, rankStat: { apiIdentity: 999 } },
        ],
      },
    }
    const page = parseBingxLeaderboardPage({ search, timeframe: 30 }, ctx)
    expect(page.rows[0].exchangeTraderId).toBe('123')
    expect(page.rows[0].traderMeta).toMatchObject({ bingx_api_identity: '999' })
  })
})

describe('bingxPerTfExtras', () => {
  it('extracts per-TF sharpe/mdd/risk', () => {
    const row = (
      fixture('search.json') as { data: { result: Array<{ rankStat: Record<string, unknown> }> } }
    ).data.result[0].rankStat
    const e30 = bingxPerTfExtras(row, 30)
    expect(e30.sharpe).toBeCloseTo(-0.94, 2)
    expect(e30.mdd).toBeCloseTo(52.63, 1)
    expect(e30.risk_rating).toBe(7)
  })
})
