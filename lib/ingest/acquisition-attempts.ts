/**
 * Worker-only client for the append-only Tier-A acquisition ledger.
 *
 * The database owns attempt ordering and start time. Callers retain the
 * returned identity through RAW persistence and terminal recording; neither a
 * successful begin nor a complete acquisition authorizes public ranking.
 */

import { randomUUID } from 'node:crypto'

import {
  LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
  LEADERBOARD_ACQUISITION_MANIFEST_CONTRACT,
  LEADERBOARD_ACQUISITION_MANIFEST_V3_CONTRACT,
  parseLeaderboardAcquisitionManifest,
  parseLeaderboardAcquisitionManifestV3,
  type BuiltLeaderboardAcquisitionManifest,
  type BuiltLeaderboardAcquisitionManifestV3,
  type LeaderboardAcquisitionManifest,
  type LeaderboardAcquisitionManifestV3,
} from './acquisition-manifest'
import type { RankingTimeframe } from './core/types'
import { ingestClientConnect } from './db'
import { strictCanonicalJson, strictCanonicalSha256 } from './strict-canonical-json'

export { LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT } from './acquisition-manifest'
export const VERIFIED_LEADERBOARD_ACQUISITION_CONTRACT = LEADERBOARD_ACQUISITION_MANIFEST_CONTRACT
export const ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT =
  LEADERBOARD_ACQUISITION_MANIFEST_V3_CONTRACT
export const LEGACY_LEADERBOARD_ACQUISITION_CONTRACT = 'legacy_unverified' as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const FULL_GIT_SHA = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const WORKER_REGION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MANIFEST_PROJECTION_BRAND: unique symbol = Symbol('leaderboard-manifest-outcome')

export type LeaderboardAcquisitionContract =
  | typeof VERIFIED_LEADERBOARD_ACQUISITION_CONTRACT
  | typeof ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT
  | typeof LEGACY_LEADERBOARD_ACQUISITION_CONTRACT
export type LeaderboardAcquisitionTerminalState =
  | 'complete'
  | 'partial'
  | 'unknown'
  | 'processing_failed'
  | 'abandoned'
export type LeaderboardAcquisitionState = 'complete' | 'partial' | 'unknown'
export type LeaderboardPopulationState = 'verified' | 'partial' | 'unknown'
export type LeaderboardCaptureEvidenceState =
  | LeaderboardAcquisitionManifest['capture_evidence_state']
  | 'legacy_unverified'
  | 'unassessed'
export type LeaderboardTerminationReason = LeaderboardAcquisitionManifest['termination_reason']
export type LeaderboardAggregateReportState =
  LeaderboardAcquisitionManifest['population']['reports']['population']['state']
type LeaderboardAcquisitionManifestLike =
  | LeaderboardAcquisitionManifest
  | LeaderboardAcquisitionManifestV3
export type LeaderboardAcquisitionFailureStage =
  | 'session_open'
  | 'request_build'
  | 'upstream_fetch'
  | 'parse_validate_manifest'
  | 'raw_persistence'
  | 'attempt_finalize'
  | 'lease_lost'
  | 'worker_shutdown'
  | 'stale_timeout'
export type LeaderboardAcquisitionReasonCode =
  | 'upstream_blocked'
  | 'upstream_http_error'
  | 'upstream_unavailable'
  | 'pagination_partial'
  | 'pagination_unknown'
  | 'population_partial'
  | 'population_unknown'
  | 'legacy_unverified'
  | 'parse_failed'
  | 'validation_failed'
  | 'manifest_failed'
  | 'raw_persistence_failed'
  | 'attempt_finalize_failed'
  | 'lease_lost'
  | 'worker_crash'
  | 'stale_timeout'
  | 'unknown_failure'

export interface StartLeaderboardAcquisitionAttemptInput {
  attemptId?: string
  sourceId: number
  timeframe: RankingTimeframe
  observationCycleId: string | null
  queueJobId: string | null
  queueAttempt: number
  captureContract: LeaderboardAcquisitionContract
  runnerGitSha: string | null
  workerRegion: string | null
}

export interface LeaderboardAcquisitionAttempt {
  attemptSeq: number
  attemptId: string
  sourceId: number
  sourceSlug: string
  adapterSlug: string
  timeframe: RankingTimeframe
  observationCycleId: string | null
  queueJobId: string | null
  queueAttempt: number
  captureContract: LeaderboardAcquisitionContract
  attemptBindingContract: typeof LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT
  runnerGitSha: string | null
  workerRegion: string | null
  sourceStatus: 'active'
  sourceServingMode: 'legacy' | 'shadow' | 'serving'
  sourceCurrency: 'USDT' | 'USDx' | 'USDC' | 'USD'
  sourceFetchRegion: string
  recordedStartedAt: string
  replayed: boolean
}

