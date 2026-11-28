/**
 * Read-only lookup for the Tier-A window republish path.
 *
 * On a BullMQ retry, a window whose previous queue attempt already captured,
 * persisted (RAW + manifest + terminal outcome) and proved completeness, but
 * failed only while publishing, can be re-published from its recorded RAW
 * instead of being rescanned. This module only reads the window's latest
 * attempt and classifies it; it never writes. Every authority decision is
 * re-checked by the database: the publication fences (latest terminal
 * attempt, exact outcome, freshness) and
 * arena.record_tier_a_execution_window_republish_receipt (migration
 * 20261127202748: same queue job, earlier claim and queue attempt, latest
 * attempt, complete or exhausted with a holding proof, snapshot binding,
 * at most one republish per attempt).
 */

import type { IngestQueryExecutor } from '@/lib/ingest/db'
import type { RankingTimeframe } from '@/lib/ingest/core/types'
import {
  ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
  LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
  type ClaimedLeaderboardAcquisitionAttempt,
  type LeaderboardAcquisitionContract,
} from '@/lib/ingest/acquisition-attempts'
import type { RawObjectReceipt } from '@/lib/ingest/raw'

/** Fixed skip reasons, logged as `reason=<value>`. */
export type TierAWindowRepublishSkipReason =
  | 'sha_mismatch'
  | 'contract_unsupported'
  | 'raw_unreadable'
  | 'raw_hash_mismatch'
  | 'manifest_mismatch'
  | 'page_hash_mismatch'
  | 'parse_mismatch'
  | 'receipt_rpc_unavailable'
  | 'publish_failed'
  | 'stale'

/**
 * Upper bound for a replayable capture's age. Publication additionally
 * rejects evidence older than the source's reviewed metric contract
 * (assertTrustedPublicationIsNewest); the tighter of the two applies here so a
 * stale capture never downloads its RAW.
 */
export const TIER_A_WINDOW_REPUBLISH_MAX_AGE_MS = 6 * 60 * 60 * 1000

export interface TierAWindowRepublishOutcome {
  terminalState: string
  acquisitionState: string
  populationState: string
  reasonCode: string | null
  captureEvidenceState: string
  terminationReason: string | null
  captureStartedAt: string
  captureCompletedAt: string
  sourceRunId: string
  sourcePayload: RawObjectReceipt
  populationManifest: RawObjectReceipt
  diagnosticRawObjectId: number | null
  failureStage: string | null
  reportedPopulation: number | null
  populationReportState: string | null
  sourcePageCount: number | null
  reportedPageCount: number | null
  pageCountReportState: string | null
  observedPopulation: number | null
  acceptedPopulation: number | null
  rejectedRowCount: number | null
  deduplicatedRowCount: number | null
  callerLimited: boolean
  safetyLimited: boolean
  /** An exhaustion proof row exists for this outcome's source run. */
  exhaustionEvidencePresent: boolean
}

export interface LatestTierAWindowAttempt {
  attempt: ClaimedLeaderboardAcquisitionAttempt
  /** Null while the latest attempt is in progress or its outcome is not usable. */
  outcome: TierAWindowRepublishOutcome | null
  databaseNow: string
}

export interface TierAWindowRepublishCurrentExecution {
  sourceId: number
  timeframe: RankingTimeframe
  observationCycleId: string
  queueJobId: string
  queueAttempt: number
  claimId: string
  generationSeq: number
  gitSha: string
  /** Tightest reviewed metric freshness bound, or null without one. */
  maxFreshnessMs: number | null
}

export type TierAWindowRepublishClassification =
  | { kind: 'none' }
  | { kind: 'skip'; reason: TierAWindowRepublishSkipReason; attemptSeq: number }
  | {
      kind: 'candidate'
      attempt: ClaimedLeaderboardAcquisitionAttempt
      outcome: TierAWindowRepublishOutcome
    }

/**
 * The newest attempt of one source window and its outcome. `attempt_seq`, not
 * a clock, orders attempts (the same fence publication uses). Only objects the
 * worker role may read are touched; the exhaustion proof is re-validated by
 * the SECURITY DEFINER receipt function and the publication fence.
 */
