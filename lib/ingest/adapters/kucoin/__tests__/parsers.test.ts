/**
 * KuCoin parser tests over real RAW fixtures (captured live 2026-06-11 from
 * www.kucoin.com/copytrading + trader-profile/1007359). leaderboard-p1.json
 * is truncated to 3 rows — one TradePilot (exchange 'BN') + two native 'KU'.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseKucoinHistory,
  parseKucoinLeaderboardPage,
  parseKucoinPositions,
  parseKucoinProfile,
  validateKucoinProfile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'kucoin_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-11T00:00:00.000Z',
  meta: {},
}

interface ProfileFixtureBundle {
  summary: { data: Record<string, unknown> }
  overview: unknown
  pnlHistory: { data: Array<Record<string, unknown>> }
  currencyPreference: unknown
  timeframe: number
}

function profileBundle(timeframe: number): ProfileFixtureBundle {
  return {
    summary: fixture('summary.json') as ProfileFixtureBundle['summary'],
    overview: fixture('overview.json'),
    pnlHistory: fixture('pnl-history-30.json') as ProfileFixtureBundle['pnlHistory'],
    currencyPreference: fixture('currency-preference.json'),
    timeframe,
  }
}

describe('parseKucoinLeaderboardPage', () => {
  it('parses a board page: 30d headline + TradePilot rows marked bot/ai', () => {
    const page = parseKucoinLeaderboardPage(fixture('leaderboard-p1.json'), ctx)
    expect(page.reportedTotal).toBe(122)
    expect(page.rows).toHaveLength(3)
    // Row 1 is the TradePilot trader (exchange 'BN')
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: '1007359',
      rank: 1,
      nickname: 'OldWolfofWallStreet_KC',
      traderKind: 'bot',
      botStrategy: 'ai',
      traderMeta: { tradepilot: true, venue: 'BN' },
      headlineRoi: 432.1693, // thirtyDayPnlRatio "4.3216934574…"
      headlinePnl: 6310.43909344,
      headlineWinRate: null,
      headlineCopierCount: 47, // currentCopyUserCount
    })
    // 逐图核对: board-row lead principal / tenure / copier / min-copy promoted
    expect(page.rows[0].headlineExtras).toMatchObject({
      lead_principal: 4797.39877728,
      leading_days: 136,
      max_copier_slots: 1000,
      total_roi: 151.1, // totalPnlRatio 1.5110 ×100
      min_copy_amount: 10,
    })
    // Native KuCoin rows stay human
    expect(page.rows[1]).toMatchObject({
      exchangeTraderId: '1008600',
      nickname: 'TheShitcoinShorter',
      traderKind: 'human',
      botStrategy: null,
      traderMeta: null,
    })
    // Sparkline + lead size + copier slots preserved verbatim
    const raw = page.rows[0].raw as Record<string, unknown>
    expect(Array.isArray(raw.totalPnlDate)).toBe(true)
    expect(raw.leadAmount).toBeDefined()
  })

  it('falls back to pnl/principal when thirtyDayPnlRatio is absurd (broken field)', () => {
    const page = parseKucoinLeaderboardPage(
      {
        data: {
          items: [
            // Real prod case: ratio field returns 2.19e9 while pnl/principal ~17%.
            {
              leadConfigId: 1007384,
              thirtyDayPnlRatio: '2196044437.78',
              thirtyDayPnl: '20.83',
              leadPrincipal: '120.83',
            },
            // Normal trader: ratio is sane (<100000%) so it is trusted as-is.
            {
              leadConfigId: 1008600,
              thirtyDayPnlRatio: '4.32',
              thirtyDayPnl: '6310',
              leadPrincipal: '5000',
            },
          ],
        },
      },
      ctx
    )
    expect(page.rows[0].headlineRoi).toBeCloseTo(17.24, 1) // 20.83/120.83*100, not 2.19e11
    expect(page.rows[1].headlineRoi).toBe(432) // 4.32 ratio trusted (sane)
  })

  it('returns empty rows for an error payload', () => {
    const page = parseKucoinLeaderboardPage({ success: false, data: null }, ctx)
    expect(page.rows).toHaveLength(0)
    expect(page.reportedTotal).toBeNull()
  })
})

describe('parseKucoinProfile', () => {
  it('parses the 30d bundle: chart-derived roi/pnl + overview enrichments', () => {
    const raw = profileBundle(30)
    const profile = parseKucoinProfile(raw, ctx)
    expect(profile.nickname).toBe('OldWolfofWallStreet_KC')
    expect(profile.avatarUrlOrigin).toMatch(/^https:\/\/assets\.staticimg\.com\//)

    expect(profile.stats).toHaveLength(1)
    const s = profile.stats[0]
    expect(s).toMatchObject({
      timeframe: 30,
      roi: 432.1693, // last chart point ratio "4.32169345743905481248"
      pnl: 6310.43909344,
      mdd: null,
      winRate: null,
      copierPnl: 192.9321799631,
      copierCount: 47,
      aum: 3004.0731799631,
      profitShareRate: 10, // "0.10"
      sharpe: null,
      volume: null,
    })
    expect(s.tradingPreferences).toMatchObject({
      currencies: expect.arrayContaining([{ currency: 'BTC', percent: '0.0767' }]),
    })
    expect(s.extras).toMatchObject({
      exchange_uid: '253719106',
      lead_days: 137,
      follower_count: 285,
      max_copier_slots: 1000,
      venue: 'BN',
      tradepilot: true,
      total_return_rate: 151.1014,
      lead_principal: 4797.39877728,
      trading_frequency: 10, // raw per-day
      trade_frequency: 70, // 10 × 7 → per-week alias for display
    })

    const metrics = profile.series.map((x) => x.metric).sort()
    expect(metrics).toEqual(['pnl', 'roi'])
    const pnl = profile.series.find((x) => x.metric === 'pnl')!
    expect(pnl.timeframe).toBe(30)
    expect(pnl.points).toHaveLength(30)
    expect(pnl.points[0]).toEqual({ ts: '2026-05-13T16:00:00.000Z', value: -173.12764102 })
    expect(pnl.points[29]).toEqual({ ts: '2026-06-11T16:00:00.000Z', value: 6310.43909344 })
    expect(profile.replaceSeries).toEqual([{ timeframe: 30, metrics: ['pnl', 'roi'] }])
    expect(validateKucoinProfile(profile, ctx, 30, raw)).toEqual([])
  })

  it('sorts an unsorted chart before deriving its scalar tail', () => {
    const raw = profileBundle(30)
    raw.pnlHistory.data = [...raw.pnlHistory.data].reverse()
    const parsed = parseKucoinProfile(raw, ctx)
    expect(parsed.stats[0]).toMatchObject({ roi: 432.1693, pnl: 6310.43909344 })
    expect(parsed.series[0].points[0].ts).toBe('2026-05-13T16:00:00.000Z')
  })

  it('rejects a stopped historical chart without changing its parsed evidence', () => {
    const staleCtx = { ...ctx, scrapedAt: '2026-07-16T16:00:00.000Z' }
    const raw = profileBundle(30)
    const parsed = parseKucoinProfile(raw, staleCtx)
    expect(parsed.replaceSeries).toEqual([{ timeframe: 30, metrics: ['pnl', 'roi'] }])
    expect(validateKucoinProfile(parsed, staleCtx, 30, raw)[0]).toMatchObject({
      reason: 'profile_series_tail_stale',
      payload: {
        metrics: {
          pnl: { tail_at: '2026-06-11T16:00:00.000Z' },
          roi: { tail_at: '2026-06-11T16:00:00.000Z' },
        },
      },
    })
  })

  it('rejects malformed RAW chart values instead of coercing them to zero', () => {
    const raw = profileBundle(30)
    raw.pnlHistory.data[0] = {
      ...raw.pnlHistory.data[0],
      pnl: false,
      ratio: [],
    }
    raw.pnlHistory.data.push({ statTime: 'not-an-epoch', pnl: '1', ratio: '0.01' })

    const parsed = parseKucoinProfile(raw, ctx)
    const reject = validateKucoinProfile(parsed, ctx, 30, raw)[0]
    expect(reject).toMatchObject({
      reason: 'profile_series_point_invalid',
      payload: {
        blocking_reasons: ['profile_series_point_invalid'],
        raw_chart: {
          row_count: 31,
          invalid_row_count: 2,
          invalid_timestamp_count: 1,
          invalid_pnl_count: 1,
          invalid_roi_count: 1,
        },
      },
    })
    expect(parsed.replaceSeries).toEqual([])
    expect(parsed.series.find((series) => series.metric === 'pnl')?.points[0].value).not.toBe(0)
  })

  it('rejects a truncated established-trader window but permits a genuine newcomer', () => {
    const truncated = profileBundle(90)
    truncated.pnlHistory.data = truncated.pnlHistory.data.slice(-1)
    const established = parseKucoinProfile(truncated, ctx)
    expect(validateKucoinProfile(established, ctx, 90, truncated)[0]).toMatchObject({
      reason: 'profile_series_points_insufficient',
      payload: {
        min_point_count: 72,
        blocking_reasons: [
          'profile_series_points_insufficient',
          'profile_series_coverage_insufficient',
        ],
      },
    })

    const newcomer = profileBundle(90)
    newcomer.summary.data.leadDays = 1
    newcomer.pnlHistory.data = newcomer.pnlHistory.data.slice(-1)
    const newcomerProfile = parseKucoinProfile(newcomer, ctx)
    expect(validateKucoinProfile(newcomerProfile, ctx, 90, newcomer)).toEqual([])
  })

  it('deduplicates exact timestamps last-wins before publication', () => {
    const raw = profileBundle(30)
    raw.pnlHistory.data.push({
      ...raw.pnlHistory.data.at(-1),
      pnl: '7000',
      ratio: '5',
    })
    const parsed = parseKucoinProfile(raw, ctx)
    expect(parsed.stats[0]).toMatchObject({ pnl: 7000, roi: 500 })
    expect(parsed.series.find((series) => series.metric === 'pnl')?.points).toHaveLength(30)
    expect(validateKucoinProfile(parsed, ctx, 30, raw)).toEqual([])
  })
})

describe('parseKucoinPositions', () => {
  it('always returns empty (positions are visibility-gated)', () => {
    expect(parseKucoinPositions(fixture('position-history-null.json'), ctx)).toEqual([])
  })
})

describe('parseKucoinHistory', () => {
  it('parses lead-order fills (tradeSide split + orderId dedupe)', () => {
    const rows = parseKucoinHistory(fixture('lead-orders-p1.json'), 'orders', ctx)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      kind: 'orders',
      ts: '2026-06-12T00:04:29.000Z', // tradeTime ms
      orderKind: 'OPEN',
      symbol: 'ETCUSDTM',
      side: 'short',
      price: 7.237,
      qty: 344.12,
    })
    expect(rows[0].dedupeHash).toMatch(/^[0-9a-f]{40}$/)
    const again = parseKucoinHistory(fixture('lead-orders-p1.json'), 'orders', ctx)
    expect(again[0].dedupeHash).toBe(rows[0].dedupeHash)
  })

  it('parses copiers (masked email stored, never rendered)', () => {
    const rows = parseKucoinHistory(fixture('copy-traders-p1.json'), 'copiers', ctx)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: 'jm4***@privaterelay.appleid.com',
      copierInvested: 10,
      copierPnl: 32.593517794,
      copyDurationDays: 90,
    })
  })

  it('throws on unsupported surfaces', () => {
    expect(() => parseKucoinHistory({}, 'position_history', ctx)).toThrow('not supported')
    expect(() => parseKucoinHistory({}, 'transfers', ctx)).toThrow('not supported')
  })
})
