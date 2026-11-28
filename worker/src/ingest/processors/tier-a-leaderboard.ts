/**
 * Tier A leaderboard crawl (spec §2.3-A): every 4-6h per source, all native
 * ranking timeframes. Attempt-bound capture is the only path: a source needs
 * an adapter capture implementation and an exactly registered @3/@4 capture
 * contract, otherwise the job fails before any session. Flow per TF:
 *   begin attempt → capture → pure-parse → staging validate → attempt-bound
 *   RAW + manifest → terminal outcome → fenced publish (count check plus the
 *   attempt evidence; failed snapshots never reach serving).
 *
 * This is the bulk of the product: every ranked trader gets a traders row,
 * leaderboard_entries and headline stats so profile first screens render
 * with zero on-demand fetching.
 */

import type { Job } from 'bullmq'
import { getSourceBySlug, nativeRankingTimeframes } from '@/lib/ingest/sources'
import { getAdapter, type SourceAdapter } from '@/lib/ingest/core/adapter'
import {
  RANKING_TIMEFRAMES,
  type BoardSeriesBlock,
  type ParseCtx,
  type ParsedLeaderboardRow,
  type RankingTimeframe,
  type RawPage,
  type SourceRow,
} from '@/lib/ingest/core/types'
import { openSession } from '@/lib/ingest/fetch/fetcher'
import {
  LeaderboardCaptureUpstreamError,
  isPartitionedNumericLeaderboardCapture,
  type AnyLeaderboardCapture,
  type LeaderboardCapture,
  type PartitionedNumericLeaderboardCapture,
} from '@/lib/ingest/fetch/capture'
import {
  buildLeaderboardAcquisitionManifestV3,
  buildLeaderboardAcquisitionManifestV4,
  LEADERBOARD_PARTITIONED_NUMERIC_PARSER_PAGE_CONTRACT,
  parseLeaderboardAcquisitionManifestV3,
  projectPartitionedNumericParserPage,
  type BuiltLeaderboardAcquisitionManifestV3,
  type BuildLeaderboardAcquisitionManifestInput,
  type LeaderboardAcquisitionManifestV3,
  type BuildLeaderboardAcquisitionManifestV4Input,
} from '@/lib/ingest/acquisition-manifest'
import {
  ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
  ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
  findRegisteredAttemptBoundLeaderboardAcquisitionContract,
  finishLeaderboardAcquisitionAttemptInTransaction,
  projectLeaderboardManifestV3Outcome,
  startLeaderboardAcquisitionAttemptInTransaction,
  type AttemptBoundLeaderboardAcquisitionContract,
  type LeaderboardManifestOutcomeProjection,
  type ClaimedLeaderboardAcquisitionAttempt,
  type LeaderboardAcquisitionExecutionBinding,
  type LeaderboardAcquisitionFailureStage,
  type LeaderboardAcquisitionReasonCode,
} from '@/lib/ingest/acquisition-attempts'
import {
  LeaderboardTrustRawReadError,
  readAttemptBoundLeaderboardTrustRawPayload,
  writeAttemptBoundLeaderboardRawArtifactSet,
  writeRawObject,
  type IngestTransactionRunner,
  type RawObjectReceipt,
} from '@/lib/ingest/raw'
import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalJson,
  strictCanonicalSha256,
} from '@/lib/ingest/strict-canonical-json'
import { recordFieldInventoryWithExecutor } from '@/lib/ingest/field-inventory'
import { StaleLeaderboardPublicationError } from '@/lib/ingest/serving/publish'
import { validateLeaderboardRows } from '@/lib/ingest/staging/validate'
import {
  hasRegisteredLeaderboardMetricTrust,
  registeredLeaderboardMetricMaxFreshnessMs,
  type LeaderboardAttemptBoundV4Bundle,
  type LeaderboardMetricTrustBundle,
} from '@/lib/ingest/serving/metric-trust-publish'
import type { TierJobData } from '../queues'
import { observationCycleId } from '../observation-cycle'
import { noteTierAPublished } from '../progress'
import {
  assertSourceMatchesConsumedRegion,
  type AuthorizedConsumedRegionContext,
} from '../consumed-region-context'
import {
  publishClaimedAttemptBoundLeaderboardSnapshot,
  publishClaimedBoardSeries,
  publishClaimedTrustedLeaderboardSnapshot,
} from '../fenced-tier-a-publication'
import {
  claimSourceJobExecutionAuthority,
  type SourceJobExecutionAuthority,
} from '../source-job-execution-authority'
import type { SourceJobRunProvenance } from '../source-job-routing'
import {
  getTierAExecutionWindowReceipt,
  hasTierAExecutionWindowRepublishReceipt,
  recordTierAExecutionWindowReceipt,
  recordTierAExecutionWindowRepublishReceipt,
  TierAExecutionWindowReceiptError,
  withTierAExecutionReceiptWriter,
} from '../tier-a-execution-window-receipt'
import {
  classifyTierAWindowRepublishCandidate,
  findLatestTierAWindowAttempt,
  classifyRepublishPublicationError,
  type TierAWindowRepublishSkipReason,
} from '../tier-a-window-republish'

export interface TierAResult {
  timeframe: number
  actualCount: number
  rejects: number
  passed: boolean
  baselineUsed: number | null
  snapshotId: number
}

type TierAAcquisition =
  | { kind: 'capture'; capture: AnyLeaderboardCapture }
  | {
      kind: 'captured_error'
      capture: AnyLeaderboardCapture
      error: LeaderboardCaptureUpstreamError
    }

async function acquireLeaderboard(
  adapter: SourceAdapter,
  session: Parameters<SourceAdapter['listLeaderboard']>[0],
  src: Parameters<SourceAdapter['listLeaderboard']>[1],
  timeframe: RankingTimeframe,
  signal?: AbortSignal
): Promise<TierAAcquisition> {
  if (!adapter.captureLeaderboard) {
    throw new Error(`[tier-a] ${src.slug} adapter has no attempt-bound capture implementation`)
  }
  try {
    return {
      kind: 'capture',
      capture: await adapter.captureLeaderboard(session, src, timeframe, { signal }),
    }
  } catch (cause) {
    if (cause instanceof LeaderboardCaptureUpstreamError) {
      return { kind: 'captured_error', capture: cause.capture, error: cause }
    }
    throw cause
  }
}

function authoritativePartitionIds(
  adapter: SourceAdapter,
  src: SourceRow,
  timeframe: RankingTimeframe
): readonly string[] {
  if (!adapter.leaderboardPartitionIds) {
    throw new TypeError(
      `[tier-a] ${src.slug} v4 capture requires authoritative adapter partition ids`
    )
  }
  const partitionIds = [...adapter.leaderboardPartitionIds(src, timeframe)]
  if (
    partitionIds.length < 2 ||
    new Set(partitionIds).size !== partitionIds.length ||
    partitionIds.some(
      (partitionId) =>
        typeof partitionId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(partitionId)
    )
  ) {
    throw new TypeError(`[tier-a] ${src.slug} v4 partition ids are not canonical and unique`)
  }
  return Object.freeze(partitionIds)
}

function completedTimeframesFrom(value: unknown): RankingTimeframe[] {
  if (!Array.isArray(value)) return []
  const completed = new Set(value.filter((timeframe) => RANKING_TIMEFRAMES.includes(timeframe)))
  return RANKING_TIMEFRAMES.filter((timeframe) => completed.has(timeframe))
}

class TierACheckpointPersistenceError extends AggregateError {
  constructor(
    sourceSlug: string,
    timeframe: RankingTimeframe | null,
    failures: readonly unknown[]
  ) {
    const errors = failures.map(asError)
    const detail = errors.map((error) => error.message).join('; ')
    super(
      errors,
      `checkpoint persistence failed for ${sourceSlug}` +
        `${timeframe === null ? '' : ` ${timeframe}d`}: ${detail}`
    )
    this.name = 'TierACheckpointPersistenceError'
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

class TierAEvidencePersistenceError extends AggregateError {
  constructor(
    sourceSlug: string,
    timeframe: RankingTimeframe,
    priorFailures: readonly unknown[],
    persistenceCause: unknown
  ) {
    super(
      [...priorFailures.map(asError), asError(persistenceCause)],
      `[tier-a] ${sourceSlug} ${timeframe}d evidence persistence failed`
    )
    this.name = 'TierAEvidencePersistenceError'
  }
}

class TierACaptureProcessingError extends AggregateError {
  constructor(sourceSlug: string, timeframe: RankingTimeframe, failures: readonly unknown[]) {
    super(
      failures.map(asError),
      `[tier-a] ${sourceSlug} ${timeframe}d capture processing failed after RAW fallback`
    )
    this.name = 'TierACaptureProcessingError'
  }
}

class TierAAttemptFinalizationError extends AggregateError {
  constructor(
    sourceSlug: string,
    timeframe: RankingTimeframe,
    priorFailures: readonly unknown[],
    finalizationCause: unknown
  ) {
    super(
      [...priorFailures.map(asError), asError(finalizationCause)],
      `[tier-a] ${sourceSlug} ${timeframe}d acquisition finalization failed`
    )
    this.name = 'TierAAttemptFinalizationError'
  }
}

/**
 * The snapshot was recorded but failed its count check (GATED). A plain Error
 * subclass with the unchanged message, so the capture path handles it exactly
 * as before; the republish path recognises it, because replaying the same
 * capture within the same cycle would be GATED again on every retry.
 */
class TierACountCheckGatedError extends Error {}

function throwIfTierACancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const reason = signal.reason
  throw reason instanceof Error ? reason : new Error('[tier-a] execution cancelled')
}

function canonicalAttemptObservationCycleId(value: string | null, sourceSlug: string): string {
  if (
    value === null ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(
      `[tier-a] ${sourceSlug} attempt-bound capture requires a canonical observation cycle`
    )
  }
  return value
}

function exactCompletedTimeframeCache(
  value: unknown,
  expected: readonly RankingTimeframe[]
): boolean {
  if (value === undefined && expected.length === 0) return true
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((timeframe, index) => timeframe === expected[index])
  )
}