export interface LeaderboardAcquisitionAttemptBinding {
  bindingContract: typeof LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT
  attemptId: string
  attemptSeq: number
  captureStartedAt: string
  captureCompletedAt: string
  runnerGitSha: string | null
}

export interface LeaderboardManifestOutcomeProjection {
  readonly [MANIFEST_PROJECTION_BRAND]: true
  binding: Readonly<LeaderboardAcquisitionAttemptBinding>
  terminalState: Extract<LeaderboardAcquisitionTerminalState, 'complete' | 'partial' | 'unknown'>
  acquisitionState: LeaderboardAcquisitionState
  populationState: LeaderboardPopulationState
  captureEvidenceState: Extract<LeaderboardCaptureEvidenceState, 'verified' | 'unavailable'>
  terminationReason: LeaderboardTerminationReason
  sourceRunId: string
  reportedPopulation: number | null
  populationReportState: LeaderboardAggregateReportState
  sourcePageCount: number
  reportedPageCount: number | null
  pageCountReportState: LeaderboardAggregateReportState
  observedPopulation: number
  acceptedPopulation: number
  rejectedRowCount: number
  deduplicatedRowCount: number
  callerLimited: boolean
  safetyLimited: boolean
  failureStage: null
  reasonCode: LeaderboardAcquisitionReasonCode | null
}

interface ManifestFinishInput {
  kind: 'manifest'
  attempt: LeaderboardAcquisitionAttempt
  projection: LeaderboardManifestOutcomeProjection
  sourcePayloadRawObjectId: number
  manifestRawObjectId: number
}

interface LegacyUnknownFinishInput {
  kind: 'legacy_unknown'
  attempt: LeaderboardAcquisitionAttempt
  captureCompletedAt: string
  diagnosticRawObjectId: number
  acceptedPopulation: number
  rejectedRowCount: number
}

interface ProcessingFailedFinishInput {
  kind: 'processing_failed'
  attempt: LeaderboardAcquisitionAttempt
  captureCompletedAt: string | null
  diagnosticRawObjectId?: number | null
  failureStage: LeaderboardAcquisitionFailureStage
  reasonCode: Exclude<
    LeaderboardAcquisitionReasonCode,
    'legacy_unverified' | 'lease_lost' | 'worker_crash' | 'stale_timeout'
  >
}

interface AbandonedFinishInput {
  kind: 'abandoned'
  attempt: LeaderboardAcquisitionAttempt
  captureCompletedAt: string | null
  diagnosticRawObjectId?: number | null
  failureStage: Extract<
    LeaderboardAcquisitionFailureStage,
    'lease_lost' | 'worker_shutdown' | 'stale_timeout'
  >
}

export type FinishLeaderboardAcquisitionAttemptInput =
  | ManifestFinishInput
  | LegacyUnknownFinishInput
  | ProcessingFailedFinishInput
  | AbandonedFinishInput

export interface LeaderboardAcquisitionOutcome {
  attemptSeq: number
  terminalState: LeaderboardAcquisitionTerminalState
  recordedCompletedAt: string
  replayed: boolean
}

interface AttemptRow {
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
  recorded_started_at_is_millisecond: boolean
}

interface OutcomeRow {
  attempt_seq: string
  terminal_state: string
  recorded_completed_at: string
}

interface CaptureContractRow {
  capture_contract: string
  adapter_slug: string
  attempt_binding_contract: string
  requires_runner_git_sha: boolean
}

interface TerminalProjection {
  terminalState: LeaderboardAcquisitionTerminalState
  acquisitionState: LeaderboardAcquisitionState
  populationState: LeaderboardPopulationState
  captureEvidenceState: LeaderboardCaptureEvidenceState
  terminationReason: LeaderboardTerminationReason | null
  captureStartedAt: string | null
  captureCompletedAt: string | null
  sourceRunId: string | null
  sourcePayloadRawObjectId: number | null
  manifestRawObjectId: number | null
  diagnosticRawObjectId: number | null
  reportedPopulation: number | null
  populationReportState: LeaderboardAggregateReportState | null
  sourcePageCount: number | null
  reportedPageCount: number | null
  pageCountReportState: LeaderboardAggregateReportState | null
  observedPopulation: number | null
  acceptedPopulation: number | null
  rejectedRowCount: number | null
  deduplicatedRowCount: number | null
  callerLimited: boolean
  safetyLimited: boolean
  failureStage: LeaderboardAcquisitionFailureStage | null
  reasonCode: LeaderboardAcquisitionReasonCode | null
}

