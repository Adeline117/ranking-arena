import type { Job } from 'bullmq'
import type { ParsedLeaderboardRow, RawPage, SourceRow } from '@/lib/ingest/core/types'
import {
  LeaderboardCaptureUpstreamError,
  captureNumericLeaderboard,
  type LeaderboardCapture,
  type PartitionedNumericLeaderboardCapture,
} from '@/lib/ingest/fetch/capture'
import type { FetchSession } from '@/lib/ingest/fetch/types'
import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalSha256,
} from '@/lib/ingest/strict-canonical-json'
import {
  ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
  ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
  LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
  projectLeaderboardManifestV3Outcome,
  projectLeaderboardManifestV4Outcome,
  type LeaderboardAcquisitionAttempt,
  type StartLeaderboardAcquisitionAttemptInput,
} from '@/lib/ingest/acquisition-attempts'
import {
  LEADERBOARD_PARTITIONED_NUMERIC_AGGREGATION_CONTRACT,
  LEADERBOARD_PARTITIONED_NUMERIC_PARSER_PAGE_CONTRACT,
  projectPartitionedNumericParserPage,
} from '@/lib/ingest/acquisition-manifest'
import { LEADERBOARD_EXHAUSTION_COMPLETENESS_CONTRACT } from '@/lib/ingest/acquisition-exhaustion'
import type { TierJobData } from '../../queues'

const mockGetSourceBySlug = jest.fn()
const mockNativeRankingTimeframes = jest.fn()
const mockGetAdapter = jest.fn()
const mockOpenSession = jest.fn()
const mockSessionClose = jest.fn()
const mockWriteRawObject = jest.fn()
const mockWriteAttemptBoundLeaderboardRawArtifactSet = jest.fn()
const mockFindRegisteredAttemptBoundContract = jest.fn()
const mockStartLeaderboardAcquisitionAttempt = jest.fn()
const mockFinishLeaderboardAcquisitionAttempt = jest.fn()
const mockRecordFieldInventory = jest.fn()
const mockValidateLeaderboardRows = jest.fn()
const mockPublishTrustedLeaderboardSnapshot = jest.fn()
const mockPublishAttemptBoundLeaderboardSnapshot = jest.fn()
const mockHasRegisteredLeaderboardMetricTrust = jest.fn()
const mockPublishFencedBoardSeries = jest.fn()
const mockJobUpdateData = jest.fn()
const mockDirectJobUpdateData = jest.fn()
const mockClaimSourceJobExecutionAuthority = jest.fn()
const mockExecutionAssertActive = jest.fn()
const mockExecutionClose = jest.fn()
const mockExecutionWithClaimedWrite = jest.fn()
const mockBullReplaceDataIfOwned = jest.fn()
const mockClaimedWriteClient = Object.freeze({ query: jest.fn() })
const mockAttemptTransaction = jest.fn()
const mockRawPointerTransaction = jest.fn()
const mockFieldInventoryTransaction = jest.fn()
const mockPublicationExecution = jest.fn()
const mockGetExecutionWindowReceipt = jest.fn()
const mockRecordExecutionWindowReceipt = jest.fn()
const mockReceiptWriterTransaction = jest.fn()
const mockRecordRepublishReceipt = jest.fn()
const mockHasRepublishReceipt = jest.fn()
const mockFindLatestTierAWindowAttempt = jest.fn()
const mockReadTrustRaw = jest.fn()
const mockMaxFreshnessMs = jest.fn()

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
  LeaderboardTrustRawReadError: class MockLeaderboardTrustRawReadError extends Error {
    failure: 'unreadable' | 'hash_mismatch'
    constructor(failure: 'unreadable' | 'hash_mismatch') {
      super(`mock trust RAW read failed (${failure})`)
      this.failure = failure
    }
  },
  readAttemptBoundLeaderboardTrustRawPayload: async (
    input: unknown,
    runTransaction: (operation: (transaction: unknown) => Promise<unknown>) => Promise<unknown>
  ) => {
    await runTransaction(async (transaction: unknown) => {
      mockRawPointerTransaction('trust-read', transaction)
    })
    return mockReadTrustRaw(input)
  },
  writeRawObject: async (
    input: unknown,
    runTransaction?: (operation: (transaction: unknown) => Promise<unknown>) => Promise<unknown>
  ) => {
    const result = await mockWriteRawObject(input)
    if (runTransaction) {
      await runTransaction(async (transaction: unknown) => {
        mockRawPointerTransaction('raw', transaction)
      })
    }
    return result
  },
  writeAttemptBoundLeaderboardRawArtifactSet: async (
    input: unknown,
    runTransaction?: (operation: (transaction: unknown) => Promise<unknown>) => Promise<unknown>
  ) => {
    const result = await mockWriteAttemptBoundLeaderboardRawArtifactSet(input)
    if (runTransaction) {
      await runTransaction(async (transaction: unknown) => {
        mockRawPointerTransaction('attempt-artifact', transaction)
      })
    }
    return result
  },
}))
jest.mock('@/lib/ingest/acquisition-attempts', () => {
  const actual = jest.requireActual('@/lib/ingest/acquisition-attempts')
  return {
    ...actual,
    findRegisteredAttemptBoundLeaderboardAcquisitionContract: (...args: unknown[]) =>
      mockFindRegisteredAttemptBoundContract(...args),
    startLeaderboardAcquisitionAttemptInTransaction: (
      transaction: unknown,
      execution: unknown,
      input: unknown
    ) => {
      mockAttemptTransaction('start', transaction, execution)
      return mockStartLeaderboardAcquisitionAttempt(input)
    },
    finishLeaderboardAcquisitionAttemptInTransaction: (
      transaction: unknown,
      execution: unknown,
      input: unknown
    ) => {
      mockAttemptTransaction('finish', transaction, execution)
      return mockFinishLeaderboardAcquisitionAttempt(input)
    },
  }
})
jest.mock('@/lib/ingest/field-inventory', () => ({
  recordFieldInventoryWithExecutor: (transaction: unknown, ...args: unknown[]) => {
    mockFieldInventoryTransaction(transaction)
    return mockRecordFieldInventory(...args)
  },
}))
jest.mock('@/lib/ingest/staging/validate', () => ({
  validateLeaderboardRows: (...args: unknown[]) => mockValidateLeaderboardRows(...args),
}))
jest.mock('@/worker/src/ingest/fenced-tier-a-publication', () => ({
  publishClaimedBoardSeries: (
    src: unknown,
    series: unknown,
    traderIds: unknown,
    context: unknown,
    execution: unknown,
    options: unknown,
    _signal?: unknown
  ) => {
    mockPublicationExecution('series', execution)
    return mockPublishFencedBoardSeries(src, series, traderIds, context, options)
  },
  publishClaimedTrustedLeaderboardSnapshot: (
    input: unknown,
    context: unknown,
    execution: unknown,
    _signal?: unknown
  ) => {
    mockPublicationExecution('trusted-snapshot', execution)
    return mockPublishTrustedLeaderboardSnapshot(input, context)
  },
  publishClaimedAttemptBoundLeaderboardSnapshot: (
    input: unknown,
    context: unknown,
    execution: unknown,
    _signal?: unknown
  ) => {
    mockPublicationExecution('attempt-snapshot', execution)
    return mockPublishAttemptBoundLeaderboardSnapshot(input, context)
  },
}))
jest.mock('@/lib/ingest/serving/metric-trust-publish', () => ({
  hasRegisteredLeaderboardMetricTrust: (...args: unknown[]) =>
    mockHasRegisteredLeaderboardMetricTrust(...args),
  registeredLeaderboardMetricMaxFreshnessMs: (...args: unknown[]) => mockMaxFreshnessMs(...args),
}))
jest.mock('@/worker/src/ingest/tier-a-window-republish', () => {
  const actual = jest.requireActual('@/worker/src/ingest/tier-a-window-republish')
  return {
    ...actual,
    findLatestTierAWindowAttempt: (...args: unknown[]) => mockFindLatestTierAWindowAttempt(...args),
  }
})
const mockNoteTierAPublished = jest.fn()
jest.mock('@/worker/src/ingest/progress', () => ({
  noteTierAPublished: () => mockNoteTierAPublished(),
}))
jest.mock('@/worker/src/ingest/source-job-execution-authority', () => ({
  claimSourceJobExecutionAuthority: (...args: unknown[]) =>
    mockClaimSourceJobExecutionAuthority(...args),
}))
jest.mock('@/worker/src/ingest/tier-a-execution-window-receipt', () => {
  class MockTierAExecutionWindowReceiptError extends Error {}
  return {
    TierAExecutionWindowReceiptError: MockTierAExecutionWindowReceiptError,
    getTierAExecutionWindowReceipt: (...args: unknown[]) => mockGetExecutionWindowReceipt(...args),
    withTierAExecutionReceiptWriter: async (
      transaction: unknown,
      binding: unknown,
      callback: (writer: unknown) => Promise<unknown>
    ) => {
      mockReceiptWriterTransaction(transaction, binding)
      return callback(Object.freeze({ transaction, binding }))
    },
    recordTierAExecutionWindowReceipt: (...args: unknown[]) =>
      mockRecordExecutionWindowReceipt(...args),
    recordTierAExecutionWindowRepublishReceipt: (...args: unknown[]) =>
      mockRecordRepublishReceipt(...args),
    hasTierAExecutionWindowRepublishReceipt: (...args: unknown[]) =>
      mockHasRepublishReceipt(...args),
  }
})

import { processTierA as processTierAWithAuthority } from '../tier-a-leaderboard'
import {
  createConsumedRegionContext,
  type AuthorizedConsumedRegionContext,
} from '../../consumed-region-context'
import type { SourceJobRunProvenance } from '../../source-job-routing'

function createAuthorizedTestContext(
  consumedRegion: 'local' | 'vps_sg',
  executionRegion: 'local' | 'vps_sg'
): AuthorizedConsumedRegionContext {
  return {
    ...createConsumedRegionContext(consumedRegion, executionRegion),
    assertCanConsume: jest.fn(),
    authority: {} as never,
  }
}

function testProvenance(job: Job<TierJobData>): SourceJobRunProvenance {
  return Object.freeze({
    bullJob: Object.freeze({
      proof: Object.freeze({
        contract: 'arena.ingest.bull-job-provenance@1' as const,
        queueName: 'arena-ingest',
        jobId: String(job.id),
        jobName: 'tiera:leaderboard',
        attemptsMade: job.attemptsMade,
        attemptsStarted: job.attemptsMade + 1,
        processorTokenSha256: 'a'.repeat(64),
      }),
      assertActive: jest.fn(),
      extendLock: jest.fn(async () => undefined),
      replaceDataIfOwned: async (nextData: unknown) => {
        await mockBullReplaceDataIfOwned(nextData)
        job.data = nextData as TierJobData
      },
    }),
    sourceLease: {} as SourceJobRunProvenance['sourceLease'],
  })
}

const processTierAInRegion = (
  job: Job<TierJobData>,
  context: AuthorizedConsumedRegionContext,
  signal?: AbortSignal
) => processTierAWithAuthority(job, context, testProvenance(job), signal)

const processTierA = (job: Job<TierJobData>) => {
  const region = job.data.sourceSlug.startsWith('binance_') ? 'vps_sg' : 'local'
  return processTierAInRegion(job, createAuthorizedTestContext(region, region))
}

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
  fetch_region: 'local',
} as SourceRow

const binanceSrc = {
  ...src,
  id: 1,
  slug: 'binance_futures',
  adapter_slug: 'binance',
  fetch_region: 'vps_sg',
  serving_mode: 'serving',
} as SourceRow

