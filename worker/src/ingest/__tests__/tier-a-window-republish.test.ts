import type { IngestQueryExecutor } from '@/lib/ingest/db'
import {
  ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
  ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
  LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
} from '@/lib/ingest/acquisition-attempts'

import {
  classifyTierAWindowRepublishCandidate,
  findLatestTierAWindowAttempt,
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
})
