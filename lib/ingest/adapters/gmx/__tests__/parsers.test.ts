/**
 * GMX parser tests over real RAW fixtures (captured live 2026-06-12 from
 * gmx.squids.live/gmx-synthetics-arbitrum + arbitrum-api.gmxinfra.io).
 * period-account-stats.json holds 6 real 7d-window rows (incl. a zero-loss
 * trader, a no-closes whale and a losing account); profile-bundle.json is
 * the same trader's periodAccountStats + accountPnlHistoryStats pair;
 * positions-bundle.json is a live SILVER long with its market/token maps.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  gmxRealizedPnlUsd,
  parseGmxHistory,
  parseGmxLeaderboardPage,
  parseGmxPositions,
  parseGmxProfile,
} from '../parsers'
import { gmxWindowFrom } from '../index'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'gmx',
  currency: 'USDC',
  tfLabelMap: {},
  scrapedAt: '2026-06-12T00:00:00.000Z',
  meta: {},
}

describe('gmxRealizedPnlUsd', () => {
  it('matches the verified identity (pnl − fees + impact − startUnrealized)', () => {
    const rows = fixture('period-account-stats.json').rows as Array<Record<string, unknown>>
    // cross-checked live against accountPnlSummaryStats.realizedPnlUsd
    expect(gmxRealizedPnlUsd(rows[0])).toBeCloseTo(124.189338, 5)
    expect(gmxRealizedPnlUsd(rows[2])).toBeCloseTo(-142.587463, 5)
  })
})

describe('parseGmxLeaderboardPage', () => {
  const fx = fixture('period-account-stats.json')
  const payload = { timeframe: 7, from: fx.from, reportedTotal: 2866, rows: fx.rows }

  it('parses real rows: wallet identity, realized-basis PnL, maxCapital ROI', () => {
    const page = parseGmxLeaderboardPage(payload, ctx)
    expect(page.reportedTotal).toBe(2866)
    expect(page.rows).toHaveLength(6)
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: '0xf7cf8c69f370ce6e05bdf23c12c5b45d91f57b02',
      walletAddress: '0xf7cf8c69f370ce6e05bdf23c12c5b45d91f57b02',
      rank: 1,
      nickname: null,
      avatarUrlOrigin: null,
      traderKind: 'human',
      botStrategy: null,
      headlineWinRate: 100,
    })
    expect(page.rows[0].headlineRoi).toBeCloseTo(24.84557, 4)
    expect(page.rows[0].headlinePnl).toBeCloseTo(124.189338, 5)
    // open-only account: zero closes → null win rate, PnL still computed
    expect(page.rows[1].headlineWinRate).toBeNull()
    expect(page.rows[1].headlineRoi).toBeCloseTo(20.471309, 5)
    // losing account keeps its negative numbers
    expect(page.rows[2].headlinePnl).toBeCloseTo(-142.587463, 5)
    expect(page.rows[2].headlineWinRate).toBeCloseTo(63.157895, 5)
    // raw kept verbatim — 1e30 strings, never thrown away (spec §3)
    expect((page.rows[0].raw as Record<string, unknown>).maxCapital).toBe(
      '499845000000000000000000000000000'
    )
  })

  it('skips rows without a 0x identity', () => {
    const page = parseGmxLeaderboardPage(
      { timeframe: 7, reportedTotal: 2, rows: [{ id: 'bogus' }, ...(fx.rows as unknown[])] },
      ctx
    )
    expect(page.rows).toHaveLength(6)
    expect(page.rows[0].rank).toBe(1)
  })
})

describe('parseGmxProfile', () => {
  const bundle = fixture('profile-bundle.json')

  it('stats: total-basis PnL from cumulative history, ROI on maxCapital', () => {
    const profile = parseGmxProfile(bundle, ctx)
    expect(profile.stats).toHaveLength(1)
    const s = profile.stats[0]
    expect(s.timeframe).toBe(7)
    // last cumulativePnl point = window PnL incl. unrealized (verified
    // identical to accountPnlSummaryStats.pnlUsd live)
    expect(s.pnl).toBeCloseTo(227.628956, 5)
    expect(s.roi).toBeCloseTo(45.539908, 5)
    expect(s.winRate).toBe(100)
    expect(s.winPositions).toBe(1)
    expect(s.totalPositions).toBe(1)
    expect(s.volume).toBeCloseTo(7990.7198, 3)
    expect(s.aum).toBeCloseTo(499.845, 3)
    expect(s.extras.pnl_basis).toBe('total_incl_unrealized')
    expect(s.extras.realized_pnl_usd as number).toBeCloseTo(124.189338, 5)
    // Tier-0 daily-approx risk derived from the cumulative-PnL series over the
    // maxCapital base (was NULL — GMX exposes no MDD/Sharpe). 8 daily samples.
    expect(s.mdd).toBeCloseTo(-1.12, 2)
    expect(s.sharpe).toBe(10) // mostly-up curve → capped
    expect(s.extras.sortino).toBe(10)
    expect(s.extras.risk_derivation).toBe('daily-approx')
    expect(s.extras.risk_samples).toBe(8)
    expect(s.copierPnl).toBeNull()
  })

  it('series: window-cumulative pnl points, sorted ascending ISO', () => {
    const profile = parseGmxProfile(bundle, ctx)
    expect(profile.series).toHaveLength(1)
    const series = profile.series[0]
    expect(series.metric).toBe('pnl')
    expect(series.timeframe).toBe(7)
    expect(series.points).toHaveLength(8)
    expect(series.points[0].ts).toBe(new Date(1780617600 * 1000).toISOString())
    expect(series.points[7].value).toBeCloseTo(227.628956, 5)
  })

  it('empty payload → no stats, no series (never throws)', () => {
    const profile = parseGmxProfile({ periodStats: [], pnlHistory: [], timeframe: 30 }, ctx)
    expect(profile.stats).toHaveLength(0)
    expect(profile.series).toHaveLength(0)
  })
})

describe('parseGmxPositions', () => {
  it('resolves symbol/decimals via embedded maps; scales 1e30/1e4 fields', () => {
    const positions = parseGmxPositions(fixture('positions-bundle.json'), ctx)
    expect(positions).toHaveLength(1)
    const p = positions[0]
    expect(p.symbol).toBe('SILVER')
    expect(p.side).toBe('long')
    expect(p.size).toBeCloseTo(46.104398, 5) // sizeInTokens / 10^18
    expect(p.entryPrice).toBeCloseTo(65.0075, 4) // raw / 10^(30−18)
    expect(p.leverage).toBeCloseTo(4.9729, 4) // raw / 1e4
    expect(p.unrealizedPnl).toBeCloseTo(104.426461, 5)
    expect(p.markPrice).toBeNull() // no live mark in the subgraph
  })

  it('skips snapshot rows and zero-size rows', () => {
    const fx = fixture('positions-bundle.json') as {
      positions: Array<Record<string, unknown>>
      markets: unknown
      tokens: unknown
    }
    const doctored = {
      ...fx,
      positions: [
        { ...fx.positions[0], isSnapshot: true },
        { ...fx.positions[0], sizeInUsd: '0' },
      ],
    }
    expect(parseGmxPositions(doctored, ctx)).toHaveLength(0)
  })
})

describe('gmxWindowFrom', () => {
  const now = Date.parse('2026-06-12T15:30:00Z')
  it('midnight-aligned; 90d uses an 89-day window (resolver requires <90d)', () => {
    const midnight = Date.parse('2026-06-12T00:00:00Z') / 1000
    expect(gmxWindowFrom(7, now)).toBe(midnight - 7 * 86_400)
    expect(gmxWindowFrom(30, now)).toBe(midnight - 30 * 86_400)
    expect(gmxWindowFrom(90, now)).toBe(midnight - 89 * 86_400)
    // strictly <90 days even at 23:59
    const lateNow = Date.parse('2026-06-12T23:59:59Z')
    expect((lateNow / 1000 - gmxWindowFrom(90, lateNow)) / 86_400).toBeLessThan(90)
  })
})

describe('parseGmxHistory', () => {
  it('throws — no history surfaces in v1', () => {
    expect(() => parseGmxHistory({}, 'orders', ctx)).toThrow('not supported')
  })
})
