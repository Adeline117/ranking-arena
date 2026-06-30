/**
 * HTX parser tests over real RAW fixtures (captured live 2026-06-11 from
 * futures.htx.com/en-us/copytrading/{futures,spot} + trader NTMwMzM0NzU's
 * profile). Leaderboard fixtures truncated to 2-3 rows.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseHtxHistory,
  parseHtxLeaderboardPage,
  parseHtxPositions,
  parseHtxProfile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'htx_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-11T00:00:00.000Z',
  meta: { boardKey: 'futures' },
}

describe('parseHtxLeaderboardPage', () => {
  it('parses the futures rank page (fraction → percent, userSign in traderMeta)', () => {
    const page = parseHtxLeaderboardPage(fixture('rank-futures-p1.json'), ctx)
    expect(page.reportedTotal).toBe(532)
    expect(page.rows).toHaveLength(3)
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: '546498641', // uid is the stable identity
      rank: 1,
      nickname: '五年计划',
      headlineRoi: 3122.57, // profitRate90 "31.2257" fraction
      headlinePnl: 56028.8765,
      headlineWinRate: 100, // winRate "1.0000"
      headlineMdd: 125.32, // mdd "1.2532" fraction → percent (>100 garbage; boundPct nulls downstream)
      headlineAum: 13640.187592, // absolute USDT
      traderKind: 'human',
      botStrategy: null,
      traderMeta: { user_sign: 'NTQ2NDk4NjQ' }, // profile endpoint routing key
    })
    // 30-point sparkline + mdd + aum + copier slots preserved verbatim
    const raw = page.rows[0].raw as Record<string, unknown>
    expect(Array.isArray(raw.profitList)).toBe(true)
    expect(raw.mdd).toBe('1.253200')
    expect(page.rows[1].rank).toBe(2)
  })

  it('parses the spot rank page with the identical shape (one adapter, two boards)', () => {
    const page = parseHtxLeaderboardPage(fixture('rank-spot-p1.json'), ctx)
    expect(page.reportedTotal).toBe(538)
    expect(page.rows).toHaveLength(2)
    expect(page.rows[0].exchangeTraderId).toBe('543648467')
    expect(page.rows[0].traderMeta).toEqual({ user_sign: 'NTQzNjQ4NDY' })
  })

  it('returns empty rows for an error payload', () => {
    const page = parseHtxLeaderboardPage({ code: 500 }, ctx)
    expect(page.rows).toHaveLength(0)
    expect(page.reportedTotal).toBeNull()
  })
})

describe('parseHtxProfile', () => {
  const bundle = {
    baseInfo: fixture('base-info.json'),
    performance: fixture('performance.json'),
    profitRateChart: fixture('profit-rate-chart-90.json'),
    profitChart: fixture('profit-chart-90.json'),
    timeframe: 90,
  }

  it('parses the all-time Overview block onto the 90d stats row', () => {
    const profile = parseHtxProfile(bundle, ctx)
    expect(profile.nickname).toBe('拾光筑梦点滴成川')
    expect(profile.avatarUrlOrigin).toMatch(/^https:\/\/d1x7dwosqaosdj\.cloudfront\.net\//)

    expect(profile.stats).toHaveLength(1)
    const s = profile.stats[0]
    expect(s).toMatchObject({
      timeframe: 90,
      roi: 185.78, // totalProfitRate "1.8578"
      pnl: 18941.5524,
      mdd: 133.38, // "1.3338"
      winRate: 89.21,
      winPositions: 124,
      totalPositions: 139, // winNum 124 + lossNum 15
      copierPnl: 80649.0621,
      copierCount: 50,
      aum: 49685.0002,
      profitShareRate: 25, // takeRate "0.2500"
      sharpe: null,
      volume: null,
    })
    expect(s.holdingDurationAvgHours).toBeCloseTo(9.1718, 3) // 33018351 ms
    // symbolRates JSON strings decoded into preferences
    expect(s.tradingPreferences).toEqual({
      symbols: [
        { symbol: 'ETH-USDT', ratio: 97.16 },
        { symbol: 'BTC-USDT', ratio: 2.84 },
      ],
    })
    expect(s.extras).toMatchObject({
      stats_scope: 'all_time',
      copier_count_history: 420,
      trade_frequency_per_week: 9.83,
      last_trade_time: '2026-06-11T23:18:17.554Z', // ms epoch
      lead_since: '2026-03-05T01:45:29.067Z',
      style_tags: ['Short-term', 'Momentum', 'Prudent'],
      max_copier_slots: 1000,
      profit_loss_ratio: 0.1803,
    })

    const metrics = profile.series.map((x) => x.metric).sort()
    expect(metrics).toEqual(['pnl_daily', 'roi'])
    const roi = profile.series.find((x) => x.metric === 'roi')!
    expect(roi.timeframe).toBe(90)
    expect(roi.points).toHaveLength(90)
    expect(roi.points[0]).toEqual({ ts: '2026-03-13T16:00:00.000Z', value: 41.25 })
  })
})

describe('parseHtxPositions', () => {
  it('parses current positions (positionSide, lastPrice fallback for mark)', () => {
    const positions = parseHtxPositions(fixture('current-positions-nonempty.json'), ctx)
    expect(positions.length).toBeGreaterThanOrEqual(1)
    expect(positions[0]).toMatchObject({
      symbol: 'ETH-USDT',
      side: 'long',
      leverage: 200,
      size: 480,
      entryPrice: 1686.1,
      markPrice: 1672.05, // markPrice null → lastPrice fallback
      unrealizedPnl: -67.44,
    })
  })

  it('returns empty for a trader with no open positions', () => {
    expect(parseHtxPositions(fixture('current-positions.json'), ctx)).toEqual([])
  })
})

describe('parseHtxHistory', () => {
  it('parses History rows (direction sell → short, ms epochs, field-tuple hash)', () => {
    const rows = parseHtxHistory(fixture('history-positions-p1.json'), 'position_history', ctx)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      kind: 'position_history',
      symbol: 'ETH-USDT',
      side: 'short',
      size: 356,
      entryPrice: 1680.54,
      exitPrice: 1671.91,
      realizedPnl: 30.7228,
      openedAt: '2026-06-11T22:18:25.538Z',
      closedAt: '2026-06-11T23:18:17.511Z',
    })
    expect(rows[0].dedupeHash).toMatch(/^[0-9a-f]{40}$/)
    const again = parseHtxHistory(fixture('history-positions-p1.json'), 'position_history', ctx)
    expect(again[0].dedupeHash).toBe(rows[0].dedupeHash)
  })

  it('throws on unsupported surfaces (followers are login-gated)', () => {
    expect(() => parseHtxHistory({}, 'copiers', ctx)).toThrow('not supported')
    expect(() => parseHtxHistory({}, 'orders', ctx)).toThrow('not supported')
  })
})