const START_SQL = `SELECT
    attempt_seq::text AS attempt_seq,
    attempt_id::text AS attempt_id,
    source_id,
    source_slug,
    adapter_slug,
    timeframe,
    observation_cycle_id,
    queue_job_id,
    queue_attempt,
    capture_contract,
    attempt_binding_contract,
    runner_git_sha,
    worker_region,
    source_status,
    source_serving_mode,
    source_currency,
    source_fetch_region,
    recorded_started_at::text AS recorded_started_at,
    recorded_started_at = pg_catalog.date_trunc(
      'milliseconds', recorded_started_at
    ) AS recorded_started_at_is_millisecond
  FROM arena.start_leaderboard_acquisition_attempt(
    p_attempt_id => $1::uuid,
    p_source_id => $2::integer,
    p_timeframe => $3::integer,
    p_observation_cycle_id => $4::text,
    p_queue_job_id => $5::text,
    p_queue_attempt => $6::integer,
    p_capture_contract => $7::text,
    p_runner_git_sha => $8::text,
    p_worker_region => $9::text
  )`

const FINISH_SQL = `SELECT
    attempt_seq::text AS attempt_seq,
    terminal_state,
    recorded_completed_at::text AS recorded_completed_at
  FROM arena.finish_leaderboard_acquisition_attempt(
    p_attempt_id => $1::uuid,
    p_terminal_state => $2::text,
    p_acquisition_state => $3::text,
    p_population_state => $4::text,
    p_capture_evidence_state => $5::text,
    p_termination_reason => $6::text,
    p_capture_started_at => $7::timestamptz,
    p_capture_completed_at => $8::timestamptz,
    p_source_run_id => $9::text,
    p_source_payload_raw_object_id => $10::bigint,
    p_manifest_raw_object_id => $11::bigint,
    p_diagnostic_raw_object_id => $12::bigint,
    p_reported_population => $13::integer,
    p_population_report_state => $14::text,
    p_source_page_count => $15::integer,
    p_reported_page_count => $16::integer,
    p_page_count_report_state => $17::text,
    p_observed_population => $18::integer,
    p_accepted_population => $19::integer,
    p_rejected_row_count => $20::integer,
    p_deduplicated_row_count => $21::integer,
    p_caller_limited => $22::boolean,
    p_safety_limited => $23::boolean,
    p_failure_stage => $24::text,
    p_reason_code => $25::text
  )`

const ATTEMPT_BOUND_CAPTURE_CONTRACT_SQL = `SELECT
    capture_contract,
    adapter_slug,
    attempt_binding_contract,
    requires_runner_git_sha
  FROM arena.leaderboard_capture_contracts
  WHERE source_id = $1::smallint
    AND capture_contract = $2::text`

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function databaseErrorCode(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('code' in value)) return ''
  return String(value.code)
}

function isUncertainDatabaseOutcome(value: unknown): boolean {
  const code = databaseErrorCode(value)
  if (/^(08|40|53|55|57)/.test(code)) return true
  if (['EDBHANDLEREXITED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(code)) return true
  const message =
    typeof value === 'object' && value !== null && 'message' in value ? String(value.message) : ''
  return /EDBHANDLEREXITED|ECONNRESET|EPIPE|ETIMEDOUT|connection terminated|connection to database closed|query read timeout|socket hang up/i.test(
    message
  )
}

function shouldDestroyClient(value: unknown): boolean {
  const code = databaseErrorCode(value)
  return isUncertainDatabaseOutcome(value) || !/^(22|23|42)/.test(code)
}

async function queryOnce<Row>(sql: string, params: readonly unknown[]): Promise<Row[]> {
  const client = await ingestClientConnect()
  let released = false
  try {
    const result = await client.query(sql, params as unknown[])
    released = true
    client.release()
    return result.rows as Row[]
  } catch (cause) {
    if (!released) client.release(shouldDestroyClient(cause))
    throw cause
  }
}

async function exactReplayQuery<Row>(
  operation: 'start' | 'finish',
  sql: string,
  params: readonly unknown[]
): Promise<{ rows: Row[]; replayed: boolean }> {
  try {
    return { rows: await queryOnce<Row>(sql, params), replayed: false }
  } catch (firstCause) {
    if (!isUncertainDatabaseOutcome(firstCause)) throw firstCause
    try {
      return { rows: await queryOnce<Row>(sql, params), replayed: true }
    } catch (replayCause) {
      throw new AggregateError(
        [asError(firstCause), asError(replayCause)],
        `[ingest] leaderboard acquisition ${operation} outcome is unresolved after exact replay`
      )
    }
  }
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`[ingest] leaderboard acquisition ${label} is not a timestamp`)
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError(`[ingest] leaderboard acquisition ${label} is not a timestamp`)
  }
  return parsed.toISOString()
}

