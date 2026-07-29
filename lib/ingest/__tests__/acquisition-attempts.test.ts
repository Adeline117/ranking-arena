const mockConnect = jest.fn()

jest.mock('../db', () => ({
  ingestClientConnect: (...args: unknown[]) => mockConnect(...args),
}))

import {
  LEADERBOARD_PARTITIONED_NUMERIC_AGGREGATION_CONTRACT,
  LEADERBOARD_PARTITIONED_NUMERIC_PARSER_PAGE_CONTRACT,
  buildLeaderboardAcquisitionManifest,
  buildLeaderboardAcquisitionManifestV3,
  buildLeaderboardAcquisitionManifestV4,
  projectPartitionedNumericParserPage,
  type BuildLeaderboardAcquisitionManifestV4Input,
} from '../acquisition-manifest'
import {
  ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
  ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V3_CONTRACT,
  ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
  findRegisteredAttemptBoundLeaderboardAcquisitionContract,
  finishLeaderboardAcquisitionAttempt,
  finishLeaderboardAcquisitionAttemptInTransaction,
  hasRegisteredAttemptBoundLeaderboardAcquisitionContract,
  LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
  LEGACY_LEADERBOARD_ACQUISITION_CONTRACT,
  projectLeaderboardManifestOutcome,
  projectLeaderboardManifestV3Outcome,
  projectLeaderboardManifestV4Outcome,
  startLeaderboardAcquisitionAttempt,
  startLeaderboardAcquisitionAttemptInTransaction,
  VERIFIED_LEADERBOARD_ACQUISITION_CONTRACT,
  type ClaimedLeaderboardAcquisitionAttempt,
  type LeaderboardAcquisitionAttempt,
  type LeaderboardAcquisitionExecutionBinding,
  type StartLeaderboardAcquisitionAttemptInput,
} from '../acquisition-attempts'
import type { IngestQueryExecutor } from '../db'

const attemptId = '00000000-0000-4000-8000-000000000001'
const executionClaimId = '00000000-0000-4000-8000-000000000099'
const startedAt = '2026-07-22T03:00:00.123Z'
const completedAt = '2026-07-22T03:00:02.456Z'

function attemptRow(overrides: Record<string, unknown> = {}) {
  return {
    attempt_seq: '41',
    attempt_id: attemptId,
    source_id: 1,
    source_slug: 'binance_futures',
    adapter_slug: 'binance',
    timeframe: 30,
    observation_cycle_id: 'tier-a:binance_futures:job-1:1000',
    queue_job_id: 'job-1',
    queue_attempt: 2,
    capture_contract: VERIFIED_LEADERBOARD_ACQUISITION_CONTRACT,
    attempt_binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
    runner_git_sha: 'a'.repeat(40),
    worker_region: 'vps_sg',
    source_status: 'active',
    source_serving_mode: 'serving',
    source_currency: 'USDT',
    source_fetch_region: 'vps_sg',
    recorded_started_at: '2026-07-22 03:00:00.123+00',
    recorded_started_at_is_millisecond: true,
    ...overrides,
  }
}

function startInput(): StartLeaderboardAcquisitionAttemptInput {
  return {
    attemptId,
    sourceId: 1,
    timeframe: 30,
    observationCycleId: 'tier-a:binance_futures:job-1:1000',
    queueJobId: 'job-1',
    queueAttempt: 2,
    captureContract: VERIFIED_LEADERBOARD_ACQUISITION_CONTRACT,
    runnerGitSha: 'a'.repeat(40),
    workerRegion: 'vps_sg',
  }
}

function attempt(
  overrides: Partial<LeaderboardAcquisitionAttempt> = {}
): LeaderboardAcquisitionAttempt {
  return {
    attemptSeq: 41,
    attemptId,
    sourceId: 1,
    sourceSlug: 'binance_futures',
    adapterSlug: 'binance',
    timeframe: 30,
    observationCycleId: 'tier-a:binance_futures:job-1:1000',
    queueJobId: 'job-1',
    queueAttempt: 2,
    captureContract: VERIFIED_LEADERBOARD_ACQUISITION_CONTRACT,
    attemptBindingContract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
    runnerGitSha: 'a'.repeat(40),
    workerRegion: 'vps_sg',
    sourceStatus: 'active',
    sourceServingMode: 'serving',
    sourceCurrency: 'USDT',
    sourceFetchRegion: 'vps_sg',
    recordedStartedAt: startedAt,
    replayed: false,
    ...overrides,
  }
}

function executionBinding(
  overrides: Partial<LeaderboardAcquisitionExecutionBinding> = {}
): LeaderboardAcquisitionExecutionBinding {
  return Object.freeze({
    claimId: executionClaimId,
    generationSeq: 7,
    sourceId: 1,
    ...overrides,
  })
}

function claimedAttempt(
  overrides: Partial<ClaimedLeaderboardAcquisitionAttempt> = {}
): ClaimedLeaderboardAcquisitionAttempt {
  return {
    ...attempt(),
    executionClaimId,
    executionGenerationSeq: 7,
    ...overrides,
  }
}