async function replaceCompletedTimeframeCache(input: {
  provenance: SourceJobRunProvenance
  execution: SourceJobExecutionAuthority
  persistedJobData: TierJobData
  completedTimeframes: ReadonlySet<RankingTimeframe>
  nativeTimeframes: readonly RankingTimeframe[]
  sourceSlug: string
  timeframe: RankingTimeframe | null
}): Promise<TierJobData> {
  const completed = completedTimeframesFrom([...input.completedTimeframes]).filter((timeframe) =>
    input.nativeTimeframes.includes(timeframe)
  )
  if (exactCompletedTimeframeCache(input.persistedJobData.completedTimeframes, completed)) {
    return input.persistedJobData
  }
  const nextData: TierJobData = {
    ...input.persistedJobData,
    completedTimeframes: completed,
  }

  try {
    await input.provenance.bullJob.replaceDataIfOwned(nextData)
    return nextData
  } catch (checkpointCause) {
    try {
      // replaceDataIfOwned failures are sticky. Assert immediately so Bull
      // ownership loss revokes the execution before any later timeframe can run.
      input.execution.assertActive()
    } catch (authorityCause) {
      throw new TierACheckpointPersistenceError(input.sourceSlug, input.timeframe, [
        checkpointCause,
        authorityCause,
      ])
    }
    throw new TierACheckpointPersistenceError(input.sourceSlug, input.timeframe, [checkpointCause])
  }
}

async function recordFieldInventoryBestEffort(input: {
  execution: SourceJobExecutionAuthority
  sourceId: number
  payload: unknown
}): Promise<void> {
  try {
    await input.execution.withClaimedWrite((transaction) =>
      recordFieldInventoryWithExecutor(transaction, input.sourceId, 'tier_a', input.payload)
    )
  } catch {
    // Inventory is observational only. A business/query failure may be
    // swallowed, but an authority failure must remain terminal and sticky.
    input.execution.assertActive()
  }
}

function lifecycleAggregate(sourceSlug: string, errors: readonly Error[]): Error | null {
  if (errors.length === 0) return null
  if (errors.length === 1) return errors[0]
  return new AggregateError(errors, `[tier-a] ${sourceSlug}: lifecycle failures`)
}

type AttemptLifecycle = 'not_started' | 'open' | 'finalizing' | 'terminal'
type ProcessingFailureReason = Exclude<
  LeaderboardAcquisitionReasonCode,
  'legacy_unverified' | 'lease_lost' | 'worker_crash' | 'stale_timeout'
>

interface CaptureManifestInput {
  src: SourceRow
  timeframe: RankingTimeframe
  startedAt: string
  completedAt: string
  runnerGitSha: string | null
  cycleId: string | null
  capture: AnyLeaderboardCapture
  capturedFailure: boolean
  acceptedPopulation: number
  rejectedRowCount: number
}

function captureManifestInput(
  input: CaptureManifestInput & { capture: LeaderboardCapture }
): BuildLeaderboardAcquisitionManifestInput {
  const { src, capture } = input
  const unavailableCapture = input.capturedFailure && capture.sourcePages.length === 0
  if (
    unavailableCapture &&
    (capture.parsePages.length !== 0 ||
      capture.parserTransformation.source_page_ordinals.length !== 0)
  ) {
    throw new TypeError('[tier-a] unavailable capture cannot contain parser pages')
  }
  if (
    input.capturedFailure &&
    !unavailableCapture &&
    capture.terminationReason !== 'upstream_error'
  ) {
    throw new TypeError('[tier-a] captured upstream evidence must terminate as upstream_error')
  }
  return {
    source: {
      id: src.id,
      slug: src.slug,
      adapter_slug: src.adapter_slug,
      configured_page_size: src.page_size,
      configured_pagination_kind: src.pagination_kind,
    },
    surface: 'tier_a_leaderboard',
    timeframe: input.timeframe,
    started_at: input.startedAt,
    completed_at: input.completedAt,
    runner_git_sha: input.runnerGitSha,
    observation_cycle_id: input.cycleId,
    capture_evidence_state: unavailableCapture ? 'unavailable' : 'verified',
    termination_reason: unavailableCapture ? 'unknown' : capture.terminationReason,
    capture_config: capture.captureConfig,
    source_pages: capture.sourcePages.map((sourcePage) => ({
      raw_page: sourcePage.rawPage,
      source_row_count: sourcePage.sourceRowCount,
      request_sha256: sourcePage.requestSha256,
      http_status: sourcePage.httpStatus,
      pagination_position: sourcePage.paginationPosition,
      source_reports: sourcePage.sourceReports,
    })),
    parse_pages: capture.parsePages,
    parser_transformation: capture.parserTransformation,
    accepted_population: input.acceptedPopulation,
    rejected_row_count: input.rejectedRowCount,
  }
}

function buildAttemptBoundCaptureManifest(
  input: CaptureManifestInput & {
    attempt: ClaimedLeaderboardAcquisitionAttempt
    configuredPartitionIds: readonly string[] | null
  }
) {
  const unavailableCapture = input.capturedFailure && input.capture.sourcePages.length === 0
  if (
    unavailableCapture &&
    (input.capture.parsePages.length !== 0 ||
      input.capture.parserTransformation.source_page_ordinals.length !== 0)
  ) {
    throw new TypeError('[tier-a] unavailable capture cannot contain parser pages')
  }
  if (
    input.capturedFailure &&
    !unavailableCapture &&
    input.capture.terminationReason !== 'upstream_error'
  ) {
    throw new TypeError('[tier-a] captured upstream evidence must terminate as upstream_error')
  }
  const acquisitionAttempt = {
    binding_contract: input.attempt.attemptBindingContract,
    attempt_id: input.attempt.attemptId,
    attempt_seq: input.attempt.attemptSeq,
  }
  if (input.attempt.captureContract === ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT) {
    if (isPartitionedNumericLeaderboardCapture(input.capture)) {
      throw new TypeError('[tier-a] attempt-bound v3 requires an identity capture')
    }
    return {
      kind: 'v3' as const,
      built: buildLeaderboardAcquisitionManifestV3({
        ...captureManifestInput({ ...input, capture: input.capture }),
        acquisition_attempt: acquisitionAttempt,
        ...(input.capture.completeness ? { completeness: input.capture.completeness } : {}),
      }),
    }
  }
  if (input.attempt.captureContract !== ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT) {
    throw new TypeError('[tier-a] attempt-bound capture contract is unsupported')
  }
  if (!isPartitionedNumericLeaderboardCapture(input.capture)) {
    throw new TypeError('[tier-a] attempt-bound v4 requires a partitioned numeric capture')
  }
  if (input.configuredPartitionIds === null) {
    throw new TypeError('[tier-a] attempt-bound v4 requires authoritative partition ids')
  }
  const expectedPartitionIds = input.capture.paginationTopology.expected_partition_ids
  if (
    expectedPartitionIds.length !== input.configuredPartitionIds.length ||
    expectedPartitionIds.some(
      (partitionId, index) => partitionId !== input.configuredPartitionIds![index]
    )
  ) {
    throw new TypeError(
      '[tier-a] captured partition topology does not match authoritative source configuration'
    )
  }
  const { expected_partition_ids: _capturedExpectedIds, ...paginationTopology } =
    input.capture.paginationTopology
  const manifestInput: BuildLeaderboardAcquisitionManifestV4Input = {
    source: {
      id: input.src.id,
      slug: input.src.slug,
      adapter_slug: input.src.adapter_slug,
      configured_page_size: input.src.page_size,
      configured_pagination_kind: input.src.pagination_kind,
      configured_partition_ids: [...input.configuredPartitionIds],
    },
    surface: 'tier_a_leaderboard',
    timeframe: input.timeframe,
    started_at: input.startedAt,
    completed_at: input.completedAt,
    runner_git_sha: input.runnerGitSha,
    observation_cycle_id: input.cycleId,
    capture_evidence_state:
      input.capturedFailure && input.capture.sourcePages.length === 0 ? 'unavailable' : 'verified',
    termination_reason:
      input.capturedFailure && input.capture.sourcePages.length === 0
        ? 'unknown'
        : input.capture.terminationReason,
    capture_config: input.capture.captureConfig,
    source_pages: input.capture.sourcePages.map((sourcePage) => ({
      raw_page: sourcePage.rawPage,
      source_row_count: sourcePage.sourceRowCount,
      request_sha256: sourcePage.requestSha256,
      http_status: sourcePage.httpStatus,
      pagination_position: sourcePage.paginationPosition,
      source_reports: sourcePage.sourceReports,
    })),
    parse_pages: input.capture.parsePages,
    parser_transformation: input.capture.parserTransformation,
    accepted_population: input.acceptedPopulation,
    rejected_row_count: input.rejectedRowCount,
    acquisition_attempt: acquisitionAttempt,
    pagination_topology: paginationTopology,
  }
  return { kind: 'v4' as const, built: buildLeaderboardAcquisitionManifestV4(manifestInput) }
}

export interface CapturedPageRankAnchor {
  sourcePageOrdinal: number
  rankBase: number
  sourceRowCount: number
}

function capturedIdentityPageRankAnchors(capture: LeaderboardCapture): CapturedPageRankAnchor[] {
  const ordinals = capture.parserTransformation.source_page_ordinals
  if (ordinals.length !== capture.parsePages.length) {
    throw new TypeError('[tier-a] parser pages require one source-page ordinal each')
  }

  let rankBase = 0
  return capture.parsePages.map((parsePage, pageOffset) => {
    const sourcePageOrdinal = ordinals[pageOffset]
    // Numeric capture stops at its first terminal/error page, so parser pages
    // must be the exact non-empty source prefix. Skips or reordering make rank
    // bases ambiguous and must never reach serving.
    if (sourcePageOrdinal !== pageOffset + 1) {
      throw new TypeError('[tier-a] captured parser pages must be a continuous source prefix')
    }
    const sourcePage = capture.sourcePages[sourcePageOrdinal - 1]
    // captureNumericLeaderboard hands the processor one in-memory graph, so
    // parser pages must be the exact RawPage objects retained in sourcePages.
    // A future deserialize/replay path needs canonical byte equality instead;
    // until then, cloned pages deliberately fail closed here.
    if (
      !sourcePage ||
      sourcePage.rawPage !== parsePage ||
      sourcePage.rawPage.pageIndex !== sourcePageOrdinal ||
      sourcePage.paginationPosition.kind !== 'page_index' ||
      sourcePage.paginationPosition.request_page_index !== sourcePageOrdinal
    ) {
      throw new TypeError('[tier-a] captured parser page is not bound to its source page')
    }
    if (
      !Number.isSafeInteger(sourcePage.sourceRowCount) ||
      Object.is(sourcePage.sourceRowCount, -0) ||
      sourcePage.sourceRowCount < 1
    ) {
      throw new TypeError('[tier-a] captured parser page must have a positive source row count')
    }

    const anchor = {
      sourcePageOrdinal,
      rankBase,
      sourceRowCount: sourcePage.sourceRowCount,
    }
    rankBase += sourcePage.sourceRowCount
    if (!Number.isSafeInteger(rankBase)) {
      throw new TypeError('[tier-a] captured rank base exceeds the safe integer range')
    }
    return anchor
  })
}

