/**
 * BTCC parser tests over real RAW fixtures (captured live 2026-06-11 from
 * www.btcc.com/en-US/copy-trading?type=all + trader 1941565 "Black Rock").
 * Leaderboard fixture truncated to 3 rows; supportSyms/netProfitList
 * shortened for readability (parsing is unaffected).
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseBtccHistory,
  parseBtccLeaderboardPage,
  parseBtccPositions,
  parseBtccProfile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'btcc_futures',
  currency: 'USDT',
  tfLabelMap: { '7D': 7, '1M': 30, '3M': 90 },
  scrapedAt: '2026-06-11T12:00:00.000Z',
  meta: {},
}

describe('parseBtccLeaderboardPage', () => {
  it('parses the native 30d board (values already percent, bps MDD in raw)', () => {
    const page = parseBtccLeaderboardPage(fixture('trader-page-p1.json'), ctx)
    expect(page.reportedTotal).toBe(1820)
    expect(page.rows).toHaveLength(3)
    const blackRock = page.rows[1]
    expect(blackRock).toMatchObject({
      exchangeTraderId: '1941565',
      rank: 2,
      nickname: 'Black Rock',
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: 353.67, // rateProfit — already percent
      headlinePnl: 41117.02,
      headlineWinRate: 93.8,
    })
    // AUM, copier count, bps maxBackRate, sparkline kept verbatim
    const raw = blackRock.raw as Record<string, unknown>
    expect(raw.totalTraderAtom).toBe(120612.12)
    expect(raw.followNum).toBe(2861)
    expect(raw.maxBackRate).toBe(5676.0) // basis points on the BOARD only
  })
})

describe('parseBtccProfile', () => {
  const bundle = {
    info: fixture('info.json'),
    profitInfo: fixture('profit-info.json'),
    gain: fixture('gain-7.json'),
    profit: fixture('profit-7.json'),
    tradeAmount: fixture('trade-amount-7.json'),
    symbolRate: fixture('symbol-rate-7.json'),
    timeframe: 7,
  }

  it('maps the per-TF gain block into canonical stats', () => {
    const profile = parseBtccProfile(bundle, ctx)
    expect(profile.nickname).toBe('Black Rock')
    expect(profile.stats).toHaveLength(1)
    const stats = profile.stats[0]
    expect(stats.timeframe).toBe(7)
    // Window ROI = final dayTotalProfitRate of the daily series
    expect(stats.roi).toBe(235.01)
    expect(stats.pnl).toBe(27321.05)
    expect(stats.mdd).toBe(0) // gain.maxBackRate — already percent
    expect(stats.winRate).toBe(97.92) // 47/48
    expect(stats.winPositions).toBe(47)
    expect(stats.totalPositions).toBe(48)
    expect(stats.copierCount).toBe(2861) // info.followNum
    expect(stats.aum).toBe(124771.15) // gain.traderAtom
    expect(stats.profitShareRate).toBe(12)
    expect(stats.holdingDurationAvgHours).toBeCloseTo(16300 / 3600, 5)
    expect(stats.tradingPreferences).toEqual({
      symbols: [
        { symbol: 'ETH', tradeNum: 48, openMargin: '3507.036050000001', tradeTotalNum: 48 },
      ],
    })
    expect(stats.extras).toMatchObject({
      profit_loss_ratio_pct: 972.93,
      copier_limit: 3000,
      total_copiers_history: 7193,
      register_days: 556,
      trader_level: 2,
      all_time: { roi: 304.43, pnl: 35392.5, win_rate: 93.8 },
    })
  })

  it('builds daily roi/pnl/volume series with UTC-midnight timestamps', () => {
    const profile = parseBtccProfile(bundle, ctx)
    const metrics = profile.series.map((s) => s.metric)
    expect(metrics).toEqual(['roi', 'pnl', 'volume_daily'])
    const roi = profile.series[0]
    expect(roi.timeframe).toBe(7)
    expect(roi.points[0]).toEqual({ ts: '2026-06-05T00:00:00.000Z', value: 62.76 })
    expect(roi.points[roi.points.length - 1].value).toBe(235.01)
    const volume = profile.series[2]
    expect(volume.points).toHaveLength(7)
    expect(volume.points[0]).toEqual({ ts: '2026-06-05T00:00:00.000Z', value: 520762.76 })
  })

  it('returns empty stats when the gain block is missing', () => {
    const profile = parseBtccProfile({ timeframe: 30 }, ctx)
    expect(profile.stats).toEqual([])
    expect(profile.series).toEqual([])
  })
})

describe('parseBtccPositions', () => {
  it('parses ongoing lead positions (unrealized PnL not public → null)', () => {
    const positions = parseBtccPositions(fixture('current-bring-p1.json'), ctx)
    expect(positions).toHaveLength(2)
    expect(positions[0]).toMatchObject({
      symbol: 'ETHUSDT',
      side: 'short', // direction 2
      leverage: 150,
      size: 5,
      entryPrice: 1611.37,
      markPrice: null,
      unrealizedPnl: null,
    })
  })
})

describe('parseBtccHistory', () => {
  it('parses closed lead positions with positionId-based dedupe', () => {
    const rows = parseBtccHistory(fixture('history-bring-p1.json'), 'position_history', ctx)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      kind: 'position_history',
      openedAt: '2026-06-09T15:55:20.000Z',
      closedAt: '2026-06-10T22:25:16.000Z',
      symbol: 'ETHUSDT',
      side: 'short',
      leverage: 150,
      entryPrice: 1637.53,
      exitPrice: 1609.44,
      realizedPnl: 134.76,
    })
    expect(rows[0].dedupeHash).not.toBe(rows[1].dedupeHash)
  })

  it('parses copiers (masked-email PII stored, never rendered)', () => {
    const rows = parseBtccHistory(fixture('followers-p1.json'), 'copiers', ctx)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: 'klem****@gmail.com',
      copierPnl: 32212.96,
      copierInvested: null,
    })
    expect(rows[0].copyDurationDays).toBeGreaterThan(80) // followed 2026-03-17
  })

  it('rejects unsupported surfaces', () => {
    expect(() => parseBtccHistory({}, 'orders', ctx)).toThrow('not supported')
  })
})