export const LATEST_TIER_A_WINDOW_ATTEMPT_SQL = `SELECT
    attempt.attempt_seq::text AS attempt_seq,
    attempt.attempt_id::text AS attempt_id,
    attempt.source_id,
    attempt.source_slug,
    attempt.adapter_slug,
    attempt.timeframe,
    attempt.observation_cycle_id,
    attempt.queue_job_id,
    attempt.queue_attempt,
    attempt.capture_contract,
    attempt.attempt_binding_contract,
    attempt.runner_git_sha,
    attempt.worker_region,
    attempt.source_status,
    attempt.source_serving_mode,
    attempt.source_currency,
    attempt.source_fetch_region,
    attempt.recorded_started_at::text AS recorded_started_at,
    attempt.execution_claim_id::text AS execution_claim_id,
    attempt.execution_generation_seq::text AS execution_generation_seq,
    outcome.attempt_seq IS NOT NULL AS has_outcome,
    outcome.terminal_state,
    outcome.acquisition_state,
    outcome.population_state,
    outcome.reason_code,
    outcome.capture_evidence_state,
    outcome.termination_reason,
    outcome.capture_started_at::text AS capture_started_at,
    outcome.capture_completed_at::text AS capture_completed_at,
    outcome.source_run_id,
    outcome.source_payload_raw_object_id::text AS source_payload_raw_object_id,
    outcome.source_payload_content_hash,
    outcome.source_payload_storage_path,
    outcome.manifest_raw_object_id::text AS manifest_raw_object_id,
    outcome.manifest_content_hash,
    outcome.manifest_storage_path,
    outcome.diagnostic_raw_object_id::text AS diagnostic_raw_object_id,
    outcome.failure_stage,
    outcome.reported_population,
    outcome.population_report_state,
    outcome.source_page_count,
    outcome.reported_page_count,
    outcome.page_count_report_state,
    outcome.observed_population,
    outcome.accepted_population,
    outcome.rejected_row_count,
    outcome.deduplicated_row_count,
    outcome.caller_limited,
    outcome.safety_limited,
    EXISTS (
      SELECT 1
        FROM arena.leaderboard_acquisition_exhaustion_evidence AS evidence
       WHERE evidence.attempt_seq = attempt.attempt_seq
         AND evidence.source_run_id = outcome.source_run_id
    ) AS exhaustion_evidence_present,
    pg_catalog.clock_timestamp()::text AS database_now
  FROM arena.leaderboard_acquisition_attempts AS attempt
  LEFT JOIN arena.leaderboard_acquisition_outcomes AS outcome
    ON outcome.attempt_seq = attempt.attempt_seq
 WHERE attempt.source_id = $1::smallint
   AND attempt.timeframe = $2::smallint
 ORDER BY attempt.attempt_seq DESC
 LIMIT 1`