const bitgetBotsSrc = {
  ...src,
  id: 27,
  slug: 'bitget_bots_spot',
  adapter_slug: 'bitget_bots',
  product_type: 'spot',
  page_size: 20,
  trader_kind_scope: 'bot',
  serving_mode: 'serving',
  meta: { boards: ['spot_grid', 'spot_martingale'] },
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

function exhaustedLeaderboardCapture(): LeaderboardCapture {
  const fetchedAt = new Date().toISOString()
  const rawPage = { ...page, fetchedAt }
  const requestSha256 = 'a'.repeat(64)
  const responseSha256 = strictCanonicalSha256(rawPage.payload)
  const rowKeysSha256 = strictCanonicalSha256(['xt-1'])
  return {
    sourcePages: [
      {
        rawPage,
        sourceRowCount: 1,
        requestSha256,
        httpStatus: 200,
        paginationPosition: { kind: 'page_index', request_page_index: 1 },
        sourceReports: {
          population: { state: 'not_reported' },
          page_count: { state: 'not_reported' },
          current_page: { state: 'not_reported' },
          page_size: { state: 'not_reported' },
        },
      },
    ],
    parsePages: [rawPage],
    terminationReason: 'short_page',
    captureConfig: { caller_page_cap: null, safety_page_cap: 5_000 },
    parserTransformation: { kind: 'identity_projection', source_page_ordinals: [1] },
    completeness: {
      data_contract: LEADERBOARD_EXHAUSTION_COMPLETENESS_CONTRACT,
      declaration: {
        completeness_mode: 'exhausted',
        list_path: ['result', 'items'],
        row_key_path: ['accountId'],
        end_signal: { kind: 'short_page' },
        board_version: { kind: 'first_page_reread' },
        max_duplicate_rows: 0,
      },
      pages: [
        {
          ordinal: 1,
          request_sha256: requestSha256,
          response_sha256: responseSha256,
          row_count: 1,
          row_keys_sha256: rowKeysSha256,
          end_signal_value: null,
          version_token_sha256: null,
        },
      ],
      row_keys: { observed: 1, distinct: 1, duplicate: 0 },
      board_version: {
        kind: 'first_page_reread',
        reread: {
          request_sha256: requestSha256,
          response_sha256: responseSha256,
          http_status: 200,
          row_keys_sha256: rowKeysSha256,
        },
      },
    },
  }
}

function capturedLeaderboardWithPageRows(pageRows: string[][]): LeaderboardCapture {
  const fetchedAt = new Date().toISOString()
  const reportedPopulation = pageRows.reduce((total, rows) => total + rows.length, 0)
  const rawPages = pageRows.map((accounts, index) => ({
    ...page,
    pageIndex: index + 1,
    payload: { result: { items: accounts.map((accountId) => ({ accountId })) } },
    url: `https://xt.test/leader-list?page=${index + 1}`,
    fetchedAt,
  }))
  return capturedLeaderboard({
    sourcePages: rawPages.map((rawPage, index) => ({
      rawPage,
      sourceRowCount: pageRows[index].length,
      requestSha256: String(index + 1).repeat(64),
      httpStatus: 200,
      paginationPosition: { kind: 'page_index', request_page_index: index + 1 },
      sourceReports: {
        population: { state: 'reported', value: reportedPopulation },
        page_count: { state: 'not_reported' },
        current_page: { state: 'not_reported' },
        page_size: { state: 'not_reported' },
      },
    })),
    parsePages: rawPages,
    terminationReason: 'reported_population_reached',
    parserTransformation: {
      kind: 'identity_projection',
      source_page_ordinals: rawPages.map((_, index) => index + 1),
    },
  })
}

function partitionedLeaderboardCapture(pageSize = 20): PartitionedNumericLeaderboardCapture {
  const fetchedAt = new Date().toISOString()
  const partitionIds = ['spot_grid', 'spot_martingale']
  const pageRows = [['grid-1', 'grid-2'], [], ['martingale-1'], []]
  const partitionPositions = [
    { partitionOrdinal: 1, partitionId: 'spot_grid', requestPageIndex: 1 },
    { partitionOrdinal: 1, partitionId: 'spot_grid', requestPageIndex: 2 },
    { partitionOrdinal: 2, partitionId: 'spot_martingale', requestPageIndex: 1 },
    { partitionOrdinal: 2, partitionId: 'spot_martingale', requestPageIndex: 2 },
  ] as const
  const sourcePages = pageRows.map((ids, index) => {
    const position = partitionPositions[index]
    const rawPage: RawPage = {
      pageIndex: index + 1,
      payload: { items: ids },
      url: `https://bitget.test/${position.partitionId}?page=${position.requestPageIndex}`,
      fetchedAt,
    }
    return {
      rawPage,
      sourceRowCount: ids.length,
      requestSha256: String(index + 1).repeat(64),
      httpStatus: 200,
      paginationPosition: {
        kind: 'partitioned_page_index' as const,
        partition_ordinal: position.partitionOrdinal,
        partition_id: position.partitionId,
        request_page_index: position.requestPageIndex,
      },
      sourceReports: {
        population: {
          state: 'reported' as const,
          value: position.partitionId === 'spot_grid' ? 2 : 1,
        },
        page_count: { state: 'not_reported' as const },
        current_page: { state: 'reported' as const, value: position.requestPageIndex },
        page_size: { state: 'not_reported' as const },
      },
    }
  })
  const parserSourceOrdinals = [1, 3]
  const pageBindings = parserSourceOrdinals.map((sourcePageOrdinal) => {
    const position = sourcePages[sourcePageOrdinal - 1].paginationPosition
    return {
      source_page_ordinal: sourcePageOrdinal,
      partition_ordinal: position.partition_ordinal,
      partition_id: position.partition_id,
      request_page_index: position.request_page_index,
      request_page_size: pageSize,
    }
  })
  return {
    sourcePages,
    parsePages: parserSourceOrdinals.map((sourcePageOrdinal, index) =>
      projectPartitionedNumericParserPage(
        sourcePages[sourcePageOrdinal - 1].rawPage,
        pageBindings[index]
      )
    ),
    terminationReason: 'reported_population_reached',
    captureConfig: { caller_page_cap: null, safety_page_cap: 10 },
    parserTransformation: {
      kind: 'partitioned_numeric_projection',
      source_page_ordinals: parserSourceOrdinals,
      algorithm_contract: LEADERBOARD_PARTITIONED_NUMERIC_PARSER_PAGE_CONTRACT,
      page_bindings: pageBindings,
    },
    paginationTopology: {
      kind: 'partitioned_numeric',
      aggregation_contract: LEADERBOARD_PARTITIONED_NUMERIC_AGGREGATION_CONTRACT,
      rank_scope: 'partition_local_concatenated_for_storage',
      expected_partition_ids: partitionIds,
      partitions: [
        {
          partition_id: 'spot_grid',
          source_page_ordinals: [1, 2],
          parser_page_ordinals: [1],
          termination_reason: 'reported_population_reached',
          capture_config: { caller_page_cap: null, safety_page_cap: 5 },
        },
        {
          partition_id: 'spot_martingale',
          source_page_ordinals: [3, 4],
          parser_page_ordinals: [2],
          termination_reason: 'reported_population_reached',
          capture_config: { caller_page_cap: null, safety_page_cap: 5 },
        },
      ],
    },
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
      return mockDirectJobUpdateData(nextData)
    },
  }
  return testJob as unknown as Job<TierJobData>
}

// The source the current test's attempts are recorded for (every Tier-A
// window is attempt-bound).
let activeSource: SourceRow = src

