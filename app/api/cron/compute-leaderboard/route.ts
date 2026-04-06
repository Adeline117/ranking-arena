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
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { sanitizeDisplayName } from '@/lib/utils/profanity'
import { generateIdenticonSvg } from '@/lib/utils/avatar'
import { tieredGet, tieredSet, tieredDel } from '@/lib/cache/redis-layer'
import { PipelineState } from '@/lib/services/pipeline-state'
import { env } from '@/lib/env'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// DEX sources where 0x addresses may be bots
const DEX_SOURCES = new Set(['hyperliquid', 'gmx', 'dydx', 'drift', 'aevo', 'gains', 'jupiter_perps'])

// Heuristic bot detection for DEX traders
// Enhanced bot detection (freqtrade 47.8K★ trading frequency patterns)
function detectTraderType(
  source: string,
  sourceId: string,
  tradesCount: number | null,
  existingType: string | null,
  avgHoldingHours?: number | null,
  winRate?: number | null,
): 'human' | 'bot' | null {
  // Explicit type always wins
  if (existingType === 'human' || existingType === 'bot') return existingType
  // web3_bot source is always bot
  if (source === 'web3_bot') return 'bot'

  if (DEX_SOURCES.has(source) && sourceId.startsWith('0x')) {
    // High trade count → likely bot
    if (tradesCount != null && tradesCount > 500) return 'bot'
    // Extremely short hold times + high trade count → algorithmic trading
    if (avgHoldingHours != null && avgHoldingHours < 0.5 && tradesCount != null && tradesCount > 100) return 'bot'
    // Suspiciously perfect win rate with many trades → likely bot
    if (winRate != null && winRate >= 95 && tradesCount != null && tradesCount > 50) return 'bot'
  }

  return null
}

const logger = createLogger('compute-leaderboard')

const SEASONS: Period[] = ['7D', '30D', '90D']
/** Per-platform freshness thresholds: CEX=48h, DEX=72h
 *  Tightened from 168h (7d) now that all fetcher groups run every 3-6h.
 *  If a platform's data is >2-3 days old, it's genuinely stale. */
const DATA_FRESHNESS_HOURS_CEX = 48
const DATA_FRESHNESS_HOURS_DEX = 72