/**
 * Replay counterpart of capturedIdentityPageRankAnchors for a capture read
 * back from its stored RAW. There is no in-memory graph to compare by
 * reference, so every parser page must be canonically byte-equal to the
 * stored source page at its ordinal, and that stored page must carry the
 * payload hash, ordinal and page-index position the manifest recorded. Rank
 * bases come from the manifest's per-page source_row_count, under the same
 * continuous-prefix rule: skips, reordering, a missing or tampered page all
 * fail closed.
 */
export function replayedIdentityPageRankAnchors(input: {
  sourcePages: readonly RawPage[]
  parsePages: readonly RawPage[]
  manifest: Pick<LeaderboardAcquisitionManifestV3, 'source_pages' | 'parser_input'>
}): CapturedPageRankAnchor[] {
  const transformation = input.manifest.parser_input.transformation
  if (transformation.kind !== 'identity_projection') {
    throw new TypeError('[tier-a] replayed v3 parser pages require an identity projection')
  }
  const ordinals = transformation.source_page_ordinals
  if (
    ordinals.length !== input.parsePages.length ||
    input.manifest.parser_input.page_count !== input.parsePages.length ||
    input.manifest.source_pages.length !== input.sourcePages.length
  ) {
    throw new TypeError('[tier-a] replayed parser pages require one source-page ordinal each')
  }

  let rankBase = 0
  return input.parsePages.map((parsePage, pageOffset) => {
    const sourcePageOrdinal = ordinals[pageOffset]
    if (sourcePageOrdinal !== pageOffset + 1) {
      throw new TypeError('[tier-a] replayed parser pages must be a continuous source prefix')
    }
    const sourcePage = input.sourcePages[sourcePageOrdinal - 1]
    const recorded = input.manifest.source_pages[sourcePageOrdinal - 1]
    if (
      !sourcePage ||
      !recorded ||
      recorded.ordinal !== sourcePageOrdinal ||
      recorded.stored_page_index !== sourcePageOrdinal ||
      sourcePage.pageIndex !== sourcePageOrdinal ||
      recorded.pagination_position?.kind !== 'page_index' ||
      recorded.pagination_position.request_page_index !== sourcePageOrdinal ||
      strictCanonicalSha256(sourcePage.payload) !== recorded.payload.sha256 ||
      strictCanonicalJson(sourcePage) !== strictCanonicalJson(parsePage)
    ) {
      throw new TypeError('[tier-a] replayed parser page is not bound to its stored source page')
    }
    const sourceRowCount = recorded.source_row_count
    if (
      !Number.isSafeInteger(sourceRowCount) ||
      Object.is(sourceRowCount, -0) ||
      sourceRowCount < 1
    ) {
      throw new TypeError('[tier-a] replayed parser page must have a positive source row count')
    }
    const anchor = { sourcePageOrdinal, rankBase, sourceRowCount }
    rankBase += sourceRowCount
    if (!Number.isSafeInteger(rankBase)) {
      throw new TypeError('[tier-a] replayed rank base exceeds the safe integer range')
    }
    return anchor
  })
}

function assertDenseOrdinals(
  ordinals: readonly number[],
  expectedCount: number,
  label: string
): void {
  if (
    ordinals.length !== expectedCount ||
    ordinals.some((ordinal, index) => ordinal !== index + 1)
  ) {
    throw new TypeError(`[tier-a] ${label} must form one dense ordered cover`)
  }
}

function capturedPartitionedPageRankAnchors(
  capture: PartitionedNumericLeaderboardCapture,
  configuredPageSize: number | null
): CapturedPageRankAnchor[] {
  const topology = capture.paginationTopology
  const transformation = capture.parserTransformation
  if (
    transformation.algorithm_contract !== LEADERBOARD_PARTITIONED_NUMERIC_PARSER_PAGE_CONTRACT ||
    configuredPageSize === null ||
    !Number.isSafeInteger(configuredPageSize) ||
    Object.is(configuredPageSize, -0) ||
    configuredPageSize < 1
  ) {
    throw new TypeError(
      '[tier-a] partitioned parser projection requires its exact algorithm and page size'
    )
  }
  if (
    topology.expected_partition_ids.length !== topology.partitions.length ||
    topology.partitions.some(
      (partition, index) => partition.partition_id !== topology.expected_partition_ids[index]
    ) ||
    new Set(topology.expected_partition_ids).size !== topology.expected_partition_ids.length
  ) {
    throw new TypeError('[tier-a] captured partitions must exactly match expected ids and order')
  }
  if (
    transformation.source_page_ordinals.length !== capture.parsePages.length ||
    transformation.page_bindings.length !== capture.parsePages.length
  ) {
    throw new TypeError('[tier-a] partitioned parser pages require one exact binding each')
  }

  const topologySourceOrdinals = topology.partitions.flatMap(
    (partition) => partition.source_page_ordinals
  )
  const topologyParserOrdinals = topology.partitions.flatMap(
    (partition) => partition.parser_page_ordinals
  )
  assertDenseOrdinals(
    topologySourceOrdinals,
    capture.sourcePages.length,
    'partition source-page ordinals'
  )
  assertDenseOrdinals(
    topologyParserOrdinals,
    capture.parsePages.length,
    'partition parser-page ordinals'
  )

  const parserPartitionByOrdinal = new Map<
    number,
    { partitionId: string; partitionOrdinal: number }
  >()

  for (const [partitionIndex, partition] of topology.partitions.entries()) {
    for (const parserPageOrdinal of partition.parser_page_ordinals) {
      parserPartitionByOrdinal.set(parserPageOrdinal, {
        partitionId: partition.partition_id,
        partitionOrdinal: partitionIndex + 1,
      })
    }
    const positiveSourceOrdinals: number[] = []
    for (const [localPageIndex, sourcePageOrdinal] of partition.source_page_ordinals.entries()) {
      const sourcePage = capture.sourcePages[sourcePageOrdinal - 1]
      const position = sourcePage?.paginationPosition
      if (
        !sourcePage ||
        sourcePage.rawPage.pageIndex !== sourcePageOrdinal ||
        position?.kind !== 'partitioned_page_index' ||
        position.partition_ordinal !== partitionIndex + 1 ||
        position.partition_id !== partition.partition_id ||
        position.request_page_index !== localPageIndex + 1
      ) {
        throw new TypeError(
          '[tier-a] partition source pages must bind their exact ordered topology'
        )
      }
      if (
        !Number.isSafeInteger(sourcePage.sourceRowCount) ||
        Object.is(sourcePage.sourceRowCount, -0) ||
        sourcePage.sourceRowCount < 0
      ) {
        throw new TypeError('[tier-a] partition source row count must be non-negative')
      }
      if (sourcePage.sourceRowCount > 0) positiveSourceOrdinals.push(sourcePageOrdinal)
    }
    const boundSourceOrdinals = partition.parser_page_ordinals.map(
      (parserPageOrdinal) => transformation.source_page_ordinals[parserPageOrdinal - 1]
    )
    if (
      boundSourceOrdinals.length !== positiveSourceOrdinals.length ||
      boundSourceOrdinals.some(
        (sourcePageOrdinal, index) => sourcePageOrdinal !== positiveSourceOrdinals[index]
      )
    ) {
      throw new TypeError(
        '[tier-a] partition parser pages must exactly cover positive source pages'
      )
    }
  }

  let rankBase = 0
  return capture.parsePages.map((parsePage, pageOffset) => {
    const sourcePageOrdinal = transformation.source_page_ordinals[pageOffset]
    const binding = transformation.page_bindings[pageOffset]
    const sourcePage = capture.sourcePages[sourcePageOrdinal - 1]
    const position = sourcePage?.paginationPosition
    const topologyPartition = parserPartitionByOrdinal.get(pageOffset + 1)
    if (
      !sourcePage ||
      !binding ||
      !topologyPartition ||
      binding.source_page_ordinal !== sourcePageOrdinal ||
      position?.kind !== 'partitioned_page_index' ||
      binding.partition_ordinal !== topologyPartition.partitionOrdinal ||
      binding.partition_id !== topologyPartition.partitionId ||
      binding.partition_ordinal !== position.partition_ordinal ||
      binding.partition_id !== position.partition_id ||
      binding.request_page_index !== position.request_page_index ||
      binding.request_page_size !== configuredPageSize ||
      strictCanonicalJson(projectPartitionedNumericParserPage(sourcePage.rawPage, binding)) !==
        strictCanonicalJson(parsePage)
    ) {
      throw new TypeError(
        '[tier-a] partitioned parser projection is not canonically bound to its source page'
      )
    }
    if (
      !Number.isSafeInteger(sourcePage.sourceRowCount) ||
      Object.is(sourcePage.sourceRowCount, -0) ||
      sourcePage.sourceRowCount < 1
    ) {
      throw new TypeError('[tier-a] partitioned parser page must have a positive source row count')
    }
    const anchor = { sourcePageOrdinal, rankBase, sourceRowCount: sourcePage.sourceRowCount }
    rankBase += sourcePage.sourceRowCount
    if (!Number.isSafeInteger(rankBase)) {
      throw new TypeError('[tier-a] captured rank base exceeds the safe integer range')
    }
    return anchor
  })
}

function capturedPageRankAnchors(
  capture: AnyLeaderboardCapture,
  configuredPageSize: number | null
): CapturedPageRankAnchor[] {
  return isPartitionedNumericLeaderboardCapture(capture)
    ? capturedPartitionedPageRankAnchors(capture, configuredPageSize)
    : capturedIdentityPageRankAnchors(capture)
}

