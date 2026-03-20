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
  debouncedConfidence,
  ARENA_CONFIG,
  type Period,
} from '@/lib/utils/arena-score'
import {
  ALL_SOURCES,
  SOURCE_TYPE_MAP,
  SOURCE_TRUST_WEIGHT,
} from '@/lib/constants/exchanges'
import { createLogger, fireAndForget } from '@/lib/utils/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { sanitizeDisplayName } from '@/lib/utils/profanity'
import { generateBlockieSvg } from '@/lib/utils/avatar'
import { tieredGet, tieredSet, tieredDel } from '@/lib/cache/redis-layer'
import { getSharedRedis } from '@/lib/cache/redis-client'
import { env } from '@/lib/env'
import { detectTraderType, getFreshnessHours, deriveWinRateMDD } from './helpers'
import { warmupLeaderboardCache } from './cache'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const logger = createLogger('compute-leaderboard')

const SEASONS: Period[] = ['7D', '30D', '90D']
const MIN_TRADES_COUNT = 1 // Allow all traders with at least 1 trade (DEX traders may have 1-2 high-quality trades)
const DEGRADATION_THRESHOLD = 0.85 // 85% — block catastrophic drops only; stale counts still inflated from pre-2026-03-15 accumulation

// P1-3: ROI anomaly thresholds per period
const ROI_ANOMALY_THRESHOLDS: Record<Period, number> = {
  '7D': 2000,
  '30D': 5000,
  '90D': 50000,
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

  // Idempotency: atomic lock to prevent duplicate concurrent runs
  const IDEMPOTENCY_KEY = 'cron:compute-leaderboard:running'
  const redis = await getSharedRedis()
  if (redis) {
    const lockAcquired = await redis.set(IDEMPOTENCY_KEY, new Date().toISOString(), { ex: 300, nx: true })
    if (!lockAcquired) {
      return NextResponse.json({ ok: true, message: 'Already running, skipped', cached: true })
    }
  } else {
    // Fallback to non-atomic check when Redis unavailable
    const cached = await tieredGet(IDEMPOTENCY_KEY, 'hot')
    if (cached.data) {
      return NextResponse.json({ ok: true, message: 'Already running, skipped', cached: true })
    }
    await tieredSet(IDEMPOTENCY_KEY, { startedAt: new Date().toISOString() }, 'hot', [])
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
        const msg = `${season}: degradation detected, upsert SKIPPED (previous: ${previousCounts[season]})`
        warnings.push(msg)
        rolledBack.push(season)
        stats.seasons[season] = previousCounts[season] // Keep old count in stats
      }
    }

    const elapsed = Date.now() - startTime
    logger.info(`Leaderboard computed in ${elapsed}ms`, stats)

    // Send Telegram alert if degradation detected
    if (warnings.length > 0) {
      try {
        const { sendTelegramAlert } = await import('@/lib/notifications/telegram')
        await sendTelegramAlert({
          level: 'critical',
          source: 'Leaderboard',
          title: '排行榜降级告警',
          message: warnings.join('\n'),
        })
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

    // Release idempotency lock
    await tieredDel(IDEMPOTENCY_KEY)

    const totalRanked = Object.values(stats.seasons).reduce((a, b) => a + b, 0)
    if (warnings.length > 0) {
      await plog.error(new Error(warnings.join('; ')), { stats, rolledBack })
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
    // Release idempotency lock on failure
    await tieredDel(IDEMPOTENCY_KEY).catch(() => {})
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
    roi: number
    pnl: number
    win_rate: number | null
    max_drawdown: number | null
    trades_count: number | null
    followers: number | null
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
      if (snap.trading_style != null && existing.trading_style == null) existing.trading_style = snap.trading_style
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
  for (let i = 0; i < ALL_SOURCES.length; i += batchSize) {
    const batch = ALL_SOURCES.slice(i, i + batchSize)
    const results = await Promise.all(
      batch.map(async (source) => {
        const rows: TraderRow[] = []
        const freshnessISO = freshnessISOBySource(source)
        let { data, error } = await supabase
          .from('trader_snapshots_v2')
          .select('platform, trader_key, roi_pct, pnl_usd, win_rate, max_drawdown, trades_count, followers, arena_score, updated_at, sharpe_ratio')
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
            .select('platform, trader_key, roi_pct, pnl_usd, win_rate, max_drawdown, trades_count, followers, arena_score, updated_at, sharpe_ratio')
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

        for (const d of data) {
          rows.push({
            source: d.platform as string,
            source_trader_id: d.trader_key as string,
            roi: d.roi_pct as number,
            pnl: d.pnl_usd as number,
            win_rate: d.win_rate as number | null,
            max_drawdown: d.max_drawdown as number | null,
            trades_count: d.trades_count as number | null,
            followers: d.followers as number | null,
            arena_score: d.arena_score as number | null,
            captured_at: d.updated_at as string,
            full_confidence_at: null,
            profitability_score: null,
            risk_control_score: null,
            execution_score: null,
            score_completeness: null,
            trading_style: null,
            avg_holding_hours: null,
            style_confidence: null,
            sharpe_ratio: d.sharpe_ratio as number | null,
            sortino_ratio: null,
            profit_factor: null,
            calmar_ratio: null,
            trader_type: null,
            metrics_estimated: false,
          })
        }
        return rows
      })
    )
    results.forEach(rows => {
      if (rows.length > 0) {
        v2CountBySource.set(rows[0].source, rows.length)
      }
      rows.forEach(addToTraderMap)
    })
  }

  // V1 fetch removed — v2 backfill (migration 20260319b) ensures v2 has full coverage.
  // upsertTraders() writes to both v1 and v2 on every cron run, so v2 stays current.
  // If v2 coverage drops below expectations, run the backfill migration again.
  logger.info(`[${season}] ${traderMap.size} unique traders from v2`)

  // Phase 3: Fill missing metrics from trader_stats_detail (enrichment table)
  // Now fills ALL available fields: win_rate, max_drawdown, sharpe, trades_count, avg_holding_hours
  const tradersNeedingEnrichment = Array.from(traderMap.values())
    .filter(t => t.win_rate == null || t.max_drawdown == null || t.sharpe_ratio == null || t.trades_count == null || t.avg_holding_hours == null)
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
            .select('source_trader_id, profitable_trades_pct, max_drawdown, sharpe_ratio, winning_positions, total_positions, total_trades, avg_holding_time_hours, period')
            .eq('source', source)
            .in('source_trader_id', chunk)
            .order('captured_at', { ascending: false })
            .limit(2000)
          if (!statsRows) continue
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
            if (sr.profitable_trades_pct != null && existing.win_rate == null) {
              existing.win_rate = sr.profitable_trades_pct
            }
            if (sr.max_drawdown != null && existing.max_drawdown == null) {
              existing.max_drawdown = sr.max_drawdown
            }
            if (sr.sharpe_ratio != null && existing.sharpe_ratio == null) {
              existing.sharpe_ratio = sr.sharpe_ratio
            }
            // NEW: Fill trades_count from total_trades or total_positions
            if (existing.trades_count == null) {
              const tc = sr.total_trades ?? sr.total_positions
              if (tc != null && tc > 0) existing.trades_count = tc
            }
            // NEW: Fill avg_holding_hours
            if (sr.avg_holding_time_hours != null && existing.avg_holding_hours == null) {
              existing.avg_holding_hours = sr.avg_holding_time_hours
            }
          }
        }
      })
    )
    logger.info(`[${season}] Enriched ${tradersNeedingEnrichment.length} traders from stats_detail`)
  }

  // Phase 3.5: Fill trades_count + avg_holding_hours from position_history for platforms that have it
  const needingTradesOrHolding = Array.from(traderMap.values())
    .filter(t => t.trades_count == null || t.avg_holding_hours == null)
  if (needingTradesOrHolding.length > 0) {
    const phBySource = new Map<string, string[]>()
    for (const t of needingTradesOrHolding) {
      const ids = phBySource.get(t.source) || []
      ids.push(t.source_trader_id)
      phBySource.set(t.source, ids)
    }
    let phase35Count = 0
    await Promise.all(
      Array.from(phBySource.entries()).map(async ([source, traderIds]) => {
        for (let i = 0; i < traderIds.length; i += 200) {
          const chunk = traderIds.slice(i, i + 200)
          // Query position_history: count per trader + avg holding time
          const { data: phRows } = await supabase
            .from('trader_position_history')
            .select('source_trader_id, open_time, close_time')
            .eq('source', source)
            .in('source_trader_id', chunk)
            .limit(10000)
          if (!phRows?.length) continue

          // Group by trader
          const byTrader = new Map<string, Array<{ open_time: string | null; close_time: string | null }>>()
          for (const row of phRows) {
            const tid = row.source_trader_id.startsWith('0x') ? row.source_trader_id.toLowerCase() : row.source_trader_id
            const arr = byTrader.get(tid) || []
            arr.push({ open_time: row.open_time, close_time: row.close_time })
            byTrader.set(tid, arr)
          }

          for (const [tid, positions] of Array.from(byTrader.entries())) {
            const existing = traderMap.get(`${source}:${tid}`)
            if (!existing) continue

            // Fill trades_count
            if (existing.trades_count == null && positions.length > 0) {
              existing.trades_count = positions.length
              phase35Count++
            }

            // Fill avg_holding_hours from position open/close times
            if (existing.avg_holding_hours == null) {
              let totalHours = 0, count = 0
              for (const p of positions) {
                if (p.open_time && p.close_time) {
                  const open = new Date(p.open_time).getTime()
                  const close = new Date(p.close_time).getTime()
                  if (close > open && !isNaN(open) && !isNaN(close)) {
                    totalHours += (close - open) / 3600000
                    count++
                  }
                }
              }
              if (count >= 2) {
                const avg = totalHours / count
                if (avg > 0 && avg < 100000) {
                  existing.avg_holding_hours = Math.round(avg * 100) / 100
                  phase35Count++
                }
              }
            }
          }
        }
      })
    )
    if (phase35Count > 0) {
      logger.info(`[${season}] Phase 3.5: derived ${phase35Count} trades_count/avg_holding from position_history`)
    }
  }

  // Phase 4: Derive win_rate/max_drawdown/sharpe from equity_curve (daily PnL) as universal fallback
  // This covers ALL platforms that have equity curve data but no native WR/MDD/Sharpe
  const stillNeedingData = Array.from(traderMap.values())
    .filter(t => t.win_rate == null || t.max_drawdown == null || t.sharpe_ratio == null)
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

            // Derive sharpe_ratio from daily ROI returns (annualized, risk-free=0)
            if (existing.sharpe_ratio == null && points.length >= 5) {
              const roiValues = points.map(p => p.roi ?? 0)
              const dailyReturns: number[] = []
              for (let j = 1; j < roiValues.length; j++) {
                dailyReturns.push(roiValues[j] - roiValues[j - 1])
              }
              if (dailyReturns.length >= 4) {
                const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length
                const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / dailyReturns.length
                const stdDev = Math.sqrt(variance)
                if (stdDev > 0) {
                  const sharpe = (mean / stdDev) * Math.sqrt(365)
                  if (sharpe > -10 && sharpe < 10) {
                    existing.sharpe_ratio = Math.round(sharpe * 100) / 100
                    derived++
                  }
                }
              }
            }
          }
        }
      })
    )
    logger.info(`[${season}] Derived ${derived} WR/MDD values from equity curves`)
  }

  // Phase 4.5: Use daily_snapshots as fallback for sharpe (accumulated ROI over time)
  const stillNeedingSharpe = Array.from(traderMap.values())
    .filter(t => t.sharpe_ratio == null)
  if (stillNeedingSharpe.length > 0) {
    const dsBySource = new Map<string, string[]>()
    for (const t of stillNeedingSharpe) {
      const ids = dsBySource.get(t.source) || []
      ids.push(t.source_trader_id)
      dsBySource.set(t.source, ids)
    }
    let phase45Count = 0
    await Promise.all(
      Array.from(dsBySource.entries()).map(async ([source, traderIds]) => {
        for (let i = 0; i < traderIds.length; i += 200) {
          const chunk = traderIds.slice(i, i + 200)
          const { data: dsRows } = await supabase
            .from('trader_daily_snapshots')
            .select('trader_key, roi, date')
            .eq('platform', source)
            .in('trader_key', chunk)
            .not('roi', 'is', null)
            .order('date', { ascending: true })
            .limit(10000)
          if (!dsRows?.length) continue

          const byTrader = new Map<string, number[]>()
          for (const row of dsRows) {
            const tid = row.trader_key.startsWith('0x') ? row.trader_key.toLowerCase() : row.trader_key
            const arr = byTrader.get(tid) || []
            arr.push(row.roi)
            byTrader.set(tid, arr)
          }

          for (const [tid, rois] of Array.from(byTrader.entries())) {
            if (rois.length < 5) continue
            const existing = traderMap.get(`${source}:${tid}`)
            if (!existing || existing.sharpe_ratio != null) continue

            const dailyReturns: number[] = []
            for (let j = 1; j < rois.length; j++) {
              dailyReturns.push(rois[j] - rois[j - 1])
            }
            if (dailyReturns.length < 4) continue
            const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length
            const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / dailyReturns.length
            const stdDev = Math.sqrt(variance)
            if (stdDev > 0) {
              const sharpe = (mean / stdDev) * Math.sqrt(365)
              if (sharpe > -10 && sharpe < 10) {
                existing.sharpe_ratio = Math.round(sharpe * 100) / 100
                phase45Count++
              }
            }
          }
        }
      })
    )
    if (phase45Count > 0) {
      logger.info(`[${season}] Phase 4.5: derived ${phase45Count} sharpe ratios from daily_snapshots`)
    }
  }

  // Phase 5: For remaining nulls, estimate from ROI + trades_count
  // If a trader has positive ROI and trades_count, we can estimate WR
  // If ROI is known, MDD can be estimated as a fraction of absolute ROI (conservative)
  // IMPORTANT: mark these as estimated so frontend can display visual indicator
  let phase5Count = 0
  for (const snap of Array.from(traderMap.values())) {
    if (snap.roi == null) continue

    // Estimate WR from ROI direction + trades_count
    if (snap.win_rate == null) {
      if (snap.trades_count != null && snap.trades_count > 0) {
        // ROI > 0 implies majority wins; ROI < 0 implies majority losses
        // Use a conservative sigmoid: WR = 50 + 30*tanh(ROI/100)
        const wr = 50 + 30 * Math.tanh(snap.roi / 100)
        snap.win_rate = Math.round(Math.max(5, Math.min(95, wr)) * 100) / 100
        snap.metrics_estimated = true
        phase5Count++
      } else if (snap.roi > 0) {
        // No trades_count but positive ROI — estimate conservatively
        snap.win_rate = Math.round(Math.max(30, Math.min(80, 50 + 20 * Math.tanh(snap.roi / 200))) * 100) / 100
        snap.metrics_estimated = true
        phase5Count++
      } else {
        // Negative ROI — below 50%
        snap.win_rate = Math.round(Math.max(10, Math.min(50, 50 + 20 * Math.tanh(snap.roi / 200))) * 100) / 100
        snap.metrics_estimated = true
        phase5Count++
      }
    }

    // Estimate MDD from ROI magnitude (conservative)
    if (snap.max_drawdown == null) {
      // Traders with high ROI typically experienced significant drawdowns
      // Conservative estimate: MDD = min(abs(ROI) * 0.3, 80) for positive ROI
      // For negative ROI: MDD = min(abs(ROI), 95)
      if (snap.roi >= 0) {
        snap.max_drawdown = Math.round(Math.min(Math.max(Math.abs(snap.roi) * 0.3, 5), 80) * 100) / 100
      } else {
        snap.max_drawdown = Math.round(Math.min(Math.abs(snap.roi), 95) * 100) / 100
      }
      snap.metrics_estimated = true
      phase5Count++
    }

    // Phase 5.5: Estimate sharpe from ROI + MDD as last resort
    if (snap.sharpe_ratio == null && snap.roi != null) {
      let estimatedSharpe: number | null = null
      if (snap.max_drawdown != null && snap.max_drawdown > 0) {
        // ROI/MDD ratio scaled via tanh to [-3, 3]
        const rawRatio = snap.roi / snap.max_drawdown
        estimatedSharpe = Math.tanh(rawRatio / 3) * 3
      } else if (snap.roi !== 0) {
        // MDD=0 or null: use ROI sign/magnitude directly
        // Positive ROI with 0 drawdown → high sharpe, negative ROI → low sharpe
        estimatedSharpe = Math.tanh(snap.roi / 100) * 2
      } else {
        // roi=0 AND mdd=0: no return, no risk → neutral sharpe
        estimatedSharpe = 0
      }
      if (estimatedSharpe != null && estimatedSharpe > -10 && estimatedSharpe < 10) {
        snap.sharpe_ratio = Math.round(estimatedSharpe * 100) / 100
        snap.metrics_estimated = true
        phase5Count++
      }
    }
  }
  if (phase5Count > 0) {
    logger.info(`[${season}] Phase 5: estimated ${phase5Count} WR/MDD/sharpe values from ROI`)
  }

  // Phase 5.6: Derive calmar_ratio from ROI/MDD, sortino from equity curve or sharpe
  let phase56Count = 0
  for (const snap of Array.from(traderMap.values())) {
    // Calmar = annualized ROI / max_drawdown
    if (snap.calmar_ratio == null && snap.roi != null && snap.max_drawdown != null && snap.max_drawdown > 0) {
      // Annualize based on season window
      const daysMap: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }
      const windowDays = daysMap[season] || 30
      const annualizedRoi = snap.roi * (365 / windowDays)
      const calmar = annualizedRoi / snap.max_drawdown
      if (calmar > -100 && calmar < 100) {
        snap.calmar_ratio = Math.round(calmar * 100) / 100
        phase56Count++
      }
    }
    // Sortino ≈ sharpe * sqrt(2) for normal distributions (conservative estimate)
    if (snap.sortino_ratio == null && snap.sharpe_ratio != null) {
      snap.sortino_ratio = Math.round(snap.sharpe_ratio * 1.41 * 100) / 100
      phase56Count++
    }
    // Profit factor from win_rate and avg profit/loss estimates
    if (snap.profit_factor == null && snap.win_rate != null && snap.win_rate > 0 && snap.win_rate < 100) {
      // PF = (WR * avg_win) / ((1-WR) * avg_loss) — estimate avg_win/avg_loss ratio from WR
      const wr = snap.win_rate / 100
      // Simple model: PF = WR / (1-WR) * adjustment (1.0-1.5 typical)
      const pf = (wr / (1 - wr))
      if (pf > 0 && pf < 50) {
        snap.profit_factor = Math.round(pf * 100) / 100
        phase56Count++
      }
    }
  }
  if (phase56Count > 0) {
    logger.info(`[${season}] Phase 5.6: derived ${phase56Count} calmar/sortino/profit_factor values`)
  }

  // Phase 6: Classify trading_style for all traders missing it
  let styleCount = 0
  for (const snap of traderMap.values()) {
    if (snap.trading_style != null) continue
    // Simple classification from available metrics
    const holding = snap.avg_holding_hours
    const trades = snap.trades_count
    if (holding != null) {
      if (holding < 1) { snap.trading_style = 'Scalper'; snap.style_confidence = 0.9 }
      else if (holding < 8) { snap.trading_style = 'Day Trader'; snap.style_confidence = 0.85 }
      else if (holding < 72) { snap.trading_style = 'Swing Trader'; snap.style_confidence = 0.8 }
      else if (holding < 720) { snap.trading_style = 'Position Trader'; snap.style_confidence = 0.75 }
      else { snap.trading_style = 'Long-Term'; snap.style_confidence = 0.7 }
      styleCount++
    } else if (trades != null && trades > 0) {
      const dailyTrades = trades / 90
      if (dailyTrades > 20) { snap.trading_style = 'Scalper'; snap.style_confidence = 0.6 }
      else if (dailyTrades > 5) { snap.trading_style = 'Day Trader'; snap.style_confidence = 0.55 }
      else if (dailyTrades > 1) { snap.trading_style = 'Swing Trader'; snap.style_confidence = 0.5 }
      else if (dailyTrades > 0.1) { snap.trading_style = 'Position Trader'; snap.style_confidence = 0.45 }
      else { snap.trading_style = 'Long-Term'; snap.style_confidence = 0.4 }
      styleCount++
    }
  }
  if (styleCount > 0) {
    logger.info(`[${season}] Phase 6: classified ${styleCount} trading styles`)
  }

  const roiThreshold = ROI_ANOMALY_THRESHOLDS[season]
  const uniqueTraders = Array.from(traderMap.values())
    .filter(t => t.roi != null)
    .filter(t => Math.abs(t.roi!) <= roiThreshold)
    .filter(t => t.roi! > -90) // 过滤已爆仓交易员（ROI < -90%），无参考价值
    .filter(t => t.trades_count == null || t.trades_count >= MIN_TRADES_COUNT)

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
        pnl: t.pnl ?? 0,
        maxDrawdown: t.max_drawdown,
        winRate: normalizedWinRate,
      },
      season
    )

    const effectiveConfidence = debouncedConfidence(
      scoreResult.scoreConfidence,
      t.full_confidence_at,
    )
    const confidenceMultiplier = ARENA_CONFIG.CONFIDENCE_MULTIPLIER[effectiveConfidence]
    const rawSubScores = scoreResult.returnScore + scoreResult.pnlScore +
                         scoreResult.drawdownScore + scoreResult.stabilityScore
    // P1-1: Apply source trust weight
    const trustWeight = SOURCE_TRUST_WEIGHT[t.source] ?? 0.5
    const finalScore = Math.round(
      Math.max(0, Math.min(100, rawSubScores * confidenceMultiplier * trustWeight)) * 100
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
      pnl: t.pnl ?? 0,
      win_rate: normalizedWinRate,
      max_drawdown: t.max_drawdown,
      followers: t.followers ?? 0,
      trades_count: t.trades_count,
      handle: displayHandle,
      avatar_url: info.avatar_url || generateBlockieSvg(t.source + '_' + t.source_trader_id, 64),
      // Score sub-components (returnScore/drawdownScore/stabilityScore/pnlScore)
      profitability_score: Math.round(scoreResult.returnScore * 100) / 100,
      risk_control_score: Math.round(scoreResult.drawdownScore * 100) / 100,
      execution_score: Math.round(scoreResult.stabilityScore * 100) / 100,
      score_completeness: Math.round(scoreResult.pnlScore * 100) / 100,
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

  // Sort by arena_score desc, then by drawdown, then by id
  scored.sort((a, b) => {
    const diff = b.arena_score - a.arena_score
    if (Math.abs(diff) > 0.01) return diff
    const mddA = Math.abs(a.max_drawdown ?? 100)
    const mddB = Math.abs(b.max_drawdown ?? 100)
    if (mddA !== mddB) return mddA - mddB
    return a.source_trader_id.localeCompare(b.source_trader_id)
  })

  // Pre-upsert degradation check: block if new count drops below DEGRADATION_THRESHOLD (85%) of previous
  // Also enforce absolute minimum of 500 traders for a viable leaderboard
  // FALLBACK: After 3 consecutive skips, force-compute anyway to prevent indefinite stale data
  const MAX_CONSECUTIVE_SKIPS = 3
  if (previousCount && previousCount > 500 && !forceWrite) {
    const ratio = scored.length / previousCount
    if (scored.length < 500 || ratio < DEGRADATION_THRESHOLD) {
      // Check consecutive skip counter from Redis
      let consecutiveSkips = 0
      try {
        const { tieredGet: tGet, tieredSet: tSet } = await import('@/lib/cache/redis-layer')
        const skipKey = `leaderboard:degradation-skips:${season}`
        const cached = await tGet(skipKey, 'hot')
        consecutiveSkips = (cached?.data as number) || 0
        consecutiveSkips++
        await tSet(skipKey, consecutiveSkips, 'warm', [])
      } catch { /* Redis failure — proceed with skip */ }

      if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
        logger.warn(`${season}: degradation detected (${scored.length}/${previousCount}, ${(ratio * 100).toFixed(1)}%) but FORCE-COMPUTING after ${consecutiveSkips} consecutive skips to prevent stale data`)
        // Reset counter and fall through to upsert
        try {
          const { tieredDel: tDel } = await import('@/lib/cache/redis-layer')
          await tDel(`leaderboard:degradation-skips:${season}`)
        } catch { /* non-critical */ }
      } else {
        logger.error(`${season}: computed ${scored.length} traders (previous: ${previousCount}, ratio: ${(ratio * 100).toFixed(1)}%). SKIPPING — below ${DEGRADATION_THRESHOLD * 100}% threshold (skip ${consecutiveSkips}/${MAX_CONSECUTIVE_SKIPS}).`)
        return -1
      }
    }
  } else if (forceWrite) {
    logger.warn(`${season}: force write enabled, skipping degradation check (scored: ${scored.length}, previous: ${previousCount})`)
  }
  // Reset consecutive skip counter on successful computation
  try {
    const { tieredDel: tDel } = await import('@/lib/cache/redis-layer')
    await tDel(`leaderboard:degradation-skips:${season}`)
  } catch { /* non-critical */ }

  // Phase 2: Incremental upsert — only update changed rows to reduce write volume ~40%
  // Fetch current arena_scores to diff against
  const currentScoreMap = new Map<string, { arena_score: number; rank: number; handle: string | null; avatar_url: string | null; sharpe_ratio: number | null; trading_style: string | null; trades_count: number | null; calmar_ratio: number | null; sortino_ratio: number | null; profit_factor: number | null }>()
  {
    // Fetch in pages of 1000 to handle large leaderboards
    let offset = 0
    const PAGE = 1000
    const MAX_PAGES = 100
    let pageCount = 0
    while (true) {
      if (++pageCount > MAX_PAGES) {
        console.warn(`[compute-leaderboard] Reached MAX_PAGES (${MAX_PAGES}) for season ${season}, breaking`)
        break
      }
      const { data: currentScores } = await supabase
        .from('leaderboard_ranks')
        .select('source, source_trader_id, arena_score, rank, handle, avatar_url, sharpe_ratio, trading_style, trades_count, calmar_ratio, sortino_ratio, profit_factor')
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
          trading_style: r.trading_style,
          trades_count: r.trades_count,
          calmar_ratio: r.calmar_ratio,
          sortino_ratio: r.sortino_ratio,
          profit_factor: r.profit_factor,
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
    // Always update if derived metrics were newly filled
    if (t.sharpe_ratio != null && current.sharpe_ratio == null) return true
    if (t.trading_style != null && current.trading_style == null) return true
    if (t.trades_count != null && current.trades_count == null) return true
    if (t.calmar_ratio != null && current.calmar_ratio == null) return true
    if (t.sortino_ratio != null && current.sortino_ratio == null) return true
    if (t.profit_factor != null && current.profit_factor == null) return true
    const newRank = idx + 1
    if (current.rank !== newRank) return true // rank changed
    if (current.arena_score === 0) return t.arena_score !== 0 // was zero, check if now non-zero
    return Math.abs(t.arena_score - current.arena_score) > current.arena_score * 0.005 // >0.5% score change
  })

  logger.info(`[${season}] Incremental upsert: ${changedTraders.length}/${scored.length} changed (${((1 - changedTraders.length / scored.length) * 100).toFixed(1)}% skipped)`)

  // Build a rank lookup from the full sorted scored array
  const rankMap = new Map<string, number>()
  scored.forEach((t, idx) => rankMap.set(`${t.source}:${t.source_trader_id}`, idx + 1))

  // Upsert only changed rows in batches
  let upsertErrors = 0
  const batchUpsertSize = 500
  for (let i = 0; i < changedTraders.length; i += batchUpsertSize) {
    const batch = changedTraders.slice(i, i + batchUpsertSize).map((t) => ({
      season_id: season,
      source: t.source,
      source_type: SOURCE_TYPE_MAP[t.source] || 'futures',
      source_trader_id: t.source_trader_id,
      rank: rankMap.get(`${t.source}:${t.source_trader_id}`) ?? 0,
      arena_score: t.arena_score,
      roi: t.roi,
      pnl: t.pnl,
      win_rate: t.win_rate,
      max_drawdown: t.max_drawdown,
      followers: t.followers,
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
      sortino_ratio: t.sortino_ratio,
      calmar_ratio: t.calmar_ratio,
      profit_factor: t.profit_factor,
      metrics_estimated: t.metrics_estimated,
      trader_type: t.trader_type || (t.source === 'web3_bot' ? 'bot' : null),
    }))

    const { error } = await supabase
      .from('leaderboard_ranks')
      .upsert(batch, { onConflict: 'season_id,source,source_trader_id' })

    if (error) {
      logger.error(`Upsert error for ${season} batch ${i}:`, error)
      upsertErrors += batch.length
    }
  }

  // Clean up rows not updated in 3 days (stale data from dropped traders)
  // Previously used 14-day cutoff which left too many stale null-metric rows.
  const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
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

  const actualUpserted = scored.length - upsertErrors
  logger.info(`${season}: ranked ${scored.length} traders (${upsertErrors} upsert errors)`)
  return actualUpserted
}
