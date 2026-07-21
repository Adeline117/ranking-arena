/**
 * Binance parser tests — run against RAW fixtures captured live via the
 * SG remote browser (2026-06-11). Fixture values are real payloads, so
 * the assertions double as unit-semantics documentation (percent vs
 * decimal, ms epochs, signed sizes).
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  dedupeHash,
  parseBinanceHistory,
  parseBinanceLeaderboardPage,
  parseBinancePositions,
  parseBinanceProfile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'binance_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-11T00:00:00.000Z',
  meta: { boardKey: 'futures' },
}

describe('parseBinanceLeaderboardPage', () => {
  it('parses the futures query-list shape', () => {
    const page = parseBinanceLeaderboardPage(fixture('leaderboard-p1.json'), ctx)
    expect(page.reportedTotal).toBe(9806)
    expect(page.rows).toHaveLength(20)
    const first = page.rows[0]
    expect(first.exchangeTraderId).toMatch(/^\d{16,}$/) // leadPortfolioId
    expect(first.rank).toBe(1)
    expect(first.traderKind).toBe('human')
    expect(typeof first.headlineRoi).toBe('number') // already percent
    expect(typeof first.headlinePnl).toBe('number')
    expect(first.headlineMetricSources).toEqual({
      roi: { fieldPath: 'data.list[].roi' },
      pnl: { fieldPath: 'data.list[].pnl' },
      win_rate: { fieldPath: 'data.list[].winRate' },
    })
    expect(first.headlineMetricSources?.roi).not.toHaveProperty('provenance')
    expect(first.headlineAum).toBeCloseTo(85079.66905633, 2) // board aum (absolute USD)
    expect(first.raw).toHaveProperty('sharpRatio') // board card extras kept
    expect(first.raw).toHaveProperty('chartItems')
  })

  it('parses the spot home-page-list shape (no winRate on rows)', () => {
    const page = parseBinanceLeaderboardPage(fixture('spot-leaderboard-p1.json'), ctx)
    expect(page.reportedTotal).toBe(2509)
    expect(page.rows).toHaveLength(20)
    expect(page.rows[0].headlineWinRate).toBeNull()
    expect(page.rows[0].headlineMetricSources).toEqual({
      roi: { fieldPath: 'data.list[].roi' },
      pnl: { fieldPath: 'data.list[].pnl' },
    })
    expect(page.rows[0].exchangeTraderId).toMatch(/^\d{16,}$/)
    expect(page.rows[5].rank).toBe(6)
  })

  it('returns empty rows for malformed payloads', () => {
    expect(parseBinanceLeaderboardPage(null, ctx).rows).toHaveLength(0)
    expect(parseBinanceLeaderboardPage({ data: {} }, ctx).rows).toHaveLength(0)
  })
})

describe('parseBinanceProfile', () => {
  it('parses the futures bundle — Sharpe mapped, percent units preserved', () => {
    const profile = parseBinanceProfile(
      {
        detail: fixture('detail.json'),
        performance: fixture('performance-7.json'),
        chartRoi: fixture('chart-roi-7.json'),
        chartPnl: fixture('chart-pnl-7.json'),
        coinPreference: fixture('coin-preference-7.json'),
        timeframe: 7,
      },
      ctx
    )
    expect(profile.stats).toHaveLength(1)
    const st = profile.stats[0]
    expect(st.timeframe).toBe(7)
    expect(st.roi).toBeCloseTo(45.60207166) // already percent
    expect(st.pnl).toBeCloseTo(6269.17835034)
    expect(st.sharpe).toBeCloseTo(3.16850933) // Binance exposes Sharpe
    expect(st.mdd).toBeCloseTo(11.839176)
    expect(st.winRate).toBeCloseTo(80)
    expect(st.winPositions).toBe(4)
    expect(st.totalPositions).toBe(5)
    expect(st.copierCount).toBe(500)
    expect(st.aum).toBeCloseTo(443307.236725) // from detail.aumAmount
    expect(st.profitShareRate).toBeCloseTo(15)
    expect(st.extras.margin_balance).toBeCloseTo(20155.89470914)
    expect(st.extras.lead_start_time).toBe('2026-04-04T11:08:58.506Z')
    expect(st.tradingPreferences).toMatchObject({ assets: [{ asset: 'ETH', volume: 100 }] })

    expect(profile.series).toHaveLength(2)
    const roi = profile.series.find((s) => s.metric === 'roi')!
    expect(roi.timeframe).toBe(7)
    expect(roi.points.length).toBeGreaterThanOrEqual(7)
    expect(roi.points[0].ts).toBe('2026-06-05T00:00:00.000Z') // UTC-midnight daily
    const pnl = profile.series.find((s) => s.metric === 'pnl')!
    expect(pnl.points[0].value).toBeCloseTo(-1782.460953)

    expect(profile.nickname).toBe('厦风')
  })

  it('parses the spot bundle — string numerics, winDays → extras', () => {
    const profile = parseBinanceProfile(
      {
        detail: fixture('spot-detail.json'),
        performance: fixture('spot-performance-7.json'),
        chartRoi: fixture('spot-chart-roi-7.json'),
        chartPnl: fixture('spot-chart-pnl-7.json'),
        coinPreference: fixture('spot-coin-preference-7.json'),
        timeframe: 7,
      },
      { ...ctx, sourceSlug: 'binance_spot', meta: { boardKey: 'spot' } }
    )
    const st = profile.stats[0]
    expect(st.roi).toBeCloseTo(57.96655022)
    expect(st.sharpe).toBeCloseTo(0.09533622)
    expect(st.aum).toBeCloseTo(40073.17838603) // spot perf exposes aum directly
    expect(st.winPositions).toBeNull() // spot has winDays, not winOrders
    expect(typeof st.extras.win_days).toBe('number')
    expect(st.extras.days_trading).toBe(637)
    expect(st.copierCount).toBe(160)
    expect(profile.series.map((s) => s.metric).sort()).toEqual(['pnl', 'roi'])
  })

  it('yields no stats when the performance block is missing', () => {
    const profile = parseBinanceProfile({ detail: fixture('detail.json'), timeframe: 30 }, ctx)
    expect(profile.stats).toHaveLength(0)
    expect(profile.nickname).toBe('厦风')
  })
})

describe('parseBinancePositions', () => {
  it('filters zero futures placeholder rows and signs the side', () => {
    const positions = parseBinancePositions(fixture('positions.json'), ctx)
    // fixture: 2 nonzero rows + 2 zero placeholders
    expect(positions).toHaveLength(2)
    for (const p of positions) {
      expect(p.size).not.toBe(0)
      expect(['long', 'short']).toContain(p.side)
      expect(p.entryPrice).toBeGreaterThan(0)
      expect(p.markPrice).toBeGreaterThan(0)
    }
    const short = positions.find((p) => (p.size ?? 0) < 0)
    if (short) expect(short.side).toBe('short')
  })

  it('parses spot holdings as long positions', () => {
    const positions = parseBinancePositions(fixture('spot-holdings-p1.json'), ctx)
    expect(positions.length).toBeGreaterThanOrEqual(5)
    const eth = positions.find((p) => p.symbol === 'ETHUSDT')!
    expect(eth.side).toBe('long')
    expect(eth.size).toBeCloseTo(1.4210775)
    expect(eth.entryPrice).toBeCloseTo(1622.61261261)
    expect(eth.leverage).toBeNull()
  })
})

describe('parseBinanceHistory', () => {
  const wrap = (response: unknown, sort?: string) => ({
    portfolioId: '4988579992261068032',
    sort,
    response,
  })

  it('parses position history and dedupes across OPENING/CLOSING sorts', () => {
    const opening = parseBinanceHistory(
      wrap(fixture('position-history-opening-p1.json'), 'OPENING'),
      'position_history',
      ctx
    )
    const closing = parseBinanceHistory(
      wrap(fixture('position-history-closing-p1.json'), 'CLOSING'),
      'position_history',
      ctx
    )
    expect(opening.length).toBeGreaterThan(0)
    const row = opening[0]
    expect(row.kind).toBe('position_history')
    if (row.kind === 'position_history') {
      expect(row.symbol).toBe('ETHUSDT')
      expect(row.openedAt).toBe('2026-06-09T15:26:03.608Z')
      expect(row.closedAt).toBe('2026-06-10T15:05:03.332Z')
      expect(row.side).toBe('long')
      expect(row.leverage).toBe(50)
      expect(row.realizedPnl).toBeCloseTo(368.88331987)
    }
    // Same rows fetched under both sorts collapse onto identical hashes.
    const openingHashes = new Set(opening.map((r) => r.dedupeHash))
    const overlap = closing.filter((r) => openingHashes.has(r.dedupeHash))
    expect(overlap.length).toBeGreaterThan(0)
  })

  it('includes the portfolio id in dedupe hashes (ids are ms epochs, not unique)', () => {
    const a = parseBinanceHistory(
      wrap(fixture('position-history-opening-p1.json')),
      'position_history',
      ctx
    )
    const b = parseBinanceHistory(
      { portfolioId: 'другой', response: fixture('position-history-opening-p1.json') },
      'position_history',
      ctx
    )
    expect(a[0].dedupeHash).not.toBe(b[0].dedupeHash)
  })

  it('parses futures order history (Latest Records)', () => {
    const rows = parseBinanceHistory(wrap(fixture('order-history-p1.json')), 'orders', ctx)
    expect(rows.length).toBeGreaterThan(0)
    const row = rows[0]
    if (row.kind === 'orders') {
      expect(row.symbol).toBe('ETHUSDT')
      expect(row.side).toBe('short') // SELL
      expect(row.orderKind).toBe('LIMIT')
      expect(row.qty).toBe(10)
      expect(row.price).toBeCloseTo(1657.3)
      expect(row.ts).toBe(new Date(1781158716398).toISOString())
    }
  })

  it('parses spot trade history, disambiguating identical fills', () => {
    const rows = parseBinanceHistory(wrap(fixture('spot-trade-history-p1.json')), 'orders', ctx)
    expect(rows.length).toBeGreaterThan(0)
    // The real fixture contains byte-identical fills (same ts/qty/price) —
    // occurrence indexing must keep them distinct.
    const hashes = new Set(rows.map((r) => r.dedupeHash))
    expect(hashes.size).toBe(rows.length)
    const row = rows[0]
    if (row.kind === 'orders') {
      expect(row.side).toBe('long') // BUY
      expect(row.orderKind).toBe('TAKER')
    }
  })

  it('parses transfers with lead-account-relative direction', () => {
    const rows = parseBinanceHistory(wrap(fixture('transfer-history-p1.json')), 'transfers', ctx)
    expect(rows.length).toBeGreaterThan(0)
    const dirs = rows.map((r) => (r.kind === 'transfers' ? r.direction : null))
    expect(dirs).toContain('in') // LEAD_DEPOSIT
    expect(dirs).toContain('out') // LEAD_WITHDRAW
    const first = rows[0]
    if (first.kind === 'transfers') {
      expect(first.asset).toBe('USDT')
      expect(first.amount).toBeCloseTo(1452.91948368)
    }
  })

  it('parses futures copiers (copyPortfolioId label) and spot copiers (nickname label)', () => {
    const fut = parseBinanceHistory(wrap(fixture('copy-traders-p1.json')), 'copiers', ctx)
    expect(fut.length).toBeGreaterThan(0)
    const f = fut[0]
    if (f.kind === 'copiers') {
      expect(f.copierLabel).toMatch(/^\d{16,}$/) // stable copyPortfolioId
      expect(f.copierInvested).toBeGreaterThan(0)
      expect(f.copyDurationDays).toBeGreaterThanOrEqual(0)
      expect(f.ts).toBe(ctx.scrapedAt)
    }

    const spot = parseBinanceHistory(wrap(fixture('spot-copy-traders-p1.json')), 'copiers', ctx)
    expect(spot.length).toBeGreaterThan(0)
    const s = spot[0]
    if (s.kind === 'copiers') {
      expect(typeof s.copierLabel).toBe('string') // masked nickname fallback
      expect(s.copierPnl).not.toBeNull()
    }
  })
})

describe('dedupeHash', () => {
  it('is deterministic and order-sensitive', () => {
    expect(dedupeHash('a', 1, null)).toBe(dedupeHash('a', 1, null))
    expect(dedupeHash('a', 'b')).not.toBe(dedupeHash('b', 'a'))
  })
})