function enqueueQuery(result: { rows: unknown[] } | Error) {
  const query = jest.fn()
  if (result instanceof Error) query.mockRejectedValueOnce(result)
  else query.mockResolvedValueOnce(result)
  const release = jest.fn()
  mockConnect.mockResolvedValueOnce({ query, release })
  return { query, release }
}

function sourceReports(population: number | null, pageCount: number | null, pageSize = 1) {
  return {
    population:
      population === null
        ? ({ state: 'not_reported' } as const)
        : ({ state: 'reported', value: population } as const),
    page_count:
      pageCount === null
        ? ({ state: 'not_reported' } as const)
        : ({ state: 'reported', value: pageCount } as const),
    current_page: { state: 'reported', value: 1 } as const,
    page_size: { state: 'reported', value: pageSize } as const,
  }
}

function manifestInput(
  kind: 'complete' | 'partial' | 'unknown'
): Parameters<typeof buildLeaderboardAcquisitionManifest>[0] {
  const partial = kind === 'partial'
  const unknown = kind === 'unknown'
  const reports = sourceReports(
    unknown ? null : partial ? 2 : 1,
    partial ? 2 : null,
    unknown ? 2 : 1
  )
  const rawPage = {
    pageIndex: 1,
    payload: unknown
      ? { data: [{ id: 'one' }] }
      : { data: [{ id: 'one' }], total: partial ? 2 : 1 },
    url: 'https://example.test/leaderboard?page=1',
    fetchedAt: '2026-07-22T03:00:01.000Z',
  }
  return {
    source: {
      id: 1,
      slug: 'binance_futures',
      adapter_slug: 'binance',
      configured_page_size: unknown ? 2 : 1,
      configured_pagination_kind: 'numeric',
    },
    surface: 'tier_a_leaderboard',
    timeframe: 30,
    started_at: startedAt,
    completed_at: completedAt,
    runner_git_sha: 'a'.repeat(40),
    observation_cycle_id: 'tier-a:binance_futures:job-1:1000',
    capture_evidence_state: 'verified',
    termination_reason: partial
      ? 'caller_limit'
      : unknown
        ? 'short_page'
        : 'reported_population_reached',
    capture_config: { caller_page_cap: partial ? 1 : null, safety_page_cap: 5_000 },
    source_pages: [
      {
        raw_page: rawPage,
        source_row_count: 1,
        request_sha256: 'b'.repeat(64),
        http_status: 200,
        pagination_position: { kind: 'page_index', request_page_index: 1 },
        source_reports: reports,
      },
    ],
    parse_pages: [rawPage],
    parser_transformation: { kind: 'identity_projection', source_page_ordinals: [1] },
    accepted_population: 1,
    rejected_row_count: 0,
  }
}

function builtManifest(kind: 'complete' | 'partial' | 'unknown') {
  return buildLeaderboardAcquisitionManifest(manifestInput(kind))
}

function builtManifestV3(
  kind: 'complete' | 'partial' | 'unknown',
  acquisitionAttempt: {
    binding_contract: typeof LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT
    attempt_id: string
    attempt_seq: number
  } = {
    binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
    attempt_id: attemptId,
    attempt_seq: 41,
  }
) {
  return buildLeaderboardAcquisitionManifestV3({
    ...manifestInput(kind),
    acquisition_attempt: acquisitionAttempt,
  })
}