function assertCanonicalTimestamp(value: string, label: string): void {
  if (canonicalTimestamp(value, label) !== value) {
    throw new TypeError(`[ingest] leaderboard acquisition ${label} is not canonical`)
  }
}

function assertSafeInteger(value: number, label: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`[ingest] leaderboard acquisition ${label} is invalid`)
  }
}

function parsePositiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new TypeError(`[ingest] leaderboard acquisition ${label} is invalid`)
  }
  const parsed = Number(value)
  assertSafeInteger(parsed, label, 1)
  return parsed
}

function assertCanonicalNullableText(value: string | null, label: string, maxLength: number): void {
  if (value !== null && (value.length < 1 || value.length > maxLength || value.trim() !== value)) {
    throw new TypeError(`[ingest] leaderboard acquisition ${label} is invalid`)
  }
}

function assertCanonicalUuid(value: string, label: string): void {
  if (!UUID.test(value)) {
    throw new TypeError(`[ingest] leaderboard acquisition ${label} is invalid`)
  }
}

function assertDigest(value: string, pattern: RegExp, length: number, label: string): void {
  if (!pattern.test(value) || value === '0'.repeat(length)) {
    throw new TypeError(`[ingest] leaderboard acquisition ${label} is invalid`)
  }
}

function assertStartInput(
  input: Required<Pick<StartLeaderboardAcquisitionAttemptInput, 'attemptId'>> &
    Omit<StartLeaderboardAcquisitionAttemptInput, 'attemptId'>
): void {
  assertCanonicalUuid(input.attemptId, 'attempt id')
  assertSafeInteger(input.sourceId, 'source id', 1)
  if (input.sourceId > 32_767 || ![7, 30, 90].includes(input.timeframe)) {
    throw new TypeError('[ingest] leaderboard acquisition source/timeframe is invalid')
  }
  assertCanonicalNullableText(input.observationCycleId, 'observation cycle id', 512)
  assertCanonicalNullableText(input.queueJobId, 'queue job id', 512)
  assertSafeInteger(input.queueAttempt, 'queue attempt', 0)
  if (
    input.captureContract !== VERIFIED_LEADERBOARD_ACQUISITION_CONTRACT &&
    input.captureContract !== ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT &&
    input.captureContract !== LEGACY_LEADERBOARD_ACQUISITION_CONTRACT
  ) {
    throw new TypeError('[ingest] leaderboard acquisition capture contract is invalid')
  }
  if (input.runnerGitSha !== null) {
    assertDigest(input.runnerGitSha, FULL_GIT_SHA, 40, 'runner git SHA')
  }
  if (
    input.captureContract !== LEGACY_LEADERBOARD_ACQUISITION_CONTRACT &&
    input.runnerGitSha === null
  ) {
    throw new TypeError(
      '[ingest] leaderboard acquisition verified contract requires a runner git SHA'
    )
  }
  if (
    input.workerRegion !== null &&
    (!WORKER_REGION.test(input.workerRegion) || input.workerRegion.trim() !== input.workerRegion)
  ) {
    throw new TypeError('[ingest] leaderboard acquisition worker region is invalid')
  }
}

function assertCanonicalSourceText(value: string, label: string): void {
  if (value.length < 1 || value.length > 128 || value.trim() !== value) {
    throw new Error(`[ingest] leaderboard acquisition begin returned an invalid ${label}`)
  }
}

