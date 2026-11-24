/**
 * While the database still applies the four-metric row policy and the scoring
 * worker still publishes with 'four_metrics', every served row is labelled
 * 'full'. In that state the relaxed reader must behave exactly like the reader
 * it replaces: same verdict for every row, same sanitized payload.
 *
 * `previousVerdict` is the rule the reader applied before the relaxation,
 * written out independently of the current implementation.
 */
import {
  hasConcretePublicRankingMetrics,
  isPublicRankingRowEligible,
  isPublicRankingSourceAllowed,
  PUBLIC_RANKING_CACHE_EPOCH,
  sanitizePublicRankingPayload,
} from '../publication-policy'

const NOW_MS = Date.parse('2026-11-22T12:00:00.000Z')
const COMPUTED_AT = '2026-11-22T11:00:00.000Z'

type Row = Record<string, unknown>

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** The metric basis the reader required before the relaxation. */
function previousMetricBasis(row: Row): boolean {
  return (
    typeof row.source === 'string' &&
    isPublicRankingSourceAllowed(row.source) &&
    typeof row.source_trader_id === 'string' &&
    row.source_trader_id.length > 0 &&
    row.source_trader_id === row.source_trader_id.trim() &&
    row.score_completeness === 'full' &&
    row.metrics_estimated === false &&
    row.is_outlier !== true &&
    finite(row.roi) &&
    finite(row.pnl) &&
    finite(row.win_rate) &&
    row.win_rate >= 0 &&
    row.win_rate <= 100 &&
    finite(row.max_drawdown) &&
    row.max_drawdown >= 0 &&
    row.max_drawdown < 100
  )
}

function previousVerdict(row: Row): boolean {
  return (
    previousMetricBasis(row) &&
    finite(row.arena_score) &&
    row.arena_score > 0 &&
    row.arena_score <= 100 &&
    row.season_id === '90D' &&
    row.computed_at === COMPUTED_AT
  )
}

function fullRow(index: number, overrides: Row = {}): Row {
  return {
    source: ['binance_futures', 'bybit', 'hyperliquid', 'gateio'][index % 4],
    source_trader_id: `trader-${index}`,
    season_id: '90D',
    rank: index + 1,
    arena_score: 100 - index * 0.37,
    roi: 250 - index * 3.1,
    pnl: 90_000 - index * 1_111,
    win_rate: (index * 7) % 101,
    max_drawdown: (index * 3.3) % 99.99,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: COMPUTED_AT,
    ...overrides,
  }
}

/** What the four-metric database policy serves: complete, in-range rows. */
const servedRows: Row[] = [
  ...Array.from({ length: 120 }, (_, index) => fullRow(index)),
  // Boundary values that are valid observations.
  fullRow(200, { win_rate: 0, max_drawdown: 0 }),
  fullRow(201, { win_rate: 100, max_drawdown: 99.99 }),
  fullRow(202, { roi: -73.5, pnl: -12_000, arena_score: 0.4 }),
  fullRow(203, { roi: 0, pnl: 0, arena_score: 2.2 }),
  fullRow(204, { arena_score: 100 }),
  fullRow(205, { is_outlier: null }),
]

/** Rows labelled 'full' that the previous reader refused. */
const refusedFullRows: Row[] = [
  fullRow(300, { win_rate: null }),
  fullRow(301, { max_drawdown: null }),
  fullRow(302, { win_rate: null, max_drawdown: null }),
  fullRow(303, { win_rate: 100.01 }),
  fullRow(304, { win_rate: -0.01 }),
  fullRow(305, { win_rate: Number.NaN }),
  fullRow(306, { win_rate: '55' }),
  fullRow(307, { max_drawdown: 100 }),
  fullRow(308, { max_drawdown: -1 }),
  fullRow(309, { max_drawdown: Number.POSITIVE_INFINITY }),
  fullRow(310, { roi: null }),
  fullRow(311, { pnl: null }),
  fullRow(312, { metrics_estimated: true }),
  fullRow(313, { metrics_estimated: null }),
  fullRow(314, { is_outlier: true }),
  fullRow(315, { arena_score: 0 }),
  fullRow(316, { arena_score: 100.01 }),
  fullRow(317, { arena_score: null }),
  fullRow(318, { source: 'okx_web3_solana' }),
  fullRow(319, { source_trader_id: ' padded' }),
  fullRow(320, { source_trader_id: '' }),
  fullRow(321, { computed_at: '2026-11-20T11:59:59.000Z' }),
  fullRow(322, { season_id: '30D' }),
]

