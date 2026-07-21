import type { Job } from 'bullmq'
import type { ParsedLeaderboardRow, RawPage, SourceRow } from '@/lib/ingest/core/types'
import {
  LeaderboardCaptureUpstreamError,
  type LeaderboardCapture,
} from '@/lib/ingest/fetch/capture'
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
const mockPublishBots = jest.fn()
const mockJobUpdateData = jest.fn()
const mockResolveDeployedSha = jest.fn()

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
jest.mock('@/lib/ingest/serving/publish-bots', () => ({
  publishBots: (...args: unknown[]) => mockPublishBots(...args),
}))
jest.mock('@/worker/src/ingest/heartbeat', () => ({
  resolveDeployedSha: () => mockResolveDeployedSha(),
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
  pagination_kind: 'numeric',
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

const terminalPage: RawPage = {
  pageIndex: 2,
  payload: { result: { items: [] } },
  url: 'https://xt.test/leader-list?page=2',
  fetchedAt: '2026-07-16T00:00:01.000Z',
}

function capturedLeaderboard(overrides: Partial<LeaderboardCapture> = {}): LeaderboardCapture {
  const fetchedAt = new Date().toISOString()
  const capturedPage = { ...page, fetchedAt }
  const capturedTerminalPage = { ...terminalPage, fetchedAt }
  return {
    sourcePages: [
      {
        rawPage: capturedPage,
        sourceRowCount: 1,
        requestSha256: 'a'.repeat(64),
        httpStatus: 200,
        paginationPosition: { kind: 'page_index', request_page_index: 1 },
        sourceReports: {
          population: { state: 'reported', value: 1 },
          page_count: { state: 'not_reported' },
          current_page: { state: 'not_reported' },
          page_size: { state: 'not_reported' },
        },
      },
      {
        rawPage: capturedTerminalPage,
        sourceRowCount: 0,
        requestSha256: 'b'.repeat(64),
        httpStatus: 200,
        paginationPosition: { kind: 'page_index', request_page_index: 2 },
        sourceReports: {
          population: { state: 'reported', value: 1 },
          page_count: { state: 'not_reported' },
          current_page: { state: 'not_reported' },
          page_size: { state: 'not_reported' },
        },
      },
    ],
    parsePages: [capturedPage],
    terminationReason: 'empty_page',
    captureConfig: { caller_page_cap: null, safety_page_cap: 5_000 },
    parserTransformation: { kind: 'identity_projection', source_page_ordinals: [1] },
    ...overrides,
  }
}

function makeJob(data: TierJobData = { sourceSlug: src.slug }): Job<TierJobData> {
  const testJob = {
    id: 'repeat:tiera:xt_futures:1784361600000',
    timestamp: 1_784_361_600_000,
    attemptsMade: 2,
    data: {
      ...data,
      ...(data.completedTimeframes ? { completedTimeframes: [...data.completedTimeframes] } : {}),
    },
    updateData(nextData: TierJobData): Promise<void> {
      // BullMQ mutates the in-memory Job before awaiting its Redis command.
      // Keep the mock faithful so fail-closed restoration is regression-tested.
      testJob.data = nextData
      return mockJobUpdateData(nextData)
    },
  }
  return testJob as unknown as Job<TierJobData>
}

describe('Tier-A board-series publication guard', () => {
  let job: Job<TierJobData>
  let expectedCycleId: string

  beforeEach(() => {
    jest.clearAllMocks()
    mockJobUpdateData.mockResolvedValue(undefined)
    job = makeJob()
    expectedCycleId = `tier-a:${src.slug}:${job.id}:${job.timestamp}`
    mockResolveDeployedSha.mockReturnValue('c'.repeat(40))
    mockGetSourceBySlug.mockResolvedValue(src)
    mockNativeRankingTimeframes.mockReturnValue([30])
    mockOpenSession.mockResolvedValue({ close: mockSessionClose })
    mockSessionClose.mockResolvedValue(undefined)
    mockWriteRawObject.mockResolvedValue({
      id: 9001,
      storagePath: 'xt_futures/tier_a/raw.json.gz',
      contentHash: 'a'.repeat(64),
    })
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
    mockPublishBots.mockResolvedValue({ written: 1 })
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
    expect(mockJobUpdateData).toHaveBeenCalledWith({
      sourceSlug: src.slug,
      completedTimeframes: [30],
    })
    expect(mockPublishBoardSeries.mock.invocationCallOrder[0]).toBeLessThan(
      mockJobUpdateData.mock.invocationCallOrder[0]
    )
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('prefers capture evidence, parses only parsePages, and stores all sourcePages in RAW', async () => {
    let capture: LeaderboardCapture | null = null
    const captureLeaderboard = jest.fn(async () => {
      capture = capturedLeaderboard()
      return capture
    })
    const listLeaderboard = jest.fn(async function* () {
      throw new Error('legacy stream must not run')
    })
    const parseLeaderboard = jest.fn(() => ({ rows: [row], reportedTotal: 1 }))
    mockGetAdapter.mockReturnValue({
      captureLeaderboard,
      listLeaderboard,
      parseLeaderboard,
      parseLeaderboardSeries: () => new Map(),
    })

    await expect(processTierA(job)).resolves.toHaveLength(1)

    expect(capture).not.toBeNull()
    const sourcePages = (capture as LeaderboardCapture).sourcePages.map(
      (sourcePage) => sourcePage.rawPage
    )
    const parsePage = (capture as LeaderboardCapture).parsePages[0]

    expect(captureLeaderboard).toHaveBeenCalledTimes(1)
    expect(listLeaderboard).not.toHaveBeenCalled()
    expect(parseLeaderboard).toHaveBeenCalledTimes(1)
    expect(parseLeaderboard).toHaveBeenCalledWith(parsePage.payload, expect.any(Object))
    expect(parseLeaderboard).not.toHaveBeenCalledWith(terminalPage.payload, expect.any(Object))
    expect(mockWriteRawObject).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: sourcePages,
        meta: { pageCount: 2, observation_cycle_id: expectedCycleId },
      })
    )
    expect(mockPublishLeaderboardSnapshot).toHaveBeenCalledTimes(1)
  })

  it('freezes one runner SHA before a multi-window capture cycle', async () => {
    mockNativeRankingTimeframes.mockReturnValue([7, 30])
    mockResolveDeployedSha.mockReturnValueOnce('d'.repeat(40)).mockReturnValueOnce('e'.repeat(40))
    const captureLeaderboard = jest.fn(async () => capturedLeaderboard())
    mockGetAdapter.mockReturnValue({
      captureLeaderboard,
      listLeaderboard: async function* () {
        throw new Error('legacy stream must not run')
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
      parseLeaderboardSeries: () => new Map(),
    })

    await expect(processTierA(job)).resolves.toHaveLength(2)

    expect(captureLeaderboard).toHaveBeenCalledTimes(2)
    expect(mockResolveDeployedSha).toHaveBeenCalledTimes(1)
  })

  it('keeps partial capture out of the legacy count gate and serving', async () => {
    const captureLeaderboard = jest.fn(async () => {
      const complete = capturedLeaderboard()
      const firstSourcePage = complete.sourcePages[0]
      return {
        ...complete,
        sourcePages: [
          {
            ...firstSourcePage,
            sourceReports: {
              ...firstSourcePage.sourceReports,
              population: { state: 'reported', value: 2 },
            },
          },
        ],
        parsePages: [firstSourcePage.rawPage],
        terminationReason: 'caller_limit' as const,
        captureConfig: { caller_page_cap: 1, safety_page_cap: 5_000 },
        parserTransformation: {
          kind: 'identity_projection' as const,
          source_page_ordinals: [1],
        },
      }
    })
    mockGetAdapter.mockReturnValue({
      captureLeaderboard,
      listLeaderboard: async function* () {
        throw new Error('legacy stream must not run')
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 2 }),
      parseLeaderboardSeries: () => new Map(),
    })
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    let failure: unknown
    try {
      await processTierA(job)
    } catch (error) {
      failure = error
    } finally {
      errorSpy.mockRestore()
    }

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors[0].message).toContain(
      'acquisition trust gate FAILED: acquisition=partial, population=partial'
    )
    expect(mockWriteRawObject).toHaveBeenCalledTimes(1)
    expect(mockPublishLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
  })

  it('keeps unknown capture out of serving even when parsed rows look valid', async () => {
    const captureLeaderboard = jest.fn(async () => {
      const complete = capturedLeaderboard()
      const firstSourcePage = complete.sourcePages[0]
      return {
        ...complete,
        sourcePages: [
          {
            ...firstSourcePage,
            sourceReports: {
              population: { state: 'not_reported' as const },
              page_count: { state: 'not_reported' as const },
              current_page: { state: 'not_reported' as const },
              page_size: { state: 'not_reported' as const },
            },
          },
        ],
        parsePages: [firstSourcePage.rawPage],
        terminationReason: 'unknown' as const,
        parserTransformation: {
          kind: 'identity_projection' as const,
          source_page_ordinals: [1],
        },
      }
    })
    mockGetAdapter.mockReturnValue({
      captureLeaderboard,
      listLeaderboard: async function* () {
        throw new Error('legacy stream must not run')
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
      parseLeaderboardSeries: () => new Map(),
    })
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    let failure: unknown
    try {
      await processTierA(job)
    } catch (error) {
      failure = error
    } finally {
      errorSpy.mockRestore()
    }

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors[0].message).toContain(
      'acquisition trust gate FAILED: acquisition=unknown, population=unknown'
    )
    expect(mockWriteRawObject).toHaveBeenCalledTimes(1)
    expect(mockPublishLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
  })

  it('preserves capture error identity through the per-window AggregateError', async () => {
    const failedCapture = capturedLeaderboard({
      sourcePages: [
        {
          rawPage: page,
          sourceRowCount: 0,
          requestSha256: 'd'.repeat(64),
          httpStatus: 503,
          paginationPosition: { kind: 'page_index', request_page_index: 1 },
          sourceReports: {
            population: { state: 'not_reported' },
            page_count: { state: 'not_reported' },
            current_page: { state: 'not_reported' },
            page_size: { state: 'not_reported' },
          },
        },
      ],
      parsePages: [],
      terminationReason: 'upstream_error',
      parserTransformation: { kind: 'identity_projection', source_page_ordinals: [] },
    })
    const upstream = new LeaderboardCaptureUpstreamError(
      503,
      page.url,
      failedCapture,
      new Error('service unavailable')
    )
    mockGetAdapter.mockReturnValue({
      captureLeaderboard: async () => {
        throw upstream
      },
      listLeaderboard: async function* () {
        throw new Error('legacy stream must not run')
      },
    })
    mockSessionClose.mockRejectedValueOnce(new Error('browser close failed'))
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    let failure: unknown
    try {
      await processTierA(job)
    } catch (error) {
      failure = error
    } finally {
      errorSpy.mockRestore()
    }

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
    const wrapped = (failure as AggregateError).errors[0] as Error & { cause?: unknown }
    expect(wrapped.cause).toBe(upstream)
    expect((wrapped.cause as LeaderboardCaptureUpstreamError).capture).toBe(failedCapture)
    expect((failure as AggregateError).errors[1].message).toContain(
      'session close failed: browser close failed'
    )
    expect(mockWriteRawObject).not.toHaveBeenCalled()
    expect(mockPublishLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
  })

  it('keeps adapters without capture capability on the legacy stream', async () => {
    const listLeaderboard = jest.fn(async function* () {
      yield page
    })
    mockGetAdapter.mockReturnValue({
      listLeaderboard,
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
      parseLeaderboardSeries: () => new Map(),
    })

    await expect(processTierA(job)).resolves.toHaveLength(1)

    expect(listLeaderboard).toHaveBeenCalledTimes(1)
    expect(mockWriteRawObject).toHaveBeenCalledWith(
      expect.objectContaining({ payload: [page], meta: expect.objectContaining({ pageCount: 1 }) })
    )
    expect(mockResolveDeployedSha).not.toHaveBeenCalled()
  })

  it('resumes a retried job at the first unfinished native window', async () => {
    const attempted: number[] = []
    job = makeJob({ sourceSlug: src.slug, completedTimeframes: [7, 30] })
    mockNativeRankingTimeframes.mockReturnValue([7, 30, 90])
    mockGetAdapter.mockReturnValue({
      listLeaderboard: async function* (_session: unknown, _src: SourceRow, timeframe: number) {
        attempted.push(timeframe)
        yield page
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
      parseLeaderboardSeries: () => new Map(),
    })

    await expect(processTierA(job)).resolves.toEqual([
      expect.objectContaining({ timeframe: 90, snapshotId: 777, passed: true }),
    ])

    expect(attempted).toEqual([90])
    expect(mockWriteRawObject).toHaveBeenCalledTimes(1)
    expect(mockWriteRawObject).toHaveBeenCalledWith(expect.objectContaining({ timeframe: 90 }))
    expect(mockJobUpdateData).toHaveBeenCalledWith({
      sourceSlug: src.slug,
      completedTimeframes: [7, 30, 90],
    })
    expect(job.data.completedTimeframes).toEqual([7, 30, 90])
  })

  it('normalizes duplicate and invalid checkpoints before deciding what to skip', async () => {
    const attempted: number[] = []
    job = makeJob({
      sourceSlug: src.slug,
      completedTimeframes: [30, 30, 365, '90', null],
    } as unknown as TierJobData)
    mockNativeRankingTimeframes.mockReturnValue([7, 30, 90])
    mockGetAdapter.mockReturnValue({
      listLeaderboard: async function* (_session: unknown, _src: SourceRow, timeframe: number) {
        attempted.push(timeframe)
        yield page
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
      parseLeaderboardSeries: () => new Map(),
    })

    await expect(processTierA(job)).resolves.toHaveLength(2)

    // Only the numeric native 30d value is trusted; duplicates, unknown
    // numbers, strings, and null cannot suppress a crawl.
    expect(attempted).toEqual([7, 90])
    expect(mockJobUpdateData.mock.calls.map(([data]) => data.completedTimeframes)).toEqual([
      [7, 30],
      [7, 30, 90],
    ])
    expect(job.data.completedTimeframes).toEqual([7, 30, 90])
  })

  it('returns before opening a browser when every native window is checkpointed', async () => {
    job = makeJob({ sourceSlug: src.slug, completedTimeframes: [7, 30, 90] })
    mockNativeRankingTimeframes.mockReturnValue([7, 30, 90])

    await expect(processTierA(job)).resolves.toEqual([])

    expect(mockGetAdapter).not.toHaveBeenCalled()
    expect(mockOpenSession).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
  })

  it('does not checkpoint a window until board-series publication succeeds', async () => {
    mockPublishBoardSeries.mockRejectedValueOnce(new Error('series write failed'))
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(processTierA(job)).rejects.toThrow('1/1 native windows failed (30d)')
    } finally {
      errorSpy.mockRestore()
    }

    expect(mockPublishLeaderboardSnapshot).toHaveBeenCalledTimes(1)
    expect(mockPublishBoardSeries).toHaveBeenCalledTimes(1)
    expect(mockJobUpdateData).not.toHaveBeenCalled()
    expect(job.data).toEqual({ sourceSlug: src.slug })
  })

  it('checkpoints a bot window only after bot publication succeeds', async () => {
    mockGetSourceBySlug.mockResolvedValue({ ...src, trader_kind_scope: 'bot' })

    await expect(processTierA(job)).resolves.toHaveLength(1)

    expect(mockPublishBots).toHaveBeenCalledTimes(1)
    expect(mockPublishBots.mock.invocationCallOrder[0]).toBeLessThan(
      mockJobUpdateData.mock.invocationCallOrder[0]
    )
    expect(mockJobUpdateData).toHaveBeenCalledWith({
      sourceSlug: src.slug,
      completedTimeframes: [30],
    })
  })

  it('does not checkpoint a bot window whose bot publication fails', async () => {
    mockGetSourceBySlug.mockResolvedValue({ ...src, trader_kind_scope: 'bot' })
    mockPublishBots.mockRejectedValueOnce(new Error('bot write failed'))
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(processTierA(job)).rejects.toThrow('1/1 native windows failed (30d)')
    } finally {
      errorSpy.mockRestore()
    }

    expect(mockPublishBots).toHaveBeenCalledTimes(1)
    expect(mockJobUpdateData).not.toHaveBeenCalled()
    expect(job.data).toEqual({ sourceSlug: src.slug })
  })

  it('fails closed, restores acknowledged data, and stops after an updateData failure', async () => {
    const attempted: number[] = []
    job = makeJob({ sourceSlug: src.slug, completedTimeframes: [7] })
    mockNativeRankingTimeframes.mockReturnValue([7, 30, 90])
    mockGetAdapter.mockReturnValue({
      listLeaderboard: async function* (_session: unknown, _src: SourceRow, timeframe: number) {
        attempted.push(timeframe)
        yield page
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
      parseLeaderboardSeries: () => new Map(),
    })
    mockJobUpdateData.mockRejectedValueOnce(new Error('redis unavailable'))
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(processTierA(job)).rejects.toThrow(
        'checkpoint persistence failed for xt_futures 30d: redis unavailable'
      )
    } finally {
      errorSpy.mockRestore()
    }

    expect(attempted).toEqual([30])
    expect(mockPublishLeaderboardSnapshot).toHaveBeenCalledTimes(1)
    expect(mockJobUpdateData).toHaveBeenCalledWith({
      sourceSlug: src.slug,
      completedTimeframes: [7, 30],
    })
    expect(job.data).toEqual({ sourceSlug: src.slug, completedTimeframes: [7] })
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('checkpoints successes around a normal failure and retries only the missing window', async () => {
    const attempted: number[] = []
    let run = 1
    mockNativeRankingTimeframes.mockReturnValue([7, 30, 90])
    mockGetAdapter.mockReturnValue({
      listLeaderboard: async function* (_session: unknown, _src: SourceRow, timeframe: number) {
        attempted.push(timeframe)
        if (run === 1 && timeframe === 30) throw new Error('transient upstream failure')
        yield page
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
      parseLeaderboardSeries: () => new Map(),
    })
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(processTierA(job)).rejects.toThrow('1/3 native windows failed (30d)')

      expect(attempted).toEqual([7, 30, 90])
      expect(mockJobUpdateData.mock.calls.map(([data]) => data.completedTimeframes)).toEqual([
        [7],
        [7, 90],
      ])
      expect(job.data.completedTimeframes).toEqual([7, 90])

      run = 2
      attempted.length = 0
      mockJobUpdateData.mockClear()

      await expect(processTierA(job)).resolves.toEqual([
        expect.objectContaining({ timeframe: 30, snapshotId: 777, passed: true }),
      ])

      expect(attempted).toEqual([30])
      expect(mockJobUpdateData).toHaveBeenCalledWith({
        sourceSlug: src.slug,
        completedTimeframes: [7, 30, 90],
      })
      expect(job.data.completedTimeframes).toEqual([7, 30, 90])
    } finally {
      errorSpy.mockRestore()
    }
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
    mockWriteRawObject
      .mockResolvedValueOnce({
        id: 9030,
        storagePath: 'xt_futures/tier_a/30.json.gz',
        contentHash: 'b'.repeat(64),
      })
      .mockResolvedValueOnce({
        id: 9090,
        storagePath: 'xt_futures/tier_a/90.json.gz',
        contentHash: 'c'.repeat(64),
      })
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
    expect(mockJobUpdateData).toHaveBeenCalledTimes(1)
    expect(mockJobUpdateData).toHaveBeenCalledWith({
      sourceSlug: src.slug,
      completedTimeframes: [90],
    })
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
