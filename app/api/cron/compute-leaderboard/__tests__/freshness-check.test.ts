/**
 * @jest-environment node
 */

jest.mock('@/lib/constants/exchanges', () => ({
  SOURCES_WITH_DATA: ['loaded', 'missing_fresh', 'missing_stale', 'missing_unknown'],
}))

import { checkPlatformFreshness } from '../freshness-check'
import type { TraderRow } from '../trader-row'

function trader(
  source: string,
  capturedAt: string,
  id = 'trader',
  sourceBoardAsOf = capturedAt
): TraderRow {
  return {
    source,
    source_trader_id: id,
    roi: 10,
    pnl: 100,
    win_rate: null,
    max_drawdown: null,
    trades_count: 10,
    followers: null,
    copiers: null,
    arena_score: null,
    captured_at: capturedAt,
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

function watermarkQuery(result: {
  data: Array<{ source: string; source_as_of: string }> | null
  error: { message: string } | null
}) {
  const eq = jest.fn().mockResolvedValue(result)
  const select = jest.fn(() => ({ eq }))
  return { select, eq }
}

describe('compute leaderboard freshness gate', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-18T12:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('uses current board watermarks plus persisted per-window source watermarks', async () => {
    const query = watermarkQuery({
      data: [
        { source: 'missing_fresh', source_as_of: '2026-07-18T11:00:00.000Z' },
        { source: 'missing_stale', source_as_of: '2026-07-16T08:00:00.000Z' },
      ],
      error: null,
    })
    const from = jest.fn(() => ({ select: query.select }))
    const traderMap = new Map([['loaded:one', trader('loaded', '2026-07-18T10:00:00.000Z', 'one')]])

    await expect(checkPlatformFreshness({ from } as never, traderMap, '30D')).resolves.toEqual({
      freshPlatforms: ['loaded'],
      stalePlatforms: ['missing_stale', 'missing_unknown'],
      queryFailedPlatforms: ['missing_fresh'],
    })

    expect(from).toHaveBeenCalledTimes(1)
    expect(from).toHaveBeenCalledWith('leaderboard_source_freshness')
    expect(query.select).toHaveBeenCalledWith('source,source_as_of')
    expect(query.eq).toHaveBeenCalledWith('season_id', '30D')
  })

  it('treats a stale row observation with a fresh source board as fresh', async () => {
    const query = watermarkQuery({ data: [], error: null })
    const from = jest.fn(() => ({ select: query.select }))
    const traderMap = new Map([
      [
        'loaded:one',
        trader('loaded', '2026-07-15T11:00:00.000Z', 'one', '2026-07-18T11:00:00.000Z'),
      ],
    ])

    const result = await checkPlatformFreshness({ from } as never, traderMap, '7D')

    expect(result.freshPlatforms).toContain('loaded')
    expect(result.stalePlatforms).not.toContain('loaded')
  })

  it('treats a fresh row observation with a stale source board as stale', async () => {
    const query = watermarkQuery({ data: [], error: null })
    const from = jest.fn(() => ({ select: query.select }))
    const traderMap = new Map([
      [
        'loaded:one',
        trader('loaded', '2026-07-18T11:00:00.000Z', 'one', '2026-07-15T11:00:00.000Z'),
      ],
    ])

    const result = await checkPlatformFreshness({ from } as never, traderMap, '7D')

    expect(result.stalePlatforms).toContain('loaded')
    expect(result.freshPlatforms).not.toContain('loaded')
  })

  it('uses the oldest watermark when a loaded source contains mixed boards', async () => {
    const query = watermarkQuery({ data: [], error: null })
    const from = jest.fn(() => ({ select: query.select }))
    const traderMap = new Map([
      [
        'loaded:new',
        trader('loaded', '2026-07-18T11:00:00.000Z', 'new', '2026-07-18T11:00:00.000Z'),
      ],
      [
        'loaded:old',
        trader('loaded', '2026-07-18T11:00:00.000Z', 'old', '2026-07-15T11:00:00.000Z'),
      ],
    ])

    const result = await checkPlatformFreshness({ from } as never, traderMap, '7D')

    expect(result.stalePlatforms).toContain('loaded')
    expect(result.freshPlatforms).not.toContain('loaded')
  })

  it.each([
    ['invalid', 'not-a-timestamp'],
    ['far-future', '2026-07-18T12:10:00.000Z'],
  ])('treats a loaded source with an %s board watermark as stale', async (_case, boardAsOf) => {
    const query = watermarkQuery({ data: [], error: null })
    const from = jest.fn(() => ({ select: query.select }))
    const traderMap = new Map([
      ['loaded:one', trader('loaded', '2026-07-18T11:00:00.000Z', 'one', boardAsOf)],
    ])

    const result = await checkPlatformFreshness({ from } as never, traderMap, '7D')

    expect(result.stalePlatforms).toContain('loaded')
    expect(result.freshPlatforms).not.toContain('loaded')
  })

  it('classifies missing sources as query failures when provenance cannot be read', async () => {
    const query = watermarkQuery({
      data: null,
      error: { message: 'relation unavailable' },
    })
    const from = jest.fn(() => ({ select: query.select }))

    const result = await checkPlatformFreshness({ from } as never, new Map(), '90D')

    expect(result.queryFailedPlatforms).toEqual([
      'loaded',
      'missing_fresh',
      'missing_stale',
      'missing_unknown',
    ])
    expect(result.stalePlatforms).toEqual([])
  })
})
