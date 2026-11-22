/**
 * Tier B deep-profile / record-history crawl (spec §2.3-B): only the top
 * sources.deep_profile_topn per board, every 12-24h. These hot traders
 * stay cache-warm so the most-viewed profiles never trigger a live fetch.
 * Record-only adapters use the same bounded cohort and cadence. Long-tail
 * traders are NEVER crawled on a timer — that's Tier C.
 */

import type { Job } from 'bullmq'
import { getIngestPool } from '@/lib/ingest/db'
import { getSourceBySlug, profileTimeframes } from '@/lib/ingest/sources'
import { getLatestPassedNativeCohort, type NativeCohortTrader } from '@/lib/ingest/native-cohort'
import { getAdapter, type SourceAdapter } from '@/lib/ingest/core/adapter'
import { nextHistoryCursor } from '@/lib/ingest/core/history-cursor'
import { supportsSourceSurface } from '@/lib/ingest/core/surface-capabilities'
import {
  findIncompleteProfileWindow,
  IncompleteProfileWindowError,
} from '@/lib/ingest/core/profile-coverage'
import type {
  HistoryKind,
  ParseCtx,
  ParsedHistoryRow,
  ParsedProfile,
  ParsedStats,
  RankingTimeframe,
  RawPage,
  SourceRow,
  Timeframe,
} from '@/lib/ingest/core/types'
import type { FetchSession } from '@/lib/ingest/fetch/types'
import { getCircuit, openSession } from '@/lib/ingest/fetch/fetcher'
import { UpstreamGoneError } from '@/lib/ingest/fetch/capture'
import {
  CopierPageCapReachedError,
  HistoryPageCapReachedError,
} from '@/lib/ingest/core/history-page-cap'
import { captureHistoryAcquisition } from '@/lib/ingest/history-acquisition'
import { buildPositionHistoryAcquisitionArtifactV2 } from '@/lib/ingest/position-history-acquisition-v2'
import {
  writeCopierSnapshotRawArtifact,
  writePositionHistoryRawArtifact,
  writeRawObject,
  type IngestTransactionRunner,
} from '@/lib/ingest/raw'
import { buildCopierSnapshotArtifact } from '@/lib/ingest/copier-snapshot-artifact'
import { recordStagingRejects } from '@/lib/ingest/staging/rejects'
import {
  roiCrossCheckOk,
  validateStats,
  type NulledStatMetric,
} from '@/lib/ingest/staging/validate'
import { getHistoryCursor, publishHistoryRows, publishProfile } from '@/lib/ingest/serving/publish'
import { publishCopierSnapshotInTransaction } from '@/lib/ingest/serving/copier-snapshot-publish'
import { recordFieldInventory } from '@/lib/ingest/field-inventory'
import {
  buildProfileAcquisition,
  lastStatsBlock,
  profileOutcome,
  type ProfileCaptureResult,
} from '@/lib/ingest/profile-capture/capture'
import {
  getProfileCaptureContract,
  type ProfileCaptureContract,
} from '@/lib/ingest/profile-capture/contract'
import {
  finishProfileAcquisitionAttempt,
  profileCaptureRawMeta,
  startProfileAcquisitionAttempt,
  type ProfileAcquisitionAttempt,
} from '@/lib/ingest/profile-capture/ledger'
import type { ProfileStatsEvidence } from '@/lib/ingest/serving/publish'
import { fireAndForget, logger } from '@/lib/utils/logger'
import { getRegionQueue, INGEST_JOB, type TierJobData } from '../queues'
import { getConnection } from '../../connection'
import { closeCircuitCycle } from '../circuit-cycle'
import {
  assertSourceMatchesConsumedRegion,
  type ConsumedRegionContext,
} from '../consumed-region-context'
import { runHistoryTransaction } from '../history-transaction'
import { isContinuableHistoryKind } from '@/lib/ingest/core/history-continuation'
import { continueTruncatedHistory, recordHistoryTruncation } from './tier-b-history-continuation'

/**
 * Staleness filter (deadline-chunking, 2026-07-03): only traders NOT
 * processed by Tier B since `stalerThan` are returned. The marker is a dedicated
 * arena.ingest_cursors row (kind 'tierb_profiled') written after each trader
 * whose requested profile and history surfaces all committed successfully,
 * or whose requested profile timeframes ended in a durable quality reject.
 * Operational history failures never advance this whole-trader marker.
 * trader_stats.as_of is NOT usable here because the
 * tier-A board upsert refreshes it every 2-5h, which would make everyone
 * look "fresh" and starve the deep crawl entirely.
 * The native-cohort helper applies this filter after selecting only declared
 * native PASSED top-N membership; derived boards must never feed Tier-B back
 * into themselves.
 */
/** Compatibility marker recording a terminal Tier-B profile/record attempt. */
const PROFILED_CURSOR_KIND = 'tierb_profiled'