function parseLeaderboardRows(input: {
  adapter: SourceAdapter
  pages: readonly RawPage[]
  ctx: ParseCtx
  pageSize: number
  captureRankAnchors?: readonly CapturedPageRankAnchor[]
}): ParsedLeaderboardRow[] {
  if (input.captureRankAnchors && input.captureRankAnchors.length !== input.pages.length) {
    throw new TypeError('[tier-a] parser pages require one captured rank anchor each')
  }
  const rows: ParsedLeaderboardRow[] = []
  for (const [pageOffset, page] of input.pages.entries()) {
    const parsed = input.adapter.parseLeaderboard(page.payload, input.ctx)
    const anchor = input.captureRankAnchors?.[pageOffset]
    const pageLocalRanks = new Set<number>()
    for (const row of parsed.rows) {
      if (
        !Number.isSafeInteger(row.rank) ||
        Object.is(row.rank, -0) ||
        row.rank < 1 ||
        (anchor && row.rank > anchor.sourceRowCount)
      ) {
        throw new TypeError('[tier-a] page-local rank exceeds captured source rows')
      }
      if (anchor && pageLocalRanks.has(row.rank)) {
        throw new TypeError('[tier-a] page-local ranks must be unique within a captured page')
      }
      pageLocalRanks.add(row.rank)
      const anchoredRank = anchor
        ? anchor.rankBase + row.rank
        : (page.pageIndex - 1) * input.pageSize + row.rank
      if (!Number.isSafeInteger(anchoredRank) || anchoredRank < 1) {
        throw new TypeError('[tier-a] global leaderboard rank exceeds the safe integer range')
      }
      const sourcePageOrdinal = anchor?.sourcePageOrdinal
      const headlineMetricSources = row.headlineMetricSources
        ? Object.fromEntries(
            Object.entries(row.headlineMetricSources).map(([metric, source]) => {
              // Preserve every unknown adapter field so staging can reject it;
              // only the adapter-claimed page ordinal is stripped/replaced.
              const sourceWithoutAdapterOrdinal = { ...source }
              delete sourceWithoutAdapterOrdinal.sourcePageOrdinal
              return [
                metric,
                {
                  ...sourceWithoutAdapterOrdinal,
                  ...(sourcePageOrdinal === undefined ? {} : { sourcePageOrdinal }),
                },
              ]
            })
          )
        : undefined
      rows.push({
        ...row,
        rank: anchoredRank,
        ...(headlineMetricSources ? { headlineMetricSources } : {}),
      })
    }
  }
  return rows
}

function parseLeaderboardSeriesWindow(input: {
  adapter: SourceAdapter
  pages: readonly RawPage[]
  ctx: ParseCtx
  timeframe: RankingTimeframe
}): Map<string, BoardSeriesBlock[]> {
  const boardSeries = new Map<string, BoardSeriesBlock[]>()
  if (!input.adapter.parseLeaderboardSeries) return boardSeries

  for (const page of input.pages) {
    const pageSeries = input.adapter.parseLeaderboardSeries(
      page.payload,
      input.ctx,
      input.timeframe
    )
    for (const [traderId, blocks] of pageSeries) {
      if (blocks.some((block) => block.timeframe !== input.timeframe)) {
        throw new TypeError('[tier-a] board series block crossed its snapshot timeframe')
      }
      const existing = boardSeries.get(traderId)
      if (existing) existing.push(...blocks)
      else boardSeries.set(traderId, blocks)
    }
  }
  return boardSeries
}

async function persistUnprocessedCaptureRaw(input: {
  src: SourceRow
  timeframe: RankingTimeframe
  cycleId: string | null
  startedAt: string
  completedAt: string
  capture: AnyLeaderboardCapture
  priorFailures: readonly unknown[]
  attempt: ClaimedLeaderboardAcquisitionAttempt
  runTransaction: IngestTransactionRunner
}): Promise<RawObjectReceipt> {
  const captureEvidence = {
    mode: isPartitionedNumericLeaderboardCapture(input.capture)
      ? ('partitioned_numeric' as const)
      : ('identity' as const),
    capture_config: input.capture.captureConfig,
    parser_transformation: input.capture.parserTransformation,
    source_pages: input.capture.sourcePages.map((sourcePage, index) => ({
      ordinal: index + 1,
      stored_page_index: sourcePage.rawPage.pageIndex,
      url: sourcePage.rawPage.url,
      fetched_at: sourcePage.rawPage.fetchedAt,
      payload_sha256: strictCanonicalSha256(sourcePage.rawPage.payload),
      source_row_count: sourcePage.sourceRowCount,
      request_sha256: sourcePage.requestSha256,
      http_status: sourcePage.httpStatus,
      pagination_position: sourcePage.paginationPosition,
      source_reports: sourcePage.sourceReports,
    })),
    ...(isPartitionedNumericLeaderboardCapture(input.capture)
      ? { pagination_topology: input.capture.paginationTopology }
      : {}),
  }
  try {
    return await writeRawObject(
      {
        sourceId: input.src.id,
        sourceSlug: input.src.slug,
        jobType: 'tier_a_failure',
        timeframe: input.timeframe,
        payload: input.capture.sourcePages.map((sourcePage) => sourcePage.rawPage),
        serialization: STRICT_CANONICAL_JSON_CONTRACT,
        meta: {
          pageCount: input.capture.sourcePages.length,
          ...(input.cycleId ? { observation_cycle_id: input.cycleId } : {}),
          acquisition_attempt: {
            binding_contract: input.attempt.attemptBindingContract,
            attempt_id: input.attempt.attemptId,
            attempt_seq: input.attempt.attemptSeq,
            capture_contract: input.attempt.captureContract,
            runner_git_sha: input.attempt.runnerGitSha,
            capture_started_at: input.attempt.recordedStartedAt,
            capture_completed_at: input.completedAt,
          },
          trust_evidence: {
            state: 'unknown',
            rank_eligible: false,
            failure_stage: 'parse_validate_or_manifest',
            termination_reason: input.capture.terminationReason,
            capture_started_at: input.startedAt,
            capture_completed_at: input.completedAt,
          },
          capture_evidence: captureEvidence,
        },
      },
      input.runTransaction
    )
  } catch (persistenceCause) {
    throw new TierAEvidencePersistenceError(
      input.src.slug,
      input.timeframe,
      input.priorFailures,
      persistenceCause
    )
  }
}