function attemptFromStart(
  input: StartLeaderboardAcquisitionAttemptInput,
  sequence: number,
  source: SourceRow = activeSource
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

/** Each attempt-bound RAW write, projected to its manifest-level fields. */
function attemptBoundRawWrites() {
  return mockWriteAttemptBoundLeaderboardRawArtifactSet.mock.calls.map(
    ([input]: [
      {
        attempt: LeaderboardAcquisitionAttempt
        built: { sourceRunId: string; manifest: Record<string, unknown> }
        sourcePages: RawPage[]
      },
    ]) => ({
      sourcePages: input.sourcePages,
      sourceRunId: input.built.sourceRunId,
      manifest: input.built.manifest,
      observationCycleId: input.attempt.observationCycleId,
    })
  )
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('Tier-A board-series publication guard', () => {
  let job: Job<TierJobData>
  let expectedCycleId: string
  const originalIngestLocalRegion = process.env.INGEST_LOCAL_REGION

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.INGEST_LOCAL_REGION = 'local'
    activeSource = src
    mockJobUpdateData.mockResolvedValue(undefined)
    mockDirectJobUpdateData.mockResolvedValue(undefined)
    mockBullReplaceDataIfOwned.mockImplementation((nextData: unknown) =>
      mockJobUpdateData(nextData)
    )
    mockExecutionAssertActive.mockReturnValue(undefined)
    mockExecutionWithClaimedWrite.mockImplementation(
      (callback: (transaction: unknown) => Promise<unknown>) => callback(mockClaimedWriteClient)
    )
    mockExecutionClose.mockImplementation(async (phase: 'completed' | 'failed' | 'revoked') => ({
      phase,
    }))
    mockClaimSourceJobExecutionAuthority.mockImplementation(
      async (options: {
        provenance: SourceJobRunProvenance
        signal?: AbortSignal
        sourceId: number
      }) => {
        const controller = new AbortController()
        const abort = () => controller.abort(options.signal?.reason)
        if (options.signal?.aborted) abort()
        else options.signal?.addEventListener('abort', abort, { once: true })
        const execution = {
          proof: Object.freeze({
            claimId: '10000000-0000-4000-8000-000000000001',
            generationSeq: 17,
            gitSha: 'c'.repeat(40),
            queueAttempt: options.provenance.bullJob.proof.attemptsMade!,
            queueJobId: options.provenance.bullJob.proof.jobId!,
            queueName: options.provenance.bullJob.proof.queueName!,
            sourceId: options.sourceId,
          }),
          signal: controller.signal,
          assertActive: () => {
            try {
              mockExecutionAssertActive()
            } catch (cause) {
              if (!controller.signal.aborted) controller.abort(cause)
              throw cause
            }
          },
          close: (phase: 'completed' | 'failed' | 'revoked') => mockExecutionClose(phase),
          withClaimedWrite: (callback: (transaction: unknown) => Promise<unknown>) =>
            mockExecutionWithClaimedWrite(callback),
        }
        return Object.freeze(execution)
      }
    )
    mockGetExecutionWindowReceipt.mockResolvedValue(null)
    mockRecordExecutionWindowReceipt.mockResolvedValue(Object.freeze({ recorded: true }))
    mockFindLatestTierAWindowAttempt.mockResolvedValue(null)
    mockHasRepublishReceipt.mockResolvedValue(true)
    mockRecordRepublishReceipt.mockResolvedValue(Object.freeze({ recorded: true }))
    mockMaxFreshnessMs.mockReturnValue(6 * 60 * 60 * 1000)
    job = makeJob()
    expectedCycleId = `tier-a:${src.slug}:${job.id}:${job.timestamp}`
    mockFindRegisteredAttemptBoundContract.mockResolvedValue(
      ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT
    )
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
    mockRecordFieldInventory.mockResolvedValue(undefined)
    mockValidateLeaderboardRows.mockImplementation((rows: ParsedLeaderboardRow[]) => ({
      valid: rows,
      rejects: [],
    }))
    mockHasRegisteredLeaderboardMetricTrust.mockReturnValue(true)
    mockGetAdapter.mockReturnValue({
      captureLeaderboard: jest.fn(async () => capturedLeaderboard()),
      listLeaderboard: async function* () {
        throw new Error('Tier-A must never use the uncaptured stream')
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
    mockPublishAttemptBoundLeaderboardSnapshot.mockResolvedValue({
      snapshotId: 778,
      scrapedAt: '2026-07-16 00:01:02.123456+00',
      verdict: { passed: true, baselineUsed: 3, deviationPct: 0 },
      published: true,
      traderIds: new Map([
        ['grid-1', 43],
        ['grid-2', 44],
        ['martingale-1', 45],
      ]),
    })
    mockPublishFencedBoardSeries.mockResolvedValue({ traders: 1, points: 1 })
  })

  afterAll(() => {
    if (originalIngestLocalRegion === undefined) delete process.env.INGEST_LOCAL_REGION
    else process.env.INGEST_LOCAL_REGION = originalIngestLocalRegion
  })

  function configureAttemptBoundSource(
    timeframes: Array<7 | 30 | 90> = [30],
    captureLeaderboard: jest.Mock = jest.fn(async () => capturedLeaderboard()),
    parsedRows: ParsedLeaderboardRow[] = [row]
  ) {
    job = makeJob({ sourceSlug: binanceSrc.slug })
    expectedCycleId = `tier-a:${binanceSrc.slug}:${job.id}:${job.timestamp}`
    activeSource = binanceSrc
    mockGetSourceBySlug.mockResolvedValue(binanceSrc)
    mockNativeRankingTimeframes.mockReturnValue(timeframes)
    mockFindRegisteredAttemptBoundContract.mockResolvedValue(
      ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT
    )
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

  function configureV4Source(
    captureLeaderboard: jest.Mock = jest.fn(async () => partitionedLeaderboardCapture())
  ) {
    job = makeJob({ sourceSlug: bitgetBotsSrc.slug })
    expectedCycleId = `tier-a:${bitgetBotsSrc.slug}:${job.id}:${job.timestamp}`
    activeSource = bitgetBotsSrc
    mockGetSourceBySlug.mockResolvedValue(bitgetBotsSrc)
    mockNativeRankingTimeframes.mockReturnValue([30])
    mockFindRegisteredAttemptBoundContract.mockResolvedValue(
      ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT
    )
    mockStartLeaderboardAcquisitionAttempt.mockImplementation(
      async (input: StartLeaderboardAcquisitionAttemptInput) =>
        attemptFromStart(input, 81, bitgetBotsSrc)
    )
    mockWriteAttemptBoundLeaderboardRawArtifactSet.mockImplementation(
      async (input: {
        attempt: LeaderboardAcquisitionAttempt
        built: Parameters<typeof projectLeaderboardManifestV4Outcome>[1]
      }) => ({
        sourcePayload: {
          id: 9_501,
          storagePath: `${bitgetBotsSrc.slug}/tier_a_trust/source-v4.json.gz`,
          contentHash: 'd'.repeat(64),
        },
        populationManifest: {
          id: 9_502,
          storagePath: `${bitgetBotsSrc.slug}/tier_a_trust/manifest-v4.json.gz`,
          contentHash: input.built.sourceRunId,
        },
        projection: projectLeaderboardManifestV4Outcome(input.attempt, input.built),
      })
    )
    mockGetAdapter.mockReturnValue({
      leaderboardAcquisitionContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
      leaderboardPartitionIds: () => ['spot_grid', 'spot_martingale'],
      captureLeaderboard,
      listLeaderboard: async function* () {
        throw new Error('v4 capture must not use the legacy stream')
      },
      parseLeaderboard: (raw: unknown) => {
        const envelope = raw as { payload: { items: string[] } }
        return {
          rows: envelope.payload.items.map((exchangeTraderId, index) => ({
            ...row,
            exchangeTraderId,
            rank: index + 1,
          })),
          reportedTotal: envelope.payload.items.length,
        }
      },
      parseLeaderboardSeries: () => new Map(),
    })
    return captureLeaderboard
  }

  it('rejects a source moved away from the consumed queue before opening a session', async () => {
    mockGetSourceBySlug.mockResolvedValue({ ...src, fetch_region: 'vps_sg' })

    await expect(processTierA(job)).rejects.toThrow(
      'belongs to vps_sg, not consumed queue region local'
    )
    expect(mockOpenSession).not.toHaveBeenCalled()
    expect(mockWriteRawObject).not.toHaveBeenCalled()
  })

  it('claims execution before opening a session and a claim failure opens nothing', async () => {
    const claimFailure = new Error('claim unavailable')
    mockClaimSourceJobExecutionAuthority.mockRejectedValueOnce(claimFailure)

    await expect(processTierA(job)).rejects.toBe(claimFailure)

    expect(mockClaimSourceJobExecutionAuthority).toHaveBeenCalledTimes(1)
    expect(mockOpenSession).not.toHaveBeenCalled()
    expect(mockExecutionClose).not.toHaveBeenCalled()
    expect(mockWriteRawObject).not.toHaveBeenCalled()
  })

  it('drains best-effort field inventory before the processor can return', async () => {
    const inventory = deferred()
    const inventoryStarted = deferred()
    mockRecordFieldInventory.mockImplementationOnce(async () => {
      inventoryStarted.resolve()
      return inventory.promise
    })

    let settled = false
    const run = processTierA(job)
    void run.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await inventoryStarted.promise
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(mockSessionClose).not.toHaveBeenCalled()

    inventory.resolve()
    await expect(run).resolves.toHaveLength(1)
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
    // A PASSED publication records the node's Tier-A output watermark.
    expect(mockNoteTierAPublished).toHaveBeenCalled()
  })

  it('swallows only an inventory query failure after reasserting execution authority', async () => {
    mockRecordFieldInventory.mockRejectedValueOnce(new Error('inventory unavailable'))

    await expect(processTierA(job)).resolves.toHaveLength(1)

    expect(mockExecutionAssertActive).toHaveBeenCalled()
    expect(mockPublishTrustedLeaderboardSnapshot).toHaveBeenCalledTimes(1)
    expect(mockExecutionClose).toHaveBeenCalledWith('completed')
  })

  it('fails before any claim or session when the adapter has no capture implementation', async () => {
    mockGetAdapter.mockReturnValue({
      listLeaderboard: async function* () {
        yield page
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
      parseLeaderboardSeries: () => new Map(),
    })

    await expect(processTierA(job)).rejects.toThrow(
      'xt_futures adapter has no attempt-bound capture implementation'
    )

    expect(mockFindRegisteredAttemptBoundContract).not.toHaveBeenCalled()
    expect(mockClaimSourceJobExecutionAuthority).not.toHaveBeenCalled()
    expect(mockOpenSession).not.toHaveBeenCalled()
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
  })

  it('fails before any claim or session when the v3 capture contract is not registered', async () => {
    mockFindRegisteredAttemptBoundContract.mockResolvedValue(null)

    await expect(processTierA(job)).rejects.toThrow(
      'xt_futures v3 capture contract is not exactly registered'
    )

    expect(mockClaimSourceJobExecutionAuthority).not.toHaveBeenCalled()
    expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
    expect(mockOpenSession).not.toHaveBeenCalled()
    expect(mockWriteRawObject).not.toHaveBeenCalled()
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
  })

  it('fails an explicit v4 adapter when its exact registry contract is absent', async () => {
    const captureLeaderboard = configureV4Source()
    mockFindRegisteredAttemptBoundContract.mockResolvedValue(null)

    await expect(processTierA(job)).rejects.toThrow('v4 capture contract is not exactly registered')

    expect(mockFindRegisteredAttemptBoundContract).toHaveBeenCalledWith({
      sourceId: bitgetBotsSrc.id,
      adapterSlug: bitgetBotsSrc.adapter_slug,
      captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
    })
    expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
    expect(mockOpenSession).not.toHaveBeenCalled()
    expect(captureLeaderboard).not.toHaveBeenCalled()
  })

  it('publishes terminal-gap v4 evidence only through its exact attempt fence', async () => {
    configureV4Source()
    await expect(processTierA(job)).resolves.toEqual([
      expect.objectContaining({ timeframe: 30, snapshotId: 778, passed: true }),
    ])

    expect(mockStartLeaderboardAcquisitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: bitgetBotsSrc.id,
        captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
      })
    )
    expect(mockValidateLeaderboardRows.mock.calls[0][0]).toEqual([
      expect.objectContaining({ exchangeTraderId: 'grid-1', rank: 1 }),
      expect.objectContaining({ exchangeTraderId: 'grid-2', rank: 2 }),
      expect.objectContaining({ exchangeTraderId: 'martingale-1', rank: 3 }),
    ])
    const artifactInput = mockWriteAttemptBoundLeaderboardRawArtifactSet.mock.calls[0][0]
    expect(artifactInput.built.manifest).toMatchObject({
      data_contract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
      source: { configured_partition_ids: ['spot_grid', 'spot_martingale'] },
      parser_input: {
        page_count: 2,
        transformation: { source_page_ordinals: [1, 3] },
      },
      pagination_topology: {
        expected_partition_ids: ['spot_grid', 'spot_martingale'],
        partitions: [
          { source_page_ordinals: [1, 2], parser_page_ordinals: [1] },
          { source_page_ordinals: [3, 4], parser_page_ordinals: [2] },
        ],
      },
      population: { observed_row_count: 3, accepted_population: 3 },
    })
    expect(mockFinishLeaderboardAcquisitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'manifest',
        projection: expect.objectContaining({ terminalState: 'complete' }),
      })
    )
    expect(mockPublishAttemptBoundLeaderboardSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        src: bitgetBotsSrc,
        timeframe: 30,
        rows: expect.arrayContaining([
          expect.objectContaining({ exchangeTraderId: 'grid-1', rank: 1 }),
          expect.objectContaining({ exchangeTraderId: 'martingale-1', rank: 3 }),
        ]),
        rejects: [],
        observationCycleId: expectedCycleId,
        attemptEvidence: expect.objectContaining({
          sourceRunId: artifactInput.built.sourceRunId,
          manifest: artifactInput.built.manifest,
          artifacts: expect.objectContaining({
            sourcePayload: expect.objectContaining({ id: 9_501 }),
            populationManifest: expect.objectContaining({ id: 9_502 }),
          }),
        }),
      }),
      expect.any(Object)
    )
    expect(mockHasRegisteredLeaderboardMetricTrust).not.toHaveBeenCalled()
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockJobUpdateData).toHaveBeenCalledTimes(1)
  })

  it('runs the v4 terminal fence even for a gated snapshot and leaves its checkpoint open', async () => {
    configureV4Source()
    mockPublishAttemptBoundLeaderboardSnapshot.mockResolvedValue({
      snapshotId: 779,
      scrapedAt: '2026-07-16 00:01:02.123456+00',
      verdict: { passed: false, baselineUsed: 20, deviationPct: 85 },
      published: false,
      traderIds: new Map(),
    })
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(processTierA(job)).rejects.toBeInstanceOf(AggregateError)
    } finally {
      errorSpy.mockRestore()
    }

    expect(mockFinishLeaderboardAcquisitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'manifest',
        projection: expect.objectContaining({ terminalState: 'complete' }),
      })
    )
    expect(mockPublishAttemptBoundLeaderboardSnapshot).toHaveBeenCalledTimes(1)
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockRecordExecutionWindowReceipt).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
    expect(mockExecutionClose).toHaveBeenCalledWith('failed')
  })

  it('terminally records a v4/identity capture mismatch without publishing or downgrading', async () => {
    configureV4Source(jest.fn(async () => capturedLeaderboard()))
    const adapter = mockGetAdapter()
    adapter.parseLeaderboard = () => ({ rows: [row], reportedTotal: 1 })
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(processTierA(job)).rejects.toThrow(
        'capture processing failed after RAW fallback'
      )
    } finally {
      errorSpy.mockRestore()
    }

    expect(mockWriteRawObject).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: 'tier_a_failure',
        meta: expect.objectContaining({
          acquisition_attempt: expect.objectContaining({
            capture_contract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
          }),
          capture_evidence: expect.objectContaining({
            mode: 'identity',
            capture_config: expect.any(Object),
            parser_transformation: expect.any(Object),
            source_pages: expect.arrayContaining([
              expect.objectContaining({
                ordinal: 1,
                stored_page_index: 1,
                payload_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
                source_row_count: 1,
                request_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
                pagination_position: expect.any(Object),
              }),
            ]),
          }),
        }),
      })
    )
    expect(mockFinishLeaderboardAcquisitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'processing_failed',
        failureStage: 'parse_validate_manifest',
        reasonCode: 'manifest_failed',
      })
    )
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).not.toHaveBeenCalled()
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).not.toHaveBeenCalled()
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
  })

  it('preserves exact partition bindings when authoritative topology drift is rejected', async () => {
    configureV4Source()
    const adapter = mockGetAdapter()
    adapter.leaderboardPartitionIds = () => ['spot_martingale', 'spot_grid']
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(processTierA(job)).rejects.toThrow(
        'capture processing failed after RAW fallback'
      )
    } finally {
      errorSpy.mockRestore()
    }

    expect(mockWriteRawObject).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: 'tier_a_failure',
        meta: expect.objectContaining({
          acquisition_attempt: expect.objectContaining({
            capture_contract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
          }),
          capture_evidence: expect.objectContaining({
            mode: 'partitioned_numeric',
            parser_transformation: expect.objectContaining({
              kind: 'partitioned_numeric_projection',
              source_page_ordinals: [1, 3],
              page_bindings: expect.arrayContaining([
                expect.objectContaining({
                  partition_id: 'spot_grid',
                  source_page_ordinal: 1,
                  request_page_index: 1,
                  request_page_size: 20,
                }),
              ]),
            }),
            pagination_topology: expect.objectContaining({
              expected_partition_ids: ['spot_grid', 'spot_martingale'],
            }),
            source_pages: expect.arrayContaining([
              expect.objectContaining({
                ordinal: 3,
                source_row_count: 1,
                pagination_position: expect.objectContaining({
                  partition_id: 'spot_martingale',
                  request_page_index: 1,
                }),
              }),
            ]),
          }),
        }),
      })
    )
    expect(mockFinishLeaderboardAcquisitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'processing_failed',
        diagnosticRawObjectId: 9001,
        failureStage: 'parse_validate_manifest',
        reasonCode: 'manifest_failed',
      })
    )
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).not.toHaveBeenCalled()
    expect(mockPublishAttemptBoundLeaderboardSnapshot).not.toHaveBeenCalled()
  })

  it('terminally records a v3/partitioned capture mismatch without publishing or upgrading', async () => {
    configureAttemptBoundSource(
      [30],
      jest.fn(async () => partitionedLeaderboardCapture(100))
    )
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(processTierA(job)).rejects.toThrow(
        'capture processing failed after RAW fallback'
      )
    } finally {
      errorSpy.mockRestore()
    }

    expect(mockFinishLeaderboardAcquisitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'processing_failed',
        failureStage: 'parse_validate_manifest',
        reasonCode: 'manifest_failed',
      })
    )
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).not.toHaveBeenCalled()
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).not.toHaveBeenCalled()
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
  })

  it('uses evidence-only validation and durably terminates captured v4 upstream evidence', async () => {
    configureV4Source(
      jest.fn(async () => {
        const failedCapture = partitionedLeaderboardCapture()
        failedCapture.terminationReason = 'upstream_error'
        failedCapture.paginationTopology.partitions[1].termination_reason = 'upstream_error'
        throw new LeaderboardCaptureUpstreamError(
          null,
          'https://bitget.test/spot_martingale?page=3',
          failedCapture,
          new Error('connection reset')
        )
      })
    )
    const validateLeaderboard = jest.fn()
    const adapter = mockGetAdapter()
    adapter.validateLeaderboard = validateLeaderboard
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(processTierA(job)).rejects.toBeInstanceOf(AggregateError)
    } finally {
      errorSpy.mockRestore()
    }

    expect(validateLeaderboard).toHaveBeenCalledWith(
      expect.objectContaining({
        parsedRows: expect.any(Array),
        validRows: expect.any(Array),
        rejectedRowCount: 0,
      }),
      bitgetBotsSrc,
      30,
      { purpose: 'evidence_only' }
    )
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).toHaveBeenCalledTimes(1)
    expect(mockWriteRawObject).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobType: 'tier_a_failure' })
    )
    expect(mockFinishLeaderboardAcquisitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'manifest',
        projection: expect.objectContaining({ terminalState: 'unknown' }),
      })
    )
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
  })

  it('passes the exact live snapshot identity before publishing replacement series', async () => {
    await expect(processTierA(job)).resolves.toEqual([
      expect.objectContaining({ timeframe: 30, snapshotId: 777, passed: true }),
    ])

    expect(mockPublishFencedBoardSeries).toHaveBeenCalledWith(
      src,
      expect.any(Map),
      new Map([[row.exchangeTraderId, 42]]),
      expect.objectContaining({ consumedRegion: 'local' }),
      {
        expectedLatestSnapshots: new Map([
          [
            30,
            {
              id: 777,
              rawObjectId: 9261,
              scrapedAt: '2026-07-16T00:01:02.123Z',
            },
          ],
        ]),
      }
    )
    // openSession(src) is the fetch-layer's source-scoped, single-slot
    // unsuffixed lane. Do not bypass it with a raw profile suffix override.
    expect(mockOpenSession).toHaveBeenCalledWith(src)
    expect(mockWriteRawObject).not.toHaveBeenCalled()
    expect(mockPublishTrustedLeaderboardSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        timeframe: 30,
        observationCycleId: expectedCycleId,
      }),
      expect.objectContaining({ consumedRegion: 'local' })
    )
    expect(mockRecordExecutionWindowReceipt).toHaveBeenCalledTimes(1)
    expect(mockJobUpdateData).toHaveBeenCalledTimes(1)
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('rejects a cross-timeframe series block before snapshot publication or checkpoint', async () => {
    mockGetAdapter.mockReturnValue({
      captureLeaderboard: jest.fn(async () => capturedLeaderboard()),
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
                timeframe: 7,
                metric: 'pnl',
                points: [{ ts: '2026-07-16T00:00:00.000Z', value: 20 }],
              },
            ],
          ],
        ]),
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
    const windowFailure = (failure as AggregateError).errors[0] as Error & { cause?: unknown }
    expect(windowFailure.cause).toEqual(
      expect.objectContaining({
        message: '[tier-a] board series block crossed its snapshot timeframe',
      })
    )
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockPublishFencedBoardSeries).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
    expect(job.data).toEqual({ sourceSlug: src.slug })
  })

  it('runs the source-specific whole-board gate before snapshot, series, or checkpoint', async () => {
    const validateLeaderboard = jest.fn(() => {
      throw new TypeError('source-specific board contract failed')
    })
    const parseLeaderboardSeries = jest.fn(() => new Map())
    mockGetAdapter.mockReturnValue({
      captureLeaderboard: jest.fn(async () => capturedLeaderboard()),
      listLeaderboard: async function* () {
        yield page
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
      validateLeaderboard,
      parseLeaderboardSeries,
    })
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(processTierA(job)).rejects.toBeInstanceOf(AggregateError)
    } finally {
      errorSpy.mockRestore()
    }

    expect(validateLeaderboard).toHaveBeenCalledWith(
      { parsedRows: [row], validRows: [row], rejectedRowCount: 0 },
      src,
      30,
      { purpose: 'publication' }
    )
    expect(mockWriteRawObject).toHaveBeenCalledTimes(1)
    expect(parseLeaderboardSeries).not.toHaveBeenCalled()
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockPublishFencedBoardSeries).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
    expect(job.data).toEqual({ sourceSlug: src.slug })
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
    const parseLeaderboard = jest.fn(() => ({
      rows: [
        {
          ...row,
          headlineMetricSources: {
            roi: { fieldPath: 'result.items[].roi', sourcePageOrdinal: 999 },
            pnl: { fieldPath: 'result.items[].pnl' },
          },
        },
      ],
      reportedTotal: 1,
    }))
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
    expect(attemptBoundRawWrites()).toContainEqual(
      expect.objectContaining({
        sourcePages,
        observationCycleId: expectedCycleId,
        manifest: expect.objectContaining({
          assessment: { acquisition_state: 'complete', population_state: 'verified' },
        }),
      })
    )
    const artifactInput = attemptBoundRawWrites()[0]
    expect(artifactInput.sourceRunId).toBe(strictCanonicalSha256(artifactInput.manifest))
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet.mock.invocationCallOrder[0]).toBeLessThan(
      mockPublishTrustedLeaderboardSnapshot.mock.invocationCallOrder[0]
    )
    expect(mockPublishTrustedLeaderboardSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [
          expect.objectContaining({
            headlineMetricSources: {
              roi: { fieldPath: 'result.items[].roi', sourcePageOrdinal: 1 },
              pnl: { fieldPath: 'result.items[].pnl', sourcePageOrdinal: 1 },
            },
          }),
        ],
        trust: expect.objectContaining({
          sourceRunId: artifactInput.sourceRunId,
          manifest: artifactInput.manifest,
          artifacts: expect.objectContaining({
            sourcePayload: expect.objectContaining({ id: 9261 }),
            populationManifest: expect.objectContaining({ id: 9262 }),
          }),
        }),
      }),
      expect.objectContaining({ consumedRegion: 'local' })
    )
  })

  it('anchors capture ranks to observed source rows when configured page size is unknown', async () => {
    const defaultedSource = { ...src, page_size: null }
    const firstAccounts = Array.from({ length: 20 }, (_, index) => `first-${index + 1}`)
    const secondAccounts = ['second-1']
    mockGetSourceBySlug.mockResolvedValue(defaultedSource)
    mockGetAdapter.mockReturnValue({
      captureLeaderboard: jest.fn(async () =>
        capturedLeaderboardWithPageRows([firstAccounts, secondAccounts])
      ),
      listLeaderboard: async function* () {
        throw new Error('capture-aware adapter must not run legacy streaming')
      },
      parseLeaderboard: (payload: unknown) => {
        const items = (payload as { result: { items: Array<{ accountId: string }> } }).result.items
        return {
          rows: items.map(({ accountId }, index) => ({
            ...row,
            exchangeTraderId: accountId,
            nickname: accountId,
            rank: index + 1,
          })),
          reportedTotal: 21,
        }
      },
      parseLeaderboardSeries: () => new Map(),
    })

    await expect(processTierA(job)).resolves.toEqual([
      expect.objectContaining({ actualCount: 21, rejects: 0, passed: true }),
    ])

    expect(mockPublishTrustedLeaderboardSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        src: defaultedSource,
        rows: expect.arrayContaining([
          expect.objectContaining({ exchangeTraderId: 'first-1', rank: 1 }),
          expect.objectContaining({ exchangeTraderId: 'first-20', rank: 20 }),
          expect.objectContaining({ exchangeTraderId: 'second-1', rank: 21 }),
        ]),
      }),
      expect.objectContaining({ consumedRegion: 'local' })
    )
    expect(attemptBoundRawWrites()).toContainEqual(
      expect.objectContaining({
        manifest: expect.objectContaining({
          source: expect.objectContaining({ configured_page_size: null }),
        }),
      })
    )
  })

  it('keeps source-row rank gaps but quarantines a capture when parsing loses an identity', async () => {
    const defaultedSource = { ...src, page_size: null }
    const firstAccounts = Array.from({ length: 20 }, (_, index) => `first-${index + 1}`)
    mockGetSourceBySlug.mockResolvedValue(defaultedSource)
    mockGetAdapter.mockReturnValue({
      captureLeaderboard: jest.fn(async () =>
        capturedLeaderboardWithPageRows([firstAccounts, ['second-1']])
      ),
      listLeaderboard: async function* () {
        throw new Error('capture-aware adapter must not run legacy streaming')
      },
      parseLeaderboard: (payload: unknown) => {
        const items = (payload as { result: { items: Array<{ accountId: string }> } }).result.items
        return {
          rows: items.flatMap(({ accountId }, index) =>
            accountId === 'first-10'
              ? []
              : [
                  {
                    ...row,
                    exchangeTraderId: accountId,
                    nickname: accountId,
                    rank: index + 1,
                  },
                ]
          ),
          reportedTotal: 21,
        }
      },
      parseLeaderboardSeries: () => new Map(),
    })
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(processTierA(job)).rejects.toBeInstanceOf(AggregateError)
    } finally {
      errorSpy.mockRestore()
    }

    const rowsAtValidation = mockValidateLeaderboardRows.mock.calls[0][0] as ParsedLeaderboardRow[]
    expect(rowsAtValidation).toHaveLength(20)
    expect(rowsAtValidation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ exchangeTraderId: 'first-11', rank: 11 }),
        expect.objectContaining({ exchangeTraderId: 'second-1', rank: 21 }),
      ])
    )
    expect(rowsAtValidation.some((candidate) => candidate.rank === 10)).toBe(false)
    expect(attemptBoundRawWrites()).toContainEqual(
      expect.objectContaining({
        manifest: expect.objectContaining({
          assessment: { acquisition_state: 'complete', population_state: 'partial' },
        }),
      })
    )
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
  })

  it.each([
    [
      'terminal-page ordinal',
      () =>
        capturedLeaderboard({
          parserTransformation: {
            kind: 'identity_projection',
            source_page_ordinals: [2],
          },
        }),
      [{ ...row, rank: 1 }],
    ],
    [
      'page-local rank beyond the source row count',
      () => capturedLeaderboard(),
      [{ ...row, rank: 2 }],
    ],
    [
      'negative source row count',
      () => {
        const capture = capturedLeaderboard()
        return {
          ...capture,
          sourcePages: [{ ...capture.sourcePages[0], sourceRowCount: -1 }, capture.sourcePages[1]],
        }
      },
      [{ ...row, rank: 1 }],
    ],
    [
      'zero-row terminal page included as parser input',
      () => {
        const zeroPage = {
          ...terminalPage,
          pageIndex: 1,
          url: 'https://xt.test/leader-list?page=1',
          fetchedAt: new Date().toISOString(),
        }
        return capturedLeaderboard({
          sourcePages: [
            {
              rawPage: zeroPage,
              sourceRowCount: 0,
              requestSha256: 'a'.repeat(64),
              httpStatus: 200,
              paginationPosition: { kind: 'page_index', request_page_index: 1 },
              sourceReports: {
                population: { state: 'reported', value: 0 },
                page_count: { state: 'not_reported' },
                current_page: { state: 'not_reported' },
                page_size: { state: 'not_reported' },
              },
            },
          ],
          parsePages: [zeroPage],
          terminationReason: 'empty_page',
          parserTransformation: {
            kind: 'identity_projection',
            source_page_ordinals: [1],
          },
        })
      },
      [{ ...row, rank: 1 }],
    ],
    [
      'duplicate page-local rank',
      () => capturedLeaderboard(),
      [
        { ...row, exchangeTraderId: 'one', rank: 1 },
        { ...row, exchangeTraderId: 'two', rank: 1 },
      ],
    ],
  ] as const)(
    'keeps invalid capture rank evidence out of serving: %s',
    async (_label, makeCapture, parsedRows) => {
      mockGetAdapter.mockReturnValue({
        captureLeaderboard: jest.fn(async () => makeCapture()),
        listLeaderboard: async function* () {
          throw new Error('capture-aware adapter must not run legacy streaming')
        },
        parseLeaderboard: () => ({ rows: parsedRows, reportedTotal: 1 }),
        parseLeaderboardSeries: () => new Map(),
      })
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

      try {
        await expect(processTierA(job)).rejects.toBeInstanceOf(AggregateError)
      } finally {
        errorSpy.mockRestore()
      }

      expect(mockWriteRawObject).toHaveBeenCalledWith(
        expect.objectContaining({ jobType: 'tier_a_failure' })
      )
      expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
    }
  )

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
    expect(attemptBoundRawWrites()).toContainEqual(
      expect.objectContaining({
        manifest: expect.objectContaining({
          assessment: { acquisition_state: 'partial', population_state: 'partial' },
        }),
      })
    )
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
    expect(attemptBoundRawWrites()).toContainEqual(
      expect.objectContaining({
        manifest: expect.objectContaining({
          assessment: { acquisition_state: 'unknown', population_state: 'unknown' },
        }),
      })
    )
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
    const processingFailure = (failure as AggregateError).errors[0] as AggregateError
    const wrapped = processingFailure.errors[0] as Error & { cause?: unknown }
    expect(wrapped.cause).toBe(upstream)
    expect((wrapped.cause as LeaderboardCaptureUpstreamError).capture).toBe(failedCapture)
    expect((failure as AggregateError).errors[1].message).toBe('browser close failed')
    expect(mockWriteRawObject).not.toHaveBeenCalled()
    expect(attemptBoundRawWrites()).toContainEqual(
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
    expect(attemptBoundRawWrites()).toContainEqual(
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
    expect(attemptBoundRawWrites()).toContainEqual(
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
    expect(attemptBoundRawWrites()).toContainEqual(
      expect.objectContaining({
        manifest: expect.objectContaining({
          assessment: { acquisition_state: 'complete', population_state: 'verified' },
        }),
      })
    )
    expect(mockWriteRawObject).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
  })

  it('stops later windows and preserves upstream plus artifact persistence failures', async () => {
    mockNativeRankingTimeframes.mockReturnValue([30, 90])
    const attempted: number[] = []
    let upstream: LeaderboardCaptureUpstreamError | null = null
    const persistenceError = new Error('artifact database unavailable')
    mockWriteAttemptBoundLeaderboardRawArtifactSet.mockRejectedValueOnce(persistenceError)
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
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).not.toHaveBeenCalled()
    expect(mockWriteRawObject).toHaveBeenCalledWith({
      sourceId: src.id,
      sourceSlug: src.slug,
      jobType: 'tier_a_failure',
      timeframe: 30,
      payload: (capture as LeaderboardCapture).sourcePages.map((sourcePage) => sourcePage.rawPage),
      serialization: STRICT_CANONICAL_JSON_CONTRACT,
      meta: expect.objectContaining({
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
        capture_evidence: expect.objectContaining({
          mode: 'identity',
          source_pages: expect.arrayContaining([
            expect.objectContaining({
              payload_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
              request_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            }),
          ]),
        }),
      }),
    })
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
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
  })

  it('uses exact-cycle database receipts to resume and repairs an absent Redis hint', async () => {
    const attempted: number[] = []
    configureAttemptBoundSource(
      [7, 30, 90],
      jest.fn(async (_session: unknown, _src: SourceRow, timeframe: number) => {
        attempted.push(timeframe)
        return capturedLeaderboard()
      })
    )
    mockGetExecutionWindowReceipt.mockImplementation(
      async (_transaction: unknown, input: { timeframe: number }) =>
        input.timeframe === 7 || input.timeframe === 30 ? { timeframe: input.timeframe } : null
    )

    await expect(processTierA(job)).resolves.toEqual([
      expect.objectContaining({ timeframe: 90, snapshotId: 777, passed: true }),
    ])

    expect(attempted).toEqual([90])
    expect(mockStartLeaderboardAcquisitionAttempt).toHaveBeenCalledTimes(1)
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).toHaveBeenCalledTimes(1)
    expect(mockJobUpdateData.mock.calls.map(([data]) => data.completedTimeframes)).toEqual([
      [7, 30],
      [7, 30, 90],
    ])
    expect(job.data.completedTimeframes).toEqual([7, 30, 90])
  })

  it('ignores legacy hints, clears them by CAS, and refetches every native window', async () => {
    const attempted: number[] = []
    job = makeJob({
      sourceSlug: src.slug,
      completedTimeframes: [30, 30, 365, '90', null],
    } as unknown as TierJobData)
    mockNativeRankingTimeframes.mockReturnValue([7, 30, 90])
    mockGetAdapter.mockReturnValue({
      captureLeaderboard: jest.fn(async (_session: unknown, _src: SourceRow, timeframe: number) => {
        attempted.push(timeframe)
        return capturedLeaderboard()
      }),
      listLeaderboard: async function* () {
        throw new Error('Tier-A must never use the uncaptured stream')
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
      parseLeaderboardSeries: () => new Map(),
    })

    await expect(processTierA(job)).resolves.toHaveLength(3)

    expect(attempted).toEqual([7, 30, 90])
    expect(mockJobUpdateData.mock.calls.map(([data]) => data.completedTimeframes)).toEqual([
      [],
      [7],
      [7, 30],
      [7, 30, 90],
    ])
    expect(job.data.completedTimeframes).toEqual([7, 30, 90])
    expect(mockRecordExecutionWindowReceipt).toHaveBeenCalledTimes(3)
  })

  it('closes completed without opening a browser when every native receipt exists', async () => {
    const captureLeaderboard = configureAttemptBoundSource([7, 30, 90])
    job = makeJob({ sourceSlug: binanceSrc.slug, completedTimeframes: [7, 30, 90] })
    mockGetExecutionWindowReceipt.mockImplementation(
      async (_transaction: unknown, input: { timeframe: number }) => ({
        timeframe: input.timeframe,
      })
    )

    await expect(processTierA(job)).resolves.toEqual([])

    expect(mockClaimSourceJobExecutionAuthority).toHaveBeenCalledTimes(1)
    expect(mockGetExecutionWindowReceipt).toHaveBeenCalledTimes(3)
    expect(mockOpenSession).not.toHaveBeenCalled()
    expect(captureLeaderboard).not.toHaveBeenCalled()
    expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
    expect(mockExecutionClose).toHaveBeenCalledWith('completed')
  })

  it('does not let a Redis hint or a foreign-cycle receipt suppress current-cycle work', async () => {
    const captureLeaderboard = configureAttemptBoundSource([30])
    job = makeJob({ sourceSlug: binanceSrc.slug, completedTimeframes: [30] })
    expectedCycleId = `tier-a:${binanceSrc.slug}:${job.id}:${job.timestamp}`
    const receiptsByCycle = new Map([['foreign-cycle', { timeframe: 30 }]])
    mockGetExecutionWindowReceipt.mockImplementation(
      async (_transaction: unknown, input: { observationCycleId: string }) =>
        receiptsByCycle.get(input.observationCycleId) ?? null
    )

    await expect(processTierA(job)).resolves.toHaveLength(1)

    expect(mockGetExecutionWindowReceipt).toHaveBeenCalledWith(
      mockClaimedWriteClient,
      expect.objectContaining({
        observationCycleId: expectedCycleId,
        queueJobId: job.id,
        queueName: 'arena-ingest',
        timeframe: 30,
      })
    )
    expect(captureLeaderboard).toHaveBeenCalledTimes(1)
    expect(mockJobUpdateData.mock.calls.map(([data]) => data.completedTimeframes)).toEqual([
      [],
      [30],
    ])
  })

  it('treats receipt lookup failure as terminal before browser acquisition', async () => {
    const captureLeaderboard = configureAttemptBoundSource([30])
    const receiptFailure = new Error('receipt database unavailable')
    mockGetExecutionWindowReceipt.mockRejectedValueOnce(receiptFailure)

    await expect(processTierA(job)).rejects.toBe(receiptFailure)

    expect(captureLeaderboard).not.toHaveBeenCalled()
    expect(mockOpenSession).not.toHaveBeenCalled()
    expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
    expect(mockExecutionClose).toHaveBeenCalledWith('failed')
  })

  it('stops after a receipt record failure without CAS or a later timeframe', async () => {
    const attempted: number[] = []
    configureAttemptBoundSource(
      [7, 30],
      jest.fn(async (_session: unknown, _src: SourceRow, timeframe: number) => {
        attempted.push(timeframe)
        return capturedLeaderboard()
      })
    )
    const receiptFailure = new Error('receipt insert unavailable')
    mockRecordExecutionWindowReceipt.mockRejectedValueOnce(receiptFailure)

    await expect(processTierA(job)).rejects.toBe(receiptFailure)

    expect(attempted).toEqual([7])
    expect(mockRecordExecutionWindowReceipt).toHaveBeenCalledTimes(1)
    expect(mockJobUpdateData).not.toHaveBeenCalled()
    expect(mockExecutionClose).toHaveBeenCalledWith('failed')
  })

  it('does not checkpoint a window until board-series publication succeeds', async () => {
    mockPublishFencedBoardSeries.mockRejectedValueOnce(new Error('series write failed'))
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(processTierA(job)).rejects.toThrow('1/1 native windows failed (30d)')
    } finally {
      errorSpy.mockRestore()
    }

    expect(mockPublishTrustedLeaderboardSnapshot).toHaveBeenCalledTimes(1)
    expect(mockPublishFencedBoardSeries).toHaveBeenCalledTimes(1)
    expect(mockJobUpdateData).not.toHaveBeenCalled()
    expect(job.data).toEqual({ sourceSlug: src.slug })
  })

  it('continues after a registered series failure but receipts only the successful window', async () => {
    const captureLeaderboard = jest.fn(async () => capturedLeaderboard())
    configureAttemptBoundSource([7, 30], captureLeaderboard)
    mockGetAdapter.mockReturnValue({
      captureLeaderboard,
      listLeaderboard: async function* () {
        throw new Error('registered source must not use the legacy stream')
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
      parseLeaderboardSeries: (_raw: unknown, _ctx: unknown, timeframe: RankingTimeframe) =>
        new Map([
          [
            row.exchangeTraderId,
            [
              {
                timeframe,
                metric: 'pnl',
                replaceSeries: true,
                points: [{ ts: '2026-07-16T00:00:00.000Z', value: 20 }],
              },
            ],
          ],
        ]),
    })
    mockPublishFencedBoardSeries.mockRejectedValueOnce(new Error('series write failed'))
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(processTierA(job)).rejects.toThrow('1/2 native windows failed (7d)')
    } finally {
      errorSpy.mockRestore()
    }

    expect(captureLeaderboard).toHaveBeenCalledTimes(2)
    expect(mockRecordExecutionWindowReceipt).toHaveBeenCalledTimes(1)
    expect(mockRecordExecutionWindowReceipt.mock.calls[0][1]).toEqual(
      expect.objectContaining({ timeframe: 30 })
    )
    expect(mockJobUpdateData).toHaveBeenCalledWith({
      sourceSlug: binanceSrc.slug,
      completedTimeframes: [30],
    })
    expect(mockExecutionClose).toHaveBeenCalledWith('failed')
  })

  it('records a durable receipt after snapshot metadata and only then repairs Redis', async () => {
    configureAttemptBoundSource()
    mockGetSourceBySlug.mockResolvedValue({ ...binanceSrc, trader_kind_scope: 'bot' })

    await expect(processTierA(job)).resolves.toHaveLength(1)

    expect(mockPublishTrustedLeaderboardSnapshot).toHaveBeenCalledTimes(1)
    expect(mockPublishTrustedLeaderboardSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mockRecordExecutionWindowReceipt.mock.invocationCallOrder[0]
    )
    expect(mockRecordExecutionWindowReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      mockJobUpdateData.mock.invocationCallOrder[0]
    )
    expect(mockRecordExecutionWindowReceipt.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        attemptId: expect.any(String),
        observationCycleId: expectedCycleId,
        rawObjectId: expect.any(Number),
        snapshotId: 777,
        sourceRunId: expect.stringMatching(/^[0-9a-f]{64}$/),
        timeframe: 30,
      })
    )
    expect(mockJobUpdateData).toHaveBeenCalledWith({
      sourceSlug: binanceSrc.slug,
      completedTimeframes: [30],
    })
  })

  it('keeps the durable receipt and stops before the next window when CAS fails', async () => {
    const attempted: number[] = []
    configureAttemptBoundSource(
      [7, 30, 90],
      jest.fn(async (_session: unknown, _src: SourceRow, timeframe: number) => {
        attempted.push(timeframe)
        return capturedLeaderboard()
      })
    )
    job = makeJob({ sourceSlug: binanceSrc.slug, completedTimeframes: [7] })
    expectedCycleId = `tier-a:${binanceSrc.slug}:${job.id}:${job.timestamp}`
    mockGetExecutionWindowReceipt.mockImplementation(
      async (_transaction: unknown, input: { timeframe: number }) =>
        input.timeframe === 7 ? { timeframe: 7 } : null
    )
    const redisFailure = new Error('redis unavailable')
    const ownershipLoss = new Error('Bull lock lost')
    mockJobUpdateData.mockRejectedValueOnce(redisFailure)
    mockExecutionAssertActive.mockImplementation(() => {
      if (mockJobUpdateData.mock.calls.length > 0) throw ownershipLoss
    })
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(processTierA(job)).rejects.toThrow(
        'checkpoint persistence failed for binance_futures 30d: redis unavailable; Bull lock lost'
      )
    } finally {
      errorSpy.mockRestore()
    }

    expect(attempted).toEqual([30])
    expect(mockPublishTrustedLeaderboardSnapshot).toHaveBeenCalledTimes(1)
    expect(mockRecordExecutionWindowReceipt).toHaveBeenCalledTimes(1)
    expect(mockJobUpdateData).toHaveBeenCalledWith({
      sourceSlug: binanceSrc.slug,
      completedTimeframes: [7, 30],
    })
    expect(job.data).toEqual({ sourceSlug: binanceSrc.slug, completedTimeframes: [7] })
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
    expect(mockExecutionClose).toHaveBeenCalledWith('revoked')
    expect(mockDirectJobUpdateData).not.toHaveBeenCalled()
  })

  it('checkpoints successes around a normal failure and retries only the missing window', async () => {
    const attempted: number[] = []
    const durableReceipts = new Set<number>()
    let run = 1
    configureAttemptBoundSource(
      [7, 30, 90],
      jest.fn(async (_session: unknown, _src: SourceRow, timeframe: number) => {
        attempted.push(timeframe)
        if (run === 1 && timeframe === 30) throw new Error('transient upstream failure')
        return capturedLeaderboard()
      })
    )
    mockGetExecutionWindowReceipt.mockImplementation(
      async (_transaction: unknown, input: { timeframe: number }) =>
        durableReceipts.has(input.timeframe) ? { timeframe: input.timeframe } : null
    )
    mockRecordExecutionWindowReceipt.mockImplementation(
      async (_writer: unknown, input: { timeframe: number }) => {
        durableReceipts.add(input.timeframe)
        return { timeframe: input.timeframe }
      }
    )
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
        sourceSlug: binanceSrc.slug,
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
      captureLeaderboard: jest.fn(async (_session: unknown, _src: SourceRow, timeframe: number) => {
        attempted.push(timeframe)
        if (timeframe === 7) throw new Error('upstream 503')
        return capturedLeaderboard()
      }),
      listLeaderboard: async function* () {
        throw new Error('Tier-A must never use the uncaptured stream')
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
      parseLeaderboardSeries: () => new Map(),
    })
    mockPublishTrustedLeaderboardSnapshot.mockImplementation(
      async (input: { timeframe: number }) => ({
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
    expect(
      mockPublishTrustedLeaderboardSnapshot.mock.calls.map(([input]) => input.timeframe)
    ).toEqual([30, 90])
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
    expect((failure as Error).message).toContain('2/3 native windows failed (7d, 30d)')
    expect((failure as Error).message).toContain('1 succeeded')
    // Only the published window is receipted and checkpointed.
    expect(mockRecordExecutionWindowReceipt).toHaveBeenCalledTimes(1)
    expect(job.data.completedTimeframes).toEqual([90])
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
    expect(mockExecutionClose).toHaveBeenCalledWith('failed')
    for (const [input] of mockPublishTrustedLeaderboardSnapshot.mock.calls) {
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
    const claimImplementation = mockClaimSourceJobExecutionAuthority.getMockImplementation()!
    mockClaimSourceJobExecutionAuthority.mockImplementation(async (...args: unknown[]) => {
      events.push('claim')
      return claimImplementation(...args)
    })
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
        }
      }
    )
    mockRecordFieldInventory.mockImplementation(async () => {
      events.push('field')
    })
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
    mockRecordExecutionWindowReceipt.mockImplementation(
      async (_writer: unknown, input: { timeframe: RankingTimeframe }) => {
        events.push(`receipt:${input.timeframe}`)
        return { timeframe: input.timeframe }
      }
    )
    mockExecutionClose.mockImplementation(async (phase: 'completed' | 'failed' | 'revoked') => {
      events.push(`execution:close:${phase}`)
      return { phase }
    })

    await expect(processTierA(job)).resolves.toHaveLength(2)

    expect(events).toEqual([
      'claim',
      'begin:7',
      'session:open',
      'capture:7',
      'raw:7',
      'field',
      'finish:7',
      'publish:7',
      'receipt:7',
      'checkpoint:7',
      'begin:30',
      'capture:30',
      'raw:30',
      'field',
      'finish:30',
      'publish:30',
      'receipt:30',
      'checkpoint:30',
      'session:close',
      'execution:close:completed',
    ])
    expect(mockOpenSession).toHaveBeenCalledTimes(1)
    expect(mockStartLeaderboardAcquisitionAttempt.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        sourceId: binanceSrc.id,
        timeframe: 7,
        observationCycleId: expectedCycleId,
        queueJobId: job.id,
        queueAttempt: job.attemptsMade,
        runnerGitSha: 'c'.repeat(40),
        workerRegion: 'vps_sg',
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
    for (const [, transaction] of mockAttemptTransaction.mock.calls) {
      expect(transaction).toBe(mockClaimedWriteClient)
    }
    for (const [, transaction] of mockRawPointerTransaction.mock.calls) {
      expect(transaction).toBe(mockClaimedWriteClient)
    }
    for (const [transaction] of mockFieldInventoryTransaction.mock.calls) {
      expect(transaction).toBe(mockClaimedWriteClient)
    }
    for (const [transaction] of mockReceiptWriterTransaction.mock.calls) {
      expect(transaction).toBe(mockClaimedWriteClient)
    }
    const claimedExecution = await mockClaimSourceJobExecutionAuthority.mock.results[0].value
    for (const [, publicationExecution] of mockPublicationExecution.mock.calls) {
      expect(publicationExecution).toBe(claimedExecution)
    }
    expect(mockDirectJobUpdateData).not.toHaveBeenCalled()
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
            })
        })
      }
    )

    const pending = processTierA(job)
    await finishCalled
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockPublishFencedBoardSeries).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()

    resolveFinish(undefined)
    await expect(pending).resolves.toHaveLength(1)
    expect(mockPublishTrustedLeaderboardSnapshot).toHaveBeenCalledTimes(1)
    expect(mockJobUpdateData).toHaveBeenCalledTimes(1)
  })

  it('binds a registered attempt to the database-attested execution SHA', async () => {
    configureAttemptBoundSource()

    await expect(processTierA(job)).resolves.toHaveLength(1)
    expect(mockStartLeaderboardAcquisitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ runnerGitSha: 'c'.repeat(40) })
    )
  })

  it('records execution provenance separately from the consumed queue authority', async () => {
    configureAttemptBoundSource()

    await expect(
      processTierAInRegion(job, createAuthorizedTestContext('vps_sg', 'local'))
    ).resolves.toHaveLength(1)
    expect(mockStartLeaderboardAcquisitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ workerRegion: 'local' })
    )
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

  it('fails before source lookup when its execution signal is already aborted', async () => {
    const controller = new AbortController()
    const cancellation = new Error('authority already lost')
    controller.abort(cancellation)

    await expect(
      processTierAInRegion(job, createAuthorizedTestContext('local', 'local'), controller.signal)
    ).rejects.toBe(cancellation)

    expect(mockGetSourceBySlug).not.toHaveBeenCalled()
    expect(mockOpenSession).not.toHaveBeenCalled()
    expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).not.toHaveBeenCalled()
    expect(mockFinishLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
  })

  it('preserves the normal successful path with a live execution signal', async () => {
    const controller = new AbortController()

    await expect(
      processTierAInRegion(job, createAuthorizedTestContext('local', 'local'), controller.signal)
    ).resolves.toHaveLength(1)

    expect(mockPublishTrustedLeaderboardSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ src, timeframe: 30 }),
      expect.objectContaining({ consumedRegion: 'local' })
    )
    expect(mockPublicationExecution).toHaveBeenCalledWith('trusted-snapshot', expect.any(Object))
    expect(mockJobUpdateData).toHaveBeenCalledTimes(1)
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('fails a completed close that is downgraded to another phase', async () => {
    mockExecutionClose.mockResolvedValueOnce({ phase: 'revoked' })

    await expect(processTierA(job)).rejects.toThrow(
      'execution close phase mismatch: requested=completed, returned=revoked'
    )

    expect(mockSessionClose).toHaveBeenCalledTimes(1)
    expect(mockExecutionClose).toHaveBeenCalledWith('completed')
  })

  it('aggregates processing, session-close, and execution-close failures', async () => {
    const processingFailure = new Error('upstream failed')
    const sessionFailure = new Error('session close failed')
    const executionCloseFailure = new Error('execution close failed')
    mockGetAdapter.mockReturnValue({
      captureLeaderboard: jest.fn(async () => {
        throw processingFailure
      }),
      listLeaderboard: async function* () {
        throw new Error('Tier-A must never use the uncaptured stream')
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
      parseLeaderboardSeries: () => new Map(),
    })
    mockSessionClose.mockRejectedValueOnce(sessionFailure)
    mockExecutionClose.mockRejectedValueOnce(executionCloseFailure)
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
    expect((failure as AggregateError).errors).toHaveLength(3)
    expect((failure as AggregateError).errors[1]).toBe(sessionFailure)
    expect((failure as AggregateError).errors[2]).toBe(executionCloseFailure)
    expect(mockExecutionClose).toHaveBeenCalledWith('failed')
  })

  it('leaves an open attempt and closes its session when authority is lost during capture', async () => {
    const captureStarted = deferred()
    const finishCapture = deferred()
    const captureLeaderboard = jest.fn(async () => {
      captureStarted.resolve()
      await finishCapture.promise
      return capturedLeaderboard()
    })
    configureAttemptBoundSource([30], captureLeaderboard)
    const controller = new AbortController()
    const cancellation = new Error('regional authority lost')

    const run = processTierAInRegion(
      job,
      createAuthorizedTestContext('vps_sg', 'vps_sg'),
      controller.signal
    )
    await captureStarted.promise
    controller.abort(cancellation)
    await Promise.resolve()

    expect(mockSessionClose).toHaveBeenCalledTimes(1)
    finishCapture.resolve()
    await expect(run).rejects.toBe(cancellation)
    expect(mockStartLeaderboardAcquisitionAttempt).toHaveBeenCalledTimes(1)
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).not.toHaveBeenCalled()
    expect(mockFinishLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
    expect(mockJobUpdateData).not.toHaveBeenCalled()
    expect(mockExecutionClose).toHaveBeenCalledWith('revoked')
  })

  it('preserves a concurrent business error and abort reason without finalizing the open attempt', async () => {
    const controller = new AbortController()
    const businessFailure = new Error('capture business failure')
    const cancellation = new Error('authority revoked concurrently')
    configureAttemptBoundSource(
      [30],
      jest.fn(async () => {
        controller.abort(cancellation)
        throw businessFailure
      })
    )

    let failure: unknown
    try {
      await processTierAInRegion(
        job,
        createAuthorizedTestContext('vps_sg', 'vps_sg'),
        controller.signal
      )
    } catch (cause) {
      failure = cause
    }

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([businessFailure, cancellation])
    expect(mockFinishLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
    expect(mockExecutionClose).toHaveBeenCalledWith('revoked')
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
      expect(mockPublishFencedBoardSeries).not.toHaveBeenCalled()
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
    expect(diagnosticInput).toMatchObject({
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
          capture_contract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
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
    expect(diagnosticInput.meta.capture_evidence).toMatchObject({
      mode: 'identity',
      capture_config: parserCapture.captureConfig,
      parser_transformation: parserCapture.parserTransformation,
    })
    expect(diagnosticInput.meta.capture_evidence.source_pages).toHaveLength(
      parserCapture.sourcePages.length
    )
    expect(diagnosticInput.meta.capture_evidence.source_pages[0]).toMatchObject({
      ordinal: 1,
      stored_page_index: parserCapture.sourcePages[0].rawPage.pageIndex,
      payload_sha256: strictCanonicalSha256(parserCapture.sourcePages[0].rawPage.payload),
      request_sha256: parserCapture.sourcePages[0].requestSha256,
      pagination_position: parserCapture.sourcePages[0].paginationPosition,
      source_reports: parserCapture.sourcePages[0].sourceReports,
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
    mockGetExecutionWindowReceipt.mockImplementation(
      async (_transaction: unknown, input: { timeframe: number }) =>
        input.timeframe === 7 ? { timeframe: 7 } : null
    )

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
    mockFindRegisteredAttemptBoundContract.mockResolvedValue(null)
    const captureLeaderboard = jest.fn(async () => capturedLeaderboard())
    mockGetAdapter.mockReturnValue({
      captureLeaderboard,
      listLeaderboard: async function* () {
        throw new Error('Tier-A must never use the uncaptured stream')
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
      parseLeaderboardSeries: () => new Map(),
    })

    // A shared capture method is not a registration: the unregistered source
    // fails closed instead of publishing without attempt-bound evidence.
    await expect(processTierA(job)).rejects.toThrow(
      'binance_spot v3 capture contract is not exactly registered'
    )

    expect(mockFindRegisteredAttemptBoundContract).toHaveBeenCalledWith({
      sourceId: spotSrc.id,
      adapterSlug: 'binance',
      captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
    })
    expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
    expect(captureLeaderboard).not.toHaveBeenCalled()
    expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).not.toHaveBeenCalled()
    expect(mockPublishTrustedLeaderboardSnapshot).not.toHaveBeenCalled()
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
    mockFindRegisteredAttemptBoundContract.mockResolvedValue(
      ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT
    )
    mockGetAdapter.mockReturnValue({
      listLeaderboard: async function* () {
        yield page
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
    })

    await expect(processTierA(job)).rejects.toThrow(
      'adapter has no attempt-bound capture implementation'
    )
    expect(mockFindRegisteredAttemptBoundContract).not.toHaveBeenCalled()
    expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
    expect(mockOpenSession).not.toHaveBeenCalled()
    expect(mockWriteRawObject).not.toHaveBeenCalled()
  })

  it('does not acquire the Tier-A profile lane before timeframe preparation succeeds', async () => {
    mockNativeRankingTimeframes.mockImplementation(() => {
      throw new Error('invalid timeframe config')
    })

    await expect(processTierA(job)).rejects.toThrow('invalid timeframe config')
    expect(mockOpenSession).not.toHaveBeenCalled()
    expect(mockSessionClose).not.toHaveBeenCalled()
  })

  describe('republish of an earlier attempt that captured but failed to publish', () => {
    const CAPTURED_BY_CLAIM = '10000000-0000-4000-8000-000000000000'
    let warnSpy: jest.SpyInstance
    let logSpy: jest.SpyInstance
    let errorSpy: jest.SpyInstance

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
      warnSpy.mockRestore()
      logSpy.mockRestore()
      errorSpy.mockRestore()
    })

    function warnLines(): string[] {
      return warnSpy.mock.calls.map((call) => String(call[0]))
    }

    function logLines(): string[] {
      return logSpy.mock.calls.map((call) => String(call[0]))
    }

    /**
     * Run the ordinary capture path once with a failing publication (as on
     * 11-27), and return what a later queue attempt finds in the database:
     * the earlier attempt, its terminal outcome and its two stored RAWs.
     * With several timeframes every window captures and fails to publish;
     * `republishable` selects which of them the lookup then offers.
     */
    async function recordCaptureThatFailedToPublish(
      options: {
        timeframes?: Array<7 | 30 | 90>
        republishable?: Array<7 | 30 | 90>
        capture?: () => LeaderboardCapture
      } = {}
    ) {
      const timeframes = options.timeframes ?? [30]
      const captureLeaderboard = configureAttemptBoundSource(
        timeframes,
        jest.fn(async () => (options.capture ?? capturedLeaderboard)())
      )
      for (const _timeframe of timeframes) {
        mockPublishTrustedLeaderboardSnapshot.mockRejectedValueOnce(
          Object.assign(new Error('canceling statement due to statement timeout'), {
            code: '57014',
          })
        )
      }
      await expect(processTierA(job)).rejects.toThrow('native windows failed')
      expect(captureLeaderboard).toHaveBeenCalledTimes(timeframes.length)

      const writes = attemptBoundRawWrites()
      const byTimeframe = new Map<
        number,
        {
          latest: {
            attempt: Record<string, unknown>
            outcome: Record<string, unknown>
            databaseNow: string
          }
          attempt: LeaderboardAcquisitionAttempt & { executionGenerationSeq: number }
          storedManifest: Record<string, unknown>
          storedPages: RawPage[]
          projection: ReturnType<typeof attemptBoundRawReceipt>['projection']
        }
      >()
      for (const [index] of timeframes.entries()) {
        const startedAttempt = (await mockStartLeaderboardAcquisitionAttempt.mock.results[index]
          .value) as LeaderboardAcquisitionAttempt
        const write = writes[index]
        const artifacts = (await mockWriteAttemptBoundLeaderboardRawArtifactSet.mock.results[index]
          .value) as ReturnType<typeof attemptBoundRawReceipt>
        const projection = artifacts.projection
        const attempt = Object.freeze({
          ...startedAttempt,
          queueAttempt: job.attemptsMade - 1,
          executionClaimId: CAPTURED_BY_CLAIM,
          executionGenerationSeq: 16,
        })
        const latest = {
          attempt,
          outcome: {
            terminalState: projection.terminalState,
            acquisitionState: projection.acquisitionState,
            populationState: projection.populationState,
            reasonCode: projection.reasonCode,
            captureEvidenceState: projection.captureEvidenceState,
            terminationReason: projection.terminationReason,
            captureStartedAt: projection.binding.captureStartedAt,
            captureCompletedAt: projection.binding.captureCompletedAt,
            sourceRunId: projection.sourceRunId,
            sourcePayload: artifacts.sourcePayload,
            populationManifest: artifacts.populationManifest,
            diagnosticRawObjectId: null,
            failureStage: null,
            reportedPopulation: projection.reportedPopulation,
            populationReportState: projection.populationReportState,
            sourcePageCount: projection.sourcePageCount,
            reportedPageCount: projection.reportedPageCount,
            pageCountReportState: projection.pageCountReportState,
            observedPopulation: projection.observedPopulation,
            acceptedPopulation: projection.acceptedPopulation,
            rejectedRowCount: projection.rejectedRowCount,
            deduplicatedRowCount: projection.deduplicatedRowCount,
            callerLimited: projection.callerLimited,
            safetyLimited: projection.safetyLimited,
            exhaustionEvidencePresent: projection.exhaustionVerified,
            gatedSnapshotPresent: false,
          },
          databaseNow: new Date().toISOString(),
        }
        byTimeframe.set(startedAttempt.timeframe, {
          latest,
          attempt,
          storedManifest: JSON.parse(JSON.stringify(write.manifest)) as Record<string, unknown>,
          storedPages: JSON.parse(JSON.stringify(write.sourcePages)) as RawPage[],
          projection,
        })
      }
      const republishable = new Set(options.republishable ?? timeframes)
      mockFindLatestTierAWindowAttempt.mockImplementation(
        async (_transaction: unknown, input: { timeframe: number }) =>
          republishable.has(input.timeframe as 7 | 30 | 90)
            ? (byTimeframe.get(input.timeframe)?.latest ?? null)
            : null
      )
      mockReadTrustRaw.mockImplementation(
        async (input: { role: string; expectedTimeframe: number }) => {
          const stored = byTimeframe.get(input.expectedTimeframe)!
          return input.role === 'population_manifest'
            ? JSON.parse(JSON.stringify(stored.storedManifest))
            : JSON.parse(JSON.stringify(stored.storedPages))
        }
      )

      // The retry: a fresh claim of the same job, nothing else carried over.
      mockStartLeaderboardAcquisitionAttempt.mockClear()
      mockWriteAttemptBoundLeaderboardRawArtifactSet.mockClear()
      mockFinishLeaderboardAcquisitionAttempt.mockClear()
      mockPublishTrustedLeaderboardSnapshot.mockClear()
      mockRecordExecutionWindowReceipt.mockClear()
      mockOpenSession.mockClear()
      captureLeaderboard.mockClear()
      warnSpy.mockClear()
      logSpy.mockClear()
      const first = byTimeframe.get(timeframes[0])!
      return { captureLeaderboard, byTimeframe, ...first }
    }

    function expectRescanned(captureLeaderboard: jest.Mock) {
      expect(captureLeaderboard).toHaveBeenCalledTimes(1)
      expect(mockStartLeaderboardAcquisitionAttempt).toHaveBeenCalledTimes(1)
      expect(mockRecordRepublishReceipt).not.toHaveBeenCalled()
      expect(mockRecordExecutionWindowReceipt).toHaveBeenCalledTimes(1)
    }

    function expectSkipped(reason: string, attemptSeq: number) {
      expect(warnLines()).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            new RegExp(
              `^\\[tier-a\\] republish skipped reason=${reason} source=binance_futures tf=30d attempt_seq=${attemptSeq}( |$)`
            )
          ),
        ])
      )
    }

    it('stays on the capture path without a candidate and logs no skip', async () => {
      const captureLeaderboard = configureAttemptBoundSource([30])

      await expect(processTierA(job)).resolves.toHaveLength(1)

      expect(mockFindLatestTierAWindowAttempt).toHaveBeenCalledTimes(1)
      expect(mockHasRepublishReceipt).not.toHaveBeenCalled()
      expect(mockReadTrustRaw).not.toHaveBeenCalled()
      expectRescanned(captureLeaderboard)
      expect(warnLines().some((line) => line.includes('republish'))).toBe(false)
    })

    it('does not look for a candidate on the first queue attempt', async () => {
      configureAttemptBoundSource([30])
      job.attemptsMade = 0

      await expect(processTierA(job)).resolves.toHaveLength(1)

      expect(mockFindLatestTierAWindowAttempt).not.toHaveBeenCalled()
    })

    it('re-publishes the recorded capture without rescanning or starting an attempt', async () => {
      const { captureLeaderboard, attempt, storedManifest, projection } =
        await recordCaptureThatFailedToPublish()

      const results = await processTierA(job)

      expect(results).toEqual([
        expect.objectContaining({ timeframe: 30, actualCount: 1, snapshotId: 777 }),
      ])
      expect(captureLeaderboard).not.toHaveBeenCalled()
      expect(mockOpenSession).not.toHaveBeenCalled()
      expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
      expect(mockWriteAttemptBoundLeaderboardRawArtifactSet).not.toHaveBeenCalled()
      expect(mockFinishLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
      expect(mockHasRepublishReceipt).toHaveBeenCalledTimes(1)
      expect(mockReadTrustRaw).toHaveBeenCalledTimes(2)
      expect(mockRecordExecutionWindowReceipt).not.toHaveBeenCalled()
      expect(mockRecordRepublishReceipt).toHaveBeenCalledTimes(1)
      expect(mockRecordRepublishReceipt.mock.calls[0][1]).toEqual({
        attemptId: attempt.attemptId,
        observationCycleId: expectedCycleId,
        rawObjectId: 9_200 + 30 * 2 + 1,
        snapshotId: 777,
        sourceRunId: projection.sourceRunId,
        timeframe: 30,
      })
      const [publishInput] = mockPublishTrustedLeaderboardSnapshot.mock.calls[0] as [
        { rows: ParsedLeaderboardRow[]; trust: { sourceRunId: string; manifest: unknown } },
      ]
      expect(publishInput.trust.sourceRunId).toBe(projection.sourceRunId)
      expect(JSON.parse(JSON.stringify(publishInput.trust.manifest))).toEqual(storedManifest)
      expect(publishInput.rows).toEqual([expect.objectContaining({ exchangeTraderId: 'xt-1' })])
      expect(logLines()).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            new RegExp(
              `^\\[tier-a\\] republished source=binance_futures tf=30d attempt_seq=${attempt.attemptSeq} rows=1 ms=\\d+$`
            )
          ),
        ])
      )
      expect(warnLines().some((line) => line.includes('republish skipped'))).toBe(false)
      expect(job.data.completedTimeframes).toEqual([30])
    })

    it.each([
      [
        'sha_mismatch',
        (latest: { attempt: Record<string, unknown> }) => {
          latest.attempt = { ...latest.attempt, runnerGitSha: 'a'.repeat(40) }
        },
      ],
      [
        'contract_unsupported',
        (latest: { attempt: Record<string, unknown> }) => {
          latest.attempt = {
            ...latest.attempt,
            captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
          }
        },
      ],
      [
        'stale',
        (latest: { databaseNow: string }) => {
          latest.databaseNow = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString()
        },
      ],
    ])('skips a %s candidate before reading RAW and rescans', async (reason, mutate) => {
      const { captureLeaderboard, latest, attempt } = await recordCaptureThatFailedToPublish()
      mutate(latest as never)

      await expect(processTierA(job)).resolves.toHaveLength(1)

      expectSkipped(reason, attempt.attemptSeq)
      expect(mockReadTrustRaw).not.toHaveBeenCalled()
      expectRescanned(captureLeaderboard)
    })

    it('skips receipt_rpc_unavailable when the migration is not applied, before publishing', async () => {
      const { captureLeaderboard, attempt } = await recordCaptureThatFailedToPublish()
      mockHasRepublishReceipt.mockResolvedValueOnce(false)

      await expect(processTierA(job)).resolves.toHaveLength(1)

      expectSkipped('receipt_rpc_unavailable', attempt.attemptSeq)
      expect(mockReadTrustRaw).not.toHaveBeenCalled()
      expect(mockPublishTrustedLeaderboardSnapshot).toHaveBeenCalledTimes(1)
      expectRescanned(captureLeaderboard)
    })

    it('skips receipt_rpc_unavailable when the probe itself fails', async () => {
      const { captureLeaderboard, attempt } = await recordCaptureThatFailedToPublish()
      mockHasRepublishReceipt.mockRejectedValueOnce(new Error('probe unavailable'))

      await expect(processTierA(job)).resolves.toHaveLength(1)

      expectSkipped('receipt_rpc_unavailable', attempt.attemptSeq)
      expectRescanned(captureLeaderboard)
    })

    it.each([
      ['raw_unreadable', 'unreadable'],
      ['raw_hash_mismatch', 'hash_mismatch'],
    ])('skips %s and rescans', async (reason, failure) => {
      const { captureLeaderboard, attempt } = await recordCaptureThatFailedToPublish()
      const { LeaderboardTrustRawReadError } = jest.requireMock('@/lib/ingest/raw') as {
        LeaderboardTrustRawReadError: new (failure: string) => Error
      }
      mockReadTrustRaw.mockRejectedValueOnce(new LeaderboardTrustRawReadError(failure))

      await expect(processTierA(job)).resolves.toHaveLength(1)

      expectSkipped(reason, attempt.attemptSeq)
      expectRescanned(captureLeaderboard)
    })

    it.each([
      [
        'a manifest bound to another attempt',
        (manifest: Record<string, unknown>) => {
          const binding = manifest.acquisition_attempt as Record<string, unknown>
          manifest.acquisition_attempt = { ...binding, attempt_seq: 9_999 }
        },
      ],
      [
        'a manifest that does not hash to the outcome source run',
        (manifest: Record<string, unknown>) => {
          manifest.caller_limited = !manifest.caller_limited
        },
      ],
      [
        'a manifest that is not strict v3',
        (manifest: Record<string, unknown>) => {
          manifest.unexpected = true
        },
      ],
    ])('skips manifest_mismatch for %s', async (_label, mutate) => {
      const { captureLeaderboard, attempt, storedManifest, storedPages } =
        await recordCaptureThatFailedToPublish()
      const tampered = JSON.parse(JSON.stringify(storedManifest)) as Record<string, unknown>
      mutate(tampered)
      mockReadTrustRaw.mockImplementation(async (input: { role: string }) =>
        input.role === 'population_manifest' ? tampered : JSON.parse(JSON.stringify(storedPages))
      )

      await expect(processTierA(job)).resolves.toHaveLength(1)

      expectSkipped('manifest_mismatch', attempt.attemptSeq)
      expectRescanned(captureLeaderboard)
    })

    it.each([
      [
        'a tampered page payload',
        (pages: RawPage[]) => {
          pages[0] = { ...pages[0], payload: { result: { items: [{ accountId: 'forged' }] } } }
        },
      ],
      ['a missing page', (pages: RawPage[]) => void pages.pop()],
      ['reordered pages', (pages: RawPage[]) => void pages.reverse()],
    ])('skips page_hash_mismatch for %s', async (_label, mutate) => {
      const { captureLeaderboard, attempt, storedManifest, storedPages } =
        await recordCaptureThatFailedToPublish()
      const tampered = JSON.parse(JSON.stringify(storedPages)) as RawPage[]
      mutate(tampered)
      mockReadTrustRaw.mockImplementation(async (input: { role: string }) =>
        input.role === 'population_manifest' ? JSON.parse(JSON.stringify(storedManifest)) : tampered
      )

      await expect(processTierA(job)).resolves.toHaveLength(1)

      expectSkipped('page_hash_mismatch', attempt.attemptSeq)
      expectRescanned(captureLeaderboard)
    })

    it('skips parse_mismatch when the re-parse disagrees with the recorded counts', async () => {
      const { captureLeaderboard, attempt } = await recordCaptureThatFailedToPublish()
      mockValidateLeaderboardRows.mockImplementationOnce((rows: ParsedLeaderboardRow[]) => ({
        valid: [],
        rejects: rows.map((parsedRow) => ({ row: parsedRow, reason: 'replay' })),
      }))

      await expect(processTierA(job)).resolves.toHaveLength(1)

      expectSkipped('parse_mismatch', attempt.attemptSeq)
      expectRescanned(captureLeaderboard)
    })

    it('skips parse_mismatch when the adapter parser now throws', async () => {
      const { captureLeaderboard, attempt } = await recordCaptureThatFailedToPublish()
      const adapter = mockGetAdapter.mock.results.at(-1)!.value as {
        parseLeaderboard: (...args: unknown[]) => unknown
      }
      const parse = adapter.parseLeaderboard
      let calls = 0
      adapter.parseLeaderboard = (...args: unknown[]) => {
        calls += 1
        if (calls === 1) throw new Error('parser changed')
        return parse(...args)
      }

      await expect(processTierA(job)).resolves.toHaveLength(1)

      expectSkipped('parse_mismatch', attempt.attemptSeq)
      expectRescanned(captureLeaderboard)
    })

    it('fails the window on a transient publish_failed without rescanning in the same job attempt', async () => {
      const { captureLeaderboard, attempt } = await recordCaptureThatFailedToPublish()
      mockPublishTrustedLeaderboardSnapshot.mockRejectedValueOnce(
        Object.assign(new Error('write deadline'), { code: '57014' })
      )

      const failure = await processTierA(job).then(
        () => null,
        (error: unknown) => error as AggregateError
      )
      expect(failure?.message).toContain('1/1 native windows failed (30d)')
      expect(failure?.errors.map((error: Error) => error.message)).toEqual([
        '[tier-a] binance_futures 30d failed: write deadline',
      ])

      expectSkipped('publish_failed', attempt.attemptSeq)
      expect(captureLeaderboard).not.toHaveBeenCalled()
      expect(mockOpenSession).not.toHaveBeenCalled()
      expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
      expect(mockRecordRepublishReceipt).not.toHaveBeenCalled()
      expect(mockRecordExecutionWindowReceipt).not.toHaveBeenCalled()
      expect(mockExecutionClose).toHaveBeenLastCalledWith('failed')
    })

    it('rescans after a GATED republish instead of failing every retry', async () => {
      const { captureLeaderboard, attempt } = await recordCaptureThatFailedToPublish()
      mockPublishTrustedLeaderboardSnapshot.mockResolvedValueOnce({
        snapshotId: 790,
        scrapedAt: '2026-07-16 00:01:02.123456+00',
        verdict: { passed: false, baselineUsed: 500, deviationPct: -99.8 },
        published: false,
        traderIds: new Map(),
        trust: { sourceRunId: 'c'.repeat(64), observationsWritten: 0, artifactRefsWritten: 0 },
      })

      await expect(processTierA(job)).resolves.toHaveLength(1)

      expectSkipped('count_check_gated', attempt.attemptSeq)
      expect(mockPublishTrustedLeaderboardSnapshot).toHaveBeenCalledTimes(2)
      expectRescanned(captureLeaderboard)
    })

    it('skips a capture whose snapshot is already GATED before reading RAW', async () => {
      const { captureLeaderboard, latest, attempt } = await recordCaptureThatFailedToPublish()
      latest.outcome = { ...latest.outcome, gatedSnapshotPresent: true }

      await expect(processTierA(job)).resolves.toHaveLength(1)

      expectSkipped('count_check_gated', attempt.attemptSeq)
      expect(mockReadTrustRaw).not.toHaveBeenCalled()
      expectRescanned(captureLeaderboard)
    })

    it.each([
      [
        'an identity conflict',
        () =>
          mockPublishTrustedLeaderboardSnapshot.mockRejectedValueOnce(
            Object.assign(new Error('duplicate trader identity'), { code: '23505' })
          ),
      ],
      [
        'an exhaustion proof that no longer holds',
        () =>
          mockPublishTrustedLeaderboardSnapshot.mockRejectedValueOnce(
            new Error(
              'attempt-bound trusted publication requires one exact complete acquisition outcome'
            )
          ),
      ],
      [
        'a missing metric trust contract',
        () => mockHasRegisteredLeaderboardMetricTrust.mockReturnValueOnce(false),
      ],
      [
        'an unknown error',
        () => mockPublishTrustedLeaderboardSnapshot.mockRejectedValueOnce(new Error('unexpected')),
      ],
    ])('rescans on a deterministic publish failure: %s', async (_label, arrange) => {
      const { captureLeaderboard, attempt } = await recordCaptureThatFailedToPublish()
      arrange()

      await expect(processTierA(job)).resolves.toHaveLength(1)

      expectSkipped('publish_rejected', attempt.attemptSeq)
      expectRescanned(captureLeaderboard)
    })

    it.each([
      ['a statement timeout', { code: '57014' }],
      ['a dropped connection', { code: 'ECONNRESET' }],
      ['a lock timeout', { code: '55P03' }],
      ['a server-side transaction timeout (25P04)', { code: '25P04' }],
    ])('fails without rescanning on a transient publish failure: %s', async (_label, fields) => {
      const { captureLeaderboard, attempt } = await recordCaptureThatFailedToPublish()
      mockPublishTrustedLeaderboardSnapshot.mockRejectedValueOnce(
        Object.assign(new Error('publication failed'), fields)
      )

      await expect(processTierA(job)).rejects.toThrow('1/1 native windows failed (30d)')

      expectSkipped('publish_failed', attempt.attemptSeq)
      expect(captureLeaderboard).not.toHaveBeenCalled()
      expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
    })

    it('skips a candidate inside the freshness margin and rescans', async () => {
      const { captureLeaderboard, latest, attempt } = await recordCaptureThatFailedToPublish()
      latest.databaseNow = new Date(
        Date.parse(attempt.recordedStartedAt) + 6 * 60 * 60 * 1000 - 10 * 60 * 1000
      ).toISOString()

      await expect(processTierA(job)).resolves.toHaveLength(1)

      expectSkipped('stale', attempt.attemptSeq)
      expect(mockReadTrustRaw).not.toHaveBeenCalled()
      expectRescanned(captureLeaderboard)
    })

    it('re-publishes an exhausted capture with a holding proof', async () => {
      const { captureLeaderboard, attempt, projection } = await recordCaptureThatFailedToPublish({
        capture: exhaustedLeaderboardCapture,
      })
      expect(projection.terminalState).toBe('unknown')
      expect(projection.exhaustionVerified).toBe(true)

      await expect(processTierA(job)).resolves.toEqual([
        expect.objectContaining({ timeframe: 30, snapshotId: 777 }),
      ])

      expect(captureLeaderboard).not.toHaveBeenCalled()
      expect(mockRecordRepublishReceipt).toHaveBeenCalledTimes(1)
      expect(logLines()).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            `[tier-a] republished source=binance_futures tf=30d attempt_seq=${attempt.attemptSeq} rows=1`
          ),
        ])
      )
    })

    it('re-publishes 7D and rescans 30D in one job', async () => {
      const { captureLeaderboard, byTimeframe } = await recordCaptureThatFailedToPublish({
        timeframes: [7, 30],
        republishable: [7],
      })

      const results = await processTierA(job)

      expect(results.map((result) => result.timeframe)).toEqual([7, 30])
      expect(captureLeaderboard).toHaveBeenCalledTimes(1)
      expect(captureLeaderboard.mock.calls[0][2]).toBe(30)
      expect(mockRecordRepublishReceipt).toHaveBeenCalledTimes(1)
      expect(mockRecordRepublishReceipt.mock.calls[0][1]).toEqual(
        expect.objectContaining({ timeframe: 7, attemptId: byTimeframe.get(7)!.attempt.attemptId })
      )
      expect(mockRecordExecutionWindowReceipt).toHaveBeenCalledTimes(1)
      expect(mockRecordExecutionWindowReceipt.mock.calls[0][1]).toEqual(
        expect.objectContaining({ timeframe: 30 })
      )
      expect(job.data.completedTimeframes).toEqual([7, 30])
    })

    it.each(['55000', '42501'])(
      'fails the job when the republish receipt is refused (%s) after publication',
      async (code) => {
        const { captureLeaderboard, attempt } = await recordCaptureThatFailedToPublish()
        const { TierAExecutionWindowReceiptError } = jest.requireMock(
          '@/worker/src/ingest/tier-a-execution-window-receipt'
        ) as { TierAExecutionWindowReceiptError: new (message: string) => Error }
        const refusal = Object.assign(new TierAExecutionWindowReceiptError('receipt refused'), {
          code: 'unavailable',
          cause: Object.assign(new Error('refused'), { code }),
        })
        mockRecordRepublishReceipt.mockRejectedValueOnce(refusal)

        await expect(processTierA(job)).rejects.toBe(refusal)

        expectSkipped('publish_failed', attempt.attemptSeq)
        expect(mockPublishTrustedLeaderboardSnapshot).toHaveBeenCalledTimes(1)
        expect(captureLeaderboard).not.toHaveBeenCalled()
        expect(job.data.completedTimeframes ?? []).toEqual([])
      }
    )

    it('keeps the 11-27 write deadline transient: window fails, no rescan, no new attempt', async () => {
      const { captureLeaderboard, attempt } = await recordCaptureThatFailedToPublish()
      const { WorkerDbFenceError } = jest.requireActual(
        '@/lib/ingest/db-fenced-write-contract'
      ) as {
        WorkerDbFenceError: new (code: string, operation: string, retryPolicy: string) => Error
      }
      mockPublishTrustedLeaderboardSnapshot.mockRejectedValueOnce(
        new WorkerDbFenceError('write_deadline_exceeded', 'write', 'never')
      )

      const failure = await processTierA(job).then(
        () => null,
        (error: unknown) => error as AggregateError
      )

      expect(failure?.message).toContain('1/1 native windows failed (30d)')
      expect(failure?.errors.map((error: Error) => error.message)).toEqual([
        '[tier-a] binance_futures 30d failed: [ingest-worker] worker database fence write failed (write_deadline_exceeded)',
      ])
      expectSkipped('publish_failed', attempt.attemptSeq)
      expect(captureLeaderboard).not.toHaveBeenCalled()
      expect(mockOpenSession).not.toHaveBeenCalled()
      expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
      expect(mockExecutionClose).toHaveBeenLastCalledWith('failed')
    })

    it.each(['control_plane_unavailable', 'lease_deadline_exceeded', 'commit_aborted'])(
      'keeps the fence code %s transient without a same-attempt rescan',
      async (code) => {
        const { captureLeaderboard, attempt } = await recordCaptureThatFailedToPublish()
        const { WorkerDbFenceError } = jest.requireActual(
          '@/lib/ingest/db-fenced-write-contract'
        ) as {
          WorkerDbFenceError: new (code: string, operation: string, retryPolicy: string) => Error
        }
        mockPublishTrustedLeaderboardSnapshot.mockRejectedValueOnce(
          new Error('[publish] failed', {
            cause: new WorkerDbFenceError(code, 'write', 'reacquire'),
          })
        )

        await expect(processTierA(job)).rejects.toThrow('1/1 native windows failed (30d)')

        expectSkipped('publish_failed', attempt.attemptSeq)
        expect(captureLeaderboard).not.toHaveBeenCalled()
        expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
      }
    )

    it.each([
      ['region_lost', 'SourceJobExecutionError'],
      ['commit_outcome_unknown', 'WorkerDbFenceError'],
    ])('rethrows %s: the job fails and nothing rescans', async (code, kind) => {
      const { captureLeaderboard, attempt } = await recordCaptureThatFailedToPublish()
      const { WorkerDbFenceError } = jest.requireActual(
        '@/lib/ingest/db-fenced-write-contract'
      ) as {
        WorkerDbFenceError: new (code: string, operation: string, retryPolicy: string) => Error
      }
      const authorityFailure =
        kind === 'WorkerDbFenceError'
          ? new WorkerDbFenceError(code, 'write', 'never')
          : Object.assign(new Error(`[ingest-worker] Tier-A execution assert failed (${code})`), {
              name: 'SourceJobExecutionError',
              code,
            })
      mockPublishTrustedLeaderboardSnapshot.mockRejectedValueOnce(authorityFailure)

      await expect(processTierA(job)).rejects.toBe(authorityFailure)

      expectSkipped('publish_failed', attempt.attemptSeq)
      expect(captureLeaderboard).not.toHaveBeenCalled()
      expect(mockOpenSession).not.toHaveBeenCalled()
      expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
      expect(mockRecordRepublishReceipt).not.toHaveBeenCalled()
    })

    it('does not rescan when a deterministic-looking failure hides an ownership loss', async () => {
      const { captureLeaderboard } = await recordCaptureThatFailedToPublish()
      const lost = new Error('bull lock lost')
      mockPublishTrustedLeaderboardSnapshot.mockImplementationOnce(async () => {
        mockExecutionAssertActive.mockImplementation(() => {
          throw lost
        })
        throw Object.assign(new Error('duplicate trader identity'), { code: '23505' })
      })

      await expect(processTierA(job)).rejects.toBeDefined()

      expect(captureLeaderboard).not.toHaveBeenCalled()
      expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
      expect(mockExecutionClose).toHaveBeenLastCalledWith('revoked')
    })

    it('reuses the committed snapshot after a failed receipt instead of rescanning or republishing twice', async () => {
      const { captureLeaderboard, attempt, projection } = await recordCaptureThatFailedToPublish()
      // Retry 1: the republish commits snapshot 777, then the receipt fails.
      const receiptFailure = new Error('receipt transaction failed')
      mockRecordRepublishReceipt.mockRejectedValueOnce(receiptFailure)
      await expect(processTierA(job)).rejects.toBe(receiptFailure)
      expect(mockPublishTrustedLeaderboardSnapshot).toHaveBeenCalledTimes(1)

      // Retry 2: publication reconciles the same source run to the committed
      // snapshot (reconcileLeaderboardMetricTrust) and returns it as replayed.
      mockPublishTrustedLeaderboardSnapshot.mockClear()
      mockRecordRepublishReceipt.mockClear()
      warnSpy.mockClear()
      mockPublishTrustedLeaderboardSnapshot.mockResolvedValueOnce({
        snapshotId: 777,
        scrapedAt: '2026-07-16 00:01:02.123456+00',
        verdict: { passed: true, baselineUsed: 1, deviationPct: 0 },
        published: true,
        traderIds: new Map([[row.exchangeTraderId, 42]]),
        trust: {
          sourceRunId: projection.sourceRunId,
          observationsWritten: 0,
          artifactRefsWritten: 0,
          replayed: true,
        },
      })

      await expect(processTierA(job)).resolves.toEqual([
        expect.objectContaining({ timeframe: 30, snapshotId: 777 }),
      ])

      expect(mockPublishTrustedLeaderboardSnapshot).toHaveBeenCalledTimes(1)
      const [publishInput] = mockPublishTrustedLeaderboardSnapshot.mock.calls[0] as [
        { trust: { sourceRunId: string } },
      ]
      expect(publishInput.trust.sourceRunId).toBe(projection.sourceRunId)
      expect(mockRecordRepublishReceipt).toHaveBeenCalledTimes(1)
      expect(mockRecordRepublishReceipt.mock.calls[0][1]).toEqual(
        expect.objectContaining({ attemptId: attempt.attemptId, snapshotId: 777 })
      )
      expect(captureLeaderboard).not.toHaveBeenCalled()
      expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
      expect(warnLines().some((line) => line.includes('republish skipped'))).toBe(false)
      expect(job.data.completedTimeframes).toEqual([30])
    })

    it('stops when execution authority is revoked during the republish', async () => {
      const { captureLeaderboard } = await recordCaptureThatFailedToPublish()
      const lost = new Error('execution lease lost')
      mockPublishTrustedLeaderboardSnapshot.mockImplementationOnce(async () => {
        mockExecutionAssertActive.mockImplementation(() => {
          throw lost
        })
        throw new Error('publication aborted')
      })

      await expect(processTierA(job)).rejects.toBeDefined()

      expect(captureLeaderboard).not.toHaveBeenCalled()
      expect(mockStartLeaderboardAcquisitionAttempt).not.toHaveBeenCalled()
      expect(mockRecordRepublishReceipt).not.toHaveBeenCalled()
      expect(mockExecutionClose).toHaveBeenLastCalledWith('revoked')
    })

    it('rescans when a newer snapshot already serves the window (stale publication)', async () => {
      const { captureLeaderboard, attempt } = await recordCaptureThatFailedToPublish()
      const { StaleLeaderboardPublicationError } = jest.requireActual(
        '@/lib/ingest/serving/publish'
      ) as {
        StaleLeaderboardPublicationError: new (...args: [string, number, string, string]) => Error
      }
      mockPublishTrustedLeaderboardSnapshot.mockRejectedValueOnce(
        new StaleLeaderboardPublicationError('binance_futures', 30, 'a', 'b')
      )

      await expect(processTierA(job)).resolves.toHaveLength(1)

      expectSkipped('stale', attempt.attemptSeq)
      expectRescanned(captureLeaderboard)
    })

    it('fails the job when the republish receipt itself fails after publication', async () => {
      const { captureLeaderboard, attempt } = await recordCaptureThatFailedToPublish()
      const receiptFailure = new Error('receipt conflict')
      mockRecordRepublishReceipt.mockRejectedValueOnce(receiptFailure)

      await expect(processTierA(job)).rejects.toBe(receiptFailure)

      expectSkipped('publish_failed', attempt.attemptSeq)
      expect(captureLeaderboard).not.toHaveBeenCalled()
      expect(job.data.completedTimeframes ?? []).toEqual([])
    })

    it('falls back to the capture path when the candidate lookup fails', async () => {
      const captureLeaderboard = configureAttemptBoundSource([30])
      mockFindLatestTierAWindowAttempt.mockRejectedValueOnce(new Error('lookup unavailable'))

      await expect(processTierA(job)).resolves.toHaveLength(1)

      expect(warnLines()).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            '[tier-a] republish lookup failed source=binance_futures tf=30d: lookup unavailable'
          ),
        ])
      )
      expectRescanned(captureLeaderboard)
    })
  })
})
