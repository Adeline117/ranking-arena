import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseBitgetBotsBoardPage,
  parseBitgetBotsCopiers,
  parseBitgetBotsProfile,
} from '../bots-parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'bitget_bots_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-11T00:00:00.000Z',
  meta: {},
}

describe('parseBitgetBotsBoardPage (live-captured fixtures, 2026-06-11)', () => {
  it('parses futures grid cards into shadow-trader rows with bot meta', () => {
    const page = parseBitgetBotsBoardPage(
      { board: 'futures_grid', payload: fixture('bots-board-futures-grid.json') },
      ctx
    )
    expect(page.reportedTotal).toBe(100)
    expect(page.rows).toHaveLength(20)
    const first = page.rows[0]
    expect(first.traderKind).toBe('bot')
    expect(first.botStrategy).toBe('grid')
    expect(first.exchangeTraderId).toMatch(/^\d+$/) // strategyId
    expect(first.nickname).toBe('RIVERUSDT') // pair is the card title
    expect(first.headlineRoi).toBeCloseTo(22869.74, 1)
    expect(first.headlineWinRate).toBeNull()
    // 最大回撤 now captured from thirtyMaxDrawdown (was dropped) — spec §11.5
    expect(typeof first.headlineMdd).toBe('number')
    const bot = first.traderMeta?.bot as Record<string, unknown>
    expect(bot).toMatchObject({
      exchange_bot_id: first.exchangeTraderId,
      pair: 'RIVERUSDT',
      product_type: 'futures',
      strategy: 'grid',
      direction: 'long',
      profit_share_rate: 30,
    })
    expect(bot.owner_account_id).toMatch(/^b/)
    expect(typeof bot.runtime_days).toBe('number')
    expect(bot.created_at_origin).toMatch(/Z$/)
  })

  it('parses spot martingale cards with the right strategy/product split', () => {
    const page = parseBitgetBotsBoardPage(
      { board: 'spot_martingale', payload: fixture('bots-board-spot-martingale.json') },
      ctx
    )
    expect(page.rows.length).toBeGreaterThan(0)
    expect(page.rows[0].botStrategy).toBe('martingale')
    const bot = page.rows[0].traderMeta?.bot as Record<string, unknown>
    expect(bot.product_type).toBe('spot')
  })

  it('returns empty for junk payloads', () => {
    expect(parseBitgetBotsBoardPage(null, ctx).rows).toHaveLength(0)
    expect(parseBitgetBotsBoardPage({ board: 'futures_grid', payload: {} }, ctx).rows).toHaveLength(
      0
    )
  })
})

describe('parseBitgetBotsProfile (live-captured fixture, 2026-06-11)', () => {
  it('parses performances per TF plus an inception (timeframe 0) block', () => {
    const profile = parseBitgetBotsProfile(
      { strategyInfo: fixture('bots-strategy-info.json'), timeframe: 30 },
      ctx
    )
    const tfs = profile.stats.map((s) => s.timeframe).sort((a, b) => a - b)
    expect(tfs).toEqual([0, 7, 30, 90])

    const tf7 = profile.stats.find((s) => s.timeframe === 7)
    expect(tf7?.roi).toBeCloseTo(-56.92, 2)
    expect(tf7?.pnl).toBeCloseTo(-29.05, 2)

    const inception = profile.stats.find((s) => s.timeframe === 0)
    const fixtureRoi = Number(
      (fixture('bots-strategy-info.json') as { data: { profitRate: string } }).data.profitRate
    )
    expect(inception?.roi).toBe(fixtureRoi) // cumulative since creation
    expect(inception?.copierCount).toBeGreaterThan(0)
    expect(inception?.aum).not.toBeNull()
    expect(inception?.extras.created_at_origin).toMatch(/Z$/)
    expect(inception?.extras.runtime_days).toBeGreaterThan(100)

    // This payload carries the copier-profit trend (profitChartDto); the
    // bot's own chart (strategySelfProfitChartDto) is null in this capture.
    const copierPnl = profile.series.find((s) => s.metric === 'copier_pnl')
    expect(copierPnl?.timeframe).toBe(30)
    expect(copierPnl?.points.length).toBeGreaterThan(10)
    expect(copierPnl?.points[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(profile.nickname).toBe('RIVERUSDT')
  })

  it('handles missing payloads without throwing', () => {
    expect(parseBitgetBotsProfile(null, ctx).stats).toHaveLength(0)
    expect(parseBitgetBotsProfile({ strategyInfo: { data: null } }, ctx).stats).toHaveLength(0)
  })
})

describe('parseBitgetBotsCopiers (live-captured fixture, 2026-06-11)', () => {
  it('uses the page-disclosed lastUpdateTime as ts and parses durations', () => {
    const rows = parseBitgetBotsCopiers(fixture('bots-follow-rank.json'), ctx)
    expect(rows).toHaveLength(10)
    const first = rows[0]
    if (first.kind !== 'copiers') throw new Error('wrong kind')
    expect(first.ts).not.toBe(ctx.scrapedAt) // lastUpdateTime, not scrape time
    expect(first.ts).toMatch(/Z$/)
    expect(first.copierLabel).toMatch(/^BGUSER/)
    expect(first.copierInvested).toBe(Number(first.raw.followerInvestmentAmount))
    expect(typeof first.copyDurationDays).toBe('number')
    expect(new Set(rows.map((r) => r.dedupeHash)).size).toBe(rows.length)
  })

  it('tolerates junk payloads', () => {
    expect(parseBitgetBotsCopiers(null, ctx)).toHaveLength(0)
    expect(parseBitgetBotsCopiers({ data: {} }, ctx)).toHaveLength(0)
  })
})