async function persistPositionHistoryRawOnly(
  input: Parameters<typeof writePositionHistoryRawArtifact>[0]
): Promise<void> {
  let storageDurable = false
  const markStorageDurable: IngestTransactionRunner = async (persistRawPointer) => {
    storageDurable = true
    return runHistoryTransaction(persistRawPointer)
  }

  try {
    await writePositionHistoryRawArtifact(input, markStorageDurable)
  } catch (cause) {
    if (!storageDurable) throw cause

    // The first transaction may have rolled back or committed before its
    // response was lost. Replay the exact content-addressed artifact once;
    // pointer validation turns either outcome into the same durable state.
    try {
      await writePositionHistoryRawArtifact(input, runHistoryTransaction)
    } catch (replayCause) {
      throw new AggregateError(
        [
          cause instanceof Error ? cause : new Error(String(cause)),
          replayCause instanceof Error ? replayCause : new Error(String(replayCause)),
        ],
        '[tier-b] history RAW evidence persistence and reconciliation both failed'
      )
    }
  }
}

async function markProfileAttempted(traderId: number): Promise<void> {
  await getIngestPool().query(
    `INSERT INTO arena.ingest_cursors (trader_id, kind, cursor_value, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (trader_id, kind)
     DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = now()`,
    [traderId, PROFILED_CURSOR_KIND, new Date().toISOString()]
  )
}

/**
 * Failed Tier-B attempts tolerated per refresh window before a trader is
 * backed off like a 404/410 one. Persistent non-404 failures (HTTP-200
 * business errors, parse failures, browser sources that never see a 404, or
 * a profile that succeeds while its histories keep failing) would otherwise
 * be re-crawled on every continuation hop of every pass.
 */
export const TIER_B_MAX_FAILED_ATTEMPTS = 3
const FAILED_ATTEMPTS_META_KEY = 'tierb_failed_attempts'

/** Counts one failed attempt; returns the trader's consecutive failure count. */
async function recordFailedAttempt(traderId: number): Promise<number> {
  const { rows } = await getIngestPool().query<{ failures: number | null }>(
    `UPDATE arena.traders
        SET meta = jsonb_set(
              meta, ARRAY[$2::text],
              to_jsonb(COALESCE((meta->>$2::text)::int, 0) + 1))
      WHERE id = $1
      RETURNING (meta->>$2::text)::int AS failures`,
    [traderId, FAILED_ATTEMPTS_META_KEY]
  )
  return rows[0]?.failures ?? 0
}

async function clearFailedAttempts(traderId: number): Promise<void> {
  await getIngestPool().query(
    `UPDATE arena.traders SET meta = meta - $2::text WHERE id = $1 AND meta ? $2::text`,
    [traderId, FAILED_ATTEMPTS_META_KEY]
  )
}

/** Durable marker: the latest copier capture was cut by the page budget. */
async function recordCopierTruncation(
  traderId: number,
  pageCap: number,
  pagesCaptured: number
): Promise<void> {
  await getIngestPool().query(
    `UPDATE arena.traders
        SET meta = meta || jsonb_build_object(
          'copiers_truncated',
          jsonb_build_object('detected_at', now(), 'page_cap', $2::int, 'pages_captured', $3::int)
        )
      WHERE id = $1`,
    [traderId, pageCap, pagesCaptured]
  )
}

/**
 * Max continuation hops per chain: bounds a pathological slow-failing source
 * (nothing gets marked profiled → every continuation re-attempts the same
 * traders) to ~depth × deadline of wasted crawl per cadence instead of a
 * self-requeue loop that never ends.
 */
const MAX_CONT_DEPTH = 50

/** Fisher–Yates — never crawl ranks 1→N in perfect order (spec §4). */
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export interface TierBResult {
  tradersCrawled: number
  surfacesFetched: number
  historyRowsWritten: number
  rejects: number
  errors: number
  crossCheckFails: number
  /**
   * Stats metrics stored NULL because the source value was outside [0, 100]
   * (e.g. a reported max drawdown above 100 %). The block is still published.
   */
  nulledMetrics: number
  /** Traders still stale when the deadline hit (0 = pass completed). */
  remaining: number
}

/** History kinds this source can serve, per adapter capabilities. */
function historyKinds(adapter: SourceAdapter, src: SourceRow): HistoryKind[] {
  const kinds: HistoryKind[] = []
  if (supportsSourceSurface(adapter, src, 'positionHistory')) kinds.push('position_history')
  if (supportsSourceSurface(adapter, src, 'orders')) kinds.push('orders')
  if (supportsSourceSurface(adapter, src, 'transfers')) kinds.push('transfers')
  if (supportsSourceSurface(adapter, src, 'copiers')) kinds.push('copiers')
  return kinds
}