function getFreshnessHours(source: string): number {
  const sourceType = SOURCE_TYPE_MAP[source]
  return sourceType === 'web3' ? DATA_FRESHNESS_HOURS_DEX : DATA_FRESHNESS_HOURS_CEX
}
const MIN_TRADES_COUNT = 1 // Allow all traders with at least 1 trade (DEX traders may have 1-2 high-quality trades)
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

  // Idempotency: atomic SET NX EX (no race window between get and set)
  const IDEMPOTENCY_KEY = 'cron:compute-leaderboard:running'
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
    return NextResponse.json({ ok: true, message: 'Already running (atomic lock)', cached: true })
  }

  const supabase = getSupabaseAdmin()
  const startTime = Date.now()
  const stats = { seasons: {} as Record<string, number> }
  const warnings: string[] = []
  const rolledBack: string[] = []
  const plog = await PipelineLogger.start('compute-leaderboard')

  try {
    // P0-2: Record current counts before computing
    const previousCounts: Record<string, number> = {}
    for (const season of SEASONS) {
      const { count } = await supabase
        .from('leaderboard_ranks')
        .select('id', { count: 'exact', head: true })
        .eq('season_id', season)
      previousCounts[season] = count || 0
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

    // Phase 2: Parallelize season computation (300s → 120s)
    const results = await Promise.all(
      SEASONS.map(async (season) => {
        try {
          const count = await computeSeason(supabase, season, previousCounts[season], forceWrite)
          return { season, count, error: null }
        } catch (err) {
          logger.error(`[${season}] computeSeason failed:`, err)
          return { season, count: -1, error: err }
        }
      })
    )

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

    // Refresh leaderboard count cache after all seasons computed
    try {
      const { query: dbQuery } = await import('@/lib/db')
      await dbQuery('SELECT refresh_leaderboard_count_cache()', [])
      logger.info('Refreshed leaderboard_count_cache')
    } catch (cacheErr) {
      logger.warn('Failed to refresh leaderboard_count_cache:', cacheErr)
    }

    // Sync arena_score from leaderboard_ranks → trader_snapshots_v2 flat column
    // This ensures the v2 table has scores matching the freshly computed leaderboard
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
          // Execute in batches of 100
          let synced = 0
          for (let i = 0; i < updates.length; i += 100) {
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

    // Sync sub-scores + advanced metrics: leaderboard_ranks → trader_snapshots_v2
    // Fills orphan v2 columns (return_score/drawdown_score/stability_score = 0 rows,
    // sortino_ratio/calmar_ratio = 247 rows vs LR's 39K+)
    fireAndForget((async () => {
      try {
        const { data: lrRows } = await supabase
          .from('leaderboard_ranks')
          .select('source, source_trader_id, season_id, profitability_score, risk_control_score, execution_score, sortino_ratio, calmar_ratio')
          .not('profitability_score', 'is', null)
          .limit(5000)
        if (!lrRows?.length) return

        const scoreMap = new Map<string, typeof lrRows[0]>()
        for (const r of lrRows) scoreMap.set(`${r.source}:${r.source_trader_id}:${r.season_id}`, r)

        const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
        const { data: v2Rows } = await supabase
          .from('trader_snapshots_v2')
          .select('id, platform, trader_key, window')
          .is('return_score', null)
          .not('arena_score', 'is', null)
          .gte('created_at', cutoff)
          .limit(2000)
        if (!v2Rows?.length) return

        const updates: Array<Record<string, unknown>> = []
        for (const row of v2Rows) {
          const lr = scoreMap.get(`${row.platform}:${row.trader_key}:${row.window}`)
          if (lr?.profitability_score != null) {
            updates.push({
              id: row.id,
              return_score: Number(lr.profitability_score),
              drawdown_score: lr.risk_control_score != null ? Number(lr.risk_control_score) : null,
              stability_score: lr.execution_score != null ? Number(lr.execution_score) : null,
              sortino_ratio: lr.sortino_ratio != null ? Number(lr.sortino_ratio) : null,
              calmar_ratio: lr.calmar_ratio != null ? Number(lr.calmar_ratio) : null,
            })
          }
        }

        let synced = 0
        for (let i = 0; i < updates.length; i += 100) {
          const chunk = updates.slice(i, i + 100)
          const { error } = await supabase.from('trader_snapshots_v2').upsert(chunk, { onConflict: 'id' })
          if (!error) synced += chunk.length
        }
        if (synced > 0) logger.info(`Synced sub-scores to v2: ${synced}/${v2Rows.length} rows`)
      } catch (e) {
        logger.warn('Sub-score sync to v2 failed (non-critical):', e)
      }
    })(), 'sync-subscores-to-v2')

    // Post-compute: derive WR/MDD from historical snapshots for traders missing them
    let wrMddDerived = 0
    try {
      wrMddDerived = await deriveWinRateMDD(supabase)
      if (wrMddDerived > 0) logger.info(`Derived WR/MDD for ${wrMddDerived} traders`)
    } catch (e) {
      logger.warn('WR/MDD derivation failed (non-critical):', e)
    }

    // Fire-and-forget: warm Redis cache with top 100 for each season
    fireAndForget(warmupLeaderboardCache(supabase), 'warmup-leaderboard-cache')

    // Fire-and-forget: warm the SSR homepage cache (home-initial-traders:90D)
    // This keeps getInitialTraders() hitting Redis instead of doing a cold DB query on page load
    fireAndForget((async () => {
      const { fetchLeaderboardFromDB } = await import('@/lib/getInitialTraders')
      await fetchLeaderboardFromDB('90D', 50)
      logger.info('[warmup] Refreshed home-initial-traders:90D SSR cache')
    })(), 'warmup-ssr-homepage-cache')

    // Fire-and-forget: sync Redis sorted sets for near-real-time rankings
    fireAndForget((async () => {
      const { syncSortedSetFromLeaderboard } = await import('@/lib/realtime/ranking-store')
      for (const season of SEASONS) {
        await syncSortedSetFromLeaderboard(supabase, season)
      }
    })(), 'sync-redis-sorted-set')

    // Fire-and-forget: revalidate top exchange ranking pages so ISR picks up fresh data
    fireAndForget((async () => {
      const { revalidatePath } = await import('next/cache')
      const topExchanges = ['binance_futures', 'bybit', 'hyperliquid', 'okx_futures', 'bitget_futures']
      for (const exchange of topExchanges) {
        revalidatePath(`/rankings/${exchange}`)
      }
      revalidatePath('/') // homepage
    })(), 'revalidate-ranking-pages')

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
): Promise<number> {
  // Per-source freshness thresholds
  const freshnessISOBySource = (source: string): string => {
    const threshold = new Date()
    threshold.setHours(threshold.getHours() - getFreshnessHours(source))
    return threshold.toISOString()
  }

  // Collect all traders across all sources
  interface TraderRow {
    source: string
    source_trader_id: string
    roi: number | null
    pnl: number | null
    win_rate: number | null
    max_drawdown: number | null
    trades_count: number | null
    followers: number | null
    copiers: number | null
    arena_score: number | null
    captured_at: string
    full_confidence_at: string | null
    profitability_score: number | null
    risk_control_score: number | null
    execution_score: number | null
    score_completeness: string | null
    trading_style: string | null
    avg_holding_hours: number | null
    style_confidence: number | null
    sharpe_ratio: number | null
    sortino_ratio: number | null
    profit_factor: number | null
    calmar_ratio: number | null
    trader_type: string | null
    metrics_estimated: boolean
  }

  // Stream directly into traderMap instead of accumulating allSnapshots array
  // This reduces peak memory from ~200MB to ~50MB by avoiding intermediate array
  const traderMap = new Map<string, TraderRow>()
  const v2CountBySource = new Map<string, number>()

  function addToTraderMap(snap: TraderRow) {
    if (snap.source_trader_id.startsWith('0x')) {
      snap.source_trader_id = snap.source_trader_id.toLowerCase()
    }
    // Ensure metrics_estimated is initialized (v1 snapshots don't have this field)
    if (snap.metrics_estimated == null) snap.metrics_estimated = false

    // --- Boundary sanitization (safety net for all data sources) ---
    // ROI: null out extreme values (> 100,000% or < -100%)
    if (snap.roi != null && (snap.roi > 100000 || snap.roi < -100)) {
      snap.roi = null
    }
    // Win rate: must be 0-100%
    if (snap.win_rate != null && (snap.win_rate > 100 || snap.win_rate < 0)) {
      snap.win_rate = null
    }
    // Max drawdown: must be 0-100%
    if (snap.max_drawdown != null && (snap.max_drawdown > 100 || snap.max_drawdown < 0)) {
      snap.max_drawdown = null
    }
    // MDD=0% with ROI > 50% is almost certainly missing data, not real zero drawdown.
    if (snap.max_drawdown === 0 && snap.roi != null && Math.abs(snap.roi) > 50) {
      snap.max_drawdown = null
    }
    // MDD < 1% with ROI > 500% is physically implausible — enrichment likely computed
    // from a tiny subset of trades (e.g. 43 out of 523). Null it out.
    if (snap.max_drawdown != null && snap.max_drawdown < 1 && snap.roi != null && snap.roi > 500) {
      snap.max_drawdown = null
    }
    // Sharpe ratio: must be -20 to 20
    if (snap.sharpe_ratio != null && (snap.sharpe_ratio > 20 || snap.sharpe_ratio < -20)) {
      snap.sharpe_ratio = null
    }
    // Win rate sanity: null out contradictory values
    // - WR=0% with positive ROI is impossible (at least one winning trade)
    // - WR=100% with negative ROI is impossible
    // - WR=100% with trades < 2 is statistically meaningless
    if (snap.win_rate != null && snap.roi != null) {
      if (snap.win_rate === 0 && snap.roi > 10) { snap.win_rate = null }
      else if (snap.win_rate >= 100 && snap.roi < -10) { snap.win_rate = null }
    }
    if (snap.win_rate != null && snap.win_rate >= 100 && snap.trades_count != null && snap.trades_count < 2) {
      snap.win_rate = null
    }
    // WR=100% with no trade count info is unverifiable — null it out
    if (snap.win_rate != null && snap.win_rate >= 100 && (snap.trades_count == null || snap.trades_count === 0)) {
      snap.win_rate = null
    }

    const key = `${snap.source}:${snap.source_trader_id}`
    if (!traderMap.has(key)) {
      traderMap.set(key, snap)
    } else {
      // Merge: fill null fields from the duplicate
      const existing = traderMap.get(key)!
      if (snap.win_rate != null && existing.win_rate == null) existing.win_rate = snap.win_rate
      if (snap.max_drawdown != null && existing.max_drawdown == null) existing.max_drawdown = snap.max_drawdown
      if (snap.trades_count != null && existing.trades_count == null) existing.trades_count = snap.trades_count
      if (snap.followers != null && existing.followers == null) existing.followers = snap.followers
      if (snap.sharpe_ratio != null && existing.sharpe_ratio == null) existing.sharpe_ratio = snap.sharpe_ratio
      if (snap.profitability_score != null && existing.profitability_score == null) existing.profitability_score = snap.profitability_score
      if (snap.risk_control_score != null && existing.risk_control_score == null) existing.risk_control_score = snap.risk_control_score
      if (snap.execution_score != null && existing.execution_score == null) existing.execution_score = snap.execution_score
      if (snap.sortino_ratio != null && existing.sortino_ratio == null) existing.sortino_ratio = snap.sortino_ratio
      if (snap.profit_factor != null && existing.profit_factor == null) existing.profit_factor = snap.profit_factor
      if (snap.calmar_ratio != null && existing.calmar_ratio == null) existing.calmar_ratio = snap.calmar_ratio
      if (snap.trading_style != null && existing.trading_style == null) existing.trading_style = snap.trading_style
      if (snap.avg_holding_hours != null && existing.avg_holding_hours == null) existing.avg_holding_hours = snap.avg_holding_hours
      if (snap.trader_type != null && existing.trader_type == null) existing.trader_type = snap.trader_type
      if (snap.full_confidence_at &&
          (!existing.full_confidence_at || snap.full_confidence_at > existing.full_confidence_at)) {
        existing.full_confidence_at = snap.full_confidence_at
      }
    }
  }

  // Fetch v2 FIRST so it gets dedup priority (v2 is newer, more reliable)
  // Column mapping: platform→source, trader_key→source_trader_id, window→season_id,
  //                  roi_pct→roi, pnl_usd→pnl, created_at→captured_at
  const batchSize = 10
  const v2Window = season // V2 uses same format as v1: '7D', '30D', '90D'
  // Minimum trader threshold: if a platform has fewer than this many traders
  // in the requested window, fall back to 30D data (most platforms fetch 30D)
  const FALLBACK_THRESHOLD = 50
  for (let i = 0; i < SOURCES_WITH_DATA.length; i += batchSize) {
    const batch = SOURCES_WITH_DATA.slice(i, i + batchSize)
    const results = await Promise.all(
      batch.map(async (source) => {
        const rows: TraderRow[] = []
        const freshnessISO = freshnessISOBySource(source)
        let { data, error } = await supabase
          .from('trader_snapshots_v2')
          .select('platform, trader_key, roi_pct, pnl_usd, win_rate, max_drawdown, trades_count, followers, copiers, arena_score, updated_at, sharpe_ratio, sortino_ratio, calmar_ratio, volatility_pct, downside_volatility_pct, metrics')
          .eq('platform', source)
          .eq('window', v2Window)
          .gte('updated_at', freshnessISO)
          .order('updated_at', { ascending: false })
          .limit(5000)

        // Fallback: if this window has too few traders, use 30D data
        // (many platforms only fetch one window; 30D is the most common)
        if ((!data || data.length < FALLBACK_THRESHOLD) && v2Window !== '30D') {
          const fallback = await supabase
            .from('trader_snapshots_v2')
            .select('platform, trader_key, roi_pct, pnl_usd, win_rate, max_drawdown, trades_count, followers, copiers, arena_score, updated_at, sharpe_ratio, sortino_ratio, calmar_ratio, volatility_pct, downside_volatility_pct, metrics')
            .eq('platform', source)
            .eq('window', '30D')
            .gte('updated_at', freshnessISO)
            .order('updated_at', { ascending: false })
            .limit(5000)
          if (!fallback.error && fallback.data && fallback.data.length > (data?.length || 0)) {
            data = fallback.data
            error = fallback.error
          }
        }

        if (error || !data?.length) return rows

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

  // Data freshness check: if ALL platforms are stale (>48h), skip computation
  const staleThresholdMs = 48 * 3600 * 1000
  const now = Date.now()
  const stalePlatforms: string[] = []
  const freshPlatforms: string[] = []
  for (const source of SOURCES_WITH_DATA) {
    const sourceTraders = Array.from(traderMap.values()).filter(t => t.source === source)
    if (sourceTraders.length === 0) {
      stalePlatforms.push(source)
      continue
    }
    const latestCaptured = Math.max(...sourceTraders.map(t => new Date(t.captured_at).getTime()))
    if (now - latestCaptured > staleThresholdMs) {
      stalePlatforms.push(source)
    } else {
      freshPlatforms.push(source)
    }
  }

  if (freshPlatforms.length === 0 && SOURCES_WITH_DATA.length > 0) {
    logger.error(`[${season}] ALL platforms are stale (>48h). Skipping computation to prevent stale leaderboard.`, { stalePlatforms })
    throw new Error(`All ${stalePlatforms.length} platforms are stale (>48h). Blocking computation.`)
  }

  if (stalePlatforms.length > 0) {
    logger.warn(`[${season}] ${stalePlatforms.length} platforms have stale data (>48h): ${stalePlatforms.join(', ')}. Computing with ${freshPlatforms.length} fresh platforms.`)
  }

  // Phase 3: Fill missing metrics from trader_stats_detail (enrichment table)
  // This catches data from enrichment runs that wrote to stats_detail but not back to snapshots
  // Now also fills: sharpe, sortino, calmar, trades_count, avg_holding_hours
  const tradersNeedingEnrichment = Array.from(traderMap.values())
    .filter(t => t.win_rate == null || t.max_drawdown == null || t.sharpe_ratio == null ||
                 t.sortino_ratio == null || t.calmar_ratio == null || t.trades_count == null)
  if (tradersNeedingEnrichment.length > 0) {
    const enrichBySource = new Map<string, string[]>()
    for (const t of tradersNeedingEnrichment) {
      const ids = enrichBySource.get(t.source) || []
      ids.push(t.source_trader_id)
      enrichBySource.set(t.source, ids)
    }
    await Promise.all(
      Array.from(enrichBySource.entries()).map(async ([source, traderIds]) => {
        for (let i = 0; i < traderIds.length; i += 100) {
          const chunk = traderIds.slice(i, i + 100)
          const { data: statsRows } = await supabase
            .from('trader_stats_detail')
            .select('source_trader_id, profitable_trades_pct, max_drawdown, sharpe_ratio, winning_positions, total_positions, total_trades, avg_holding_time_hours, volatility, copiers_count, aum, period')
            .eq('source', source)
            .in('source_trader_id', chunk)
            .order('captured_at', { ascending: false })
            .limit(2000)
          if (!statsRows) continue
          // Dedup: keep the best row per trader (prefer matching season, then most recent)
          const bestPerTrader = new Map<string, typeof statsRows[0]>()
          for (const sr of statsRows) {
            const tid = sr.source_trader_id.startsWith('0x') ? sr.source_trader_id.toLowerCase() : sr.source_trader_id
            const existing = bestPerTrader.get(tid)
            if (!existing || (sr.period === season && existing.period !== season)) {
              bestPerTrader.set(tid, sr)
            }
          }
          for (const [tid, sr] of bestPerTrader) {
            const existing = traderMap.get(`${source}:${tid}`)
            if (!existing) continue
            // Validate enrichment values before applying (stats_detail may have bad data)
            if (sr.profitable_trades_pct != null && existing.win_rate == null &&
                sr.profitable_trades_pct >= 0 && sr.profitable_trades_pct <= 100) {
              existing.win_rate = sr.profitable_trades_pct
            }
            if (sr.max_drawdown != null && existing.max_drawdown == null &&
                sr.max_drawdown >= 0 && sr.max_drawdown <= 100) {
              existing.max_drawdown = sr.max_drawdown
            }
            if (sr.sharpe_ratio != null && existing.sharpe_ratio == null &&
                sr.sharpe_ratio >= -20 && sr.sharpe_ratio <= 20) {
              existing.sharpe_ratio = sr.sharpe_ratio
            }
            // Fill trades_count from total_trades or total_positions
            if (existing.trades_count == null) {
              const tc = sr.total_trades ?? sr.total_positions
              if (tc != null && tc > 0) existing.trades_count = tc
            }
            // Fill avg_holding_hours (used for trading_style classification)
            if (existing.avg_holding_hours == null && sr.avg_holding_time_hours != null) {
              existing.avg_holding_hours = sr.avg_holding_time_hours
            }
            // copiers_count from enrichment → exchange copy-trade count
            if (sr.copiers_count != null && sr.copiers_count > 0 && existing.copiers == null) {
              existing.copiers = sr.copiers_count
            }
            // Arena followers come from trader_follows table, applied after scoring
          }
        }
      })
    )
    logger.info(`[${season}] Enriched ${tradersNeedingEnrichment.length} traders from stats_detail`)
  }

  // Phase 4: Derive win_rate/max_drawdown from equity_curve (daily PnL) as universal fallback
  // This covers ALL platforms that have equity curve data but no native WR/MDD
  const stillNeedingData = Array.from(traderMap.values())
    .filter(t => t.win_rate == null || t.max_drawdown == null)
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
          const chunk = traderIds.slice(i, i + 50)
          const { data: eqRows } = await supabase
            .from('trader_equity_curve')
            .select('source_trader_id, pnl_usd, roi_pct, data_date')
            .eq('source', source)
            .in('source_trader_id', chunk)
            .order('data_date', { ascending: true })
            .limit(5000)
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
  {
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
            const chunk = traderIds.slice(i, i + 50)
            const { data: eqRows } = await supabase
              .from('trader_equity_curve')
              .select('source_trader_id, roi_pct, pnl_usd, data_date')
              .eq('source', source)
              .in('source_trader_id', chunk)
              .order('data_date', { ascending: true })
              .limit(5000)
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
  {
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
            const chunk = traderIds.slice(i, i + 100)
            const { data: dsRows } = await supabase
              .from('trader_daily_snapshots')
              .select('trader_key, date, daily_return_pct, roi')
              .eq('platform', source)
              .in('trader_key', chunk)
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

  // Phase 4b3: Last resort — compute calmar from ROI + MDD for ALL traders still missing
  // Calmar = annualized_ROI / |MDD| — doesn't require daily returns, just total ROI and MDD
  {
    let calmarOnly = 0
    for (const snap of Array.from(traderMap.values())) {
      if (snap.calmar_ratio != null) continue
      if (snap.roi == null || snap.max_drawdown == null || snap.max_drawdown <= 0) continue
      const periodDays = season === '7D' ? 7 : season === '30D' ? 30 : 90
      const annRoi = snap.roi * (365 / periodDays)
      snap.calmar_ratio = Math.round(Math.max(-10, Math.min(10, annRoi / Math.abs(snap.max_drawdown))) * 10000) / 10000
      calmarOnly++
    }
    if (calmarOnly > 0) {
      logger.info(`[${season}] Computed ${calmarOnly} calmar ratios from ROI/MDD (no daily returns needed)`)
    }
  }

  // Phase 4c: Classify trading_style from avg_holding_hours
  for (const snap of Array.from(traderMap.values())) {
    if (snap.trading_style != null) continue
    if (snap.avg_holding_hours != null) {
      const h = snap.avg_holding_hours
      if (h < 1) { snap.trading_style = 'scalper'; snap.style_confidence = 0.8 }
      else if (h < 24) { snap.trading_style = 'day_trader'; snap.style_confidence = 0.7 }
      else if (h < 168) { snap.trading_style = 'swing'; snap.style_confidence = 0.6 }
      else { snap.trading_style = 'position'; snap.style_confidence = 0.5 }
    } else if (snap.trades_count != null && snap.trades_count > 0 && snap.roi != null) {
      // Heuristic: high trade count relative to period → likely scalper/day trader
      const periodDays = season === '7D' ? 7 : season === '30D' ? 30 : 90
      const tradesPerDay = snap.trades_count / periodDays
      if (tradesPerDay > 10) { snap.trading_style = 'scalper'; snap.style_confidence = 0.4 }
      else if (tradesPerDay > 2) { snap.trading_style = 'day_trader'; snap.style_confidence = 0.3 }
      else if (tradesPerDay > 0.3) { snap.trading_style = 'swing'; snap.style_confidence = 0.3 }
      else { snap.trading_style = 'position'; snap.style_confidence = 0.3 }
    } else if (snap.roi != null && snap.max_drawdown != null && snap.win_rate != null) {
      // Last resort: classify by risk profile (ROI magnitude + MDD + WR pattern)
      // This enables trading_style for ALL traders that have the basic 3 metrics
      const absRoi = Math.abs(snap.roi)
      const mdd = snap.max_drawdown
      const wr = snap.win_rate
      if (absRoi > 500 && mdd > 30) { snap.trading_style = 'aggressive'; snap.style_confidence = 0.25 }
      else if (wr > 65 && mdd < 15) { snap.trading_style = 'conservative'; snap.style_confidence = 0.25 }
      else if (absRoi > 100 && mdd > 15 && mdd < 50) { snap.trading_style = 'swing'; snap.style_confidence = 0.2 }
      else if (absRoi < 50 && mdd < 20) { snap.trading_style = 'conservative'; snap.style_confidence = 0.2 }
      else { snap.trading_style = 'balanced'; snap.style_confidence = 0.15 }
    }
  }

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

  // Batch fetch handles and avatars from unified `traders` table
  // (replaces two-step trader_sources + trader_profiles_v2 fallback)
  const handleMap = new Map<string, { handle: string | null; avatar_url: string | null }>()

  const bySource = new Map<string, string[]>()
  for (const t of uniqueTraders) {
    const ids = bySource.get(t.source) || []
    ids.push(t.source_trader_id)
    bySource.set(t.source, ids)
  }

  // Step 1: Query trader_profiles_v2 first (primary source)
  await Promise.all(
    Array.from(bySource.entries()).map(async ([source, traderIds]) => {
      for (let i = 0; i < traderIds.length; i += 500) {
        const chunk = traderIds.slice(i, i + 500)
        const { data: v2Data } = await supabase
          .from('trader_profiles_v2')
          .select('trader_key, display_name, avatar_url')
          .eq('platform', source)
          .in('trader_key', chunk)

        v2Data?.forEach((s: { trader_key: string; display_name: string | null; avatar_url: string | null }) => {
          const tid = s.trader_key.startsWith('0x') ? s.trader_key.toLowerCase() : s.trader_key
          handleMap.set(`${source}:${tid}`, {
            handle: s.display_name,
            avatar_url: s.avatar_url || null,
          })
        })
      }
    })
  )

  // Step 2: Targeted fallback — only query traders table for keys with NULL handles
  const missingHandleBySource = new Map<string, string[]>()
  for (const t of uniqueTraders) {
    const tid = t.source_trader_id.startsWith('0x') ? t.source_trader_id.toLowerCase() : t.source_trader_id
    const key = `${t.source}:${tid}`
    const entry = handleMap.get(key)
    if (!entry || !entry.handle) {
      const ids = missingHandleBySource.get(t.source) || []
      ids.push(t.source_trader_id)
      missingHandleBySource.set(t.source, ids)
    }
  }

  if (missingHandleBySource.size > 0) {
    await Promise.all(
      Array.from(missingHandleBySource.entries()).map(async ([source, traderIds]) => {
        for (let i = 0; i < traderIds.length; i += 500) {
          const chunk = traderIds.slice(i, i + 500)
          const { data: fallbackData } = await supabase
            .from('traders')
            .select('trader_key, handle, avatar_url')
            .eq('platform', source)
            .in('trader_key', chunk)

          fallbackData?.forEach((s: { trader_key: string; handle: string | null; avatar_url: string | null }) => {
            const tid = s.trader_key.startsWith('0x') ? s.trader_key.toLowerCase() : s.trader_key
            const key = `${source}:${tid}`
            if (!handleMap.has(key) || (!handleMap.get(key)!.handle && s.handle)) {
              handleMap.set(key, {
                handle: handleMap.get(key)?.handle || s.handle,
                avatar_url: handleMap.get(key)?.avatar_url || s.avatar_url || null,
              })
            }
          })
        }
      })
    )
  }

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

  // Pre-write validation: mark outliers to prevent data pollution
  // These stay in the array (for count) but get is_outlier=true in DB
  let outlierCount = 0
  for (const t of scored) {
    let isOutlier = false
    // |ROI| > 10,000% is almost certainly data corruption (aligned with ROI_CAP)
    if (Math.abs(t.roi) > 10000) isOutlier = true
    // PnL > $100M from non-whale sources
    if (t.pnl != null && Math.abs(t.pnl) > 100_000_000 && !['hyperliquid'].includes(t.source)) isOutlier = true
    // ROI and PnL sign mismatch — positive ROI with significant negative PnL or vice versa
    // Lowered from 1000/1000 threshold: audit found ROI=6086% with PnL=-$8K passing through
    if (t.pnl != null && t.pnl > 500 && t.roi < -50) isOutlier = true
    if (t.pnl != null && t.pnl < -500 && t.roi > 50) isOutlier = true
    // High ROI but PnL is 0 — data inconsistency (e.g. Bitfinex equity proxy mismatch)
    if (Math.abs(t.roi) > 500 && (t.pnl == null || t.pnl === 0)) isOutlier = true
    // web3_bot entries are excluded upstream in uniqueTraders filter, no need to check here

    if (isOutlier) {
      ;(t as Record<string, unknown>).is_outlier = true
      outlierCount++
    }
  }
  if (outlierCount > 0) {
    logger.info(`[${season}] Marked ${outlierCount} outliers (kept in leaderboard with is_outlier=true)`)
  }

  // Phase: Replace exchange followers with Arena internal follower counts from trader_follows
  {
    const allTraderIds = [...new Set(scored.map(t => t.source_trader_id))]
    const arenaFollowerMap = new Map<string, number>()
    // Query trader_follows in chunks of 500
    for (let i = 0; i < allTraderIds.length; i += 500) {
      const chunk = allTraderIds.slice(i, i + 500)
      try {
        const { data, error } = await supabase
          .rpc('count_trader_followers', { trader_ids: chunk })
        if (!error && data) {
          for (const row of data as { trader_id: string; cnt: number }[]) {
            arenaFollowerMap.set(row.trader_id, (arenaFollowerMap.get(row.trader_id) || 0) + row.cnt)
          }
        }
      } catch (e) {
        logger.warn(`[${season}] arena follower batch query failed, using fallback: ${e instanceof Error ? e.message : String(e)}`)
        // Fallback: individual count query
        const { data: fallbackData } = await supabase
          .from('trader_follows')
          .select('trader_id')
          .in('trader_id', chunk)
          .limit(10000)
        if (fallbackData) {
          for (const row of fallbackData) {
            arenaFollowerMap.set(row.trader_id, (arenaFollowerMap.get(row.trader_id) || 0) + 1)
          }
        }
      }
    }
    // Apply Arena follower counts to scored array
    let arenaFollowersApplied = 0
    for (const t of scored) {
      const count = arenaFollowerMap.get(t.source_trader_id) || 0
      t.followers = count
      if (count > 0) arenaFollowersApplied++
    }
    logger.info(`[${season}] Arena followers: ${arenaFollowersApplied} traders have followers (${arenaFollowerMap.size} unique trader_ids queried)`)
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

  // Fetch previous ranks to compute rank_change
  const prevRankMap = new Map<string, number>()
  const { data: prevRanks } = await supabase
    .from('leaderboard_ranks')
    .select('source, source_trader_id, rank')
    .eq('season_id', season)
    .not('rank', 'is', null)
    .limit(5000)
  if (prevRanks) {
    for (const row of prevRanks) {
      prevRankMap.set(`${row.source}:${row.source_trader_id}`, row.rank)
    }
  }

  // Upsert only changed rows in batches
  let upsertErrors = 0
  const batchUpsertSize = 500
  for (let i = 0; i < changedTraders.length; i += batchUpsertSize) {
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

    const { error } = await supabase
      .from('leaderboard_ranks')
      .upsert(batch, { onConflict: 'season_id,source,source_trader_id' })

    if (error) {
      logger.error(`Upsert error for ${season} batch ${i}:`, error)
      upsertErrors += batch.length
    }
  }

  // Re-rank ALL rows to fix drift from incremental upserts
  // Stale traders (outside freshness window) keep old ranks while new traders shift numbering.
  // This global re-rank ensures rank always matches arena_score DESC ordering.
  try {
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

  // Clean up rows not updated in 14 days (truly abandoned data)
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
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
    logger.info(`${season}: cleaned ${staleIds.length} stale rows (>14d old)`)
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

/**
 * Derive WR and MDD from historical ROI snapshots for traders missing these metrics.
 * Runs after leaderboard computation to fill gaps in platforms that don't provide WR/MDD natively.
 * WR = percentage of days where ROI increased (from v2 snapshots)
 * MDD = maximum peak-to-trough decline in equity curve
 */
async function deriveWinRateMDD(supabase: ReturnType<typeof getSupabaseAdmin>): Promise<number> {
  const { data: missing } = await supabase.from('leaderboard_ranks')
    .select('source, source_trader_id, win_rate, max_drawdown, season_id')
    .or('win_rate.is.null,max_drawdown.is.null')
    .limit(2000) // Process up to 2000 per run to stay within timeout

  if (!missing?.length) return 0

  // Group by trader (source + source_trader_id)
  const traderMap = new Map<string, typeof missing>()
  for (const row of missing) {
    const key = `${row.source}:${row.source_trader_id}`
    if (!traderMap.has(key)) traderMap.set(key, [])
    traderMap.get(key)!.push(row)
  }

  // Batch fetch ALL needed trader_snapshots_v2 rows in one query
  const allTraderKeys = [...traderMap.keys()].map(k => {
    const [platform, ...parts] = k.split(':')
    return { platform, trader_key: parts.join(':') }
  })

  // Fetch snapshots for all traders at once, grouped by platform
  const platformGroups = new Map<string, string[]>()
  for (const t of allTraderKeys) {
    if (!platformGroups.has(t.platform)) platformGroups.set(t.platform, [])
    platformGroups.get(t.platform)!.push(t.trader_key)
  }

  // Single batch fetch per platform (much fewer queries than per-trader)
  const allSnapshots: Array<{ platform: string; trader_key: string; roi_pct: number; created_at: string }> = []
  await Promise.all(
    Array.from(platformGroups.entries()).map(async ([platform, traderKeys]) => {
      for (let i = 0; i < traderKeys.length; i += 500) {
        const chunk = traderKeys.slice(i, i + 500)
        const { data: snaps } = await supabase.from('trader_snapshots_v2')
          .select('platform, trader_key, roi_pct, created_at')
          .eq('platform', platform)
          .in('trader_key', chunk)
          .not('roi_pct', 'is', null)
          .order('created_at', { ascending: true })
          .limit(50000)

        if (snaps) allSnapshots.push(...(snaps as typeof allSnapshots))
      }
    })
  )

  // Group snapshots by trader key
  const snapshotsByTrader = new Map<string, Array<{ roi_pct: number; created_at: string }>>()
  for (const snap of allSnapshots) {
    const key = `${snap.platform}:${snap.trader_key}`
    if (!snapshotsByTrader.has(key)) snapshotsByTrader.set(key, [])
    snapshotsByTrader.get(key)!.push(snap)
  }

  // Compute WR/MDD in memory and collect all updates
  const leaderboardUpdates: Array<{
    source: string; source_trader_id: string; season_id: string;
    win_rate?: number; max_drawdown?: number;
  }> = []

  for (const [compositeKey, rows] of traderMap) {
    const snapshots = snapshotsByTrader.get(compositeKey) || []
    if (snapshots.length < 2) continue

    // Deduplicate by day, keep latest per day
    const daily = new Map<string, number>()
    for (const snap of snapshots) {
      const day = snap.created_at?.slice(0, 10)
      if (day) daily.set(day, snap.roi_pct)
    }
    const rois = [...daily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(e => e[1])
    if (rois.length < 2) continue

    // Win Rate: days where ROI increased
    let wins = 0, days = 0
    for (let j = 1; j < rois.length; j++) { if (rois[j] > rois[j - 1]) wins++; days++ }
    const wr = days > 0 ? parseFloat(((wins / days) * 100).toFixed(2)) : null

    // MDD from equity curve
    const eq = rois.map(r => 1 + r / 100)
    let peak = eq[0], maxDD = 0
    for (const e of eq) { if (e > peak) peak = e; const dd = peak > 0 ? (peak - e) / peak : 0; if (dd > maxDD) maxDD = dd }
    const mdd = parseFloat((maxDD * 100).toFixed(2))

    for (const row of rows) {
      const upd: Record<string, number> = {}
      if (row.win_rate == null && wr != null) upd.win_rate = wr
      if (row.max_drawdown == null && mdd > 0) upd.max_drawdown = Math.min(mdd, 100)
      if (Object.keys(upd).length > 0) {
        leaderboardUpdates.push({
          source: rows[0].source,
          source_trader_id: rows[0].source_trader_id,
          season_id: row.season_id,
          ...upd,
        })
      }
    }
  }

  // Batch upsert all leaderboard_ranks updates (single query per batch of 500)
  let derived = 0
  const UPSERT_BATCH = 500
  for (let i = 0; i < leaderboardUpdates.length; i += UPSERT_BATCH) {
    const batch = leaderboardUpdates.slice(i, i + UPSERT_BATCH)
    // Use individual updates grouped in Promise.all with larger batches
    // (leaderboard_ranks has composite PK so we need per-row updates, but we batch them)
    const results = await Promise.all(
      batch.map(upd => {
        const updateFields: Record<string, number> = {}
        if (upd.win_rate != null) updateFields.win_rate = upd.win_rate
        if (upd.max_drawdown != null) updateFields.max_drawdown = upd.max_drawdown
        return supabase.from('leaderboard_ranks').update(updateFields)
          .eq('source', upd.source).eq('source_trader_id', upd.source_trader_id).eq('season_id', upd.season_id)
      })
    )
    derived += results.filter(r => !r.error).length
  }

  return derived
}

/**
 * Pre-populate Redis with top 100 leaderboard rows for each season.
 * Runs as fire-and-forget after leaderboard computation so it doesn't
 * block the cron response. TTL = 30 min (matches cron schedule).
 */
async function warmupLeaderboardCache(
  supabase: ReturnType<typeof getSupabaseAdmin>
): Promise<void> {
  const { tieredSet } = await import('@/lib/cache/redis-layer')

  // Pre-populate the exact cache keys that /api/traders uses
  // Key pattern: leaderboard:{season}:{exchange}:{sort}:{order}:{cursor}:{limit}
  const defaultLimit = 50
  const warmupTargets = SEASONS.map(season => ({
    season,
    key: `leaderboard:${season}:all:arena_score:desc:start:${defaultLimit}`,
  }))

  await Promise.all(
    warmupTargets.map(async ({ season, key }) => {
      const { data, error } = await supabase
        .from('leaderboard_ranks')
        .select('source, source_trader_id, rank, arena_score, roi, pnl, win_rate, max_drawdown, handle, avatar_url, followers, copiers, trades_count, sharpe_ratio, trader_type, source_type, season_id')
        .eq('season_id', season)
        .not('arena_score', 'is', null)
        .gt('arena_score', 0)
        .order('arena_score', { ascending: false })
        .limit(defaultLimit)

      if (error || !data?.length) return

      await tieredSet(key, data, 'warm', ['rankings', `season:${season}`])
      logger.info(`[warmup] Cached ${data.length} rows → ${key}`)
    })
  )
}
