import type { Job } from 'bullmq'
import type { ParsedLeaderboardRow, RawPage, SourceRow } from '@/lib/ingest/core/types'
import {
  LeaderboardCaptureUpstreamError,
  captureNumericLeaderboard,
  type LeaderboardCapture,
} from '@/lib/ingest/fetch/capture'
import type { FetchSession } from '@/lib/ingest/fetch/types'
import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalSha256,
} from '@/lib/ingest/strict-canonical-json'
import {
  LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
  projectLeaderboardManifestV3Outcome,
  type LeaderboardAcquisitionAttempt,
  type StartLeaderboardAcquisitionAttemptInput,
} from '@/lib/ingest/acquisition-attempts'
import type { TierJobData } from '../../queues'

const mockGetSourceBySlug = jest.fn()
const mockNativeRankingTimeframes = jest.fn()
const mockGetAdapter = jest.fn()
const mockOpenSession = jest.fn()
const mockSessionClose = jest.fn()
const mockWriteRawObject = jest.fn()
const mockWriteLeaderboardRawArtifactSet = jest.fn()
const mockWriteAttemptBoundLeaderboardRawArtifactSet = jest.fn()
const mockHasRegisteredAttemptBoundContract = jest.fn()
const mockStartLeaderboardAcquisitionAttempt = jest.fn()
const mockFinishLeaderboardAcquisitionAttempt = jest.fn()
const mockRecordFieldInventory = jest.fn()
const mockValidateLeaderboardRows = jest.fn()
const mockPublishLeaderboardSnapshot = jest.fn()
const mockPublishTrustedLeaderboardSnapshot = jest.fn()
const mockHasRegisteredLeaderboardMetricTrust = jest.fn()
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
  writeLeaderboardRawArtifactSet: (...args: unknown[]) =>
    mockWriteLeaderboardRawArtifactSet(...args),
  writeAttemptBoundLeaderboardRawArtifactSet: (...args: unknown[]) =>
    mockWriteAttemptBoundLeaderboardRawArtifactSet(...args),
}))
jest.mock('@/lib/ingest/acquisition-attempts', () => {
  const actual = jest.requireActual('@/lib/ingest/acquisition-attempts')
  return {
    ...actual,
    hasRegisteredAttemptBoundLeaderboardAcquisitionContract: (...args: unknown[]) =>
      mockHasRegisteredAttemptBoundContract(...args),
    startLeaderboardAcquisitionAttempt: (...args: unknown[]) =>
      mockStartLeaderboardAcquisitionAttempt(...args),
    finishLeaderboardAcquisitionAttempt: (...args: unknown[]) =>
      mockFinishLeaderboardAcquisitionAttempt(...args),
  }
})
jest.mock('@/lib/ingest/field-inventory', () => ({
  recordFieldInventory: (...args: unknown[]) => mockRecordFieldInventory(...args),
}))
jest.mock('@/lib/ingest/staging/validate', () => ({
  validateLeaderboardRows: (...args: unknown[]) => mockValidateLeaderboardRows(...args),
}))
jest.mock('@/lib/ingest/serving/publish', () => ({
  publishLeaderboardSnapshot: (...args: unknown[]) => mockPublishLeaderboardSnapshot(...args),
  publishTrustedLeaderboardSnapshot: (...args: unknown[]) =>
    mockPublishTrustedLeaderboardSnapshot(...args),
  publishBoardSeries: (...args: unknown[]) => mockPublishBoardSeries(...args),
}))
jest.mock('@/lib/ingest/serving/metric-trust-publish', () => ({
  hasRegisteredLeaderboardMetricTrust: (...args: unknown[]) =>
    mockHasRegisteredLeaderboardMetricTrust(...args),
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

const binanceSrc = {
  ...src,
  id: 1,
  slug: 'binance_futures',
  adapter_slug: 'binance',
  fetch_region: 'vps_sg',
  serving_mode: 'serving',
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

function attemptFromStart(
  input: StartLeaderboardAcquisitionAttemptInput,
  sequence: number,
  source: SourceRow = binanceSrc
): LeaderboardAcquisitionAttempt {
  return Object.freeze({
    attemptSeq: sequence,
    attemptId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    sourceId: source.id,
    sourceSlug: source.slug,
    adapterSlug: source.adapter_slug,
    timeframe: input.timeframe,
    observationCycleId: input.observationCycleId,
    queueJobId: input.queueJobId,
    queueAttempt: input.queueAttempt,
    captureContract: input.captureContract,
    attemptBindingContract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
    runnerGitSha: input.runnerGitSha,
    workerRegion: input.workerRegion,
    sourceStatus: 'active',
    sourceServingMode: 'serving',
    sourceCurrency: 'USDT',
    sourceFetchRegion: source.fetch_region,
    recordedStartedAt: new Date().toISOString(),
    replayed: false,
  })
}

function attemptBoundRawReceipt(input: {
  attempt: LeaderboardAcquisitionAttempt
  built: Parameters<typeof projectLeaderboardManifestV3Outcome>[1]
}) {
  const idBase = 9_200 + input.attempt.timeframe * 2
  return {
    sourcePayload: {
      id: idBase + 1,
      storagePath: `${input.attempt.sourceSlug}/tier_a_trust/source-v3.json.gz`,
      contentHash: 'd'.repeat(64),
    },
    populationManifest: {
      id: idBase + 2,
      storagePath: `${input.attempt.sourceSlug}/tier_a_trust/manifest-v3.json.gz`,
      contentHash: input.built.sourceRunId,
    },
    projection: projectLeaderboardManifestV3Outcome(input.attempt, input.built),
  }
}

describe('Tier-A board-series publication guard', () => {
  let job: Job<TierJobData>
  let expectedCycleId: string
  const originalIngestLocalRegion = process.env.INGEST_LOCAL_REGION
  const originalAttemptBoundCaptureEnabled = process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.INGEST_LOCAL_REGION = 'local'
    process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED = 'true'
    mockJobUpdateData.mockResolvedValue(undefined)
    job = makeJob()
    expectedCycleId = `tier-a:${src.slug}:${job.id}:${job.timestamp}`
    mockResolveDeployedSha.mockReturnValue('c'.repeat(40))
    mockHasRegisteredAttemptBoundContract.mockResolvedValue(false)
    let nextAttemptSequence = 41
    mockStartLeaderboardAcquisitionAttempt.mockImplementation(
      async (input: StartLeaderboardAcquisitionAttemptInput) =>
        attemptFromStart(input, nextAttemptSequence++)
    )
    mockWriteAttemptBoundLeaderboardRawArtifactSet.mockImplementation(
      async (input: {
        attempt: LeaderboardAcquisitionAttempt
        built: Parameters<typeof projectLeaderboardManifestV3Outcome>[1]
      }) => attemptBoundRawReceipt(input)
    )
    mockFinishLeaderboardAcquisitionAttempt.mockImplementation(
      async (input: {
        attempt: LeaderboardAcquisitionAttempt
        kind: 'manifest' | 'processing_failed'
        projection?: { terminalState: string }
      }) => ({
        attemptSeq: input.attempt.attemptSeq,
        terminalState:
          input.kind === 'manifest' ? input.projection!.terminalState : 'processing_failed',
        recordedCompletedAt: new Date().toISOString(),
        replayed: false,
      })
    )
    mockGetSourceBySlug.mockResolvedValue(src)
    mockNativeRankingTimeframes.mockReturnValue([30])
    mockOpenSession.mockResolvedValue({ close: mockSessionClose })
    mockSessionClose.mockResolvedValue(undefined)
    mockWriteRawObject.mockResolvedValue({
      id: 9001,
      storagePath: 'xt_futures/tier_a/raw.json.gz',
      contentHash: 'a'.repeat(64),
    })
    mockWriteLeaderboardRawArtifactSet.mockResolvedValue({
      sourcePayload: {
        id: 9101,
        storagePath: 'xt_futures/tier_a_trust/source.json.gz',
        contentHash: 'b'.repeat(64),
      },
      populationManifest: {
        id: 9102,
        storagePath: 'xt_futures/tier_a_trust/manifest.json.gz',
        contentHash: 'c'.repeat(64),
      },
    })
    mockRecordFieldInventory.mockResolvedValue(undefined)
    mockValidateLeaderboardRows.mockImplementation((rows: ParsedLeaderboardRow[]) => ({
      valid: rows,
      rejects: [],
    }))
    mockHasRegisteredLeaderboardMetricTrust.mockReturnValue(true)
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
    mockPublishTrustedLeaderboardSnapshot.mockResolvedValue({
      snapshotId: 777,
      scrapedAt: '2026-07-16 00:01:02.123456+00',
      verdict: { passed: true, baselineUsed: 1, deviationPct: 0 },
      published: true,
      traderIds: new Map([[row.exchangeTraderId, 42]]),
      trust: {
        sourceRunId: 'c'.repeat(64),
        observationsWritten: 0,
        artifactRefsWritten: 0,
        replayed: false,
      },
    })
    mockPublishBoardSeries.mockResolvedValue({ traders: 1, points: 1 })
    mockPublishBots.mockResolvedValue({ written: 1 })
  })

  afterAll(() => {
    if (originalIngestLocalRegion === undefined) delete process.env.INGEST_LOCAL_REGION
    else process.env.INGEST_LOCAL_REGION = originalIngestLocalRegion
    if (originalAttemptBoundCaptureEnabled === undefined) {
      delete process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED
    } else {
      process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED = originalAttemptBoundCaptureEnabled
    }
  })

  function configureAttemptBoundSource(
    timeframes: Array<7 | 30 | 90> = [30],
    captureLeaderboard: jest.Mock = jest.fn(async () => capturedLeaderboard()),
    parsedRows: ParsedLeaderboardRow[] = [row]
  ) {
    job = makeJob({ sourceSlug: binanceSrc.slug })
    expectedCycleId = `tier-a:${binanceSrc.slug}:${job.id}:${job.timestamp}`
    mockGetSourceBySlug.mockResolvedValue(binanceSrc)
    mockNativeRankingTimeframes.mockReturnValue(timeframes)
    mockHasRegisteredAttemptBoundContract.mockResolvedValue(true)
    mockGetAdapter.mockReturnValue({
      captureLeaderboard,
      listLeaderboard: async function* () {
        throw new Error('registered source must not use the legacy stream')
      },
      parseLeaderboard: () => ({ rows: parsedRows, reportedTotal: parsedRows.length }),
      parseLeaderboardSeries: () => new Map(),
    })
    return captureLeaderboard
  }

  it('keeps a registered v3 contract inert without explicit rollout approval', async () => {
    delete process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED
    mockHasRegisteredAttemptBoundContract.mockResolvedValue(true)

    await expect(processTierA(job)).resolves.toEqual([
      expect.objectContaining({ timeframe: 30, snapshotId: 777, passed: true }),
    ])

    expect(mockHasRegisteredAttemptBoundContract).not.toHaveBeenCalled()
    expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).not.toHaveBeenCalled()
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
    expect(mockWriteRawObject).not.toHaveBeenCalled()
    expect(mockWriteLeaderboardRawArtifactSet).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePages,
        observationCycleId: expectedCycleId,
        manifest: expect.objectContaining({
          assessment: { acquisition_state: 'complete', population_state: 'verified' },
        }),
      })
    )
    const artifactInput = mockWriteLeaderboardRawArtifactSet.mock.calls[0][0]
    expect(artifactInput.sourceRunId).toBe(strictCanonicalSha256(artifactInput.manifest))
    expect(mockWriteLeaderboardRawArtifactSet.mock.invocationCallOrder[0]).toBeLessThan(
      mockPublishTrustedLeaderboardSnapshot.mock.invocationCallOrder[0]
    )
    expect(mockPublishTrustedLeaderboardSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        trust: expect.objectContaining({
          sourceRunId: artifactInput.sourceRunId,
          manifest: artifactInput.manifest,
          artifacts: expect.objectContaining({
            sourcePayload: expect.objectContaining({ id: 9101 }),
            populationManifest: expect.objectContaining({ id: 9102 }),
          }),
        }),
      })
    )
    expect(mockPublishLeaderboardSnapshot).not.toHaveBeenCalled()
  })

  it('keeps captured artifacts but uses legacy publication when no metric trust contract is registered', async () => {
    const captureLeaderboard = jest.fn(async () => capturedLeaderboard())
    mockHasRegisteredLeaderboardMetricTrust.mockReturnValue(false)
    mockGetAdapter.mockReturnValue({
      captureLeaderboard,
      listLeaderboard: async function* () {
        throw new Error('legacy stream must not run')
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
      parseLeaderboardSeries: () => new Map(),
    })

    await expect(processTierA(job)).resolves.toHaveLength(1)

    expect(captureLeaderboard).toHaveBeenCalledTimes(1)
    expect(mockWriteLeaderboardRawArtifactSet).toHaveBeenCalledTimes(1)
    expect(mockWriteLeaderboardRawArtifactSet).toHaveBeenCalledWith(
      expect.objectContaining({
        observationCycleId: expectedCycleId,
        manifest: expect.objectContaining({
          assessment: { acquisition_state: 'complete', population_state: 'verified' },
        }),
      })
    )
    expect(mockHasRegisteredLeaderboardMetricTrust).toHaveBeenCalledWith(src, 30)
    expect(mockWriteLeaderboardRawArtifactSet.mock.invocationCallOrder[0]).toBeLessThan(
      mockPublishLeaderboardSnapshot.mock.invocationCallOrder[0]
    )
    expect(mockPublishLeaderboardSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        src,
        timeframe: 30,
        rows: [row],
        rejects: [],
        rawObjectId: 9101,
        observationCycleId: expectedCycleId,
      })
    )
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
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
    expect(mockWriteRawObject).not.toHaveBeenCalled()
    expect(mockWriteLeaderboardRawArtifactSet).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({
          assessment: { acquisition_state: 'partial', population_state: 'partial' },
        }),
      })
    )
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
    expect(mockWriteRawObject).not.toHaveBeenCalled()
    expect(mockWriteLeaderboardRawArtifactSet).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({
          assessment: { acquisition_state: 'unknown', population_state: 'unknown' },
        }),
      })
    )
    expect(mockPublishLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
  })

  it('persists a missing-runner manifest as unknown before refusing publication', async () => {
    mockResolveDeployedSha.mockReturnValue('unknown-deployment')
    mockGetAdapter.mockReturnValue({
      captureLeaderboard: async () => capturedLeaderboard(),
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
    expect(mockWriteLeaderboardRawArtifactSet).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({
          runner_git_sha: null,
          assessment: { acquisition_state: 'unknown', population_state: 'unknown' },
        }),
      })
    )
    expect(mockPublishLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
  })

  it('preserves capture error identity through the per-window AggregateError', async () => {
    let failedRawPage: RawPage | null = null
    let failedCapture: LeaderboardCapture | null = null
    let upstream: LeaderboardCaptureUpstreamError | null = null
    mockGetAdapter.mockReturnValue({
      captureLeaderboard: async () => {
        const captureBase = capturedLeaderboard()
        failedRawPage = {
          ...captureBase.sourcePages[0].rawPage,
          payload: { error: 'service unavailable' },
        }
        failedCapture = capturedLeaderboard({
          sourcePages: [
            {
              rawPage: failedRawPage,
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
        upstream = new LeaderboardCaptureUpstreamError(
          503,
          failedRawPage.url,
          failedCapture,
          new Error('service unavailable')
        )
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
    expect(mockWriteLeaderboardRawArtifactSet).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePages: [failedRawPage],
        manifest: expect.objectContaining({
          termination_reason: 'upstream_error',
          population: expect.objectContaining({
            accepted_population: 0,
            rejected_row_count: 0,
          }),
          assessment: { acquisition_state: 'unknown', population_state: 'unknown' },
        }),
      })
    )
    expect(mockPublishLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
  })

  it('uses real accepted counts from pages captured before an upstream error', async () => {
    let upstream: LeaderboardCaptureUpstreamError | null = null
    mockGetAdapter.mockReturnValue({
      captureLeaderboard: async () => {
        const base = capturedLeaderboard()
        const errorRawPage: RawPage = {
          ...base.sourcePages[1].rawPage,
          payload: { error: 'second page unavailable' },
        }
        const failedCapture = capturedLeaderboard({
          sourcePages: [
            base.sourcePages[0],
            {
              ...base.sourcePages[1],
              rawPage: errorRawPage,
              sourceRowCount: 0,
              httpStatus: 503,
              sourceReports: {
                population: { state: 'not_reported' },
                page_count: { state: 'not_reported' },
                current_page: { state: 'not_reported' },
                page_size: { state: 'not_reported' },
              },
            },
          ],
          parsePages: [base.sourcePages[0].rawPage],
          terminationReason: 'upstream_error',
          parserTransformation: { kind: 'identity_projection', source_page_ordinals: [1] },
        })
        upstream = new LeaderboardCaptureUpstreamError(
          503,
          errorRawPage.url,
          failedCapture,
          new Error('service unavailable')
        )
        throw upstream
      },
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
    expect(((failure as AggregateError).errors[0] as Error & { cause?: unknown }).cause).toBe(
      upstream
    )
    expect(mockWriteLeaderboardRawArtifactSet).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({
          termination_reason: 'upstream_error',
          parser_input: expect.objectContaining({ page_count: 1 }),
          population: expect.objectContaining({
            observed_row_count: 1,
            accepted_population: 1,
            rejected_row_count: 0,
          }),
          assessment: { acquisition_state: 'unknown', population_state: 'unknown' },
        }),
      })
    )
    expect(mockPublishLeaderboardSnapshot).not.toHaveBeenCalled()
  })

  it('persists a real first-request transport failure as unavailable and unknown', async () => {
    const transportError = new Error('connection failed before a response')
    const captureSession = {
      sourceSlug: src.slug,
      paced: <T>(fn: () => Promise<T>) => fn(),
      close: mockSessionClose,
    } as unknown as FetchSession
    mockOpenSession.mockResolvedValue(captureSession)
    mockGetAdapter.mockReturnValue({
      captureLeaderboard: (session: FetchSession) =>
        captureNumericLeaderboard({
          session,
          fetcher: async () => {
            throw transportError
          },
          buildRequest: (pageIndex) => ({
            url: `https://xt.test/leader-list?page=${pageIndex}`,
            method: 'GET',
            headers: {},
          }),
          projectPublicRequest: (template) => ({
            url: template.url,
            method: template.method,
          }),
          pageBinding: { location: 'query', key: 'page' },
          extractMeta: () => ({
            rowCount: 0,
            reportedPopulation: null,
            reportedPageCount: null,
            reportedCurrentPage: null,
            reportedPageSize: null,
          }),
          pageSize: src.page_size,
          safetyPageCap: 5_000,
        }),
      listLeaderboard: async function* () {
        throw new Error('legacy stream must not run')
      },
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
    const wrapped = (failure as AggregateError).errors[0] as Error & { cause?: unknown }
    expect(wrapped.cause).toBeInstanceOf(LeaderboardCaptureUpstreamError)
    expect(wrapped.cause).toMatchObject({ status: null, cause: transportError })
    expect(mockWriteRawObject).not.toHaveBeenCalled()
    expect(mockWriteLeaderboardRawArtifactSet).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePages: [],
        manifest: expect.objectContaining({
          capture_evidence_state: 'unavailable',
          termination_reason: 'unknown',
          population: expect.objectContaining({
            observed_row_count: 0,
            accepted_population: 0,
            rejected_row_count: 0,
          }),
          assessment: { acquisition_state: 'unknown', population_state: 'unknown' },
        }),
      })
    )
    expect(mockPublishLeaderboardSnapshot).not.toHaveBeenCalled()
  })

  it('keeps a series-parser bug from erasing valid population evidence', async () => {
    const seriesError = new Error('series envelope changed')
    mockGetAdapter.mockReturnValue({
      captureLeaderboard: async () => capturedLeaderboard(),
      listLeaderboard: async function* () {
        throw new Error('legacy stream must not run')
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
      parseLeaderboardSeries: () => {
        throw seriesError
      },
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
    expect(((failure as AggregateError).errors[0] as Error & { cause?: unknown }).cause).toBe(
      seriesError
    )
    expect(mockWriteLeaderboardRawArtifactSet).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({
          assessment: { acquisition_state: 'complete', population_state: 'verified' },
        }),
      })
    )
    expect(mockWriteRawObject).not.toHaveBeenCalled()
    expect(mockPublishLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
  })

  it('stops later windows and preserves upstream plus artifact persistence failures', async () => {
    mockNativeRankingTimeframes.mockReturnValue([30, 90])
    const attempted: number[] = []
    let upstream: LeaderboardCaptureUpstreamError | null = null
    const persistenceError = new Error('artifact database unavailable')
    mockWriteLeaderboardRawArtifactSet.mockRejectedValueOnce(persistenceError)
    mockGetAdapter.mockReturnValue({
      captureLeaderboard: async (_session: unknown, _source: SourceRow, timeframe: number) => {
        attempted.push(timeframe)
        const base = capturedLeaderboard()
        const failedRawPage: RawPage = {
          ...base.sourcePages[0].rawPage,
          payload: { error: 'upstream unavailable' },
        }
        const failedCapture = capturedLeaderboard({
          sourcePages: [
            {
              ...base.sourcePages[0],
              rawPage: failedRawPage,
              sourceRowCount: 0,
              httpStatus: 503,
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
        upstream = new LeaderboardCaptureUpstreamError(
          503,
          failedRawPage.url,
          failedCapture,
          new Error('service unavailable')
        )
        throw upstream
      },
      listLeaderboard: async function* () {
        throw new Error('legacy stream must not run')
      },
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
    expect((failure as AggregateError).errors).toEqual([upstream, persistenceError])
    expect(attempted).toEqual([30])
    expect(mockPublishLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('persists an explicit unknown RAW fallback and stops when capture parsing fails', async () => {
    mockNativeRankingTimeframes.mockReturnValue([30, 90])
    const attempted: number[] = []
    const parserError = new Error('parser contract mismatch')
    let capture: LeaderboardCapture | null = null
    mockGetAdapter.mockReturnValue({
      captureLeaderboard: async (_session: unknown, _source: SourceRow, timeframe: number) => {
        attempted.push(timeframe)
        capture = capturedLeaderboard()
        return capture
      },
      listLeaderboard: async function* () {
        throw new Error('legacy stream must not run')
      },
      parseLeaderboard: () => {
        throw parserError
      },
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
    expect((failure as AggregateError).errors).toEqual([parserError])
    expect(attempted).toEqual([30])
    expect(mockWriteLeaderboardRawArtifactSet).not.toHaveBeenCalled()
    expect(mockWriteRawObject).toHaveBeenCalledWith({
      sourceId: src.id,
      sourceSlug: src.slug,
      jobType: 'tier_a_failure',
      timeframe: 30,
      payload: (capture as LeaderboardCapture).sourcePages.map((sourcePage) => sourcePage.rawPage),
      serialization: STRICT_CANONICAL_JSON_CONTRACT,
      meta: {
        pageCount: 2,
        observation_cycle_id: expectedCycleId,
        trust_evidence: {
          state: 'unknown',
          rank_eligible: false,
          failure_stage: 'parse_validate_or_manifest',
          termination_reason: 'empty_page',
          capture_started_at: expect.any(String),
          capture_completed_at: expect.any(String),
        },
      },
    })
    expect(mockPublishLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
  })

  it('preserves parser and RAW fallback persistence failures together', async () => {
    const parserError = new Error('parser contract mismatch')
    const persistenceError = new Error('RAW bucket unavailable')
    mockWriteRawObject.mockRejectedValueOnce(persistenceError)
    mockGetAdapter.mockReturnValue({
      captureLeaderboard: async () => capturedLeaderboard(),
      listLeaderboard: async function* () {
        throw new Error('legacy stream must not run')
      },
      parseLeaderboard: () => {
        throw parserError
      },
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
    expect((failure as AggregateError).errors).toEqual([parserError, persistenceError])
    expect(mockWriteLeaderboardRawArtifactSet).not.toHaveBeenCalled()
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
    expect(mockWriteLeaderboardRawArtifactSet).not.toHaveBeenCalled()
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

  it('orders each registered window begin → capture → RAW → finish → publish before the next begin', async () => {
    const events: string[] = []
    const rawReceipts: ReturnType<typeof attemptBoundRawReceipt>[] = []
    const captureLeaderboard = jest.fn(
      async (_session: unknown, _source: SourceRow, timeframe: RankingTimeframe) => {
        events.push(`capture:${timeframe}`)
        return capturedLeaderboard()
      }
    )
    configureAttemptBoundSource([7, 30], captureLeaderboard)
    let sequence = 41
    mockStartLeaderboardAcquisitionAttempt.mockImplementation(
      async (input: StartLeaderboardAcquisitionAttemptInput) => {
        events.push(`begin:${input.timeframe}`)
        return attemptFromStart(input, sequence++)
      }
    )
    mockOpenSession.mockImplementation(async () => {
      events.push('session:open')
      return { close: mockSessionClose }
    })
    mockSessionClose.mockImplementation(async () => {
      events.push('session:close')
    })
    mockWriteAttemptBoundLeaderboardRawArtifactSet.mockImplementation(
      async (input: {
        attempt: LeaderboardAcquisitionAttempt
        built: Parameters<typeof projectLeaderboardManifestV3Outcome>[1]
      }) => {
        events.push(`raw:${input.attempt.timeframe}`)
        const receipt = attemptBoundRawReceipt(input)
        rawReceipts.push(receipt)
        return receipt
      }
    )
    mockFinishLeaderboardAcquisitionAttempt.mockImplementation(
      async (input: {
        attempt: LeaderboardAcquisitionAttempt
        projection: { terminalState: string }
      }) => {
        events.push(`finish:${input.attempt.timeframe}`)
        return {
          attemptSeq: input.attempt.attemptSeq,
          terminalState: input.projection.terminalState,
          recordedCompletedAt: new Date().toISOString(),
          replayed: false,
        }
      }
    )
    mockPublishTrustedLeaderboardSnapshot.mockImplementation(
      async (input: { timeframe: RankingTimeframe }) => {
        events.push(`publish:${input.timeframe}`)
        return {
          snapshotId: 700 + input.timeframe,
          scrapedAt: '2026-07-21 10:00:04.000+00',
          verdict: { passed: true, baselineUsed: 1, deviationPct: 0 },
          published: true,
          traderIds: new Map([[row.exchangeTraderId, 42]]),
          trust: {
            sourceRunId: 'c'.repeat(64),
            observationsWritten: 2,
            artifactRefsWritten: 4,
            replayed: false,
          },
        }
      }
    )
    mockJobUpdateData.mockImplementation(async (data: TierJobData) => {
      events.push(`checkpoint:${data.completedTimeframes?.at(-1)}`)
    })

    await expect(processTierA(job)).resolves.toHaveLength(2)

    expect(events).toEqual([
      'begin:7',
      'session:open',
      'capture:7',
      'raw:7',
      'finish:7',
      'publish:7',
      'checkpoint:7',
      'begin:30',
      'capture:30',
      'raw:30',
      'finish:30',
      'publish:30',
      'checkpoint:30',
      'session:close',
    ])
    expect(mockOpenSession).toHaveBeenCalledTimes(1)
    expect(mockPublishLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockStartLeaderboardAcquisitionAttempt.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        sourceId: binanceSrc.id,
        timeframe: 7,
        observationCycleId: expectedCycleId,
        queueJobId: job.id,
        queueAttempt: job.attemptsMade,
        runnerGitSha: 'c'.repeat(40),
        workerRegion: 'local',
      }),
      expect.objectContaining({ timeframe: 30 }),
    ])
    for (const [
      index,
      [rawInput],
    ] of mockWriteAttemptBoundLeaderboardRawArtifactSet.mock.calls.entries()) {
      expect(rawInput.built.manifest.started_at).toBe(rawInput.attempt.recordedStartedAt)
      expect(rawInput.built.manifest.acquisition_attempt).toEqual({
        binding_contract: rawInput.attempt.attemptBindingContract,
        attempt_id: rawInput.attempt.attemptId,
        attempt_seq: rawInput.attempt.attemptSeq,
      })
      const [finishInput] = mockFinishLeaderboardAcquisitionAttempt.mock.calls[index]
      expect(finishInput).toMatchObject({
        kind: 'manifest',
        attempt: rawInput.attempt,
        sourcePayloadRawObjectId: rawReceipts[index].sourcePayload.id,
        manifestRawObjectId: rawReceipts[index].populationManifest.id,
      })
      expect(finishInput.projection).toBe(rawReceipts[index].projection)
    }
  })

  it('awaits manifest finalization before any registered-window publication or checkpoint', async () => {
    configureAttemptBoundSource()
    let signalFinishCalled!: () => void
    const finishCalled = new Promise<void>((resolve) => {
      signalFinishCalled = resolve
    })
    let resolveFinish!: (value: unknown) => void
    mockFinishLeaderboardAcquisitionAttempt.mockImplementation(
      (input: {
        attempt: LeaderboardAcquisitionAttempt
        projection: { terminalState: string }
      }) => {
        signalFinishCalled()
        return new Promise((resolve) => {
          resolveFinish = () =>
            resolve({
              attemptSeq: input.attempt.attemptSeq,
              terminalState: input.projection.terminalState,
              recordedCompletedAt: new Date().toISOString(),
              replayed: false,
            })
        })
      }
    )

    const pending = processTierA(job)
    await finishCalled
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockPublishLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockPublishBoardSeries).not.toHaveBeenCalled()
    expect(mockPublishBots).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()

    resolveFinish(undefined)
    await expect(pending).resolves.toHaveLength(1)
    expect(mockPublishTrustedLeaderboardSnapshot).toHaveBeenCalledTimes(1)
    expect(mockJobUpdateData).toHaveBeenCalledTimes(1)
  })

  it('fails before upstream I/O when a registered source cannot prove its runner SHA', async () => {
    configureAttemptBoundSource()
    mockResolveDeployedSha.mockReturnValue('unknown-deployment')

    await expect(processTierA(job)).rejects.toThrow('requires an exact deployed runner SHA')
    expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
    expect(mockOpenSession).not.toHaveBeenCalled()
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).not.toHaveBeenCalled()
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
  })

  it('fails before begin or upstream I/O when the actual worker region is not configured', async () => {
    configureAttemptBoundSource()
    delete process.env.INGEST_LOCAL_REGION

    await expect(processTierA(job)).rejects.toThrow(
      'attempt-bound capture requires an explicit INGEST_LOCAL_REGION'
    )
    expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
    expect(mockOpenSession).not.toHaveBeenCalled()
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).not.toHaveBeenCalled()
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
  })

  it('does not open a session when the first registered-window begin fails', async () => {
    configureAttemptBoundSource([7, 30])
    const beginFailure = new Error('ledger unavailable')
    mockStartLeaderboardAcquisitionAttempt.mockRejectedValue(beginFailure)

    await expect(processTierA(job)).rejects.toThrow('attempt start failed: ledger unavailable')
    expect(mockStartLeaderboardAcquisitionAttempt).toHaveBeenCalledTimes(1)
    expect(mockOpenSession).not.toHaveBeenCalled()
    expect(mockFinishLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).not.toHaveBeenCalled()
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
  })

  it('terminally records first-session failure without beginning a later window', async () => {
    configureAttemptBoundSource([7, 30])
    mockOpenSession.mockRejectedValue(new Error('browser unavailable'))
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(processTierA(job)).rejects.toThrow('browser unavailable')
    } finally {
      errorSpy.mockRestore()
    }

    expect(mockStartLeaderboardAcquisitionAttempt).toHaveBeenCalledTimes(1)
    expect(mockFinishLeaderboardAcquisitionAttempt).toHaveBeenCalledTimes(1)
    expect(mockFinishLeaderboardAcquisitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'processing_failed',
        captureCompletedAt: null,
        diagnosticRawObjectId: null,
        failureStage: 'session_open',
        reasonCode: 'upstream_unavailable',
      })
    )
    expect(mockSessionClose).not.toHaveBeenCalled()
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).not.toHaveBeenCalled()
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
  })

  it('records RAW persistence failure once and stops before later windows', async () => {
    configureAttemptBoundSource([30, 90])
    const rawFailure = new Error('Storage unavailable')
    mockWriteAttemptBoundLeaderboardRawArtifactSet.mockRejectedValue(rawFailure)
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    let failure: unknown
    try {
      await processTierA(job)
    } catch (cause) {
      failure = cause
    } finally {
      errorSpy.mockRestore()
    }

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toStrictEqual([rawFailure])
    expect(mockStartLeaderboardAcquisitionAttempt).toHaveBeenCalledTimes(1)
    expect(mockFinishLeaderboardAcquisitionAttempt).toHaveBeenCalledTimes(1)
    expect(mockFinishLeaderboardAcquisitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'processing_failed',
        failureStage: 'raw_persistence',
        reasonCode: 'raw_persistence_failed',
      })
    )
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
  })

  it('never retries terminal finalization or publishes when manifest finish is unresolved', async () => {
    configureAttemptBoundSource([30, 90])
    const finishFailure = new Error('finish exact replay unresolved')
    mockFinishLeaderboardAcquisitionAttempt.mockRejectedValue(finishFailure)

    let failure: unknown
    try {
      await processTierA(job)
    } catch (cause) {
      failure = cause
    }

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([finishFailure])
    expect(mockFinishLeaderboardAcquisitionAttempt).toHaveBeenCalledTimes(1)
    expect(mockStartLeaderboardAcquisitionAttempt).toHaveBeenCalledTimes(1)
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
  })

  it('preserves the upstream failure when its unknown-manifest finalization also fails', async () => {
    let upstream: LeaderboardCaptureUpstreamError | null = null
    const captureLeaderboard = jest.fn(async () => {
      const failedRawPage: RawPage = {
        ...page,
        payload: { error: 'service unavailable' },
        fetchedAt: new Date().toISOString(),
      }
      const failedCapture = capturedLeaderboard({
        sourcePages: [
          {
            rawPage: failedRawPage,
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
      upstream = new LeaderboardCaptureUpstreamError(
        503,
        failedRawPage.url,
        failedCapture,
        new Error('service unavailable')
      )
      throw upstream
    })
    const finishFailure = new Error('terminal ledger unavailable')
    configureAttemptBoundSource([30, 90], captureLeaderboard, [])
    mockFinishLeaderboardAcquisitionAttempt.mockRejectedValue(finishFailure)

    let failure: unknown
    try {
      await processTierA(job)
    } catch (cause) {
      failure = cause
    }

    expect(failure).toBeInstanceOf(AggregateError)
    expect(upstream).not.toBeNull()
    expect((failure as AggregateError).errors).toStrictEqual([upstream!, finishFailure])
    expect(mockFinishLeaderboardAcquisitionAttempt).toHaveBeenCalledTimes(1)
    expect(mockStartLeaderboardAcquisitionAttempt).toHaveBeenCalledTimes(1)
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
  })

  it.each([
    [
      'partial',
      'partial',
      'pagination_partial',
      () => {
        const complete = capturedLeaderboard()
        return {
          ...complete,
          sourcePages: [
            {
              ...complete.sourcePages[0],
              sourceReports: {
                ...complete.sourcePages[0].sourceReports,
                population: { state: 'reported' as const, value: 2 },
              },
            },
          ],
          parsePages: [complete.sourcePages[0].rawPage],
          terminationReason: 'caller_limit' as const,
          captureConfig: { caller_page_cap: 1, safety_page_cap: 5_000 },
          parserTransformation: {
            kind: 'identity_projection' as const,
            source_page_ordinals: [1],
          },
        }
      },
    ],
    [
      'unknown',
      'unknown',
      'population_unknown',
      () => {
        const complete = capturedLeaderboard()
        const first = complete.sourcePages[0]
        return {
          ...complete,
          sourcePages: [
            {
              ...first,
              sourceReports: {
                population: { state: 'not_reported' as const },
                page_count: { state: 'not_reported' as const },
                current_page: { state: 'not_reported' as const },
                page_size: { state: 'not_reported' as const },
              },
            },
          ],
          parsePages: [first.rawPage],
          terminationReason: 'short_page' as const,
          parserTransformation: {
            kind: 'identity_projection' as const,
            source_page_ordinals: [1],
          },
        }
      },
    ],
  ] as const)(
    'records a %s manifest terminal but never ranks it',
    async (_label, terminalState, reasonCode, captureFactory) => {
      configureAttemptBoundSource(
        [30],
        jest.fn(async () => captureFactory() as LeaderboardCapture)
      )
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

      try {
        await expect(processTierA(job)).rejects.toBeInstanceOf(AggregateError)
      } finally {
        errorSpy.mockRestore()
      }

      const [finishInput] = mockFinishLeaderboardAcquisitionAttempt.mock.calls[0]
      expect(finishInput.kind).toBe('manifest')
      expect(finishInput.projection).toMatchObject({ terminalState, reasonCode })
      expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
      expect(mockPublishLeaderboardSnapshot).not.toHaveBeenCalled()
      expect(mockPublishBoardSeries).not.toHaveBeenCalled()
      expect(mockPublishBots).not.toHaveBeenCalled()
      expect(mockJobUpdateData).not.toHaveBeenCalled()
    }
  )

  it('binds parser-failure diagnostic RAW to the attempt before terminal failure', async () => {
    const parserCapture = capturedLeaderboard()
    const captureLeaderboard = jest.fn(async () => parserCapture)
    configureAttemptBoundSource([30], captureLeaderboard)
    const parserFailure = new Error('parser contract drift')
    mockGetAdapter.mockReturnValue({
      captureLeaderboard,
      listLeaderboard: async function* () {
        throw new Error('registered source must not use legacy stream')
      },
      parseLeaderboard: () => {
        throw parserFailure
      },
      parseLeaderboardSeries: () => new Map(),
    })
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(processTierA(job)).rejects.toBeInstanceOf(AggregateError)
    } finally {
      errorSpy.mockRestore()
    }

    const [diagnosticInput] = mockWriteRawObject.mock.calls[0]
    const [finishInput] = mockFinishLeaderboardAcquisitionAttempt.mock.calls[0]
    expect(diagnosticInput).toStrictEqual({
      sourceId: binanceSrc.id,
      sourceSlug: binanceSrc.slug,
      jobType: 'tier_a_failure',
      timeframe: 30,
      payload: parserCapture.sourcePages.map((sourcePage) => sourcePage.rawPage),
      serialization: STRICT_CANONICAL_JSON_CONTRACT,
      meta: {
        pageCount: parserCapture.sourcePages.length,
        observation_cycle_id: expectedCycleId,
        acquisition_attempt: {
          binding_contract: finishInput.attempt.attemptBindingContract,
          attempt_id: finishInput.attempt.attemptId,
          attempt_seq: finishInput.attempt.attemptSeq,
          runner_git_sha: 'c'.repeat(40),
          capture_started_at: finishInput.attempt.recordedStartedAt,
          capture_completed_at: finishInput.captureCompletedAt,
        },
        trust_evidence: {
          state: 'unknown',
          rank_eligible: false,
          failure_stage: 'parse_validate_or_manifest',
          termination_reason: parserCapture.terminationReason,
          capture_started_at: finishInput.attempt.recordedStartedAt,
          capture_completed_at: finishInput.captureCompletedAt,
        },
      },
    })
    expect(finishInput).toMatchObject({
      kind: 'processing_failed',
      diagnosticRawObjectId: 9001,
      failureStage: 'parse_validate_manifest',
      reasonCode: 'parse_failed',
    })
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).not.toHaveBeenCalled()
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
  })

  it('starts only pending registered windows on resume', async () => {
    configureAttemptBoundSource([7, 30, 90])
    job = makeJob({ sourceSlug: binanceSrc.slug, completedTimeframes: [7] })
    expectedCycleId = `tier-a:${binanceSrc.slug}:${job.id}:${job.timestamp}`

    await expect(processTierA(job)).resolves.toHaveLength(2)

    expect(
      mockStartLeaderboardAcquisitionAttempt.mock.calls.map(([input]) => input.timeframe)
    ).toEqual([30, 90])
    expect(mockJobUpdateData.mock.calls.map(([data]) => data.completedTimeframes)).toEqual([
      [7, 30],
      [7, 30, 90],
    ])
  })

  it('does not infer @3 eligibility from a shared Binance adapter method', async () => {
    const spotSrc = { ...binanceSrc, id: 2, slug: 'binance_spot' } as SourceRow
    job = makeJob({ sourceSlug: spotSrc.slug })
    mockGetSourceBySlug.mockResolvedValue(spotSrc)
    mockHasRegisteredAttemptBoundContract.mockResolvedValue(false)
    mockGetAdapter.mockReturnValue({
      captureLeaderboard: async () => capturedLeaderboard(),
      listLeaderboard: async function* () {
        throw new Error('capture path should handle this fixture')
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
      parseLeaderboardSeries: () => new Map(),
    })

    await expect(processTierA(job)).resolves.toHaveLength(1)

    expect(mockHasRegisteredAttemptBoundContract).toHaveBeenCalledWith({
      sourceId: spotSrc.id,
      adapterSlug: 'binance',
    })
    expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).not.toHaveBeenCalled()
    expect(mockWriteLeaderboardRawArtifactSet).toHaveBeenCalledTimes(1)
  })

  it('finishes each evidence-less upstream failure before beginning the next window', async () => {
    const events: string[] = []
    const captureLeaderboard = jest.fn(
      async (_session: unknown, _source: SourceRow, timeframe: RankingTimeframe) => {
        events.push(`capture:${timeframe}`)
        throw new Error(`upstream unavailable ${timeframe}`)
      }
    )
    configureAttemptBoundSource([30, 90], captureLeaderboard)
    let sequence = 41
    mockStartLeaderboardAcquisitionAttempt.mockImplementation(
      async (input: StartLeaderboardAcquisitionAttemptInput) => {
        events.push(`begin:${input.timeframe}`)
        return attemptFromStart(input, sequence++)
      }
    )
    let signalFirstFinishCalled!: () => void
    const firstFinishCalled = new Promise<void>((resolve) => {
      signalFirstFinishCalled = resolve
    })
    let resolveFirstFinish!: () => void
    mockFinishLeaderboardAcquisitionAttempt.mockImplementation(
      (input: { attempt: LeaderboardAcquisitionAttempt }) => {
        events.push(`finish:${input.attempt.timeframe}`)
        const result = {
          attemptSeq: input.attempt.attemptSeq,
          terminalState: 'processing_failed',
          recordedCompletedAt: new Date().toISOString(),
          replayed: false,
        }
        if (input.attempt.timeframe !== 30) return Promise.resolve(result)
        signalFirstFinishCalled()
        return new Promise((resolve) => {
          resolveFirstFinish = () => resolve(result)
        })
      }
    )
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const pending = processTierA(job)
      await firstFinishCalled
      expect(events).toEqual(['begin:30', 'capture:30', 'finish:30'])
      expect(mockStartLeaderboardAcquisitionAttempt).toHaveBeenCalledTimes(1)
      resolveFirstFinish()
      await expect(pending).rejects.toBeInstanceOf(AggregateError)
    } finally {
      errorSpy.mockRestore()
    }

    expect(events).toEqual([
      'begin:30',
      'capture:30',
      'finish:30',
      'begin:90',
      'capture:90',
      'finish:90',
    ])
    expect(mockFinishLeaderboardAcquisitionAttempt.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        kind: 'processing_failed',
        captureCompletedAt: null,
        failureStage: 'upstream_fetch',
        reasonCode: 'unknown_failure',
      }),
      expect.objectContaining({
        kind: 'processing_failed',
        captureCompletedAt: null,
        failureStage: 'upstream_fetch',
        reasonCode: 'unknown_failure',
      }),
    ])
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).not.toHaveBeenCalled()
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
  })

  it('records a structured upstream HTTP failure as an unknown manifest terminal', async () => {
    let upstream: LeaderboardCaptureUpstreamError | null = null
    const captureLeaderboard = jest.fn(async () => {
      const failedRawPage: RawPage = {
        ...page,
        payload: { error: 'service unavailable' },
        fetchedAt: new Date().toISOString(),
      }
      const failedCapture = capturedLeaderboard({
        sourcePages: [
          {
            rawPage: failedRawPage,
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
      upstream = new LeaderboardCaptureUpstreamError(
        503,
        failedRawPage.url,
        failedCapture,
        new Error('service unavailable')
      )
      throw upstream
    })
    configureAttemptBoundSource([30], captureLeaderboard, [])
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    let failure: unknown
    try {
      await processTierA(job)
    } catch (cause) {
      failure = cause
    } finally {
      errorSpy.mockRestore()
    }

    expect(failure).toBeInstanceOf(AggregateError)
    expect(upstream).not.toBeNull()
    expect(((failure as AggregateError).errors[0] as Error & { cause?: unknown }).cause).toBe(
      upstream!
    )
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).toHaveBeenCalledTimes(1)
    expect(mockFinishLeaderboardAcquisitionAttempt).toHaveBeenCalledTimes(1)
    expect(mockFinishLeaderboardAcquisitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'manifest',
        projection: expect.objectContaining({
          terminalState: 'unknown',
          reasonCode: 'upstream_http_error',
        }),
      })
    )
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
  })

  it.each([
    [
      'validation',
      'validation_failed',
      () => {
        mockValidateLeaderboardRows.mockImplementation(() => {
          throw new Error('validator contract drift')
        })
      },
    ],
    [
      'manifest',
      'manifest_failed',
      () => {
        const captureLeaderboard = jest.fn(async () => {
          const capture = capturedLeaderboard()
          const invalidPage = {
            ...capture.sourcePages[0].rawPage,
            fetchedAt: 'not-a-timestamp',
          }
          return {
            ...capture,
            sourcePages: [
              {
                ...capture.sourcePages[0],
                rawPage: invalidPage,
              },
            ],
            parsePages: [invalidPage],
            parserTransformation: {
              kind: 'identity_projection' as const,
              source_page_ordinals: [1],
            },
          }
        })
        configureAttemptBoundSource([30], captureLeaderboard)
      },
    ],
  ] as const)(
    'records %s failure with its exact diagnostic reason',
    async (_label, reasonCode, setupFailure) => {
      configureAttemptBoundSource()
      setupFailure()
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

      try {
        await expect(processTierA(job)).rejects.toBeInstanceOf(AggregateError)
      } finally {
        errorSpy.mockRestore()
      }

      expect(mockWriteRawObject).toHaveBeenCalledWith(
        expect.objectContaining({ jobType: 'tier_a_failure' })
      )
      expect(mockFinishLeaderboardAcquisitionAttempt).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'processing_failed',
          diagnosticRawObjectId: 9001,
          failureStage: 'parse_validate_manifest',
          reasonCode,
        })
      )
      expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).not.toHaveBeenCalled()
      expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
    }
  )

  it('refuses an unreviewed metric fallback after the attempt is terminal', async () => {
    configureAttemptBoundSource()
    mockHasRegisteredLeaderboardMetricTrust.mockReturnValue(false)
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(processTierA(job)).rejects.toThrow('1/1 native windows failed')
    } finally {
      errorSpy.mockRestore()
    }

    expect(mockFinishLeaderboardAcquisitionAttempt).toHaveBeenCalledTimes(1)
    expect(mockFinishLeaderboardAcquisitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'manifest' })
    )
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockPublishLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
  })

  it('does not rewrite a complete acquisition terminal when checkpoint persistence fails', async () => {
    configureAttemptBoundSource([30, 90])
    mockJobUpdateData.mockRejectedValue(new Error('redis unavailable'))
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(processTierA(job)).rejects.toThrow(
        'checkpoint persistence failed for binance_futures 30d: redis unavailable'
      )
    } finally {
      errorSpy.mockRestore()
    }

    expect(mockFinishLeaderboardAcquisitionAttempt).toHaveBeenCalledTimes(1)
    expect(mockFinishLeaderboardAcquisitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'manifest' })
    )
    expect(mockStartLeaderboardAcquisitionAttempt).toHaveBeenCalledTimes(1)
    expect(mockPublishTrustedLeaderboardSnapshot).toHaveBeenCalledTimes(1)
  })

  it('hard-fails registry/code drift before begin or session acquisition', async () => {
    job = makeJob({ sourceSlug: binanceSrc.slug })
    mockGetSourceBySlug.mockResolvedValue(binanceSrc)
    mockHasRegisteredAttemptBoundContract.mockResolvedValue(true)
    mockGetAdapter.mockReturnValue({
      listLeaderboard: async function* () {
        yield page
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
    })

    await expect(processTierA(job)).rejects.toThrow('adapter has no capture implementation')
    expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
    expect(mockOpenSession).not.toHaveBeenCalled()
    expect(mockWriteRawObject).not.toHaveBeenCalled()
    expect(mockPublishLeaderboardSnapshot).not.toHaveBeenCalled()
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
