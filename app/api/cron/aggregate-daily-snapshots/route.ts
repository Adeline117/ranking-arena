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

      const { data: fallbackData, error: fallbackError } = await supabase
        .from('trader_snapshots_v2')
        .select('platform, trader_key, window, roi_pct, pnl_usd, win_rate, max_drawdown, followers, trades_count, created_at')
        .eq('window', '90D')
        .gte('created_at', `${dateStr}T00:00:00Z`)
        .lt('created_at', `${todayStr}T00:00:00Z`)
        .order('created_at', { ascending: false })
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
    const { data: prevSnapshots } = await supabase
      .from('trader_daily_snapshots')
      .select('platform, trader_key, pnl, roi')
      .in('platform', platforms)
      .lt('date', dateStr)
      .order('date', { ascending: false })
      .limit(50000)

    // Build lookup: keep only the latest per trader
    const prevDataMap = new Map<string, { pnl: number | null; roi: number | null }>()
    if (prevSnapshots) {
      for (const ps of prevSnapshots) {
        const key = `${ps.platform}:${ps.trader_key}`
        if (!prevDataMap.has(key)) {
          prevDataMap.set(key, {
            pnl: ps.pnl != null ? parseFloat(String(ps.pnl)) : null,
            roi: ps.roi != null ? parseFloat(String(ps.roi)) : null,
          })
        }
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

      // Compute daily return: prefer ROI delta (works for all platforms), fallback to PnL delta
      let dailyReturnPct: number | null = null
      if (currentRoi != null && prev?.roi != null) {
        // ROI delta: e.g. today 150% - yesterday 148% = +2% daily return
        dailyReturnPct = currentRoi - prev.roi
      } else if (currentPnl != null && prev?.pnl != null && prev.pnl !== 0) {
        // PnL delta fallback
        dailyReturnPct = ((currentPnl - prev.pnl) / Math.abs(prev.pnl)) * 100
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
      // Fetch recent daily returns (last 90 days) for these traders
      const { data: recentDaily } = await supabase
        .from('trader_daily_snapshots')
        .select('platform, trader_key, daily_return_pct, roi')
        .in('platform', platforms)
        .gte('date', new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().split('T')[0])
        .order('date', { ascending: true })
        .limit(100000)

      if (recentDaily && recentDaily.length > 0) {
        // Group daily returns by trader
        const returnsByTrader = new Map<string, number[]>()
        for (const row of recentDaily) {
          if (row.daily_return_pct == null) continue
          const key = `${row.platform}:${row.trader_key}`
          if (!returnsByTrader.has(key)) returnsByTrader.set(key, [])
          returnsByTrader.get(key)!.push(parseFloat(String(row.daily_return_pct)))
        }

        // Compute Sharpe and batch update trader_snapshots_v2
        const sharpeUpdates: Array<{ source: string; source_trader_id: string; sharpe_ratio: number }> = []
        for (const [key, returns] of returnsByTrader) {
          if (returns.length < 7) continue
          const mean = returns.reduce((s, r) => s + r, 0) / returns.length
          const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
          const stdDev = Math.sqrt(variance)
          if (stdDev === 0) continue
          const sharpe = (mean / stdDev) * Math.sqrt(365)
          if (sharpe < -10 || sharpe > 10) continue
          const [platform, ...traderKeyParts] = key.split(':')
          const trader_key = traderKeyParts.join(':')
          sharpeUpdates.push({
            source: platform,
            source_trader_id: trader_key,
            sharpe_ratio: Math.round(sharpe * 100) / 100,
          })
        }

        // Batch update sharpe_ratio in trader_snapshots_v2
        if (sharpeUpdates.length > 0) {
          let sharpeUpdated = 0
          const SHARPE_BATCH = 50
          for (let i = 0; i < sharpeUpdates.length; i += SHARPE_BATCH) {
            const batch = sharpeUpdates.slice(i, i + SHARPE_BATCH)
            const results = await Promise.all(
              batch.map(upd =>
                supabase
                  .from('trader_snapshots_v2')
                  .update({ sharpe_ratio: upd.sharpe_ratio })
                  .eq('platform', upd.source)
                  .eq('trader_key', upd.source_trader_id)
              )
            )
            sharpeUpdated += results.filter(r => !r.error).length
          }
          logger.info(`[aggregate] Computed Sharpe ratio for ${sharpeUpdated}/${sharpeUpdates.length} traders`)
        }

        // Step 4b: Compute max_drawdown from ROI history for traders that lack it
        // MDD = max((peak - current) / peak) over ROI time series
        const roiByTrader = new Map<string, number[]>()
      for (const row of recentDaily) {
        if (row.roi == null) continue
        const key = `${row.platform}:${row.trader_key}`
        if (!roiByTrader.has(key)) roiByTrader.set(key, [])
        roiByTrader.get(key)!.push(parseFloat(String(row.roi)))
      }

      const mddUpdates: Array<{ source: string; source_trader_id: string; max_drawdown: number }> = []
      for (const [key, rois] of roiByTrader) {
        if (rois.length < 3) continue // need at least 3 data points
        // Convert ROI% to equity curve: 100 * (1 + roi/100)
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

      if (mddUpdates.length > 0) {
        let mddUpdated = 0
        const MDD_BATCH = 50
        for (let i = 0; i < mddUpdates.length; i += MDD_BATCH) {
          const batch = mddUpdates.slice(i, i + MDD_BATCH)
          // Update v2 snapshots where max_drawdown is null
          const results = await Promise.all(
            batch.map(upd =>
              supabase
                .from('trader_snapshots_v2')
                .update({ max_drawdown: upd.max_drawdown })
                .eq('platform', upd.source)
                .eq('trader_key', upd.source_trader_id)
                .is('max_drawdown', null)
            )
          )
          mddUpdated += results.filter(r => !r.error).length
        }
        logger.info(`[aggregate] Computed MDD for ${mddUpdated}/${mddUpdates.length} traders from ROI history`)
        }

        // Step 4c: Compute win_rate from daily ROI series for traders that lack it
        // Win rate = % of days with positive ROI change
        const dailyRoiByTrader = new Map<string, number[]>()
        for (const row of recentDaily) {
          if (row.daily_return_pct == null) continue
          const key = `${row.platform}:${row.trader_key}`
          if (!dailyRoiByTrader.has(key)) dailyRoiByTrader.set(key, [])
          dailyRoiByTrader.get(key)!.push(parseFloat(String(row.daily_return_pct)))
        }

        const wrUpdates: Array<{ source: string; source_trader_id: string; win_rate: number }> = []
        for (const [key, returns] of dailyRoiByTrader) {
          if (returns.length < 5) continue // need at least 5 trading days
          const wins = returns.filter(r => r > 0).length
          const wr = (wins / returns.length) * 100
          const [platform, ...parts] = key.split(':')
          wrUpdates.push({ source: platform, source_trader_id: parts.join(':'), win_rate: Math.round(wr * 10) / 10 })
        }

        if (wrUpdates.length > 0) {
          let wrUpdated = 0
          const WR_BATCH = 50
          for (let i = 0; i < wrUpdates.length; i += WR_BATCH) {
            const batch = wrUpdates.slice(i, i + WR_BATCH)
            const results = await Promise.all(
              batch.map(upd =>
                supabase
                  .from('trader_snapshots_v2')
                  .update({ win_rate: upd.win_rate })
                  .eq('platform', upd.source)
                  .eq('trader_key', upd.source_trader_id)
                  .is('win_rate', null)
              )
            )
            wrUpdated += results.filter(r => !r.error).length
          }
          logger.info(`[aggregate] Computed win_rate for ${wrUpdated}/${wrUpdates.length} traders from daily returns`)
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
    let cleanedUp = 0
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

    // Step 7: Refresh computed metrics from equity curves (sharpe, win_rate, max_drawdown, trades_count, arena_score)
    let metricsResult = null
    try {
      metricsResult = await refreshComputedMetrics(supabase)
      logger.info(`[aggregate] Metrics backfill: sharpe=${metricsResult.sharpeUpdated}, wr=${metricsResult.winRateUpdated}, mdd=${metricsResult.maxDrawdownUpdated}, score=${metricsResult.arenaScoreUpdated}`)
    } catch (metricsErr) {
      logger.warn(`[aggregate] Metrics backfill failed: ${metricsErr}`)
    }

    const duration = Date.now() - startTime

    if (errors > 0) {
      await plog.error(new Error(`${errors} upsert errors`), { inserted, errors, date: dateStr, cleanedUp })
    } else {
      await plog.success(inserted, { date: dateStr, cleanedUp, metricsBackfill: metricsResult })
    }

    return NextResponse.json({
      success: true,
      date: dateStr,
      processed: snapshotMap.size,
      inserted,
      errors,
      cleanedUp,
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
