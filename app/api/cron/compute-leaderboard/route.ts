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
import {
  calculateArenaScore,
  wilsonConfidenceMultiplier,
  type Period,
} from '@/lib/utils/arena-score'
import {
  SOURCES_WITH_DATA,
  SOURCE_TYPE_MAP,
  SOURCE_TRUST_WEIGHT,
} from '@/lib/constants/exchanges'
import { createLogger, fireAndForget } from '@/lib/utils/logger'
import {
  syncSubscoresToV2,
  warmupSsrHomepageCache,
  syncRedisSortedSet,
  revalidateRankingPages,
  warmupLeaderboardCache,
} from './post-processing'
import { detectTraderType, deriveWinRateMDD } from './helpers'
import { type TraderRow, makeAddToTraderMap } from './trader-row'
import { computeLastResortCalmar, classifyTradingStyle, markOutliers, applyArenaFollowers } from './scoring-helpers'
import { checkPlatformFreshness } from './freshness-check'
import { fetchHandleAvatarMap } from './fetch-handles'
import { enrichFromStatsDetail } from './enrich-stats-detail'
import { deriveWrMddFromEquityCurve, deriveAdvancedFromEquityCurve } from './enrich-equity-curve'
import { deriveAdvancedFromDailySnapshots } from './enrich-daily-snapshots'
import { fetchPhase1FromV2 } from './fetch-phase1'
import { rerankAllRows, cleanupStaleRows } from './rerank-cleanup'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { sanitizeDisplayName } from '@/lib/utils/profanity'
import { generateIdenticonSvg } from '@/lib/utils/avatar'
import { tieredGet, tieredSet, tieredDel } from '@/lib/cache/redis-layer'
import { PipelineState } from '@/lib/services/pipeline-state'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { validateBeforeWrite, logRejectedWrites } from '@/lib/pipeline/validate-before-write'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// detectTraderType, getFreshnessHours, deriveWinRateMDD all live in ./helpers.ts
// (single source of truth — duplicates removed 2026-04-09). getFreshnessHours
// is now consumed only by fetch-phase1.ts.

const logger = createLogger('compute-leaderboard')

