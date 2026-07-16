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
import { GMX_SUBGRAPH_URL, gmxWindowBounds, gmxWindowFrom, sortGmxLeaderboardRows } from '../index'
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
const DAY_SECONDS = 86_400

describe('gmxRealizedPnlUsd', () => {
  it('nets every realized fee and impact without mixing in window-start unrealized PnL', () => {
    const rows = fixture('period-account-stats.json').rows as Array<Record<string, unknown>>
    expect(gmxRealizedPnlUsd(rows[0])).toBeCloseTo(124.189338, 5)
    // No closes and zero realizedPnl: fees stay a loss even though the old
    // formula's start-unrealized adjustment incorrectly made this positive.
    expect(gmxRealizedPnlUsd(rows[1])).toBeCloseTo(-24.493454, 5)
    // Includes non-zero realizedSwapFees + realizedSwapImpact.
    expect(gmxRealizedPnlUsd(rows[4])).toBeCloseTo(204.553564, 5)
  })

  it('fails closed when any realized-net component is absent', () => {
    const complete = {
      realizedPnl: '10',
      realizedFees: '1',
      realizedSwapFees: '2',
      realizedPriceImpact: '3',
      realizedSwapImpact: '4',
    }
    for (const key of Object.keys(complete)) {
      const incomplete = { ...complete } as Record<string, unknown>
      delete incomplete[key]
      expect(gmxRealizedPnlUsd(incomplete)).toBeNull()
    }
  })
})

describe('parseGmxLeaderboardPage', () => {
  const fx = fixture('period-account-stats.json')
  const from = Number(fx.from)
  const payload = {
    timeframe: 7,
    from,
    to: from + 7 * DAY_SECONDS,
    reportedTotal: 2866,
    rows: fx.rows,
  }

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
    expect(page.rows[0].headlineExtras).toMatchObject({
      pnl_basis: 'gmx_period_realized_net',
      roi_basis: 'max_capital_usd',
      pnl_includes_unrealized: false,
      pnl_components_complete: true,
      profile_series_contract: 'unavailable_same_basis',
      window_from: from,
      window_to: from + 7 * DAY_SECONDS,
      window_duration_days: 7,
      window_semantics: 'completed_utc_days',
    })
    // open-only account: zero closes → null win rate; realized fees remain loss
    expect(page.rows[1].headlineWinRate).toBeNull()
    expect(page.rows[1].headlineRoi).toBeCloseTo(-3.737128, 5)
    // losing account keeps its negative numbers
    expect(page.rows[3].headlinePnl).toBeCloseTo(-248.8365, 5)
    expect(page.rows[3].headlineWinRate).toBeCloseTo(45.454545, 5)
    // raw kept verbatim — 1e30 strings, never thrown away (spec §3)
    expect((page.rows[0].raw as Record<string, unknown>).maxCapital).toBe(
      '499845000000000000000000000000000'
    )
  })

  it('skips rows without a 0x identity', () => {
    const page = parseGmxLeaderboardPage(
      { ...payload, reportedTotal: 2, rows: [{ id: 'bogus' }, ...(fx.rows as unknown[])] },
      ctx
    )
    expect(page.rows).toHaveLength(6)
    expect(page.rows[0].rank).toBe(1)
  })

  it('fails closed when a valid leaderboard row loses a realized component', () => {
    const row = { ...(fx.rows as Array<Record<string, unknown>>)[0] }
    delete row.realizedSwapImpact
    expect(() =>
      parseGmxLeaderboardPage({ ...payload, reportedTotal: 1, rows: [row] }, ctx)
    ).toThrow('incomplete realized-net leaderboard components')
  })

  it('rejects legacy 89d replay payloads labelled as 90d', () => {
    expect(() =>
      parseGmxLeaderboardPage(
        {
          ...payload,
          timeframe: 90,
          to: from + 89 * DAY_SECONDS,
        },
        ctx
      )
    ).toThrow('[gmx] invalid completed UTC window bounds')
  })
})

