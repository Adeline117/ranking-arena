/**
 * @jest-environment node
 */

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

import { buildChangedTraders, fetchCurrentScoreMap, type CurrentRow } from '../incremental-diff'
import type { ScoredTrader } from '../score-traders'

const FACTORS: NonNullable<ScoredTrader['score_factors']> = {
  roi: 0.81,
  pnl: 0.72,
  drawdown: 0.64,
  sharpe: 0.58,
  consistency: 0.67,
}

function makeScored(overrides: Partial<ScoredTrader> = {}): ScoredTrader {
  return {
    source: 'fixture_source',
    source_trader_id: 'trader-1',
    arena_score: 80,
    arena_score_v3: 76,
    arena_score_v4: 80,
    score_factors: { ...FACTORS },
    roi: 31.5,
    pnl: 125_000,
    win_rate: 68,
    max_drawdown: 14,
    followers: 1_200,
    copiers: 33,
    trades_count: 410,
    handle: 'Alpha',
    avatar_url: '/avatars/alpha.png',
    profitability_score: 75,
    risk_control_score: 68,
    execution_score: 63,
    score_completeness: 'full',
    trading_style: 'swing',
    avg_holding_hours: 18,
    style_confidence: 0.91,
    sharpe_ratio: 1.8,
    sortino_ratio: 2.1,
    profit_factor: 1.65,
    calmar_ratio: 1.4,
    trader_type: 'human',
    metrics_estimated: false,
    is_outlier: false,
    ...overrides,
  }
}

function makeCurrent(overrides: Partial<CurrentRow> = {}): CurrentRow {
  const trader = makeScored()
  return {
    source_type: 'futures',
    arena_score: trader.arena_score,
    arena_score_v3: trader.arena_score_v3,
    arena_score_v4: trader.arena_score_v4,
    score_factors: { ...FACTORS },
    rank: 1,
    roi: trader.roi,
    pnl: trader.pnl,
    win_rate: trader.win_rate,
    max_drawdown: trader.max_drawdown,
    followers: trader.followers,
    copiers: trader.copiers,
    trades_count: trader.trades_count,
    handle: trader.handle,
    avatar_url: trader.avatar_url,
    profitability_score: trader.profitability_score,
    risk_control_score: trader.risk_control_score,
    execution_score: trader.execution_score,
    score_completeness: trader.score_completeness,
    trading_style: trader.trading_style,
    avg_holding_hours: trader.avg_holding_hours,
    style_confidence: trader.style_confidence,
    sharpe_ratio: trader.sharpe_ratio,
    sortino_ratio: trader.sortino_ratio,
    profit_factor: trader.profit_factor,
    calmar_ratio: trader.calmar_ratio,
    trader_type: trader.trader_type,
    metrics_estimated: trader.metrics_estimated,
    is_outlier: trader.is_outlier === true,
    ...overrides,
  } as CurrentRow
}

function keyFor(trader: ScoredTrader): string {
  return `${trader.source}:${trader.source_trader_id}`
}

function diffOne(trader: ScoredTrader, current: CurrentRow = makeCurrent()) {
  return buildChangedTraders([trader], new Map([[keyFor(trader), current]]), '90D')
}

type NullableComparableField =
  | 'arena_score_v3'
  | 'arena_score_v4'
  | 'score_factors'
  | 'roi'
  | 'pnl'
  | 'win_rate'
  | 'max_drawdown'
  | 'followers'
  | 'copiers'
  | 'trades_count'
  | 'handle'
  | 'avatar_url'
  | 'profitability_score'
  | 'risk_control_score'
  | 'execution_score'
  | 'score_completeness'
  | 'trading_style'
  | 'avg_holding_hours'
  | 'style_confidence'
  | 'sharpe_ratio'
  | 'sortino_ratio'
  | 'profit_factor'
  | 'calmar_ratio'
  | 'trader_type'

const nullableFieldCases: ReadonlyArray<readonly [NullableComparableField, unknown]> = [
  ['arena_score_v3', 76],
  ['arena_score_v4', 80],
  ['score_factors', FACTORS],
  ['roi', 31.5],
  ['pnl', 125_000],
  ['win_rate', 68],
  ['max_drawdown', 14],
  ['followers', 1_200],
  ['copiers', 33],
  ['trades_count', 410],
  ['handle', 'Alpha'],
  ['avatar_url', '/avatars/alpha.png'],
  ['profitability_score', 75],
  ['risk_control_score', 68],
  ['execution_score', 63],
  ['score_completeness', 'full'],
  ['trading_style', 'swing'],
  ['avg_holding_hours', 18],
  ['style_confidence', 0.91],
  ['sharpe_ratio', 1.8],
  ['sortino_ratio', 2.1],
  ['profit_factor', 1.65],
  ['calmar_ratio', 1.4],
  ['trader_type', 'human'],
]

