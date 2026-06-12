/**
 * Arena Score v2 feature extraction — fixtures are REAL rows sampled from
 * prod arena.trader_stats.extras / arena.traders.meta (2026-06-12), so the
 * normalizer is tested against actual scraped shapes, not idealized ones.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { extractFeatureVector, fetchFeatureVectors } from '../arena-score-v2-features'

// ── Real prod fixtures ──────────────────────────────────────────────

const BITGET_CFD_EXTRAS = {
  largest_loss: 0,
  style_labels: ['低频', '多元专家', '*不活跃'],
  largest_profit: 0,
  settled_in_days: 546,
  trade_frequency: 0,
  copier_count_max: 0,
  long_short_ratio: null,
  copier_count_current: 89,
}

const GATE_FUTURES_EXTRAS = {
  pl_ratio: 1.25,
  lead_size: 417.57,
  average_loss: -67.43,
  leading_days: 171,
  style_labels: ['long-line', 'high-frequence', 'radical'],
  last_trade_at: '2026-06-11T21:33:55.000Z',
  roi_net_value: -100,
  average_profit: 84.5,
  trading_frequency: 1.57,
  copier_count_total: 0,
  last_liquidation_at: '2026-03-10T02:30:12.000Z',
}

const BITMART_EXTRAS = {
  nav: 1.067071471,
  start_at: '2026-06-08T01:01:44.000Z',
  rank_rings: {
    roi_point: 35.568864,
    max_drawdown_point: 93.27748,
    trades_per_day_point: 0.566824,
    profit_loss_ratio_point: 100,
    top3_volume_share_point: 100,
  },
  master_since: '2026-06-08T01:01:44.000Z',
  total_equity: 475.90888468,
  leverage_limit: 5,
  trades_per_day: 1.4,
  unrealized_pnl: 12.38696096,
  min_copy_amount: 10,
  run_time_seconds: 355831,
  top_volume_share: 100,
  profit_loss_ratio: 10000,
  realized_profit_sharing: 0,
}

const MEXC_EXTRAS = {
  total_pnl: 349651.01,
  style_tags: [
    { code: 'HIGH_PRESSURE', content: 'High Stress Tolerance' },
    { code: 'MID_LEVERAGE', content: 'Balanced' },
    { code: 'SHORT_TERM', content: 'Short-Term Holding' },
  ],
  settled_days: 1270,
  ability_rating: 'SS',
  ability_scores: {
    profit: 1,
    win_rate: 0.8433,
    win_times: 0.7391,
    max_winning_times: 0.9391,
    single_max_profit: 0.9998,
  },
  copier_count_history: 1338,
  profit_and_loss_ratio: '2.6:1',
  trade_frequency_per_week: 13,
}

const HTX_EXTRAS = {
  style_tags: ['Short-term', 'Momentum', 'Prudent'],
  max_copier_slots: 100,
  copier_count_history: 4,
  trade_frequency_per_week: 0.72,
  lead_since: '2025-12-28T03:15:25.965Z',
}

const BINANCE_SPOT_EXTRAS = {
  win_days: 2,
  days_trading: 4,
  copier_count_max: 300,
  copier_count_total: 0,
  margin_balance: 2574.84687908,
}

describe('extractFeatureVector — real prod shapes', () => {
  it('bitget_cfd: labels + copier slots + settled days', () => {
    const fv = extractFeatureVector({
      source: 'bitget_cfd',
      timeframe: 90,
      extras: BITGET_CFD_EXTRAS,
    })
    expect(fv.style_labels).toEqual(['低频', '多元专家', '*不活跃'])
    expect(fv.settled_in_days).toBe(546)
    expect(fv.copier_count_current).toBe(89)
    expect(fv.copier_count_max).toBe(0)
    expect(fv.trade_frequency_per_week).toBe(0)
    expect(fv.long_short_ratio).toBeNull() // explicit null in prod row
    expect(fv.radar_percentiles).toBeNull()
    expect(fv.kol).toBe(false)
    expect(fv.coverage).toBe(5)
  })

  it('gate_futures: last_liquidation_at survives as ISO (spec §12.3 risk signal)', () => {
    const fv = extractFeatureVector({
      source: 'gate_futures',
      timeframe: 90,
      extras: GATE_FUTURES_EXTRAS,
    })
    expect(fv.last_liquidation_at).toBe('2026-03-10T02:30:12.000Z')
    expect(fv.style_labels).toEqual(['long-line', 'high-frequence', 'radical'])
    expect(fv.settled_in_days).toBe(171) // leading_days alias
    expect(fv.trade_frequency_per_week).toBe(1.57) // trading_frequency alias
    expect(fv.nav).toBeNull() // roi_net_value is NOT nav
  })

  it('bitmart: nav + rank_rings → 0-100 radar, trades_per_day → per-week', () => {
    const fv = extractFeatureVector({
      source: 'bitmart_futures',
      timeframe: 90,
      extras: BITMART_EXTRAS,
    })
    expect(fv.nav).toBeCloseTo(1.067071471)
    expect(fv.radar_percentiles).toEqual({
      roi: 35.568864,
      max_drawdown: 93.27748,
      trades_per_day: 0.566824,
      profit_loss_ratio: 100,
      top3_volume_share: 100,
    })
    expect(fv.trade_frequency_per_week).toBeCloseTo(1.4 * 7)
  })

  it('mexc: {code,content} style tags + 0-1 ability scores → 0-100', () => {
    const fv = extractFeatureVector({ source: 'mexc_futures', timeframe: 90, extras: MEXC_EXTRAS })
    expect(fv.style_labels).toEqual(['High Stress Tolerance', 'Balanced', 'Short-Term Holding'])
    expect(fv.radar_percentiles).toEqual({
      profit: 100,
      win_rate: 84.33,
      win_times: 73.91,
      max_winning_times: 93.91,
      single_max_profit: 99.98,
    })
    expect(fv.settled_in_days).toBe(1270)
    expect(fv.trade_frequency_per_week).toBe(13)
  })

  it('htx: plain-string style_tags + max_copier_slots alias', () => {
    const fv = extractFeatureVector({ source: 'htx_futures', timeframe: 90, extras: HTX_EXTRAS })
    expect(fv.style_labels).toEqual(['Short-term', 'Momentum', 'Prudent'])
    expect(fv.copier_count_max).toBe(100)
    expect(fv.trade_frequency_per_week).toBe(0.72)
  })

  it('binance_spot: days_trading + copier_count_max aliases', () => {
    const fv = extractFeatureVector({
      source: 'binance_spot',
      timeframe: 7,
      extras: BINANCE_SPOT_EXTRAS,
    })
    expect(fv.settled_in_days).toBe(4)
    expect(fv.copier_count_max).toBe(300)
  })

  it('binance_web3_bsc meta: kol flag', () => {
    const fv = extractFeatureVector({
      source: 'binance_web3_bsc',
      extras: {},
      meta: { binance_web3_kol: true },
    })
    expect(fv.kol).toBe(true)
    expect(fv.coverage).toBe(1)
  })

  it('okx_web3_solana meta: wallet categories', () => {
    const fv = extractFeatureVector({
      source: 'okx_web3_solana',
      extras: {},
      meta: { okx_web3_labels: ['dev'] },
    })
    expect(fv.wallet_categories).toEqual(['dev'])
    expect(fv.kol).toBe(false)
  })

  it('bingx-style risk rating clamps to 1-10 and rounds', () => {
    expect(
      extractFeatureVector({ source: 'bingx_futures', extras: { risk_rating: 7 } }).risk_rating
    ).toBe(7)
    expect(
      extractFeatureVector({ source: 'bingx_futures', extras: { risk_rating: 0 } }).risk_rating
    ).toBe(1)
    expect(
      extractFeatureVector({ source: 'bingx_futures', extras: { risk_rating: 14.6 } }).risk_rating
    ).toBe(10)
  })
})

describe('extractFeatureVector — hostile/missing input', () => {
  it('handles null/undefined extras and meta', () => {
    const fv = extractFeatureVector({ source: 'whatever', extras: null, meta: undefined })
    expect(fv.style_labels).toEqual([])
    expect(fv.radar_percentiles).toBeNull()
    expect(fv.coverage).toBe(0)
  })

  it('rejects junk values instead of NaN-poisoning the vector', () => {
    const fv = extractFeatureVector({
      source: 'junk',
      extras: {
        style_labels: [42, '', null, { code: 'X' }, '  ok  '],
        settled_in_days: 'not-a-number',
        copier_count_current: -5,
        nav: -1,
        long_short_ratio: 'NaN',
        last_liquidation_at: 'yesterday-ish',
        trades_per_day: -2,
      },
    })
    expect(fv.style_labels).toEqual(['ok'])
    expect(fv.settled_in_days).toBeNull()
    expect(fv.copier_count_current).toBeNull()
    expect(fv.nav).toBeNull()
    expect(fv.long_short_ratio).toBeNull()
    expect(fv.last_liquidation_at).toBeNull()
    expect(fv.trade_frequency_per_week).toBeNull()
  })

  it('dedupes labels case-insensitively across both lists and caps at 12', () => {
    const many = Array.from({ length: 20 }, (_, i) => `tag-${i}`)
    const fv = extractFeatureVector({
      source: 'x',
      extras: { style_labels: ['Radical', ...many], style_tags: ['radical'] },
    })
    expect(fv.style_labels).toHaveLength(12)
    expect(fv.style_labels[0]).toBe('Radical')
    expect(fv.style_labels.filter((l) => l.toLowerCase() === 'radical')).toHaveLength(1)
  })

  it('numeric strings coerce (scraped JSON often stringifies numbers)', () => {
    const fv = extractFeatureVector({
      source: 'x',
      extras: { settled_in_days: '546', nav: '1.05', copier_count_current: '89' },
    })
    expect(fv.settled_in_days).toBe(546)
    expect(fv.nav).toBeCloseTo(1.05)
    expect(fv.copier_count_current).toBe(89)
  })
})

describe('fetchFeatureVectors (arena_score_features RPC mapper)', () => {
  function rpcClient(data: unknown, error: unknown = null): SupabaseClient {
    return { rpc: jest.fn().mockResolvedValue({ data, error }) } as unknown as SupabaseClient
  }

  it('maps byTimeframe rows into per-tf vectors with shared meta', async () => {
    const client = rpcClient({
      source: 'gate_futures',
      exchangeTraderId: 'abc',
      meta: { binance_web3_kol: true },
      byTimeframe: {
        '90': { asOf: '2026-06-11T00:00:00Z', extras: GATE_FUTURES_EXTRAS },
        '7': { asOf: '2026-06-11T00:00:00Z', extras: {} },
      },
    })
    const out = await fetchFeatureVectors(client, 'gate_futures', 'abc')
    expect(Object.keys(out).sort()).toEqual(['7', '90'])
    expect(out[90].last_liquidation_at).toBe('2026-03-10T02:30:12.000Z')
    expect(out[90].kol).toBe(true) // traders.meta applies to every timeframe
    expect(out[7].coverage).toBe(1) // kol only
    expect(client.rpc).toHaveBeenCalledWith('arena_score_features', {
      p_source: 'gate_futures',
      p_trader: 'abc',
    })
  })

  it('returns {} on RPC error or empty payload (e.g. missing grant)', async () => {
    expect(await fetchFeatureVectors(rpcClient(null, { message: 'denied' }), 's', 't')).toEqual({})
    expect(await fetchFeatureVectors(rpcClient(null), 's', 't')).toEqual({})
  })
})