function parseExactStartRow(
  row: AttemptRow,
  input: Required<Pick<StartLeaderboardAcquisitionAttemptInput, 'attemptId'>> &
    Omit<StartLeaderboardAcquisitionAttemptInput, 'attemptId'>
): Omit<LeaderboardAcquisitionAttempt, 'replayed'> {
  const attemptSeq = parsePositiveSafeInteger(row.attempt_seq, 'attempt sequence')
  if (
    row.attempt_id !== input.attemptId ||
    row.source_id !== input.sourceId ||
    row.timeframe !== input.timeframe ||
    row.observation_cycle_id !== input.observationCycleId ||
    row.queue_job_id !== input.queueJobId ||
    row.queue_attempt !== input.queueAttempt ||
    row.capture_contract !== input.captureContract ||
    row.runner_git_sha !== input.runnerGitSha ||
    row.worker_region !== input.workerRegion ||
    row.attempt_binding_contract !== LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT
  ) {
    throw new Error('[ingest] leaderboard acquisition begin returned a conflicting identity')
  }
  if (row.recorded_started_at_is_millisecond !== true) {
    throw new Error('[ingest] leaderboard acquisition begin returned a sub-millisecond start')
  }
  if (row.source_status !== 'active') {
    throw new Error('[ingest] leaderboard acquisition begin returned a non-active source')
  }
  if (!['legacy', 'shadow', 'serving'].includes(row.source_serving_mode)) {
    throw new Error('[ingest] leaderboard acquisition begin returned an invalid serving mode')
  }
  if (!['USDT', 'USDx', 'USDC', 'USD'].includes(row.source_currency)) {
    throw new Error('[ingest] leaderboard acquisition begin returned an invalid currency')
  }
  assertCanonicalSourceText(row.source_slug, 'source slug')
  assertCanonicalSourceText(row.adapter_slug, 'adapter slug')
  assertCanonicalSourceText(row.source_fetch_region, 'fetch region')

  return Object.freeze({
    attemptSeq,
    attemptId: row.attempt_id,
    sourceId: row.source_id,
    sourceSlug: row.source_slug,
    adapterSlug: row.adapter_slug,
    timeframe: row.timeframe as RankingTimeframe,
    observationCycleId: row.observation_cycle_id,
    queueJobId: row.queue_job_id,
    queueAttempt: row.queue_attempt,
    captureContract: row.capture_contract as LeaderboardAcquisitionContract,
    attemptBindingContract:
      row.attempt_binding_contract as typeof LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
    runnerGitSha: row.runner_git_sha,
    workerRegion: row.worker_region,
    sourceStatus: row.source_status,
    sourceServingMode:
      row.source_serving_mode as LeaderboardAcquisitionAttempt['sourceServingMode'],
    sourceCurrency: row.source_currency as LeaderboardAcquisitionAttempt['sourceCurrency'],
    sourceFetchRegion: row.source_fetch_region,
    recordedStartedAt: canonicalTimestamp(row.recorded_started_at, 'recorded start'),
  })
}

function singleRow<Row>(rows: Row[], operation: 'start' | 'finish'): Row {
  if (rows.length !== 1) {
    throw new Error(
      `[ingest] leaderboard acquisition ${operation} returned ${rows.length} rows instead of one`
    )
  }
  return rows[0]
}

function freezeParams(values: readonly unknown[]): readonly unknown[] {
  return Object.freeze([...values])
}

function assertAttemptShape(attempt: LeaderboardAcquisitionAttempt): void {
  assertStartInput({
    attemptId: attempt.attemptId,
    sourceId: attempt.sourceId,
    timeframe: attempt.timeframe,
    observationCycleId: attempt.observationCycleId,
    queueJobId: attempt.queueJobId,
    queueAttempt: attempt.queueAttempt,
    captureContract: attempt.captureContract,
    runnerGitSha: attempt.runnerGitSha,
    workerRegion: attempt.workerRegion,
  })
  assertSafeInteger(attempt.attemptSeq, 'attempt sequence', 1)
  if (attempt.attemptBindingContract !== LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT) {
    throw new TypeError('[ingest] leaderboard acquisition attempt binding contract is invalid')
  }
  assertCanonicalTimestamp(attempt.recordedStartedAt, 'recorded start')
}

/**
 * Read the immutable database capability registry before choosing the @3
 * worker path. Adapter methods are shared by some source rows and therefore
 * are not sufficient evidence that a source contract was reviewed.
 */
export async function hasRegisteredAttemptBoundLeaderboardAcquisitionContract(input: {
  sourceId: number
  adapterSlug: string
}): Promise<boolean> {
  assertSafeInteger(input.sourceId, 'source id', 1)
  if (input.sourceId > 32_767) {
    throw new TypeError('[ingest] leaderboard acquisition source id is invalid')
  }
  if (
    typeof input.adapterSlug !== 'string' ||
    input.adapterSlug.length < 1 ||
    input.adapterSlug.length > 128 ||
    input.adapterSlug.trim() !== input.adapterSlug
  ) {
    throw new TypeError('[ingest] leaderboard acquisition adapter slug is invalid')
  }
  const rows = await queryOnce<CaptureContractRow>(ATTEMPT_BOUND_CAPTURE_CONTRACT_SQL, [
    input.sourceId,
    ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
  ])
  if (rows.length === 0) return false
  if (rows.length !== 1) {
    throw new Error('[ingest] attempt-bound leaderboard capture registry is ambiguous')
  }
  const [row] = rows
  if (
    row.capture_contract !== ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT ||
    row.adapter_slug !== input.adapterSlug ||
    row.attempt_binding_contract !== LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT ||
    row.requires_runner_git_sha !== true
  ) {
    throw new Error('[ingest] attempt-bound leaderboard capture registry is inconsistent')
  }
  return true
}

