import type { IngestQueryExecutor } from '@/lib/ingest/db'
import {
  validateWorkerDbFencedWriteStatement,
  WorkerDbFenceError,
  type WorkerDbFenceErrorCode,
} from '@/lib/ingest/db-fenced-write-contract'
import {
  ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
  ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
  LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
} from '@/lib/ingest/acquisition-attempts'

import {
  classifyRepublishPublicationError,
  classifyTierAWindowRepublishCandidate,
  findLatestTierAWindowAttempt,
  isTransientRepublishPublicationError,
  TIER_A_WINDOW_REPUBLISH_FRESHNESS_MARGIN_MS,
  LATEST_TIER_A_WINDOW_ATTEMPT_SQL,
  TIER_A_WINDOW_REPUBLISH_MAX_AGE_MS,
  type TierAWindowRepublishCurrentExecution,
} from '../tier-a-window-republish'

const CYCLE = 'tier-a:bybit_mt5:repeat:tiera:bybit_mt5:1:1'
const JOB = 'repeat:tiera:bybit_mt5:1'
const GIT_SHA = 'c'.repeat(40)
const STARTED = '2026-11-27T10:00:00.000Z'

function row(overrides: Record<string, unknown> = {}) {
  return {
    attempt_seq: '901',
    attempt_id: '00000000-0000-4000-8000-000000000901',
    source_id: 44,
    source_slug: 'bybit_mt5',
    adapter_slug: 'bybit_mt5',
    timeframe: 7,
    observation_cycle_id: CYCLE,
    queue_job_id: JOB,
    queue_attempt: 1,
    capture_contract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
    attempt_binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
    runner_git_sha: GIT_SHA,
    worker_region: 'vps_sg',
    source_status: 'active',
    source_serving_mode: 'serving',
    source_currency: 'USDx',
    source_fetch_region: 'vps_sg',
    recorded_started_at: '2026-11-27 10:00:00+00',
    execution_claim_id: '10000000-0000-4000-8000-000000000001',
    execution_generation_seq: '16',
    has_outcome: true,
    terminal_state: 'unknown',
    acquisition_state: 'complete',
    population_state: 'unknown',
    reason_code: 'population_unknown',
    capture_evidence_state: 'verified',
    termination_reason: 'empty_page',
    capture_started_at: '2026-11-27 10:00:00+00',
    capture_completed_at: '2026-11-27 11:47:00+00',
    source_run_id: 'e'.repeat(64),
    source_payload_raw_object_id: '7001',
    source_payload_content_hash: 'd'.repeat(64),
    source_payload_storage_path: 'bybit_mt5/tier_a_trust/x/source_payload.json.gz',
    manifest_raw_object_id: '7002',
    manifest_content_hash: 'e'.repeat(64),
    manifest_storage_path: 'bybit_mt5/tier_a_trust/x/population_manifest.json.gz',
    diagnostic_raw_object_id: null,
    failure_stage: null,
    reported_population: null,
    population_report_state: 'unknown',
    source_page_count: 2048,
    reported_page_count: null,
    page_count_report_state: 'unknown',
    observed_population: 40_940,
    accepted_population: 40_900,
    rejected_row_count: 40,
    deduplicated_row_count: 0,
    caller_limited: false,
    safety_limited: false,
    exhaustion_evidence_present: true,
    gated_snapshot_present: false,
    database_now: '2026-11-27 12:30:00+00',
    ...overrides,
  }
}

function executor(rows: unknown[]) {
  const query = jest.fn(async () => ({ rows }))
  return { executor: { query } as unknown as IngestQueryExecutor, query }
}

const current: TierAWindowRepublishCurrentExecution = {
  sourceId: 44,
  timeframe: 7,
  observationCycleId: CYCLE,
  queueJobId: JOB,
  queueAttempt: 2,
  claimId: '10000000-0000-4000-8000-000000000002',
  generationSeq: 17,
  gitSha: GIT_SHA,
  maxFreshnessMs: TIER_A_WINDOW_REPUBLISH_MAX_AGE_MS,
}

async function classify(
  overrides: Record<string, unknown> = {},
  currentOverrides: Partial<TierAWindowRepublishCurrentExecution> = {}
) {
  const { executor: database } = executor([row(overrides)])
  const latest = await findLatestTierAWindowAttempt(database, { sourceId: 44, timeframe: 7 })
  return classifyTierAWindowRepublishCandidate(latest, { ...current, ...currentOverrides })
}

