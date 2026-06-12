/**
 * CoinEx parser tests over real RAW fixtures (captured live 2026-06-11 from
 * www.coinex.com/en/copy-trading/traders + trader F6D0B209's profile).
 * leaderboard-p1.json is truncated to 3 rows (parser never needs more).
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseCoinexHistory,
  parseCoinexLeaderboardPage,
  parseCoinexPositions,
  parseCoinexProfile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'coinex_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-11T00:00:00.000Z',
  meta: {},
}

function profileBundle(timeframe: number): unknown {
  return {
    traderDetail: fixture('trader-detail.json'),
    tradeData: fixture('trade-data.json'),
    profitSeries: fixture('profit-series-30.json'),
    aumSeries: fixture('aum-series-30.json'),
    marketPercent: fixture('market-percent-30.json'),
    timeframe,
  }
}

describe('parseCoinexLeaderboardPage', () => {
  it('parses a live board page (string fraction → percent + reported total)', () => {
    const page = parseCoinexLeaderboardPage(fixture('leaderboard-p1.json'), ctx)
    expect(page.reportedTotal).toBe(188)
    expect(page.rows).toHaveLength(3)
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: 'F6D0B209',
      rank: 1,
      nickname: 'alirezaa141',
      headlineRoi: 35.2281, // profit_rate "0.35228131" fraction
      headlinePnl: 23.27056883,
      headlineWinRate: 100, // winning_rate "1"
      traderKind: 'human',
      botStrategy: null,
      walletAddress: null,
    })
    expect(page.rows[0].avatarUrlOrigin).toMatch(/^https:\/\/file\.coinexstatic\.com\//)
    // MDD, AUM, copier slots, sparkline preserved verbatim
    const raw = page.rows[0].raw as Record<string, unknown>
    expect(raw.mdd).toBe('0.05939723')
    expect(raw.aum).toBe('3234.41711368')
    expect(Array.isArray(raw.profit_rate_series)).toBe(true)
    expect(page.rows[2]).toMatchObject({ exchangeTraderId: '056A9ABF', rank: 3 })
  })

  it('returns empty rows for an error payload', () => {
    const page = parseCoinexLeaderboardPage({ code: 2, data: null, message: 'err' }, ctx)
    expect(page.rows).toHaveLength(0)
    expect(page.reportedTotal).toBeNull()
  })
})

describe('parseCoinexProfile', () => {
  it('parses the 30d bundle: overview stats + 4 chart series + roi sparkline', () => {
    const profile = parseCoinexProfile(profileBundle(30), ctx)
    expect(profile.nickname).toBe('alirezaa141')
    expect(profile.avatarUrlOrigin).toMatch(/^https:\/\/file\.coinexstatic\.com\//)

    expect(profile.stats).toHaveLength(1)
    const s = profile.stats[0]
    expect(s).toMatchObject({
      timeframe: 30,
      roi: 35.2281,
      pnl: 23.27056883,
      mdd: 5.9397, // "0.05939723"
      winRate: 100,
      winPositions: 10,
      totalPositions: 10,
      copierPnl: -128.54097387,
      copierCount: 43,
      profitShareRate: 10, // "0.1"
      sharpe: null,
      volume: null,
      holdingDurationAvgHours: null,
    })
    // AUM = latest aum-series point
    expect(s.aum).toBeCloseTo(3212.76470368)
    expect(s.tradingPreferences).toMatchObject({
      markets: [
        expect.objectContaining({ market: 'BTCUSDT' }),
        expect.objectContaining({ market: 'ETHUSDT' }),
      ],
    })
    expect(s.extras).toMatchObject({
      copier_count_history: 74,
      max_copier_slots: 100,
      trade_days: 28,
      last_trade_time: '2026-06-11T20:26:49.000Z', // 1781209609 SECONDS epoch
    })

    const metrics = profile.series.map((x) => x.metric).sort()
    expect(metrics).toEqual(['aum', 'pnl', 'pnl_copiers', 'pnl_overall', 'roi'])
    const pnl = profile.series.find((x) => x.metric === 'pnl')!
    expect(pnl.timeframe).toBe(30)
    expect(pnl.points).toHaveLength(29)
    expect(pnl.points[pnl.points.length - 1]).toEqual({
      ts: '2026-06-12T00:00:00.000Z', // 1781222400 s
      value: 25.13641088,
    })
    const copier = profile.series.find((x) => x.metric === 'pnl_copiers')!
    expect(copier.points[copier.points.length - 1].value).toBeCloseTo(-91.71145708)
  })

  it('omits the fixed-30d-window roi sparkline on non-30d bundles', () => {
    const profile = parseCoinexProfile(profileBundle(90), ctx)
    expect(profile.stats[0].timeframe).toBe(90)
    expect(profile.series.find((x) => x.metric === 'roi')).toBeUndefined()
  })
})

describe('parseCoinexPositions', () => {
  it('parses current lead positions (side 2 = long, seconds epochs in raw)', () => {
    const positions = parseCoinexPositions(fixture('current-position.json'), ctx)
    expect(positions).toHaveLength(2)
    expect(positions[0]).toMatchObject({
      symbol: 'ETHUSDT',
      side: 'long', // side 2
      leverage: 10,
      size: 0.059,
      entryPrice: 1676,
      markPrice: null,
      unrealizedPnl: -0.22833,
    })
  })
})

describe('parseCoinexHistory', () => {
  it('parses Lead History rows with position_id dedupe', () => {
    const rows = parseCoinexHistory(fixture('finished-position-p1.json'), 'position_history', ctx)
    expect(rows).toHaveLength(10)
    expect(rows[0]).toMatchObject({
      kind: 'position_history',
      symbol: 'ETHUSDT',
      side: 'long',
      leverage: 10,
      size: 0.18,
      exitPrice: 1657.36,
      realizedPnl: 3.1989213,
      openedAt: '2026-06-09T09:33:30.000Z', // 1780997610 s
      closedAt: '2026-06-11T10:29:36.000Z', // 1781173776 s
    })
    expect(rows[0].dedupeHash).toMatch(/^[0-9a-f]{40}$/)
    // stable: same payload → same hash
    const again = parseCoinexHistory(fixture('finished-position-p1.json'), 'position_history', ctx)
    expect(again[0].dedupeHash).toBe(rows[0].dedupeHash)
  })

  it('parses copiers (PII label stored, never rendered)', () => {
    const rows = parseCoinexHistory(fixture('followers-p1.json'), 'copiers', ctx)
    expect(rows).toHaveLength(10)
    expect(rows[0]).toMatchObject({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: 'User_QLZ4569',
      copierInvested: 500,
      copierPnl: 17.06470696,
      copyDurationDays: null,
    })
  })

  it('throws on unsupported surfaces', () => {
    expect(() => parseCoinexHistory({}, 'orders', ctx)).toThrow('not supported')
    expect(() => parseCoinexHistory({}, 'transfers', ctx)).toThrow('not supported')
  })
})
