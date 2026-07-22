/**
 * @jest-environment node
 */

const positiveScore = () => ({
  returnScore: 20,
  pnlScore: 20,
  drawdownScore: 20,
  stabilityScore: 20,
})
const mockCalculateArenaScore = jest.fn(positiveScore)
const mockComputeArenaScoresV4 = jest.fn((inputs: Array<{ pnl: number }>) =>
  inputs.map(() => ({
    totalScore: 80,
    factors: {
      pnl: 0.8,
      roi: 0.8,
      drawdown: 0.8,
      sharpe: 0.8,
      consistency: 0.8,
    },
  }))
)

jest.mock('@/lib/utils/arena-score', () => ({
  calculateArenaScore: (...args: unknown[]) => mockCalculateArenaScore(...args),
  computeArenaScoresV4: (inputs: Array<{ pnl: number }>) => mockComputeArenaScoresV4(inputs),
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

function trader(id: string, pnl: number | null, roi = 10): TraderRow {
  return {
    source: 'source',
    source_trader_id: id,
    roi,
    pnl,
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

describe('scoreTraders PnL eligibility boundary', () => {
  beforeEach(() => {
    mockCalculateArenaScore.mockReset()
    mockCalculateArenaScore.mockImplementation(positiveScore)
    mockComputeArenaScoresV4.mockClear()
  })

  it('keeps finite zero and losses while excluding ROI-only and malformed PnL before scoring', async () => {
    const candidates = [
      trader('roi-only', null),
      trader('nan', Number.NaN),
      trader('positive-infinity', Number.POSITIVE_INFINITY),
      trader('negative-infinity', Number.NEGATIVE_INFINITY),
      trader('runtime-string', '100' as never),
      trader('zero', 0),
      trader('loss', -100),
      trader('profit', 100),
    ]

    const result = await scoreTraders(candidates, new Map(), new Set(), '30D', {} as never)

    expect(mockCalculateArenaScore).toHaveBeenCalledTimes(3)
    expect(mockCalculateArenaScore.mock.calls.map(([input]) => input.pnl)).toEqual([0, -100, 100])
    expect(mockComputeArenaScoresV4).toHaveBeenCalledTimes(1)
    expect(mockComputeArenaScoresV4.mock.calls[0][0].map((input) => input.pnl)).toEqual([
      0, -100, 100,
    ])
    expect(result.scored.map((row) => row.source_trader_id)).toEqual(['zero', 'loss', 'profit'])
    expect(result.scoredFiltered.map((row) => row.source_trader_id)).toEqual([
      'zero',
      'loss',
      'profit',
    ])
  })

  it('keeps legitimate zero scores and negative ROI/PnL in the v4 ranking cohort', async () => {
    mockCalculateArenaScore.mockImplementation(() => ({
      returnScore: 0,
      pnlScore: 0,
      drawdownScore: 0,
      stabilityScore: 0,
    }))

    const result = await scoreTraders(
      [trader('zero-score', 0, 0), trader('loss-score', -100, -10)],
      new Map(),
      new Set(),
      '30D',
      {} as never
    )

    expect(mockCalculateArenaScore).toHaveBeenCalledTimes(2)
    expect(result.scored.map((row) => row.arena_score_v3)).toEqual([0, 0])
    expect(mockComputeArenaScoresV4.mock.calls[0][0].map((input) => input.pnl)).toEqual([0, -100])
    expect(result.scoredFiltered.map((row) => row.source_trader_id)).toEqual([
      'zero-score',
      'loss-score',
    ])
  })
})