async function persistPositionHistory(
  session: FetchSession,
  adapter: SourceAdapter,
  src: SourceRow,
  trader: NativeCohortTrader,
  requireResponsePage: boolean
): Promise<number> {
  // The retained @1 publication checkpoint was derived from typed rows whose
  // parser/source-fact conservation was never proved. It cannot seed the @2
  // evidence chain: the first trusted acquisition must be cursorless and
  // exhaustive so facts omitted by the old parser remain recoverable.
  const cursor = null
  const acquisition = await captureHistoryAcquisition({
    source: src,
    traderId: trader.id,
    exchangeTraderId: trader.exchange_trader_id,
    kind: 'position_history',
    cursor,
    attemptStartedAt: new Date().toISOString(),
    stream: adapter.getHistory(
      session,
      src,
      trader.exchange_trader_id,
      'position_history',
      cursor,
      trader.meta
    ),
    terminalVerifier: adapter.historyTerminalVerifier?.(src, 'position_history') ?? undefined,
  })
  const rawInput = { artifact: acquisition.artifact, sourceRunId: acquisition.sourceRunId }

  if (acquisition.error !== null) {
    await persistPositionHistoryRawOnly(rawInput)
    throw acquisition.error
  }

  let evidenceInput: Parameters<typeof writePositionHistoryRawArtifact>[0] = rawInput
  let evidenceFailure: string | null = null
  if (acquisition.artifact.termination.evidence_state === 'verified') {
    if (acquisition.artifact.termination.scan_terminal_state !== 'exhausted') {
      // A cursorless genesis cannot terminate by overlap: there is no trusted
      // prior boundary for the overlap to prove. Keep the RAW audit artifact,
      // but never promote it into the @2 trusted acquisition chain.
      evidenceFailure = 'cursorless_genesis_not_exhausted'
    } else {
      const verifiedEvidence = buildPositionHistoryAcquisitionArtifactV2({
        acquisition: acquisition.artifact,
        expectedAcquisition: {
          sourceRunId: acquisition.sourceRunId,
          sourceId: src.id,
          sourceSlug: src.slug,
          traderId: trader.id,
          exchangeTraderId: trader.exchange_trader_id,
        },
      })
      if (verifiedEvidence.state === 'verified') {
        // @2 proves terminal acquisition plus framework-enumerated source facts,
        // but not parser projection or ranking eligibility. Persist only its RAW
        // pointer; the legacy @1 publication RPC must remain unreachable here.
        evidenceInput = {
          artifact: verifiedEvidence.artifact,
          sourceRunId: verifiedEvidence.sourceRunId,
        }
      } else {
        evidenceFailure = verifiedEvidence.reason
      }
    }
  }

  await persistPositionHistoryRawOnly(evidenceInput)
  if (evidenceFailure !== null) {
    throw new Error(
      `[tier-b] ${src.slug} verified position-history evidence upgrade failed: ${evidenceFailure}`
    )
  }
  if (requireResponsePage && acquisition.pages.length === 0) {
    throw new Error(`[tier-b] ${src.slug} position_history returned no upstream response page`)
  }
  return 0
}

/**
 * History pass for one trader within the same session. Position history is
 * acquisition-evidence only until a versioned parser projection and receipt
 * exist. Copier tables use an immutable full-snapshot receipt; only orders and
 * transfers retain their legacy cursor/upsert path.
 */
