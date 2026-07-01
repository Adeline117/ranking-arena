/**
 * Phemex parser tests over real RAW fixtures (captured live 2026-06-11 from
 * phemex.com/copy-trading/list?t=r + trader 2874961). recommend-p1.json is
 * truncated to 3 rows; ai-trader-list.json to 2 house AI bots.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parsePhemexHistory,
  parsePhemexLeaderboardPage,
  parsePhemexPositions,
  parsePhemexProfile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'phemex_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-11T00:00:00.000Z',
  meta: {},
}

describe('parsePhemexLeaderboardPage', () => {
  it('parses a 30d composite board page (fraction → percent + total)', () => {
    const page = parsePhemexLeaderboardPage(
      { board: fixture('recommend-p1.json'), timeframe: 30 },
      ctx
    )
    expect(page.reportedTotal).toBe(229)
    expect(page.rows).toHaveLength(3)
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: '2874961',
      rank: 1,
      nickname: 'PhemexTraderrr',
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: 43.03, // pnlRate30d "0.4303"
      headlinePnl: 50182.4014,
      headlineWinRate: 78.13, // tradeWinRate30d
      avatarUrlOrigin: null, // relative CDN path — raw only
    })
    // mdd / aum / copier slots / both TF variants preserved verbatim
    const raw = page.rows[0].raw as Record<string, unknown>
    expect(raw.mdd30d).toBe('0.08')
    expect(raw.pnlRate90d).toBe('0.7476')
  })

  it('parses the SAME payload as the 90d board with 90d headline fields', () => {
    const page = parsePhemexLeaderboardPage(
      { board: fixture('recommend-p1.json'), timeframe: 90 },
      ctx
    )
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: '2874961',
      headlineRoi: 74.76, // pnlRate90d "0.7476"
      headlinePnl: 78846.795,
    })
  })

  it('marks house AI carousel rows as bot/ai (spec §11.19)', () => {
    const page = parsePhemexLeaderboardPage(
      { aiList: fixture('ai-trader-list.json'), timeframe: 30 },
      ctx
    )
    expect(page.reportedTotal).toBeNull() // additive page — no board total
    expect(page.rows).toHaveLength(2)
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: '9175175',
      nickname: 'Stoic Triad',
      traderKind: 'bot',
      botStrategy: 'ai',
      traderMeta: { ai_trader: true },
      headlineRoi: 86.03, // pnlRate30d "0.8603"
    })
    expect((page.rows[0].raw as Record<string, unknown>).aiDescription).toBeDefined()
  })
})

describe('parsePhemexProfile', () => {
  const bundle = (tf: number) => ({
    user: fixture('user-detail.json'),
    pnlRateChart: fixture('pnl-rate-chart-30.json'),
    pnlChart: fixture('pnl-rate-chart-30.json'), // same shape (value = PNL)
    symbolMetric: fixture('symbol-metric.json'),
    timeframe: tf,
  })

  it('parses genuinely TF-scoped stats from the 30d field variants', () => {
    const profile = parsePhemexProfile(bundle(30), ctx)
    expect(profile.nickname).toBe('PhemexTraderrr')

    expect(profile.stats).toHaveLength(1)
    const s = profile.stats[0]
    expect(s).toMatchObject({
      timeframe: 30,
      roi: 43.03,
      pnl: 50182.4014,
      mdd: 8, // mdd30d "0.08"
      winRate: 78.13,
      winPositions: 25, // tradeWinCount30d
      totalPositions: 31, // tradeCount30d
      copierPnl: 0, // copierRealizedPnl30d {currency USD, amount "0"}
      copierCount: 6,
      aum: 209.825497,
      volume: 258262.133785, // cptTradeVolume30d
      profitShareRate: 10, // profitShareRateRr "0.1"
      holdingDurationAvgHours: null, // ns SUM kept raw in extras
      sharpe: null,
    })
    expect(s.tradingPreferences).toMatchObject({
      symbols: expect.arrayContaining([{ symbol: 'BABYUSDT', value: '0.175572519084' }]),
    })
    expect(s.extras).toMatchObject({
      total_pnl: 379607.9035,
      total_roi: 569.21, // totalPnlRate "5.6921"
      follower_count: 751,
      max_copier_slots: 100,
      position_hold_time_total_ns: 2994139773479394,
      preference_symbols: expect.arrayContaining(['SIRENUSDT']),
      lifetime_trades: 1071, // tradeData.totalTradeCount (Phase A)
      min_copy_amount: 10, // copyTradeData.minCopyAmount {USD, "10"}
    })
    expect(s.extras.lifetime_win_rate as number).toBeCloseTo(60.13, 2) // 0.60130719 ×100

    const roi = profile.series.find((x) => x.metric === 'roi')!
    expect(roi.timeframe).toBe(30)
    expect(roi.points).toHaveLength(30)
    expect(roi.points[0]).toEqual({ ts: '2026-05-14T00:00:00.000Z', value: 1.7 }) // "0.017"
  })

  it('switches to the 90d field variants for the 90d bundle', () => {
    const profile = parsePhemexProfile(bundle(90), ctx)
    const s = profile.stats[0]
    expect(s).toMatchObject({
      timeframe: 90,
      roi: 74.76, // pnlRate90d
      pnl: 78846.795,
      mdd: 18.9, // mdd90d "0.189"
      totalPositions: 119, // tradeCount90d
      volume: 1290367.836704, // cptTradeVolume90d
    })
  })
})

describe('parsePhemexPositions', () => {
  it('parses current positions (posSide → side)', () => {
    const positions = parsePhemexPositions(fixture('position-current.json'), ctx)
    expect(positions.length).toBeGreaterThanOrEqual(1)
    expect(positions[0]).toMatchObject({
      symbol: 'XRPUSDT',
      side: 'short',
      leverage: 3.6,
      size: 1205.38,
      entryPrice: 1.13195231,
      markPrice: null,
    })
  })
})

describe('parsePhemexHistory', () => {
  it('parses closed positions (positionId+openedTime hash, ms epochs)', () => {
    const rows = parsePhemexHistory(fixture('position-closed.json'), 'position_history', ctx)
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows[0]).toMatchObject({
      kind: 'position_history',
      symbol: 'VVVUSDT',
      side: 'short',
      size: 24,
      entryPrice: 13.5,
      exitPrice: 13.504375,
      realizedPnl: -0.4778346,
      openedAt: '2026-06-11T05:01:54.745Z',
      closedAt: '2026-06-11T08:28:36.611Z',
    })
    expect(rows[0].dedupeHash).toMatch(/^[0-9a-f]{40}$/)
    const again = parsePhemexHistory(fixture('position-closed.json'), 'position_history', ctx)
    expect(again[0].dedupeHash).toBe(rows[0].dedupeHash)
  })

  it('throws on unsupported surfaces (Commentary skipped, no copier table)', () => {
    expect(() => parsePhemexHistory({}, 'copiers', ctx)).toThrow('not supported')
    expect(() => parsePhemexHistory({}, 'orders', ctx)).toThrow('not supported')
  })
})
