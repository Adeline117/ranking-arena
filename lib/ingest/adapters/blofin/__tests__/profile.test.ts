/**
 * blofin profile parser over REAL fixtures (headful-harvested 2026-07-02 from
 * blofin.com/uapi/v1/copy/trader/stat/*). Confirms the risk metrics the board
 * omits (sharpe/sortino/calmar/volatility) reach ParsedStats + preferences/chart.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseBlofinProfile } from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fx(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'blofin_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-07-02T00:00:00.000Z',
  meta: {},
}

describe('parseBlofinProfile', () => {
  const payload = {
    info: fx('profile-info.json'),
    indicators: fx('profile-indicators-d30.json'),
    symbolPerf: fx('profile-symbol-perf-d30.json'),
    performance: fx('profile-performance-d30.json'),
    timeframe: 30,
  }

  it('harvests risk metrics the board omits (sharpe/sortino/calmar/volatility)', () => {
    const r = parseBlofinProfile(payload, ctx)
    expect(r.stats).toHaveLength(1)
    const s = r.stats[0]
    expect(s.timeframe).toBe(30)
    expect(s.sharpe).toBeCloseTo(9.2657, 3) // raw ratio, board had 0
    expect(s.extras.sortino).toBeCloseTo(142.9351, 3)
    expect(s.extras.calmar).toBeCloseTo(50.9622, 3)
    expect(typeof s.extras.volatility).toBe('number')
  })

  it('scales roi/mdd/win_rate like the board (×100 fraction→percent)', () => {
    const s = parseBlofinProfile(payload, ctx).stats[0]
    expect(s.roi).toBeCloseTo(3520.27, 1) // 35.2027 × 100 (matches board convention)
    expect(s.mdd).toBeCloseTo(69.08, 1) // 0.6908 × 100
    expect(s.winRate).toBeCloseTo(51.56, 1) // 0.5156 × 100
    expect(s.winPositions).toBe(33)
    expect(s.totalPositions).toBe(64)
    expect(s.pnl).toBeGreaterThan(100000) // real_pnl money, not scaled
  })

  it("does not take a zero-trade period's carried-over drawdown as the period drawdown", () => {
    const withIndicators = (over: Record<string, unknown>) => {
      const base = payload as { indicators: { data: Record<string, unknown> } }
      return {
        ...base,
        indicators: { ...base.indicators, data: { ...base.indicators.data, ...over } },
      }
    }
    const idle = parseBlofinProfile(withIndicators({ trades: 0, winning_trades: 0 }), ctx).stats[0]
    expect(idle.mdd).toBeNull()
    expect(idle.extras.carried_mdd).toBeCloseTo(69.08, 1)

    const idleZero = parseBlofinProfile(
      withIndicators({ trades: 0, winning_trades: 0, max_drawdown: '0' }),
      ctx
    ).stats[0]
    expect(idleZero.mdd).toBe(0)
    expect(idleZero.extras.carried_mdd).toBeUndefined()

    // A period with trades keeps its drawdown (asserted above: 69.08).
    expect(parseBlofinProfile(payload, ctx).stats[0].extras.carried_mdd).toBeUndefined()
  })

  it('maps per-symbol performance into trading preferences', () => {
    const s = parseBlofinProfile(payload, ctx).stats[0]
    const prefs = s.tradingPreferences as { assets?: Array<Record<string, unknown>> } | null
    expect(prefs?.assets?.length).toBe(3)
    expect(prefs?.assets?.[0].asset).toBe('BTC-USDT')
    expect(prefs?.assets?.[0].trades).toBe(49)
  })

  it('builds roi + pnl chart series from the performance endpoint', () => {
    const r = parseBlofinProfile(payload, ctx)
    const roi = r.series.find((x) => x.metric === 'roi')
    const pnl = r.series.find((x) => x.metric === 'pnl')
    expect(roi && roi.points.length).toBeGreaterThan(5)
    expect(pnl && pnl.points.length).toBeGreaterThan(5)
    // ascending by ts
    expect(roi!.points[0].ts < roi!.points[roi!.points.length - 1].ts).toBe(true)
  })

  it('surfaces identity (nickname/avatar) from info', () => {
    const r = parseBlofinProfile(payload, ctx)
    expect(r.nickname).toBe('ISHIRO')
    expect(typeof r.avatarUrlOrigin).toBe('string')
  })

  it('NULL-collapses gracefully when endpoints are null (dead-fetch)', () => {
    const r = parseBlofinProfile(
      { info: null, indicators: null, symbolPerf: null, performance: null, timeframe: 90 },
      ctx
    )
    expect(r.stats).toHaveLength(0)
    expect(r.series).toHaveLength(0)
    expect(r.nickname).toBeNull()
  })
})

/**
 * blofin_spot detail (public probe 2026-11-20 of
 * blofin.com/sapi/v1/spot_copy/trader/*, one trader, D7/D30/D90). The spot
 * stat/performance response is an object carrying the chart and the
 * per-symbol table; there is no separate symbol_performance response.
 */
