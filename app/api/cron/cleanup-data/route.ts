/**
 * GET /api/cron/cleanup-data
 *
 * Handles all data cleanup and metric refresh tasks:
 * - Cleanup old trader_snapshots_v2 rows (>180 days)
 * - Cleanup old trader_daily_snapshots rows (>365 days)
 * - Refresh computed metrics from equity curves
 * - Run orphaned/stale data cleanup via RPC
 *
 * Schedule: Daily at 01:00 UTC (runs after aggregate + compute-derived-metrics)
 */

import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { refreshComputedMetrics } from '@/lib/cron/metrics-backfill'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()
  const startTime = Date.now()
  const plog = await PipelineLogger.start('cleanup-data')

  try {
    const stepErrors: string[] = []

    // Step 1: Cleanup old trader_snapshots_v2 rows (keep 180 days)
    let snapshotsV2Cleaned = 0
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
          logger.warn(`[cleanup-data] snapshots_v2 cleanup error: ${cleanupErr.message}`)
          break
        }
        const deleted = count ?? 0
        snapshotsV2Cleaned += deleted
        if (deleted < 5000) break
      }
      if (snapshotsV2Cleaned > 0) {
        logger.info(`[cleanup-data] Cleaned up ${snapshotsV2Cleaned} old snapshots_v2 rows (>180d)`)
        // P1-3: Run ANALYZE after bulk deletes to update planner statistics
        try {
          await supabase.rpc('exec_sql', { sql: 'ANALYZE trader_snapshots_v2' })
          logger.info('[cleanup-data] ANALYZE trader_snapshots_v2 completed')
        } catch (analyzeErr) {
          logger.warn(`[cleanup-data] ANALYZE trader_snapshots_v2 failed: ${analyzeErr}`)
        }
      }
    } catch (err) {
      logger.warn(`[cleanup-data] snapshots_v2 cleanup failed: ${err}`)
      stepErrors.push(`snapshots_v2: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Step 2: Cleanup old trader_daily_snapshots rows (keep 365 days)
    let dailySnapshotsCleaned = 0
    try {
      const dailyCutoffDate = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().split('T')[0]
      const MAX_DAILY_CLEANUP_BATCHES = 10
      for (let batch = 0; batch < MAX_DAILY_CLEANUP_BATCHES; batch++) {
        const { count: deletedCount, error: dailyCleanupErr } = await supabase
          .from('trader_daily_snapshots')
          .delete({ count: 'exact' })
          .lt('date', dailyCutoffDate)
          .limit(5000)
        if (dailyCleanupErr) {
          logger.warn(`[cleanup-data] daily_snapshots cleanup error: ${dailyCleanupErr.message}`)
          break
        }
        const deleted = deletedCount ?? 0
        dailySnapshotsCleaned += deleted
        if (deleted < 5000) break
      }
      if (dailySnapshotsCleaned > 0) {
        logger.info(`[cleanup-data] Cleaned up ${dailySnapshotsCleaned} old daily_snapshots rows (>365d)`)
      }
    } catch (err) {
      logger.warn(`[cleanup-data] daily_snapshots cleanup failed: ${err}`)
      stepErrors.push(`daily_snapshots: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Step 2b: Cleanup old hot_topics (>180 days)
    let hotTopicsCleaned = 0
    try {
      const hotTopicsCutoff = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString()
      const { count, error: htErr } = await supabase
        .from('hot_topics')
        .delete({ count: 'exact' })
        .lt('created_at', hotTopicsCutoff)
      if (htErr) {
        logger.warn(`[cleanup-data] hot_topics cleanup error: ${htErr.message}`)
      } else {
        hotTopicsCleaned = count ?? 0
        if (hotTopicsCleaned > 0) {
          logger.info(`[cleanup-data] Cleaned up ${hotTopicsCleaned} old hot_topics rows (>180d)`)
        }
      }
    } catch (err) {
      logger.warn(`[cleanup-data] hot_topics cleanup failed: ${err}`)
    }

    // Step 2c: Cleanup old flash_news (>365 days)
    let flashNewsCleaned = 0
    try {
      const flashNewsCutoff = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString()
      const { count, error: fnErr } = await supabase
        .from('flash_news')
        .delete({ count: 'exact' })
        .lt('created_at', flashNewsCutoff)
      if (fnErr) {
        logger.warn(`[cleanup-data] flash_news cleanup error: ${fnErr.message}`)
      } else {
        flashNewsCleaned = count ?? 0
        if (flashNewsCleaned > 0) {
          logger.info(`[cleanup-data] Cleaned up ${flashNewsCleaned} old flash_news rows (>365d)`)
        }
      }
    } catch (err) {
      logger.warn(`[cleanup-data] flash_news cleanup failed: ${err}`)
    }

    // Step 2d: Cleanup read notifications (>90 days)
    let notificationsCleaned = 0
    try {
      const notifCutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
      const { count, error: notifErr } = await supabase
        .from('notifications')
        .delete({ count: 'exact' })
        .eq('read', true)
        .lt('created_at', notifCutoff)
      if (notifErr) {
        logger.warn(`[cleanup-data] notifications cleanup error: ${notifErr.message}`)
      } else {
        notificationsCleaned = count ?? 0
        if (notificationsCleaned > 0) {
          logger.info(`[cleanup-data] Cleaned up ${notificationsCleaned} old read notifications (>90d)`)
        }
      }
    } catch (err) {
      logger.warn(`[cleanup-data] notifications cleanup failed: ${err}`)
    }

    // Step 2e: Cleanup old trader_position_history (>30 days)
    // This table grows ~2.5M rows/day (75M/month) from hourly position snapshots.
    // Only recent positions are used for trader detail views. 30 days is sufficient.
    let positionsCleaned = 0
    try {
      const positionsCutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
      const MAX_POS_BATCHES = 50 // Up to 250K rows per run
      for (let batch = 0; batch < MAX_POS_BATCHES; batch++) {
        const { count, error: posErr } = await supabase
          .from('trader_position_history')
          .delete({ count: 'exact' })
          .lt('created_at', positionsCutoff)
          .limit(5000)
        if (posErr) {
          logger.warn(`[cleanup-data] position_history cleanup error: ${posErr.message}`)
          break
        }
        const deleted = count ?? 0
        positionsCleaned += deleted
        if (deleted < 5000) break
      }
      if (positionsCleaned > 0) {
        logger.info(`[cleanup-data] Cleaned up ${positionsCleaned} old position_history rows (>30d)`)
      }
    } catch (err) {
      logger.warn(`[cleanup-data] position_history cleanup failed: ${err}`)
    }

    // Step 3: Refresh computed metrics from equity curves
    let metricsResult = null
    try {
      metricsResult = await refreshComputedMetrics(supabase)
      logger.info(`[cleanup-data] Metrics refresh: sharpe=${metricsResult.sharpeUpdated}, wr=${metricsResult.winRateUpdated}, mdd=${metricsResult.maxDrawdownUpdated}, score=${metricsResult.arenaScoreUpdated}`)
    } catch (err) {
      logger.warn(`[cleanup-data] Metrics refresh failed: ${err}`)
      stepErrors.push(`metrics_refresh: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Step 4: Run orphaned/stale data cleanup via RPC
    let staleDataCleanup: Record<string, number> | null = null
    try {
      const { data: cleanupResults, error: cleanupRpcError } = await supabase
        .rpc('cleanup_stale_data')

      if (cleanupRpcError) {
        logger.warn(`[cleanup-data] cleanup_stale_data RPC error: ${cleanupRpcError.message}`)
      } else if (cleanupResults && Array.isArray(cleanupResults)) {
        staleDataCleanup = {}
        for (const row of cleanupResults) {
          if (row.deleted_rows > 0) {
            staleDataCleanup[row.table_name] = Number(row.deleted_rows)
          }
        }
        const totalCleaned = Object.values(staleDataCleanup).reduce((s, n) => s + n, 0)
        if (totalCleaned > 0) {
          logger.info(`[cleanup-data] Stale data cleanup: ${JSON.stringify(staleDataCleanup)}`)
        }
      }
    } catch (err) {
      logger.warn(`[cleanup-data] cleanup_stale_data failed: ${err}`)
      stepErrors.push(`stale_data_cleanup: ${err instanceof Error ? err.message : String(err)}`)
    }

    const duration = Date.now() - startTime
    const hasErrors = stepErrors.length > 0

    const totalCleaned = snapshotsV2Cleaned + dailySnapshotsCleaned + hotTopicsCleaned + flashNewsCleaned + notificationsCleaned + positionsCleaned

    const resultMeta = {
      snapshotsV2Cleaned,
      dailySnapshotsCleaned,
      hotTopicsCleaned,
      flashNewsCleaned,
      notificationsCleaned,
      positionsCleaned,
      metricsRefresh: metricsResult,
      staleDataCleanup,
      stepErrors: hasErrors ? stepErrors : undefined,
    }

    if (hasErrors) {
      await plog.partialSuccess(totalCleaned, stepErrors, resultMeta)
    } else {
      await plog.success(totalCleaned, resultMeta)
    }

    return NextResponse.json({
      success: !hasErrors,
      ...resultMeta,
      duration: `${duration}ms`,
    })
  } catch (error) {
    logger.apiError('/api/cron/cleanup-data', error, {})
    await plog.error(error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