interface LatestAttemptRow {
  attempt_seq: string
  attempt_id: string
  source_id: number
  source_slug: string
  adapter_slug: string
  timeframe: number
  observation_cycle_id: string | null
  queue_job_id: string | null
  queue_attempt: number
  capture_contract: string
  attempt_binding_contract: string
  runner_git_sha: string | null
  worker_region: string | null
  source_status: string
  source_serving_mode: string
  source_currency: string
  source_fetch_region: string
  recorded_started_at: string
  execution_claim_id: string | null
  execution_generation_seq: string | null
  has_outcome: boolean
  terminal_state: string | null
  acquisition_state: string | null
  population_state: string | null
  reason_code: string | null
  capture_evidence_state: string | null
  termination_reason: string | null
  capture_started_at: string | null
  capture_completed_at: string | null
  source_run_id: string | null
  source_payload_raw_object_id: string | null
  source_payload_content_hash: string | null
  source_payload_storage_path: string | null
  manifest_raw_object_id: string | null
  manifest_content_hash: string | null
  manifest_storage_path: string | null
  diagnostic_raw_object_id: string | null
  failure_stage: string | null
  reported_population: number | null
  population_report_state: string | null
  source_page_count: number | null
  reported_page_count: number | null
  page_count_report_state: string | null
  observed_population: number | null
  accepted_population: number | null
  rejected_row_count: number | null
  deduplicated_row_count: number | null
  caller_limited: boolean | null
  safety_limited: boolean | null
  exhaustion_evidence_present: boolean
  database_now: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/

function lookupError(detail: string): Error {
  return new Error(`[tier-a] republish lookup returned ${detail}`)
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') throw lookupError(`a non-timestamp ${label}`)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw lookupError(`an invalid ${label}`)
  return new Date(parsed).toISOString()
}

function positiveId(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw lookupError(`an invalid ${label}`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw lookupError(`an unsafe ${label}`)
  return parsed
}

function nullablePositiveId(value: unknown, label: string): number | null {
  return value === null ? null : positiveId(value, label)
}

function parseAttempt(row: LatestAttemptRow): ClaimedLeaderboardAcquisitionAttempt | null {
  // An attempt not started under an execution claim can never be republished
  // across claims; it is simply not a candidate.
  if (row.execution_claim_id === null || row.execution_generation_seq === null) return null
  if (!UUID.test(row.attempt_id) || !UUID.test(row.execution_claim_id)) {
    throw lookupError('a non-canonical attempt or claim id')
  }
  if (row.attempt_binding_contract !== LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT) {
    throw lookupError('an unknown attempt binding contract')
  }
  return Object.freeze({
    attemptSeq: positiveId(row.attempt_seq, 'attempt sequence'),
    attemptId: row.attempt_id,
    sourceId: row.source_id,
    sourceSlug: row.source_slug,
    adapterSlug: row.adapter_slug,
    timeframe: row.timeframe as RankingTimeframe,
    observationCycleId: row.observation_cycle_id,
    queueJobId: row.queue_job_id,
    queueAttempt: row.queue_attempt,
    captureContract: row.capture_contract as LeaderboardAcquisitionContract,
    attemptBindingContract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
    runnerGitSha: row.runner_git_sha,
    workerRegion: row.worker_region,
    sourceStatus: row.source_status as 'active',
    sourceServingMode:
      row.source_serving_mode as ClaimedLeaderboardAcquisitionAttempt['sourceServingMode'],
    sourceCurrency: row.source_currency as ClaimedLeaderboardAcquisitionAttempt['sourceCurrency'],
    sourceFetchRegion: row.source_fetch_region,
    recordedStartedAt: canonicalTimestamp(row.recorded_started_at, 'attempt start'),
    executionClaimId: row.execution_claim_id,
    executionGenerationSeq: positiveId(row.execution_generation_seq, 'execution generation'),
  })
}

function parseOutcome(row: LatestAttemptRow): TierAWindowRepublishOutcome | null {
  // Only a manifest outcome (source run + both trust RAWs) can be replayed.
  if (
    !row.has_outcome ||
    row.terminal_state === null ||
    row.acquisition_state === null ||
    row.population_state === null ||
    row.capture_evidence_state === null ||
    row.capture_started_at === null ||
    row.capture_completed_at === null ||
    row.source_run_id === null ||
    row.source_payload_raw_object_id === null ||
    row.source_payload_content_hash === null ||
    row.source_payload_storage_path === null ||
    row.manifest_raw_object_id === null ||
    row.manifest_content_hash === null ||
    row.manifest_storage_path === null
  ) {
    return null
  }
  if (
    !SHA256.test(row.source_run_id) ||
    !SHA256.test(row.source_payload_content_hash) ||
    !SHA256.test(row.manifest_content_hash)
  ) {
    throw lookupError('a non-canonical outcome digest')
  }
  return Object.freeze({
    terminalState: row.terminal_state,
    acquisitionState: row.acquisition_state,
    populationState: row.population_state,
    reasonCode: row.reason_code,
    captureEvidenceState: row.capture_evidence_state,
    terminationReason: row.termination_reason,
    captureStartedAt: canonicalTimestamp(row.capture_started_at, 'capture start'),
    captureCompletedAt: canonicalTimestamp(row.capture_completed_at, 'capture completion'),
    sourceRunId: row.source_run_id,
    sourcePayload: Object.freeze({
      id: positiveId(row.source_payload_raw_object_id, 'source payload RAW id'),
      storagePath: row.source_payload_storage_path,
      contentHash: row.source_payload_content_hash,
    }),
    populationManifest: Object.freeze({
      id: positiveId(row.manifest_raw_object_id, 'manifest RAW id'),
      storagePath: row.manifest_storage_path,
      contentHash: row.manifest_content_hash,
    }),
    diagnosticRawObjectId: nullablePositiveId(row.diagnostic_raw_object_id, 'diagnostic RAW id'),
    failureStage: row.failure_stage,
    reportedPopulation: row.reported_population,
    populationReportState: row.population_report_state,
    sourcePageCount: row.source_page_count,
    reportedPageCount: row.reported_page_count,
    pageCountReportState: row.page_count_report_state,
    observedPopulation: row.observed_population,
    acceptedPopulation: row.accepted_population,
    rejectedRowCount: row.rejected_row_count,
    deduplicatedRowCount: row.deduplicated_row_count,
    callerLimited: row.caller_limited === true,
    safetyLimited: row.safety_limited === true,
    exhaustionEvidencePresent: row.exhaustion_evidence_present === true,
  })
}

/** Read the newest attempt of one source window (read-only). */
export async function findLatestTierAWindowAttempt(
  executor: IngestQueryExecutor,
  input: { sourceId: number; timeframe: RankingTimeframe }
): Promise<LatestTierAWindowAttempt | null> {
  const { rows } = await executor.query<LatestAttemptRow>(LATEST_TIER_A_WINDOW_ATTEMPT_SQL, [
    input.sourceId,
    input.timeframe,
  ])
  if (rows.length === 0) return null
  if (rows.length !== 1) throw lookupError(`${rows.length} rows instead of one`)
  const row = rows[0]
  if (row.source_id !== input.sourceId || row.timeframe !== input.timeframe) {
    throw lookupError('a different source window')
  }
  const attempt = parseAttempt(row)
  if (attempt === null) return null
  return {
    attempt,
    outcome: parseOutcome(row),
    databaseNow: canonicalTimestamp(row.database_now, 'database clock'),
  }
}

/** Complete, or the exhausted branch with a recorded proof (as 20261118161307). */
function isPublishableOutcome(outcome: TierAWindowRepublishOutcome): boolean {
  if (outcome.diagnosticRawObjectId !== null || outcome.failureStage !== null) return false
  if (outcome.terminalState === 'complete') return true
  return (
    outcome.terminalState === 'unknown' &&
    outcome.populationState === 'unknown' &&
    outcome.populationReportState === 'unknown' &&
    outcome.reportedPopulation === null &&
    outcome.reasonCode === 'population_unknown' &&
    outcome.exhaustionEvidencePresent
  )
}

/**
 * Decide whether the window's latest attempt is a republish candidate for the
 * current execution. `none` is the ordinary case (first attempt, a fresh job,
 * a capture that never reached a publishable outcome) and is not logged; a
 * `skip` names why an otherwise replayable capture is not reused.
 */
export function classifyTierAWindowRepublishCandidate(
  latest: LatestTierAWindowAttempt | null,
  current: TierAWindowRepublishCurrentExecution
): TierAWindowRepublishClassification {
  if (latest === null || latest.outcome === null) return { kind: 'none' }
  const { attempt, outcome } = latest
  if (
    attempt.sourceId !== current.sourceId ||
    attempt.timeframe !== current.timeframe ||
    attempt.observationCycleId !== current.observationCycleId ||
    attempt.queueJobId !== current.queueJobId ||
    !(attempt.queueAttempt < current.queueAttempt) ||
    attempt.executionClaimId === current.claimId ||
    !(attempt.executionGenerationSeq < current.generationSeq) ||
    !isPublishableOutcome(outcome)
  ) {
    return { kind: 'none' }
  }
  const skip = (reason: TierAWindowRepublishSkipReason): TierAWindowRepublishClassification => ({
    kind: 'skip',
    reason,
    attemptSeq: attempt.attemptSeq,
  })
  if (attempt.captureContract !== ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT) {
    return skip('contract_unsupported')
  }
  if (attempt.runnerGitSha !== current.gitSha) return skip('sha_mismatch')
  // The earliest page cannot be fetched before the attempt start, so judging
  // age from the start is never looser than publication's sourceAsOf check.
  const maxAgeMs = Math.min(
    current.maxFreshnessMs ?? TIER_A_WINDOW_REPUBLISH_MAX_AGE_MS,
    TIER_A_WINDOW_REPUBLISH_MAX_AGE_MS
  )
  if (Date.parse(latest.databaseNow) - Date.parse(attempt.recordedStartedAt) >= maxAgeMs) {
    return skip('stale')
  }
  return { kind: 'candidate', attempt, outcome }
}
