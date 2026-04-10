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
import { detectTraderType, getFreshnessHours, deriveWinRateMDD } from './helpers'
import { type TraderRow, makeAddToTraderMap } from './trader-row'
import { computeLastResortCalmar, classifyTradingStyle, markOutliers, applyArenaFollowers } from './scoring-helpers'
import { checkPlatformFreshness } from './freshness-check'
import { fetchHandleAvatarMap } from './fetch-handles'
import { enrichFromStatsDetail } from './enrich-stats-detail'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { sanitizeDisplayName } from '@/lib/utils/profanity'
import { generateIdenticonSvg } from '@/lib/utils/avatar'
import { tieredGet, tieredSet, tieredDel } from '@/lib/cache/redis-layer'
import { PipelineState } from '@/lib/services/pipeline-state'
import { env } from '@/lib/env'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { validateBeforeWrite, logRejectedWrites } from '@/lib/pipeline/validate-before-write'
import { DATA_QUALITY_BOUNDARY } from '@/lib/pipeline/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// detectTraderType, getFreshnessHours, deriveWinRateMDD all live in ./helpers.ts
// (single source of truth — duplicates removed 2026-04-09).

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
  // Verify cron secret in production
  const authHeader = request.headers.get('authorization')
  if (!env.CRON_SECRET) {
    if (process.env.NODE_ENV !== 'development') {
      return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
    }
  } else if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
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

  const supabase = getSupabaseAdmin()
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
      const { data: cacheRow } = await supabase
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
        const { data: missingScores } = await supabase
          .from('trader_snapshots_v2')
          .select('id, platform, trader_key, window')
          .is('arena_score', null)
          .gte('created_at', recentCutoff)
          .limit(1000)

        if (missingScores && missingScores.length > 0) {
          // Batch lookup from leaderboard_ranks
          const traderKeys = [...new Set(missingScores.map(r => r.trader_key))]
          const { data: ranks } = await supabase
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
  // Per-source freshness thresholds
  const freshnessISOBySource = (source: string): string => {
    const threshold = new Date()
    threshold.setHours(threshold.getHours() - getFreshnessHours(source))
    return threshold.toISOString()
  }

  // Stream directly into traderMap instead of accumulating allSnapshots array
  // This reduces peak memory from ~200MB to ~50MB by avoiding intermediate array.
  // TraderRow shape + addToTraderMap sanitize/merge logic live in ./trader-row.ts.
  const traderMap = new Map<string, TraderRow>()
  const v2CountBySource = new Map<string, number>()
  const addToTraderMap = makeAddToTraderMap(traderMap)

  // Fetch v2 FIRST so it gets dedup priority (v2 is newer, more reliable)
  // Column mapping: platform→source, trader_key→source_trader_id, window→season_id,
  //                  roi_pct→roi, pnl_usd→pnl, created_at→captured_at
  // ROOT CAUSE FIX (2026-04-09): Sequential single-platform queries.
  // Concurrent batches (even 3) still exhaust DB pool under cron storms.
  // Batch 3 sources in parallel — 3x faster than sequential with acceptable pool usage
  const batchSize = 1 // Sequential: 1 query at a time to avoid DB pool exhaustion
  const v2Window = season
  const FALLBACK_THRESHOLD = 50
  const phase1Start = Date.now()
  for (let i = 0; i < SOURCES_WITH_DATA.length; i += batchSize) {
    // Time budget: 150s (leave 150s for scoring + upsert + enrichment)
    if (Date.now() - phase1Start > 150_000) {
      logger.warn(`[${season}] Phase 1 time budget exceeded at platform ${i}/${SOURCES_WITH_DATA.length}, proceeding with ${traderMap.size} traders`)
      break
    }
    const batch = SOURCES_WITH_DATA.slice(i, i + batchSize)
    const results = await Promise.all(
      batch.map(async (source) => {
        const rows: TraderRow[] = []
        const freshnessISO = freshnessISOBySource(source)
        // Per-source 15s timeout: skip slow sources instead of blocking the entire run
        const queryWithTimeout = async <T>(promise: PromiseLike<T>): Promise<T> => {
          return Promise.race([
            promise,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${source} query timeout`)), 30_000)),
          ])
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let data: any[] | null = null
        let error: { message: string; code?: string } | null = null
        try {
          const result = await queryWithTimeout(supabase
            .from('trader_snapshots_v2')
            .select('platform, trader_key, roi_pct, pnl_usd, win_rate, max_drawdown, trades_count, followers, copiers, arena_score, updated_at, sharpe_ratio, sortino_ratio, calmar_ratio, volatility_pct, downside_volatility_pct, metrics')
            .eq('platform', source)
            .eq('window', v2Window)
            .gte('updated_at', freshnessISO)
            .order('updated_at', { ascending: false })
            .limit(1000))
          data = result.data as TraderRow[] | null
          error = result.error
        } catch (e) {
          logger.warn(`[${season}] ${source}: Phase 1 query timeout, skipping`)
          return []
        }

        // Fallback: if this window has too few traders, use 30D data
        // (many platforms only fetch one window; 30D is the most common)
        if ((!data || data.length < FALLBACK_THRESHOLD) && v2Window !== '30D') {
          try {
            const fallback = await queryWithTimeout(supabase
              .from('trader_snapshots_v2')
              .select('platform, trader_key, roi_pct, pnl_usd, win_rate, max_drawdown, trades_count, followers, copiers, arena_score, updated_at, sharpe_ratio, sortino_ratio, calmar_ratio, volatility_pct, downside_volatility_pct, metrics')
              .eq('platform', source)
              .eq('window', '30D')
              .gte('updated_at', freshnessISO)
              .order('updated_at', { ascending: false })
              .limit(1000))
            if (!fallback.error && fallback.data && fallback.data.length > (data?.length || 0)) {
              data = fallback.data
              error = fallback.error as typeof error
            }
          } catch {
            // Fallback also timed out — use primary result
          }
        }

        if (error) {
          // Retry once after 2s with smaller limit to recover from transient statement_timeout.
          logger.error(`[${season}] Query failed for ${source}: ${error.message} (code=${error.code}) — retrying with limit=1000`, { source, window: v2Window })
          await new Promise(r => setTimeout(r, 2000))
          const retry = await supabase
            .from('trader_snapshots_v2')
            .select('platform, trader_key, roi_pct, pnl_usd, win_rate, max_drawdown, trades_count, followers, copiers, arena_score, updated_at, sharpe_ratio, sortino_ratio, calmar_ratio, volatility_pct, downside_volatility_pct, metrics')
            .eq('platform', source)
            .eq('window', v2Window)
            .gte('updated_at', freshnessISO)
            .order('updated_at', { ascending: false })
            .limit(1000)
          if (retry.error) {
            logger.error(`[${season}] Retry also failed for ${source}: ${retry.error.message} — data NOT loaded (will cause false "stale" downstream)`)
            return rows
          }
          data = retry.data
        }
        if (!data?.length) return rows

        let totalJsonbFallbacks = 0
        for (const d of data) {
          // Supabase returns `numeric` columns as strings for high-precision values.
          // Must use Number() to convert, not `as number` (which is just a TS type assertion).
          // Fallback to metrics JSONB when columns are NULL (some platforms write only to JSONB).
          const m = (d.metrics as Record<string, unknown>) || {}
          let jsonbFallbackCount = 0
          const col = (key: string, jsonKey?: string) => {
            const v = d[key as keyof typeof d]
            if (v != null) { const n = Number(v); return Number.isFinite(n) ? n : null }
            const jk = jsonKey || key
            const jv = m[jk]
            if (jv != null) {
              const n = Number(jv)
              if (!Number.isFinite(n)) return null
              jsonbFallbackCount++
              return n
            }
            return null
          }
          rows.push({
            source: d.platform as string,
            source_trader_id: d.trader_key as string,
            roi: col('roi_pct', 'roi'),
            pnl: col('pnl_usd', 'pnl'),
            win_rate: col('win_rate'),
            max_drawdown: col('max_drawdown'),
            trades_count: col('trades_count'),
            followers: col('followers'),
            copiers: col('copiers'),
            arena_score: col('arena_score'),
            captured_at: d.updated_at as string,
            full_confidence_at: null,
            profitability_score: null,
            risk_control_score: null,
            execution_score: null,
            score_completeness: null,
            trading_style: null,
            avg_holding_hours: null,
            style_confidence: null,
            sharpe_ratio: d.sharpe_ratio != null ? Number(d.sharpe_ratio) : null,
            sortino_ratio: d.sortino_ratio != null ? Number(d.sortino_ratio) : null,
            profit_factor: null,
            calmar_ratio: d.calmar_ratio != null ? Number(d.calmar_ratio) : null,
            trader_type: null,
            metrics_estimated: false,
          })
          if (jsonbFallbackCount > 0) totalJsonbFallbacks++
        }
        if (totalJsonbFallbacks > 0) {
          logger.warn(`[${source}] ${totalJsonbFallbacks}/${data.length} traders used JSONB metrics fallback`)
        }
        return rows
      })
    )
    results.forEach((rows, idx) => {
      const batchSource = batch[idx]
      if (rows.length > 0) {
        v2CountBySource.set(rows[0].source, rows.length)
      } else if (batchSource) {
        logger.warn(`[${season}] ${batchSource}: 0 traders fetched from snapshots_v2 (window=${v2Window}, fallback checked)`)
      }
      rows.forEach(addToTraderMap)
    })
  }

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

  // Phase 4: Derive win_rate/max_drawdown from equity_curve (daily PnL) as universal fallback
  // This covers ALL platforms that have equity curve data but no native WR/MDD
  if (isOutOfTime(75_000)) {
    logger.warn(`[${season}] SKIPPING Phase 4 (equity_curve WR/MDD derivation) — only ${Math.round(timeLeftMs() / 1000)}s left`)
  }
  const stillNeedingData = isOutOfTime(75_000)
    ? []
    : Array.from(traderMap.values()).filter(t => t.win_rate == null || t.max_drawdown == null)
  if (stillNeedingData.length > 0) {
    const eqBySource = new Map<string, string[]>()
    for (const t of stillNeedingData) {
      const ids = eqBySource.get(t.source) || []
      ids.push(t.source_trader_id)
      eqBySource.set(t.source, ids)
    }
    let derived = 0
    await Promise.all(
      Array.from(eqBySource.entries()).map(async ([source, traderIds]) => {
        // Query equity curves for these traders (all periods, prefer 90D)
        for (let i = 0; i < traderIds.length; i += 50) {
          if (isOutOfTime(60_000)) break
          const chunk = traderIds.slice(i, i + 50)
          const { data: eqRows } = await supabase
            .from('trader_equity_curve')
            .select('source_trader_id, pnl_usd, roi_pct, data_date')
            .eq('source', source)
            .in('source_trader_id', chunk)
            .order('data_date', { ascending: true })
            .limit(1000)
          if (!eqRows?.length) continue

          // Group by trader
          const byTrader = new Map<string, Array<{ pnl: number | null; roi: number | null }>>()
          for (const row of eqRows) {
            const tid = row.source_trader_id.startsWith('0x') ? row.source_trader_id.toLowerCase() : row.source_trader_id
            const arr = byTrader.get(tid) || []
            arr.push({ pnl: row.pnl_usd, roi: row.roi_pct })
            byTrader.set(tid, arr)
          }

          for (const [tid, points] of byTrader) {
            const existing = traderMap.get(`${source}:${tid}`)
            if (!existing) continue

            // Derive win_rate from daily PnL direction (lowered from 3 to 2 points)
            if (existing.win_rate == null && points.length >= 2) {
              let wins = 0, total = 0
              for (let j = 1; j < points.length; j++) {
                const prevPnl = points[j - 1].pnl ?? 0
                const currPnl = points[j].pnl ?? 0
                const dailyPnl = currPnl - prevPnl
                if (dailyPnl > 0) wins++
                if (Math.abs(dailyPnl) > 0.01) total++
              }
              if (total >= 1) {
                existing.win_rate = Math.round((wins / total) * 10000) / 100
                derived++
              }
            }

            // Derive max_drawdown from cumulative PnL or ROI curve (lowered from 3 to 2 points)
            if (existing.max_drawdown == null && points.length >= 2) {
              let peak = 0, maxDD = 0
              // Try ROI first, fall back to PnL
              const values = points.map(p => p.roi ?? p.pnl ?? 0)
              for (const v of values) {
                if (v > peak) peak = v
                if (peak > 0) {
                  const dd = ((peak - v) / Math.abs(peak)) * 100
                  if (dd > maxDD) maxDD = dd
                }
              }
              if (maxDD > 0.01 && maxDD <= 100) {
                existing.max_drawdown = Math.round(maxDD * 100) / 100
                derived++
              }
            }
          }
        }
      })
    )
    logger.info(`[${season}] Derived ${derived} WR/MDD values from equity curves`)
  }

  // Phase 4b: Compute sharpe/sortino/calmar/profit_factor from equity_curve for traders still missing them
  // Also estimate trades_count from equity curve points for platforms that don't provide it
  if (isOutOfTime(60_000)) {
    logger.warn(`[${season}] SKIPPING Phase 4b (advanced metrics from equity_curve) — only ${Math.round(timeLeftMs() / 1000)}s left`)
  } else {
    const needAdvanced = Array.from(traderMap.values())
      .filter(t => t.roi != null && (t.sharpe_ratio == null || t.sortino_ratio == null || t.calmar_ratio == null || t.profit_factor == null || t.trades_count == null))
    if (needAdvanced.length > 0) {
      const advBySource = new Map<string, string[]>()
      for (const t of needAdvanced) {
        const ids = advBySource.get(t.source) || []
        ids.push(t.source_trader_id)
        advBySource.set(t.source, ids)
      }
      let advancedDerived = 0
      await Promise.all(
        Array.from(advBySource.entries()).map(async ([source, traderIds]) => {
          for (let i = 0; i < traderIds.length; i += 50) {
            if (isOutOfTime(50_000)) break
            const chunk = traderIds.slice(i, i + 50)
            const { data: eqRows } = await supabase
              .from('trader_equity_curve')
              .select('source_trader_id, roi_pct, pnl_usd, data_date')
              .eq('source', source)
              .in('source_trader_id', chunk)
              .order('data_date', { ascending: true })
              .limit(1000)
            if (!eqRows?.length) continue

            // Group by trader
            const byTrader = new Map<string, Array<{ roi: number; pnl: number | null; date: string }>>()
            for (const row of eqRows) {
              const tid = row.source_trader_id.startsWith('0x') ? row.source_trader_id.toLowerCase() : row.source_trader_id
              const arr = byTrader.get(tid) || []
              if (row.roi_pct != null) arr.push({ roi: Number(row.roi_pct), pnl: row.pnl_usd != null ? Number(row.pnl_usd) : null, date: row.data_date })
              byTrader.set(tid, arr)
            }

            for (const [tid, points] of byTrader) {
              const existing = traderMap.get(`${source}:${tid}`)
              if (!existing) continue

              // Estimate trades_count from equity curve data points (each point = a day with activity)
              if (existing.trades_count == null && points.length >= 2) {
                existing.trades_count = points.length
                advancedDerived++
              }

              if (points.length < 7) continue

              // Compute daily returns from cumulative ROI
              const dailyReturns: number[] = []
              for (let j = 1; j < points.length; j++) {
                dailyReturns.push(points[j].roi - points[j - 1].roi)
              }

              // Compute daily PnL changes for avg_profit/avg_loss/largest_win/largest_loss
              const dailyPnlChanges: number[] = []
              for (let j = 1; j < points.length; j++) {
                const prevPnl = points[j - 1].pnl
                const currPnl = points[j].pnl
                if (prevPnl != null && currPnl != null) {
                  const change = currPnl - prevPnl
                  if (Math.abs(change) > 0.01) dailyPnlChanges.push(change)
                }
              }

              // Sharpe ratio = (mean daily return / std dev of daily returns) * sqrt(365)
              if (existing.sharpe_ratio == null && dailyReturns.length >= 7) {
                const decimalReturns = dailyReturns.map(r => r / 100)
                const mean = decimalReturns.reduce((a, b) => a + b, 0) / decimalReturns.length
                const variance = decimalReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / decimalReturns.length
                const stdDev = Math.sqrt(variance)
                if (stdDev > 0) {
                  const sharpe = (mean / stdDev) * Math.sqrt(365)
                  existing.sharpe_ratio = Math.round(Math.max(-20, Math.min(20, sharpe)) * 10000) / 10000
                  advancedDerived++
                }
              }

              // Sortino ratio
              if (existing.sortino_ratio == null && dailyReturns.length >= 3) {
                const decimalReturns = dailyReturns.map(r => r / 100)
                const negReturns = decimalReturns.filter(r => r < 0)
                if (negReturns.length > 0) {
                  const avgReturn = decimalReturns.reduce((a, b) => a + b, 0) / decimalReturns.length
                  const downsideDev = Math.sqrt(negReturns.reduce((s, r) => s + r * r, 0) / decimalReturns.length)
                  if (downsideDev > 0) {
                    const sortino = Math.max(-10, Math.min(10, (avgReturn / downsideDev) * Math.sqrt(365)))
                    existing.sortino_ratio = Math.round(sortino * 10000) / 10000
                    advancedDerived++
                  }
                } else {
                  existing.sortino_ratio = 10 // No negative returns
                  advancedDerived++
                }
              }

              // Calmar ratio = annualized ROI / |MDD|
              if (existing.calmar_ratio == null && existing.roi != null && existing.max_drawdown != null && existing.max_drawdown > 0) {
                const periodDays = season === '7D' ? 7 : season === '30D' ? 30 : 90
                const annualizedRoi = existing.roi * (365 / periodDays)
                const calmar = annualizedRoi / Math.abs(existing.max_drawdown)
                existing.calmar_ratio = Math.round(Math.max(-10, Math.min(10, calmar)) * 10000) / 10000
                advancedDerived++
              }

              // Profit factor from daily returns (gross wins / gross losses)
              if (existing.profit_factor == null && dailyReturns.length >= 3) {
                const grossWin = dailyReturns.filter(r => r > 0).reduce((s, r) => s + r, 0)
                const grossLoss = Math.abs(dailyReturns.filter(r => r < 0).reduce((s, r) => s + r, 0))
                if (grossLoss > 0) {
                  existing.profit_factor = Math.round(Math.min(10, grossWin / grossLoss) * 10000) / 10000
                } else if (grossWin > 0) {
                  existing.profit_factor = 10
                }
                advancedDerived++
              }
            }
          }
        })
      )
      logger.info(`[${season}] Derived ${advancedDerived} sharpe/sortino/calmar/PF/trades values from equity curves`)
    }
  }

  // Phase 4b2: Fallback — compute from trader_daily_snapshots for traders still missing
  // This covers traders not reached by enrichment (which only processes top N by score)
  if (isOutOfTime(50_000)) {
    logger.warn(`[${season}] SKIPPING Phase 4b2 (advanced metrics from daily_snapshots) — only ${Math.round(timeLeftMs() / 1000)}s left`)
  } else {
    const stillNeedAdvanced = Array.from(traderMap.values())
      .filter(t => t.roi != null && (t.sharpe_ratio == null || t.sortino_ratio == null || t.calmar_ratio == null || t.profit_factor == null))
    if (stillNeedAdvanced.length > 0) {
      const dsBySource = new Map<string, string[]>()
      for (const t of stillNeedAdvanced) {
        const ids = dsBySource.get(t.source) || []
        ids.push(t.source_trader_id)
        dsBySource.set(t.source, ids)
      }
      let dailyDerived = 0
      await Promise.all(
        Array.from(dsBySource.entries()).map(async ([source, traderIds]) => {
          for (let i = 0; i < traderIds.length; i += 100) {
            if (isOutOfTime(40_000)) break
            const chunk = traderIds.slice(i, i + 100)
            const { data: dsRows } = await supabase
              .from('trader_daily_snapshots')
              .select('trader_key, date, daily_return_pct, roi')
              .eq('platform', source)
              .in('trader_key', chunk)
              .gte('date', DATA_QUALITY_BOUNDARY)
              .order('date', { ascending: true })
              .limit(10000)
            if (!dsRows?.length) continue

            // Group by trader — collect daily_return_pct AND roi for fallback computation
            const byTraderRaw = new Map<string, Array<{ daily_return_pct: number | null; roi: number | null }>>()
            for (const row of dsRows) {
              const tid = row.trader_key.startsWith('0x') ? row.trader_key.toLowerCase() : row.trader_key
              if (!byTraderRaw.has(tid)) byTraderRaw.set(tid, [])
              byTraderRaw.get(tid)!.push({
                daily_return_pct: row.daily_return_pct != null ? Number(row.daily_return_pct) : null,
                roi: row.roi != null ? Number(row.roi) : null,
              })
            }

            // Compute daily returns: prefer daily_return_pct, fallback to ROI diff between consecutive days
            const byTrader = new Map<string, number[]>()
            for (const [tid, rows] of byTraderRaw) {
              const returns: number[] = []
              for (let r = 0; r < rows.length; r++) {
                const ret = rows[r].daily_return_pct
                if (ret != null && !isNaN(ret)) {
                  returns.push(ret)
                } else if (r > 0 && rows[r].roi != null && rows[r - 1].roi != null) {
                  // Compute daily return from consecutive ROI values
                  const diff = rows[r].roi! - rows[r - 1].roi!
                  if (Math.abs(diff) < 1000) returns.push(diff)
                }
              }
              byTrader.set(tid, returns)
            }

            for (const [tid, dailyReturns] of byTrader) {
              const existing = traderMap.get(`${source}:${tid}`)
              if (!existing || dailyReturns.length < 3) continue

              // Sharpe ratio from daily snapshots
              if (existing.sharpe_ratio == null && dailyReturns.length >= 7) {
                const decReturns = dailyReturns.map(r => r / 100)
                const mean = decReturns.reduce((a, b) => a + b, 0) / decReturns.length
                const variance = decReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / decReturns.length
                const stdDev = Math.sqrt(variance)
                if (stdDev > 0) {
                  const sharpe = (mean / stdDev) * Math.sqrt(365)
                  existing.sharpe_ratio = Math.round(Math.max(-20, Math.min(20, sharpe)) * 10000) / 10000
                  dailyDerived++
                }
              }

              // Sortino
              if (existing.sortino_ratio == null && dailyReturns.length >= 3) {
                const decReturns = dailyReturns.map(r => r / 100)
                const negReturns = decReturns.filter(r => r < 0)
                if (negReturns.length > 0) {
                  const avg = decReturns.reduce((a, b) => a + b, 0) / decReturns.length
                  const dsd = Math.sqrt(negReturns.reduce((s, r) => s + r * r, 0) / decReturns.length)
                  if (dsd > 0) {
                    existing.sortino_ratio = Math.round(Math.max(-10, Math.min(10, (avg / dsd) * Math.sqrt(365))) * 10000) / 10000
                    dailyDerived++
                  }
                } else {
                  existing.sortino_ratio = 10
                  dailyDerived++
                }
              }

              // Calmar
              if (existing.calmar_ratio == null && existing.roi != null && existing.max_drawdown != null && existing.max_drawdown > 0) {
                const periodDays = season === '7D' ? 7 : season === '30D' ? 30 : 90
                const annRoi = existing.roi * (365 / periodDays)
                existing.calmar_ratio = Math.round(Math.max(-10, Math.min(10, annRoi / Math.abs(existing.max_drawdown))) * 10000) / 10000
                dailyDerived++
              }

              // Profit factor
              if (existing.profit_factor == null && dailyReturns.length >= 3) {
                const gw = dailyReturns.filter(r => r > 0).reduce((s, r) => s + r, 0)
                const gl = Math.abs(dailyReturns.filter(r => r < 0).reduce((s, r) => s + r, 0))
                if (gl > 0) {
                  existing.profit_factor = Math.round(Math.min(10, gw / gl) * 10000) / 10000
                  dailyDerived++
                } else if (gw > 0) {
                  existing.profit_factor = 10
                  dailyDerived++
                }
              }
            }
          }
        })
      )
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
        }, `leaderboard-degrade:${season}`, 60 * 60 * 1000).catch(() => {/* non-blocking */})

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
            const staleIds = staleRows.map((r: { id: string }) => r.id)
            for (let i = 0; i < staleIds.length; i += 500) {
              await supabase.from('leaderboard_ranks').delete().in('id', staleIds.slice(i, i + 500))
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
          arena_score: r.arena_score,
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
        .upsert(validBatch, { onConflict: 'season_id,source,source_trader_id' })

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
        for (let i = 0; i < ids.length; i += 200) {
          const batch = ids.slice(i, i + 200)
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

  // Re-rank ALL rows to fix drift from incremental upserts
  // Stale traders (outside freshness window) keep old ranks while new traders shift numbering.
  // This global re-rank ensures rank always matches arena_score DESC ordering.
  // Skip if running out of time — re-rank can run on next cycle.
  if (isOutOfTime(15_000)) {
    logger.warn(`[${season}] SKIPPING re-rank — only ${Math.round(timeLeftMs() / 1000)}s left`)
  } else try {
    const { error: rerankErr } = await supabase.rpc('rerank_leaderboard', { p_season_id: season })
    if (rerankErr) {
      // Fallback: direct SQL if RPC doesn't exist
      if (rerankErr.code === '42883') {
        // RPC not available — re-rank inline (slower but correct)
        const { data: allRows } = await supabase
          .from('leaderboard_ranks')
          .select('id, arena_score')
          .eq('season_id', season)
          .order('arena_score', { ascending: false, nullsFirst: false })
        if (allRows?.length) {
          const rerankUpdates = allRows.map((r: { id: string }, idx: number) => ({ id: r.id, rank: idx + 1 }))
          for (let i = 0; i < rerankUpdates.length; i += 500) {
            await supabase.from('leaderboard_ranks').upsert(rerankUpdates.slice(i, i + 500), { onConflict: 'id' })
          }
          logger.info(`${season}: re-ranked ${rerankUpdates.length} rows (inline fallback)`)
        }
      } else {
        logger.warn(`${season}: re-rank failed: ${rerankErr.message}`)
      }
    }
  } catch (e) {
    logger.warn(`${season}: re-rank exception (non-critical):`, e)
  }

  // Clean up rows not updated in 5 days (was 14 — stale traders with old high scores
  // were persisting for weeks at the top of rankings because excluded traders' rows
  // were never re-computed, keeping outdated scores).
  // Skip if running out of time — cleanup will run on next cycle.
  if (isOutOfTime(10_000)) {
    logger.warn(`[${season}] SKIPPING stale-row cleanup — only ${Math.round(timeLeftMs() / 1000)}s left`)
  } else {
    const cutoff = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    const { data: staleRows, error: staleErr } = await supabase
      .from('leaderboard_ranks')
      .select('id')
      .eq('season_id', season)
      .lt('computed_at', cutoff)
      .limit(5000)
    if (!staleErr && staleRows && staleRows.length > 0) {
      const staleIds = staleRows.map((r: { id: string }) => r.id)
      for (let i = 0; i < staleIds.length; i += 500) {
        await supabase.from('leaderboard_ranks').delete().in('id', staleIds.slice(i, i + 500))
      }
      logger.info(`${season}: cleaned ${staleIds.length} stale rows (>5d old)`)
    }
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
