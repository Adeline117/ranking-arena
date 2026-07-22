/**
 * Tier A leaderboard crawl (spec §2.3-A): every 4-6h per source, all native
 * ranking timeframes. Flow per TF:
 *   fetch pages (JSON replay) → RAW object → pure-parse → staging validate
 *   → publish gate (count check; failed snapshots never reach serving).
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
  type LeaderboardCapture,
} from '@/lib/ingest/fetch/capture'
import {
  buildLeaderboardAcquisitionManifest,
  buildLeaderboardAcquisitionManifestV3,
} from '@/lib/ingest/acquisition-manifest'
import {
  ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
  finishLeaderboardAcquisitionAttempt,
  hasRegisteredAttemptBoundLeaderboardAcquisitionContract,
  startLeaderboardAcquisitionAttempt,
  type LeaderboardAcquisitionAttempt,
  type LeaderboardAcquisitionFailureStage,
  type LeaderboardAcquisitionReasonCode,
} from '@/lib/ingest/acquisition-attempts'
import {
  writeAttemptBoundLeaderboardRawArtifactSet,
  writeLeaderboardRawArtifactSet,
  writeRawObject,
  type RawObjectReceipt,
} from '@/lib/ingest/raw'
import { STRICT_CANONICAL_JSON_CONTRACT } from '@/lib/ingest/strict-canonical-json'
import { recordFieldInventory } from '@/lib/ingest/field-inventory'
import { validateLeaderboardRows } from '@/lib/ingest/staging/validate'
import {
  publishBoardSeries,
  publishLeaderboardSnapshot,
  publishTrustedLeaderboardSnapshot,
} from '@/lib/ingest/serving/publish'
import {
  hasRegisteredLeaderboardMetricTrust,
  type LeaderboardMetricTrustBundle,
} from '@/lib/ingest/serving/metric-trust-publish'
import type { TierJobData } from '../queues'
import { observationCycleId } from '../observation-cycle'
import { resolveDeployedSha } from '@/worker/src/ingest/heartbeat'

export interface TierAResult {
  timeframe: number
  actualCount: number
  rejects: number
  passed: boolean
  baselineUsed: number | null
  snapshotId: number
}

type TierAAcquisition =
  | { kind: 'capture'; capture: LeaderboardCapture }
  | {
      kind: 'captured_error'
      capture: LeaderboardCapture
      error: LeaderboardCaptureUpstreamError
    }
  | { kind: 'legacy'; pages: RawPage[] }

async function acquireLeaderboard(
  adapter: SourceAdapter,
  session: Parameters<SourceAdapter['listLeaderboard']>[0],
  src: Parameters<SourceAdapter['listLeaderboard']>[1],
  timeframe: RankingTimeframe
): Promise<TierAAcquisition> {
  if (adapter.captureLeaderboard) {
    try {
      return {
        kind: 'capture',
        capture: await adapter.captureLeaderboard(session, src, timeframe),
      }
    } catch (cause) {
      if (cause instanceof LeaderboardCaptureUpstreamError) {
        return { kind: 'captured_error', capture: cause.capture, error: cause }
      }
      throw cause
    }
  }

  const pages: RawPage[] = []
  for await (const page of adapter.listLeaderboard(session, src, timeframe)) pages.push(page)
  return { kind: 'legacy', pages }
}

function verifiedRunnerGitSha(): string | null {
  const value = resolveDeployedSha()
  return /^[0-9a-f]{40}$/.test(value) ? value : null
}

function configuredWorkerRegion(): string | null {
  return process.env.INGEST_LOCAL_REGION?.trim() || null
}

function attemptBoundCaptureEnabled(): boolean {
  return process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED === 'true'
}

function completedTimeframesFrom(value: unknown): RankingTimeframe[] {
  if (!Array.isArray(value)) return []
  const completed = new Set(value.filter((timeframe) => RANKING_TIMEFRAMES.includes(timeframe)))
  return RANKING_TIMEFRAMES.filter((timeframe) => completed.has(timeframe))
}

class TierACheckpointPersistenceError extends Error {
  constructor(sourceSlug: string, timeframe: RankingTimeframe, options: { cause: unknown }) {
    const detail = options.cause instanceof Error ? options.cause.message : String(options.cause)
    super(`checkpoint persistence failed for ${sourceSlug} ${timeframe}d: ${detail}`, options)
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
  capture: LeaderboardCapture
  capturedFailure: boolean
  acceptedPopulation: number
  rejectedRowCount: number
}

function captureManifestInput(
  input: CaptureManifestInput
): Parameters<typeof buildLeaderboardAcquisitionManifest>[0] {
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

function buildCaptureManifest(input: CaptureManifestInput) {
  return buildLeaderboardAcquisitionManifest(captureManifestInput(input))
}

function buildAttemptBoundCaptureManifest(
  input: CaptureManifestInput & { attempt: LeaderboardAcquisitionAttempt }
) {
  return buildLeaderboardAcquisitionManifestV3({
    ...captureManifestInput(input),
    acquisition_attempt: {
      binding_contract: input.attempt.attemptBindingContract,
      attempt_id: input.attempt.attemptId,
      attempt_seq: input.attempt.attemptSeq,
    },
  })
}

function parseLeaderboardRows(input: {
  adapter: SourceAdapter
  pages: readonly RawPage[]
  ctx: ParseCtx
  pageSize: number
  sourcePageOrdinals?: readonly number[]
}): ParsedLeaderboardRow[] {
  if (
    input.sourcePageOrdinals &&
    (input.sourcePageOrdinals.length !== input.pages.length ||
      new Set(input.sourcePageOrdinals).size !== input.sourcePageOrdinals.length ||
      input.sourcePageOrdinals.some(
        (ordinal) => !Number.isSafeInteger(ordinal) || Object.is(ordinal, -0) || ordinal < 1
      ))
  ) {
    throw new TypeError('[tier-a] parser pages require distinct positive source-page ordinals')
  }
  const rows: ParsedLeaderboardRow[] = []
  for (const [pageOffset, page] of input.pages.entries()) {
    const parsed = input.adapter.parseLeaderboard(page.payload, input.ctx)
    for (const row of parsed.rows) {
      const sourcePageOrdinal = input.sourcePageOrdinals?.[pageOffset]
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
        rank: (page.pageIndex - 1) * input.pageSize + row.rank,
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
  capture: LeaderboardCapture
  priorFailures: readonly unknown[]
  attempt?: LeaderboardAcquisitionAttempt | null
}): Promise<RawObjectReceipt> {
  try {
    return await writeRawObject({
      sourceId: input.src.id,
      sourceSlug: input.src.slug,
      jobType: 'tier_a_failure',
      timeframe: input.timeframe,
      payload: input.capture.sourcePages.map((sourcePage) => sourcePage.rawPage),
      serialization: STRICT_CANONICAL_JSON_CONTRACT,
      meta: {
        pageCount: input.capture.sourcePages.length,
        ...(input.cycleId ? { observation_cycle_id: input.cycleId } : {}),
        ...(input.attempt
          ? {
              acquisition_attempt: {
                binding_contract: input.attempt.attemptBindingContract,
                attempt_id: input.attempt.attemptId,
                attempt_seq: input.attempt.attemptSeq,
                runner_git_sha: input.attempt.runnerGitSha,
                capture_started_at: input.attempt.recordedStartedAt,
                capture_completed_at: input.completedAt,
              },
            }
          : {}),
        trust_evidence: {
          state: 'unknown',
          rank_eligible: false,
          failure_stage: 'parse_validate_or_manifest',
          termination_reason: input.capture.terminationReason,
          capture_started_at: input.startedAt,
          capture_completed_at: input.completedAt,
        },
      },
    })
  } catch (persistenceCause) {
    throw new TierAEvidencePersistenceError(
      input.src.slug,
      input.timeframe,
      input.priorFailures,
      persistenceCause
    )
  }
}

async function persistCompletedTimeframe(
  job: Job<TierJobData>,
  persistedJobData: TierJobData,
  completedTimeframes: ReadonlySet<RankingTimeframe>,
  timeframe: RankingTimeframe,
  sourceSlug: string
): Promise<TierJobData> {
  const nextCompleted = completedTimeframesFrom([...completedTimeframes, timeframe])
  const nextData: TierJobData = {
    ...persistedJobData,
    completedTimeframes: nextCompleted,
  }

  try {
    await job.updateData(nextData)
    return nextData
  } catch (cause) {
    // BullMQ mutates job.data before its Redis command resolves. Restore the
    // last acknowledged value so a later checkpoint can never accidentally
    // persist this unconfirmed window. The caller treats this as fatal rather
    // than continuing to another timeframe.
    job.data = persistedJobData
    throw new TierACheckpointPersistenceError(sourceSlug, timeframe, { cause })
  }
}

export async function processTierA(job: Job<TierJobData>): Promise<TierAResult[]> {
  const src = await getSourceBySlug(job.data.sourceSlug)
  if (src.status !== 'active') {
    console.log(`[tier-a] ${src.slug} is ${src.status} — skipping`)
    return []
  }

  const timeframes = nativeRankingTimeframes(src)
  const completedTimeframes = new Set(
    completedTimeframesFrom(job.data.completedTimeframes).filter((timeframe) =>
      timeframes.includes(timeframe)
    )
  )
  const pendingTimeframes = timeframes.filter((timeframe) => !completedTimeframes.has(timeframe))
  if (completedTimeframes.size > 0) {
    console.log(
      `[tier-a] ${src.slug}: resuming job; skipping completed windows ` +
        [...completedTimeframes].map((timeframe) => `${timeframe}d`).join(', ')
    )
  }
  if (pendingTimeframes.length === 0) return []

  const adapter = getAdapter(src.adapter_slug)
  const cycleId = observationCycleId(job, 'tier-a', src.slug)
  // A registered contract means the database can understand v3 evidence; it
  // is not rollout approval. Keep acquisition on v2 until an operator enables
  // the worker only after the v3 database authority and canaries are live.
  const attemptBoundCapture =
    attemptBoundCaptureEnabled() &&
    (await hasRegisteredAttemptBoundLeaderboardAcquisitionContract({
      sourceId: src.id,
      adapterSlug: src.adapter_slug,
    }))
  const workerRegion = configuredWorkerRegion()
  // Freeze provenance before the first upstream request. A long-running crawl
  // must not bind later timeframes to a different checkout/deployment SHA.
  const runnerGitSha = adapter.captureLeaderboard ? verifiedRunnerGitSha() : null
  if (attemptBoundCapture && !adapter.captureLeaderboard) {
    throw new Error(
      `[tier-a] ${src.slug} is registered for attempt-bound capture but its adapter has no capture implementation`
    )
  }
  if (attemptBoundCapture && runnerGitSha === null) {
    throw new Error(
      `[tier-a] ${src.slug} attempt-bound capture requires an exact deployed runner SHA`
    )
  }
  if (attemptBoundCapture && workerRegion === null) {
    throw new Error(
      `[tier-a] ${src.slug} attempt-bound capture requires an explicit INGEST_LOCAL_REGION`
    )
  }
  const results: TierAResult[] = []
  const failures: Array<{ timeframe: number; error: Error }> = []
  let terminalFailure: { error: unknown } | null = null
  let sessionCloseFailure: Error | null = null
  let persistedJobData: TierJobData = { ...job.data }
  // Unregistered sources retain their existing session/capture path. A
  // registered source opens lazily only after the first pending window has a
  // durable attempt, so session-open failure is itself terminal evidence.
  let session = attemptBoundCapture ? null : await openSession(src)

  try {
    for (const timeframe of pendingTimeframes) {
      let acquisitionAttempt: LeaderboardAcquisitionAttempt | null = null
      let attemptLifecycle: AttemptLifecycle = 'not_started'
      let failureStage: LeaderboardAcquisitionFailureStage = 'upstream_fetch'
      let failureReason: ProcessingFailureReason = 'unknown_failure'
      let captureCompletedAt: string | null = null
      let diagnosticRawObjectId: number | null = null
      let finalizationPriorFailures: readonly unknown[] = []
      try {
        if (attemptBoundCapture) {
          acquisitionAttempt = await startLeaderboardAcquisitionAttempt({
            sourceId: src.id,
            timeframe,
            observationCycleId: cycleId,
            queueJobId: job.id === undefined ? null : String(job.id),
            queueAttempt: job.attemptsMade,
            captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
            runnerGitSha,
            workerRegion,
          })
          attemptLifecycle = 'open'
          failureStage = 'session_open'
          failureReason = 'upstream_unavailable'
          if (session === null) session = await openSession(src)
        }
        if (session === null) {
          throw new Error('source session was not opened')
        }

        const scrapedAt = acquisitionAttempt?.recordedStartedAt ?? new Date().toISOString()
        failureStage = 'upstream_fetch'
        failureReason = 'unknown_failure'
        const acquisition = await acquireLeaderboard(adapter, session, src, timeframe)
        const capture = acquisition.kind === 'legacy' ? null : acquisition.capture
        // This is the acquisition boundary, not a parser/runtime duration.
        captureCompletedAt = capture ? new Date().toISOString() : null
        const capturedError = acquisition.kind === 'captured_error' ? acquisition.error : null
        const pages =
          acquisition.kind === 'legacy' ? acquisition.pages : [...acquisition.capture.parsePages]
        const rawPages =
          acquisition.kind === 'legacy'
            ? acquisition.pages
            : acquisition.capture.sourcePages.map((sourcePage) => sourcePage.rawPage)
        let rawObjectId: number | null = null
        let metricTrust: LeaderboardMetricTrustBundle | null = null

        // Legacy adapters retain the existing RAW-first path. Capture-aware
        // adapters atomically persist source payload + manifest after the
        // parser has produced honest accepted/rejected counts below.
        if (acquisition.kind === 'legacy') {
          const rawReceipt = await writeRawObject({
            sourceId: src.id,
            sourceSlug: src.slug,
            jobType: 'tier_a',
            timeframe,
            payload: rawPages,
            meta: {
              pageCount: rawPages.length,
              ...(cycleId ? { observation_cycle_id: cycleId } : {}),
            },
          })
          rawObjectId = rawReceipt.id
        }

        // Upstream field radar (P1): sample the first page's shape while it's
        // still in memory (RAW blobs aren't SQL-queryable). Fire-and-forget —
        // observation must never break the crawl.
        if (pages.length > 0) {
          recordFieldInventory(src.id, 'tier_a', pages[0].payload).catch(() => {})
        }

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
        let built: ReturnType<typeof buildCaptureManifest> | null
        let attemptBoundBuilt: ReturnType<typeof buildAttemptBoundCaptureManifest> | null
        failureStage = 'parse_validate_manifest'
        failureReason = 'parse_failed'
        try {
          rows = parseLeaderboardRows({
            adapter,
            pages,
            ctx,
            pageSize,
            ...(capture
              ? {
                  sourcePageOrdinals: capture.parserTransformation.source_page_ordinals,
                }
              : {}),
          })
          failureReason = 'validation_failed'
          validated = validateLeaderboardRows(rows, requiredFields)
          failureReason = 'manifest_failed'
          const manifestInput = capture
            ? {
                src,
                timeframe,
                startedAt: scrapedAt,
                completedAt: captureCompletedAt!,
                runnerGitSha: acquisitionAttempt?.runnerGitSha ?? runnerGitSha,
                cycleId,
                capture,
                capturedFailure: capturedError !== null,
                acceptedPopulation: validated.valid.length,
                rejectedRowCount: validated.rejects.length,
              }
            : null
          attemptBoundBuilt =
            manifestInput && acquisitionAttempt
              ? buildAttemptBoundCaptureManifest({
                  ...manifestInput,
                  attempt: acquisitionAttempt,
                })
              : null
          built = manifestInput && !acquisitionAttempt ? buildCaptureManifest(manifestInput) : null
        } catch (processingCause) {
          if (capture) {
            const processingReason = failureReason
            const priorFailures = capturedError
              ? [capturedError, processingCause]
              : [processingCause]
            failureStage = 'raw_persistence'
            failureReason = 'raw_persistence_failed'
            const diagnostic = await persistUnprocessedCaptureRaw({
              src,
              timeframe,
              cycleId,
              startedAt: scrapedAt,
              completedAt: captureCompletedAt!,
              capture,
              priorFailures,
              attempt: acquisitionAttempt,
            })
            diagnosticRawObjectId = diagnostic.id
            failureStage = 'parse_validate_manifest'
            failureReason = processingReason
            throw new TierACaptureProcessingError(src.slug, timeframe, priorFailures)
          }
          throw processingCause
        }

        const { valid, rejects } = validated

        if (capture && attemptBoundBuilt && acquisitionAttempt) {
          let artifactSet
          failureStage = 'raw_persistence'
          failureReason = 'raw_persistence_failed'
          try {
            artifactSet = await writeAttemptBoundLeaderboardRawArtifactSet({
              attempt: acquisitionAttempt,
              built: attemptBoundBuilt,
              sourcePages: rawPages,
            })
          } catch (persistenceCause) {
            throw new TierAEvidencePersistenceError(
              src.slug,
              timeframe,
              capturedError ? [capturedError] : [],
              persistenceCause
            )
          }
          rawObjectId = artifactSet.sourcePayload.id
          metricTrust = {
            sourceRunId: attemptBoundBuilt.sourceRunId,
            manifest: attemptBoundBuilt.manifest,
            artifacts: artifactSet,
          }

          attemptLifecycle = 'finalizing'
          finalizationPriorFailures = capturedError ? [capturedError] : []
          failureStage = 'attempt_finalize'
          failureReason = 'attempt_finalize_failed'
          await finishLeaderboardAcquisitionAttempt({
            kind: 'manifest',
            attempt: acquisitionAttempt,
            projection: artifactSet.projection,
            sourcePayloadRawObjectId: artifactSet.sourcePayload.id,
            manifestRawObjectId: artifactSet.populationManifest.id,
          })
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
        } else if (capture && built) {
          let artifactSet
          try {
            artifactSet = await writeLeaderboardRawArtifactSet({
              sourceId: src.id,
              sourceSlug: src.slug,
              timeframe,
              sourceRunId: built.sourceRunId,
              sourcePages: rawPages,
              manifest: built.manifest,
              observationCycleId: cycleId,
            })
          } catch (persistenceCause) {
            throw new TierAEvidencePersistenceError(
              src.slug,
              timeframe,
              capturedError ? [capturedError] : [],
              persistenceCause
            )
          }
          rawObjectId = artifactSet.sourcePayload.id
          metricTrust = {
            sourceRunId: built.sourceRunId,
            manifest: built.manifest,
            artifacts: artifactSet,
          }

          // The failed response is now durable. Preserve the exact upstream
          // error object so BullMQ retry classification and operator evidence
          // remain intact; an unknown manifest can never reach publication.
          if (capturedError) throw capturedError

          if (
            built.manifest.assessment.acquisition_state !== 'complete' ||
            built.manifest.assessment.population_state !== 'verified'
          ) {
            throw new Error(
              `acquisition trust gate FAILED: acquisition=` +
                `${built.manifest.assessment.acquisition_state}, population=` +
                `${built.manifest.assessment.population_state}, source_run=${built.sourceRunId}`
            )
          }
        }

        if (rawObjectId === null) {
          throw new Error('capture evidence completed without a source RAW pointer')
        }

        // Series are additive serving material, not population evidence.
        // Parse them only after the capture pair passed its trust gate so a
        // series-specific bug cannot erase an otherwise truthful manifest.
        const boardSeries = parseLeaderboardSeriesWindow({ adapter, pages, ctx, timeframe })

        const registeredMetricTrust =
          metricTrust !== null && hasRegisteredLeaderboardMetricTrust(src, timeframe)
        if (acquisitionAttempt && !registeredMetricTrust) {
          throw new Error(
            `[tier-a] ${src.slug} ${timeframe}d attempt-bound capture has no reviewed metric trust contract`
          )
        }
        const trustedBundle = registeredMetricTrust ? metricTrust : null
        const result = trustedBundle
          ? await publishTrustedLeaderboardSnapshot({
              src,
              timeframe,
              rows: valid,
              rejects,
              observationCycleId: cycleId ?? undefined,
              trust: trustedBundle,
            })
          : await publishLeaderboardSnapshot({
              src,
              timeframe,
              rows: valid,
              rejects,
              rawObjectId,
              observationCycleId: cycleId ?? undefined,
            })

        const status = result.published ? 'PUBLISHED' : 'GATED'
        console.log(
          `[tier-a] ${src.slug} ${timeframe}d: ${valid.length} rows ` +
            `(${rejects.length} rejected, baseline=${result.verdict.baselineUsed}, ` +
            `deviation=${result.verdict.deviationPct?.toFixed(1) ?? '–'}%) → ${status}`
        )
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
          const seriesOut = await publishBoardSeries(src, boardSeries, result.traderIds, {
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
          })
          console.log(
            `[tier-a] ${src.slug} ${timeframe}d board series: ` +
              `${seriesOut.points} pts for ${seriesOut.traders} traders`
          )
        }

        // Bot boards (spec §11.5): shadow trader rows are published above
        // like any board; additionally upsert arena.bots from the
        // adapter-normalized fields (traderMeta.bot).
        if (src.trader_kind_scope === 'bot') {
          const { publishBots } = await import('@/lib/ingest/serving/publish-bots')
          const bots = await publishBots(src, valid, result.traderIds)
          console.log(`[tier-a] ${src.slug} ${timeframe}d bots upserted: ${bots.written}`)
        }

        // (compat→trader_latest write removed 2026-06-15) The score chain now runs
        // on arena directly (compute-leaderboard reads arena_score_inputs, not
        // trader_latest), so the compat bridge is orphaned and trader_latest is
        // being dropped. publish() above already wrote arena.* — the canonical source.

        // This is deliberately the LAST awaited side effect in one window.
        // A retry may skip the window only after RAW + snapshot + optional
        // board-series + optional bot publication have all completed. Persist
        // after every window so a worker restart loses at most the in-flight TF.
        persistedJobData = await persistCompletedTimeframe(
          job,
          persistedJobData,
          completedTimeframes,
          timeframe,
          src.slug
        )
        completedTimeframes.add(timeframe)

        results.push({
          timeframe,
          actualCount: valid.length,
          rejects: rejects.length,
          passed: result.verdict.passed,
          baselineUsed: result.verdict.baselineUsed,
          snapshotId: result.snapshotId,
        })
      } catch (cause) {
        if (attemptBoundCapture) {
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
            attemptLifecycle = 'finalizing'
            try {
              await finishLeaderboardAcquisitionAttempt({
                kind: 'processing_failed',
                attempt: acquisitionAttempt,
                captureCompletedAt,
                diagnosticRawObjectId,
                failureStage,
                reasonCode: failureReason,
              })
              attemptLifecycle = 'terminal'
            } catch (finalizationCause) {
              throw new TierAAttemptFinalizationError(
                src.slug,
                timeframe,
                [cause],
                finalizationCause
              )
            }
          }
        }

        const detail = cause instanceof Error ? cause.message : String(cause)
        const error = new Error(`[tier-a] ${src.slug} ${timeframe}d failed: ${detail}`, { cause })
        console.error(error.message)
        if (attemptBoundCapture && failureStage === 'session_open') throw error
        // Missing capture evidence or an unknown parser outcome is terminal:
        // later windows must not pile more state onto an unexplainable run.
        // Throw these AggregateErrors directly to preserve every original
        // failure object for retry classification and incident diagnosis.
        if (
          cause instanceof TierAEvidencePersistenceError ||
          cause instanceof TierACaptureProcessingError ||
          cause instanceof TierAAttemptFinalizationError
        ) {
          throw cause
        }
        // A checkpoint failure is also infrastructure-level and must fail
        // closed. Continuing could persist a later checkpoint after Redis lost
        // acknowledgement for this window.
        if (cause instanceof TierACheckpointPersistenceError) throw error
        failures.push({ timeframe, error })
      }
    }
  } catch (error) {
    terminalFailure = { error }
  } finally {
    if (session !== null) {
      try {
        await session.close()
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause)
        sessionCloseFailure = new Error(`[tier-a] ${src.slug} session close failed: ${detail}`, {
          cause,
        })
      }
    }
  }

  if (terminalFailure !== null) {
    if (sessionCloseFailure !== null) {
      const processingError =
        terminalFailure.error instanceof Error
          ? terminalFailure.error
          : new Error(String(terminalFailure.error))
      throw new AggregateError(
        [processingError, sessionCloseFailure],
        `[tier-a] ${src.slug}: processing and session close both failed`
      )
    }
    throw terminalFailure.error
  }

  if (failures.length > 0) {
    const errors = failures.map((failure) => failure.error)
    if (sessionCloseFailure !== null) errors.push(sessionCloseFailure)
    throw new AggregateError(
      errors,
      `[tier-a] ${src.slug}: ${failures.length}/${timeframes.length} native windows failed ` +
        `(${failures.map((failure) => `${failure.timeframe}d`).join(', ')}); ` +
        `${results.length} succeeded${sessionCloseFailure ? '; session close failed' : ''}`
    )
  }

  if (sessionCloseFailure !== null) throw sessionCloseFailure

  return results
}
