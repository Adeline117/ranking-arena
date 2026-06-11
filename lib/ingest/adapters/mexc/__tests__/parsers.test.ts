/**
 * MEXC parser tests over real RAW fixtures (captured live 2026-06-11 from
 * www.mexc.com/zh-CN/futures/copyTrade/home — the REAL copy-trading URL,
 * spec §9.1 resolved). trader-30.json symbols/symbolDetails and
 * ai-detail.json curve arrays are truncated (parser never reads them).
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseMexcHistory,
  parseMexcLeaderboardPage,
  parseMexcPositions,
  parseMexcProfile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'mexc_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-11T00:00:00.000Z',
  meta: {},
}

describe('parseMexcLeaderboardPage', () => {
  it('parses a live 全部交易员 page (fraction→percent + total)', () => {
    const page = parseMexcLeaderboardPage({ list: fixture('leaderboard-p1.json'), aiUids: [] }, ctx)
    expect(page.reportedTotal).toBe(7664)
    expect(page.rows).toHaveLength(3)
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: '02298603',
      rank: 1,
      nickname: '02*****3',
      headlineRoi: 431.3, // roi 4.313 fraction
      headlinePnl: 2586.8283,
      headlineWinRate: 71.42, // winRate 0.7142 fraction
      traderKind: 'human',
      botStrategy: null,
      traderMeta: null,
    })
    expect(page.rows[0].avatarUrlOrigin).toMatch(/^https:\/\/public\.mocortech\.com\//)
    // Style tags + sparkline + pair mix preserved verbatim (Arena Score v2)
    const raw = page.rows[0].raw as Record<string, unknown>
    expect((raw.tags as Array<{ code: string }>).map((t) => t.code)).toContain('HIGH_PRESSURE')
    expect(Array.isArray(raw.curveValues)).toBe(true)
    expect(Array.isArray(raw.contractRateList)).toBe(true)
    expect(page.rows[1].rank).toBe(2)
  })

  it('marks rows in the AI roster as bot/ai even on the main board', () => {
    const page = parseMexcLeaderboardPage(
      { list: fixture('leaderboard-p1.json'), aiUids: ['02298603'] },
      ctx
    )
    expect(page.rows[0]).toMatchObject({
      traderKind: 'bot',
      botStrategy: 'ai',
      traderMeta: { trader_type: 'AI' },
    })
    expect(page.rows[1].traderKind).toBe('human')
  })

  it('parses the AI 交易员 tab page (aiDetail shape, all rows = bot)', () => {
    const aiList = fixture('ai-list.json') as {
      data: { traders: Array<{ uid: string }> }
    }
    const aiUids = aiList.data.traders.map((t) => t.uid)
    const page = parseMexcLeaderboardPage({ aiDetail: fixture('ai-detail.json'), aiUids }, ctx)
    expect(page.reportedTotal).toBeNull()
    expect(page.rows.length).toBeGreaterThanOrEqual(2)
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: '35158194',
      nickname: 'Echo_Agent',
      traderKind: 'bot',
      botStrategy: 'ai',
      headlineRoi: 1, // roi 0.01 fraction
    })
    // traderType='AI' rows flagged bot even without roster membership
    const inline = parseMexcLeaderboardPage(
      { aiDetail: fixture('ai-detail.json'), aiUids: [] },
      ctx
    )
    const pulse = inline.rows.find((r) => r.exchangeTraderId === '25052940')
    expect(pulse?.traderKind).toBe('bot')
  })

  it('handles empty/malformed payloads', () => {
    expect(parseMexcLeaderboardPage({}, ctx).rows).toHaveLength(0)
    expect(parseMexcLeaderboardPage({ list: { data: null } }, ctx).rows).toHaveLength(0)
    const page = parseMexcLeaderboardPage(
      { list: { data: { total: 1, content: [{ nickname: 'no-uid' }] } } },
      ctx
    )
    expect(page.rows).toHaveLength(0)
    expect(page.reportedTotal).toBe(1)
  })
})

describe('parseMexcProfile', () => {
  const bundle = {
    trader: fixture('trader-30.json'),
    accumulate: fixture('accumulate-30.json'),
    dayPnl: fixture('day-pnl-30.json'),
    ability: fixture('ability-30.json'),
    hold: fixture('hold-30.json'),
    contractStat: fixture('contract-stat-30.json'),
    timeframe: 30,
  }

  it('extracts the per-TF 带单表现 stats block', () => {
    const profile = parseMexcProfile(bundle, ctx)
    expect(profile.stats).toHaveLength(1)
    const stats = profile.stats[0]
    expect(stats).toMatchObject({
      timeframe: 30,
      asOf: ctx.scrapedAt,
      roi: 56.84, // 0.5684 fraction
      pnl: 2431.95904,
      winRate: 88.7, // 0.887 fraction
      winPositions: 55,
      totalPositions: 62,
      copierCount: 33,
      aum: 2658.5861, // followCopyFunds 带单规模
      profitShareRate: 10, // profitRatio 0.1
      mdd: 0,
      sharpe: null,
      volume: null,
    })
    expect(stats.copierPnl).toBeCloseTo(-726.0971, 3)
    expect(stats.holdingDurationAvgHours).toBeCloseTo(43828 / 3600, 5)
    expect(stats.tradingPreferences).toMatchObject({
      contracts: expect.arrayContaining([
        expect.objectContaining({ contractName: 'SOL_USDT', tradeRatio: 0.3114 }),
      ]),
    })
    expect(profile.nickname).toBe('02*****3')
    expect(profile.avatarUrlOrigin).toMatch(/^https:\/\//)
  })

  it('captures radar percentiles, grade and style tags in extras (§12.2)', () => {
    const { extras } = parseMexcProfile(bundle, ctx).stats[0]
    expect(extras.ability_rating).toBe('A+')
    expect(extras.ability_scores).toMatchObject({ profit: 0.9781, win_rate: 0.9472 })
    expect(extras.style_tags).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'HIGH_PRESSURE' })])
    )
    expect(extras.settled_days).toBe(913)
    expect(extras.trade_frequency_per_week).toBe(13)
    expect(extras.total_equity).toBeCloseTo(12773.246, 2)
    expect(extras.profit_and_loss_ratio).toBe('4.0:1')
    expect(extras.max_hold_time_hours).toBeCloseTo(215932 / 3600, 4)
    expect(Array.isArray(extras.hold_histogram)).toBe(true)
  })

  it('builds 累计收益 dual-chart series + daily pnl bars', () => {
    const { series } = parseMexcProfile(bundle, ctx)
    const roi = series.find((s) => s.metric === 'roi')
    const pnl = series.find((s) => s.metric === 'pnl')
    const daily = series.find((s) => s.metric === 'pnl_daily')
    expect(roi?.points).toHaveLength(30)
    expect(roi?.timeframe).toBe(30)
    expect(roi?.points.at(-1)?.value).toBe(56.84)
    expect(pnl?.points.at(-1)?.value).toBe(2431.95904)
    expect(daily?.points).toHaveLength(30)
    // ms epochs → UTC ISO
    expect(roi?.points.at(-1)?.ts).toBe(new Date(1781193600000).toISOString())
  })

  it('yields no stats block when the trader payload is missing', () => {
    const profile = parseMexcProfile({ timeframe: 7 }, ctx)
    expect(profile.stats).toHaveLength(0)
    expect(profile.series).toHaveLength(0)
  })
})

describe('parseMexcPositions', () => {
  it('parses 当前带单 open lead orders', () => {
    const positions = parseMexcPositions(fixture('orders-p1.json'), ctx)
    expect(positions.length).toBeGreaterThanOrEqual(1)
    expect(positions[0]).toMatchObject({
      symbol: 'TAO_USDT',
      side: 'long', // positionType 1
      leverage: 200,
      size: 40.12,
      entryPrice: 239.6,
      markPrice: null,
      unrealizedPnl: null,
    })
  })
})

describe('parseMexcHistory', () => {
  it('parses 历史带单 with orderId dedupe + ms-epoch timestamps', () => {
    const rows = parseMexcHistory(fixture('orders-his-p1.json'), 'position_history', ctx)
    expect(rows).toHaveLength(10)
    const first = rows[0]
    expect(first).toMatchObject({
      kind: 'position_history',
      symbol: 'XAUT_USDT',
      side: 'long',
      leverage: 200,
      entryPrice: 4060.2,
      exitPrice: 4072,
      realizedPnl: 67.2246,
    })
    if (first.kind === 'position_history') {
      expect(first.openedAt).toBe(new Date(1781180668410).toISOString())
      expect(first.closedAt).toBe(new Date(1781181991265).toISOString())
    }
    // orderId-keyed hash is stable
    const again = parseMexcHistory(fixture('orders-his-p1.json'), 'position_history', ctx)
    expect(again[0].dedupeHash).toBe(first.dedupeHash)
  })

  it('parses 跟随者 rows (PII label stored for dedupe only)', () => {
    const rows = parseMexcHistory(fixture('followers-p1.json'), 'copiers', ctx)
    expect(rows.length).toBeGreaterThanOrEqual(5)
    const row = rows[0]
    expect(row.kind).toBe('copiers')
    if (row.kind === 'copiers') {
      expect(row.ts).toBe(ctx.scrapedAt)
      expect(row.copierInvested).toBe(30)
      expect(row.copierPnl).toBeCloseTo(2.0928, 3)
      expect(row.copierLabel).toContain('@') // masked email, never rendered
    }
  })

  it('rejects unsupported history kinds', () => {
    expect(() => parseMexcHistory({}, 'orders', ctx)).toThrow('not supported')
    expect(() => parseMexcHistory({}, 'transfers', ctx)).toThrow('not supported')
  })
})
