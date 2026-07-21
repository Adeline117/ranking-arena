import type { Job } from 'bullmq'
import type { SourceRow } from '@/lib/ingest/core/types'
import type { TierJobData } from '../../queues'

const mockDbQuery = jest.fn()
const mockGetSourceBySlug = jest.fn()
const mockGetLatestPassedNativeCohort = jest.fn()
const mockPublishLeaderboardSnapshot = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: () => ({ query: (...args: unknown[]) => mockDbQuery(...args) }),
}))
jest.mock('@/lib/ingest/sources', () => ({
  getSourceBySlug: (...args: unknown[]) => mockGetSourceBySlug(...args),
}))
jest.mock('@/lib/ingest/native-cohort', () => ({
  getLatestPassedNativeCohort: (...args: unknown[]) => mockGetLatestPassedNativeCohort(...args),
}))
jest.mock('@/lib/ingest/serving/publish', () => ({
  publishLeaderboardSnapshot: (...args: unknown[]) => mockPublishLeaderboardSnapshot(...args),
}))

import {
  DERIVED_COUNT_BASELINE_GENERATION,
  DERIVED_MIN_FRESH_COVERAGE_PCT,
  processDeriveBoards,
} from '../derive-boards'

const src = {
  id: 19,
  slug: 'mexc_futures',
  adapter_slug: 'mexc',
  status: 'active',
  currency: 'USDT',
  timeframes_native: [7],
  timeframes_derived: [30],
  deep_profile_topn: 300,
  meta: { derived_board_sort: 'roi' },
} as SourceRow

const job = {
  id: 'repeat:derive:mexc_futures:1784678400000',
  timestamp: 1_784_678_400_000,
  data: { sourceSlug: src.slug },
} as unknown as Job<TierJobData>

function cohortTraders(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    exchange_trader_id: `mexc-${index + 1}`,
    meta: null,
    headline_rois: { '7': 100 - index },
  }))
}

function statsRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    exchange_trader_id: `mexc-${index + 1}`,
    nickname: `Trader ${index + 1}`,
    avatar_url_origin: null,
    wallet_address: null,
    trader_kind: 'human' as const,
    bot_strategy: null,
    roi: String(1_000 - index),
    pnl: String(10_000 - index),
    win_rate: '55',
    as_of: '2026-07-21T23:00:00.000Z',
  }))
}

function arrangeCoverage(eligibleCount: number, freshCount: number): void {
  mockGetLatestPassedNativeCohort.mockResolvedValue({
    traders: cohortTraders(eligibleCount),
    nativeTimeframes: [7],
    foundTimeframes: [7],
    missingTimeframes: [],
  })
  mockDbQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM arena.trader_stats')) return { rows: statsRows(freshCount) }
    throw new Error(`unexpected SQL: ${sql}`)
  })
}

describe('derived-board deterministic eligibility and coverage gate', () => {
  let consoleError: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    mockGetSourceBySlug.mockResolvedValue(src)
    mockPublishLeaderboardSnapshot.mockResolvedValue({
      snapshotId: 44,
      verdict: { passed: true, baselineUsed: 300, deviationPct: 10 },
    })
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  it('publishes at the 90% boundary using the shared native top-N eligibility', async () => {
    arrangeCoverage(300, 270)

    await expect(processDeriveBoards(job)).resolves.toEqual([
      { timeframe: 30, actualCount: 270, passed: true, snapshotId: 44 },
    ])

    expect(mockGetLatestPassedNativeCohort).toHaveBeenCalledWith(src)

    const [statsSql, statsParams] = mockDbQuery.mock.calls[0]
    expect(String(statsSql)).toContain('t.id = ANY($2::bigint[])')
    expect(statsParams).toEqual([src.id, cohortTraders(300).map((row) => row.id), 30, 48])
    expect(statsParams[1]).not.toContain(9_999) // incidental Tier-C long tail is ineligible

    const publishInput = mockPublishLeaderboardSnapshot.mock.calls[0][0]
    expect(publishInput).toEqual(
      expect.objectContaining({
        src,
        timeframe: 30,
        isDerived: true,
        expectedCountOverride: 300,
        countBaselineGeneration: DERIVED_COUNT_BASELINE_GENERATION,
        observationCycleId: `derive:${src.slug}:${job.id}:${job.timestamp}`,
      })
    )
    expect(publishInput.rows).toHaveLength(270)
    expect(DERIVED_MIN_FRESH_COVERAGE_PCT).toBe(90)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('fails closed below the coverage threshold and keeps the last-good snapshot', async () => {
    arrangeCoverage(300, 269)

    await expect(processDeriveBoards(job)).resolves.toEqual([])

    expect(mockPublishLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        'P0 coverage gate mexc_futures 30d: fresh=269/300 (89.7%, required>=90%); keeping last good'
      )
    )
  })

  it('fails closed when no latest passed native board can establish eligibility', async () => {
    arrangeCoverage(0, 0)

    await expect(processDeriveBoards(job)).resolves.toEqual([])

    expect(mockDbQuery).not.toHaveBeenCalled()
    expect(mockPublishLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        'no eligible traders from latest PASSED native board; keeping last good'
      )
    )
  })

  it('fails closed when one declared native timeframe has no PASSED snapshot', async () => {
    const hyperliquid = {
      ...src,
      id: 20,
      slug: 'hyperliquid',
      adapter_slug: 'hyperliquid',
      currency: 'USDC',
      timeframes_native: [7, 30],
      timeframes_derived: [90],
      deep_profile_topn: 500,
    } as SourceRow
    mockGetSourceBySlug.mockResolvedValue(hyperliquid)
    mockGetLatestPassedNativeCohort.mockResolvedValue({
      traders: cohortTraders(500),
      nativeTimeframes: [7, 30],
      foundTimeframes: [7],
      missingTimeframes: [30],
    })

    await expect(
      processDeriveBoards({ ...job, data: { sourceSlug: hyperliquid.slug } })
    ).resolves.toEqual([])

    expect(mockDbQuery).not.toHaveBeenCalled()
    expect(mockPublishLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        'missing latest PASSED native board(s) [30d]; required=[7d,30d]; keeping last good'
      )
    )
  })
})