describe('parseBlofinProfile (blofin_spot detail)', () => {
  const recorded = fx('profile-capture-spot-4187422152.json') as {
    responses: Record<string, unknown>
  }
  const spotCtx: ParseCtx = { ...ctx, sourceSlug: 'blofin_spot' }
  const composite = (timeframe: 7 | 30 | 90) => ({
    info: recorded.responses['trader/info|'],
    indicators: recorded.responses[`trader/stat/indicators|D${timeframe}`],
    symbolPerf: null,
    performance: recorded.responses[`trader/stat/performance|D${timeframe}`],
    timeframe,
  })

  it.each([
    [30, 35.29, 6, 17, 14.7976082140442, -15.8433806762582024],
    [90, 48.27, 14, 29, 27.566833876268518, -2.8714025503648557],
  ] as const)(
    '%sd block carries the period win rate, trade counts, drawdown and ROI',
    (timeframe, winRate, wins, trades, mdd, roi) => {
      const profile = parseBlofinProfile(composite(timeframe), spotCtx)
      expect(profile.stats).toHaveLength(1)
      const s = profile.stats[0]
      expect(s.timeframe).toBe(timeframe)
      expect(s.winRate).toBeCloseTo(winRate, 9)
      expect(s.winPositions).toBe(wins)
      expect(s.totalPositions).toBe(trades)
      expect(s.mdd).toBeCloseTo(mdd, 9)
      expect(s.roi).toBeCloseTo(roi, 9)
      expect(s.volume).toBeNull() // spot indicators carry no volume field
    }
  )

  it('keeps the win rate NULL for a period without trades', () => {
    const s = parseBlofinProfile(composite(7), spotCtx).stats[0]
    expect(s.totalPositions).toBe(0)
    expect(s.winRate).toBeNull()
    // 零成交周期的回撤是沿用值：置空，原值留痕。
    expect(s.mdd).toBeNull()
    expect(s.extras.carried_mdd).toBeCloseTo(0.1497742225083643, 9)
  })

  it('reads the per-symbol table and the cumulative ROI chart from stat/performance', () => {
    const profile = parseBlofinProfile(composite(30), spotCtx)
    const prefs = profile.stats[0].tradingPreferences as {
      assets?: Array<Record<string, unknown>>
    } | null
    expect(prefs?.assets?.length).toBeGreaterThan(0)
    expect(typeof prefs?.assets?.[0].asset).toBe('string')
    const roi = profile.series.find((x) => x.metric === 'roi')
    expect(roi?.points).toHaveLength(3)
    expect(roi!.points[0].ts < roi!.points[2].ts).toBe(true)
    // The spot `pnl` array is one bar per day, not a cumulative series.
    expect(profile.series.find((x) => x.metric === 'pnl')).toBeUndefined()
    expect(profile.nickname).toBe('Cryptoracle')
  })
})
