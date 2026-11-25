/**
 * Fixed samples for computeArenaScoresV4WithOptions, the entry the rank
 * publication scorer calls (lib/rankings/publication/score-traders.ts).
 *
 * The signed golden vectors (arena-score-v4-postgres-parity,
 * arena-score-v5-zero-metrics-golden.json) cover computeArenaScoresV4 and
 * computeArenaScoresV5 only, i.e. the historical semantics. These samples pin
 * the publication semantics value by value: only null is missing, and a
 * missing drawdown / consistency scores 0 with its weight kept. They are plain
 * assertions, not a signed manifest; a change to the formula has to change
 * them on purpose.
 */
import {
  computeArenaScoresV4,
  computeArenaScoresV4WithOptions,
  type ArenaScoreV4Result,
  type TraderScoreInputV4,
} from '../arena-score'

const row = (overrides: Partial<TraderScoreInputV4>): TraderScoreInputV4 => ({
  roi: 0,
  pnl: 0,
  maxDrawdown: null,
  winRate: null,
  sharpeRatio: null,
  profitFactor: null,
  tradesCount: null,
  source: 'bybit',
  ...overrides,
})

// prettier-ignore
const COHORT: Array<[label: string, input: TraderScoreInputV4]> = [
  ['complete, with Sharpe',        row({ roi: 180.5, pnl: 520_000, maxDrawdown: 12.5, winRate: 71.2, sharpeRatio: 2.4, tradesCount: 140 })],
  ['complete',                     row({ roi: 95, pnl: 18_000, maxDrawdown: 18, winRate: 63, tradesCount: 90 })],
  ['drawdown exactly 0',           row({ roi: 40.2, pnl: 6_100, maxDrawdown: 0, winRate: 55.5, tradesCount: 60 })],
  ['win rate exactly 0',           row({ roi: 22, pnl: 2_500, maxDrawdown: 30, winRate: 0, tradesCount: 45 })],
  ['no win rate',                  row({ roi: 75, pnl: 15_000, maxDrawdown: 20, winRate: null, tradesCount: 80 })],
  ['no drawdown, trades unknown',  row({ roi: 60, pnl: 9_000, maxDrawdown: null, winRate: 58 })],
  ['top earner, ROI and PnL only', row({ roi: 310, pnl: 1_200_000 })],
  ['Sharpe only',                  row({ roi: 3, pnl: 400, sharpeRatio: 0.7, tradesCount: 12 })],
  ['loss, complete',               row({ roi: -8, pnl: -900, maxDrawdown: 28, winRate: 45, tradesCount: 30 })],
  ['worst loss, complete',         row({ roi: -55, pnl: -40_000, maxDrawdown: 71, winRate: 22 })],
  ['small loss, ROI and PnL only', row({ roi: -3, pnl: -20 })],
  ['true-zero trades source',      row({ roi: 5, pnl: 0, maxDrawdown: 4, winRate: 100, tradesCount: 0, source: 'hyperliquid' })],
]

const result = (
  totalScore: number,
  quality: number,
  confidence: number,
  roi: number,
  pnl: number,
  drawdown: number | null,
  sharpe: number | null,
  consistency: number | null
): ArenaScoreV4Result => ({
  totalScore,
  quality,
  confidence,
  factors: { roi, pnl, drawdown, sharpe, consistency },
})

// What the publication scorer computes ('roi_pnl').
const PUBLICATION: ArenaScoreV4Result[] = [
  result(100, 0.81, 0.88, 0.91, 0.68, 0.71, 1, 0.86),
  result(82.03, 0.55, 0.8, 0.82, 0.31, 0.57, null, 0.71),
  result(73.8, 0.51, 0.77, 0.55, 0.2, 1, null, 0.43),
  result(31.31, 0.19, 0.75, 0.45, 0.1, 0.14, null, 0),
  result(62.54, 0.4, 0.7, 0.73, 0.29, 0.43, null, null),
  result(38.36, 0.32, 0.49, 0.64, 0.24, null, null, 0.57),
  result(55.56, 0.54, 0.49, 1, 0.77, null, null, null),
  result(14.06, 0.05, 0.59, 0.27, 0, null, 0, null),
  result(23, 0.13, 0.72, 0.09, 0, 0.29, null, 0.29),
  result(0.37, 0.02, 0.49, 0, 0, 0, null, 0.14),
  result(7.29, 0.05, 0.49, 0.18, 0, null, null, null),
  result(46.98, 0.43, 0.49, 0.36, 0, 0.86, null, 1),
]