const SEASONS: Period[] = ['7D', '30D', '90D']
const MIN_TRADES_COUNT = 5 // Require 5+ trades for ranking — 1-trade wonders have meaningless stats
const DEGRADATION_THRESHOLD = 0.70 // 70% — block catastrophic drops only; 85% was too tight (7D hovers at 84% due to ROI filters)

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
  const seasonParam = request.nextUrl.searchParams.get('season')?.toUpperCase() as Period | undefined
  const targetSeasons: Period[] = seasonParam && SEASONS.includes(seasonParam)
    ? [seasonParam]
    : SEASONS

  // Idempotency: atomic SET NX EX (no race window between get and set)
  // Per-season lock when running single season to allow parallel staggered runs
  const lockSuffix = targetSeasons.length === 1 ? `:${targetSeasons[0]}` : ''
  const IDEMPOTENCY_KEY = `cron:compute-leaderboard:running${lockSuffix}`
  let lockAcquired = false
  try {
    const { getSharedRedis } = await import('@/lib/cache/redis-client')
    const redis = await getSharedRedis()
    if (redis) {
      const result = await redis.set(IDEMPOTENCY_KEY, new Date().toISOString(), { nx: true, ex: 300 })
      lockAcquired = result === 'OK'
    } else {
      const cached = await tieredGet(IDEMPOTENCY_KEY, 'hot')
      if (!cached.data) { await tieredSet(IDEMPOTENCY_KEY, { startedAt: new Date().toISOString() }, 'hot', []); lockAcquired = true }
    }
  } catch (err) {
    logger.warn('[compute-leaderboard] Redis lock failed, proceeding without lock:', err instanceof Error ? err.message : String(err))
    lockAcquired = true
  }
  if (!lockAcquired) {
    return NextResponse.json({ ok: true, message: `Already running (atomic lock${lockSuffix})`, cached: true })
  }

  const supabase = getSupabaseAdmin() as SupabaseClient
  const readDb = getReadReplica() as SupabaseClient // Read replica for SELECT queries (falls back to primary if not configured)
  const startTime = Date.now()
  const stats = { seasons: {} as Record<string, number> }
  const warnings: string[] = []
  const rolledBack: string[] = []
  const plog = await PipelineLogger.start(`compute-leaderboard${lockSuffix}`)

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
    const results: Array<{ season: string; count: number; error: unknown }> = []
    for (const season of targetSeasons) {
      try {
        const count = await computeSeason(supabase, season, previousCounts[season], forceWrite, computeDeadline)
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
        // Degradation skip is auto-recoverable (MAX_CONSECUTIVE_SKIPS=2 forces compute on 3rd attempt)
        // Only treat as warning, not error, to avoid noisy OpenClaw alerts
        const msg = `${season}: degradation detected, upsert SKIPPED (table: ${previousCounts[season]})`
        warnings.push(msg)
        rolledBack.push(season)
        stats.seasons[season] = previousCounts[season] // Keep old count in stats
      }
    }

    const elapsed = Date.now() - startTime
    logger.info(`Leaderboard computed in ${elapsed}ms`, stats)

    // Send alert if degradation detected (rate-limited: 6h cooldown)
    if (warnings.length > 0) {
      try {
        const { sendRateLimitedAlert } = await import('@/lib/alerts/send-alert')
        await sendRateLimitedAlert({
          title: '排行榜降级告警',
          message: warnings.join('\n'),
          level: 'critical',
          details: { seasons_affected: rolledBack.join(', ') },
        }, 'leaderboard:degradation', 6 * 60 * 60 * 1000)
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
      logger.warn(`Skipping leaderboard_count_cache refresh — only ${Math.round(remainingMs() / 1000)}s remaining`)
    }

    // Sync arena_score from leaderboard_ranks → trader_snapshots_v2 flat column
    // This ensures the v2 table has scores matching the freshly computed leaderboard
    // Gated by time budget: this can take 30-60s for large batches
    if (remainingMs() > 60_000) {
      try {
        const recentCutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
        // Fetch recent v2 rows missing scores
        const { data: missingScores } = await readDb
          .from('trader_snapshots_v2')
          .select('id, platform, trader_key, window')
          .is('arena_score', null)
          .gte('created_at', recentCutoff)
          .limit(1000)

        if (missingScores && missingScores.length > 0) {
          // Batch lookup from leaderboard_ranks
          const traderKeys = [...new Set(missingScores.map(r => r.trader_key))]
          const { data: ranks } = await readDb
            .from('leaderboard_ranks')
            .select('source, source_trader_id, season_id, arena_score')
            .in('source_trader_id', traderKeys.slice(0, 500))
            .not('arena_score', 'is', null)

          if (ranks && ranks.length > 0) {
            const scoreMap = new Map(ranks.map(r => [`${r.source}:${r.source_trader_id}:${r.season_id}`, r.arena_score]))
            // Batch updates instead of N+1 individual queries
            const updates: { id: string; arena_score: number }[] = []
            for (const row of missingScores) {
              const key = `${row.platform}:${row.trader_key}:${row.window}`
              const score = scoreMap.get(key)
              if (score != null && score > 0) {
                updates.push({ id: row.id, arena_score: score })
              }
            }
            // Execute in batches of 100, abort if time budget low
            let synced = 0
            for (let i = 0; i < updates.length; i += 100) {
              if (remainingMs() < 30_000) {
                logger.warn(`arena_score sync aborted at batch ${i} — only ${Math.round(remainingMs() / 1000)}s remaining`)
                break
              }
              const chunk = updates.slice(i, i + 100)
              const { error: upsertErr } = await supabase
                .from('trader_snapshots_v2')
                .upsert(chunk, { onConflict: 'id' })
              if (!upsertErr) synced += chunk.length
            }
            logger.info(`Synced arena_score to v2: ${synced}/${missingScores.length} rows (${updates.length} updates, batched)`)
          }
        }
      } catch (syncErr) {
        logger.warn('arena_score sync to v2 failed (non-critical):', syncErr)
      }
    } else {
      logger.warn(`Skipping arena_score v2 sync — only ${Math.round(remainingMs() / 1000)}s remaining`)
    }

    // Sync sub-scores + advanced metrics: leaderboard_ranks → trader_snapshots_v2.
    // Extracted to post-processing.ts to shrink this file per Retro 2026-04-09.
    fireAndForget(syncSubscoresToV2(supabase), 'sync-subscores-to-v2')

    // Post-compute: derive WR/MDD from historical snapshots for traders missing them
    // Gated by time budget: this queries historical data and can be slow
    let wrMddDerived = 0
    if (remainingMs() > 40_000) {
      try {
        wrMddDerived = await deriveWinRateMDD(supabase)
        if (wrMddDerived > 0) logger.info(`Derived WR/MDD for ${wrMddDerived} traders`)
      } catch (e) {
        logger.warn('WR/MDD derivation failed (non-critical):', e)
      }
    } else {
      logger.warn(`Skipping WR/MDD derivation — only ${Math.round(remainingMs() / 1000)}s remaining`)
    }

    // Post-processing blocks extracted to post-processing.ts.
    fireAndForget(warmupLeaderboardCache(supabase, SEASONS), 'warmup-leaderboard-cache')
    fireAndForget(warmupSsrHomepageCache(), 'warmup-ssr-homepage-cache')
    fireAndForget(syncRedisSortedSet(supabase, SEASONS), 'sync-redis-sorted-set')
    fireAndForget(revalidateRankingPages(), 'revalidate-ranking-pages')

    // Release idempotency lock (atomic Redis DEL with fallback)
    try { const { getSharedRedis: r } = await import('@/lib/cache/redis-client'); const c = await r(); if (c) await c.del(IDEMPOTENCY_KEY); else await tieredDel(IDEMPOTENCY_KEY) } catch { await tieredDel(IDEMPOTENCY_KEY).catch(() => {}) }

    const totalRanked = Object.values(stats.seasons).reduce((a, b) => a + b, 0)
    // Distinguish between computation FAILUREs (real errors) and degradation SKIPs (auto-recoverable)
    const hasRealFailures = results.some(r => r.error && r.count !== -1)
    if (hasRealFailures) {
      // Real computation failure — report as error
      await plog.error(new Error(warnings.join('; ')), { stats, rolledBack })
    } else if (warnings.length > 0) {
      // Only degradation skips — report as partial success (auto-recovers next run)
      await plog.success(totalRanked, { stats, warnings, rolledBack, note: 'degradation skips are auto-recoverable' })
    } else {
      await plog.success(totalRanked, { stats })
    }

    return NextResponse.json({
      ok: warnings.length === 0,
      elapsed_ms: elapsed,
      stats,
      previous_counts: previousCounts,
      warnings: warnings.length > 0 ? warnings : undefined,
      rolled_back: rolledBack.length > 0 ? rolledBack : undefined,
      wr_mdd_derived: wrMddDerived,
    })
  } catch (error: unknown) {
    // Release idempotency lock on failure (atomic Redis DEL with fallback)
    try { const { getSharedRedis: r } = await import('@/lib/cache/redis-client'); const c = await r(); if (c) await c.del(IDEMPOTENCY_KEY); else await tieredDel(IDEMPOTENCY_KEY) } catch { await tieredDel(IDEMPOTENCY_KEY).catch(() => {}) }
    logger.error('Failed to compute leaderboard', error)
    await plog.error(error)
    return NextResponse.json(
      { error: 'Compute failed', detail: String(error) },
      { status: 500 }
    )
  }
}

