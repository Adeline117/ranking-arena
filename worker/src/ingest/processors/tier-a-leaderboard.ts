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
  projectPartitionedNumericParserPage,
  type BuildLeaderboardAcquisitionManifestInput,
  type BuildLeaderboardAcquisitionManifestV4Input,
} from '@/lib/ingest/acquisition-manifest'
import {
  ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
  ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
  findRegisteredAttemptBoundLeaderboardAcquisitionContract,
  finishLeaderboardAcquisitionAttemptInTransaction,
  startLeaderboardAcquisitionAttemptInTransaction,
  type AttemptBoundLeaderboardAcquisitionContract,
  type ClaimedLeaderboardAcquisitionAttempt,
  type LeaderboardAcquisitionExecutionBinding,
  type LeaderboardAcquisitionFailureStage,
  type LeaderboardAcquisitionReasonCode,
} from '@/lib/ingest/acquisition-attempts'
import {
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
import { validateLeaderboardRows } from '@/lib/ingest/staging/validate'
import {
  hasRegisteredLeaderboardMetricTrust,
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
  recordTierAExecutionWindowReceipt,
  TierAExecutionWindowReceiptError,
  withTierAExecutionReceiptWriter,
} from '../tier-a-execution-window-receipt'

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

interface CapturedPageRankAnchor {
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
          validated = validateLeaderboardRows(rows, requiredFields)
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
        await execution.withClaimedWrite((transaction) =>
          finishLeaderboardAcquisitionAttemptInTransaction(transaction, executionBinding, {
            kind: 'manifest',
            attempt,
            projection: artifactSet.projection,
            sourcePayloadRawObjectId: artifactSet.sourcePayload.id,
            manifestRawObjectId: artifactSet.populationManifest.id,
          })
        )
        throwIfTierACancelled(executionSignal)
        attemptLifecycle = 'terminal'

        // The failed/partial response is now durable and terminal. Preserve
        // the upstream error for retry classification, but never publish it.
        if (capturedError) throw capturedError
        if (artifactSet.projection.terminalState !== 'complete') {
          throw new Error(
            `acquisition trust gate FAILED: acquisition=` +
              `${artifactSet.projection.acquisitionState}, population=` +
              `${artifactSet.projection.populationState}, source_run=` +
              `${artifactSet.projection.sourceRunId}`
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
          throw new Error(
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
        terminalWindowSideEffect = 'receipt'
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
              recordTierAExecutionWindowReceipt(writer, {
                attemptId: attempt.attemptId,
                observationCycleId: attemptBoundCycleId,
                rawObjectId,
                snapshotId: result.snapshotId,
                sourceRunId: receiptSourceRunId,
                timeframe,
              })
          )
        )
        throwIfTierACancelled(executionSignal)
        terminalWindowSideEffect = null

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

        results.push({
          timeframe,
          actualCount: valid.length,
          rejects: rejects.length,
          passed: result.verdict.passed,
          baselineUsed: result.verdict.baselineUsed,
          snapshotId: result.snapshotId,
        })
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
