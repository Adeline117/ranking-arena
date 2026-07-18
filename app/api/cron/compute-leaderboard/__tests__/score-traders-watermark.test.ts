/**
 * @jest-environment node
 */

jest.mock('@/lib/utils/arena-score', () => ({
  calculateArenaScore: () => ({
    returnScore: 20,
    pnlScore: 20,
    drawdownScore: 20,
    stabilityScore: 20,
  }),
  computeArenaScoresV4: () => [
    {
      totalScore: 80,
      factors: {
        pnl: 0.8,
        roi: 0.8,
        drawdown: 0.8,
        sharpe: 0.8,
        consistency: 0.8,
      },
    },
  ],
}))

jest.mock('../scoring-helpers', () => ({
  markOutliers: () => 0,
  applyArenaFollowers: async () => ({ applied: 0, uniqueAccounts: 1 }),
}))

jest.mock('../helpers', () => ({
  detectTraderType: () => 'human',
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

import { scoreTraders } from '../score-traders'
import type { TraderRow } from '../trader-row'

function trader(): TraderRow {
  return {
    source: 'source',
    source_trader_id: 'trader',
    roi: 10,
    pnl: 100,
    win_rate: 60,
    max_drawdown: 10,
    trades_count: 10,
    followers: null,
    copiers: null,
    arena_score: null,
    captured_at: '2026-07-17T10:00:00.000Z',
    source_board_as_of: '2026-07-18T11:00:00.000Z',
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

describe('scoreTraders source freshness provenance', () => {
  it('persists the independent board watermark rather than row observation time', async () => {
    const result = await scoreTraders([trader()], new Map(), new Set(), '30D', {} as never)

    expect(result.scored[0].source_as_of).toBe('2026-07-18T11:00:00.000Z')
    expect(result.scored[0].source_as_of).not.toBe('2026-07-17T10:00:00.000Z')
  })
})