describe('relaxed reader on full-only data (database and worker still on the old rule)', () => {
  it('the fixture is what it claims to be', () => {
    expect(servedRows.every(previousVerdict)).toBe(true)
    expect(refusedFullRows.some(previousVerdict)).toBe(false)
    expect(servedRows.length).toBeGreaterThan(100)
  })

  it.each([...servedRows, ...refusedFullRows].map((row) => [row.source_trader_id, row] as const))(
    'gives the previous verdict for full row %p',
    (_id, row) => {
      expect(isPublicRankingRowEligible(row, { nowMs: NOW_MS, expectedPeriod: '90D' })).toBe(
        previousVerdict(row)
      )
      expect(hasConcretePublicRankingMetrics(row)).toBe(previousMetricBasis(row))
    }
  )

  it('returns a page of served rows untouched: same object, same rows, same totals', () => {
    const payload = {
      period: '90D',
      traders: servedRows,
      availableSources: ['binance_futures', 'bybit', 'hyperliquid', 'gateio'],
      total: 3_412,
      totalCount: 3_412,
      hasMore: true,
      next_cursor: 'cursor-1',
    }
    const sanitized = sanitizePublicRankingPayload(payload, { nowMs: NOW_MS })
    // Nothing to remove: the payload is passed through by identity.
    expect(sanitized).toBe(payload)
    expect(sanitized.traders).toEqual(servedRows)
    expect(sanitized).not.toHaveProperty('ranking_visibility')
  })

  it('removes from a mixed page exactly the rows the previous reader removed', () => {
    const mixed = [...servedRows.slice(0, 20), ...refusedFullRows, ...servedRows.slice(20, 40)]
    const sanitized = sanitizePublicRankingPayload(
      { period: '90D', traders: mixed, totalCount: 5_000, hasMore: true },
      { nowMs: NOW_MS, expectedPeriod: '90D' }
    )
    expect(sanitized.traders).toEqual(mixed.filter(previousVerdict))
    expect(sanitized).toEqual(
      expect.objectContaining({
        totalCount: 40,
        hasMore: false,
        ranking_visibility: 'partial',
      })
    )
  })

  it('differs from the previous reader only on rows the old database never serves', () => {
    // Not 'full': these exist only after migration 20261122201611 AND a worker
    // publishing with roi_pnl.
    const afterLaunchOnly = [
      fullRow(400, {
        arena_score: 12.5,
        roi: 4,
        pnl: 300,
        win_rate: null,
        score_completeness: 'partial',
      }),
      fullRow(401, {
        arena_score: 12.5,
        roi: 4,
        pnl: 300,
        max_drawdown: null,
        score_completeness: 'partial',
      }),
      fullRow(402, {
        arena_score: 12.5,
        roi: 4,
        pnl: 300,
        win_rate: null,
        max_drawdown: null,
        score_completeness: 'minimal',
      }),
    ]
    for (const row of afterLaunchOnly) {
      expect(previousVerdict(row)).toBe(false)
      expect(isPublicRankingRowEligible(row, { nowMs: NOW_MS, expectedPeriod: '90D' })).toBe(true)
    }
  })

  it('keeps the cache epoch, so a redeploy of the website changes no cache key', () => {
    expect(PUBLIC_RANKING_CACHE_EPOCH).toBe('public-rank-policy-v7')
  })
})