function reasonCodeForManifest(
  manifest: LeaderboardAcquisitionManifestLike,
  terminalState: LeaderboardManifestOutcomeProjection['terminalState']
): LeaderboardAcquisitionReasonCode | null {
  if (terminalState === 'complete') return null
  if (terminalState === 'partial') {
    if (
      manifest.termination_reason === 'caller_limit' ||
      manifest.termination_reason === 'safety_limit'
    ) {
      return 'pagination_partial'
    }
    if (manifest.termination_reason === 'degenerate_page') return 'pagination_unknown'
    return 'population_partial'
  }
  if (manifest.termination_reason === 'upstream_error') {
    return manifest.source_pages.some(
      (page) => page.http_status !== null && (page.http_status < 200 || page.http_status > 299)
    )
      ? 'upstream_http_error'
      : 'upstream_unavailable'
  }
  if (manifest.assessment.acquisition_state === 'complete') return 'population_unknown'
  return 'pagination_unknown'
}

function terminalStateForManifest(
  manifest: LeaderboardAcquisitionManifestLike
): LeaderboardManifestOutcomeProjection['terminalState'] {
  if (
    manifest.assessment.acquisition_state === 'complete' &&
    manifest.assessment.population_state === 'verified'
  ) {
    return 'complete'
  }
  if (
    manifest.assessment.acquisition_state === 'partial' ||
    manifest.assessment.population_state === 'partial'
  ) {
    return 'partial'
  }
  return 'unknown'
}

function projectParsedLeaderboardManifestOutcome(
  attempt: LeaderboardAcquisitionAttempt,
  built: BuiltLeaderboardAcquisitionManifest | BuiltLeaderboardAcquisitionManifestV3,
  manifest: LeaderboardAcquisitionManifestLike
): LeaderboardManifestOutcomeProjection {
  const canonicalJson = strictCanonicalJson(manifest)
  if (
    built.canonicalJson !== canonicalJson ||
    built.sourceRunId !== strictCanonicalSha256(manifest)
  ) {
    throw new TypeError('[ingest] acquisition manifest digest does not match its canonical body')
  }
  assertDigest(built.sourceRunId, SHA256, 64, 'source run id')
  if (
    manifest.data_contract !== attempt.captureContract ||
    manifest.source.id !== attempt.sourceId ||
    manifest.source.slug !== attempt.sourceSlug ||
    manifest.source.adapter_slug !== attempt.adapterSlug ||
    manifest.timeframe !== attempt.timeframe ||
    manifest.observation_cycle_id !== attempt.observationCycleId ||
    manifest.runner_git_sha !== attempt.runnerGitSha ||
    manifest.started_at !== attempt.recordedStartedAt
  ) {
    throw new TypeError('[ingest] acquisition manifest does not bind the durable attempt')
  }
  const terminalState = terminalStateForManifest(manifest)
  const populationReport = manifest.population.reports.population
  const pageCountReport = manifest.population.reports.page_count
  const binding = Object.freeze({
    bindingContract: attempt.attemptBindingContract,
    attemptId: attempt.attemptId,
    attemptSeq: attempt.attemptSeq,
    captureStartedAt: manifest.started_at,
    captureCompletedAt: manifest.completed_at,
    runnerGitSha: attempt.runnerGitSha,
  })
  return Object.freeze({
    [MANIFEST_PROJECTION_BRAND]: true as const,
    binding,
    terminalState,
    acquisitionState: manifest.assessment.acquisition_state,
    populationState: manifest.assessment.population_state,
    captureEvidenceState: manifest.capture_evidence_state,
    terminationReason: manifest.termination_reason,
    sourceRunId: built.sourceRunId,
    reportedPopulation: populationReport.value,
    populationReportState: populationReport.state,
    sourcePageCount: manifest.source_pages.length,
    reportedPageCount: pageCountReport.value,
    pageCountReportState: pageCountReport.state,
    observedPopulation: manifest.population.observed_row_count,
    acceptedPopulation: manifest.population.accepted_population,
    rejectedRowCount: manifest.population.rejected_row_count,
    deduplicatedRowCount: manifest.population.deduplicated_row_count,
    callerLimited: manifest.caller_limited,
    safetyLimited: manifest.safety_limited,
    failureStage: null,
    reasonCode: reasonCodeForManifest(manifest, terminalState),
  })
}

