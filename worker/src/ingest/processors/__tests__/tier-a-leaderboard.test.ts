import type { Job } from 'bullmq'
import type { ParsedLeaderboardRow, RawPage, SourceRow } from '@/lib/ingest/core/types'
import type { TierJobData } from '../../queues'

const mockGetSourceBySlug = jest.fn()
const mockNativeRankingTimeframes = jest.fn()
const mockGetAdapter = jest.fn()
const mockOpenSession = jest.fn()
const mockSessionClose = jest.fn()
const mockWriteRawObject = jest.fn()
const mockRecordFieldInventory = jest.fn()
const mockValidateLeaderboardRows = jest.fn()
const mockPublishLeaderboardSnapshot = jest.fn()
const mockPublishBoardSeries = jest.fn()

jest.mock('@/lib/ingest/sources', () => ({
  getSourceBySlug: (...args: unknown[]) => mockGetSourceBySlug(...args),
  nativeRankingTimeframes: (...args: unknown[]) => mockNativeRankingTimeframes(...args),
}))
jest.mock('@/lib/ingest/core/adapter', () => ({
  getAdapter: (...args: unknown[]) => mockGetAdapter(...args),
}))
jest.mock('@/lib/ingest/fetch/fetcher', () => ({
  openSession: (...args: unknown[]) => mockOpenSession(...args),
}))
jest.mock('@/lib/ingest/raw', () => ({
  writeRawObject: (...args: unknown[]) => mockWriteRawObject(...args),
}))
jest.mock('@/lib/ingest/field-inventory', () => ({
  recordFieldInventory: (...args: unknown[]) => mockRecordFieldInventory(...args),
}))
jest.mock('@/lib/ingest/staging/validate', () => ({
  validateLeaderboardRows: (...args: unknown[]) => mockValidateLeaderboardRows(...args),
}))
jest.mock('@/lib/ingest/serving/publish', () => ({
  publishLeaderboardSnapshot: (...args: unknown[]) => mockPublishLeaderboardSnapshot(...args),
  publishBoardSeries: (...args: unknown[]) => mockPublishBoardSeries(...args),
}))

import { processTierA } from '../tier-a-leaderboard'

const src = {
  id: 19,
  slug: 'xt_futures',
  adapter_slug: 'xt',
  status: 'active',
  currency: 'USDT',
  tf_label_map: {},
  meta: {},
  page_size: 100,
  trader_kind_scope: 'human',
} as SourceRow

const page: RawPage = {
  pageIndex: 1,
  payload: { result: { items: [{ accountId: 'xt-1' }] } },
  url: 'https://xt.test/leader-list',
  fetchedAt: '2026-07-16T00:00:00.000Z',
}

const row = {
  exchangeTraderId: 'xt-1',
  rank: 1,
  nickname: 'XT One',
  avatarUrlOrigin: null,
  walletAddress: null,
  traderKind: 'human',
  botStrategy: null,
  headlineRoi: 10,
  headlinePnl: 20,
  headlineWinRate: 50,
  raw: {},
} as ParsedLeaderboardRow

const job = {
  id: 'repeat:tiera:xt_futures:1784361600000',
  timestamp: 1_784_361_600_000,
  attemptsMade: 2,
  data: { sourceSlug: src.slug },
} as Job<TierJobData>
const expectedCycleId = `tier-a:${src.slug}:${job.id}:${job.timestamp}`

