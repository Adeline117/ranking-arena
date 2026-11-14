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

jest.mock('@/lib/rankings/publication/scoring-helpers', () => ({
  markOutliers: () => 0,
  applyArenaFollowers: async () => ({ applied: 0, uniqueAccounts: 1 }),
}))

jest.mock('@/lib/rankings/publication/helpers', () => ({
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

function trader(
  id: string,
  pnl: number | null,
  roi: number | null = 10,
  source = 'binance_futures'
): TraderRow {
  return {
    source,
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

describe('scoreTraders ROI and PnL eligibility boundary', () => {
  beforeEach(() => {
    mockCalculateArenaScore.mockReset()
    mockCalculateArenaScore.mockImplementation(positiveScore)
    mockComputeArenaScoresV4.mockClear()
  })

  it('keeps finite zero/loss metrics while excluding malformed ROI or PnL before scoring', async () => {
    const candidates = [
      trader('roi-only', null),
      trader('pnl-nan', Number.NaN),
      trader('pnl-positive-infinity', Number.POSITIVE_INFINITY),
      trader('pnl-negative-infinity', Number.NEGATIVE_INFINITY),
      trader('pnl-runtime-string', '100' as never),
      trader('pnl-only', 100, null),
      trader('roi-nan', 100, Number.NaN),
      trader('roi-positive-infinity', 100, Number.POSITIVE_INFINITY),
      trader('roi-negative-infinity', 100, Number.NEGATIVE_INFINITY),
      trader('roi-runtime-string', 100, '10' as never),
      trader('zero', 0, 0),
      trader('loss', -100, -10),
      trader('profit', 100),
    ]

    const result = await scoreTraders(candidates, new Map(), new Set(), '30D', {} as never)

    expect(mockCalculateArenaScore).toHaveBeenCalledTimes(3)
    expect(mockCalculateArenaScore.mock.calls.map(([input]) => input.pnl)).toEqual([0, -100, 100])
    expect(mockCalculateArenaScore.mock.calls.map(([input]) => input.roi)).toEqual([0, -10, 10])
    expect(mockComputeArenaScoresV4).toHaveBeenCalledTimes(1)
    expect(mockComputeArenaScoresV4.mock.calls[0][0].map((input) => input.pnl)).toEqual([
      0, -100, 100,
    ])
    expect(result.scored.map((row) => row.source_trader_id)).toEqual(['zero', 'loss', 'profit'])
    expect(result.scored.map((row) => row.roi)).toEqual([0, -10, 10])
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

  it.each([
    ['7D', 2_000, 2_000.01],
    ['30D', 5_000, 5_000.01],
    ['90D', 9_999.99, 10_000],
  ] as const)(
    'applies the %s ROI publication boundary before either score cohort',
    async (season, eligibleRoi, ineligibleRoi) => {
      const result = await scoreTraders(
        [trader('eligible', 100, eligibleRoi), trader('ineligible', 100, ineligibleRoi)],
        new Map(),
        new Set(),
        season,
        {} as never
      )

      expect(mockCalculateArenaScore).toHaveBeenCalledTimes(1)
      expect(mockCalculateArenaScore.mock.calls[0][0].roi).toBe(eligibleRoi)
      expect(mockComputeArenaScoresV4.mock.calls[0][0]).toHaveLength(1)
      expect(result.scored.map((row) => row.source_trader_id)).toEqual(['eligible'])
      expect(result.scoredFiltered.map((row) => row.source_trader_id)).toEqual(['eligible'])
    }
  )

  it('applies CEX and reviewed DEX whale PnL bounds before either score cohort', async () => {
    const candidates = [
      trader('cex-lower-bound', -10_000_000),
      trader('cex-upper-bound', 100_000_000),
      trader('cex-too-low', -10_000_001),
      trader('cex-too-high', 100_000_001),
      trader('hyperliquid-bound', 1_000_000_000, 10, 'hyperliquid'),
      trader('hyperliquid-too-high', 1_000_000_001, 10, 'hyperliquid'),
      trader('gmx-whale', 500_000_000, 10, 'gmx'),
      trader('dydx-whale', 500_000_000, 10, 'dydx'),
      trader('drift-whale', 500_000_000, 10, 'drift'),
      trader('unreviewed-dex-whale', 500_000_000, 10, 'jupiter_perps'),
    ]

    const result = await scoreTraders(candidates, new Map(), new Set(), '30D', {} as never)
    const coreEligibleIds = [
      'cex-lower-bound',
      'cex-upper-bound',
      'hyperliquid-bound',
      'gmx-whale',
      'dydx-whale',
      'drift-whale',
    ]
    // dYdX remains a reviewed numeric whale envelope for historical/direct
    // input safety, but the retired source policy correctly keeps it off the
    // current public percentile cohort.
    const publicIds = coreEligibleIds.filter((id) => id !== 'dydx-whale')

    expect(mockCalculateArenaScore).toHaveBeenCalledTimes(coreEligibleIds.length)
    expect(mockComputeArenaScoresV4.mock.calls[0][0]).toHaveLength(publicIds.length)
    expect(result.scored.map((row) => row.source_trader_id)).toEqual(coreEligibleIds)
    expect(result.scoredFiltered.map((row) => row.source_trader_id)).toEqual(publicIds)
  })

  it('turns malformed risk metrics into partial evidence instead of coercing them', async () => {
    const validZero = trader('valid-zero', 0, 0)
    validZero.win_rate = 0
    validZero.max_drawdown = 0
    const validDecimal = trader('valid-decimal', 100)
    validDecimal.win_rate = 0.6
    validDecimal.max_drawdown = 99.9
    const validPercent = trader('valid-percent', 100)
    validPercent.win_rate = 60
    const validHundred = trader('valid-hundred', 100)
    validHundred.win_rate = 100

    const invalidWinRates = ['60', Number.NaN, Number.POSITIVE_INFINITY, -1, 101].map(
      (winRate, index) => {
        const row = trader(`invalid-win-${index}`, 100)
        row.win_rate = winRate as never
        return row
      }
    )
    const invalidDrawdowns = [
      '10',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      100,
    ].map((drawdown, index) => {
      const row = trader(`invalid-drawdown-${index}`, 100)
      row.max_drawdown = drawdown as never
      return row
    })
    const candidates = [
      validZero,
      validDecimal,
      validPercent,
      validHundred,
      ...invalidWinRates,
      ...invalidDrawdowns,
    ]

    const result = await scoreTraders(candidates, new Map(), new Set(), '30D', {} as never)
    const legacyScoreInputs = mockCalculateArenaScore.mock.calls.map(([input]) => input)

    expect(legacyScoreInputs.slice(0, 4).map((input) => input.winRate)).toEqual([0, 0.6, 60, 100])
    expect(
      legacyScoreInputs
        .slice(4, 4 + invalidWinRates.length)
        .every((input) => input.winRate === null)
    ).toBe(true)
    expect(
      legacyScoreInputs
        .slice(4 + invalidWinRates.length)
        .every((input) => input.maxDrawdown === null)
    ).toBe(true)
    expect(
      result.scored
        .filter((row) => row.source_trader_id.startsWith('invalid-'))
        .every((row) => row.score_completeness === 'partial')
    ).toBe(true)
    expect(mockComputeArenaScoresV4.mock.calls[0][0]).toHaveLength(4)
    expect(result.scoredFiltered.map((row) => row.source_trader_id)).toEqual([
      'valid-zero',
      'valid-decimal',
      'valid-percent',
      'valid-hundred',
    ])
  })

  it('nulls malformed optional percentile inputs before they can poison the cohort', async () => {
    const malformed = trader('malformed-optional', 100)
    malformed.sharpe_ratio = Number.NaN
    malformed.profit_factor = Number.POSITIVE_INFINITY
    malformed.trades_count = Number.POSITIVE_INFINITY
    const valid = trader('valid-optional', 100)
    valid.sharpe_ratio = 2
    valid.profit_factor = 3
    valid.trades_count = 20

    const result = await scoreTraders([malformed, valid], new Map(), new Set(), '30D', {} as never)
    const v4Inputs = mockComputeArenaScoresV4.mock.calls[0][0] as Array<{
      sharpeRatio: number | null
      profitFactor: number | null
      tradesCount: number | null
    }>

    expect(v4Inputs).toEqual([
      expect.objectContaining({ sharpeRatio: null, profitFactor: null, tradesCount: null }),
      expect.objectContaining({ sharpeRatio: 2, profitFactor: 3, tradesCount: 20 }),
    ])
    expect(result.scoredFiltered).toHaveLength(2)
    expect(result.scoredFiltered.every((row) => Number.isFinite(row.arena_score))).toBe(true)
  })

  it('keeps partial and estimated rows out of both percentile influence and publication', async () => {
    const partial = trader('partial', 100)
    partial.max_drawdown = null
    const estimated = trader('estimated', 100)
    estimated.metrics_estimated = true
    const full = trader('full', 100)

    const result = await scoreTraders(
      [partial, estimated, full],
      new Map(),
      new Set(),
      '30D',
      {} as never
    )

    expect(mockComputeArenaScoresV4.mock.calls[0][0]).toHaveLength(1)
    expect(result.scored).toHaveLength(3)
    expect(result.scoredFiltered.map((row) => row.source_trader_id)).toEqual(['full'])
  })
})