export function projectLeaderboardManifestOutcome(
  attempt: LeaderboardAcquisitionAttempt,
  built: BuiltLeaderboardAcquisitionManifest
): LeaderboardManifestOutcomeProjection {
  assertAttemptShape(attempt)
  if (attempt.captureContract !== VERIFIED_LEADERBOARD_ACQUISITION_CONTRACT) {
    throw new TypeError('[ingest] only a v2 attempt can project v2 manifest evidence')
  }
  return projectParsedLeaderboardManifestOutcome(
    attempt,
    built,
    parseLeaderboardAcquisitionManifest(built.manifest)
  )
}

export function projectLeaderboardManifestV3Outcome(
  attempt: LeaderboardAcquisitionAttempt,
  built: BuiltLeaderboardAcquisitionManifestV3
): LeaderboardManifestOutcomeProjection {
  assertAttemptShape(attempt)
  if (attempt.captureContract !== ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT) {
    throw new TypeError(
      '[ingest] only an attempt-bound v3 attempt can project v3 manifest evidence'
    )
  }
  const manifest = parseLeaderboardAcquisitionManifestV3(built.manifest)
  if (
    manifest.acquisition_attempt.binding_contract !== attempt.attemptBindingContract ||
    manifest.acquisition_attempt.attempt_id !== attempt.attemptId ||
    manifest.acquisition_attempt.attempt_seq !== attempt.attemptSeq
  ) {
    throw new TypeError('[ingest] acquisition manifest does not bind the durable attempt identity')
  }
  return projectParsedLeaderboardManifestOutcome(attempt, built, manifest)
}

function validatedCaptureClock(
  attempt: LeaderboardAcquisitionAttempt,
  captureCompletedAt: string | null
): Pick<TerminalProjection, 'captureStartedAt' | 'captureCompletedAt'> {
  if (captureCompletedAt === null) {
    return { captureStartedAt: null, captureCompletedAt: null }
  }
  assertCanonicalTimestamp(captureCompletedAt, 'capture completion')
  if (Date.parse(captureCompletedAt) < Date.parse(attempt.recordedStartedAt)) {
    throw new TypeError('[ingest] acquisition capture completion precedes its durable start')
  }
  return {
    captureStartedAt: attempt.recordedStartedAt,
    captureCompletedAt,
  }
}

function assertRawObjectId(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null
  assertSafeInteger(value, label, 1)
  return value
}

function projectTerminalInput(input: FinishLeaderboardAcquisitionAttemptInput): TerminalProjection {
  assertAttemptShape(input.attempt)
  if (input.kind === 'manifest') {
    const projection = input.projection
    if (
      projection[MANIFEST_PROJECTION_BRAND] !== true ||
      projection.binding.attemptId !== input.attempt.attemptId ||
      projection.binding.attemptSeq !== input.attempt.attemptSeq ||
      projection.binding.captureStartedAt !== input.attempt.recordedStartedAt ||
      projection.binding.runnerGitSha !== input.attempt.runnerGitSha
    ) {
      throw new TypeError('[ingest] acquisition outcome projection belongs to another attempt')
    }
    return {
      ...projection,
      captureStartedAt: projection.binding.captureStartedAt,
      captureCompletedAt: projection.binding.captureCompletedAt,
      sourcePayloadRawObjectId: assertRawObjectId(
        input.sourcePayloadRawObjectId,
        'source payload RAW object id'
      ),
      manifestRawObjectId: assertRawObjectId(input.manifestRawObjectId, 'manifest RAW object id'),
      diagnosticRawObjectId: null,
    }
  }

  const clock = validatedCaptureClock(input.attempt, input.captureCompletedAt)
  const diagnosticRawObjectId = assertRawObjectId(
    input.diagnosticRawObjectId,
    'diagnostic RAW object id'
  )
  if (input.kind === 'legacy_unknown') {
    if (input.attempt.captureContract !== LEGACY_LEADERBOARD_ACQUISITION_CONTRACT) {
      throw new TypeError('[ingest] legacy outcome requires a legacy attempt')
    }
    if (diagnosticRawObjectId === null) {
      throw new TypeError('[ingest] legacy outcome requires its diagnostic RAW object')
    }
    assertSafeInteger(input.acceptedPopulation, 'accepted population', 0)
    assertSafeInteger(input.rejectedRowCount, 'rejected row count', 0)
    return {
      terminalState: 'unknown',
      acquisitionState: 'unknown',
      populationState: 'unknown',
      captureEvidenceState: 'legacy_unverified',
      terminationReason: null,
      ...clock,
      sourceRunId: null,
      sourcePayloadRawObjectId: null,
      manifestRawObjectId: null,
      diagnosticRawObjectId,
      reportedPopulation: null,
      populationReportState: null,
      sourcePageCount: null,
      reportedPageCount: null,
      pageCountReportState: null,
      observedPopulation: null,
      acceptedPopulation: input.acceptedPopulation,
      rejectedRowCount: input.rejectedRowCount,
      deduplicatedRowCount: null,
      callerLimited: false,
      safetyLimited: false,
      failureStage: null,
      reasonCode: 'legacy_unverified',
    }
  }

  const common: TerminalProjection = {
    terminalState: input.kind,
    acquisitionState: 'unknown',
    populationState: 'unknown',
    captureEvidenceState: 'unassessed',
    terminationReason: null,
    ...clock,
    sourceRunId: null,
    sourcePayloadRawObjectId: null,
    manifestRawObjectId: null,
    diagnosticRawObjectId,
    reportedPopulation: null,
    populationReportState: null,
    sourcePageCount: null,
    reportedPageCount: null,
    pageCountReportState: null,
    observedPopulation: null,
    acceptedPopulation: null,
    rejectedRowCount: null,
    deduplicatedRowCount: null,
    callerLimited: false,
    safetyLimited: false,
    failureStage: input.failureStage,
    reasonCode:
      input.kind === 'processing_failed'
        ? input.reasonCode
        : input.failureStage === 'lease_lost'
          ? 'lease_lost'
          : input.failureStage === 'stale_timeout'
            ? 'stale_timeout'
            : 'worker_crash',
  }
  return common
}