function builtManifestV4(
  acquisitionAttempt: BuildLeaderboardAcquisitionManifestV4Input['acquisition_attempt'] = {
    binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
    attempt_id: attemptId,
    attempt_seq: 41,
  }
) {
  const sourcePages: BuildLeaderboardAcquisitionManifestV4Input['source_pages'] = [
    {
      raw_page: {
        pageIndex: 1,
        payload: { data: [{ id: 'grid-1' }], total: 1 },
        url: 'https://example.test/leaderboard?partition=grid&page=1',
        fetchedAt: '2026-07-22T03:00:01.000Z',
      },
      source_row_count: 1,
      request_sha256: 'b'.repeat(64),
      http_status: 200,
      pagination_position: {
        kind: 'partitioned_page_index',
        partition_ordinal: 1,
        partition_id: 'futures_grid',
        request_page_index: 1,
      },
      source_reports: sourceReports(1, null, 20),
    },
    {
      raw_page: {
        pageIndex: 2,
        payload: { data: [{ id: 'martingale-1' }], total: 1 },
        url: 'https://example.test/leaderboard?partition=martingale&page=1',
        fetchedAt: '2026-07-22T03:00:02.000Z',
      },
      source_row_count: 1,
      request_sha256: 'c'.repeat(64),
      http_status: 200,
      pagination_position: {
        kind: 'partitioned_page_index',
        partition_ordinal: 2,
        partition_id: 'futures_martingale',
        request_page_index: 1,
      },
      source_reports: sourceReports(1, null, 20),
    },
  ]
  const parserTransformation: BuildLeaderboardAcquisitionManifestV4Input['parser_transformation'] =
    {
      kind: 'partitioned_numeric_projection',
      source_page_ordinals: [1, 2],
      algorithm_contract: LEADERBOARD_PARTITIONED_NUMERIC_PARSER_PAGE_CONTRACT,
      page_bindings: [
        {
          source_page_ordinal: 1,
          partition_ordinal: 1,
          partition_id: 'futures_grid',
          request_page_index: 1,
          request_page_size: 20,
        },
        {
          source_page_ordinal: 2,
          partition_ordinal: 2,
          partition_id: 'futures_martingale',
          request_page_index: 1,
          request_page_size: 20,
        },
      ],
    }

  return buildLeaderboardAcquisitionManifestV4({
    source: {
      id: 13,
      slug: 'bitget_bots_futures',
      adapter_slug: 'bitget_bots',
      configured_page_size: 20,
      configured_pagination_kind: 'numeric',
      configured_partition_ids: ['futures_grid', 'futures_martingale'],
    },
    surface: 'tier_a_leaderboard',
    timeframe: 30,
    started_at: startedAt,
    completed_at: completedAt,
    runner_git_sha: 'a'.repeat(40),
    observation_cycle_id: 'tier-a:bitget_bots_futures:job-1:1000',
    capture_evidence_state: 'verified',
    termination_reason: 'reported_population_reached',
    capture_config: { caller_page_cap: null, safety_page_cap: 10_000 },
    source_pages: sourcePages,
    parse_pages: sourcePages.map((page, index) =>
      projectPartitionedNumericParserPage(page.raw_page, parserTransformation.page_bindings[index]!)
    ),
    parser_transformation: parserTransformation,
    accepted_population: 2,
    rejected_row_count: 0,
    acquisition_attempt: acquisitionAttempt,
    pagination_topology: {
      kind: 'partitioned_numeric',
      aggregation_contract: LEADERBOARD_PARTITIONED_NUMERIC_AGGREGATION_CONTRACT,
      rank_scope: 'partition_local_concatenated_for_storage',
      partitions: [
        {
          partition_id: 'futures_grid',
          source_page_ordinals: [1],
          parser_page_ordinals: [1],
          termination_reason: 'reported_population_reached',
          capture_config: { caller_page_cap: null, safety_page_cap: 5_000 },
        },
        {
          partition_id: 'futures_martingale',
          source_page_ordinals: [2],
          parser_page_ordinals: [2],
          termination_reason: 'reported_population_reached',
          capture_config: { caller_page_cap: null, safety_page_cap: 5_000 },
        },
      ],
    },
  })
}

function v4Attempt(
  overrides: Partial<LeaderboardAcquisitionAttempt> = {}
): LeaderboardAcquisitionAttempt {
  return attempt({
    sourceId: 13,
    sourceSlug: 'bitget_bots_futures',
    adapterSlug: 'bitget_bots',
    observationCycleId: 'tier-a:bitget_bots_futures:job-1:1000',
    captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
    ...overrides,
  })
}

