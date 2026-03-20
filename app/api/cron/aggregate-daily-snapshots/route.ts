/**
 * GET /api/cron/aggregate-daily-snapshots
 *
 * Aggregates end-of-day trader snapshots into daily records for historical analysis.
 *
 * V2: Batch queries instead of N+1 (was 3 queries per trader → now 3 total queries).
 *
 * Schedule: Daily at 00:05 UTC (Vercel cron sends GET)
 */

import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { refreshComputedMetrics } from '@/lib/cron/metrics-backfill'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const UPSERT_BATCH = 500

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()

  const startTime = Date.now()
  const plog = await PipelineLogger.start('aggregate-daily-snapshots')

  try {
    const yesterday = new Date()
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    const dateStr = yesterday.toISOString().split('T')[0]
    const today = new Date()
    const todayStr = today.toISOString().split('T')[0]

    // Step 1: Fetch ALL yesterday's snapshots in one query using RPC or direct query
    // Use distinct on (source, source_trader_id) ordered by captured_at desc to get latest per trader
    const { data: snapshots, error: snapshotError } = await supabase
      .rpc('get_latest_snapshots_for_date', { target_date: dateStr })

    let snapshotMap: Map<string, {
      source: string
      source_trader_id: string
      roi: number | null
      pnl: number | null
      win_rate: number | null
      max_drawdown: number | null
      followers: number | null
      trades_count: number | null
    }>

    if (snapshotError || !snapshots) {
      // Fallback: fetch with regular query (less optimal but works without RPC)
      logger.warn('[aggregate] RPC not available, falling back to v2 paginated query')

      // Use as_of_ts (updated on every upsert) instead of created_at (set only on INSERT).
      // created_at never changes after initial row creation, so filtering by it
      // missed most traders — only ~1000/day instead of all ~16K active traders.
      const { data: fallbackData, error: fallbackError } = await supabase
        .from('trader_snapshots_v2')
        .select('platform, trader_key, window, roi_pct, pnl_usd, win_rate, max_drawdown, followers, trades_count, as_of_ts')
        .eq('window', '90D')
        .gte('as_of_ts', `${dateStr}T00:00:00Z`)
        .lt('as_of_ts', `${todayStr}T00:00:00Z`)
        .order('as_of_ts', { ascending: false })
        .limit(50000)

      if (fallbackError || !fallbackData) {
        await plog.error(fallbackError || new Error('No snapshot data returned'))
        return NextResponse.json(
          { error: 'Failed to fetch snapshots', details: fallbackError?.message },
          { status: 500 }
        )
      }

      // Deduplicate: keep latest per (platform, trader_key) — map v2 columns to v1 shape
      snapshotMap = new Map()
      for (const s of fallbackData) {
        const key = `${s.platform}:${s.trader_key}`
        if (!snapshotMap.has(key)) {
          snapshotMap.set(key, {
            source: s.platform,
            source_trader_id: s.trader_key,
            roi: s.roi_pct,
            pnl: s.pnl_usd,
            win_rate: s.win_rate,
            max_drawdown: s.max_drawdown,
            followers: s.followers,
            trades_count: s.trades_count,
          })
        }
      }
    } else {
      snapshotMap = new Map()
      for (const s of snapshots) {
        snapshotMap.set(`${s.source}:${s.source_trader_id}`, s)
      }
    }

    // Step 1.5: Fill gaps from leaderboard_ranks (always has 100% roi/pnl coverage)
    // Many traders in LR don't have v2 snapshots yet, but we need their daily data points
    {
      const { data: lrRows } = await supabase
        .from('leaderboard_ranks')
        .select('source, source_trader_id, roi, pnl, win_rate, max_drawdown, followers, trades_count')
        .eq('season_id', '90D')
        .not('arena_score', 'is', null)
        .limit(50000)
      if (lrRows) {
        let filled = 0
        for (const lr of lrRows) {
          const key = `${lr.source}:${lr.source_trader_id}`
          if (!snapshotMap.has(key)) {
            snapshotMap.set(key, {
              source: lr.source,
              source_trader_id: lr.source_trader_id,
              roi: lr.roi,
              pnl: lr.pnl,
              win_rate: lr.win_rate,
              max_drawdown: lr.max_drawdown,
              followers: lr.followers,
              trades_count: lr.trades_count,
            })
            filled++
          } else {
            // Fill null roi/pnl from LR if v2 had nulls
            const existing = snapshotMap.get(key)!
            if (existing.roi == null && lr.roi != null) existing.roi = lr.roi
            if (existing.pnl == null && lr.pnl != null) existing.pnl = lr.pnl
          }
        }
        if (filled > 0) {
          logger.info(`[aggregate] Filled ${filled} traders from leaderboard_ranks (not in v2)`)
        }
      }
    }

    if (snapshotMap.size === 0) {
      await plog.success(0)
      return NextResponse.json({
        success: true,
        message: 'No snapshots found for yesterday',
        date: dateStr,
        processed: 0,
        inserted: 0,
      })
    }

    // Step 2: Fetch ALL previous daily snapshots in one query
    const _traderKeys = Array.from(snapshotMap.keys())
    const platforms = [...new Set(Array.from(snapshotMap.values()).map(s => s.source))]

    // Get the latest daily snapshot before dateStr for each trader (ROI + PnL for daily return calc)
    // FIXED: Use RPC function with window function to efficiently get latest record per trader
    // Replaces inefficient query with 50K limit that missed many traders (causing 3/17 coverage drop)
    const { data: prevSnapshots, error: prevError } = await supabase
      .rpc('get_latest_prev_snapshots', {
        target_platforms: platforms,
        before_date: dateStr,
      })

    if (prevError) {
      logger.warn(`[aggregate] get_latest_prev_snapshots RPC error: ${prevError.message}`)
    }

    // Build lookup: one record per trader (already filtered by RPC)
    const prevDataMap = new Map<string, { pnl: number | null; roi: number | null }>()
    if (prevSnapshots) {
      for (const ps of prevSnapshots) {
        const key = `${ps.platform}:${ps.trader_key}`
        prevDataMap.set(key, {
          pnl: ps.pnl != null ? parseFloat(String(ps.pnl)) : null,
          roi: ps.roi != null ? parseFloat(String(ps.roi)) : null,
        })
      }
    }

    // Step 3: Build upsert records
    const records: Array<{
      platform: string
      trader_key: string
      date: string
      roi: number | null
      pnl: number | null
      daily_return_pct: number | null
      win_rate: number | null
      max_drawdown: number | null
      followers: number | null
      trades_count: number | null
      cumulative_pnl: number | null
    }> = []

    for (const [key, snapshot] of snapshotMap) {
      const currentPnl = snapshot.pnl != null ? parseFloat(String(snapshot.pnl)) : null
      const currentRoi = snapshot.roi != null ? parseFloat(String(snapshot.roi)) : null
      const prev = prevDataMap.get(key)

      // Data validation: skip records with extreme values that exceed DB schema limits
      // roi: numeric(12,4) → max ~99,999,999.9999
      // pnl/cumulative_pnl: numeric(18,2) → max ~9,999,999,999,999,999.99
      // win_rate/max_drawdown: numeric(5,2) → max 999.99
      if (
        (currentRoi != null && (Math.abs(currentRoi) > 99999999 || !Number.isFinite(currentRoi))) ||
        (currentPnl != null && (Math.abs(currentPnl) > 9999999999999999 || !Number.isFinite(currentPnl))) ||
        (snapshot.win_rate != null && (Math.abs(parseFloat(String(snapshot.win_rate))) > 999 || !Number.isFinite(parseFloat(String(snapshot.win_rate))))) ||
        (snapshot.max_drawdown != null && (Math.abs(parseFloat(String(snapshot.max_drawdown))) > 999 || !Number.isFinite(parseFloat(String(snapshot.max_drawdown)))))
      ) {
        logger.warn(`[aggregate] Skipping record with extreme value: ${key}, roi=${currentRoi}, pnl=${currentPnl}`)
        continue
      }

      // Compute daily return: prefer ROI delta (works for all platforms), fallback to PnL delta
      // Apply bounds checking to prevent numeric overflow (daily_return_pct: -1000% to +1000%)
      let dailyReturnPct: number | null = null
      if (currentRoi != null && prev?.roi != null) {
        // ROI delta: e.g. today 150% - yesterday 148% = +2% daily return
        const rawReturn = currentRoi - prev.roi
        dailyReturnPct = Math.max(-1000, Math.min(1000, rawReturn))
      } else if (currentPnl != null && prev?.pnl != null && Math.abs(prev.pnl) > 0.01) {
        // PnL delta fallback (only if prev.pnl > $0.01 to avoid division by near-zero)
        const rawReturn = ((currentPnl - prev.pnl) / Math.abs(prev.pnl)) * 100
        dailyReturnPct = Math.max(-1000, Math.min(1000, rawReturn))
      }

      records.push({
        platform: snapshot.source,
        trader_key: snapshot.source_trader_id,
        date: dateStr,
        roi: snapshot.roi != null ? parseFloat(String(snapshot.roi)) : null,
        pnl: currentPnl,
        daily_return_pct: dailyReturnPct,
        win_rate: snapshot.win_rate != null ? parseFloat(String(snapshot.win_rate)) : null,
        max_drawdown: snapshot.max_drawdown != null ? parseFloat(String(snapshot.max_drawdown)) : null,
        followers: snapshot.followers ?? null,
        trades_count: snapshot.trades_count ?? null,
        cumulative_pnl: currentPnl,
      })
    }

    // Step 4: Compute Sharpe ratio from recent daily snapshots
    // For each trader, get last 30 daily_return_pct values and compute annualized Sharpe
    const tradersForSharpe = records.filter(r => r.daily_return_pct != null)
    if (tradersForSharpe.length > 0) {
      // Fetch recent daily returns (last 90 days) per-platform to avoid the 100K global
      // limit silently truncating data as the table grows beyond 100K rows in 90 days.
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().split('T')[0]
      const returnsByTrader = new Map<string, number[]>()
      const roiByTrader = new Map<string, number[]>()

      for (const platform of platforms) {
        const { data: platformDaily } = await supabase
          .from('trader_daily_snapshots')
          .select('platform, trader_key, daily_return_pct, roi')
          .eq('platform', platform)
          .gte('date', ninetyDaysAgo)
          .order('date', { ascending: true })
          .limit(10000) // max ~111 traders × 90 days — well within per-platform limits

        if (!platformDaily) continue

        for (const row of platformDaily) {
          const key = `${row.platform}:${row.trader_key}`
          if (row.daily_return_pct != null) {
            if (!returnsByTrader.has(key)) returnsByTrader.set(key, [])
            returnsByTrader.get(key)!.push(parseFloat(String(row.daily_return_pct)))
          }
          if (row.roi != null) {
            if (!roiByTrader.has(key)) roiByTrader.set(key, [])
            roiByTrader.get(key)!.push(parseFloat(String(row.roi)))
          }
        }
      }

      if (returnsByTrader.size > 0 || roiByTrader.size > 0) {
        // Compute Sharpe ratio from daily returns
        const sharpeUpdates: Array<{ source: string; source_trader_id: string; sharpe_ratio: number }> = []
        // Compute win_rate from daily returns
        const wrUpdates: Array<{ source: string; source_trader_id: string; win_rate: number }> = []

        for (const [key, returns] of returnsByTrader) {
          const [platform, ...traderKeyParts] = key.split(':')
          const trader_key = traderKeyParts.join(':')

          // Sharpe: need at least 7 data points
          if (returns.length >= 7) {
            const mean = returns.reduce((s, r) => s + r, 0) / returns.length
            const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
            const stdDev = Math.sqrt(variance)
            if (stdDev > 0) {
              const sharpe = (mean / stdDev) * Math.sqrt(365)
              if (sharpe >= -10 && sharpe <= 10) {
                sharpeUpdates.push({
                  source: platform,
                  source_trader_id: trader_key,
                  sharpe_ratio: Math.round(sharpe * 100) / 100,
                })
              }
            }
          }

          // Win rate: need at least 5 trading days
          if (returns.length >= 5) {
            const wins = returns.filter(r => r > 0).length
            const wr = (wins / returns.length) * 100
            wrUpdates.push({ source: platform, source_trader_id: trader_key, win_rate: Math.round(wr * 10) / 10 })
          }
        }

        // Compute max_drawdown from ROI history
        // MDD = max((peak - current) / peak) over ROI time series
        const mddUpdates: Array<{ source: string; source_trader_id: string; max_drawdown: number }> = []
        for (const [key, rois] of roiByTrader) {
          if (rois.length < 3) continue // need at least 3 data points
          let peak = -Infinity
          let maxDD = 0
          for (const roi of rois) {
            const equity = 100 * (1 + roi / 100)
            if (equity > peak) peak = equity
            if (peak > 0) {
              const dd = ((peak - equity) / peak) * 100
              if (dd > maxDD) maxDD = dd
            }
          }
          if (maxDD > 0 && maxDD <= 100) {
            const [platform, ...parts] = key.split(':')
            mddUpdates.push({ source: platform, source_trader_id: parts.join(':'), max_drawdown: Math.round(maxDD * 100) / 100 })
          }
        }

        // Bulk update sharpe_ratio, max_drawdown, win_rate via single RPC call
        // Replaces ~5000 individual UPDATE queries with batched RPC calls
        const allMetricUpdates: Array<{
          platform: string; trader_key: string; window: string;
          sharpe_ratio: number | null; max_drawdown: number | null; win_rate: number | null;
        }> = []

        // Build a lookup for MDD and WR by trader key
        const mddByKey = new Map<string, number>()
        for (const upd of mddUpdates) {
          mddByKey.set(`${upd.source}:${upd.source_trader_id}`, upd.max_drawdown)
        }
        const wrByKey = new Map<string, number>()
        for (const upd of wrUpdates) {
          wrByKey.set(`${upd.source}:${upd.source_trader_id}`, upd.win_rate)
        }

        // Collect all unique trader keys that need any metric update
        const allTraderKeys = new Set<string>()
        for (const upd of sharpeUpdates) allTraderKeys.add(`${upd.source}:${upd.source_trader_id}`)
        for (const upd of mddUpdates) allTraderKeys.add(`${upd.source}:${upd.source_trader_id}`)
        for (const upd of wrUpdates) allTraderKeys.add(`${upd.source}:${upd.source_trader_id}`)

        // Build sharpe lookup
        const sharpeByKey = new Map<string, number>()
        for (const upd of sharpeUpdates) {
          sharpeByKey.set(`${upd.source}:${upd.source_trader_id}`, upd.sharpe_ratio)
        }

        // Merge all metrics into unified update records (all windows)
        const WINDOWS = ['7D', '30D', '90D']
        for (const compositeKey of allTraderKeys) {
          const [platform, ...parts] = compositeKey.split(':')
          const trader_key = parts.join(':')
          for (const window of WINDOWS) {
            allMetricUpdates.push({
              platform,
              trader_key,
              window,
              sharpe_ratio: sharpeByKey.get(compositeKey) ?? null,
              max_drawdown: mddByKey.get(compositeKey) ?? null,
              win_rate: wrByKey.get(compositeKey) ?? null,
            })
          }
        }

        if (allMetricUpdates.length > 0) {
          let totalUpdated = 0
          // RPC accepts JSONB; send in batches of 1000 to avoid payload limits
          const RPC_BATCH = 1000
          for (let i = 0; i < allMetricUpdates.length; i += RPC_BATCH) {
            const batch = allMetricUpdates.slice(i, i + RPC_BATCH)
            const { data: count, error: rpcError } = await supabase
              .rpc('bulk_update_snapshot_metrics', { updates: JSON.stringify(batch) })

            if (rpcError) {
              logger.warn(`[aggregate] bulk_update_snapshot_metrics RPC error: ${rpcError.message}`)
            } else {
              totalUpdated += (count as number) || 0
            }
          }
          logger.info(`[aggregate] Bulk updated metrics: ${totalUpdated} rows (sharpe=${sharpeUpdates.length}, mdd=${mddUpdates.length}, wr=${wrUpdates.length} traders)`)
        }
      }
    }

    // Step 5: Batch upsert daily snapshots
    let inserted = 0
    let errors = 0

    for (let i = 0; i < records.length; i += UPSERT_BATCH) {
      const batch = records.slice(i, i + UPSERT_BATCH)
      const { error: upsertError } = await supabase
        .from('trader_daily_snapshots')
        .upsert(batch, { onConflict: 'platform,trader_key,date' })

      if (upsertError) {
        logger.dbError('upsert-daily-snapshots-batch', upsertError, { batchStart: i, batchSize: batch.length })
        errors += batch.length
      } else {
        inserted += batch.length
      }
    }

    // Step 6: Cleanup old trader_snapshots_v2 rows (keep 180 days)
    // Batch delete in chunks of 5000 to avoid long table locks
    // Only run if there's remaining time budget (skip if >240s elapsed)
    let cleanedUp = 0
    const elapsedMs = Date.now() - startTime
    if (elapsedMs > 240_000) {
      logger.warn('[DailySnapshots] Skipping cleanup - time budget low')
    } else {
    try {
      const cutoffDate = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString()
      const MAX_CLEANUP_BATCHES = 20
      for (let batch = 0; batch < MAX_CLEANUP_BATCHES; batch++) {
        const { count, error: cleanupErr } = await supabase
          .from('trader_snapshots_v2')
          .delete({ count: 'exact' })
          .lt('as_of_ts', cutoffDate)
          .limit(5000)
        if (cleanupErr) {
          logger.warn(`[aggregate] Snapshot cleanup error: ${cleanupErr.message}`)
          break
        }
        const deleted = count ?? 0
        cleanedUp += deleted
        if (deleted < 5000) break // No more rows to delete
      }
      if (cleanedUp > 0) logger.info(`[aggregate] Cleaned up ${cleanedUp} old snapshots_v2 rows (>180d)`)
    } catch (cleanupErr) {
      logger.warn(`[aggregate] Snapshot cleanup failed: ${cleanupErr}`)
    }
    } // end time budget check

    // Step 6b: Cleanup old trader_daily_snapshots rows (keep 365 days)
    // Batched deletes of 5K rows to avoid long table locks.
    // 377K rows growing ~1K/day: without cleanup table grows unbounded.
    let dailySnapshotsCleanedUp = 0
    const elapsedMsAfterStep6 = Date.now() - startTime
    if (elapsedMsAfterStep6 > 240_000) {
      logger.warn('[DailySnapshots] Skipping daily_snapshots cleanup - time budget low')
    } else {
      try {
        const dailyCutoffDate = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().split('T')[0]
        const MAX_DAILY_CLEANUP_BATCHES = 10 // max 50K rows per run to stay within time budget
        for (let batch = 0; batch < MAX_DAILY_CLEANUP_BATCHES; batch++) {
          const { count: deletedCount, error: dailyCleanupErr } = await supabase
            .from('trader_daily_snapshots')
            .delete({ count: 'exact' })
            .lt('date', dailyCutoffDate)
            .limit(5000)
          if (dailyCleanupErr) {
            logger.warn(`[aggregate] daily_snapshots cleanup error: ${dailyCleanupErr.message}`)
            break
          }
          const deleted = deletedCount ?? 0
          dailySnapshotsCleanedUp += deleted
          if (deleted < 5000) break // No more rows to delete
        }
        if (dailySnapshotsCleanedUp > 0) {
          logger.info(`[aggregate] Cleaned up ${dailySnapshotsCleanedUp} old daily_snapshots rows (>365d)`)
        }
      } catch (dailyCleanupErr) {
        logger.warn(`[aggregate] daily_snapshots cleanup failed: ${dailyCleanupErr}`)
      }
    }

    // Step 7: Refresh computed metrics from equity curves (sharpe, win_rate, max_drawdown, trades_count, arena_score)
    let metricsResult = null
    try {
      metricsResult = await refreshComputedMetrics(supabase)
      logger.info(`[aggregate] Metrics backfill: sharpe=${metricsResult.sharpeUpdated}, wr=${metricsResult.winRateUpdated}, mdd=${metricsResult.maxDrawdownUpdated}, score=${metricsResult.arenaScoreUpdated}`)
    } catch (metricsErr) {
      logger.warn(`[aggregate] Metrics backfill failed: ${metricsErr}`)
    }

    // Step 8: Run orphaned/stale data cleanup via RPC
    let staleDataCleanup: Record<string, number> | null = null
    try {
      const { data: cleanupResults, error: cleanupRpcError } = await supabase
        .rpc('cleanup_stale_data')

      if (cleanupRpcError) {
        logger.warn(`[aggregate] cleanup_stale_data RPC error: ${cleanupRpcError.message}`)
      } else if (cleanupResults && Array.isArray(cleanupResults)) {
        staleDataCleanup = {}
        for (const row of cleanupResults) {
          if (row.deleted_rows > 0) {
            staleDataCleanup[row.table_name] = Number(row.deleted_rows)
          }
        }
        const totalCleaned = Object.values(staleDataCleanup).reduce((s, n) => s + n, 0)
        if (totalCleaned > 0) {
          logger.info(`[aggregate] Stale data cleanup: ${JSON.stringify(staleDataCleanup)}`)
        }
      }
    } catch (cleanupErr) {
      logger.warn(`[aggregate] cleanup_stale_data failed: ${cleanupErr}`)
    }

    const duration = Date.now() - startTime

    if (errors > 0) {
      await plog.error(new Error(`${errors} upsert errors`), { inserted, errors, date: dateStr, cleanedUp, dailySnapshotsCleanedUp })
    } else {
      await plog.success(inserted, { date: dateStr, cleanedUp, dailySnapshotsCleanedUp, metricsBackfill: metricsResult, staleDataCleanup })
    }

    return NextResponse.json({
      success: true,
      date: dateStr,
      processed: snapshotMap.size,
      inserted,
      errors,
      cleanedUp,
      dailySnapshotsCleanedUp,
      staleDataCleanup,
      metricsBackfill: metricsResult,
      queries: 3,
      duration: `${duration}ms`,
    })
  } catch (error) {
    logger.apiError('/api/cron/aggregate-daily-snapshots', error, {})
    await plog.error(error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