export async function processTierA(
  job: Job<TierJobData>,
  context: AuthorizedConsumedRegionContext,
  provenance: SourceJobRunProvenance,
  signal?: AbortSignal
): Promise<TierAResult[]> {
  throwIfTierACancelled(signal)
  const src = await getSourceBySlug(job.data.sourceSlug)
  throwIfTierACancelled(signal)
  assertSourceMatchesConsumedRegion(src, context)
  if (src.status !== 'active') {
    console.log(`[tier-a] ${src.slug} is ${src.status} — skipping`)
    return []
  }

  const timeframes = nativeRankingTimeframes(src)
  const adapter = getAdapter(src.adapter_slug)
  const cycleId = observationCycleId(job, 'tier-a', src.slug)
  const desiredCaptureContract: AttemptBoundLeaderboardAcquisitionContract =
    adapter.leaderboardAcquisitionContract ?? ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT
  // Public publication requires attempt-bound trust evidence, so there is no
  // count-check-only path: an adapter without a capture implementation or a
  // source without its exact registry contract fails before any session.
  if (!adapter.captureLeaderboard) {
    throw new Error(
      `[tier-a] ${src.slug} adapter has no attempt-bound capture implementation; Tier-A publication requires attempt-bound evidence`
    )
  }
  // Registry selection is exact and happens before any upstream session. A
  // V4 adapter can never borrow a V3 registration.
  const registeredCaptureContract = await findRegisteredAttemptBoundLeaderboardAcquisitionContract({
    sourceId: src.id,
    adapterSlug: src.adapter_slug,
    captureContract: desiredCaptureContract,
  })
  throwIfTierACancelled(signal)
  if (registeredCaptureContract === null) {
    throw new Error(
      `[tier-a] ${src.slug} ${
        desiredCaptureContract === ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT ? 'v4' : 'v3'
      } capture contract is not exactly registered`
    )
  }
  if (registeredCaptureContract !== desiredCaptureContract) {
    throw new Error(`[tier-a] ${src.slug} registry returned a conflicting capture contract`)
  }
  const attemptBoundCycleId = canonicalAttemptObservationCycleId(cycleId, src.slug)
  const workerRegion = context.executionRegion
  const partitionIdsByTimeframe = new Map<RankingTimeframe, readonly string[]>()
  let runnerGitSha: string | null = null

  throwIfTierACancelled(signal)
  const execution = await claimSourceJobExecutionAuthority({
    context,
    provenance,
    sourceId: src.id,
    ...(signal ? { signal } : {}),
  })
  const executionSignal = execution.signal
  const executionBinding: LeaderboardAcquisitionExecutionBinding = Object.freeze({
    claimId: execution.proof.claimId,
    generationSeq: execution.proof.generationSeq,
    sourceId: src.id,
  })
  const runClaimedTransaction: IngestTransactionRunner = (operation) =>
    execution.withClaimedWrite((transaction) => operation(transaction))

  const results: TierAResult[] = []
  const failures: Array<{ timeframe: number; error: Error }> = []
  const completedTimeframes = new Set<RankingTimeframe>()
  let terminalFailure: { error: unknown } | null = null
  let sessionCloseFailure: Error | null = null
  let persistedJobData: TierJobData = { ...job.data }
  let pendingTimeframes: RankingTimeframe[] = []
  // The session opens lazily only after the first pending window has a
  // durable attempt, so session-open failure is itself terminal evidence.
  let session: Awaited<ReturnType<typeof openSession>> | null = null
  let sessionClosePromise: Promise<void> | null = null
  const closeSession = (): Promise<void> => {
    if (session === null) return Promise.resolve()
    sessionClosePromise ??= Promise.resolve().then(() => session!.close())
    return sessionClosePromise
  }
  const closeSessionOnAbort = () => {
    void closeSession().catch(() => undefined)
  }
  executionSignal.addEventListener('abort', closeSessionOnAbort, { once: true })

  type RecordWindowReceipt = typeof recordTierAExecutionWindowReceipt
  // Everything after a window's capture evidence is durable and terminal:
  // trust gate, metric-trust check, fenced publication, count check, board
  // series and the durable window receipt. Shared by the capture path and the
  // republish path (which replays an earlier attempt's recorded RAW), so both
  // publish under exactly the same gates; only the receipt RPC differs.
  const publishGatedWindowEvidence = async (window: {
    timeframe: RankingTimeframe
    attemptId: string
    pages: readonly RawPage[]
    ctx: ParseCtx
    valid: ParsedLeaderboardRow[]
    rejects: ReturnType<typeof validateLeaderboardRows>['rejects']
    projection: LeaderboardManifestOutcomeProjection
    evidence:
      | { kind: 'v3'; bundle: LeaderboardMetricTrustBundle }
      | { kind: 'v4'; bundle: LeaderboardAttemptBoundV4Bundle }
    rawObjectId: number
    recordReceipt: RecordWindowReceipt
    markTerminalSideEffect: (sideEffect: 'receipt' | null) => void
  }): Promise<TierAResult> => {
    const { timeframe, attemptId, pages, ctx, valid, rejects, projection, evidence, rawObjectId } =
      window
    if (projection.terminalState !== 'complete' && !projection.exhaustionVerified) {
      throw new Error(
        `acquisition trust gate FAILED: acquisition=` +
          `${projection.acquisitionState}, population=` +
          `${projection.populationState}, source_run=` +
          `${projection.sourceRunId}`
      )
    }

    // Series are additive serving material, not population evidence.
    // Parse them only after the capture pair passed its trust gate so a
    // series-specific bug cannot erase an otherwise truthful manifest.
    const boardSeries = parseLeaderboardSeriesWindow({ adapter, pages, ctx, timeframe })

    if (evidence.kind === 'v3' && !hasRegisteredLeaderboardMetricTrust(src, timeframe)) {
      throw new Error(
        `[tier-a] ${src.slug} ${timeframe}d attempt-bound capture has no reviewed metric trust contract`
      )
    }
    const receiptSourceRunId = evidence.bundle.sourceRunId
    const result =
      evidence.kind === 'v4'
        ? await publishClaimedAttemptBoundLeaderboardSnapshot(
            {
              src,
              timeframe,
              rows: valid,
              rejects,
              observationCycleId: attemptBoundCycleId,
              attemptEvidence: evidence.bundle,
            },
            context,
            execution,
            executionSignal
          )
        : await publishClaimedTrustedLeaderboardSnapshot(
            {
              src,
              timeframe,
              rows: valid,
              rejects,
              observationCycleId: cycleId ?? undefined,
              trust: evidence.bundle,
            },
            context,
            execution,
            executionSignal
          )
    throwIfTierACancelled(executionSignal)

    const status = result.published ? 'PUBLISHED' : 'GATED'
    console.log(
      `[tier-a] ${src.slug} ${timeframe}d: ${valid.length} rows ` +
        `(${rejects.length} rejected, baseline=${result.verdict.baselineUsed}, ` +
        `deviation=${result.verdict.deviationPct?.toFixed(1) ?? '–'}%) → ${status}`
    )
    if (result.published) {
      // Output watermark next to the heartbeat (audit P2-8): proves this
      // node is publishing, not just alive. Best-effort, never throws.
      noteTierAPublished()
    }
    if (!result.published) {
      // Keep this window out of serving, but do not sacrifice the other
      // native windows. The aggregate error after the loop still fails the
      // BullMQ job for retry and operator visibility.
      throw new TierACountCheckGatedError(
        `count check FAILED: actual=${valid.length} ` +
          `baseline=${result.verdict.baselineUsed} — snapshot ${result.snapshotId} ` +
          `recorded, serving keeps last good`
      )
    }

    // Board-level free series (spec §13.1): every ranked trader gets a
    // chart with no extra fetch — closes the long-tail series gap that
    // otherwise waits on Tier-B topN / on-demand Tier-C.
    if (boardSeries.size > 0) {
      const seriesOut = await publishClaimedBoardSeries(
        src,
        boardSeries,
        result.traderIds,
        context,
        execution,
        {
          expectedLatestSnapshots: new Map([
            [
              timeframe,
              {
                id: result.snapshotId,
                rawObjectId,
                scrapedAt: new Date(result.scrapedAt).toISOString(),
              },
            ],
          ]),
        },
        executionSignal
      )
      throwIfTierACancelled(executionSignal)
      console.log(
        `[tier-a] ${src.slug} ${timeframe}d board series: ` +
          `${seriesOut.points} pts for ${seriesOut.traders} traders`
      )
    }

    // (compat→trader_latest write removed 2026-06-15) The score chain now runs
    // on arena directly (compute-leaderboard reads arena_score_inputs, not
    // trader_latest), so the compat bridge is orphaned and trader_latest is
    // being dropped. publish() above already wrote arena.* — the canonical source.

    // The database receipt, not Redis job.data, is the sole retry skip
    // authority. It is committed only after snapshot and optional series.
    window.markTerminalSideEffect('receipt')
    await execution.withClaimedWrite((transaction) =>
      withTierAExecutionReceiptWriter(
        transaction,
        {
          claimId: execution.proof.claimId,
          generationSeq: execution.proof.generationSeq,
          queueJobId: execution.proof.queueJobId,
          queueName: execution.proof.queueName,
          sourceId: src.id,
        },
        (writer) =>
          window.recordReceipt(writer, {
            attemptId,
            observationCycleId: attemptBoundCycleId,
            rawObjectId,
            snapshotId: result.snapshotId,
            sourceRunId: receiptSourceRunId,
            timeframe,
          })
      )
    )
    throwIfTierACancelled(executionSignal)
    window.markTerminalSideEffect(null)

    completedTimeframes.add(timeframe)
    persistedJobData = await replaceCompletedTimeframeCache({
      provenance,
      execution,
      persistedJobData,
      completedTimeframes,
      nativeTimeframes: timeframes,
      sourceSlug: src.slug,
      timeframe,
    })
    throwIfTierACancelled(executionSignal)

    return {
      timeframe,
      actualCount: valid.length,
      rejects: rejects.length,
      passed: result.verdict.passed,
      baselineUsed: result.verdict.baselineUsed,
      snapshotId: result.snapshotId,
    }
  }

  type WindowRepublish =
    | { kind: 'rescan' }
    | { kind: 'republished'; result: TierAResult }
    | { kind: 'failed'; error: Error }
  const logRepublishSkipped = (
    reason: TierAWindowRepublishSkipReason,
    timeframe: RankingTimeframe,
    attemptSeq: number,
    detail?: unknown
  ): void => {
    console.warn(
      `[tier-a] republish skipped reason=${reason} source=${src.slug} tf=${timeframe}d ` +
        `attempt_seq=${attemptSeq}` +
        (detail === undefined ? '' : ` detail=${JSON.stringify(asError(detail).message)}`)
    )
  }

  /**
   * Retry fast path: when an earlier queue attempt of this job already
   * captured this window, persisted its RAW pair and a publishable terminal
   * outcome, and failed only while publishing, re-publish that recorded
   * capture instead of rescanning the board (bybit_mt5 7D: 2,047 pages,
   * 107 min per scan). The stored RAW is read back, every page and the
   * manifest are re-verified byte-for-byte, the rows are re-parsed with the
   * original context, and the manifest is rebuilt and must be identical
   * before the shared gated publication runs. The receipt goes through
   * arena.record_tier_a_execution_window_republish_receipt, which re-proves
   * the cross-claim lineage. Only v3 identity captures are replayed.
   *
   * Any check failing before publication logs one `republish skipped` line
   * and returns `rescan`, so the ordinary capture path runs unchanged. Once
   * publication has started, an execution-authority failure is rethrown
   * (job fails). Note that on the claimed-write path a fence failure of the
   * transaction itself (write deadline, commit aborted/unknown, lease
   * deadline) is converted by SourceJobExecutionAuthority.withClaimedWrite
   * into region_lost and revokes the execution, so the whole job fails there.
   * The remaining errors are split in two. A transient failure
   * (deadline, timeout, connection, lock, serialization;
   * reason=publish_failed) fails this window like the ordinary path would and
   * does NOT rescan in the same job attempt: a failed republish followed by a
   * 107-minute rescan could exceed the job's lock/timeout budget, and the
   * next BullMQ retry can republish again (the capture is still the window's
   * latest attempt). A deterministic one (stale, count_check_gated,
   * publish_rejected; unknown errors count as deterministic) would fail the
   * same way on every retry, so it rescans now. This classification was
   * chosen over a per-attempt republish-failure counter: it needs no new
   * durable state, and a repeatedly transient failure is bounded by the
   * job's own attempt limit, exactly as it was for the rescan.
   */
  const republishRecordedWindow = async (timeframe: RankingTimeframe): Promise<WindowRepublish> => {
    // Only pending windows reach here, so the window has no durable receipt
    // for this job yet. Queue attempt 0 has no earlier attempt to reuse.
    if (execution.proof.queueAttempt < 1) return { kind: 'rescan' }
    let latest: Awaited<ReturnType<typeof findLatestTierAWindowAttempt>>
    try {
      latest = await execution.withClaimedWrite((transaction) =>
        findLatestTierAWindowAttempt(transaction, { sourceId: src.id, timeframe })
      )
    } catch (cause) {
      // Authority loss stays terminal and sticky; a lookup defect must never
      // block the ordinary capture path.
      execution.assertActive()
      console.warn(
        `[tier-a] republish lookup failed source=${src.slug} tf=${timeframe}d: ` +
          asError(cause).message
      )
      return { kind: 'rescan' }
    }
    throwIfTierACancelled(executionSignal)
    const classification = classifyTierAWindowRepublishCandidate(latest, {
      sourceId: src.id,
      timeframe,
      observationCycleId: attemptBoundCycleId,
      queueJobId: execution.proof.queueJobId,
      queueAttempt: execution.proof.queueAttempt,
      claimId: execution.proof.claimId,
      generationSeq: execution.proof.generationSeq,
      gitSha: execution.proof.gitSha,
      maxFreshnessMs: registeredLeaderboardMetricMaxFreshnessMs(src, timeframe),
    })
    if (classification.kind === 'none') return { kind: 'rescan' }
    if (classification.kind === 'skip') {
      logRepublishSkipped(classification.reason, timeframe, classification.attemptSeq)
      return { kind: 'rescan' }
    }
    const { attempt, outcome } = classification
    const skip = (reason: TierAWindowRepublishSkipReason, detail?: unknown): WindowRepublish => {
      logRepublishSkipped(reason, timeframe, attempt.attemptSeq, detail)
      return { kind: 'rescan' }
    }

    // Probe first: without the receipt RPC a published snapshot could be
    // left without its window receipt.
    let receiptRpcPresent = false
    try {
      receiptRpcPresent = await execution.withClaimedWrite((transaction) =>
        hasTierAExecutionWindowRepublishReceipt(transaction)
      )
    } catch (cause) {
      execution.assertActive()
      return skip('receipt_rpc_unavailable', cause)
    }
    throwIfTierACancelled(executionSignal)
    if (!receiptRpcPresent) return skip('receipt_rpc_unavailable')

    const startedAtMs = Date.now()
    const readTrustRaw = async (
      role: 'source_payload' | 'population_manifest',
      receipt: RawObjectReceipt
    ): Promise<{ ok: true; payload: unknown } | { ok: false; skipped: WindowRepublish }> => {
      try {
        const payload = await readAttemptBoundLeaderboardTrustRawPayload(
          {
            rawObjectId: receipt.id,
            role,
            expectedSourceId: src.id,
            expectedTimeframe: timeframe,
            expectedSourceRunId: outcome.sourceRunId,
            expectedContentHash: receipt.contentHash,
            expectedStoragePath: receipt.storagePath,
          },
          runClaimedTransaction
        )
        throwIfTierACancelled(executionSignal)
        return { ok: true, payload }
      } catch (cause) {
        throwIfTierACancelled(executionSignal)
        execution.assertActive()
        const hashMismatch =
          cause instanceof LeaderboardTrustRawReadError && cause.failure === 'hash_mismatch'
        return {
          ok: false,
          skipped: skip(hashMismatch ? 'raw_hash_mismatch' : 'raw_unreadable', cause),
        }
      }
    }

    // 1. The manifest RAW: strict v3, canonically hashing to the outcome's
    //    source run, and bound to this durable attempt.
    if (outcome.populationManifest.contentHash !== outcome.sourceRunId) {
      return skip('manifest_mismatch')
    }
    const manifestRead = await readTrustRaw('population_manifest', outcome.populationManifest)
    if (!manifestRead.ok) return manifestRead.skipped
    let storedManifest: LeaderboardAcquisitionManifestV3
    try {
      storedManifest = parseLeaderboardAcquisitionManifestV3(manifestRead.payload)
    } catch (cause) {
      return skip('manifest_mismatch', cause)
    }
    if (
      strictCanonicalSha256(storedManifest) !== outcome.sourceRunId ||
      storedManifest.acquisition_attempt.binding_contract !== attempt.attemptBindingContract ||
      storedManifest.acquisition_attempt.attempt_id !== attempt.attemptId ||
      storedManifest.acquisition_attempt.attempt_seq !== attempt.attemptSeq ||
      storedManifest.runner_git_sha !== attempt.runnerGitSha ||
      storedManifest.started_at !== attempt.recordedStartedAt ||
      storedManifest.started_at !== outcome.captureStartedAt ||
      storedManifest.completed_at !== outcome.captureCompletedAt ||
      storedManifest.observation_cycle_id !== attempt.observationCycleId ||
      storedManifest.source.id !== src.id ||
      storedManifest.source.slug !== src.slug ||
      storedManifest.source.adapter_slug !== src.adapter_slug ||
      storedManifest.timeframe !== timeframe ||
      storedManifest.parser_input.transformation.kind !== 'identity_projection'
    ) {
      return skip('manifest_mismatch')
    }

    // 2. The source payload RAW: exactly the recorded pages, each hashing to
    //    its manifest entry.
    const sourceRead = await readTrustRaw('source_payload', outcome.sourcePayload)
    if (!sourceRead.ok) return sourceRead.skipped
    const storedPages = sourceRead.payload
    if (
      !Array.isArray(storedPages) ||
      storedPages.length !== storedManifest.source_pages.length ||
      storedPages.some((page: unknown, index) => {
        const recorded = storedManifest.source_pages[index]
        if (page === null || typeof page !== 'object' || Array.isArray(page)) return true
        const candidate = page as RawPage
        return (
          strictCanonicalJson(candidate) !==
            strictCanonicalJson({
              pageIndex: recorded.stored_page_index,
              payload: candidate.payload,
              url: recorded.url,
              fetchedAt: recorded.fetched_at,
            }) || strictCanonicalSha256(candidate.payload) !== recorded.payload.sha256
        )
      })
    ) {
      return skip('page_hash_mismatch')
    }
    const sourcePages = storedPages as RawPage[]

    // 3. Parser pages and rank anchors under canonical byte equality.
    const parsePages = storedManifest.parser_input.transformation.source_page_ordinals.map(
      (ordinal) => sourcePages[ordinal - 1]
    )
    let captureRankAnchors: CapturedPageRankAnchor[]
    try {
      if (parsePages.some((page) => page === undefined)) {
        throw new TypeError('[tier-a] replayed parser page ordinal is out of range')
      }
      captureRankAnchors = replayedIdentityPageRankAnchors({
        sourcePages,
        parsePages,
        manifest: storedManifest,
      })
    } catch (cause) {
      return skip('manifest_mismatch', cause)
    }

    // 4. Re-parse exactly as the capture path did (scrapedAt = attempt start).
    const ctx: ParseCtx = {
      sourceSlug: src.slug,
      currency: src.currency,
      tfLabelMap: src.tf_label_map,
      scrapedAt: attempt.recordedStartedAt,
      meta: src.meta,
    }
    const requiredFields = ((src.meta.required_fields as string[]) ?? []) as Array<
      keyof ParsedLeaderboardRow
    >
    let valid: ParsedLeaderboardRow[]
    let rejects: ReturnType<typeof validateLeaderboardRows>['rejects']
    try {
      const rows = parseLeaderboardRows({
        adapter,
        pages: parsePages,
        ctx,
        pageSize: src.page_size ?? 100,
        captureRankAnchors,
      })
      const annotateIdentityMerge = adapter.leaderboardIdentityMerge?.(src) ?? null
      const validated = validateLeaderboardRows(
        rows,
        requiredFields,
        annotateIdentityMerge ? { annotateIdentityMerge } : {}
      )
      adapter.validateLeaderboard?.(
        {
          parsedRows: rows,
          validRows: validated.valid,
          rejectedRowCount: validated.rejects.length,
        },
        src,
        timeframe,
        { purpose: 'publication' }
      )
      valid = validated.valid
      rejects = validated.rejects
    } catch (cause) {
      return skip('parse_mismatch', cause)
    }
    if (
      valid.length !== storedManifest.population.accepted_population ||
      rejects.length !== storedManifest.population.rejected_row_count ||
      outcome.acceptedPopulation !== valid.length ||
      outcome.rejectedRowCount !== rejects.length
    ) {
      return skip('parse_mismatch')
    }

    // 5. Rebuild the manifest from the stored pages and fresh counts; it must
    //    be byte-identical to the recorded one, and its projection must be
    //    the recorded terminal outcome.
    let rebuilt: BuiltLeaderboardAcquisitionManifestV3
    let projection: LeaderboardManifestOutcomeProjection
    try {
      const capture: LeaderboardCapture = {
        sourcePages: sourcePages.map((rawPage, index) => {
          const recorded = storedManifest.source_pages[index]
          if (
            recorded.request_sha256 === null ||
            recorded.http_status === null ||
            recorded.source_reports === null ||
            recorded.pagination_position?.kind !== 'page_index'
          ) {
            throw new TypeError('[tier-a] replayed v3 source page lacks captured response metadata')
          }
          return {
            rawPage,
            sourceRowCount: recorded.source_row_count,
            requestSha256: recorded.request_sha256,
            httpStatus: recorded.http_status,
            paginationPosition: recorded.pagination_position,
            sourceReports: recorded.source_reports,
          }
        }),
        parsePages,
        terminationReason:
          storedManifest.termination_reason as LeaderboardCapture['terminationReason'],
        captureConfig: storedManifest.capture_config,
        parserTransformation: {
          kind: 'identity_projection',
          source_page_ordinals: [
            ...storedManifest.parser_input.transformation.source_page_ordinals,
          ],
        },
        ...(storedManifest.completeness ? { completeness: storedManifest.completeness } : {}),
      }
      const built = buildAttemptBoundCaptureManifest({
        src,
        timeframe,
        startedAt: attempt.recordedStartedAt,
        completedAt: outcome.captureCompletedAt,
        runnerGitSha: attempt.runnerGitSha,
        cycleId,
        capture,
        capturedFailure: false,
        acceptedPopulation: valid.length,
        rejectedRowCount: rejects.length,
        attempt,
        configuredPartitionIds: null,
      })
      if (built.kind !== 'v3') throw new TypeError('[tier-a] replay rebuilt a non-v3 manifest')
      rebuilt = built.built
      projection = projectLeaderboardManifestV3Outcome(attempt, rebuilt)
    } catch (cause) {
      return skip('manifest_mismatch', cause)
    }
    if (
      rebuilt.sourceRunId !== outcome.sourceRunId ||
      rebuilt.canonicalJson !== strictCanonicalJson(storedManifest) ||
      projection.terminalState !== outcome.terminalState ||
      projection.acquisitionState !== outcome.acquisitionState ||
      projection.populationState !== outcome.populationState ||
      projection.reasonCode !== outcome.reasonCode ||
      projection.captureEvidenceState !== outcome.captureEvidenceState ||
      projection.terminationReason !== outcome.terminationReason ||
      projection.sourcePageCount !== outcome.sourcePageCount ||
      projection.observedPopulation !== outcome.observedPopulation ||
      projection.deduplicatedRowCount !== outcome.deduplicatedRowCount ||
      projection.reportedPopulation !== outcome.reportedPopulation ||
      projection.populationReportState !== outcome.populationReportState ||
      projection.reportedPageCount !== outcome.reportedPageCount ||
      projection.pageCountReportState !== outcome.pageCountReportState ||
      projection.callerLimited !== outcome.callerLimited ||
      projection.safetyLimited !== outcome.safetyLimited ||
      (projection.terminalState !== 'complete' && !projection.exhaustionVerified)
    ) {
      return skip('manifest_mismatch')
    }
    throwIfTierACancelled(executionSignal)

    // 6. The same gated publication as the capture path; only the receipt
    //    RPC differs. From here on a failure fails the window (see above).
    let terminalSideEffect: 'receipt' | null = null
    try {
      const result = await publishGatedWindowEvidence({
        timeframe,
        attemptId: attempt.attemptId,
        pages: parsePages,
        ctx,
        valid,
        rejects,
        projection,
        evidence: {
          kind: 'v3',
          bundle: {
            sourceRunId: rebuilt.sourceRunId,
            manifest: rebuilt.manifest,
            artifacts: {
              sourcePayload: outcome.sourcePayload,
              populationManifest: outcome.populationManifest,
            },
          },
        },
        rawObjectId: outcome.sourcePayload.id,
        recordReceipt: recordTierAExecutionWindowRepublishReceipt,
        markTerminalSideEffect: (sideEffect) => {
          terminalSideEffect = sideEffect
        },
      })
      console.log(
        `[tier-a] republished source=${src.slug} tf=${timeframe}d ` +
          `attempt_seq=${attempt.attemptSeq} rows=${valid.length} ms=${Date.now() - startedAtMs}`
      )
      return { kind: 'republished', result }
    } catch (cause) {
      if (cause instanceof TierACheckpointPersistenceError) throw cause
      if (executionSignal.aborted) {
        const abortReason = executionSignal.reason
        if (cause === abortReason) throw cause
        throw new AggregateError(
          [asError(cause), asError(abortReason)],
          `[tier-a] ${src.slug} ${timeframe}d republish failed while execution authority was revoked`
        )
      }
      // As in the capture path: a receipt-stage or receipt-contract failure
      // follows a published snapshot, leaves an ambiguous terminal side
      // effect and fails the job. The next retry republishes the same
      // capture: publication reconciles it to the already-committed,
      // byte-bound snapshot of this source run (reconcileLeaderboardMetricTrust
      // in lib/ingest/serving/publish.ts) instead of writing a second one, and
      // then records the missing republish receipt. Nothing is rescanned.
      if (cause instanceof TierAExecutionWindowReceiptError || terminalSideEffect !== null) {
        logRepublishSkipped(
          cause instanceof TierAExecutionWindowReceiptError && cause.code === 'undefined_function'
            ? 'receipt_rpc_unavailable'
            : 'publish_failed',
          timeframe,
          attempt.attemptSeq,
          cause
        )
        throw cause
      }
      // Order matters: authority loss is decided before any rescan or window
      // failure. A revoked execution was already rethrown above (signal);
      // an authority-class fence or execution error (commit outcome unknown,
      // fenced, region_lost, closed, ...) found anywhere in the cause chain is
      // rethrown here even if the signal has not observed it yet, and
      // assertActive() below surfaces an ownership loss nothing reported.
      const errorClass = classifyRepublishPublicationError(cause)
      if (errorClass === 'authority') {
        logRepublishSkipped('publish_failed', timeframe, attempt.attemptSeq, cause)
        throw cause
      }
      execution.assertActive()
      // Failures that the same recorded capture would hit again on every
      // retry fall back to the rescan now; nothing of this replay is left
      // published (the snapshot transaction rolled back, or the snapshot is
      // GATED and out of serving, or the optional series alone failed):
      // - stale: a newer snapshot of a different capture already serves the
      //   window (the same capture's own committed snapshot is reconciled and
      //   reused instead, never reported stale);
      // - count_check_gated: within one cycle the baseline does not move;
      // - publish_rejected: every other non-transient error, unknown ones
      //   included (identity conflict, a no-longer-holding exhaustion proof,
      //   a missing metric contract...). Rescanning once too often is cheaper
      //   than republishing a doomed capture until the job's attempts run out.
      // Only a transient failure (deadline, timeout, connection, lock,
      // serialization, a transient worker-fence code such as 11-27's
      // write_deadline_exceeded) keeps the no-rescan rule: the window fails
      // and the next BullMQ retry republishes again.
      const deterministicReason: TierAWindowRepublishSkipReason | null =
        cause instanceof StaleLeaderboardPublicationError
          ? 'stale'
          : cause instanceof TierACountCheckGatedError
            ? 'count_check_gated'
            : errorClass === 'transient'
              ? null
              : 'publish_rejected'
      if (deterministicReason !== null) {
        logRepublishSkipped(deterministicReason, timeframe, attempt.attemptSeq, cause)
        return { kind: 'rescan' }
      }
      logRepublishSkipped('publish_failed', timeframe, attempt.attemptSeq, cause)
      const detail = asError(cause).message
      const error = new Error(`[tier-a] ${src.slug} ${timeframe}d failed: ${detail}`, { cause })
      console.error(error.message)
      return { kind: 'failed', error }
    }
  }

  try {
    await execution.withClaimedWrite(async (transaction) => {
      for (const timeframe of timeframes) {
        const receipt = await getTierAExecutionWindowReceipt(transaction, {
          sourceId: src.id,
          queueName: execution.proof.queueName,
          queueJobId: execution.proof.queueJobId,
          observationCycleId: attemptBoundCycleId,
          timeframe,
        })
        if (receipt !== null) completedTimeframes.add(timeframe)
      }
    })
    throwIfTierACancelled(executionSignal)

    // Redis is only a repairable cache of the database receipt set.
    persistedJobData = await replaceCompletedTimeframeCache({
      provenance,
      execution,
      persistedJobData,
      completedTimeframes,
      nativeTimeframes: timeframes,
      sourceSlug: src.slug,
      timeframe: null,
    })
    throwIfTierACancelled(executionSignal)
    pendingTimeframes = timeframes.filter((timeframe) => !completedTimeframes.has(timeframe))
    if (completedTimeframes.size > 0) {
      console.log(
        `[tier-a] ${src.slug}: durable receipts skip completed windows ` +
          [...completedTimeframes].map((timeframe) => `${timeframe}d`).join(', ')
      )
    }

    // A completed durable receipt needs no browser or adapter preparation.
    // For pending claimed captures, the DB-attested execution SHA is the
    // manifest/attempt runner identity; it cannot drift from the claim.
    if (pendingTimeframes.length > 0) {
      runnerGitSha = execution.proof.gitSha
      if (desiredCaptureContract === ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT) {
        for (const timeframe of pendingTimeframes) {
          partitionIdsByTimeframe.set(timeframe, authoritativePartitionIds(adapter, src, timeframe))
        }
      }
    }

    for (const timeframe of pendingTimeframes) {
      throwIfTierACancelled(executionSignal)
      const republish = await republishRecordedWindow(timeframe)
      if (republish.kind === 'republished') {
        results.push(republish.result)
        continue
      }
      if (republish.kind === 'failed') {
        failures.push({ timeframe, error: republish.error })
        continue
      }
      let acquisitionAttempt: ClaimedLeaderboardAcquisitionAttempt | null = null
      let attemptLifecycle: AttemptLifecycle = 'not_started'
      let failureStage: LeaderboardAcquisitionFailureStage = 'upstream_fetch'
      let failureReason: ProcessingFailureReason = 'unknown_failure'
      let captureCompletedAt: string | null = null
      let diagnosticRawObjectId: number | null = null
      let finalizationPriorFailures: readonly unknown[] = []
      let terminalWindowSideEffect: 'receipt' | null = null
      try {
        throwIfTierACancelled(executionSignal)
        const attempt = await execution.withClaimedWrite((transaction) =>
          startLeaderboardAcquisitionAttemptInTransaction(transaction, executionBinding, {
            sourceId: src.id,
            timeframe,
            observationCycleId: attemptBoundCycleId,
            queueJobId: execution.proof.queueJobId,
            queueAttempt: execution.proof.queueAttempt,
            captureContract: registeredCaptureContract,
            runnerGitSha,
            workerRegion,
          })
        )
        acquisitionAttempt = attempt
        throwIfTierACancelled(executionSignal)
        attemptLifecycle = 'open'
        failureStage = 'session_open'
        failureReason = 'upstream_unavailable'
        if (session === null) {
          session = await openSession(src)
          throwIfTierACancelled(executionSignal)
        }

        const scrapedAt = attempt.recordedStartedAt
        failureStage = 'upstream_fetch'
        failureReason = 'unknown_failure'
        const acquisition = await acquireLeaderboard(
          adapter,
          session,
          src,
          timeframe,
          executionSignal
        )
        throwIfTierACancelled(executionSignal)
        const capture = acquisition.capture
        // This is the acquisition boundary, not a parser/runtime duration.
        const completedAt = new Date().toISOString()
        captureCompletedAt = completedAt
        const capturedError = acquisition.kind === 'captured_error' ? acquisition.error : null
        const pages = [...capture.parsePages]
        const rawPages = capture.sourcePages.map((sourcePage) => sourcePage.rawPage)
        let fieldInventoryRecorded = false
        const recordInventory = async () => {
          if (fieldInventoryRecorded || pages.length === 0) return
          fieldInventoryRecorded = true
          throwIfTierACancelled(executionSignal)
          await recordFieldInventoryBestEffort({
            execution,
            sourceId: src.id,
            payload: pages[0].payload,
          })
          throwIfTierACancelled(executionSignal)
        }

        // The source payload + manifest are persisted atomically after the
        // parser has produced honest accepted/rejected counts below.

        const ctx: ParseCtx = {
          sourceSlug: src.slug,
          currency: src.currency,
          tfLabelMap: src.tf_label_map,
          scrapedAt,
          meta: src.meta,
        }

        const pageSize = src.page_size ?? 100
        const requiredFields = ((src.meta.required_fields as string[]) ?? []) as Array<
          keyof ParsedLeaderboardRow
        >
        let rows: ReturnType<typeof parseLeaderboardRows>
        let validated: ReturnType<typeof validateLeaderboardRows>
        let attemptBoundBuilt: ReturnType<typeof buildAttemptBoundCaptureManifest>
        failureStage = 'parse_validate_manifest'
        failureReason = 'parse_failed'
        try {
          const captureRankAnchors = capturedPageRankAnchors(capture, src.page_size)
          rows = parseLeaderboardRows({
            adapter,
            pages,
            ctx,
            pageSize,
            ...(captureRankAnchors ? { captureRankAnchors } : {}),
          })
          failureReason = 'validation_failed'
          const annotateIdentityMerge = adapter.leaderboardIdentityMerge?.(src) ?? null
          validated = validateLeaderboardRows(
            rows,
            requiredFields,
            annotateIdentityMerge ? { annotateIdentityMerge } : {}
          )
          adapter.validateLeaderboard?.(
            {
              parsedRows: rows,
              validRows: validated.valid,
              rejectedRowCount: validated.rejects.length,
            },
            src,
            timeframe,
            { purpose: capturedError ? 'evidence_only' : 'publication' }
          )
          failureReason = 'manifest_failed'
          attemptBoundBuilt = buildAttemptBoundCaptureManifest({
            src,
            timeframe,
            startedAt: scrapedAt,
            completedAt,
            runnerGitSha: attempt.runnerGitSha,
            cycleId,
            capture,
            capturedFailure: capturedError !== null,
            acceptedPopulation: validated.valid.length,
            rejectedRowCount: validated.rejects.length,
            attempt,
            configuredPartitionIds: partitionIdsByTimeframe.get(timeframe) ?? null,
          })
        } catch (processingCause) {
          const processingReason = failureReason
          const priorFailures = capturedError ? [capturedError, processingCause] : [processingCause]
          failureStage = 'raw_persistence'
          failureReason = 'raw_persistence_failed'
          throwIfTierACancelled(executionSignal)
          const diagnostic = await persistUnprocessedCaptureRaw({
            src,
            timeframe,
            cycleId,
            startedAt: scrapedAt,
            completedAt,
            capture,
            priorFailures,
            attempt,
            runTransaction: runClaimedTransaction,
          })
          throwIfTierACancelled(executionSignal)
          diagnosticRawObjectId = diagnostic.id
          await recordInventory()
          failureStage = 'parse_validate_manifest'
          failureReason = processingReason
          throw new TierACaptureProcessingError(src.slug, timeframe, priorFailures)
        }

        const { valid, rejects } = validated

        let artifactSet
        failureStage = 'raw_persistence'
        failureReason = 'raw_persistence_failed'
        try {
          throwIfTierACancelled(executionSignal)
          artifactSet =
            attemptBoundBuilt.kind === 'v3'
              ? await writeAttemptBoundLeaderboardRawArtifactSet(
                  { attempt, built: attemptBoundBuilt.built, sourcePages: rawPages },
                  runClaimedTransaction
                )
              : await writeAttemptBoundLeaderboardRawArtifactSet(
                  { attempt, built: attemptBoundBuilt.built, sourcePages: rawPages },
                  runClaimedTransaction
                )
          throwIfTierACancelled(executionSignal)
        } catch (persistenceCause) {
          throw new TierAEvidencePersistenceError(
            src.slug,
            timeframe,
            capturedError ? [capturedError] : [],
            persistenceCause
          )
        }
        const rawObjectId = artifactSet.sourcePayload.id
        const evidence:
          | { kind: 'v3'; bundle: LeaderboardMetricTrustBundle }
          | { kind: 'v4'; bundle: LeaderboardAttemptBoundV4Bundle } =
          attemptBoundBuilt.kind === 'v3'
            ? {
                kind: 'v3',
                bundle: {
                  sourceRunId: attemptBoundBuilt.built.sourceRunId,
                  manifest: attemptBoundBuilt.built.manifest,
                  artifacts: artifactSet,
                },
              }
            : {
                kind: 'v4',
                bundle: {
                  sourceRunId: attemptBoundBuilt.built.sourceRunId,
                  manifest: attemptBoundBuilt.built.manifest,
                  artifacts: artifactSet,
                },
              }
        await recordInventory()

        attemptLifecycle = 'finalizing'
        finalizationPriorFailures = capturedError ? [capturedError] : []
        failureStage = 'attempt_finalize'
        failureReason = 'attempt_finalize_failed'
        throwIfTierACancelled(executionSignal)
        await execution.withClaimedWrite(async (transaction) => {
          const outcome = await finishLeaderboardAcquisitionAttemptInTransaction(
            transaction,
            executionBinding,
            {
              kind: 'manifest',
              attempt,
              projection: artifactSet.projection,
              sourcePayloadRawObjectId: artifactSet.sourcePayload.id,
              manifestRawObjectId: artifactSet.populationManifest.id,
            }
          )
          // Exhausted mode: the outcome records no reported total; its
          // exhaustion proof is recorded atomically with it (the DB re-checks it).
          if (artifactSet.projection.exhaustionVerified) {
            await transaction.query(
              'SELECT 1 FROM arena.record_leaderboard_exhaustion_evidence($1)',
              [attempt.attemptId]
            )
          }
          return outcome
        })
        throwIfTierACancelled(executionSignal)
        attemptLifecycle = 'terminal'

        // The failed/partial response is now durable and terminal. Preserve
        // the upstream error for retry classification, but never publish it.
        if (capturedError) throw capturedError
        results.push(
          await publishGatedWindowEvidence({
            timeframe,
            attemptId: attempt.attemptId,
            pages,
            ctx,
            valid,
            rejects,
            projection: artifactSet.projection,
            evidence,
            rawObjectId,
            recordReceipt: recordTierAExecutionWindowReceipt,
            markTerminalSideEffect: (sideEffect) => {
              terminalWindowSideEffect = sideEffect
            },
          })
        )
      } catch (cause) {
        // A failed CAS has already durably committed the receipt and then
        // asserted the now-sticky Bull authority. Preserve both failures;
        // replacing them with only the abort reason would hide the checkpoint
        // ambiguity that operators need to diagnose.
        if (cause instanceof TierACheckpointPersistenceError) throw cause
        if (executionSignal.aborted) {
          const abortReason = executionSignal.reason
          if (cause === abortReason) throw cause
          throw new AggregateError(
            [asError(cause), asError(abortReason)],
            `[tier-a] ${src.slug} ${timeframe}d failed while execution authority was revoked`
          )
        }
        if (acquisitionAttempt === null || attemptLifecycle === 'not_started') {
          const detail = cause instanceof Error ? cause.message : String(cause)
          throw new Error(`[tier-a] ${src.slug} ${timeframe}d attempt start failed: ${detail}`, {
            cause,
          })
        }
        if (attemptLifecycle === 'finalizing') {
          throw new TierAAttemptFinalizationError(
            src.slug,
            timeframe,
            finalizationPriorFailures,
            cause
          )
        }
        if (attemptLifecycle === 'open') {
          throwIfTierACancelled(executionSignal)
          attemptLifecycle = 'finalizing'
          try {
            await execution.withClaimedWrite((transaction) =>
              finishLeaderboardAcquisitionAttemptInTransaction(transaction, executionBinding, {
                kind: 'processing_failed',
                attempt: acquisitionAttempt!,
                captureCompletedAt,
                diagnosticRawObjectId,
                failureStage,
                reasonCode: failureReason,
              })
            )
            throwIfTierACancelled(executionSignal)
            attemptLifecycle = 'terminal'
          } catch (finalizationCause) {
            throw new TierAAttemptFinalizationError(src.slug, timeframe, [cause], finalizationCause)
          }
        }

        const detail = cause instanceof Error ? cause.message : String(cause)
        const error = new Error(`[tier-a] ${src.slug} ${timeframe}d failed: ${detail}`, { cause })
        console.error(error.message)
        if (failureStage === 'session_open') throw error
        // Missing capture evidence or an unknown parser outcome is terminal:
        // later windows must not pile more state onto an unexplainable run.
        // Throw these AggregateErrors directly to preserve every original
        // failure object for retry classification and incident diagnosis.
        if (
          cause instanceof TierAEvidencePersistenceError ||
          cause instanceof TierACaptureProcessingError ||
          cause instanceof TierAAttemptFinalizationError ||
          cause instanceof TierAExecutionWindowReceiptError ||
          terminalWindowSideEffect !== null
        ) {
          throw cause
        }
        // A checkpoint failure is also infrastructure-level and must fail
        // closed. Continuing could persist a later checkpoint after Redis lost
        // acknowledgement for this window.
        failures.push({ timeframe, error })
      }
    }
    execution.assertActive()
  } catch (error) {
    terminalFailure = { error }
  } finally {
    if (session !== null) {
      try {
        await closeSession()
      } catch (cause) {
        sessionCloseFailure = asError(cause)
      }
    }
    executionSignal.removeEventListener('abort', closeSessionOnAbort)
  }

  const processingErrors: Error[] = []
  if (failures.length > 0) {
    processingErrors.push(
      new AggregateError(
        failures.map((failure) => failure.error),
        `[tier-a] ${src.slug}: ${failures.length}/${timeframes.length} native windows failed ` +
          `(${failures.map((failure) => `${failure.timeframe}d`).join(', ')}); ` +
          `${results.length} succeeded`
      )
    )
  }
  if (terminalFailure !== null) processingErrors.push(asError(terminalFailure.error))

  if (processingErrors.length === 0 && sessionCloseFailure === null) {
    try {
      execution.assertActive()
    } catch (cause) {
      processingErrors.push(asError(cause))
    }
  }

  const lifecycleErrors = [...processingErrors]
  if (sessionCloseFailure !== null) lifecycleErrors.push(sessionCloseFailure)
  const closePhase = executionSignal.aborted
    ? 'revoked'
    : lifecycleErrors.length > 0
      ? 'failed'
      : 'completed'
  try {
    const closeProof = await execution.close(closePhase)
    if (closeProof.phase !== closePhase) {
      throw new Error(
        `[tier-a] ${src.slug} execution close phase mismatch: ` +
          `requested=${closePhase}, returned=${closeProof.phase}`
      )
    }
  } catch (cause) {
    lifecycleErrors.push(asError(cause))
  }

  const lifecycleFailure = lifecycleAggregate(src.slug, lifecycleErrors)
  if (lifecycleFailure !== null) throw lifecycleFailure

  return results
}