// The historical semantics for the same cohort ('four_metrics' rollback).
const LEGACY: ArenaScoreV4Result[] = [
  result(100, 0.84, 0.88, 0.91, 0.68, 0.83, 1, 0.83),
  result(82.13, 0.57, 0.8, 0.82, 0.31, 0.67, null, 0.67),
  result(53.88, 0.34, 0.68, 0.55, 0.2, null, null, 0.33),
  result(31.44, 0.22, 0.67, 0.45, 0.1, 0.17, null, null),
  result(64.44, 0.48, 0.7, 0.73, 0.29, 0.5, null, null),
  result(40.08, 0.41, 0.49, 0.64, 0.24, null, null, 0.5),
  result(74.44, 0.86, 0.49, 1, 0.77, null, null, null),
  result(14.59, 0.08, 0.59, 0.27, 0, null, 0, null),
  result(22.81, 0.13, 0.72, 0.09, 0, 0.33, null, 0.17),
  result(0, 0, 0.49, 0, 0, 0, null, 0),
  result(7.81, 0.07, 0.49, 0.18, 0, null, null, null),
  result(47.46, 0.47, 0.49, 0.36, 0, 1, null, 1),
]

const inputs = COHORT.map(([, input]) => input)
const publication = computeArenaScoresV4WithOptions(inputs, '30D', {
  zeroRiskMetricsAreKnown: true,
  missingRiskPolicy: 'zero',
})

describe('computeArenaScoresV4WithOptions fixed samples (publication semantics)', () => {
  it.each(COHORT.map(([label], index) => [label, index] as const))('%s', (_label, index) => {
    expect(publication[index]).toEqual(PUBLICATION[index])
  })

  it('is deterministic and independent of input order', () => {
    const reversed = computeArenaScoresV4WithOptions([...inputs].reverse(), '30D', {
      zeroRiskMetricsAreKnown: true,
      missingRiskPolicy: 'zero',
    }).reverse()
    expect(reversed).toEqual(PUBLICATION)
  })

  it('reads the two zeros as observations', () => {
    // Drawdown 0 is the best drawdown of the cohort; win rate 0 the worst win rate.
    expect(publication[2].factors.drawdown).toBe(1)
    expect(publication[3].factors.consistency).toBe(0)
  })

  it('caps a row with ROI and PnL only at (0.3 * pnl + 0.2 * roi) / 0.8', () => {
    // Top ROI percentile (1) and PnL factor ln(1200) / ln(10000) = 0.7698.
    const expected = (0.3 * (Math.log(1_200) / Math.log(10_000)) + 0.2 * 1) / 0.8
    expect(publication[6].quality).toBe(Math.round(expected * 100) / 100)
    // The historical rule divided by 0.5 instead and scored the same row 0.86.
    expect(LEGACY[6].quality).toBe(0.86)
  })
})

describe('the same cohort under the historical semantics', () => {
  const legacy = computeArenaScoresV4WithOptions(inputs, '30D', {
    zeroRiskMetricsAreKnown: false,
    missingRiskPolicy: 'renormalize',
  })

  it.each(COHORT.map(([label], index) => [label, index] as const))('%s', (_label, index) => {
    expect(legacy[index]).toEqual(LEGACY[index])
  })

  it('is exactly computeArenaScoresV4, the contract the signed golden vectors cover', () => {
    expect(legacy).toEqual(computeArenaScoresV4(inputs, '30D'))
  })

  it('differs from the publication semantics exactly where a risk metric is 0 or missing', () => {
    const changed = COHORT.map(([label], index) => [label, index] as const)
      .filter(([, index]) => publication[index].quality !== legacy[index].quality)
      .map(([label]) => label)
    expect(changed).toEqual([
      // percentiles of the complete rows move because two zeros joined the cohort
      'complete, with Sharpe',
      'complete',
      'drawdown exactly 0',
      'win rate exactly 0',
      'no win rate',
      'no drawdown, trades unknown',
      'top earner, ROI and PnL only',
      'Sharpe only',
      'worst loss, complete',
      'small loss, ROI and PnL only',
      'true-zero trades source',
    ])
  })
})