async function crawlTraderHistories(
  session: FetchSession,
  adapter: SourceAdapter,
  src: SourceRow,
  trader: NativeCohortTrader,
  ctx: ParseCtx,
  requireResponseForEveryKind: boolean
): Promise<number> {
  let written = 0
  for (const kind of historyKinds(adapter, src)) {
    if (kind === 'position_history') {
      written += await persistPositionHistory(
        session,
        adapter,
        src,
        trader,
        requireResponseForEveryKind
      )
      continue
    }
    // Copier tables are complete point-in-time snapshots. Reusing an event
    // cursor here truncates the aggregate and can silently erase followers.
    const cursor = kind === 'copiers' ? null : await getHistoryCursor(trader.id, kind)
    const rawPages: RawPage[] = []
    let fetchError: unknown = null

    try {
      for await (const page of adapter.getHistory(
        session,
        src,
        trader.exchange_trader_id,
        kind,
        cursor,
        trader.meta
      )) {
        rawPages.push(page)
      }
    } catch (error) {
      fetchError = error
    }

    if (kind === 'copiers') {
      if (fetchError instanceof CopierPageCapReachedError) {
        // Contract: a Tier-B copier snapshot is never caller-limited
        // (copier_snapshot_tier_b_not_caller_limited). A capture cut by the
        // page budget is therefore kept as RAW diagnostics only — no snapshot
        // is published (the last complete one stays) — and the cut is recorded
        // durably. Not rethrown: retrying every continuation hop would burn
        // the same budget and hit the same cap.
        await writeRawObject({
          sourceId: src.id,
          sourceSlug: src.slug,
          jobType: 'history:copiers',
          traderId: trader.id,
          timeframe: null,
          payload: rawPages,
          meta: {
            surface: 'copiers',
            lane: 'tier_b',
            fetch_failed: false,
            capture_rejected: 'caller_page_budget',
            page_cap: fetchError.pageCap,
          },
        })
        await recordCopierTruncation(trader.id, fetchError.pageCap, rawPages.length)
        logger.warn(
          `[tier-b] ${src.slug} trader ${trader.exchange_trader_id} copiers: page cap ` +
            `${fetchError.pageCap} reached — snapshot not published (recorded as truncated)`
        )
        continue
      }
      if (fetchError !== null || rawPages.length === 0) {
        // Failed or evidence-free captures are useful diagnostics, but cannot
        // satisfy the page-bearing snapshot contract or mark this trader fresh.
        await writeRawObject({
          sourceId: src.id,
          sourceSlug: src.slug,
          jobType: 'history:copiers',
          traderId: trader.id,
          timeframe: null,
          payload: rawPages,
          meta: {
            surface: 'copiers',
            lane: 'tier_b',
            fetch_failed: fetchError !== null,
            capture_rejected: rawPages.length === 0 ? 'no_evidence_page' : null,
          },
        })
        if (fetchError !== null) throw fetchError
        throw new Error(`[tier-b] ${src.slug} copiers returned no upstream response page`)
      }

      const artifact = buildCopierSnapshotArtifact({
        src,
        traderId: trader.id,
        exchangeTraderId: trader.exchange_trader_id,
        lane: 'tier_b',
        requestTimeframe: null,
        pages: rawPages,
        callerLimited: false,
      })
      const rawReceipt = await writeCopierSnapshotRawArtifact({ artifact }, runHistoryTransaction)
      // RAW is durable before parsing. PostgreSQL then commits the immutable
      // receipt and all private rows atomically; no legacy copier table or
      // cursor is touched by this authority path.
      const rows = rawPages.flatMap((page) => adapter.parseHistory(page.payload, kind, ctx))
      const publication = await runHistoryTransaction((transaction) =>
        publishCopierSnapshotInTransaction(transaction, {
          artifact,
          rawReceipt,
          rows,
        })
      )
      written += publication.parsedRowCount
      continue
    }

    // A page-budget cut is not a failed fetch: the yielded newest pages are
    // valid. Publish them, but record the truncation durably (RAW meta +
    // traders.meta.history_truncated) so the gap in older history is visible
    // instead of silently looking complete once the cursor jumps to newest.
    const pageCapCut =
      fetchError instanceof HistoryPageCapReachedError && rawPages.length > 0 ? fetchError : null
    if (rawPages.length > 0 || fetchError !== null) {
      await writeRawObject({
        sourceId: src.id,
        sourceSlug: src.slug,
        jobType: `history:${kind}`,
        traderId: trader.id,
        timeframe: null,
        payload: rawPages,
        meta: {
          fetch_failed: fetchError !== null && pageCapCut === null,
          caller_limited: pageCapCut !== null,
          ...(pageCapCut !== null ? { page_cap: pageCapCut.pageCap } : {}),
        },
      })
    }
    if (fetchError !== null && pageCapCut === null) throw fetchError
    if (rawPages.length === 0) {
      if (requireResponseForEveryKind) {
        throw new Error(`[tier-b] ${src.slug} ${kind} returned no upstream response page`)
      }
      if (isContinuableHistoryKind(kind)) {
        written += (await continueTruncatedHistory(session, adapter, src, trader, kind, ctx))
          .rowsWritten
      }
      continue
    }

    // RAW is durable before an incomplete or changed payload can be rejected.
    const rows: ParsedHistoryRow[] = rawPages.flatMap((page) =>
      adapter.parseHistory(page.payload, kind, ctx)
    )

    written += await publishHistoryRows(src, trader.id, kind, rows, nextHistoryCursor(rows, cursor))
    if (pageCapCut !== null && isContinuableHistoryKind(kind)) {
      const continuation = await recordHistoryTruncation(
        adapter,
        src,
        trader.id,
        kind,
        pageCapCut,
        rows
      )
      logger.warn(
        `[tier-b] ${src.slug} trader ${trader.exchange_trader_id} ${kind}: page cap ` +
          `${pageCapCut.pageCap} reached — older history not captured yet (recorded as ` +
          `truncated; continuation ${continuation.state})`
      )
      // This run already spent its budget on the newest pages: the backward
      // continuation resumes on the next run, keeping each run bounded.
      continue
    }
    if (isContinuableHistoryKind(kind)) {
      // Bounded backward continuation of an earlier truncation (#440).
      written += (await continueTruncatedHistory(session, adapter, src, trader, kind, ctx))
        .rowsWritten
    }
  }
  return written
}

/**
 * Attempt-bound profile evidence (migration 20261116215328). A source whose
 * profile capture contract covers the timeframe records every fetch as an
 * attempt with a typed terminal; only a complete capture stamps the stats it
 * attests. A ledger failure never blocks the crawl: the profile is published
 * unattested, which publication treats as no evidence (fail closed).
 */
interface ProfileEvidenceAttempt {
  readonly contract: ProfileCaptureContract
  readonly attempt: ProfileAcquisitionAttempt
  finished: boolean
}

function contractTimeframe(
  contract: ProfileCaptureContract | null,
  timeframe: Timeframe
): RankingTimeframe | null {
  if (contract === null || timeframe === 0) return null
  return contract.timeframes.includes(timeframe) ? timeframe : null
}

async function beginProfileEvidence(
  src: SourceRow,
  traderId: number,
  timeframe: Timeframe,
  contract: ProfileCaptureContract | null
): Promise<ProfileEvidenceAttempt | null> {
  const covered = contractTimeframe(contract, timeframe)
  if (contract === null || covered === null) return null
  try {
    const attempt = await startProfileAcquisitionAttempt(getIngestPool(), {
      sourceId: src.id,
      traderId,
      timeframe: covered,
      contract,
    })
    return { contract, attempt, finished: false }
  } catch (err) {
    logger.error(
      `[tier-b] ${src.slug} profile attempt not started (publishing unattested):`,
      err instanceof Error ? err.message : err
    )
    return null
  }
}