describe('findLatestTierAWindowAttempt', () => {
  it('reads only the newest attempt of the window by attempt_seq without writing', async () => {
    const { executor: database, query } = executor([row()])

    const latest = await findLatestTierAWindowAttempt(database, { sourceId: 44, timeframe: 7 })

    expect(query).toHaveBeenCalledWith(LATEST_TIER_A_WINDOW_ATTEMPT_SQL, [44, 7])
    expect(LATEST_TIER_A_WINDOW_ATTEMPT_SQL).toContain('ORDER BY attempt.attempt_seq DESC')
    expect(LATEST_TIER_A_WINDOW_ATTEMPT_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|FOR UPDATE)\b/)
    // It runs on the claimed executor, which only accepts fenced statements.
    expect(validateWorkerDbFencedWriteStatement(LATEST_TIER_A_WINDOW_ATTEMPT_SQL)).toBe(
      LATEST_TIER_A_WINDOW_ATTEMPT_SQL.trim()
    )
    expect(latest?.attempt).toEqual(
      expect.objectContaining({
        attemptSeq: 901,
        recordedStartedAt: STARTED,
        executionGenerationSeq: 16,
        queueAttempt: 1,
      })
    )
    expect(latest?.outcome).toEqual(
      expect.objectContaining({
        sourcePayload: {
          id: 7001,
          storagePath: 'bybit_mt5/tier_a_trust/x/source_payload.json.gz',
          contentHash: 'd'.repeat(64),
        },
        captureCompletedAt: '2026-11-27T11:47:00.000Z',
      })
    )
  })

  it('returns null without an attempt or for an unclaimed attempt', async () => {
    await expect(
      findLatestTierAWindowAttempt(executor([]).executor, { sourceId: 44, timeframe: 7 })
    ).resolves.toBeNull()
    await expect(
      findLatestTierAWindowAttempt(executor([row({ execution_claim_id: null })]).executor, {
        sourceId: 44,
        timeframe: 7,
      })
    ).resolves.toBeNull()
  })

  it('rejects a row for a different window', async () => {
    await expect(
      findLatestTierAWindowAttempt(executor([row({ timeframe: 30 })]).executor, {
        sourceId: 44,
        timeframe: 7,
      })
    ).rejects.toThrow('a different source window')
  })
})

describe('classifyTierAWindowRepublishCandidate', () => {
  it('accepts an exhausted, proven, earlier-queue-attempt capture of the same job and cycle', async () => {
    await expect(classify()).resolves.toEqual(
      expect.objectContaining({ kind: 'candidate', attempt: expect.any(Object) })
    )
  })

  it('accepts a complete outcome', async () => {
    await expect(
      classify({
        terminal_state: 'complete',
        population_state: 'verified',
        population_report_state: 'consistent',
        reported_population: 40_940,
        reason_code: null,
        exhaustion_evidence_present: false,
      })
    ).resolves.toEqual(expect.objectContaining({ kind: 'candidate' }))
  })

  it.each([
    ['an in-progress attempt', { has_outcome: false }],
    ['a processing failure', { terminal_state: 'processing_failed', failure_stage: 'publish' }],
    ['a diagnostic outcome', { diagnostic_raw_object_id: '9' }],
    ['an exhausted outcome without proof', { exhaustion_evidence_present: false }],
    ['a partial outcome', { terminal_state: 'partial', reason_code: 'partial' }],
    ['another cycle', { observation_cycle_id: 'tier-a:other' }],
    ['another job', { queue_job_id: 'other-job' }],
    ['the same queue attempt', { queue_attempt: 2 }],
    ['a later generation', { execution_generation_seq: '17' }],
    ['the current claim', { execution_claim_id: '10000000-0000-4000-8000-000000000002' }],
  ])('treats %s as no candidate', async (_label, overrides) => {
    await expect(classify(overrides)).resolves.toEqual({ kind: 'none' })
  })

  it('skips v4 captures as contract_unsupported', async () => {
    await expect(
      classify({ capture_contract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT })
    ).resolves.toEqual({ kind: 'skip', reason: 'contract_unsupported', attemptSeq: 901 })
  })

  it('skips a capture from another worker build as sha_mismatch', async () => {
    await expect(classify({ runner_git_sha: 'a'.repeat(40) })).resolves.toEqual({
      kind: 'skip',
      reason: 'sha_mismatch',
      attemptSeq: 901,
    })
  })

  it('skips a capture older than the tighter of the contract bound and six hours', async () => {
    await expect(classify({ database_now: '2026-11-27 16:00:00+00' })).resolves.toEqual({
      kind: 'skip',
      reason: 'stale',
      attemptSeq: 901,
    })
    await expect(classify({}, { maxFreshnessMs: 2 * 60 * 60 * 1000 })).resolves.toEqual({
      kind: 'skip',
      reason: 'stale',
      attemptSeq: 901,
    })
    await expect(classify({}, { maxFreshnessMs: 24 * 60 * 60 * 1000 })).resolves.toEqual(
      expect.objectContaining({ kind: 'candidate' })
    )
  })

  it('skips a capture whose snapshot already failed its count check', async () => {
    await expect(classify({ gated_snapshot_present: true })).resolves.toEqual({
      kind: 'skip',
      reason: 'count_check_gated',
      attemptSeq: 901,
    })
  })

  it('keeps a fifteen-minute margin below the freshness bound', async () => {
    const bound = TIER_A_WINDOW_REPUBLISH_MAX_AGE_MS - TIER_A_WINDOW_REPUBLISH_FRESHNESS_MARGIN_MS
    const at = (ms: number) => new Date(Date.parse(STARTED) + ms).toISOString()
    await expect(classify({ database_now: at(bound - 1) })).resolves.toEqual(
      expect.objectContaining({ kind: 'candidate' })
    )
    await expect(classify({ database_now: at(bound) })).resolves.toEqual(
      expect.objectContaining({ kind: 'skip', reason: 'stale' })
    )
    // A capture inside the raw bound but within the margin is not replayed.
    await expect(
      classify({ database_now: at(TIER_A_WINDOW_REPUBLISH_MAX_AGE_MS - 60_000) })
    ).resolves.toEqual(expect.objectContaining({ kind: 'skip', reason: 'stale' }))
  })
})

