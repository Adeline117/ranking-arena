/**
 * Cron: Compute `leaderboard_ranks` from canonical `arena_score_inputs`.
 * Schedule: each season every 2 hours via the BullMQ worker, with an
 * authenticated Vercel watchdog as a safety net.
 *
 * For each season (7D, 30D, 90D):
 * 1. Fetch the publication-fenced Arena score input bundle
 * 2. Calculate arena_score
 * 3. Enrich display metadata and derived metrics
 * 4. Rank and upsert into leaderboard_ranks
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { getReadReplica } from '@/lib/supabase/read-replica'
import { type Period } from '@/lib/utils/arena-score'
import { createLogger } from '@/lib/utils/logger'
import {
  warmupSsrHomepageCache,
  revalidateRankingPages,
  warmupLeaderboardCache,
} from './post-processing'
import { type TraderRow, makeAddToTraderMap, sanitizeTraderRow } from './trader-row'
import { computeLastResortCalmar, classifyTradingStyle } from './scoring-helpers'
import { checkPlatformFreshness } from './freshness-check'
import { fetchHandleAvatarMap } from './fetch-handles'
import { enrichFromStatsDetail } from './enrich-stats-detail'
import { deriveWrMddFromEquityCurve, deriveAdvancedFromEquityCurve } from './enrich-equity-curve'
import { deriveAdvancedFromDailySnapshots } from './enrich-daily-snapshots'
import { runPhase1, getPhase1ReadSource } from './phase1-select'
import { rerankAllRows, atomicPlatformCleanup } from './rerank-cleanup'
import { scoreTraders } from './score-traders'
import { checkDegradationGuard } from './degradation-guard'
import { fetchCurrentScoreMap, buildChangedTraders } from './incremental-diff'
import { upsertLeaderboard, upsertSourceFreshness, zeroOutExcluded } from './write-leaderboard'
import { acquireLeaderboardRunLease } from './run-lease'
import { assertRankPublicationDatabaseContract } from './database-contract'
import {
  hasComputeFailures,
  isCompleteDatabaseFinalizationRun,
  type ComputeResult,
  type ComputeSeasonOutcome,
} from './result-status'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { tieredGetRequired, tieredSetRequired } from '@/lib/cache/redis-layer'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { MIN_TRADES } from '@/lib/constants/trader-thresholds'
import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// detectTraderType lives in ./helpers.ts as the single source of truth.

const logger = createLogger('compute-leaderboard')

const SEASONS: Period[] = ['7D', '30D', '90D']
const LEADERBOARD_CHECKPOINT_CONTRACT = 'publication-v2'

function leaderboardCheckpointKey(season: string, now = new Date()): string {
  return `leaderboard:computed:${LEADERBOARD_CHECKPOINT_CONTRACT}:${season}:${now.toISOString().slice(0, 13)}`
}
// H-7: Use centralized threshold from lib/constants/trader-thresholds.ts
// Previously hardcoded as 5 here vs 10 in lib/utils/ranking.ts — now unified to MIN_TRADES (10).
// DEGRADATION_THRESHOLD moved to degradation-guard.ts

// P1-3: ROI anomaly thresholds per period
// Must align with arena-score.ts ROI_CAP (10000). Previously 90D was 50000,
// allowing absurd Bitfinex/Hyperliquid ROI through.
const ROI_ANOMALY_THRESHOLDS: Record<Period, number> = {
  '7D': 2000,
  '30D': 5000,
  '90D': 10000,
}

export async function GET(request: NextRequest) {
  // Verify cron secret (timing-safe)
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Accept ?season=7D|30D|90D to process a single season (staggered cron)
  // When no season param, process all seasons (fallback / legacy behavior)
  const seasonParam = request.nextUrl.searchParams.get('season')?.toUpperCase() as
    | Period
    | undefined
  const targetSeasons: Period[] =
    seasonParam && SEASONS.includes(seasonParam) ? [seasonParam] : SEASONS

  // Every invocation owns the same global publication surface. The lease
  // serializes even disjoint single-season runs because cache invalidation and
  // public markers are shared across seasons.
  const lockSuffix = targetSeasons.length === 1 ? `:${targetSeasons[0]}` : ''
  const leaseResult = await acquireLeaderboardRunLease(targetSeasons)
  if (!leaseResult.acquired) {
    const contended = leaseResult.reason === 'contended'
    logger.warn(
      `[compute-leaderboard] run lease withheld (${leaseResult.reason})${
        leaseResult.error ? `: ${leaseResult.error}` : ''
      }`
    )
    return NextResponse.json(
      contended
        ? {
            ok: false,
            error: `Leaderboard publication still running (owner-token lease${lockSuffix})`,
            publication_pending: true,
            lock_reason: leaseResult.reason,
          }
        : {
            ok: false,
            error: 'Leaderboard run lease unavailable',
            lock_reason: leaseResult.reason,
          },
      { status: contended ? 423 : 503 }
    )
  }
  const runLease = leaseResult.lease

  let plog: Awaited<ReturnType<typeof PipelineLogger.start>> | undefined
  try {
    const supabase = getSupabaseAdmin()
    // Migration-first deploy gate. These invalid-argument probes perform no
    // writes and must prove both new RPC identities through PostgREST before
    // any live leaderboard mutation can begin.
    await assertRankPublicationDatabaseContract(supabase)
    const readDb = getReadReplica() // Read replica for SELECT queries (falls back to primary if not configured)
    const startTime = Date.now()
    const stats = { seasons: {} as Record<string, number> }
    const warnings: string[] = []
    const unsealedSeasons: string[] = []
    plog = await PipelineLogger.start(`compute-leaderboard${lockSuffix}`)

    // P0-2: Record current counts from pre-computed cache (instant)
    // PERF FIX: was count:exact (25s+ per season × 3 = 75s wasted)
    const previousCounts: Record<string, number> = {}
    for (const season of targetSeasons) {
      const { data: cacheRow } = await readDb
        .from('leaderboard_count_cache')
        .select('total_count')
        .eq('season_id', season)
        .eq('source', '_all')
        .maybeSingle()
      previousCounts[season] = cacheRow?.total_count || 0
    }

    const forceWrite = request.nextUrl.searchParams.get('force') === '1'

    // A forced repair must retire any successful checkpoint from an earlier
    // run in the same hour before the first database mutation. Required reads
    // below bypass process memory, so every later instance observes this
    // shared tombstone and recomputes after a failed force run.
    if (forceWrite) {
      await Promise.all(
        targetSeasons.map((season) =>
          tieredSetRequired(
            leaderboardCheckpointKey(season),
            { count: 0, invalidatedAt: new Date().toISOString() },
            'warm',
            ['leaderboard', `season:${season}`]
          )
        )
      )
    }

    // Checkpoints are a target-set decision, never a per-season branch inside
    // the write loop. All targets hit => the whole invocation is cached. A
    // partial hit is ignored and every target is recomputed, preventing a
    // checkpoint_skip + published mixed run that mutates DB but cannot publish
    // coherent authority/cache state.
    if (!forceWrite) {
      const checkpointHits = new Map<Period, number>()
      try {
        const checkpointReads = await Promise.all(
          targetSeasons.map(async (season) => ({
            season,
            checkpoint: await tieredGetRequired<{ count: number }>(
              leaderboardCheckpointKey(season)
            ),
          }))
        )
        for (const { season, checkpoint } of checkpointReads) {
          const count = checkpoint?.count
          if (typeof count === 'number' && Number.isSafeInteger(count) && count > 0) {
            checkpointHits.set(season, count)
          }
        }
      } catch (error) {
        logger.warn(
          `Target-set checkpoint read failed; recomputing all targets: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }

      if (checkpointHits.size === targetSeasons.length) {
        for (const season of targetSeasons) {
          stats.seasons[season] = checkpointHits.get(season) as number
        }
        const totalRanked = Object.values(stats.seasons).reduce((sum, count) => sum + count, 0)
        await plog.success(totalRanked, { stats, cached: true })
        return NextResponse.json({
          ok: true,
          cached: true,
          message: 'All requested seasons already published this hour',
          stats,
          previous_counts: previousCounts,
          publication_status: Object.fromEntries(
            targetSeasons.map((season) => [season, 'checkpoint_skip'])
          ),
        })
      }
      if (checkpointHits.size > 0) {
        logger.info(
          `Ignoring partial target-set checkpoints (${[...checkpointHits.keys()].join(',')}); recomputing ${targetSeasons.join(',')}`
        )
      }
    }

    // Compute target seasons (single season when staggered, all when fallback)
    // Shared deadline: leave 30s at the end for finalization + post-processing.
    // When one season runs alone (staggered case), it gets the full budget.
    const computeDeadline = startTime + (maxDuration - 30) * 1000
    // PERF FIX: sequential instead of parallel to prevent connection pool saturation.
    // With staggered cron (single season per invocation), this loop runs once.
    // The parallel path caused 3× peak connection usage → pool exhaustion → 30-57min timeouts.
    const results: ComputeResult[] = []
    for (const season of targetSeasons) {
      try {
        const outcome = await computeSeason(supabase, season, forceWrite, computeDeadline)
        results.push({ season, ...outcome, error: null })
      } catch (err) {
        logger.error(`[${season}] computeSeason failed:`, err)
        results.push({ season, count: -1, status: 'failed', error: err })
      }
    }

    for (const { season, count, error, status } of results) {
      stats.seasons[season] = count

      if (error) {
        const msg = `${season}: computation FAILED — ${String(error)}`
        warnings.push(msg)
        unsealedSeasons.push(season)
      } else if (status === 'degradation_skip') {
        // Retry on the next cron, but never auto-force a degraded publication.
        // Only treat the preserved last-good board as a warning here.
        const msg = `${season}: degradation detected, upsert SKIPPED (table: ${previousCounts[season]})`
        warnings.push(msg)
        unsealedSeasons.push(season)
        stats.seasons[season] = previousCounts[season] // Keep old count in stats
      } else if (status === 'no_candidates') {
        const msg = `${season}: no eligible publication candidates; publication withheld`
        warnings.push(msg)
        unsealedSeasons.push(season)
      }
    }

    // A single failed, skipped, empty, missing, or duplicate season makes the
    // database-finalization set incomplete. Count authority, last-success, and
    // public caches must continue describing the last fully published run.
    const databaseFinalizationComplete = isCompleteDatabaseFinalizationRun(results, targetSeasons)
    if (!databaseFinalizationComplete && warnings.length === 0) {
      warnings.push(
        `Leaderboard invocation incomplete: ${results
          .map(({ season, status }) => `${season}=${status}`)
          .join(', ')}`
      )
    }

    // POST-COMPUTE ASSERTION: verify leaderboard_ranks is not empty.
    // ROOT CAUSE FIX for 12-day empty homepage (2026-05-19): missing DEFAULT nextval()
    // on partition id column caused silent upsert failures. This assertion catches any
    // future scenario where compute "succeeds" but writes 0 rows.
    if (results.length > 0 && results.every((r) => r.status === 'no_candidates')) {
      const assertionMsg = `CRITICAL: compute-leaderboard completed but ranked 0 traders across all seasons. Likely silent upsert failure (check DB constraints, partition defaults).`
      logger.error(assertionMsg)
      warnings.push(assertionMsg)
      try {
        const { count: dbCount } = await supabase
          .from('leaderboard_ranks')
          .select('id', { count: 'exact', head: true })
          .eq('season_id', targetSeasons[0])
          .not('arena_score', 'is', null)
        if (dbCount === 0) {
          warnings.push(
            `DB CONFIRM: leaderboard_ranks has 0 rows for ${targetSeasons[0]}. Data pipeline is broken.`
          )
        }
      } catch {
        // Non-critical — the assertion warning above is sufficient
      }
    }

    const elapsed = Date.now() - startTime
    logger.info(`Leaderboard computed in ${elapsed}ms`, stats)

    // Time budget: skip non-critical post-processing if <60s remaining (prevents 300s timeout)
    const TIME_BUDGET_MS = (maxDuration - 20) * 1000 // 280s safety margin
    const remainingMs = () => TIME_BUDGET_MS - (Date.now() - startTime)

    // Refresh count authority only after every requested season completed its
    // live-table finalization. A mixed/partial board must never become the next
    // degradation baseline.
    let publicationAuthorityReady = databaseFinalizationComplete
    if (databaseFinalizationComplete && remainingMs() > 30_000) {
      try {
        const { error: refreshError } = await supabase.rpc(
          'refresh_public_rank_count_cache_for_seasons',
          { p_season_ids: targetSeasons }
        )
        if (refreshError) {
          throw new Error(refreshError.message || 'unknown count authority refresh error')
        }
        logger.info(`Refreshed leaderboard_count_cache for ${targetSeasons.join(',')}`)
      } catch (cacheErr) {
        publicationAuthorityReady = false
        const message = `Leaderboard database finalization completed, but count authority refresh failed: ${
          cacheErr instanceof Error ? cacheErr.message : String(cacheErr)
        }`
        logger.error(message)
        warnings.push(message)
      }
    } else if (databaseFinalizationComplete) {
      publicationAuthorityReady = false
      const message = `Leaderboard database finalization completed, but count authority refresh was withheld — only ${Math.round(remainingMs() / 1000)}s remaining`
      logger.error(message)
      warnings.push(message)
    } else {
      logger.warn('Withholding leaderboard_count_cache refresh after incomplete publication run')
    }

    // leaderboard_ranks is the canonical score and sub-score store.

    // A publication remains under the owner-token lease until every cache
    // mutation settles. Invalidate first, then warm the new generation; this
    // prevents an old fire-and-forget task from racing a later publication or
    // deleting keys that the same run just warmed.
    let publicationSurfaceReady = publicationAuthorityReady
    if (publicationAuthorityReady) {
      try {
        await revalidateRankingPages(runLease)
      } catch (error) {
        publicationSurfaceReady = false
        warnings.push(
          `Leaderboard cache invalidation/revalidation failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }

      if (publicationSurfaceReady) {
        const cacheTasks: Array<{ label: string; promise: Promise<void> }> = [
          {
            label: 'leaderboard cache warmup',
            // Invalidation is global, so every default season must be restored
            // even when this invocation only recomputed one season.
            promise: warmupLeaderboardCache(supabase, SEASONS),
          },
          {
            label: 'SSR homepage cache warmup',
            promise: warmupSsrHomepageCache(),
          },
        ]

        const cacheResults = await Promise.allSettled(cacheTasks.map(({ promise }) => promise))
        for (const [index, result] of cacheResults.entries()) {
          if (result.status === 'rejected') {
            publicationSurfaceReady = false
            warnings.push(
              `${cacheTasks[index].label} failed: ${
                result.reason instanceof Error ? result.reason.message : String(result.reason)
              }`
            )
          }
        }
      } else {
        logger.warn('Withholding cache warmup because shared invalidation did not complete')
      }
    } else {
      logger.warn('Withholding leaderboard cache warmup/revalidation after incomplete publication')
    }

    // Record last-known-good markers independently per season only after the
    // database authority and public cache surface both completed. The hourly
    // checkpoint is deliberately last: if a durable marker fails, the next
    // invocation must recompute instead of skipping the repair.
    if (publicationSurfaceReady) {
      try {
        await Promise.all(
          results.map((result) =>
            tieredSetRequired(
              `leaderboard:last-success:${result.season}`,
              {
                timestamp: new Date().toISOString(),
                season: result.season,
                traderCount: result.count,
              },
              'warm',
              ['leaderboard', `season:${result.season}`]
            )
          )
        )
      } catch (error) {
        publicationSurfaceReady = false
        warnings.push(
          `Failed to write a durable per-season leaderboard:last-success marker: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }

    if (publicationSurfaceReady) {
      try {
        await Promise.all(
          results.map((result) =>
            tieredSetRequired(
              leaderboardCheckpointKey(result.season),
              { count: result.count, at: new Date().toISOString() },
              'warm',
              ['leaderboard', `season:${result.season}`]
            )
          )
        )
      } catch (error) {
        publicationSurfaceReady = false
        warnings.push(
          `Failed to write the final post-publication checkpoint: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }

    // Any failure after live-table DML leaves the generation unpublished even
    // though database rows may already have changed. Make that distinction
    // explicit to operators and downstream triggers.
    if (!publicationSurfaceReady) {
      for (const season of targetSeasons) {
        if (!unsealedSeasons.includes(season)) unsealedSeasons.push(season)
      }
    }

    // Alert after every publication surface has settled so cache failures are
    // included in the same rate-limited trust incident.
    if (warnings.length > 0) {
      try {
        await sendRateLimitedAlert(
          {
            title: '排行榜发布可信度告警',
            message: warnings.join('\n'),
            level: 'critical',
            details: { seasons_affected: unsealedSeasons.join(', ') },
          },
          'leaderboard:publication-trust',
          6 * 60 * 60 * 1000
        )
      } catch (error) {
        logger.error('[compute-leaderboard] 告警发送失败:', error)
      }
    }

    const totalRanked = Object.values(stats.seasons).reduce((a, b) => a + b, 0)
    // Distinguish computation failures from safe last-good degradation skips.
    const hasRealFailures =
      hasComputeFailures(results) ||
      results.some((result) => result.status === 'no_candidates') ||
      (!databaseFinalizationComplete &&
        results.some((result) => result.status === 'database_finalized')) ||
      (databaseFinalizationComplete && !publicationSurfaceReady)
    if (hasRealFailures) {
      // Real computation failure — report as error
      await plog.error(new Error(warnings.join('; ')), { stats, unsealedSeasons })
    } else if (warnings.length > 0) {
      // Safe skips retain the last-good public state and retry on the next run.
      await plog.success(totalRanked, {
        stats,
        warnings,
        unsealedSeasons,
        note: 'incomplete runs preserve last-good authority and public caches',
      })
    } else {
      await plog.success(totalRanked, { stats })
    }

    return NextResponse.json(
      {
        ok: !hasRealFailures && warnings.length === 0,
        elapsed_ms: elapsed,
        // Expose the authoritative Phase-1 reader in response metadata.
        read_source: getPhase1ReadSource(),
        stats,
        previous_counts: previousCounts,
        publication_status: Object.fromEntries(
          results.map((result) => [
            result.season,
            publicationSurfaceReady && result.status === 'database_finalized'
              ? 'published'
              : result.status,
          ])
        ),
        warnings: warnings.length > 0 ? warnings : undefined,
        publication_unsealed: unsealedSeasons.length > 0 ? unsealedSeasons : undefined,
      },
      { status: hasRealFailures ? 500 : 200 }
    )
  } catch (error: unknown) {
    logger.error('Failed to compute leaderboard', error)
    await plog?.error(error)
    return NextResponse.json({ error: 'Compute failed', detail: String(error) }, { status: 500 })
  } finally {
    const releaseResult = await runLease.release()
    if (!releaseResult.released) {
      logger.error('[compute-leaderboard] run lease release was not confirmed', releaseResult)
    }
  }
}

async function computeSeason(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  season: Period,
  forceWrite?: boolean,
  deadlineMs: number = Date.now() + 270_000
): Promise<ComputeSeasonOutcome> {
  // Deadline helpers — any phase can call these to abort early when time runs out.
  // Prevents cumulative Phase 3/4/4b/4b2 enrichment queries from blowing past
  // Vercel's 300s maxDuration and leaving pipeline_logs as 'running' until
  // cleanup-stuck-logs sweeps them 30 min later.
  const timeLeftMs = () => deadlineMs - Date.now()
  const isOutOfTime = (minMs: number = 10_000) => timeLeftMs() < minMs

  // Upsert abort flag (set inside the upsert loop when time runs out, consumed
  // by the zero-out phase below to skip its expensive N+1 cleanup path).
  let upsertAborted = false
  // Stream directly into traderMap instead of accumulating allSnapshots array
  // This reduces peak memory from ~200MB to ~50MB by avoiding intermediate array.
  // TraderRow shape + addToTraderMap sanitize/merge logic live in ./trader-row.ts.
  const traderMap = new Map<string, TraderRow>()
  const addToTraderMap = makeAddToTraderMap(traderMap)

  // Phase 1: fetch the canonical, publication-fenced Arena score inputs. The
  // retired trader_latest/diff cutover readers cannot be selected at runtime.
  await runPhase1(supabase, season, traderMap, addToTraderMap)

  // Log per-source counts from the canonical bundle to diagnose missing platforms.
  const sourceCounts = new Map<string, number>()
  for (const t of traderMap.values()) {
    sourceCounts.set(t.source, (sourceCounts.get(t.source) || 0) + 1)
  }
  const jupiterCount = sourceCounts.get('jupiter_perps') || 0
  logger.info(
    `[${season}] ${traderMap.size} unique traders from arena_score_inputs (jupiter_perps: ${jupiterCount}, sources: ${sourceCounts.size})`
  )

  // Window coverage is owned by the ingest adapter and RAW-to-canonical
  // publication flow; ranking computation only consumes the published rows.

  // Data freshness check: classify each source as fresh / stale / query-failed.
  // If ALL platforms are stale (>48h) we skip computation to avoid publishing
  // a stale leaderboard. Logic lives in freshness-check.ts.
  const { expectedPlatforms, freshPlatforms, stalePlatforms, queryFailedPlatforms } =
    await checkPlatformFreshness(supabase, traderMap, season)

  if (queryFailedPlatforms.length > 0) {
    logger.warn(
      `[${season}] ${queryFailedPlatforms.length} platforms had query failures but DB has fresh data: ${queryFailedPlatforms.join(', ')}`
    )
  }

  if (freshPlatforms.length === 0 && expectedPlatforms.length > 0) {
    if (queryFailedPlatforms.length > 0) {
      logger.error(
        `[${season}] No fresh platforms loaded but ${queryFailedPlatforms.length} had DB fresh-data (query failures). Transient Supabase issue — skipping this run.`,
        { queryFailedPlatforms, stalePlatforms }
      )
      throw new Error(
        `Query failures prevented loading ${queryFailedPlatforms.length} fresh platforms — will retry next cron cycle.`
      )
    }
    logger.error(
      `[${season}] ALL platforms are stale (>48h). Skipping computation to prevent stale leaderboard.`,
      { stalePlatforms }
    )
    throw new Error(
      `All ${stalePlatforms.length} platforms are stale (>48h). Blocking computation.`
    )
  }

  if (stalePlatforms.length > 0) {
    logger.warn(
      `[${season}] ${stalePlatforms.length} platforms have stale data (>48h): ${stalePlatforms.join(', ')}. Computing with ${freshPlatforms.length} fresh platforms.`
    )
  }

  // Phase 3: Fill optional missing metrics from existing trader_stats_detail
  // evidence. This fallback does not establish source freshness or publication
  // authority. Logic lives in enrich-stats-detail.ts.
  if (isOutOfTime(90_000)) {
    logger.warn(
      `[${season}] SKIPPING Phase 3 (stats_detail enrichment) — only ${Math.round(timeLeftMs() / 1000)}s left`
    )
  } else {
    const enrichedCount = await enrichFromStatsDetail(supabase, traderMap, season, isOutOfTime)
    if (enrichedCount > 0) {
      logger.info(`[${season}] Enriched ${enrichedCount} traders from stats_detail`)
    }
  }

  // Phase 4: Derive win_rate/max_drawdown from trader_equity_curve (daily PnL).
  // Universal fallback for platforms that don't provide WR/MDD natively.
  // Logic in enrich-equity-curve.ts.
  if (isOutOfTime(75_000)) {
    logger.warn(
      `[${season}] SKIPPING Phase 4 (equity_curve WR/MDD derivation) — only ${Math.round(timeLeftMs() / 1000)}s left`
    )
  } else {
    const derived = await deriveWrMddFromEquityCurve(supabase, traderMap, isOutOfTime)
    if (derived > 0) {
      logger.info(`[${season}] Derived ${derived} WR/MDD values from equity curves`)
    }
  }

  // Phase 4b: Compute sharpe / sortino / calmar / profit_factor from
  // trader_equity_curve. Also estimates trades_count from equity-curve point
  // count for platforms that don't return one. Logic in enrich-equity-curve.ts.
  if (isOutOfTime(60_000)) {
    logger.warn(
      `[${season}] SKIPPING Phase 4b (advanced metrics from equity_curve) — only ${Math.round(timeLeftMs() / 1000)}s left`
    )
  } else {
    const advancedDerived = await deriveAdvancedFromEquityCurve(
      supabase,
      traderMap,
      season,
      isOutOfTime
    )
    if (advancedDerived > 0) {
      logger.info(
        `[${season}] Derived ${advancedDerived} sharpe/sortino/calmar/PF/trades values from equity curves`
      )
    }
  }

  // Phase 4b2: Fallback — compute advanced metrics from trader_daily_snapshots
  // for traders still missing them after Phase 4b. Catches traders below the
  // top-N enrichment cut-off whose equity_curve is empty. Logic in
  // enrich-daily-snapshots.ts.
  if (isOutOfTime(50_000)) {
    logger.warn(
      `[${season}] SKIPPING Phase 4b2 (advanced metrics from daily_snapshots) — only ${Math.round(timeLeftMs() / 1000)}s left`
    )
  } else {
    const dailyDerived = await deriveAdvancedFromDailySnapshots(
      supabase,
      traderMap,
      season,
      isOutOfTime
    )
    if (dailyDerived > 0) {
      logger.info(
        `[${season}] Derived ${dailyDerived} sharpe/sortino/calmar/PF values from daily_snapshots (fallback)`
      )
    }
  }

  // Phase 4b3: Last resort — compute calmar from ROI + MDD for any trader
  // still missing it after Phases 4 / 4b / 4b2. Pure mutation in scoring-helpers.
  {
    const calmarOnly = computeLastResortCalmar(traderMap, season)
    if (calmarOnly > 0) {
      logger.info(
        `[${season}] Computed ${calmarOnly} calmar ratios from ROI/MDD (no daily returns needed)`
      )
    }
  }

  // Phase 4c: Classify trading_style from avg_holding_hours / trades_per_day
  // / risk-profile fallback ladder. Pure mutation in scoring-helpers.
  classifyTradingStyle(traderMap, season)

  // Phase 5 removed: WR/MDD estimation from ROI was mathematically incorrect
  // (e.g. 100% ROI does not imply 73% win rate). Traders with missing WR/MDD
  // are naturally penalized by the Wilson confidence multiplier in scoring.
  // win_rate and max_drawdown are left as null when not available from real API data.

  const roiThreshold = ROI_ANOMALY_THRESHOLDS[season]
  const freshPlatformSet = new Set(freshPlatforms)
  const uniqueTraders = Array.from(traderMap.values())
    // Stale sources keep their prior public rows and watermark. They must not
    // be rescored from old input while fresh sources advance independently.
    .filter((t) => freshPlatformSet.has(t.source))
    .filter((t) => t.source !== 'web3_bot') // DeFi protocol contracts, not real traders — exclude entirely
    .filter((t) => t.roi != null)
    .filter((t) => Math.abs(t.roi!) <= roiThreshold)
    .filter((t) => t.roi! > -90) // 过滤已爆仓交易员（ROI < -90%），无参考价值
    .filter((t) => t.trades_count == null || t.trades_count === 0 || t.trades_count >= MIN_TRADES) // 0 = unknown (API doesn't provide), treat same as null

  // Re-apply boundary + contradiction sanitization AFTER all enrichment (Phases 3–4b3).
  // The enrich steps (stats_detail / equity-curve / daily-snapshots) write win_rate /
  // MDD / sharpe directly into traderMap, bypassing the intake sanitizer in
  // addToTraderMap. Without this second pass, a profitable trader can carry a
  // contradictory 99.x% MDD or 0% win_rate into BOTH scoring and serving.
  for (const t of uniqueTraders) sanitizeTraderRow(t)

  // Debug: jupiter_perps filter analysis
  const jupiterInMap = Array.from(traderMap.values()).filter((t) => t.source === 'jupiter_perps')
  const jupiterWithRoi = jupiterInMap.filter((t) => t.roi != null)
  const jupiterPassAll = uniqueTraders.filter((t) => t.source === 'jupiter_perps')
  if (jupiterInMap.length > 0 || jupiterPassAll.length > 0) {
    logger.info(
      `[${season}] jupiter_perps filter: inMap=${jupiterInMap.length}, hasRoi=${jupiterWithRoi.length}, passAll=${jupiterPassAll.length}, roiThreshold=${roiThreshold}`
    )
    if (jupiterInMap.length > 0 && jupiterPassAll.length === 0) {
      const sample = jupiterInMap[0]
      logger.warn(
        `[${season}] jupiter_perps SAMPLE: roi=${sample.roi} (type=${typeof sample.roi}), trades=${sample.trades_count} (type=${typeof sample.trades_count})`
      )
    }
  }

  if (!uniqueTraders.length) {
    logger.warn(
      `[${season}] No traders passed filters! traderMap.size=${traderMap.size}, roiThreshold=${roiThreshold}`
    )
    return { count: 0, status: 'no_candidates' }
  }

  // Prefetch on-chain contract detection results from trader_sources.
  // Used by detectTraderType as ground-truth Layer 1 (eth_getCode).
  const contractAddresses = new Set<string>()
  try {
    // is_contract: ground-truth contract flag on trader_sources (now in generated types).
    const { data: contracts } = await supabase
      .from('trader_sources')
      .select('source_trader_id')
      .eq('is_contract', true)
    if (contracts) {
      for (const c of contracts) contractAddresses.add(c.source_trader_id)
    }
    if (contractAddresses.size > 0) {
      logger.info(`[${season}] Loaded ${contractAddresses.size} known contract addresses`)
    }
  } catch (e) {
    logger.warn(`[${season}] Failed to prefetch contract addresses (non-critical):`, e)
  }

  // Batch fetch handles + avatars: trader_profiles_v2 primary, traders table
  // fallback for any key still missing a handle. Logic in fetch-handles.ts.
  const handleMap = await fetchHandleAvatarMap(supabase, uniqueTraders)

  // Calculate arena scores, mark outliers, apply followers, filter nulls
  const { scored, scoredFiltered } = await scoreTraders(
    uniqueTraders,
    handleMap,
    contractAddresses,
    season,
    supabase
  )

  // Application array order is never rank authority. The database finalizer
  // owns the established score -> persisted-id order after all row mutations.

  const scoredCountBySource = new Map<string, number>()
  for (const trader of scoredFiltered) {
    scoredCountBySource.set(trader.source, (scoredCountBySource.get(trader.source) ?? 0) + 1)
  }
  const freshRankingPlatforms = [
    ...new Set(freshPlatforms.filter((source) => isPublicRankingSourceAllowed(source))),
  ]
  // Publication freshness describes the complete source board, including a
  // fresh source that legitimately yields zero rank-eligible rows. Derive it
  // from the Phase-1 board evidence, never from the scored subset.
  const freshSourceEvidence = [...traderMap.values()]
    .filter((trader) => freshRankingPlatforms.includes(trader.source))
    .map((trader) => ({
      source: trader.source,
      source_as_of: trader.source_board_as_of,
    }))

  // Degradation guard: prevent bad data from overwriting good leaderboard data
  const degradation = await checkDegradationGuard({
    supabase,
    season,
    // Only the actual publication cohort can satisfy the last-good coverage
    // gate. Partial/untrusted rows in `scored` must not pad this count.
    scoredCount: scoredFiltered.length,
    freshPlatforms: freshRankingPlatforms,
    forceWrite: forceWrite || false,
    scoredCountBySource,
  })
  if (degradation.action === 'skip') return { count: -1, status: 'degradation_skip' }

  // Phase 2: Incremental upsert — only update changed serving fields. The
  // database finalizer owns rank and scrubs unversioned movement to unknown.
  const currentScoreMap = await fetchCurrentScoreMap(supabase, season, isOutOfTime)
  const { changedTraders, prevRankMap } = buildChangedTraders(
    scoredFiltered,
    currentScoreMap,
    season
  )

  // Do not begin a legacy multi-call write when the required finalization
  // reserve is already gone. Once the first row is written, every required
  // step below must either complete or throw before database finalization.
  if (isOutOfTime(35_000)) {
    throw new Error(
      `[${season}] insufficient time to begin leaderboard publication (${Math.round(timeLeftMs() / 1000)}s remaining)`
    )
  }

  let upsertErrors = 0
  // Upsert changed rows + zero out excluded traders. Cross-request mutual
  // exclusion is owned by the owner-token Redis run lease. The retired
  // session-level advisory RPC could not span PostgREST requests and therefore
  // did not protect this multi-call publication.
  const upsertResult = await upsertLeaderboard({
    supabase,
    season,
    changedTraders,
    prevRankMap,
    isOutOfTime,
    timeLeftMs,
  })
  upsertErrors = upsertResult.upsertErrors
  upsertAborted = upsertResult.upsertAborted

  // Some rows may already have been updated by the legacy batch writer; the
  // staging/atomic finalizer remains the follow-up for byte-for-byte atomicity.
  // Never bless that mixed state as a successful publication.
  if (upsertAborted || upsertErrors > 0) {
    throw new Error(
      `[${season}] leaderboard upsert incomplete (aborted=${upsertAborted}, errors=${upsertErrors}); database finalization withheld`
    )
  }

  await zeroOutExcluded({
    supabase,
    season,
    uniqueTraders,
    traderMap,
    freshPlatforms: freshRankingPlatforms,
    isOutOfTime,
    upsertAborted,
    timeLeftMs,
  })

  if (isOutOfTime(15_000)) {
    throw new Error(
      `[${season}] insufficient time for required platform cleanup (${Math.round(timeLeftMs() / 1000)}s remaining)`
    )
  }

  // Delete obsolete rows before re-ranking so the final rank sequence has no
  // gaps. Stale/query-failed sources remain untouched.
  const scoredTradersByPlatform = new Map<string, string[]>(
    freshRankingPlatforms.map((source) => [source, []])
  )
  for (const trader of scoredFiltered) {
    const ids = scoredTradersByPlatform.get(trader.source) ?? []
    ids.push(trader.source_trader_id)
    scoredTradersByPlatform.set(trader.source, ids)
  }
  const atomicCleaned = await atomicPlatformCleanup(
    supabase,
    season,
    freshRankingPlatforms,
    scoredTradersByPlatform
  )
  if (atomicCleaned > 0) {
    logger.info(
      `${season}: atomic cleanup removed ${atomicCleaned} zombie rows from fresh platforms`
    )
  }

  if (isOutOfTime(10_000)) {
    throw new Error(
      `[${season}] insufficient time for required re-rank (${Math.round(timeLeftMs() / 1000)}s remaining)`
    )
  }
  await rerankAllRows(supabase, season)

  // Legacy source watermarks are a required database-finalization gate, not an
  // atomic publication seal. Missing/invalid evidence or a database error must
  // throw and withhold every later authority/cache marker.
  const watermarksWritten = await upsertSourceFreshness({
    supabase,
    season,
    expectedSources: freshRankingPlatforms,
    sourceEvidence: freshSourceEvidence,
  })
  logger.info(`[${season}] finalized ${watermarksWritten} source freshness watermarks`)

  const actualUpserted = scoredFiltered.length - upsertErrors
  logger.info(
    `${season}: ranked ${scoredFiltered.length} traders (${scored.length} total scored, ${scored.length - scoredFiltered.length} zero-score excluded, ${upsertErrors} upsert errors)`
  )

  return { count: actualUpserted, status: 'database_finalized' }
}

/**
 * Pre-populate Redis with top 100 leaderboard rows for each season.
 * Runs as fire-and-forget after leaderboard computation so it doesn't
 * block the cron response. TTL = 30 min (matches cron schedule).
 */
// warmupLeaderboardCache extracted to ./post-processing.ts
