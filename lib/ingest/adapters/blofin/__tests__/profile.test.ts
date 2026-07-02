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