describe('isTransientRepublishPublicationError', () => {
  const withCode = (code: string, message = 'db failure') =>
    Object.assign(new Error(message), { code })

  it.each([
    '57014',
    '08006',
    '40001',
    '40P01',
    '53300',
    '55P03',
    '25P03',
    '25P04',
    'ECONNRESET',
    'ETIMEDOUT',
  ])('treats %s as transient', (code) => {
    expect(isTransientRepublishPublicationError(withCode(code))).toBe(true)
  })

  it('finds a transient failure through causes and aggregate members', () => {
    const wrapped = new Error('[publish] failed', { cause: withCode('57014') })
    expect(isTransientRepublishPublicationError(wrapped)).toBe(true)
    expect(
      isTransientRepublishPublicationError(new AggregateError([new Error('x'), wrapped], 'agg'))
    ).toBe(true)
    expect(
      isTransientRepublishPublicationError(new Error('Connection terminated unexpectedly'))
    ).toBe(true)

    for (const message of [
      'terminating connection due to transaction timeout',
      'terminating connection due to administrator command',
    ]) {
      expect(isTransientRepublishPublicationError(new Error(message))).toBe(true)
    }
  })

  it.each([
    ['a unique violation', withCode('23505')],
    ['a prerequisite refusal', withCode('55000')],
    ['a privilege refusal', withCode('42501')],
    ['a missing metric contract', new Error('has no reviewed metric trust contract')],
    ['an unknown error', new Error('something else')],
    ['a non-error value', 'boom'],
  ])('treats %s as deterministic', (_label, error) => {
    expect(isTransientRepublishPublicationError(error)).toBe(false)
  })
})

describe('classifyRepublishPublicationError', () => {
  const fence = (code: WorkerDbFenceErrorCode) => new WorkerDbFenceError(code, 'write', 'never')
  const execution = (code: string) =>
    Object.assign(new Error(`[ingest-worker] Tier-A execution assert failed (${code})`), {
      name: 'SourceJobExecutionError',
      code,
    })

  it.each([
    'write_deadline_exceeded',
    'control_plane_unavailable',
    'lease_deadline_exceeded',
    'commit_aborted',
  ] as const)('treats the fence code %s as transient', (code) => {
    expect(classifyRepublishPublicationError(fence(code))).toBe('transient')
    expect(
      classifyRepublishPublicationError(new Error('[publish] failed', { cause: fence(code) }))
    ).toBe('transient')
  })

  it.each([
    'commit_outcome_unknown',
    'db_control_outcome_unknown',
    'fenced',
    'invalid_state',
  ] as const)('rethrows the fence code %s as an authority failure', (code) => {
    expect(classifyRepublishPublicationError(fence(code))).toBe('authority')
  })

  it.each(['invalid_input', 'rpc_contract_violation'] as const)(
    'treats the fence code %s as deterministic',
    (code) => {
      expect(classifyRepublishPublicationError(fence(code))).toBe('deterministic')
    }
  )

  it.each([
    'cancelled',
    'closed',
    'invalid_input',
    'ownership_lost',
    'region_lost',
    'rpc_contract_violation',
    'unavailable',
  ])('rethrows the execution code %s as an authority failure', (code) => {
    expect(classifyRepublishPublicationError(execution(code))).toBe('authority')
  })

  it('lets an authority member win over a transient one anywhere in the chain', () => {
    const chain = new AggregateError(
      [fence('write_deadline_exceeded'), new Error('x', { cause: execution('region_lost') })],
      'publication failed'
    )
    expect(classifyRepublishPublicationError(chain)).toBe('authority')
  })

  it('classifies an unknown error as deterministic', () => {
    expect(classifyRepublishPublicationError(new Error('unexpected'))).toBe('deterministic')
  })
})
