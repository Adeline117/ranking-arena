import { toUiTrader } from '../toUiTrader'
import { TradersListRowSchema } from '@/lib/contracts/core-api'
import type { InitialTrader } from '@/lib/getInitialTraders'

/**
 * The same published row, as the SSR first paint (InitialTrader) and as the
 * client refresh (/api/traders JSON) carry it. Both must map to the identical
 * UI row — otherwise badges/metrics flip on the first silent refresh.
 */
const ssrRow: InitialTrader = {
  id: 'trader-1',
  handle: 'Alpha',
  rank: 3,
  roi: 120.5,
  pnl: 50_000,
  win_rate: 99,
  max_drawdown: 12,
  followers: 0,
  source: 'hyperliquid',
  source_type: 'web3',
  avatar_url: null,
  avatar_url_mirror: null,
  arena_score: 88.2,
  sharpe: 2.1,
  trades_count: 40,
  // getInitialTraders derives this from score_completeness ('full').
  score_confidence: 'full',
  rank_change: 2,
  is_new: false,
  copiers: 17,
  sharpe_ratio: 2.1,
  sortino_ratio: 3.4,
  calmar_ratio: 1.2,
  profit_factor: 1.8,
  profitability_score: 30,
  risk_control_score: 20,
  execution_score: 10,
  trading_style: 'swing',
  avg_holding_hours: 30,
  trader_type: 'suspected_bot',
  is_verified: true,
  is_verified_data: false,
  source_trader_id: 'trader-1',
  season_id: '90D',
  score_completeness: 'full',
  metrics_estimated: false,
  computed_at: '2026-11-12T00:00:00.000Z',
  is_outlier: false,
}

const apiRow = {
  id: 'trader-1',
  handle: 'Alpha',
  roi: 120.5,
  pnl: 50_000,
  win_rate: 99,
  max_drawdown: 12,
  trades_count: 40,
  followers: 0,
  copiers: 17,
  source: 'hyperliquid',
  source_type: 'web3',
  avatar_url: null,
  avatar_url_mirror: null,
  arena_score: 88.2,
  rank: 3,
  rank_change: 2,
  is_new: false,
  profitability_score: 30,
  risk_control_score: 20,
  execution_score: 10,
  score_completeness: 'full',
  trading_style: 'swing',
  avg_holding_hours: 30,
  style_confidence: null,
  sharpe_ratio: 2.1,
  sortino_ratio: 3.4,
  profit_factor: 1.8,
  calmar_ratio: 1.2,
  is_bot: true,
  trader_type: 'suspected_bot',
  is_outlier: false,
  computed_at: '2026-11-12T00:00:00.000Z',
  anti_gaming_flags: ['implausible_win_rate'],
  is_verified: true,
  is_verified_data: false,
}

describe('toUiTrader — SSR and client rows map identically', () => {
  it('the /api/traders fixture satisfies the core-api row contract', () => {
    expect(TradersListRowSchema.safeParse(apiRow).success).toBe(true)
  })

  it('produces the same UI row from both shapes', () => {
    expect(toUiTrader(ssrRow)).toEqual(toUiTrader(apiRow))
  })

  it('keeps every trust/ranking signal both paths used to drop', () => {
    const ui = toUiTrader(apiRow)
    expect(ui).toMatchObject({
      rank_change: 2,
      is_new: false,
      copiers: 17,
      is_verified_data: false,
      anti_gaming_flags: ['implausible_win_rate'],
      sharpe_ratio: 2.1,
      sortino_ratio: 3.4,
      trader_type: 'suspected_bot',
      is_bot: true,
      trading_style: 'swing',
      avg_holding_hours: 30,
      profitability_score: 30,
    })
  })

  it('keeps score confidence and the claimed badge across the SSR -> client refresh', () => {
    const ssr = toUiTrader(ssrRow)
    const client = toUiTrader(apiRow)
    expect(ssr.score_confidence).toBe('full')
    expect(client.score_confidence).toBe('full')
    expect(ssr.is_verified).toBe(true)
    expect(client.is_verified).toBe(true)
  })

  it('reads the SSR `sharpe` alias when `sharpe_ratio` is absent (old cache payload)', () => {
    const { sharpe_ratio: _drop, ...legacy } = ssrRow
    expect(toUiTrader(legacy).sharpe_ratio).toBe(2.1)
  })

  it('keeps unknown metrics null rather than synthesizing zero', () => {
    const ui = toUiTrader({ id: 'x', source: 'binance_futures', rank: 1, roi: null })
    expect(ui.roi).toBeNull()
    expect(ui.copiers).toBeNull()
    expect(ui.sharpe_ratio).toBeNull()
    expect(ui.anti_gaming_flags).toEqual([])
    expect(ui.is_bot).toBe(false)
  })

  it('rejects a non-positive / non-integer rank as unpublished', () => {
    expect(toUiTrader({ id: 'x', rank: 0 }).rank).toBeNull()
    expect(toUiTrader({ id: 'x', rank: 1.5 }).rank).toBeNull()
  })
})
