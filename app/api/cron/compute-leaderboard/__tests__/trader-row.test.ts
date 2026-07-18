/**
 * @jest-environment node
 */

import { makeAddToTraderMap } from '../trader-row'
import type { TraderRow } from '../trader-row'

function trader(sourceBoardAsOf: string): TraderRow {
  return {
    source: 'source',
    source_trader_id: 'trader',
    roi: 10,
    pnl: 100,
    win_rate: null,
    max_drawdown: null,
    trades_count: 10,
    followers: null,
    copiers: null,
    arena_score: null,
    captured_at: '2026-07-18T11:30:00.000Z',
    source_board_as_of: sourceBoardAsOf,
    full_confidence_at: null,
    profitability_score: null,
    risk_control_score: null,
    execution_score: null,
    score_completeness: null,
    trading_style: null,
    avg_holding_hours: null,
    style_confidence: null,
    sharpe_ratio: null,
    sortino_ratio: null,
    profit_factor: null,
    calmar_ratio: null,
    trader_type: null,
    metrics_estimated: false,
  }
}

describe('TraderRow duplicate merge', () => {
  it('retains the oldest source board watermark', () => {
    const traderMap = new Map<string, TraderRow>()
    const addToTraderMap = makeAddToTraderMap(traderMap)

    addToTraderMap(trader('2026-07-18T11:00:00.000Z'))
    addToTraderMap(trader('2026-07-18T10:00:00.000Z'))
    addToTraderMap(trader('2026-07-18T11:30:00.000Z'))

    expect(traderMap.get('source:trader')?.source_board_as_of).toBe('2026-07-18T10:00:00.000Z')
  })

  it('does not let a valid duplicate hide an invalid board watermark', () => {
    const traderMap = new Map<string, TraderRow>()
    const addToTraderMap = makeAddToTraderMap(traderMap)

    addToTraderMap(trader('not-a-timestamp'))
    addToTraderMap(trader('2026-07-18T10:00:00.000Z'))

    expect(traderMap.get('source:trader')?.source_board_as_of).toBe('not-a-timestamp')
  })
})