describe('compute-leaderboard incremental diff', () => {
  it('fetches and maps every persisted field used by the diff', async () => {
    const databaseRow = {
      source: 'fixture_source',
      source_trader_id: 'trader-1',
      ...makeCurrent(),
    }
    const range = jest.fn().mockResolvedValue({ data: [databaseRow], error: null })
    const eq = jest.fn(() => ({ range }))
    const select = jest.fn(() => ({ eq }))
    const from = jest.fn(() => ({ select }))

    const result = await fetchCurrentScoreMap({ from } as never, '90D', () => false)

    expect(from).toHaveBeenCalledWith('leaderboard_ranks')
    expect(eq).toHaveBeenCalledWith('season_id', '90D')
    expect(range).toHaveBeenCalledWith(0, 999)

    const selected = String(select.mock.calls[0]?.[0])
    const selectedColumns = selected.split(',').map((column) => column.trim())
    for (const field of [
      'source',
      'source_type',
      'source_trader_id',
      'arena_score',
      'arena_score_v3',
      'arena_score_v4',
      'score_factors',
      'rank',
      'roi',
      'pnl',
      'win_rate',
      'max_drawdown',
      'followers',
      'copiers',
      'trades_count',
      'handle',
      'avatar_url',
      'profitability_score',
      'risk_control_score',
      'execution_score',
      'score_completeness',
      'trading_style',
      'avg_holding_hours',
      'style_confidence',
      'sharpe_ratio',
      'sortino_ratio',
      'profit_factor',
      'calmar_ratio',
      'trader_type',
      'metrics_estimated',
      'is_outlier',
    ]) {
      expect(selectedColumns).toContain(field)
    }
    expect(selectedColumns).not.toContain('rank_change')
    expect(selectedColumns).not.toContain('is_new')

    expect(result.get('fixture_source:trader-1')).toEqual(makeCurrent())
  })

  it('skips a structurally identical row, including a separately allocated factor object', () => {
    const trader = makeScored()
    const current = makeCurrent({ score_factors: { ...FACTORS } })

    const result = diffOne(trader, current)

    expect(result.changedTraders).toEqual([])
    expect(result.rankMap).toEqual(new Map([[keyFor(trader), 1]]))
    expect(result.prevRankMap).toEqual(new Map([[keyFor(trader), 1]]))
  })

  it.each(nullableFieldCases)('%s value -> null is a write-worthy change', (field, value) => {
    const trader = { ...makeScored(), [field]: null } as ScoredTrader
    const current = { ...makeCurrent(), [field]: value } as CurrentRow

    expect(diffOne(trader, current).changedTraders).toEqual([trader])
  })

  it.each(nullableFieldCases)('%s null -> value is a write-worthy change', (field, value) => {
    const trader = { ...makeScored(), [field]: value } as ScoredTrader
    const current = { ...makeCurrent(), [field]: null } as CurrentRow

    expect(diffOne(trader, current).changedTraders).toEqual([trader])
  })

  it.each([
    ['metrics_estimated false -> true', { metrics_estimated: true }, { metrics_estimated: false }],
    ['metrics_estimated true -> false', { metrics_estimated: false }, { metrics_estimated: true }],
    ['metrics_estimated null -> false', { metrics_estimated: false }, { metrics_estimated: null }],
    ['is_outlier false -> true', { is_outlier: true }, { is_outlier: false }],
    ['is_outlier true -> false', { is_outlier: false }, { is_outlier: true }],
    ['source_type mismatch', {}, { source_type: 'spot' }],
  ])('%s is a write-worthy change', (_label, traderPatch, currentPatch) => {
    const trader = makeScored(traderPatch as Partial<ScoredTrader>)
    const current = makeCurrent(currentPatch as Partial<CurrentRow>)

    expect(diffOne(trader, current).changedTraders).toEqual([trader])
  })

  it('uses SOURCE_TYPE_MAP for known sources and futures only as the fallback', () => {
    const mappedTrader = makeScored({ source: 'hyperliquid' })

    expect(diffOne(mappedTrader, makeCurrent({ source_type: 'web3' })).changedTraders).toEqual([])
    expect(diffOne(mappedTrader, makeCurrent({ source_type: 'futures' })).changedTraders).toEqual([
      mappedTrader,
    ])

    const fallbackTrader = makeScored()
    expect(diffOne(fallbackTrader, makeCurrent({ source_type: 'futures' })).changedTraders).toEqual(
      []
    )
  })

  it('retains the 0.5% arena-score threshold while rank changes remain exact', () => {
    const trader = makeScored({ arena_score: 80 })

    expect(diffOne(trader, makeCurrent({ arena_score: 79.61 })).changedTraders).toEqual([])
    expect(diffOne(trader, makeCurrent({ arena_score: 79.59 })).changedTraders).toEqual([trader])
    expect(diffOne(trader, makeCurrent({ arena_score: 80, rank: 2 })).changedTraders).toEqual([
      trader,
    ])
    expect(
      diffOne(makeScored({ arena_score: 0 }), makeCurrent({ arena_score: 0 })).changedTraders
    ).toEqual([])
    expect(diffOne(trader, makeCurrent({ arena_score: 0 })).changedTraders).toEqual([trader])
  })

  it('marks absent rows changed and builds new-rank plus complete previous-rank maps', () => {
    const first = makeScored()
    const second = makeScored({ source_trader_id: 'trader-2', arena_score: 70 })
    const staleKey = 'fixture_source:stale-trader'
    const currentScoreMap = new Map<string, CurrentRow>([
      [keyFor(first), makeCurrent({ rank: 3 })],
      [staleKey, makeCurrent({ rank: 9 })],
    ])

    const result = buildChangedTraders([first, second], currentScoreMap, '90D')

    expect(result.changedTraders).toEqual([first, second])
    expect(result.rankMap).toEqual(
      new Map([
        [keyFor(first), 1],
        [keyFor(second), 2],
      ])
    )
    expect(result.prevRankMap).toEqual(
      new Map([
        [keyFor(first), 3],
        [staleKey, 9],
      ])
    )
  })
})
