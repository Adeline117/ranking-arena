/**
 * Cron: Compute leaderboard_ranks from trader_snapshots
 * Schedule: Every hour (0 * * * *)
 *
 * For each season (7D, 30D, 90D):
 * 1. Fetch latest trader_snapshots per source+source_trader_id
 * 2. Calculate arena_score
 * 3. Join trader_sources for handle/avatar
 * 4. Rank and upsert into leaderboard_ranks
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getReadReplica } from '@/lib/supabase/read-replica'
import { type Period } from '@/lib/utils/arena-score'
import { createLogger, fireAndForget } from '@/lib/utils/logger'
import {
  warmupSsrHomepageCache,
  syncRedisSortedSet,
  revalidateRankingPages,
  warmupLeaderboardCache,
} from './post-processing'
import { type TraderRow, makeAddToTraderMap, sanitizeTraderRow } from './trader-row'
import { computeLastResortCalmar, classifyTradingStyle } from './scoring-helpers'
import { fetchHandleAvatarMap } from './fetch-handles'
import { enrichFromStatsDetail } from './enrich-stats-detail'
import { deriveWrMddFromEquityCurve, deriveAdvancedFromEquityCurve } from './enrich-equity-curve'
import { deriveAdvancedFromDailySnapshots } from './enrich-daily-snapshots'
import { runPhase1, getPhase1ReadSource } from './phase1-select'
import { scoreTraders } from './score-traders'
import { checkDegradationGuard, saveScoredCount } from './degradation-guard'
import { publishAtomicRankGeneration } from './publish-atomic-rank-generation'
import { hasComputeFailures, type ComputeResult } from './result-status'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { tieredGet, tieredSet } from '@/lib/cache/redis-layer'
import { getSharedRedis } from '@/lib/cache/redis-client'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { MIN_TRADES } from '@/lib/constants/trader-thresholds'
import { acquireLeaderboardSeasonLocks, type LeaderboardSeasonLockRedis } from './season-lock'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const logger = createLogger('compute-leaderboard')

const SEASONS: Period[] = ['7D', '30D', '90D']
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

  // Full and staggered jobs acquire the same per-season keys. A historical
  // global key for full runs did not conflict with `:90D`/`:30D`/`:7D`, so the
  // worker and watchdog could concurrently rewrite and clean up one season.
  const lockSuffix = targetSeasons.length === 1 ? `:${targetSeasons[0]}` : ''
  let redis: Awaited<ReturnType<typeof getSharedRedis>>
  try {
    redis = await getSharedRedis()
  } catch (err) {
    logger.error(
      '[compute-leaderboard] Redis client failed; refusing an unfenced compute:',
      err instanceof Error ? err.message : String(err)
    )
    return NextResponse.json(
      { ok: false, error: 'Leaderboard compute lock unavailable' },
      { status: 503 }
    )
  }
  if (!redis) {
    logger.error('[compute-leaderboard] Redis unavailable; refusing an unfenced compute')
    return NextResponse.json(
      { ok: false, error: 'Leaderboard compute lock unavailable' },
      { status: 503 }
    )
  }

  const lockRedis: LeaderboardSeasonLockRedis = {
    set: (key, value, options) => redis.set(key, value, options),
    eval: (script, keys, args) => redis.eval(script, keys, args),
  }
  const seasonLock = await acquireLeaderboardSeasonLocks(lockRedis, targetSeasons)
  if (!seasonLock.acquired) {
    const conflict = seasonLock.reason === 'conflict'
    return NextResponse.json(
      {
        ok: conflict,
        skipped: true,
        reason: conflict ? 'concurrent season compute' : 'leaderboard compute lock failed',
        season: seasonLock.blockedSeason,
      },
      { status: conflict ? 200 : 503 }
    )
  }

  const supabase = getSupabaseAdmin() as SupabaseClient
  const readDb = getReadReplica() as SupabaseClient // Read replica for SELECT queries (falls back to primary if not configured)
  const startTime = Date.now()
  const stats = { seasons: {} as Record<string, number> }
  const warnings: string[] = []
  const rolledBack: string[] = []
  let plog: Awaited<ReturnType<typeof PipelineLogger.start>>
  try {
    plog = await PipelineLogger.start(`compute-leaderboard${lockSuffix}`)
  } catch (error) {
    await seasonLock.release()
    logger.error('[compute-leaderboard] Failed to start pipeline log', error)
    return NextResponse.json({ error: 'Compute failed' }, { status: 500 })
  }

  try {
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

    // Pre-compute: fill NULL PnL from sibling windows for platforms where
    // the leaderboard API doesn't return PnL (e.g., Bybit).
    // This propagates enrichment PnL across all windows for the same trader.
    try {
      await supabase.rpc('fill_null_pnl_from_siblings')
    } catch (e) {
      logger.warn('fill_null_pnl_from_siblings failed (non-critical):', e)
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
        const count = await computeSeason(
          supabase,
          season,
          previousCounts[season],
          forceWrite,
          computeDeadline
        )
        results.push({ season, count, error: null })
      } catch (err) {
        logger.error(`[${season}] computeSeason failed:`, err)
        results.push({ season, count: -1, error: err })
      }
    }

    for (const { season, count, error } of results) {
      stats.seasons[season] = count

      if (error) {
        const msg = `${season}: computation FAILED — ${String(error)}`
        warnings.push(msg)
        rolledBack.push(season)
        stats.seasons[season] = previousCounts[season]
      } else if (count === -1) {
        // Automatic degradation is always fail-closed. A later healthy run, or
        // an authenticated operator explicitly using force=1, may resume writes.
        const msg = `${season}: degradation detected, upsert SKIPPED (table: ${previousCounts[season]})`
        warnings.push(msg)
        rolledBack.push(season)
        stats.seasons[season] = previousCounts[season] // Keep old count in stats
      }
    }

    // POST-COMPUTE ASSERTION: verify leaderboard_ranks is not empty.
    // ROOT CAUSE FIX for 12-day empty homepage (2026-05-19): missing DEFAULT nextval()
    // on partition id column caused silent upsert failures. This assertion catches any
    // future scenario where compute "succeeds" but writes 0 rows.
    const totalRankedAllSeasons = results.reduce((sum, r) => sum + Math.max(0, r.count), 0)
    if (totalRankedAllSeasons === 0 && results.every((r) => !r.error)) {
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

    // Send alert if degradation detected (rate-limited: 6h cooldown)
    if (warnings.length > 0) {
      try {
        const { sendRateLimitedAlert } = await import('@/lib/alerts/send-alert')
        await sendRateLimitedAlert(
          {
            title: '排行榜降级告警',
            message: warnings.join('\n'),
            level: 'critical',
            details: { seasons_affected: rolledBack.join(', ') },
          },
          'leaderboard:degradation',
          6 * 60 * 60 * 1000
        )
      } catch (e) {
        logger.error('[compute-leaderboard] 告警发送失败:', e)
      }
    }

    // Time budget: skip non-critical post-processing if <60s remaining (prevents 300s timeout)
    const TIME_BUDGET_MS = (maxDuration - 20) * 1000 // 280s safety margin
    const remainingMs = () => TIME_BUDGET_MS - (Date.now() - startTime)

    // Refresh leaderboard count cache after all seasons computed
    if (remainingMs() > 30_000) {
      try {
        const { query: dbQuery } = await import('@/lib/db')
        await dbQuery('SELECT refresh_leaderboard_count_cache()', [])
        logger.info('Refreshed leaderboard_count_cache')
      } catch (cacheErr) {
        logger.warn('Failed to refresh leaderboard_count_cache:', cacheErr)
      }
    } else {
      logger.warn(
        `Skipping leaderboard_count_cache refresh — only ${Math.round(remainingMs() / 1000)}s remaining`
      )
    }

    // (removed 2026-06-15) arena_score → trader_snapshots_v2 write-back.
    // v2 is being retired (ARENA_DATA_SPEC endgame); leaderboard_ranks is the
    // canonical score store. No point syncing scores back into a doomed table.

    // Save last-known-good snapshot marker for fallback resilience.
    // Rankings API reads this to verify compute health; if stale, it serves
    // cached data instead of failing when the DB query errors out.
    {
      const successfulSeasons = results.filter((r) => !r.error && r.count > 0)
      if (successfulSeasons.length > 0) {
        try {
          await tieredSet(
            'leaderboard:last-success',
            {
              timestamp: new Date().toISOString(),
              seasons: successfulSeasons.map((r) => r.season),
              traderCounts: Object.fromEntries(successfulSeasons.map((r) => [r.season, r.count])),
            },
            'warm',
            ['leaderboard']
          ) // 900s TTL (warm tier)
        } catch (e) {
          logger.warn(
            'Failed to write leaderboard:last-success marker:',
            e instanceof Error ? e.message : String(e)
          )
        }
      }
    }

    // (removed 2026-06-15) sub-scores → trader_snapshots_v2 write-back
    // (syncSubscoresToV2). v2 is being retired; leaderboard_ranks holds the
    // canonical sub-scores. See post-processing.ts.

    // Post-processing blocks extracted to post-processing.ts.
    fireAndForget(warmupLeaderboardCache(supabase, SEASONS), 'warmup-leaderboard-cache')
    fireAndForget(warmupSsrHomepageCache(), 'warmup-ssr-homepage-cache')
    fireAndForget(syncRedisSortedSet(supabase, SEASONS), 'sync-redis-sorted-set')
    fireAndForget(revalidateRankingPages(), 'revalidate-ranking-pages')

    const totalRanked = Object.values(stats.seasons).reduce((a, b) => a + b, 0)
    // Distinguish between computation FAILUREs (real errors) and degradation SKIPs (auto-recoverable)
    const hasRealFailures = hasComputeFailures(results)
    if (hasRealFailures) {
      // Real computation failure — report as error
      await plog.error(new Error(warnings.join('; ')), { stats, rolledBack })
    } else if (warnings.length > 0) {
      // Only degradation skips — report as partial success (auto-recovers next run)
      await plog.success(totalRanked, {
        stats,
        warnings,
        rolledBack,
        note: 'degradation skips are auto-recoverable',
      })
    } else {
      await plog.success(totalRanked, { stats })
    }

    return NextResponse.json(
      {
        ok: warnings.length === 0,
        elapsed_ms: elapsed,
        // ENDGAME cutover visibility: which Phase-1 reader actually ran
        // (trader_latest | arena | diff). Lets the cutover be verified from the
        // response instead of guessing from data side-effects.
        read_source: getPhase1ReadSource(),
        stats,
        previous_counts: previousCounts,
        warnings: warnings.length > 0 ? warnings : undefined,
        rolled_back: rolledBack.length > 0 ? rolledBack : undefined,
      },
      { status: hasRealFailures ? 500 : 200 }
    )
  } catch (error: unknown) {
    logger.error('Failed to compute leaderboard', error)
    await plog.error(error)
    return NextResponse.json({ error: 'Compute failed', detail: String(error) }, { status: 500 })
  } finally {
    await seasonLock.release()
  }
}

async function computeSeason(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  season: Period,
  previousCount?: number,
  forceWrite?: boolean,
  deadlineMs: number = Date.now() + 270_000
): Promise<number> {
  // Deadline helpers — any phase can call these to abort early when time runs out.
  // Prevents cumulative Phase 3/4/4b/4b2 enrichment queries from blowing past
  // Vercel's 300s maxDuration and leaving pipeline_logs as 'running' until
  // cleanup-stuck-logs sweeps them 30 min later.
  const timeLeftMs = () => deadlineMs - Date.now()
  const isOutOfTime = (minMs: number = 10_000) => timeLeftMs() < minMs
  // Checkpoint recovery: skip this season if it was already computed this hour.
  // Prevents redundant recomputation when compute-leaderboard is retried after
  // a partial failure (e.g., season 7D succeeded, 30D timed out — retry
  // shouldn't redo 7D).
  const hourKey = new Date().toISOString().slice(0, 13) // "2026-04-14T08"
  const checkpointKey = `leaderboard:computed:atomic-v1:${season}:${hourKey}`
  try {
    const { data: checkpoint } = await tieredGet<{ count: number }>(checkpointKey, 'warm')
    if (checkpoint && checkpoint.count > 0 && !forceWrite) {
      logger.info(
        `[${season}] Checkpoint hit — already computed this hour (${checkpoint.count} traders). Skipping.`
      )
      return checkpoint.count
    }
  } catch (e) {
    logger.warn(
      `[${season}] Checkpoint read failed (proceeding): ${e instanceof Error ? e.message : String(e)}`
    )
  }

  // Log scheduler provenance only. Independent per-source board watermarks below are
  // the source-data freshness gate; a completed batch job is not itself proof
  // that every exchange/protocol returned fresh data.
  try {
    const { data: latestFetch } = await supabase
      .from('pipeline_logs')
      .select('ended_at')
      .like('job_name', 'batch-fetch-traders%')
      .eq('status', 'success')
      .order('ended_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (latestFetch?.ended_at) {
      const ageMin = Math.round((Date.now() - new Date(latestFetch.ended_at).getTime()) / 60_000)
      logger.info(
        `[${season}] Last batch-fetch job completed ${ageMin}min ago (${latestFetch.ended_at}); checking per-source board watermarks`
      )
    }
  } catch {
    // Non-critical — informational log only
  }

  // Stream directly into traderMap instead of accumulating allSnapshots array
  // This reduces peak memory from ~200MB to ~50MB by avoiding intermediate array.
  // TraderRow shape + addToTraderMap sanitize/merge logic live in ./trader-row.ts.
  const traderMap = new Map<string, TraderRow>()
  const addToTraderMap = makeAddToTraderMap(traderMap)

  // Phase 1: read score rows and every physical-board authority record in one
  // database snapshot. The strict parser validates the whole bundle before any
  // row is projected into the temporary compute map.
  const sourcePublication = await runPhase1(supabase, season, traderMap, addToTraderMap)

  // V1 fetch removed — v2 backfill (migration 20260319b) ensures v2 has full coverage.
  // upsertTraders() writes to both v1 and v2 on every cron run, so v2 stays current.
  // If v2 coverage drops below expectations, run the backfill migration again.
  // Debug: log per-source counts to diagnose missing platforms
  const sourceCounts = new Map<string, number>()
  for (const t of traderMap.values()) {
    sourceCounts.set(t.source, (sourceCounts.get(t.source) || 0) + 1)
  }
  const jupiterCount = sourceCounts.get('jupiter_perps') || 0
  logger.info(
    `[${season}] ${traderMap.size} unique traders from v2 (jupiter_perps: ${jupiterCount}, sources: ${sourceCounts.size})`
  )

  // Cross-window backfill REMOVED — now handled at fetch time in connector-db-adapter.ts.
  // runConnectorBatch() builds a union of all traders across all windows and ensures
  // every trader has entries for ALL windows in trader_snapshots_v2.

  // The one publication-bundle RPC is the source/freshness authority for this
  // generation. Atomic all-source publication cannot mix retained old boards
  // with a new score cohort, so any retain decision blocks before enrichment,
  // manifest creation, or ranking mutation.
  if (sourcePublication.evidence.retainedAliases.length > 0) {
    const retained = sourcePublication.evidence.retainedAliases
      .map((alias) => `${alias.source}:${alias.denial_reasons.join('+')}`)
      .join(', ')
    throw new Error(`[${season}] source publication authority retained ${retained}`)
  }
  const expectedPlatforms = sourcePublication.evidence.aliases.map((alias) => alias.source)
  const freshPlatforms = sourcePublication.evidence.freshAliases.map((alias) => alias.source)
  if (
    expectedPlatforms.length === 0 ||
    freshPlatforms.length !== expectedPlatforms.length ||
    freshPlatforms.length !== new Set(freshPlatforms).size
  ) {
    throw new Error(`[${season}] source publication authority is incomplete`)
  }

  // Phase 3: Fill missing metrics from trader_stats_detail (enrichment table).
  // Catches data from the enrichment cron that was written to stats_detail but
  // never propagated back to trader_snapshots_v2. Logic in enrich-stats-detail.ts.
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
    // Defense in depth: only rows covered by this exact all-fresh authority
    // bundle may enter the manifest.
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
    throw new Error(
      `[${season}] no traders passed publication filters (input=${traderMap.size}, roiThreshold=${roiThreshold}); preserving the current sealed cohort`
    )
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

  // Degradation guard: prevent bad data from overwriting good leaderboard data
  const degradation = await checkDegradationGuard({
    supabase: supabase as SupabaseClient,
    season,
    scoredCount: scoredFiltered.length,
    freshPlatforms,
    forceWrite: forceWrite || false,
    previousCount,
  })
  if (degradation.action === 'skip') return -1

  // Concurrency is fenced by the owner-token Redis season lease acquired by GET().
  // Do not add a session-level PostgreSQL advisory lock through Supabase RPC here:
  // PostgREST may execute acquire and release on different pooled connections,
  // leaking the lock on the acquire session and permanently blocking this season.
  if (isOutOfTime(75_000)) {
    throw new Error(
      `[${season}] insufficient time for atomic publication (${Math.round(timeLeftMs() / 1000)}s left)`
    )
  }

  // The finalizer validates the complete manifest/generation/source authority,
  // then live-upserts, exact-cleans, reranks, seals proofs, and advances the
  // generation head inside one PostgreSQL transaction. Any error leaves the
  // previously sealed public cohort byte-for-byte readable.
  const publication = await publishAtomicRankGeneration({
    supabase: supabase as never,
    season,
    sourceEvidence: sourcePublication.evidence,
    scoredTraders: scoredFiltered,
  })
  logger.info(
    `[${season}] atomically sealed generation ${publication.generationSeq} / ${publication.scoreCohortId} (${publication.publishedCount} ranks, ${publication.sourceCount} sources)`
  )

  // Save the sealed public count for future degradation checks.
  await saveScoredCount(season, publication.publishedCount)

  // Write per-season checkpoint so retries within the same hour skip this season.
  // TTL = warm (900s) — survives the cron interval but doesn't linger.
  try {
    await tieredSet(
      checkpointKey,
      { count: publication.publishedCount, at: new Date().toISOString() },
      'warm',
      ['leaderboard']
    )
  } catch (e) {
    logger.warn(
      `[${season}] Checkpoint write failed: ${e instanceof Error ? e.message : String(e)}`
    )
  }

  logger.info(
    `${season}: atomically ranked ${publication.publishedCount} traders from ${scored.length} score candidates`
  )
  return publication.publishedCount
}

/**
 * Pre-populate Redis with top 100 leaderboard rows for each season.
 * Runs as fire-and-forget after leaderboard computation so it doesn't
 * block the cron response. TTL = 30 min (matches cron schedule).
 */
// warmupLeaderboardCache extracted to ./post-processing.ts
