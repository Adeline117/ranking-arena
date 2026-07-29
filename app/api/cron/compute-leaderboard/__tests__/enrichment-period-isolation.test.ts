/**
 * @jest-environment node
 */

import { deriveAdvancedFromEquityCurve, deriveWrMddFromEquityCurve } from '../enrich-equity-curve'
import { enrichFromStatsDetail } from '../enrich-stats-detail'
import type { TraderRow } from '../trader-row'

interface QueryRecord {
  table: string
  equalities: Array<[string, unknown]>
  lowerBounds: Array<[string, unknown]>
  upperBounds: Array<[string, unknown]>
}

interface FakeBuilder {
  select: jest.Mock<FakeBuilder, [string]>
  eq: jest.Mock<FakeBuilder, [string, unknown]>
  in: jest.Mock<FakeBuilder, [string, readonly unknown[]]>
  gte: jest.Mock<FakeBuilder, [string, unknown]>
  lte: jest.Mock<FakeBuilder, [string, unknown]>
  order: jest.Mock<FakeBuilder, [string, Record<string, unknown>]>
  limit: jest.Mock<Promise<{ data: Array<Record<string, unknown>> }>, [number]>
}

function filteringClient(rowsByTable: Readonly<Record<string, Array<Record<string, unknown>>>>) {
  const queries: QueryRecord[] = []
  const from = jest.fn((table: string) => {
    const equalities: Array<[string, unknown]> = []
    const memberships: Array<[string, readonly unknown[]]> = []
    const lowerBounds: Array<[string, unknown]> = []
    const upperBounds: Array<[string, unknown]> = []
    const builder = {} as FakeBuilder
    builder.select = jest.fn(() => builder)
    builder.eq = jest.fn((column, value) => {
      equalities.push([column, value])
      return builder
    })
    builder.in = jest.fn((column, values) => {
      memberships.push([column, values])
      return builder
    })
    builder.gte = jest.fn((column, value) => {
      lowerBounds.push([column, value])
      return builder
    })
    builder.lte = jest.fn((column, value) => {
      upperBounds.push([column, value])
      return builder
    })
    builder.order = jest.fn(() => builder)
    builder.limit = jest.fn(async () => ({
      data: (rowsByTable[table] ?? []).filter(
        (row) =>
          equalities.every(([column, value]) => row[column] === value) &&
          memberships.every(([column, values]) => values.includes(row[column])) &&
          lowerBounds.every(([column, value]) => String(row[column]) >= String(value)) &&
          upperBounds.every(([column, value]) => String(row[column]) <= String(value))
      ),
    }))
    queries.push({ table, equalities, lowerBounds, upperBounds })
    return builder
  })

  return { client: { from } as never, queries }
}