describe('leaderboard acquisition attempt client', () => {
  beforeEach(() => jest.clearAllMocks())

  it('enables @3 only from one exact database capability registration', async () => {
    const client = enqueueQuery({
      rows: [
        {
          capture_contract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
          adapter_slug: 'binance',
          attempt_binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
          requires_runner_git_sha: true,
        },
      ],
    })

    await expect(
      hasRegisteredAttemptBoundLeaderboardAcquisitionContract({
        sourceId: 1,
        adapterSlug: 'binance',
      })
    ).resolves.toBe(true)

    const [sql, params] = client.query.mock.calls[0]
    expect(String(sql)).toContain('FROM arena.leaderboard_capture_contracts')
    expect(String(sql)).toContain('source_id = $1::smallint')
    expect(params).toEqual([1, ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT])
  })

  it('retains the existing attempt-bound contract as the v3 compatibility alias', () => {
    expect(ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT).toBe(
      ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V3_CONTRACT
    )
  })

  it('returns only the exact requested v4 capability registration', async () => {
    const client = enqueueQuery({
      rows: [
        {
          capture_contract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
          adapter_slug: 'bitget_bots',
          attempt_binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
          requires_runner_git_sha: true,
        },
      ],
    })

    await expect(
      findRegisteredAttemptBoundLeaderboardAcquisitionContract({
        sourceId: 13,
        adapterSlug: 'bitget_bots',
        captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
      })
    ).resolves.toBe(ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT)

    expect(client.query.mock.calls[0][1]).toEqual([
      13,
      ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
    ])
  })

  it('returns null instead of substituting another attempt-bound contract', async () => {
    enqueueQuery({ rows: [] })

    await expect(
      findRegisteredAttemptBoundLeaderboardAcquisitionContract({
        sourceId: 13,
        adapterSlug: 'bitget_bots',
        captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
      })
    ).resolves.toBeNull()
  })

  it('rejects registry rows for a different attempt-bound contract', async () => {
    enqueueQuery({
      rows: [
        {
          capture_contract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V3_CONTRACT,
          adapter_slug: 'bitget_bots',
          attempt_binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
          requires_runner_git_sha: true,
        },
      ],
    })

    await expect(
      findRegisteredAttemptBoundLeaderboardAcquisitionContract({
        sourceId: 13,
        adapterSlug: 'bitget_bots',
        captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
      })
    ).rejects.toThrow(/inconsistent/)
  })

  it('rejects an unsupported exact contract before capability registry I/O', async () => {
    await expect(
      findRegisteredAttemptBoundLeaderboardAcquisitionContract({
        sourceId: 13,
        adapterSlug: 'bitget_bots',
        captureContract: 'arena.ingest.leaderboard-acquisition-manifest@5',
      } as Parameters<typeof findRegisteredAttemptBoundLeaderboardAcquisitionContract>[0])
    ).rejects.toThrow(/capture contract is invalid/)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('keeps an unregistered source off the @3 path', async () => {
    enqueueQuery({ rows: [] })

    await expect(
      hasRegisteredAttemptBoundLeaderboardAcquisitionContract({
        sourceId: 2,
        adapterSlug: 'binance',
      })
    ).resolves.toBe(false)
  })

  it.each([
    [
      'adapter drift',
      [
        {
          capture_contract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
          adapter_slug: 'other',
          attempt_binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
          requires_runner_git_sha: true,
        },
      ],
      /inconsistent/,
    ],
    [
      'binding drift',
      [
        {
          capture_contract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
          adapter_slug: 'binance',
          attempt_binding_contract: 'foreign-binding',
          requires_runner_git_sha: true,
        },
      ],
      /inconsistent/,
    ],
    [
      'runner provenance disabled',
      [
        {
          capture_contract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
          adapter_slug: 'binance',
          attempt_binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
          requires_runner_git_sha: false,
        },
      ],
      /inconsistent/,
    ],
    [
      'duplicate registrations',
      [
        {
          capture_contract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
          adapter_slug: 'binance',
          attempt_binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
          requires_runner_git_sha: true,
        },
        {
          capture_contract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
          adapter_slug: 'binance',
          attempt_binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
          requires_runner_git_sha: true,
        },
      ],
      /ambiguous/,
    ],
  ])('rejects %s in the @3 capability registry', async (_label, rows, error) => {
    enqueueQuery({ rows })
    await expect(
      hasRegisteredAttemptBoundLeaderboardAcquisitionContract({
        sourceId: 1,
        adapterSlug: 'binance',
      })
    ).rejects.toThrow(error as RegExp)
  })

  it.each([
    ['zero source', { sourceId: 0, adapterSlug: 'binance' }],
    ['oversized source', { sourceId: 32_768, adapterSlug: 'binance' }],
    ['padded adapter', { sourceId: 1, adapterSlug: ' binance ' }],
  ])('rejects %s before capability registry I/O', async (_label, input) => {
    await expect(hasRegisteredAttemptBoundLeaderboardAcquisitionContract(input)).rejects.toThrow(
      /leaderboard acquisition/
    )
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('starts with named, explicitly cast arguments and preserves the DB millisecond clock', async () => {
    const client = enqueueQuery({ rows: [attemptRow()] })

    await expect(startLeaderboardAcquisitionAttempt(startInput())).resolves.toEqual(attempt())

    expect(mockConnect).toHaveBeenCalledTimes(1)
    expect(client.release).toHaveBeenCalledWith()
    const [sql, params] = client.query.mock.calls[0]
    expect(String(sql)).toContain('p_attempt_id => $1::uuid')
    expect(String(sql)).toContain('p_worker_region => $9::text')
    expect(Object.isFrozen(params)).toBe(true)
    expect(params).toEqual([
      attemptId,
      1,
      30,
      'tier-a:binance_futures:job-1:1000',
      'job-1',
      2,
      VERIFIED_LEADERBOARD_ACQUISITION_CONTRACT,
      'a'.repeat(40),
      'vps_sg',
    ])
  })

  it('starts a claimed attempt once on the caller-owned transaction', async () => {
    const query = jest.fn(async () => ({
      rows: [
        attemptRow({
          execution_claim_id: executionClaimId,
          execution_generation_seq: '7',
        }),
      ],
    }))
    const transaction = { query } as unknown as IngestQueryExecutor

    await expect(
      startLeaderboardAcquisitionAttemptInTransaction(transaction, executionBinding(), startInput())
    ).resolves.toEqual(claimedAttempt())

    expect(query).toHaveBeenCalledTimes(1)
    expect(mockConnect).not.toHaveBeenCalled()
    const [sql, params] = query.mock.calls[0]
    expect(String(sql)).toContain('p_execution_claim_id => $10::uuid')
    expect(String(sql)).toContain('p_execution_generation_seq => $11::bigint')
    expect(Object.isFrozen(params)).toBe(true)
    expect(params).toEqual([
      attemptId,
      1,
      30,
      'tier-a:binance_futures:job-1:1000',
      'job-1',
      2,
      VERIFIED_LEADERBOARD_ACQUISITION_CONTRACT,
      'a'.repeat(40),
      'vps_sg',
      executionClaimId,
      7,
    ])
  })

  it('never reconnects or replays a failed claimed start query', async () => {
    const failure = Object.assign(new Error('connection outcome unknown'), { code: '08006' })
    const query = jest.fn(async () => Promise.reject(failure))
    const transaction = { query } as unknown as IngestQueryExecutor

    await expect(
      startLeaderboardAcquisitionAttemptInTransaction(transaction, executionBinding(), startInput())
    ).rejects.toBe(failure)

    expect(query).toHaveBeenCalledTimes(1)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('rejects a claimed start binding conflict and invalid source before fallback I/O', async () => {
    const query = jest.fn(async () => ({
      rows: [
        attemptRow({
          execution_claim_id: '00000000-0000-4000-8000-000000000098',
          execution_generation_seq: '7',
        }),
      ],
    }))
    const transaction = { query } as unknown as IngestQueryExecutor

    await expect(
      startLeaderboardAcquisitionAttemptInTransaction(transaction, executionBinding(), startInput())
    ).rejects.toThrow('conflicting execution')
    await expect(
      startLeaderboardAcquisitionAttemptInTransaction(
        transaction,
        executionBinding({ sourceId: 2 }),
        startInput()
      )
    ).rejects.toThrow('execution source is invalid')

    expect(query).toHaveBeenCalledTimes(1)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('starts an attempt-bound v3 acquisition without weakening the v2 contract', async () => {
    enqueueQuery({
      rows: [attemptRow({ capture_contract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT })],
    })

    await expect(
      startLeaderboardAcquisitionAttempt({
        ...startInput(),
        captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
      })
    ).resolves.toEqual(attempt({ captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT }))
  })

  it('starts an exact attempt-bound v4 acquisition', async () => {
    enqueueQuery({
      rows: [attemptRow({ capture_contract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT })],
    })

    await expect(
      startLeaderboardAcquisitionAttempt({
        ...startInput(),
        captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
      })
    ).resolves.toEqual(
      attempt({ captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT })
    )
  })

  it.each([
    ['non-canonical UUID', { attemptId: 'ABCDEFAB-0000-4000-8000-000000000001' }],
    ['invalid timeframe', { timeframe: 14 }],
    ['unsafe queue attempt', { queueAttempt: Number.MAX_SAFE_INTEGER + 1 }],
    ['padded cycle', { observationCycleId: ' cycle ' }],
    ['zero runner SHA', { runnerGitSha: '0'.repeat(40) }],
    ['missing verified runner SHA', { runnerGitSha: null }],
    [
      'missing attempt-bound runner SHA',
      {
        captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
        runnerGitSha: null,
      },
    ],
    ['invalid worker region', { workerRegion: 'bad region' }],
  ])('rejects %s before database I/O', async (_label, override) => {
    await expect(
      startLeaderboardAcquisitionAttempt({
        ...startInput(),
        ...(override as Partial<StartLeaderboardAcquisitionAttemptInput>),
      })
    ).rejects.toThrow(/leaderboard acquisition/)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it.each([[0], [2]])('rejects a %i-row begin response', async (rowCount) => {
    enqueueQuery({ rows: Array.from({ length: rowCount }, () => attemptRow()) })
    await expect(startLeaderboardAcquisitionAttempt(startInput())).rejects.toThrow(
      `returned ${rowCount} rows instead of one`
    )
  })

  it.each([
    ['identity drift', { queue_attempt: 3 }, /conflicting identity/],
    ['unsafe sequence', { attempt_seq: '9007199254740992' }, /attempt sequence is invalid/],
    [
      'sub-millisecond start',
      { recorded_started_at_is_millisecond: false },
      /sub-millisecond start/,
    ],
  ])('rejects %s in a begin response', async (_label, override, error) => {
    enqueueQuery({ rows: [attemptRow(override as Record<string, unknown>)] })
    await expect(startLeaderboardAcquisitionAttempt(startInput())).rejects.toThrow(error as RegExp)
  })

  it('replays an uncertain begin on a fresh client with identical frozen arguments', async () => {
    const uncertain = Object.assign(new Error('connection terminated unexpectedly'), {
      code: '08006',
    })
    const first = enqueueQuery(uncertain)
    const second = enqueueQuery({ rows: [attemptRow()] })

    await expect(startLeaderboardAcquisitionAttempt(startInput())).resolves.toEqual({
      ...attempt(),
      replayed: true,
    })

    expect(mockConnect).toHaveBeenCalledTimes(2)
    expect(first.release).toHaveBeenCalledWith(true)
    expect(second.release).toHaveBeenCalledWith()
    expect(first.query.mock.calls[0][0]).toBe(second.query.mock.calls[0][0])
    expect(first.query.mock.calls[0][1]).toBe(second.query.mock.calls[0][1])
  })

  it('does not replay a deterministic database rejection', async () => {
    const rejection = Object.assign(new Error('source is not active'), { code: '22023' })
    const client = enqueueQuery(rejection)

    await expect(startLeaderboardAcquisitionAttempt(startInput())).rejects.toBe(rejection)
    expect(mockConnect).toHaveBeenCalledTimes(1)
    expect(client.release).toHaveBeenCalledWith(false)
  })

  it('retains both causes when exact replay is still unresolved', async () => {
    const firstCause = Object.assign(new Error('query read timeout'), { code: 'ETIMEDOUT' })
    const secondCause = Object.assign(new Error('deadlock after uncertain first result'), {
      code: '40P01',
    })
    enqueueQuery(firstCause)
    enqueueQuery(secondCause)

    let thrown: unknown
    try {
      await startLeaderboardAcquisitionAttempt(startInput())
    } catch (cause) {
      thrown = cause
    }
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([firstCause, secondCause])
  })

  it.each([
    ['complete', 'complete', 'verified', null],
    ['partial', 'partial', 'partial', 'pagination_partial'],
    ['unknown', 'unknown', 'unknown', 'population_unknown'],
  ] as const)(
    'projects one frozen %s manifest outcome without a second derivation path',
    (kind, terminalState, populationState, reasonCode) => {
      const projection = projectLeaderboardManifestOutcome(attempt(), builtManifest(kind))
      expect(Object.isFrozen(projection)).toBe(true)
      expect(Object.isFrozen(projection.binding)).toBe(true)
      expect(projection).toMatchObject({
        terminalState,
        populationState,
        reasonCode,
        binding: {
          attemptId,
          attemptSeq: 41,
          captureStartedAt: startedAt,
          captureCompletedAt: completedAt,
        },
      })
    }
  )

  it('rejects a canonical manifest whose DB start belongs to another attempt', () => {
    const built = builtManifest('complete')
    expect(() =>
      projectLeaderboardManifestOutcome(
        attempt({ recordedStartedAt: '2026-07-22T03:00:00.124Z' }),
        built
      )
    ).toThrow('does not bind the durable attempt')
  })

  it('projects a frozen v3 outcome only when the canonical body binds the exact attempt', () => {
    const boundAttempt = attempt({
      captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
    })
    const projection = projectLeaderboardManifestV3Outcome(
      boundAttempt,
      builtManifestV3('complete')
    )

    expect(Object.isFrozen(projection)).toBe(true)
    expect(Object.isFrozen(projection.binding)).toBe(true)
    expect(projection).toMatchObject({
      terminalState: 'complete',
      populationState: 'verified',
      reasonCode: null,
      binding: {
        bindingContract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
        attemptId,
        attemptSeq: 41,
        captureStartedAt: startedAt,
        captureCompletedAt: completedAt,
        runnerGitSha: 'a'.repeat(40),
      },
    })
  })

  it('projects a frozen v4 outcome only when the canonical body binds the exact attempt', () => {
    const projection = projectLeaderboardManifestV4Outcome(v4Attempt(), builtManifestV4())

    expect(Object.isFrozen(projection)).toBe(true)
    expect(Object.isFrozen(projection.binding)).toBe(true)
    expect(projection).toMatchObject({
      terminalState: 'complete',
      populationState: 'verified',
      observedPopulation: 2,
      acceptedPopulation: 2,
      reasonCode: null,
      binding: {
        bindingContract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
        attemptId,
        attemptSeq: 41,
        captureStartedAt: startedAt,
        captureCompletedAt: completedAt,
        runnerGitSha: 'a'.repeat(40),
      },
    })
  })

  it('rejects v4 evidence bound to a foreign durable attempt identity', () => {
    expect(() =>
      projectLeaderboardManifestV4Outcome(
        v4Attempt(),
        builtManifestV4({
          binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
          attempt_id: '00000000-0000-4000-8000-000000000002',
          attempt_seq: 41,
        })
      )
    ).toThrow('does not bind the durable attempt identity')
  })

  it.each([
    [
      'attempt id',
      {
        binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
        attempt_id: '00000000-0000-4000-8000-000000000002',
        attempt_seq: 41,
      },
    ],
    [
      'attempt sequence',
      {
        binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
        attempt_id: attemptId,
        attempt_seq: 42,
      },
    ],
  ] as const)('rejects v3 evidence bound to a foreign %s', (_label, binding) => {
    expect(() =>
      projectLeaderboardManifestV3Outcome(
        attempt({ captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT }),
        builtManifestV3('complete', binding)
      )
    ).toThrow('does not bind the durable attempt identity')
  })

  it('keeps v2, v3, and v4 projection contracts isolated', () => {
    expect(() =>
      projectLeaderboardManifestV3Outcome(attempt(), builtManifestV3('complete'))
    ).toThrow('only an attempt-bound v3 attempt')
    expect(() =>
      projectLeaderboardManifestOutcome(
        attempt({ captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT }),
        builtManifest('complete')
      )
    ).toThrow('only a v2 attempt')
    expect(() =>
      projectLeaderboardManifestV4Outcome(
        v4Attempt({ captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V3_CONTRACT }),
        builtManifestV4()
      )
    ).toThrow('only an attempt-bound v4 attempt')
    expect(() =>
      projectLeaderboardManifestV3Outcome(v4Attempt(), builtManifestV3('complete'))
    ).toThrow('only an attempt-bound v3 attempt')
  })

  it('rejects v3 evidence whose DB start belongs to another attempt', () => {
    expect(() =>
      projectLeaderboardManifestV3Outcome(
        attempt({
          captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
          recordedStartedAt: '2026-07-22T03:00:00.124Z',
        }),
        builtManifestV3('complete')
      )
    ).toThrow('does not bind the durable attempt')
  })

  it.each([
    ['source slug', { sourceSlug: 'binance_spot' }],
    ['adapter slug', { adapterSlug: 'other_adapter' }],
    ['timeframe', { timeframe: 7 }],
    ['observation cycle', { observationCycleId: 'tier-a:binance_futures:job-2:1000' }],
    ['runner SHA', { runnerGitSha: 'b'.repeat(40) }],
  ] as const)('rejects v3 evidence with durable %s drift', (_label, override) => {
    expect(() =>
      projectLeaderboardManifestV3Outcome(
        attempt({
          captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
          ...(override as Partial<LeaderboardAcquisitionAttempt>),
        }),
        builtManifestV3('complete')
      )
    ).toThrow('does not bind the durable attempt')
  })

  it.each([
    ['canonical JSON', { canonicalJson: 'forged' }],
    ['source run id', { sourceRunId: 'd'.repeat(64) }],
  ])('rejects v3 evidence with a forged %s', (_label, override) => {
    expect(() =>
      projectLeaderboardManifestV3Outcome(
        attempt({ captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT }),
        { ...builtManifestV3('complete'), ...override }
      )
    ).toThrow('digest does not match its canonical body')
  })

  it('finishes an attempt-bound v3 projection through the same exact terminal contract', async () => {
    const boundAttempt = attempt({
      captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
    })
    const projection = projectLeaderboardManifestV3Outcome(
      boundAttempt,
      builtManifestV3('complete')
    )
    const client = enqueueQuery({
      rows: [
        {
          attempt_seq: '41',
          terminal_state: 'complete',
          recorded_completed_at: '2026-07-22 03:00:03.789+00',
        },
      ],
    })

    await expect(
      finishLeaderboardAcquisitionAttempt({
        kind: 'manifest',
        attempt: boundAttempt,
        projection,
        sourcePayloadRawObjectId: 301,
        manifestRawObjectId: 302,
      })
    ).resolves.toMatchObject({ attemptSeq: 41, terminalState: 'complete' })
    expect(client.query.mock.calls[0][1]).toHaveLength(25)
    expect(client.query.mock.calls[0][1].slice(8, 12)).toEqual([
      projection.sourceRunId,
      301,
      302,
      null,
    ])
  })

  it('finishes a manifest through the exact named 25-argument projection', async () => {
    const projection = projectLeaderboardManifestOutcome(attempt(), builtManifest('complete'))
    const client = enqueueQuery({
      rows: [
        {
          attempt_seq: '41',
          terminal_state: 'complete',
          recorded_completed_at: '2026-07-22 03:00:03.789123+00',
        },
      ],
    })

    await expect(
      finishLeaderboardAcquisitionAttempt({
        kind: 'manifest',
        attempt: attempt(),
        projection,
        sourcePayloadRawObjectId: 101,
        manifestRawObjectId: 102,
      })
    ).resolves.toEqual({
      attemptSeq: 41,
      terminalState: 'complete',
      recordedCompletedAt: '2026-07-22T03:00:03.789Z',
      replayed: false,
    })

    const [sql, params] = client.query.mock.calls[0]
    expect(String(sql)).toContain('p_attempt_id => $1::uuid')
    expect(String(sql)).toContain('p_reason_code => $25::text')
    expect(params).toHaveLength(25)
    expect(params).toEqual([
      attemptId,
      'complete',
      'complete',
      'verified',
      'verified',
      'reported_population_reached',
      startedAt,
      completedAt,
      projection.sourceRunId,
      101,
      102,
      null,
      1,
      'consistent',
      1,
      null,
      'unknown',
      1,
      1,
      0,
      0,
      false,
      false,
      null,
      null,
    ])
  })

  it('finishes a claimed attempt once on the caller-owned transaction', async () => {
    const boundAttempt = claimedAttempt()
    const projection = projectLeaderboardManifestOutcome(boundAttempt, builtManifest('complete'))
    const query = jest.fn(async () => ({
      rows: [
        {
          attempt_seq: '41',
          terminal_state: 'complete',
          recorded_completed_at: '2026-07-22 03:00:03.789+00',
        },
      ],
    }))
    const transaction = { query } as unknown as IngestQueryExecutor

    await expect(
      finishLeaderboardAcquisitionAttemptInTransaction(transaction, executionBinding(), {
        kind: 'manifest',
        attempt: boundAttempt,
        projection,
        sourcePayloadRawObjectId: 101,
        manifestRawObjectId: 102,
      })
    ).resolves.toEqual({
      attemptSeq: 41,
      terminalState: 'complete',
      recordedCompletedAt: '2026-07-22T03:00:03.789Z',
      replayed: false,
    })

    expect(query).toHaveBeenCalledTimes(1)
    expect(mockConnect).not.toHaveBeenCalled()
    const [sql, params] = query.mock.calls[0]
    expect(String(sql)).toContain('p_execution_claim_id => $26::uuid')
    expect(String(sql)).toContain('p_execution_generation_seq => $27::bigint')
    expect(Object.isFrozen(params)).toBe(true)
    expect(params).toHaveLength(27)
    expect(params.slice(-2)).toEqual([executionClaimId, 7])
  })

  it('never reconnects or replays a failed claimed finish query', async () => {
    const failure = Object.assign(new Error('connection outcome unknown'), { code: '08006' })
    const query = jest.fn(async () => Promise.reject(failure))
    const transaction = { query } as unknown as IngestQueryExecutor
    const boundAttempt = claimedAttempt()

    await expect(
      finishLeaderboardAcquisitionAttemptInTransaction(transaction, executionBinding(), {
        kind: 'manifest',
        attempt: boundAttempt,
        projection: projectLeaderboardManifestOutcome(boundAttempt, builtManifest('complete')),
        sourcePayloadRawObjectId: 101,
        manifestRawObjectId: 102,
      })
    ).rejects.toBe(failure)

    expect(query).toHaveBeenCalledTimes(1)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('rejects a claimed finish whose attempt belongs to another execution', async () => {
    const query = jest.fn()
    const transaction = { query } as unknown as IngestQueryExecutor
    const foreignAttempt = claimedAttempt({
      executionClaimId: '00000000-0000-4000-8000-000000000098',
    })

    await expect(
      finishLeaderboardAcquisitionAttemptInTransaction(transaction, executionBinding(), {
        kind: 'processing_failed',
        attempt: foreignAttempt,
        captureCompletedAt: null,
        failureStage: 'session_open',
        reasonCode: 'upstream_unavailable',
      })
    ).rejects.toThrow('execution binding conflicts')

    expect(query).not.toHaveBeenCalled()
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('replays an uncertain finish on a fresh client without recomputing arguments', async () => {
    const projection = projectLeaderboardManifestOutcome(attempt(), builtManifest('partial'))
    const uncertain = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    const first = enqueueQuery(uncertain)
    const second = enqueueQuery({
      rows: [
        {
          attempt_seq: '41',
          terminal_state: 'partial',
          recorded_completed_at: '2026-07-22 03:00:03.000+00',
        },
      ],
    })

    await expect(
      finishLeaderboardAcquisitionAttempt({
        kind: 'manifest',
        attempt: attempt(),
        projection,
        sourcePayloadRawObjectId: 101,
        manifestRawObjectId: 102,
      })
    ).resolves.toMatchObject({ terminalState: 'partial', replayed: true })

    expect(first.release).toHaveBeenCalledWith(true)
    expect(first.query.mock.calls[0][1]).toBe(second.query.mock.calls[0][1])
  })

  it('projects legacy and processing failures into closed terminal shapes', async () => {
    const legacyAttempt = attempt({
      captureContract: LEGACY_LEADERBOARD_ACQUISITION_CONTRACT,
      runnerGitSha: null,
    })
    const legacyClient = enqueueQuery({
      rows: [
        {
          attempt_seq: '41',
          terminal_state: 'unknown',
          recorded_completed_at: '2026-07-22 03:00:03+00',
        },
      ],
    })
    await finishLeaderboardAcquisitionAttempt({
      kind: 'legacy_unknown',
      attempt: legacyAttempt,
      captureCompletedAt: completedAt,
      diagnosticRawObjectId: 201,
      acceptedPopulation: 7,
      rejectedRowCount: 2,
    })
    expect(legacyClient.query.mock.calls[0][1]).toEqual([
      attemptId,
      'unknown',
      'unknown',
      'unknown',
      'legacy_unverified',
      null,
      startedAt,
      completedAt,
      null,
      null,
      null,
      201,
      null,
      null,
      null,
      null,
      null,
      null,
      7,
      2,
      null,
      false,
      false,
      null,
      'legacy_unverified',
    ])

    const failedClient = enqueueQuery({
      rows: [
        {
          attempt_seq: '41',
          terminal_state: 'processing_failed',
          recorded_completed_at: '2026-07-22 03:00:04+00',
        },
      ],
    })
    await finishLeaderboardAcquisitionAttempt({
      kind: 'processing_failed',
      attempt: attempt(),
      captureCompletedAt: null,
      failureStage: 'session_open',
      reasonCode: 'upstream_unavailable',
    })
    expect(failedClient.query.mock.calls[0][1]).toEqual([
      attemptId,
      'processing_failed',
      'unknown',
      'unknown',
      'unassessed',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      false,
      false,
      'session_open',
      'upstream_unavailable',
    ])
  })

  it('rejects a conflicting finish response', async () => {
    const projection = projectLeaderboardManifestOutcome(attempt(), builtManifest('complete'))
    enqueueQuery({
      rows: [
        {
          attempt_seq: '42',
          terminal_state: 'complete',
          recorded_completed_at: '2026-07-22 03:00:03+00',
        },
      ],
    })
    await expect(
      finishLeaderboardAcquisitionAttempt({
        kind: 'manifest',
        attempt: attempt(),
        projection,
        sourcePayloadRawObjectId: 101,
        manifestRawObjectId: 102,
      })
    ).rejects.toThrow('conflicting outcome')
  })
})
