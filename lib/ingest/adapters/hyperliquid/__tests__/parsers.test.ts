/**
 * Hyperliquid parser tests over real RAW fixtures (captured live 2026-06-11
 * from stats-data.hyperliquid.xyz + api.hyperliquid.xyz/info — see
 * docs/hyperliquid-spike.md). leaderboard-page.json holds 4 real rows of the
 * 38,582-row file: the #1 unsorted row, a displayName whale, a zero-7d-PnL
 * row and the worst-7d-PnL row. profile-bundle.json is a full portfolio +
 * clearinghouseState pair for a mid-board account (7 open positions).
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  lerpAt,
  parseHyperliquidHistory,
  parseHyperliquidLeaderboardPage,
  parseHyperliquidPositions,
  parseHyperliquidProfile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

// scrapedAt pinned to the fixture portfolio's last history point so the
// 90d lerp assertions are exact.
const ctx: ParseCtx = {
  sourceSlug: 'hyperliquid',
  currency: 'USDC',
  tfLabelMap: {},
  scrapedAt: new Date(1781214420993).toISOString(),
  meta: {},
}

describe('parseHyperliquidLeaderboardPage', () => {
  const payload = fixture('leaderboard-page.json') as { rows: Array<Record<string, unknown>> }

  it('parses real rows: wallet identity, fraction→percent ROI, week→7 mapping', () => {
    const page = parseHyperliquidLeaderboardPage(payload, ctx)
    expect(page.reportedTotal).toBe(38582)
    expect(page.rows).toHaveLength(4)
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: '0x85ecf584f25db6f146718b86d493e33c5af72052',
      walletAddress: '0x85ecf584f25db6f146718b86d493e33c5af72052',
      rank: 1,
      nickname: null, // displayName null → long tail renders the address
      avatarUrlOrigin: null,
      traderKind: 'human',
      botStrategy: null,
      headlineWinRate: null,
    })
    // week roi -0.0213260146 (decimal fraction) → -2.13260146 percent
    expect(page.rows[0].headlineRoi).toBeCloseTo(-2.13260146, 6)
    expect(page.rows[0].headlinePnl).toBeCloseTo(-1600655.247453, 4)
    expect(page.rows[0].headlineAum).toBeCloseTo(58880227.366394, 2) // accountValue = on-chain equity
    // named whale keeps its displayName
    expect(page.rows[1].nickname).toBe('ABC')
    expect(page.rows[1].headlineRoi).toBeCloseTo(0.17678109, 6)
    // raw kept verbatim — all 4 windows + accountValue (equity, NOT PnL)
    const raw = page.rows[0].raw as Record<string, unknown>
    expect(raw.accountValue).toBe('58880227.3663940057')
    expect(Array.isArray(raw.windowPerformances)).toBe(true)
    expect(page.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4])
  })

  it('maps month→30 for the 30d board from the SAME payload rows', () => {
    const page = parseHyperliquidLeaderboardPage({ ...payload, timeframe: 30 }, ctx)
    // row 0 month: pnl 3084449.68, roi 0.0341792539
    expect(page.rows[0].headlineRoi).toBeCloseTo(3.41792539, 6)
    expect(page.rows[0].headlinePnl).toBeCloseTo(3084449.68312, 4)
  })

  it('drops rows without a 0x identity instead of publishing them', () => {
    const page = parseHyperliquidLeaderboardPage(
      { timeframe: 7, reportedTotal: 2, rows: [{ displayName: 'ghost' }, payload.rows[0]] },
      ctx
    )
    expect(page.rows).toHaveLength(1)
    expect(page.rows[0].rank).toBe(1)
  })
})

describe('parseHyperliquidProfile', () => {
  const bundle = fixture('profile-bundle.json') as Record<string, unknown>

  it('30d: native month window — cumulative PnL end value + start-equity ROI', () => {
    const profile = parseHyperliquidProfile({ ...bundle, timeframe: 30 }, ctx)
    expect(profile.stats).toHaveLength(1)
    const st = profile.stats[0]
    expect(st.timeframe).toBe(30)
    expect(st.pnl).toBeCloseTo(1367215.469297, 4)
    expect(st.roi).toBeCloseTo(69.5115438, 4) // 1367215.47 / 1966889.81 × 100
    expect(st.aum).toBeCloseTo(927231.356076, 4)
    expect(st.volume).toBeCloseTo(222920609.98, 1)
    expect(st.winRate).toBeNull()
    // Tier-0 risk from the real accountValueHistory equity curve (47 samples).
    expect(st.mdd).toBeCloseTo(-45.78, 1)
    expect(st.sharpe).toBeCloseTo(3.1, 1)
    expect(st.extras.sortino).toBeCloseTo(6.04, 1)
    expect(st.extras.risk_derivation).toBe('daily-approx')
    expect(st.extras.risk_samples).toBe(47)
    expect(st.copierCount).toBeNull() // DEX — no copy trading
    const pnlSeries = profile.series.find((s) => s.metric === 'pnl')
    expect(pnlSeries?.timeframe).toBe(30)
    expect(pnlSeries?.points).toHaveLength(47)
    expect(profile.series.find((s) => s.metric === 'account_value')?.points).toHaveLength(47)
  })

  it('90d: derived via allTime lerp — disclosed in extras, series rebased', () => {
    const profile = parseHyperliquidProfile({ ...bundle, timeframe: 90 }, ctx)
    const st = profile.stats[0]
    expect(st.timeframe).toBe(90)
    // precomputed against the fixture: pnl_now 902168.85 − lerp(t−90d) −245246.04
    expect(st.pnl).toBeCloseTo(1147414.886682, 3)
    expect(st.roi).toBeCloseTo(85.1734484, 4) // ÷ equity lerp 1347150.91 × 100
    expect(st.volume).toBeNull() // only allTime vlm exists — no honest 90d vlm
    expect(st.extras).toMatchObject({ derivation: 'portfolio_alltime_lerp' })
    const pnlSeries = profile.series.find((s) => s.metric === 'pnl')
    expect(pnlSeries?.points).toHaveLength(21) // allTime points inside 90d
    // rebased: last point equals the 90d window PnL
    expect(pnlSeries?.points[pnlSeries.points.length - 1].value).toBeCloseTo(1147414.886682, 3)
  })

  it('timeframe 0 (inception) falls back to the 90d derivation', () => {
    const profile = parseHyperliquidProfile({ ...bundle, timeframe: 0 }, ctx)
    expect(profile.stats[0].timeframe).toBe(90)
  })

  it('missing portfolio window yields no stats rather than fake zeros', () => {
    const profile = parseHyperliquidProfile(
      { portfolio: [], clearinghouse: null, timeframe: 30 },
      ctx
    )
    expect(profile.stats).toHaveLength(0)
    expect(profile.series).toHaveLength(0)
  })
})

describe('parseHyperliquidPositions', () => {
  it('maps clearinghouseState.assetPositions with recovered mark price', () => {
    const bundle = fixture('profile-bundle.json') as { clearinghouse: unknown }
    const positions = parseHyperliquidPositions(bundle.clearinghouse, ctx)
    expect(positions).toHaveLength(7)
    const btc = positions.find((p) => p.symbol === 'BTC')
    expect(btc).toMatchObject({ side: 'short', leverage: 30 })
    expect(btc?.size).toBeCloseTo(45.028, 3)
    expect(btc?.entryPrice).toBeCloseTo(62378.8, 1)
    // positionValue = |szi| × mark → markPrice = 2860178.56 / 45.028
    expect(btc?.markPrice).toBeCloseTo(63520.0, 1)
    expect(btc?.unrealizedPnl).toBeCloseTo(-51385.715677, 4)
  })
})

describe('lerpAt', () => {
  const pts = [
    { ts: 0, value: 0 },
    { ts: 100, value: 100 },
  ]
  it('interpolates, clamps to ends, handles empty', () => {
    expect(lerpAt(pts, 50)).toBe(50)
    expect(lerpAt(pts, -10)).toBe(0)
    expect(lerpAt(pts, 999)).toBe(100)
    expect(lerpAt([], 50)).toBeNull()
  })
})

describe('parseHyperliquidHistory', () => {
  it('throws — no history surfaces in v1', () => {
    expect(() => parseHyperliquidHistory({}, 'orders', ctx)).toThrow(/not supported/)
  })
})