/** Records the terminal once; true only when a complete outcome is durable. */
async function finishProfileEvidence(
  src: SourceRow,
  evidence: ProfileEvidenceAttempt | null,
  result: ProfileCaptureResult,
  rawObjectId: number | null
): Promise<boolean> {
  if (evidence === null || evidence.finished) return false
  evidence.finished = true
  try {
    await finishProfileAcquisitionAttempt(getIngestPool(), evidence.attempt, result, rawObjectId)
    return result.terminalState === 'complete'
  } catch (err) {
    logger.error(
      `[tier-b] ${src.slug} profile attempt ${evidence.attempt.attemptSeq} not finished ` +
        `(publishing unattested):`,
      err instanceof Error ? err.message : err
    )
    return false
  }
}

/**
 * Decide this attempt's terminal from what the publish loop will store: an
 * incomplete window is partial; otherwise the last block for the timeframe
 * (after the same staging validation) is checked against the contract.
 */
async function settleProfileEvidence(
  src: SourceRow,
  evidenceAttempt: ProfileEvidenceAttempt | null,
  exchangeTraderId: string,
  pages: readonly RawPage[],
  profiles: readonly ParsedProfile[],
  requiredFields: Array<keyof ParsedStats>,
  rawObjectId: number
): Promise<{ profileIndex: number; stats: ProfileStatsEvidence } | null> {
  if (evidenceAttempt === null) return null
  const { attempt, contract } = evidenceAttempt
  if (profiles.some((profile) => findIncompleteProfileWindow(profile) !== null)) {
    await finishProfileEvidence(
      src,
      evidenceAttempt,
      profileOutcome('partial', 'profile_window_incomplete', 'profile window incomplete'),
      rawObjectId
    )
    return null
  }
  const last = lastStatsBlock(profiles, attempt.timeframe)
  const stored =
    last === null ? null : (validateStats([last.block], requiredFields).valid[0] ?? null)
  const result = buildProfileAcquisition({
    contract,
    contractSha256: attempt.contractSha256,
    attemptId: attempt.attemptId,
    exchangeTraderId,
    timeframe: attempt.timeframe,
    pages,
    parsed: last?.block ?? null,
    stored,
  })
  if (result.terminalState !== 'complete') {
    logger.warn(
      `[tier-b] ${src.slug} ${exchangeTraderId} ${attempt.timeframe}d profile capture ` +
        `${result.terminalState}/${result.reasonCode}: ${result.detail}`
    )
  }
  const durable = await finishProfileEvidence(src, evidenceAttempt, result, rawObjectId)
  if (!durable || last === null || result.attestedMetrics.length === 0) return null
  return {
    profileIndex: last.profileIndex,
    stats: {
      attemptSeq: attempt.attemptSeq,
      timeframe: attempt.timeframe,
      metrics: result.attestedMetrics,
    },
  }
}

/**
 * Leaves a trace of every stats metric staging stored NULL because the source
 * value was outside [0, 100]: each one is logged and counted, and one the
 * source's profile capture contract declares (so its evidence is dropped with
 * it) is also written to arena.staging_rejects against the attempt's RAW
 * object, as `metric_out_of_range:<metric>`. The block itself is still
 * published; an audit-write failure is logged and never blocks it.
 */
async function recordNulledStatMetrics(
  src: SourceRow,
  trader: NativeCohortTrader,
  rawObjectId: number,
  nulledMetrics: readonly NulledStatMetric[],
  contract: ProfileCaptureContract | null
): Promise<number> {
  if (nulledMetrics.length === 0) return 0
  for (const nulled of nulledMetrics) {
    logger.warn(
      `[tier-b] ${src.slug} ${trader.exchange_trader_id} ${nulled.timeframe}d ` +
        `${nulled.metric}=${nulled.value} is outside [0, 100]: stored NULL, not attested`
    )
  }
  const contracted = nulledMetrics.filter(
    (nulled) =>
      contract !== null &&
      contractTimeframe(contract, nulled.timeframe) !== null &&
      contract.metrics[nulled.metric] !== undefined
  )
  if (contracted.length > 0) {
    try {
      await recordStagingRejects(
        src.id,
        rawObjectId,
        contracted.map((nulled) => ({
          reason: `metric_out_of_range:${nulled.metric}`,
          payload: {
            source_slug: src.slug,
            trader_id: trader.id,
            exchange_trader_id: trader.exchange_trader_id,
            timeframe: nulled.timeframe,
            metric: nulled.metric,
            source_value: nulled.value,
            action: 'stored_null_not_attested',
          },
        }))
      )
    } catch (err) {
      logger.error(
        `[tier-b] ${src.slug} out-of-range metric audit not recorded:`,
        err instanceof Error ? err.message : err
      )
    }
  }
  return nulledMetrics.length
}

