/**
 * @jest-environment node
 */

import { mapArenaScoreRowToTraderRow } from '../arena-score-row-mapper'
import {
  SourcePublicationBundleReaderError,
  readSourcePublicationBundle,
  type SourcePublicationBundleReaderErrorCode,
} from '../read-source-publication-bundle'
import { SourcePublicationEvidenceError } from '../source-publication-evidence'

const NOW = new Date('2026-07-22T00:00:00.000Z')

function scoreRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: 'alpha',
    market_type: 'futures',
    trader_key: 'trader-1',
    board_rank: 1,
    roi_pct: 12.5,
    pnl_usd: 250,
    win_rate: 60,
    max_drawdown: 8,
    copiers: 4,
    trades_count: 20,
    sharpe_ratio: 1.2,
    sortino_ratio: 1.4,
    calmar_ratio: 1.1,
    volatility_pct: 15,
    trader_kind: null,
    handle: 'Alpha',
    avatar_url: null,
    currency: 'USDT',
    as_of: '2026-07-21T22:30:00.000Z',
    board_as_of: '2026-07-21T23:00:00.000Z',
    ...overrides,
  }
}

function physicalBoard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    registry_slug: 'alpha-futures',
    filter_source: 'alpha',
    window: '30D',
    snapshot_id: 101,
    scraped_at: '2026-07-21T23:00:00.000Z',
    actual_count: 1,
    entry_count: 1,
    evidence_status: 'passed',
    latest_attempt_id: 101,
    latest_attempt_scraped_at: '2026-07-21T23:00:00.000Z',
    latest_attempt_passed: true,
    ...overrides,
  }
}

function bundle(
  scoreRows: Record<string, unknown>[] = [scoreRow()],
  physicalBoards: Record<string, unknown>[] = [physicalBoard()]
) {
  return { scoreRows, physicalBoards }
}

function supabaseReturning(data: unknown, error: unknown = null) {
  return {
    rpc: jest.fn().mockResolvedValue({ data, error }),
  }
}

async function captureReaderError(
  operation: Promise<unknown>,
  code: SourcePublicationBundleReaderErrorCode
): Promise<SourcePublicationBundleReaderError> {
  try {
    await operation
  } catch (error) {
    expect(error).toBeInstanceOf(SourcePublicationBundleReaderError)
    expect((error as SourcePublicationBundleReaderError).code).toBe(code)
    return error as SourcePublicationBundleReaderError
  }
  throw new Error(`expected SourcePublicationBundleReaderError(${code})`)
}