describe('Tier-A board-series publication guard', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSourceBySlug.mockResolvedValue(src)
    mockNativeRankingTimeframes.mockReturnValue([30])
    mockOpenSession.mockResolvedValue({ close: mockSessionClose })
    mockSessionClose.mockResolvedValue(undefined)
    mockWriteRawObject.mockResolvedValue(9001)
    mockRecordFieldInventory.mockResolvedValue(undefined)
    mockValidateLeaderboardRows.mockImplementation((rows: ParsedLeaderboardRow[]) => ({
      valid: rows,
      rejects: [],
    }))
    mockGetAdapter.mockReturnValue({
      listLeaderboard: async function* () {
        yield page
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
      parseLeaderboardSeries: () =>
        new Map([
          [
            row.exchangeTraderId,
            [
              {
                timeframe: 30,
                metric: 'pnl',
                replaceSeries: true,
                points: [{ ts: '2026-07-16T00:00:00.000Z', value: 20 }],
              },
            ],
          ],
        ]),
    })
    mockPublishLeaderboardSnapshot.mockResolvedValue({
      snapshotId: 777,
      scrapedAt: '2026-07-16 00:01:02.123456+00',
      verdict: { passed: true, baselineUsed: 1, deviationPct: 0 },
      published: true,
      traderIds: new Map([[row.exchangeTraderId, 42]]),
    })
    mockPublishBoardSeries.mockResolvedValue({ traders: 1, points: 1 })
  })

  it('passes the exact live snapshot identity before publishing replacement series', async () => {
    await expect(processTierA(job)).resolves.toEqual([
      expect.objectContaining({ timeframe: 30, snapshotId: 777, passed: true }),
    ])

    expect(mockPublishBoardSeries).toHaveBeenCalledWith(
      src,
      expect.any(Map),
      new Map([[row.exchangeTraderId, 42]]),
      {
        expectedLatestSnapshots: new Map([
          [
            30,
            {
              id: 777,
              rawObjectId: 9001,
              scrapedAt: '2026-07-16T00:01:02.123Z',
            },
          ],
        ]),
      }
    )
    // openSession(src) is the fetch-layer's source-scoped, single-slot
    // unsuffixed lane. Do not bypass it with a raw profile suffix override.
    expect(mockOpenSession).toHaveBeenCalledWith(src)
    expect(mockWriteRawObject).toHaveBeenCalledWith(
      expect.objectContaining({
        timeframe: 30,
        meta: { pageCount: 1, observation_cycle_id: expectedCycleId },
      })
    )
    expect(mockPublishLeaderboardSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        timeframe: 30,
        observationCycleId: expectedCycleId,
      })
    )
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('attempts every native window, then exits with one aggregate error', async () => {
    const attempted: number[] = []
    mockNativeRankingTimeframes.mockReturnValue([7, 30, 90])
    mockGetAdapter.mockReturnValue({
      listLeaderboard: async function* (_session: unknown, _src: SourceRow, timeframe: number) {
        attempted.push(timeframe)
        if (timeframe === 7) throw new Error('upstream 503')
        yield page
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
      parseLeaderboardSeries: () => new Map(),
    })
    mockWriteRawObject.mockResolvedValueOnce(9030).mockResolvedValueOnce(9090)
    mockPublishLeaderboardSnapshot.mockImplementation(
      async (input: { timeframe: number; rawObjectId: number }) => ({
        snapshotId: input.timeframe === 30 ? 730 : 790,
        scrapedAt: '2026-07-16 00:01:02.123456+00',
        verdict: {
          passed: input.timeframe !== 30,
          baselineUsed: input.timeframe === 30 ? 20 : 1,
          deviationPct: input.timeframe === 30 ? 50 : 0,
        },
        published: input.timeframe !== 30,
        traderIds: input.timeframe === 30 ? new Map() : new Map([[row.exchangeTraderId, 42]]),
      })
    )
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    let failure: unknown
    try {
      await processTierA(job)
    } catch (error) {
      failure = error
    } finally {
      errorSpy.mockRestore()
    }

    expect(attempted).toEqual([7, 30, 90])
    expect(mockPublishLeaderboardSnapshot.mock.calls.map(([input]) => input.timeframe)).toEqual([
      30, 90,
    ])
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
    expect((failure as Error).message).toContain('2/3 native windows failed (7d, 30d)')
    expect((failure as Error).message).toContain('1 succeeded')
    expect(mockSessionClose).toHaveBeenCalledTimes(1)

    for (const [input] of mockWriteRawObject.mock.calls) {
      expect(input.meta.observation_cycle_id).toBe(expectedCycleId)
    }
    for (const [input] of mockPublishLeaderboardSnapshot.mock.calls) {
      expect(input.observationCycleId).toBe(expectedCycleId)
    }
  })

  it('does not acquire the Tier-A profile lane before timeframe preparation succeeds', async () => {
    mockNativeRankingTimeframes.mockImplementation(() => {
      throw new Error('invalid timeframe config')
    })

    await expect(processTierA(job)).rejects.toThrow('invalid timeframe config')
    expect(mockOpenSession).not.toHaveBeenCalled()
    expect(mockSessionClose).not.toHaveBeenCalled()
  })
})