function trader(): TraderRow {
  return {
    source: 'exchange',
    source_trader_id: 'trader-1',
    roi: 20,
    pnl: 100,
    win_rate: null,
    max_drawdown: null,
    trades_count: null,
    followers: null,
    copiers: null,
    arena_score: null,
    captured_at: '2026-07-29T00:00:00.000Z',
    source_board_as_of: '2026-07-29T00:00:00.000Z',
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

function traderMap(row: TraderRow): Map<string, TraderRow> {
  return new Map([[`${row.source}:${row.source_trader_id}`, row]])
}

describe('leaderboard enrichment period isolation', () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-29T12:00:00.000Z'))
  })

  afterAll(() => {
    jest.useRealTimers()
  })

  it('does not fill current-season stats from another period', async () => {
    const row = trader()
    const { client, queries } = filteringClient({
      trader_stats_detail: [
        {
          source: 'exchange',
          source_trader_id: 'trader-1',
          period: '90D',
          captured_at: '2026-07-29T11:00:00.000Z',
          profitable_trades_pct: 99,
          max_drawdown: 1,
          sharpe_ratio: 10,
          total_trades: 500,
        },
      ],
    })

    await enrichFromStatsDetail(client, traderMap(row), '7D', () => false)

    expect(queries[0].equalities).toContainEqual(['period', '7D'])
    expect(row).toEqual(
      expect.objectContaining({
        win_rate: null,
        max_drawdown: null,
        sharpe_ratio: null,
        trades_count: null,
      })
    )
  })

  it('does not derive win rate or drawdown from another period curve', async () => {
    const row = trader()
    const { client, queries } = filteringClient({
      trader_equity_curve: [
        {
          source: 'exchange',
          source_trader_id: 'trader-1',
          period: '90D',
          captured_at: '2026-07-29T11:00:00.000Z',
          data_date: '2026-07-28',
          pnl_usd: 100,
          roi_pct: 10,
        },
        {
          source: 'exchange',
          source_trader_id: 'trader-1',
          period: '90D',
          captured_at: '2026-07-29T11:00:00.000Z',
          data_date: '2026-07-29',
          pnl_usd: 200,
          roi_pct: 5,
        },
      ],
    })

    await deriveWrMddFromEquityCurve(client, traderMap(row), '7D', () => false)

    expect(queries[0].equalities).toContainEqual(['period', '7D'])
    expect(row.win_rate).toBeNull()
    expect(row.max_drawdown).toBeNull()
  })

  it('does not derive advanced metrics or trade counts from another period curve', async () => {
    const row = trader()
    const crossPeriodCurve = Array.from({ length: 8 }, (_, index) => ({
      source: 'exchange',
      source_trader_id: 'trader-1',
      period: '90D',
      captured_at: '2026-07-29T11:00:00.000Z',
      data_date: `2026-07-${String(20 + index).padStart(2, '0')}`,
      pnl_usd: index % 2 === 0 ? index * 100 : index * 50,
      roi_pct: index % 2 === 0 ? index * 2 : index,
    }))
    const { client, queries } = filteringClient({ trader_equity_curve: crossPeriodCurve })

    await deriveAdvancedFromEquityCurve(client, traderMap(row), '7D', () => false)

    expect(queries[0].equalities).toContainEqual(['period', '7D'])
    expect(row).toEqual(
      expect.objectContaining({
        trades_count: null,
        sharpe_ratio: null,
        sortino_ratio: null,
        profit_factor: null,
      })
    )
  })

  it('does not fill current rankings from stale same-period enrichment', async () => {
    const statsRow = trader()
    const staleStats = filteringClient({
      trader_stats_detail: [
        {
          source: 'exchange',
          source_trader_id: 'trader-1',
          period: '7D',
          captured_at: '2026-07-26T11:59:59.999Z',
          profitable_trades_pct: 99,
          max_drawdown: 1,
          sharpe_ratio: 10,
          total_trades: 500,
        },
      ],
    })

    await enrichFromStatsDetail(staleStats.client, traderMap(statsRow), '7D', () => false)

    expect(staleStats.queries[0].lowerBounds).toContainEqual([
      'captured_at',
      '2026-07-27T12:00:00.000Z',
    ])
    expect(statsRow.win_rate).toBeNull()
    expect(statsRow.max_drawdown).toBeNull()

    const equityRow = trader()
    const staleCurve = filteringClient({
      trader_equity_curve: [
        {
          source: 'exchange',
          source_trader_id: 'trader-1',
          period: '7D',
          captured_at: '2026-07-26T11:59:59.999Z',
          data_date: '2026-07-28',
          pnl_usd: 100,
          roi_pct: 10,
        },
        {
          source: 'exchange',
          source_trader_id: 'trader-1',
          period: '7D',
          captured_at: '2026-07-26T11:59:59.999Z',
          data_date: '2026-07-29',
          pnl_usd: 200,
          roi_pct: 5,
        },
      ],
    })

    await deriveWrMddFromEquityCurve(staleCurve.client, traderMap(equityRow), '7D', () => false)

    expect(staleCurve.queries[0].lowerBounds).toContainEqual([
      'captured_at',
      '2026-07-27T12:00:00.000Z',
    ])
    expect(staleCurve.queries[0].upperBounds).toContainEqual([
      'captured_at',
      '2026-07-29T12:05:00.000Z',
    ])
    expect(equityRow.win_rate).toBeNull()
    expect(equityRow.max_drawdown).toBeNull()
  })
})