describe('readSourcePublicationBundle', () => {
  it('projects only fresh rows and preserves shared aliases plus explicit empty boards', async () => {
    const rawBundle = bundle(
      [
        scoreRow({
          platform: 'shared',
          trader_key: 'shared-trader',
          board_as_of: '2026-07-21T22:00:00.123456Z',
        }),
        scoreRow({
          platform: 'retained',
          trader_key: 'old-trader',
          board_as_of: '2026-07-19T00:00:00.000Z',
        }),
      ],
      [
        physicalBoard({
          registry_slug: 'shared-z',
          filter_source: 'shared',
          snapshot_id: 202,
          latest_attempt_id: 202,
        }),
        physicalBoard({
          registry_slug: 'shared-a',
          filter_source: 'shared',
          snapshot_id: 201,
          scraped_at: '2026-07-21T22:00:00.123456Z',
          latest_attempt_id: 201,
          latest_attempt_scraped_at: '2026-07-21T22:00:00.123456Z',
        }),
        physicalBoard({
          registry_slug: 'empty-board',
          filter_source: 'empty',
          snapshot_id: 301,
          actual_count: 0,
          entry_count: 0,
          latest_attempt_id: 301,
        }),
        physicalBoard({
          registry_slug: 'retained-board',
          filter_source: 'retained',
          snapshot_id: 401,
          scraped_at: '2026-07-19T00:00:00.000Z',
          evidence_status: 'stale',
          latest_attempt_id: 401,
          latest_attempt_scraped_at: '2026-07-19T00:00:00.000Z',
        }),
      ]
    )
    const supabase = supabaseReturning(rawBundle)

    const result = await readSourcePublicationBundle(supabase as never, '30D', { now: NOW })

    expect(supabase.rpc).toHaveBeenCalledWith('arena_score_inputs_publish_bundle_json', {
      p_window: '30D',
      p_per_platform_limit: 1000,
      p_max_age_hours: 48,
    })
    expect(result.evidence.scoreRows).toHaveLength(2)
    expect(result.evidence.freshScoreRows.map((row) => row.platform)).toEqual(['shared'])
    expect(result.evidence.retainedAliases.map((alias) => alias.source)).toEqual(['retained'])
    expect(result.evidence.freshAliases).toEqual([
      expect.objectContaining({ source: 'empty', explicit_empty: true }),
      expect.objectContaining({
        source: 'shared',
        registry_slugs: ['shared-a', 'shared-z'],
        source_as_of: '2026-07-21T22:00:00.123456Z',
      }),
    ])
    expect(result.freshRowCounts).toEqual(
      new Map([
        ['empty', 0],
        ['shared', 1],
      ])
    )
    expect(result.traderRows).toEqual([
      expect.objectContaining({
        source: 'shared',
        source_trader_id: 'shared-trader',
        roi: 12.5,
        captured_at: '2026-07-21T22:30:00.000Z',
        source_board_as_of: '2026-07-21T22:00:00.123456Z',
      }),
    ])
  })

  it('fails closed on RPC errors and null data before projection', async () => {
    for (const [data, error, code] of [
      [null, { message: 'function unavailable', code: 'PGRST202' }, 'rpc_error'],
      [null, null, 'rpc_null'],
    ] as const) {
      const mapScoreRow = jest.fn(mapArenaScoreRowToTraderRow)
      await captureReaderError(
        readSourcePublicationBundle(
          supabaseReturning(data, error) as never,
          '30D',
          { now: NOW },
          { mapScoreRow }
        ),
        code
      )
      expect(mapScoreRow).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['top-level array', []],
    ['non-array scoreRows', { scoreRows: {}, physicalBoards: [physicalBoard()] }],
    ['non-array physicalBoards', { scoreRows: [], physicalBoards: {} }],
  ])('rejects an invalid bundle with %s before projection', async (_label, data) => {
    const mapScoreRow = jest.fn(mapArenaScoreRowToTraderRow)

    await expect(
      readSourcePublicationBundle(
        supabaseReturning(data) as never,
        '30D',
        { now: NOW },
        { mapScoreRow }
      )
    ).rejects.toMatchObject<Partial<SourcePublicationEvidenceError>>({
      code: 'invalid_bundle',
    })
    expect(mapScoreRow).not.toHaveBeenCalled()
  })

  it.each([
    ['numeric string', '12.5'],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
  ])('rejects %s metrics before projection', async (_label, roiPct) => {
    const mapScoreRow = jest.fn(mapArenaScoreRowToTraderRow)

    await expect(
      readSourcePublicationBundle(
        supabaseReturning(
          bundle(
            [scoreRow(), scoreRow({ trader_key: 'invalid-trader', roi_pct: roiPct })],
            [physicalBoard({ actual_count: 2, entry_count: 2 })]
          )
        ) as never,
        '30D',
        { now: NOW },
        { mapScoreRow }
      )
    ).rejects.toMatchObject<Partial<SourcePublicationEvidenceError>>({
      code: 'invalid_bundle',
    })
    expect(mapScoreRow).not.toHaveBeenCalled()
  })

  it('aborts and fails closed when the RPC exceeds its deadline', async () => {
    jest.useFakeTimers()
    let capturedSignal: AbortSignal | undefined
    const abortSignal = jest.fn((signal: AbortSignal) => {
      capturedSignal = signal
      return new Promise<never>(() => {})
    })
    const supabase = { rpc: jest.fn(() => ({ abortSignal })) }
    const mapScoreRow = jest.fn(mapArenaScoreRowToTraderRow)

    try {
      const readPromise = readSourcePublicationBundle(
        supabase as never,
        '30D',
        { now: NOW, timeoutMs: 25 },
        { mapScoreRow }
      )
      const rejection = captureReaderError(readPromise, 'rpc_timeout')

      await jest.advanceTimersByTimeAsync(25)
      await rejection

      expect(abortSignal).toHaveBeenCalledTimes(1)
      expect(capturedSignal?.aborted).toBe(true)
      expect(mapScoreRow).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it('enforces the deadline even when the RPC query has no abortSignal method', async () => {
    jest.useFakeTimers()
    const supabase = { rpc: jest.fn(() => new Promise<never>(() => {})) }
    const mapScoreRow = jest.fn(mapArenaScoreRowToTraderRow)

    try {
      const readPromise = readSourcePublicationBundle(
        supabase as never,
        '30D',
        { now: NOW, timeoutMs: 25 },
        { mapScoreRow }
      )
      const rejection = captureReaderError(readPromise, 'rpc_timeout')

      await jest.advanceTimersByTimeAsync(25)
      await rejection

      expect(mapScoreRow).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })
})