async function computeSeason(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  season: Period,
  previousCount?: number,
  forceWrite?: boolean,
  deadlineMs: number = Date.now() + 270_000,
): Promise<number> {
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

  // Phase 1: Fetch fresh trader rows from trader_snapshots_v2, one platform
  // at a time. Sequential to avoid DB pool exhaustion under cron storms.
  // Per-source 30s timeout, 30D fallback for sparse windows, JSONB fallback
  // for platforms that write columns sparsely. Logic in fetch-phase1.ts.
  // The returned per-source row counts aren't currently consumed downstream
  // — kept for parity with the pre-refactor diagnostic surface.
  await fetchPhase1FromV2(supabase, season, addToTraderMap)

  // V1 fetch removed — v2 backfill (migration 20260319b) ensures v2 has full coverage.
  // upsertTraders() writes to both v1 and v2 on every cron run, so v2 stays current.
  // If v2 coverage drops below expectations, run the backfill migration again.
  // Debug: log per-source counts to diagnose missing platforms
  const sourceCounts = new Map<string, number>()
  for (const t of traderMap.values()) {
    sourceCounts.set(t.source, (sourceCounts.get(t.source) || 0) + 1)
  }
  const jupiterCount = sourceCounts.get('jupiter_perps') || 0
  logger.info(`[${season}] ${traderMap.size} unique traders from v2 (jupiter_perps: ${jupiterCount}, sources: ${sourceCounts.size})`)

  // Cross-window backfill REMOVED — now handled at fetch time in connector-db-adapter.ts.
  // runConnectorBatch() builds a union of all traders across all windows and ensures
  // every trader has entries for ALL windows in trader_snapshots_v2.

  // Data freshness check: classify each source as fresh / stale / query-failed.
  // If ALL platforms are stale (>48h) we skip computation to avoid publishing
  // a stale leaderboard. Logic lives in freshness-check.ts.
  const { freshPlatforms, stalePlatforms, queryFailedPlatforms } =
    await checkPlatformFreshness(supabase, traderMap)

  if (queryFailedPlatforms.length > 0) {
    logger.warn(`[${season}] ${queryFailedPlatforms.length} platforms had query failures but DB has fresh data: ${queryFailedPlatforms.join(', ')}`)
  }

  if (freshPlatforms.length === 0 && SOURCES_WITH_DATA.length > 0) {
    if (queryFailedPlatforms.length > 0) {
      logger.error(`[${season}] No fresh platforms loaded but ${queryFailedPlatforms.length} had DB fresh-data (query failures). Transient Supabase issue — skipping this run.`, { queryFailedPlatforms, stalePlatforms })
      throw new Error(`Query failures prevented loading ${queryFailedPlatforms.length} fresh platforms — will retry next cron cycle.`)
    }
    logger.error(`[${season}] ALL platforms are stale (>48h). Skipping computation to prevent stale leaderboard.`, { stalePlatforms })
    throw new Error(`All ${stalePlatforms.length} platforms are stale (>48h). Blocking computation.`)
  }

  if (stalePlatforms.length > 0) {
    logger.warn(`[${season}] ${stalePlatforms.length} platforms have stale data (>48h): ${stalePlatforms.join(', ')}. Computing with ${freshPlatforms.length} fresh platforms.`)
  }

  // Phase 3: Fill missing metrics from trader_stats_detail (enrichment table).
  // Catches data from the enrichment cron that was written to stats_detail but
  // never propagated back to trader_snapshots_v2. Logic in enrich-stats-detail.ts.
  if (isOutOfTime(90_000)) {
    logger.warn(`[${season}] SKIPPING Phase 3 (stats_detail enrichment) — only ${Math.round(timeLeftMs() / 1000)}s left`)
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
    logger.warn(`[${season}] SKIPPING Phase 4 (equity_curve WR/MDD derivation) — only ${Math.round(timeLeftMs() / 1000)}s left`)
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
    logger.warn(`[${season}] SKIPPING Phase 4b (advanced metrics from equity_curve) — only ${Math.round(timeLeftMs() / 1000)}s left`)
  } else {
    const advancedDerived = await deriveAdvancedFromEquityCurve(supabase, traderMap, season, isOutOfTime)
    if (advancedDerived > 0) {
      logger.info(`[${season}] Derived ${advancedDerived} sharpe/sortino/calmar/PF/trades values from equity curves`)
    }
  }

  // Phase 4b2: Fallback — compute advanced metrics from trader_daily_snapshots
  // for traders still missing them after Phase 4b. Catches traders below the
  // top-N enrichment cut-off whose equity_curve is empty. Logic in
  // enrich-daily-snapshots.ts.
  if (isOutOfTime(50_000)) {
    logger.warn(`[${season}] SKIPPING Phase 4b2 (advanced metrics from daily_snapshots) — only ${Math.round(timeLeftMs() / 1000)}s left`)
  } else {
    const dailyDerived = await deriveAdvancedFromDailySnapshots(supabase, traderMap, season, isOutOfTime)
    if (dailyDerived > 0) {
      logger.info(`[${season}] Derived ${dailyDerived} sharpe/sortino/calmar/PF values from daily_snapshots (fallback)`)
    }
  }

  // Phase 4b3: Last resort — compute calmar from ROI + MDD for any trader
  // still missing it after Phases 4 / 4b / 4b2. Pure mutation in scoring-helpers.
  {
    const calmarOnly = computeLastResortCalmar(traderMap, season)
    if (calmarOnly > 0) {
      logger.info(`[${season}] Computed ${calmarOnly} calmar ratios from ROI/MDD (no daily returns needed)`)
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
  const uniqueTraders = Array.from(traderMap.values())
    .filter(t => t.source !== 'web3_bot') // DeFi protocol contracts, not real traders — exclude entirely
    .filter(t => t.roi != null)
    .filter(t => Math.abs(t.roi!) <= roiThreshold)
    .filter(t => t.roi! > -90) // 过滤已爆仓交易员（ROI < -90%），无参考价值
    .filter(t => t.trades_count == null || t.trades_count === 0 || t.trades_count >= MIN_TRADES_COUNT) // 0 = unknown (API doesn't provide), treat same as null

  // Debug: jupiter_perps filter analysis
  const jupiterInMap = Array.from(traderMap.values()).filter(t => t.source === 'jupiter_perps')
  const jupiterWithRoi = jupiterInMap.filter(t => t.roi != null)
  const jupiterPassAll = uniqueTraders.filter(t => t.source === 'jupiter_perps')
  if (jupiterInMap.length > 0 || jupiterPassAll.length > 0) {
    logger.info(`[${season}] jupiter_perps filter: inMap=${jupiterInMap.length}, hasRoi=${jupiterWithRoi.length}, passAll=${jupiterPassAll.length}, roiThreshold=${roiThreshold}`)
    if (jupiterInMap.length > 0 && jupiterPassAll.length === 0) {
      const sample = jupiterInMap[0]
      logger.warn(`[${season}] jupiter_perps SAMPLE: roi=${sample.roi} (type=${typeof sample.roi}), trades=${sample.trades_count} (type=${typeof sample.trades_count})`)
    }
  }

  if (!uniqueTraders.length) {
    logger.warn(`[${season}] No traders passed filters! traderMap.size=${traderMap.size}, roiThreshold=${roiThreshold}`)
    return 0
  }

  // Batch fetch handles + avatars: trader_profiles_v2 primary, traders table
  // fallback for any key still missing a handle. Logic in fetch-handles.ts.
  const handleMap = await fetchHandleAvatarMap(supabase, uniqueTraders)

  // Calculate arena_score and rank
  const scored = uniqueTraders.map(t => {
    // Win rate should already be percentage (0-100) from fetcher normalization.
    // Only clamp to valid range; don't re-normalize decimal→percentage.
    let normalizedWinRate: number | null = null
    if (t.win_rate != null && !isNaN(t.win_rate)) {
      // Safety: if somehow still decimal (0-1 range), convert
      const wr = t.win_rate > 0 && t.win_rate <= 1 ? t.win_rate * 100 : t.win_rate
      normalizedWinRate = Math.max(0, Math.min(100, wr))
    }

    const scoreResult = calculateArenaScore(
      {
        roi: t.roi!, // guaranteed non-null by filter above
        pnl: t.pnl ?? null,
        maxDrawdown: t.max_drawdown,
        winRate: normalizedWinRate,
      },
      season
    )

    // Wilson confidence: smooth curve based on actual data availability
    // Replaces hardcoded 'full' from calculateArenaScore() which ignored missing metrics
    const confidenceMultiplier = wilsonConfidenceMultiplier(
      t.roi, t.pnl, t.max_drawdown, t.win_rate, t.sharpe_ratio
    )
    // Estimation penalty kept for future use — currently always 1.0 since Phase 5 estimation was removed
    const estimationPenalty = t.metrics_estimated ? 0.92 : 1.0
    // Low trade count penalty: traders with very few trades have unreliable metrics
    // (e.g., 100% WR with 1 trade is meaningless, not skill)
    // Scale: 0 trades → 0.6x, 1 → 0.7x, 2 → 0.8x, 5 → 0.92x, 10+ → 1.0x
    let tradeCountPenalty = 1.0
    if (t.trades_count != null && t.trades_count >= 0 && t.trades_count < 10) {
      tradeCountPenalty = 0.6 + 0.04 * t.trades_count // 0.6 at 0, 1.0 at 10
    }
    const rawSubScores = scoreResult.returnScore + scoreResult.pnlScore +
                         scoreResult.drawdownScore + scoreResult.stabilityScore
    // Trust weight removed from score formula — same skill shouldn't get different
    // scores based on exchange. Trust weight used only as tie-breaker in sort below.
    const finalScore = Math.round(
      Math.max(0, Math.min(100, rawSubScores * confidenceMultiplier * estimationPenalty * tradeCountPenalty)) * 100
    ) / 100

    const info = handleMap.get(`${t.source}:${t.source_trader_id}`) || { handle: null, avatar_url: null }
    // Only use handle if it's a real nickname, not a numeric UID
    const rawHandle = info.handle?.trim() || null
    const isNumericUid = rawHandle && /^\d{7,}$/.test(rawHandle)
    // Apply profanity filter before storing in database
    const displayHandle = (rawHandle && !isNumericUid) ? sanitizeDisplayName(rawHandle) : null

    return {
      source: t.source,
      source_trader_id: t.source_trader_id,
      arena_score: finalScore,
      roi: t.roi ?? 0,
      pnl: t.pnl,
      win_rate: normalizedWinRate,
      max_drawdown: t.max_drawdown,
      followers: 0, // Will be replaced with Arena follower count below
      copiers: t.copiers ?? null, // Exchange copy-trade count (from v2 or enrichment stats_detail)
      trades_count: t.trades_count,
      handle: displayHandle,
      // Generate identicon locally when no avatar — eliminates external dicebear.com request per trader
      avatar_url: info.avatar_url || generateIdenticonSvg(t.source + '_' + t.source_trader_id, 64),
      // Score sub-components for frontend display
      profitability_score: Math.round(scoreResult.returnScore * 100) / 100,
      risk_control_score: Math.round(scoreResult.pnlScore * 100) / 100,
      execution_score: null, // V3 removed drawdown/stability sub-scores
      // Data completeness: derive from which metrics are available
      score_completeness: (t.max_drawdown != null && t.win_rate != null) ? 'full'
        : (t.max_drawdown != null || t.win_rate != null) ? 'partial' : 'minimal',
      trading_style: t.trading_style,
      avg_holding_hours: t.avg_holding_hours,
      style_confidence: t.style_confidence,
      sharpe_ratio: t.sharpe_ratio,
      sortino_ratio: t.sortino_ratio ?? null,
      profit_factor: t.profit_factor ?? null,
      calmar_ratio: t.calmar_ratio ?? null,
      trader_type: detectTraderType(t.source, t.source_trader_id, t.trades_count, t.trader_type, t.avg_holding_hours, t.win_rate),
      metrics_estimated: t.metrics_estimated || false,
    }
  })

  // Pre-write validation: flag rows that look like data corruption with
  // is_outlier=true. They stay in the array (counted toward ranking totals)
  // but get filtered out of public leaderboards downstream by the is_outlier
  // column. Heuristics live in scoring-helpers.markOutliers.
  const outlierCount = markOutliers(scored)
  if (outlierCount > 0) {
    logger.info(`[${season}] Marked ${outlierCount} outliers (kept in leaderboard with is_outlier=true)`)
  }

  // Phase: Replace exchange followers with Arena internal follower counts.
  // Logic + RPC fallback live in scoring-helpers.applyArenaFollowers.
  {
    const { applied, uniqueIds } = await applyArenaFollowers(supabase, scored, season)
    logger.info(`[${season}] Arena followers: ${applied} traders have followers (${uniqueIds} unique trader_ids queried)`)
  }

  // Sort by arena_score desc, then trust weight (higher trust = higher for ties),
  // then Sharpe ratio (better risk-adjusted), then stable id.
  // Trust weight removed from score formula (same skill ≠ different score per exchange)
  // but kept here as tie-breaker for equal-scoring traders.
  scored.sort((a, b) => {
    const diff = b.arena_score - a.arena_score
    if (Math.abs(diff) > 0.01) return diff
    const twA = SOURCE_TRUST_WEIGHT[a.source] ?? 0.5
    const twB = SOURCE_TRUST_WEIGHT[b.source] ?? 0.5
    if (Math.abs(twB - twA) > 0.01) return twB - twA
    const srA = a.sharpe_ratio ?? -99
    const srB = b.sharpe_ratio ?? -99
    if (Math.abs(srB - srA) > 0.01) return srB - srA
    return a.source_trader_id.localeCompare(b.source_trader_id)
  })

  // Pre-upsert degradation check: block if new count drops below DEGRADATION_THRESHOLD of previous
  // BUG FIX 2026-03-31: previousCount was the total rows in leaderboard_ranks (including zombie rows
  // from incremental upsert not deleting old entries). The table accumulated 14-17K rows but compute
  // only produces ~8K, causing ratio=47% < 70% threshold on EVERY run. Fix: use the last scored count
  // from Redis (i.e., what the compute actually produced last time) as the baseline.
  const LAST_SCORED_KEY = `leaderboard:last-scored-count:${season}`
  let baselineCount = previousCount || 0
  let _baselineSource = 'table-count'
  try {
    const stored = await PipelineState.get<number>(LAST_SCORED_KEY)
    if (stored && typeof stored === 'number' && stored > 0) {
      baselineCount = stored
      _baselineSource = 'pipeline-state'
      logger.info(`[${season}] Using DB baseline (last scored count): ${baselineCount} (table count: ${previousCount})`)
    } else if (previousCount && previousCount > 0) {
      // Cold start: pipeline_state has no baseline yet (table may not exist or first run).
      // The table count includes zombie rows from incremental upsert, so it's inflated.
      // Use 60% of table count as conservative baseline to avoid false degradation alerts.
      baselineCount = Math.round(previousCount * 0.60)
      _baselineSource = 'table-count-discounted'
      logger.info(`[${season}] No pipeline_state baseline — using discounted table count: ${baselineCount} (raw: ${previousCount})`)
    }
  } catch (e) { logger.warn(`[${season}] pipeline_state read failed: ${e instanceof Error ? e.message : String(e)}`) }

  const MAX_CONSECUTIVE_SKIPS = 1 // Force-compute on 2nd attempt to prevent stale data (was 2)
  const ratio = baselineCount ? scored.length / baselineCount : 1
  logger.info(`[${season}] Degradation check: scored=${scored.length}, baseline=${baselineCount}, tableCount=${previousCount}, ratio=${(ratio * 100).toFixed(1)}%, threshold=${DEGRADATION_THRESHOLD * 100}%`)

  if (baselineCount && baselineCount > 500 && !forceWrite) {
    if (scored.length < 500 || ratio < DEGRADATION_THRESHOLD) {
      // Check consecutive skip counter from Redis — use 'cold' tier (TTL 1h) to survive 30min cron interval
      let consecutiveSkips = 0
      const skipKey = `leaderboard:degradation-skips:${season}`
      try {
        const stored = await PipelineState.get<number>(skipKey)
        consecutiveSkips = (typeof stored === 'number' ? stored : 0) + 1
        await PipelineState.set(skipKey, consecutiveSkips)
      } catch (e) { logger.warn(`[${season}] skip counter DB failure: ${e instanceof Error ? e.message : String(e)}`) }

      if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
        logger.warn(`${season}: degradation detected (${scored.length}/${baselineCount}, ${(ratio * 100).toFixed(1)}%) but FORCE-COMPUTING after ${consecutiveSkips} consecutive skips to prevent stale data`)
        // Reset counter and fall through to upsert
        try {
          await PipelineState.del(skipKey)
        } catch (e) { logger.warn(`[${season}] skip counter reset failed: ${e instanceof Error ? e.message : String(e)}`) }
      } else {
        logger.error(`${season}: computed ${scored.length} traders (baseline: ${baselineCount}, ratio: ${(ratio * 100).toFixed(1)}%). SKIPPING — below ${DEGRADATION_THRESHOLD * 100}% threshold (skip ${consecutiveSkips}/${MAX_CONSECUTIVE_SKIPS}).`)
        sendRateLimitedAlert({
          title: `Leaderboard ${season} degradation skip ${consecutiveSkips}/${MAX_CONSECUTIVE_SKIPS}`,
          message: `${season}: ${scored.length}/${baselineCount} traders (${(ratio * 100).toFixed(1)}%). Data preserved but stale. Force-compute at skip ${MAX_CONSECUTIVE_SKIPS}.`,
          level: consecutiveSkips >= 2 ? 'critical' : 'warning',
          details: { season, scored: scored.length, baseline: baselineCount, ratio, skip: consecutiveSkips },
        }, `leaderboard-degrade:${season}`, 60 * 60 * 1000).catch(err => logger.warn(`[compute-leaderboard] Degradation alert failed: ${err instanceof Error ? err.message : String(err)}`))

        // ROOT CAUSE FIX: Run stale-row cleanup EVEN ON DEGRADATION SKIP.
        // Previously, if degradation was detected, we returned immediately and
        // the cleanup at line ~1707 was skipped. This meant stale high-score
        // rows from weeks ago persisted at the top of rankings FOREVER, because
        // compute-leaderboard never got past the degradation guard.
        //
        // Cleanup is independent of upsert success — it just removes rows that
        // haven't been touched in 5 days (any upsert resets computed_at).
        try {
          const cutoff = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
          const { data: staleRows } = await supabase
            .from('leaderboard_ranks')
            .select('id')
            .eq('season_id', season)
            .lt('computed_at', cutoff)
            .limit(1000)
          if (staleRows && staleRows.length > 0) {
            const staleIds = staleRows.map((r: { id: number }) => r.id)
            // Batch size 200 (down from 500) to reduce lock hold time
            for (let i = 0; i < staleIds.length; i += 200) {
              await supabase.from('leaderboard_ranks').delete().in('id', staleIds.slice(i, i + 200))
            }
            logger.info(`${season}: cleaned ${staleIds.length} stale rows (>5d old) despite degradation skip`)
          }
        } catch (cleanupErr) {
          logger.warn(`${season}: cleanup-on-degradation failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`)
        }

        return -1
      }
    }
  } else if (forceWrite) {
    logger.warn(`${season}: force write enabled, skipping degradation check (scored: ${scored.length}, baseline: ${baselineCount})`)
  }
  // Reset consecutive skip counter on successful computation
  try {
    await PipelineState.del(`leaderboard:degradation-skips:${season}`)
  } catch (e) { logger.warn(`[${season}] skip counter cleanup failed: ${e instanceof Error ? e.message : String(e)}`) }

  // Phase 2: Incremental upsert — only update changed rows to reduce write volume ~40%
  // Fetch current arena_scores to diff against
  const currentScoreMap = new Map<string, { arena_score: number; rank: number; handle: string | null; avatar_url: string | null; sharpe_ratio: number | null; sortino_ratio: number | null; calmar_ratio: number | null; profit_factor: number | null; trading_style: string | null }>()
  {
    // Fetch in pages of 1000 to handle large leaderboards
    let offset = 0
    const PAGE = 1000
    const MAX_PAGES = 100
    let pageCount = 0
    while (true) {
      if (++pageCount > MAX_PAGES) {
        logger.warn(`Reached MAX_PAGES (${MAX_PAGES}) for season ${season}, breaking`)
        break
      }
      if (isOutOfTime(45_000)) {
        logger.warn(`[${season}] aborting currentScoreMap fetch at page ${pageCount} — only ${Math.round(timeLeftMs() / 1000)}s left`)
        break
      }
      const { data: currentScores } = await supabase
        .from('leaderboard_ranks')
        .select('source, source_trader_id, arena_score, rank, handle, avatar_url, sharpe_ratio, sortino_ratio, calmar_ratio, profit_factor, trading_style')
        .eq('season_id', season)
        .range(offset, offset + PAGE - 1)
      if (!currentScores?.length) break
      for (const r of currentScores) {
        currentScoreMap.set(`${r.source}:${r.source_trader_id}`, {
          arena_score: r.arena_score ?? 0,
          rank: r.rank,
          handle: r.handle,
          avatar_url: r.avatar_url,
          sharpe_ratio: r.sharpe_ratio,
          sortino_ratio: r.sortino_ratio,
          calmar_ratio: r.calmar_ratio,
          profit_factor: r.profit_factor,
          trading_style: r.trading_style,
        })
      }
      if (currentScores.length < PAGE) break
      offset += PAGE
    }
  }

  // Filter to only changed rows: new traders, score changed >0.5%, or rank changed
  const changedTraders = scored.filter((t, idx) => {
    const current = currentScoreMap.get(`${t.source}:${t.source_trader_id}`)
    if (current == null) return true // new trader
    // Always update if handle/avatar changed (backfill)
    if (t.handle !== current.handle || t.avatar_url !== current.avatar_url) return true
    const newRank = idx + 1
    if (current.rank !== newRank) return true // rank changed
    if (current.arena_score === 0) return t.arena_score !== 0 // was zero, check if now non-zero
    // Force update if new advanced metrics available (first-time backfill)
    if (t.sharpe_ratio != null && !current.sharpe_ratio) return true
    if (t.sortino_ratio != null && !current.sortino_ratio) return true
    if (t.calmar_ratio != null && !current.calmar_ratio) return true
    if (t.profit_factor != null && !current.profit_factor) return true
    if (t.trading_style != null && !current.trading_style) return true
    return Math.abs(t.arena_score - current.arena_score) > current.arena_score * 0.005 // >0.5% score change
  })

  logger.info(`[${season}] Incremental upsert: ${changedTraders.length}/${scored.length} changed (${((1 - changedTraders.length / scored.length) * 100).toFixed(1)}% skipped)`)

  // Build a rank lookup from the full sorted scored array
  const rankMap = new Map<string, number>()
  scored.forEach((t, idx) => rankMap.set(`${t.source}:${t.source_trader_id}`, idx + 1))

  // Build prev-rank lookup from currentScoreMap (already fetched above with rank column).
  // Previously this ran a second leaderboard_ranks query for just (source, source_trader_id, rank)
  // limited to 5000 rows — duplicate work, 200-600ms per cycle, and subtly different coverage
  // than currentScoreMap. Using the map we already built keeps the data consistent and removes a round trip.
  const prevRankMap = new Map<string, number>()
  for (const [key, current] of currentScoreMap) {
    if (current.rank != null) prevRankMap.set(key, current.rank)
  }

  // Upsert only changed rows in batches
  let upsertErrors = 0
  const batchUpsertSize = 50 // Reduced from 200 — DB pool exhaustion causes upsert timeouts; 50 rows fits within statement_timeout
  for (let i = 0; i < changedTraders.length; i += batchUpsertSize) {
    if (isOutOfTime(20_000)) {
      logger.warn(`[${season}] upsert loop aborted at ${i}/${changedTraders.length} — only ${Math.round(timeLeftMs() / 1000)}s left`)
      upsertAborted = true
      break
    }
    const batch = changedTraders.slice(i, i + batchUpsertSize).map((t) => {
      const key = `${t.source}:${t.source_trader_id}`
      const newRank = rankMap.get(key) ?? 0
      const prevRank = prevRankMap.get(key)
      const rankChange = prevRank != null ? prevRank - newRank : null
      const isNew = prevRank == null
      return {
      season_id: season,
      source: t.source,
      source_type: SOURCE_TYPE_MAP[t.source] || 'futures',
      source_trader_id: t.source_trader_id,
      rank: newRank,
      rank_change: rankChange,
      is_new: isNew,
      arena_score: t.arena_score,
      roi: t.roi,
      pnl: t.pnl,
      win_rate: t.win_rate,
      max_drawdown: t.max_drawdown,
      followers: t.followers,
      copiers: t.copiers ?? null,
      trades_count: t.trades_count,
      handle: t.handle,
      avatar_url: t.avatar_url,
      computed_at: new Date().toISOString(),
      profitability_score: t.profitability_score,
      risk_control_score: t.risk_control_score,
      execution_score: t.execution_score,
      score_completeness: t.score_completeness,
      trading_style: t.trading_style,
      avg_holding_hours: t.avg_holding_hours,
      style_confidence: t.style_confidence,
      sharpe_ratio: t.sharpe_ratio,
      sortino_ratio: t.sortino_ratio ?? null,
      profit_factor: t.profit_factor ?? null,
      calmar_ratio: t.calmar_ratio ?? null,
      trader_type: t.trader_type || (t.source === 'web3_bot' ? 'bot' : null),
      is_outlier: (t as Record<string, unknown>).is_outlier === true ? true : false,
    }})

    // Data gatekeeper: validate batch before write
    const { valid: validBatch, rejected } = validateBeforeWrite(batch as Record<string, unknown>[], 'leaderboard_ranks')
    if (rejected.length) logRejectedWrites(rejected, supabase)

    if (validBatch.length > 0) {
      const { error } = await supabase
        .from('leaderboard_ranks')
        .upsert(validBatch as any, { onConflict: 'season_id,source,source_trader_id' })

      if (error) {
        logger.error(`Upsert error for ${season} batch ${i}:`, error)
        upsertErrors += validBatch.length
      }
    }
  }

  // Zero out excluded traders: traders in leaderboard_ranks whose V2 data is
  // fresh but who got excluded from computation (negative ROI, <5 trades, etc.)
  // must not retain old high scores. This was the root cause of stale traders
  // sitting at #1 for days after their ROI went deeply negative.
  // Skip if upsert aborted OR running out of time — this phase does N+1 individual
  // UPDATEs which is the most expensive cleanup in the route.
  if (upsertAborted || isOutOfTime(25_000)) {
    if (upsertAborted) logger.warn(`[${season}] SKIPPING zero-out (upsert aborted)`)
    else logger.warn(`[${season}] SKIPPING zero-out — only ${Math.round(timeLeftMs() / 1000)}s left`)
  } else {
    const computedTraderIds = new Set(uniqueTraders.map(t => `${t.source}:${t.source_trader_id}`))
    const allInTraderMap = new Set(Array.from(traderMap.values()).map(t => `${t.source}:${t.source_trader_id}`))
    // Traders in traderMap but NOT in uniqueTraders = filtered out (bad ROI, too few trades, etc.)
    const excludedTraders = Array.from(allInTraderMap).filter(k => !computedTraderIds.has(k))
    if (excludedTraders.length > 0) {
      // PERF FIX: was N+1 individual UPDATEs (30-120s). Now batched by source.
      const excludedBySource = new Map<string, string[]>()
      for (const k of excludedTraders) {
        const [source, ...rest] = k.split(':')
        const id = rest.join(':')
        if (!excludedBySource.has(source)) excludedBySource.set(source, [])
        excludedBySource.get(source)!.push(id)
      }
      let zeroed = 0
      for (const [source, ids] of excludedBySource) {
        if (isOutOfTime(20_000)) {
          logger.warn(`[${season}] zero-out aborted after ${zeroed} traders`)
          break
        }
        // Batch update all excluded traders for this source in one query
        // Batch size 100 (down from 200) to reduce lock hold time on
        // leaderboard_ranks — large updates block SSR SELECTs.
        for (let i = 0; i < ids.length; i += 100) {
          const batch = ids.slice(i, i + 100)
          const { error: zeroErr } = await supabase
            .from('leaderboard_ranks')
            .update({ arena_score: 0, computed_at: new Date().toISOString() })
            .eq('season_id', season)
            .eq('source', source)
            .in('source_trader_id', batch)
            .gt('arena_score', 0)
          if (!zeroErr) zeroed += batch.length
        }
      }
      if (zeroed > 0) {
        logger.info(`${season}: zeroed out ${zeroed} excluded traders (batched by source)`)
      }
    }
  }

  // Re-rank ALL rows to fix drift from incremental upserts. Stale traders
  // (outside freshness window) keep old ranks while new traders shift numbering;
  // this global re-rank ensures rank always matches arena_score DESC ordering.
  // Skip if running out of time — next cron cycle will catch up. Logic in
  // rerank-cleanup.ts.
  if (isOutOfTime(15_000)) {
    logger.warn(`[${season}] SKIPPING re-rank — only ${Math.round(timeLeftMs() / 1000)}s left`)
  } else {
    await rerankAllRows(supabase, season)
  }

  // Clean up rows not updated in 5 days. Excluded traders (negative ROI,
  // <5 trades, etc.) never get re-computed, so their stale high-scores
  // would persist at the top of rankings forever without this cleanup.
  // Logic in rerank-cleanup.ts.
  if (isOutOfTime(10_000)) {
    logger.warn(`[${season}] SKIPPING stale-row cleanup — only ${Math.round(timeLeftMs() / 1000)}s left`)
  } else {
    const cleaned = await cleanupStaleRows(supabase, season)
    if (cleaned > 0) logger.info(`${season}: cleaned ${cleaned} stale rows (>5d old)`)
  }

  // Store the last scored count in DB so the degradation check uses a realistic baseline
  // instead of the inflated table count (which includes zombie rows from incremental upserts).
  // Persistent — no TTL expiry risk (was the root cause of the 6-day leaderboard freeze).
  try {
    await PipelineState.set(LAST_SCORED_KEY, scored.length)
  } catch (e) {
    // CRITICAL: This write prevents the 6-day leaderboard freeze (pipeline_state baseline).
    // If this fails repeatedly, the degradation check uses inflated table counts.
    logger.error(`[${season}] CRITICAL: failed to write scored count to pipeline_state: ${e instanceof Error ? e.message : String(e)}`)
  }

  const actualUpserted = scored.length - upsertErrors
  logger.info(`${season}: ranked ${scored.length} traders (${upsertErrors} upsert errors)`)
  return actualUpserted
}

// deriveWinRateMDD lives in ./helpers.ts (single source of truth, 2026-04-09)


/**
 * Pre-populate Redis with top 100 leaderboard rows for each season.
 * Runs as fire-and-forget after leaderboard computation so it doesn't
 * block the cron response. TTL = 30 min (matches cron schedule).
 */
// warmupLeaderboardCache extracted to ./post-processing.ts
