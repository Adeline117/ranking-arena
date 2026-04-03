/**
 * GET /api/cron/cleanup-data
 *
 * Handles data maintenance tasks:
 * - Cleanup ephemeral data (hot_topics, flash_news, read notifications, pipeline_logs)
 * - Refresh computed metrics from equity curves
 * - Run orphaned/stale data cleanup via RPC
 *
 * IMPORTANT: trader_snapshots_v2, trader_daily_snapshots, trader_position_history
 * are NEVER deleted — historical data is accumulated for years.
 * See CLAUDE.md: "绝对不要删除数据库历史数据"
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

    // ── Ephemeral data cleanup (NOT trader/snapshot data) ──────────

    // Cleanup old hot_topics (>180 days) — ephemeral market news
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

    // Cleanup old flash_news (>365 days) — ephemeral news feed
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

    // Cleanup read notifications (>90 days) — user inbox hygiene
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

    // Cleanup old pipeline_logs (>90 days) — operational logs only
    let pipelineLogsCleaned = 0
    try {
      const logsCutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
      const { count, error: logsErr } = await supabase
        .from('pipeline_logs')
        .delete({ count: 'exact' })
        .lt('started_at', logsCutoff)
        .limit(10000)
      if (logsErr) {
        logger.warn(`[cleanup-data] pipeline_logs cleanup error: ${logsErr.message}`)
      } else {
        pipelineLogsCleaned = count ?? 0
        if (pipelineLogsCleaned > 0) {
          logger.info(`[cleanup-data] Cleaned up ${pipelineLogsCleaned} old pipeline_logs (>90d)`)
        }
      }
    } catch (err) {
      logger.warn(`[cleanup-data] pipeline_logs cleanup failed: ${err}`)
    }

    // ── Metrics refresh (keep) ────────────────────────────────────

    let metricsResult = null
    try {
      metricsResult = await refreshComputedMetrics(supabase)
      logger.info(`[cleanup-data] Metrics refresh: sharpe=${metricsResult.sharpeUpdated}, wr=${metricsResult.winRateUpdated}, mdd=${metricsResult.maxDrawdownUpdated}, score=${metricsResult.arenaScoreUpdated}`)
    } catch (err) {
      logger.warn(`[cleanup-data] Metrics refresh failed: ${err}`)
      stepErrors.push(`metrics_refresh: ${err instanceof Error ? err.message : String(err)}`)
    }

    // ── VACUUM/ANALYZE on large tables ────────────────────────────
    // Run ANALYZE periodically to keep planner stats fresh on growing tables
    try {
      await supabase.rpc('exec_sql', { sql: 'ANALYZE trader_snapshots_v2' })
      await supabase.rpc('exec_sql', { sql: 'ANALYZE trader_daily_snapshots' })
      logger.info('[cleanup-data] ANALYZE on snapshot tables completed')
    } catch (analyzeErr) {
      logger.warn(`[cleanup-data] ANALYZE failed: ${analyzeErr}`)
    }

    const duration = Date.now() - startTime
    const hasErrors = stepErrors.length > 0

    const totalCleaned = hotTopicsCleaned + flashNewsCleaned + notificationsCleaned + pipelineLogsCleaned

    const resultMeta = {
      hotTopicsCleaned,
      flashNewsCleaned,
      notificationsCleaned,
      pipelineLogsCleaned,
      metricsRefresh: metricsResult,
      stepErrors: hasErrors ? stepErrors : undefined,
      note: 'trader snapshots/daily/positions are NEVER deleted (long-term archival)',
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