export async function startLeaderboardAcquisitionAttempt(
  input: StartLeaderboardAcquisitionAttemptInput
): Promise<LeaderboardAcquisitionAttempt> {
  const normalized = {
    attemptId: input.attemptId ?? randomUUID(),
    sourceId: input.sourceId,
    timeframe: input.timeframe,
    observationCycleId: input.observationCycleId,
    queueJobId: input.queueJobId,
    queueAttempt: input.queueAttempt,
    captureContract: input.captureContract,
    runnerGitSha: input.runnerGitSha,
    workerRegion: input.workerRegion,
  }
  assertStartInput(normalized)
  const params = freezeParams([
    normalized.attemptId,
    normalized.sourceId,
    normalized.timeframe,
    normalized.observationCycleId,
    normalized.queueJobId,
    normalized.queueAttempt,
    normalized.captureContract,
    normalized.runnerGitSha,
    normalized.workerRegion,
  ])
  const result = await exactReplayQuery<AttemptRow>('start', START_SQL, params)
  const row = singleRow(result.rows, 'start')
  return Object.freeze({ ...parseExactStartRow(row, normalized), replayed: result.replayed })
}

export async function finishLeaderboardAcquisitionAttempt(
  input: FinishLeaderboardAcquisitionAttemptInput
): Promise<LeaderboardAcquisitionOutcome> {
  const projected = projectTerminalInput(input)
  const params = freezeParams([
    input.attempt.attemptId,
    projected.terminalState,
    projected.acquisitionState,
    projected.populationState,
    projected.captureEvidenceState,
    projected.terminationReason,
    projected.captureStartedAt,
    projected.captureCompletedAt,
    projected.sourceRunId,
    projected.sourcePayloadRawObjectId,
    projected.manifestRawObjectId,
    projected.diagnosticRawObjectId,
    projected.reportedPopulation,
    projected.populationReportState,
    projected.sourcePageCount,
    projected.reportedPageCount,
    projected.pageCountReportState,
    projected.observedPopulation,
    projected.acceptedPopulation,
    projected.rejectedRowCount,
    projected.deduplicatedRowCount,
    projected.callerLimited,
    projected.safetyLimited,
    projected.failureStage,
    projected.reasonCode,
  ])
  const result = await exactReplayQuery<OutcomeRow>('finish', FINISH_SQL, params)
  const row = singleRow(result.rows, 'finish')
  const attemptSeq = parsePositiveSafeInteger(row.attempt_seq, 'terminal attempt sequence')
  if (attemptSeq !== input.attempt.attemptSeq || row.terminal_state !== projected.terminalState) {
    throw new Error('[ingest] leaderboard acquisition finish returned a conflicting outcome')
  }
  return Object.freeze({
    attemptSeq,
    terminalState: row.terminal_state as LeaderboardAcquisitionTerminalState,
    recordedCompletedAt: canonicalTimestamp(row.recorded_completed_at, 'recorded completion'),
    replayed: result.replayed,
  })
}
