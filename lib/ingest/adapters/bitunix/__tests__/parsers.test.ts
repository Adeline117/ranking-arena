/**
 * Bitunix parser tests over real RAW fixtures (captured live 2026-06-11
 * from api.bitunix.com + trader 348686197 "Fic Mic"). List fixtures
 * truncated to 3 rows; both 7d and 30d window variants covered.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseBitunixHistory,
  parseBitunixLeaderboardPage,
  parseBitunixPositions,
  parseBitunixProfile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'bitunix_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-12T03:00:00.000Z',
  meta: {},
}

describe('parseBitunixLeaderboardPage', () => {
  it('parses the 30d board (statisticType=2; fractions → percent)', () => {
    const page = parseBitunixLeaderboardPage(fixture('trader-list-30d-p1.json'), ctx)
    expect(page.reportedTotal).toBe(4025)
    expect(page.rows).toHaveLength(3)
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: '348686197',
      rank: 1,
      nickname: 'Fic Mic',
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: 87.4816, // "0.874816" fraction → percent
      headlinePnl: 27178.416518,
      headlineWinRate: 59.45,
    })
    // mdd, aum, copier slots, sparkline... kept verbatim
    const raw = page.rows[0].raw as Record<string, unknown>
    expect(raw.mdd).toBe('0.4351')
    expect(Array.isArray(raw.dailyWinRate)).toBe(true)
  })

  it('parses the 7d crawl (statisticType=1) — window-scoped values', () => {
    const page = parseBitunixLeaderboardPage(fixture('trader-list-7d-p1.json'), ctx)
    expect(page.reportedTotal).toBe(4025)
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: '388987117',
      headlineRoi: 50.1569,
      headlineWinRate: 100,
    })
  })
})

describe('parseBitunixProfile', () => {
  const bundle = {
    statistic: fixture('statistic-30.json'),
    detail: fixture('detail.json'),
    timeframe: 30,
  }

  it('maps 帶單表現 + 帶單員總覽 into canonical stats', () => {
    const profile = parseBitunixProfile(bundle, ctx)
    expect(profile.nickname).toBe('Fic Mic')
    expect(profile.stats).toHaveLength(1)
    const stats = profile.stats[0]
    expect(stats.timeframe).toBe(30)
    expect(stats.roi).toBe(87.4816)
    expect(stats.pnl).toBe(27178.416518)
    expect(stats.mdd).toBe(43.51)
    expect(stats.winRate).toBe(59.45)
    expect(stats.winPositions).toBe(22)
    expect(stats.totalPositions).toBe(37) // 22 wins + 15 losses
    expect(stats.copierPnl).toBeCloseTo(-3.3077, 3)
    expect(stats.copierCount).toBe(5)
    expect(stats.aum).toBeCloseTo(15599.022, 2)
    expect(stats.profitShareRate).toBe(10) // shareRatio "0.1000"
    expect(stats.tradingPreferences).toMatchObject({
      symbols: expect.arrayContaining([{ symbol: 'BTC', proportion: '0.6556' }]),
    })
    expect(stats.extras).toMatchObject({
      trade_days: 8,
      copier_limit: 500,
      total_copiers_history: 8,
      min_invest: 10,
      loss_count: 15,
    })
  })

  it('builds cumulative roi/pnl series from the UTC+0-labeled daily arrays', () => {
    const profile = parseBitunixProfile(bundle, ctx)
    expect(profile.series.map((s) => s.metric)).toEqual(['roi', 'pnl'])
    const roi = profile.series[0]
    expect(roi.timeframe).toBe(30)
    expect(roi.points[0]).toEqual({ ts: '2026-06-04T00:00:00.000Z', value: -21.5887 })
    const pnl = profile.series[1]
    expect(pnl.points[pnl.points.length - 1].value).toBeCloseTo(27178.416518, 4)
  })

  it('returns empty stats when the statistic block is missing', () => {
    const profile = parseBitunixProfile({ timeframe: 7 }, ctx)
    expect(profile.stats).toEqual([])
    expect(profile.series).toEqual([])
  })
})

describe('parseBitunixPositions', () => {
  it('parses 當前帶單 (side 1=short; unrealized PnL public)', () => {
    const positions = parseBitunixPositions(fixture('position-pending.json'), ctx)
    expect(positions).toHaveLength(1)
    expect(positions[0]).toMatchObject({
      symbol: 'ADAUSDT',
      side: 'short', // side 1
      leverage: 20,
      size: 584503,
      markPrice: 0.1711,
      unrealizedPnl: -1936.4389,
    })
    expect(positions[0].entryPrice).toBeCloseTo(0.16779, 5)
  })
})

describe('parseBitunixHistory', () => {
  it('parses 歷史帶單 (id-keyed dedupe; profitRate already percent)', () => {
    const rows = parseBitunixHistory(fixture('position-history-p1.json'), 'position_history', ctx)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      kind: 'position_history',
      openedAt: '2026-06-11T02:04:46.000Z',
      closedAt: '2026-06-12T01:30:32.000Z',
      symbol: 'BTCUSDT',
      side: 'long', // side 2
      leverage: 28,
      size: 15.1,
      entryPrice: 63020,
      exitPrice: 63376.8,
      realizedPnl: 4803.8711637374,
    })
    expect((rows[0].raw as Record<string, unknown>).profitRate).toBe('14.13')
    expect(rows[0].dedupeHash).not.toBe(rows[1].dedupeHash)
  })

  it('parses 跟單者 (masked-email PII stored, never rendered)', () => {
    const rows = parseBitunixHistory(fixture('follow-list-p1.json'), 'copiers', ctx)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: 'az****@gmail.com',
      copierPnl: 0,
      copierInvested: 10,
      copyDurationDays: 1,
    })
  })

  it('rejects unsupported surfaces', () => {
    expect(() => parseBitunixHistory({}, 'transfers', ctx)).toThrow('not supported')
  })
})