export async function processTierB(
  job: Job<TierJobData>,
  context: ConsumedRegionContext
): Promise<TierBResult> {
  const empty: TierBResult = {
    tradersCrawled: 0,
    surfacesFetched: 0,
    historyRowsWritten: 0,
    rejects: 0,
    errors: 0,
    crossCheckFails: 0,
    nulledMetrics: 0,
    remaining: 0,
  }
  const src = await getSourceBySlug(job.data.sourceSlug)
  assertSourceMatchesConsumedRegion(src, context)
  if (src.status !== 'active') return empty

  const adapter = getAdapter(src.adapter_slug)
  const supportsProfile = supportsSourceSurface(adapter, src, 'profile')
  const scheduledHistoryKinds = historyKinds(adapter, src)
  if (!supportsProfile && scheduledHistoryKinds.length === 0) return empty

  // Deadline chunking (2026-07-03 slot-monopoly root fix): a full top-300
  // deep-profile pass ran 3-4h per source and, phase-locked across sources,
  // monopolized every bulk slot for hours (tier-A boards 17-32h stale).
  // BullMQ priority can't preempt an in-flight job, so the job itself must
  // yield: crawl only stale traders, stop at the wall-clock deadline, and
  // re-enqueue a CONTINUATION at the same priority. Higher-priority work
  // interleaves between chunks; the pass still completes because the
  // staleness marker (ingest_cursors) makes every chunk resume where the
  // previous one left off. Freshness window = half the tier-B cadence, so a
  // scheduler iteration overlapping a continuation chain just no-ops.
  const deadlineMs = Math.max(60_000, Number(src.meta.tier_b_deadline_ms ?? 600_000))
  const refreshMs = Math.max(3_600_000, (src.cadence_tier_b_seconds * 1000) / 2)
  const stalerThan = new Date(Date.now() - refreshMs)
  const contDepth = Number(job.data.contDepth ?? 0)

  const nativeCohort = await getLatestPassedNativeCohort(src, {
    excludeClaimed: true,
    profileCursor: { kind: PROFILED_CURSOR_KIND, stalerThan },
  })
  if (nativeCohort.missingTimeframes.length > 0) {
    logger.warn(
      `[tier-b] ${src.slug}: native cohort incomplete, missing PASSED board(s) ` +
        `[${nativeCohort.missingTimeframes.map((tf) => `${tf}d`).join(',')}]; ` +
        `crawling available native top-N only`
    )
  }

  const topTraders = shuffle(nativeCohort.traders)
  if (topTraders.length === 0) {
    if (nativeCohort.missingTimeframes.length === 0) {
      logger.info(`[tier-b] ${src.slug}: all top-${src.deep_profile_topn} fresh — nothing to crawl`)
    }
    return empty
  }

  // native ∪ derived: derived 30/90 boards are synthesized from these
  // profile stats (spec §1.1-C), so Tier-B must crawl their TFs too.
  const timeframes = supportsProfile ? profileTimeframes(src) : []
  const profileContract = supportsProfile ? getProfileCaptureContract(src.slug) : null
  // Tier A intentionally keeps the legacy unsuffixed profile (warm cookies).
  // Tier B owns a stable lane so a long profile crawl cannot collide with it.
  const session = await openSession(src, {
    profileLaneKey: 'tier-b',
    profileSuffix: 'tier-b',
  })
  const startedAt = Date.now()
  let attempted = 0
  const result: TierBResult = { ...empty }
  // Bounded retries: after TIER_B_MAX_FAILED_ATTEMPTS failed attempts the
  // trader waits for the next refresh window, then gets a fresh budget.
  const backOffAfterFailure = async (trader: NativeCohortTrader): Promise<void> => {
    const failures = await recordFailedAttempt(trader.id)
    if (failures < TIER_B_MAX_FAILED_ATTEMPTS) return
    logger.warn(
      `[tier-b] ${src.slug} trader ${trader.exchange_trader_id}: ${failures} failed ` +
        `attempts, backing off until the next refresh window`
    )
    await markProfileAttempted(trader.id)
    await clearFailedAttempts(trader.id)
  }

  try {
    for (const trader of topTraders) {
      // Yield the slot once the budget is spent (always ≥1 trader of progress
      // so a chain can never spin without advancing).
      if (attempted > 0 && Date.now() - startedAt > deadlineMs) break
      attempted += 1
      let terminalTimeframes = 0
      let successfulTimeframes = 0
      let traderHadQualityReject = false
      let traderHadOperationalError = false
      // Every operational error of this trader was a 404/410 "gone" response.
      let traderOnlyGoneErrors = true
      for (const timeframe of timeframes) {
        const evidenceAttempt = await beginProfileEvidence(
          src,
          trader.id,
          timeframe,
          profileContract
        )
        let stage: 'fetch' | 'raw' | 'parse' | 'publish' = 'fetch'
        let rawObjectId: number | null = null
        try {
          const scrapedAt = new Date().toISOString()
          const bundle = await adapter.getProfile(
            session,
            src,
            trader.exchange_trader_id,
            timeframe,
            trader.meta,
            { intent: 'scheduled_full' }
          )

          stage = 'raw'
          rawObjectId = (
            await writeRawObject({
              sourceId: src.id,
              sourceSlug: src.slug,
              jobType: 'tier_b',
              traderId: trader.id,
              timeframe,
              payload: bundle.pages,
              ...(evidenceAttempt ? { meta: profileCaptureRawMeta(evidenceAttempt.attempt) } : {}),
            })
          ).id
          stage = 'parse'

          // Upstream field radar (P1): 1-in-50 traders sample the profile
          // payload shape. Fire-and-forget — never breaks the crawl.
          if (attempted % 50 === 1 && bundle.pages.length > 0) {
            fireAndForget(
              recordFieldInventory(src.id, 'tier_b', bundle.pages[0].payload),
              `tier-b-field-inventory:${src.slug}`
            )
          }

          const ctx: ParseCtx = {
            sourceSlug: src.slug,
            currency: src.currency,
            tfLabelMap: src.tf_label_map,
            scrapedAt,
            meta: src.meta,
          }
          // Parse the complete logical surface before validating or publishing
          // any page. One bad page must quarantine the whole bundle rather than
          // leave a partially-published profile.
          let parsedPages: Array<{ page: RawPage; profile: ParsedProfile }>
          try {
            parsedPages = bundle.pages.map((page) => ({
              page,
              profile: adapter.parseProfile(page.payload, ctx),
            }))
          } catch (parseErr) {
            // The fetch counted these pages as successes; an HTTP-200 business
            // error must still count toward the cycle failure rate.
            getCircuit(src.slug).recordParseFailure()
            throw parseErr
          }
          const qualityRejects =
            parsedPages.length === 0
              ? [
                  {
                    reason: 'profile_payload_missing',
                    payload: {
                      source_slug: src.slug,
                      trader_id: trader.id,
                      exchange_trader_id: trader.exchange_trader_id,
                      timeframe,
                      scraped_at: scrapedAt,
                      page_count: 0,
                    },
                  },
                ]
              : parsedPages.flatMap(({ page, profile }) =>
                  (adapter.validateProfile?.(profile, ctx, timeframe, page.payload) ?? []).map(
                    (reject) => ({
                      reason: reject.reason,
                      payload: {
                        ...reject.payload,
                        source_slug: src.slug,
                        trader_id: trader.id,
                        exchange_trader_id: trader.exchange_trader_id,
                        timeframe,
                        scraped_at: scrapedAt,
                        page_index: page.pageIndex,
                      },
                    })
                  )
                )

          if (qualityRejects.length > 0) {
            await finishProfileEvidence(
              src,
              evidenceAttempt,
              profileOutcome(
                'quality_rejected',
                'quality_rejected',
                qualityRejects.map((reject) => reject.reason).join(',')
              ),
              rawObjectId
            )
            // The immutable RAW pointer exists. A durable reject makes this
            // timeframe terminal without allowing any serving/cache mutation.
            await recordStagingRejects(src.id, rawObjectId, qualityRejects)
            result.rejects += qualityRejects.length
            result.surfacesFetched += 1
            terminalTimeframes += 1
            traderHadQualityReject = true
            continue
          }

          const requiredFields = ((src.meta.profile_required_fields as string[]) ?? []) as Array<
            keyof ParsedStats
          >
          const evidence = await settleProfileEvidence(
            src,
            evidenceAttempt,
            trader.exchange_trader_id,
            bundle.pages,
            parsedPages.map(({ profile }) => profile),
            requiredFields,
            rawObjectId
          )
          stage = 'publish'

          for (const [profileIndex, { profile }] of parsedPages.entries()) {
            const incomplete = findIncompleteProfileWindow(profile)
            if (incomplete) {
              // RAW is already durable. Merge audit extras only, then surface
              // a real failure so this trader is not marked fresh.
              await publishProfile(src, trader.id, profile, { fullSeries: true })
              throw new IncompleteProfileWindowError(incomplete.timeframe, incomplete.reason)
            }
            const { valid, rejects, nulledMetrics } = validateStats(profile.stats, requiredFields)
            result.rejects += rejects.length
            result.nulledMetrics += await recordNulledStatMetrics(
              src,
              trader,
              rawObjectId,
              nulledMetrics,
              profileContract
            )

            // Cross-check (spec §5.3): board headline ROI must match the
            // profile ROI for the same TF within tolerance — catches stale
            // caches / wrong-timeframe clicks. Log-and-count, never block:
            // the board value stays authoritative for ranking either way.
            const headline = trader.headline_rois?.[String(timeframe)] ?? null
            const profileRoi = valid.find((b) => b.timeframe === timeframe)?.roi ?? null
            if (roiCrossCheckOk(headline, profileRoi) === false) {
              result.crossCheckFails += 1
              console.warn(
                `[tier-b] ${src.slug} ${trader.exchange_trader_id} ${timeframe}d ` +
                  `ROI cross-check FAIL: board=${headline} profile=${profileRoi}`
              )
            }

            await publishProfile(
              src,
              trader.id,
              { ...profile, stats: valid },
              {
                fullSeries: true, // Tier B = ranked/topN → full series (spec §13.1)
                // Only the publish of the block the capture attested stamps it.
                evidence: evidence?.profileIndex === profileIndex ? evidence.stats : null,
              }
            )
          }
          result.surfacesFetched += 1
          successfulTimeframes += 1
          terminalTimeframes += 1
        } catch (err) {
          await finishProfileEvidence(
            src,
            evidenceAttempt,
            stage === 'fetch'
              ? profileOutcome(
                  'upstream_failed',
                  err instanceof UpstreamGoneError ? 'upstream_gone' : 'upstream_error',
                  err instanceof Error ? err.message : String(err)
                )
              : profileOutcome(
                  'processing_failed',
                  stage === 'raw' ? 'raw_persistence_failed' : 'parse_failed',
                  err instanceof Error ? err.message : String(err)
                ),
            rawObjectId
          )
          traderHadOperationalError = true
          if (!(err instanceof UpstreamGoneError)) traderOnlyGoneErrors = false
          result.errors += 1
          console.warn(
            `[tier-b] ${src.slug} trader ${trader.exchange_trader_id} ${timeframe}d failed:`,
            err instanceof Error ? err.message : err
          )
        }
      }
      const allTimeframesTerminal =
        !supportsProfile || (timeframes.length > 0 && terminalTimeframes === timeframes.length)
      const allTimeframesSuccessful =
        allTimeframesTerminal &&
        !traderHadQualityReject &&
        !traderHadOperationalError &&
        (!supportsProfile || successfulTimeframes === timeframes.length)

      if (
        supportsProfile &&
        allTimeframesTerminal &&
        traderHadQualityReject &&
        !traderHadOperationalError
      ) {
        // Quality rejects are terminal for this pass: throttle the next attempt
        // so continuation jobs cannot hot-loop on a permanently bad upstream
        // payload. The compatibility cursor kind remains `tierb_profiled`.
        await markProfileAttempted(trader.id)
      } else if (supportsProfile && traderHadOperationalError && traderOnlyGoneErrors) {
        // 404/410 on every failing timeframe = deregistered/removed trader.
        // Back off to the next refresh window (same throttle as a quality
        // reject) instead of re-crawling it on every continuation hop (up to
        // MAX_CONT_DEPTH per cadence). Transient errors stay retryable.
        logger.warn(
          `[tier-b] ${src.slug} trader ${trader.exchange_trader_id}: upstream 404/410, ` +
            `backing off until the next refresh window`
        )
        await markProfileAttempted(trader.id)
      } else if (supportsProfile && traderHadOperationalError) {
        await backOffAfterFailure(trader)
      }

      if (allTimeframesSuccessful) {
        // Histories ride the same session right after the profile (spec §2.3).
        // The whole trader is fresh only after every declared surface finishes;
        // otherwise a failed copier receipt could be hidden for one cadence.
        try {
          const ctx: ParseCtx = {
            sourceSlug: src.slug,
            currency: src.currency,
            tfLabelMap: src.tf_label_map,
            scrapedAt: new Date().toISOString(),
            meta: src.meta,
          }
          result.historyRowsWritten += await crawlTraderHistories(
            session,
            adapter,
            src,
            trader,
            ctx,
            !supportsProfile
          )
          await markProfileAttempted(trader.id)
          if (trader.meta && FAILED_ATTEMPTS_META_KEY in trader.meta) {
            await clearFailedAttempts(trader.id)
          }
          result.tradersCrawled += 1
        } catch (err) {
          result.errors += 1
          console.warn(
            `[tier-b] ${src.slug} trader ${trader.exchange_trader_id} histories failed:`,
            err instanceof Error ? err.message : err
          )
          await backOffAfterFailure(trader)
        }
      }
    }
  } finally {
    await session.close()
    // Spec §4 per-cycle failure-rate alert (never throws).
    await closeCircuitCycle(src, 'B', { redis: getConnection })
  }

  result.remaining = topTraders.length - attempted
  if (result.remaining > 0) {
    if (contDepth < MAX_CONT_DEPTH) {
      // Same priority as the scheduler registration (6) — a continuation must
      // never jump the tier order (that inversion was the 2026-07-03 wedge).
      // Depth-scoped jobId preserves dedup within one hop while letting the
      // currently-active continuation enqueue its successor. Reusing one
      // source-only id made BullMQ return the active job as a duplicate, so
      // continuation chains silently stopped after their first hop.
      try {
        const nextDepth = contDepth + 1
        await getRegionQueue(src.fetch_region).add(
          INGEST_JOB.TIER_B,
          { sourceSlug: src.slug, contDepth: nextDepth } satisfies TierJobData,
          {
            priority: 6,
            jobId: `tierb-cont-${src.slug}-${nextDepth}`,
            delay: 5_000,
            removeOnComplete: true,
            removeOnFail: { age: 3600 },
          }
        )
      } catch (err) {
        console.warn(
          `[tier-b] ${src.slug} continuation enqueue failed (next cadence covers it):`,
          err instanceof Error ? err.message : err
        )
      }
    } else {
      console.warn(
        `[tier-b] ${src.slug}: continuation depth ${contDepth} hit cap ${MAX_CONT_DEPTH} ` +
          `with ${result.remaining} still stale — stopping chain (next cadence retries)`
      )
    }
  }

  logger.info(
    `[tier-b] ${src.slug}: ${result.tradersCrawled}/${attempted} attempted ok ` +
      `(${result.remaining} stale remaining${result.remaining > 0 ? `, continuation depth ${contDepth + 1}` : ''}), ` +
      `${result.surfacesFetched} surfaces, ${result.historyRowsWritten} history rows, ` +
      `${result.rejects} rejects, ${result.nulledMetrics} out-of-range metrics nulled, ` +
      `${result.crossCheckFails} xcheck-fails, ${result.errors} errors`
  )
  return result
}