describe('parseGmxProfile', () => {
  const bundle = fixture('profile-bundle.json')

  it('stats: same realized-net PnL as the board, ROI on maxCapital', () => {
    const profile = parseGmxProfile(bundle, ctx)
    const boardRow = parseGmxLeaderboardPage(
      {
        timeframe: bundle.timeframe,
        from: bundle.from,
        to: bundle.to,
        reportedTotal: 1,
        rows: bundle.periodStats,
      },
      ctx
    ).rows[0]
    expect(profile.stats).toHaveLength(1)
    const s = profile.stats[0]
    expect(s.timeframe).toBe(7)
    expect(s.pnl).toBeCloseTo(124.189338, 5)
    expect(s.roi).toBeCloseTo(24.84557, 5)
    expect(s.winRate).toBe(100)
    expect(s.winPositions).toBe(1)
    expect(s.totalPositions).toBe(1)
    expect(s.volume).toBeCloseTo(7990.7198, 3)
    expect(s.aum).toBeCloseTo(499.845, 3)
    expect(s.extras).toMatchObject({
      pnl_basis: 'gmx_period_realized_net',
      roi_basis: 'max_capital_usd',
      pnl_includes_unrealized: false,
      pnl_components_complete: true,
      window_duration_days: 7,
      window_semantics: 'completed_utc_days',
    })
    expect(s.extras.realized_pnl_usd as number).toBeCloseTo(s.pnl!, 8)
    expect(s.pnl).toBeCloseTo(boardRow.headlinePnl!, 8)
    expect(s.roi).toBeCloseTo(boardRow.headlineRoi!, 8)
    expect(s.extras).toMatchObject(boardRow.headlineExtras!)
    expect(s.extras.gmx_total_mark_to_market_pnl_usd as number).toBeCloseTo(227.628956, 5)
    expect(s.mdd).toBeNull()
    expect(s.sharpe).toBeNull()
    expect(s.extras).not.toHaveProperty('sortino')
    expect(s.extras).not.toHaveProperty('risk_derivation')
    expect(s.extras).not.toHaveProperty('risk_samples')
    expect(s.copierPnl).toBeNull()
  })

  it('does not publish total mark-to-market history as canonical realized pnl series', () => {
    const profile = parseGmxProfile(bundle, ctx)
    expect(profile.series).toEqual([])
    expect(profile.replaceSeries).toEqual([{ timeframe: 7, metrics: ['pnl'] }])
  })

  it('client-cuts audit-only history at window_to because the resolver has no to argument', () => {
    const raw = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>
    ;(raw.pnlHistory as Array<Record<string, unknown>>).push({
      timestamp: Number(bundle.to) + DAY_SECONDS,
      cumulativePnl: '999000000000000000000000000000000',
    })
    const profile = parseGmxProfile(raw, ctx)
    expect(profile.stats[0].extras.gmx_total_mark_to_market_pnl_usd as number).toBeCloseTo(
      227.628956,
      5
    )
    expect(profile.stats[0].extras).toMatchObject({
      gmx_history_client_window_cutoff: true,
      gmx_history_rows_raw: 9,
      gmx_history_rows_in_window: 8,
    })
  })

  it('confirmed empty window publishes explicit zero and clears stale series', () => {
    const profile = parseGmxProfile(
      {
        periodStats: [],
        pnlHistory: [],
        timeframe: 30,
        from: 1_765_411_200,
        to: 1_765_411_200 + 30 * DAY_SECONDS,
      },
      ctx
    )
    expect(profile.stats).toHaveLength(1)
    expect(profile.stats[0]).toMatchObject({
      timeframe: 30,
      pnl: 0,
      roi: null,
      winRate: null,
      winPositions: 0,
      totalPositions: 0,
      volume: 0,
    })
    expect(profile.stats[0].extras).toMatchObject({
      pnl_basis: 'gmx_period_realized_net',
      pnl_includes_unrealized: false,
      pnl_components_complete: true,
      profile_window_metrics_complete: true,
      profile_window_empty: true,
      empty_window_evidence: 'explicit_empty_period_stats_and_history',
      window_from: 1_765_411_200,
      window_to: 1_765_411_200 + 30 * DAY_SECONDS,
      window_duration_days: 30,
      window_semantics: 'completed_utc_days',
    })
    expect(profile.series).toHaveLength(0)
    expect(profile.replaceSeries).toEqual([{ timeframe: 30, metrics: ['pnl'] }])
  })

  it('preserves serving values when period aggregate is missing but history is non-empty', () => {
    const profile = parseGmxProfile(
      {
        periodStats: [],
        pnlHistory: [
          { timestamp: 1_765_411_200, cumulativePnl: '1000000000000000000000000000000' },
        ],
        timeframe: 30,
        from: 1_765_411_200,
        to: 1_765_411_200 + 30 * DAY_SECONDS,
      },
      ctx
    )
    expect(profile.stats).toHaveLength(1)
    expect(profile.stats[0]).toMatchObject({ pnl: null, roi: null })
    expect(profile.stats[0].extras).toMatchObject({
      profile_window_metrics_complete: false,
      profile_window_metrics_incomplete_reason: 'period_stats_missing_with_history',
      gmx_total_mark_to_market_pnl_usd: 1,
    })
    expect(profile.replaceSeries).toEqual([{ timeframe: 30, metrics: ['pnl'] }])
  })

  it('does not mistake missing arrays or invalid history rows for a confirmed empty window', () => {
    expect(() =>
      parseGmxProfile(
        {
          periodStats: [],
          timeframe: 30,
          from: 1_765_411_200,
          to: 1_765_411_200 + 30 * DAY_SECONDS,
        },
        ctx
      )
    ).toThrow('[gmx] invalid profile bundle arrays')
    const profile = parseGmxProfile(
      {
        periodStats: [],
        pnlHistory: [{ unexpected: true }],
        timeframe: 30,
        from: 1_765_411_200,
        to: 1_765_411_200 + 30 * DAY_SECONDS,
      },
      ctx
    )
    expect(profile.stats[0].extras).toMatchObject({
      profile_window_metrics_complete: false,
      profile_window_metrics_incomplete_reason: 'period_stats_missing_with_history',
    })
  })

  it('fails closed when id_eq unexpectedly returns duplicate period aggregates', () => {
    const row = (bundle.periodStats as Array<Record<string, unknown>>)[0]
    expect(() =>
      parseGmxProfile(
        {
          periodStats: [row, row],
          pnlHistory: [],
          timeframe: 7,
          from: bundle.from,
          to: bundle.to,
        },
        ctx
      )
    ).toThrow('[gmx] duplicate period aggregates for profile window')
  })

  it('requires an explicit supported timeframe and exact completed UTC bounds', () => {
    const empty = { periodStats: [], pnlHistory: [] }
    expect(() =>
      parseGmxProfile(
        {
          ...empty,
          from: 1_765_411_200,
          to: 1_765_411_200 + 30 * DAY_SECONDS,
        },
        ctx
      )
    ).toThrow('[gmx] invalid window timeframe')
    expect(() =>
      parseGmxProfile(
        {
          ...empty,
          timeframe: 999,
          from: 1_765_411_200,
          to: 1_765_411_200 + 30 * DAY_SECONDS,
        },
        ctx
      )
    ).toThrow('[gmx] invalid window timeframe')
    expect(() =>
      parseGmxProfile({ ...empty, timeframe: 30, to: 1_765_411_200 + 30 * DAY_SECONDS }, ctx)
    ).toThrow('[gmx] invalid completed UTC window bounds')
    expect(() =>
      parseGmxProfile(
        {
          ...empty,
          timeframe: 30,
          from: 1_765_411_201,
          to: 1_765_411_200 + 30 * DAY_SECONDS,
        },
        ctx
      )
    ).toThrow('[gmx] invalid completed UTC window bounds')
    expect(() =>
      parseGmxProfile(
        {
          ...empty,
          timeframe: 90,
          from: 1_765_411_200,
          to: 1_765_411_200 + 89 * DAY_SECONDS,
        },
        ctx
      )
    ).toThrow('[gmx] invalid completed UTC window bounds')
  })

  it('fails closed without clearing serving data when a realized component is absent', () => {
    const incomplete = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>
    delete (incomplete.periodStats as Array<Record<string, unknown>>)[0].realizedSwapImpact
    expect(() => parseGmxProfile(incomplete, ctx)).toThrow(
      'incomplete realized-net profile components'
    )
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

describe('gmxWindowBounds', () => {
  const now = Date.parse('2026-06-12T15:30:00Z')
  it('returns midnight-aligned exact native windows', () => {
    const midnight = Date.parse('2026-06-12T00:00:00Z') / 1000
    expect(gmxWindowFrom(7, now)).toBe(midnight - 7 * 86_400)
    expect(gmxWindowFrom(30, now)).toBe(midnight - 30 * 86_400)
    expect(gmxWindowFrom(90, now)).toBe(midnight - 90 * 86_400)
    expect(gmxWindowBounds(90, now)).toEqual({
      from: midnight - 90 * 86_400,
      to: midnight,
    })
  })
})

describe('GMX transport defaults', () => {
  it('uses the official production Squid GraphQL endpoint', () => {
    expect(GMX_SUBGRAPH_URL).toBe(
      'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'
    )
  })
})

describe('sortGmxLeaderboardRows', () => {
  const rows = fixture('period-account-stats.json').rows as Array<Record<string, unknown>>

  it('sorts the full candidate set by validated realized-net pnl', () => {
    const sorted = sortGmxLeaderboardRows(rows)
    const pnls = sorted.map((row) => gmxRealizedPnlUsd(row)!)
    expect(pnls).toEqual([...pnls].sort((a, b) => b - a))
  })

  it('rejects a schema regression instead of sorting the row as zero', () => {
    const incomplete = { ...rows[0] }
    delete incomplete.realizedSwapFees
    expect(() => sortGmxLeaderboardRows([incomplete])).toThrow(
      'incomplete realized-net leaderboard components'
    )
  })
})

describe('parseGmxHistory', () => {
  it('throws — no history surfaces in v1', () => {
    expect(() => parseGmxHistory({}, 'orders', ctx)).toThrow('not supported')
  })
})
