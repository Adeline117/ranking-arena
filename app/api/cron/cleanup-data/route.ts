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

    // Cleanup read notifications (>90 days) + all notifications (>365 days)
    let notificationsCleaned = 0
    try {
      // Delete read notifications older than 90 days
      const readCutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
      const { count: readCount, error: readErr } = await supabase
        .from('notifications')
        .delete({ count: 'exact' })
        .eq('read', true)
        .lt('created_at', readCutoff)
      if (readErr) {
        logger.warn(`[cleanup-data] read notifications cleanup error: ${readErr.message}`)
      } else {
        notificationsCleaned += readCount ?? 0
      }
      // Delete ALL notifications older than 365 days (including unread)
      const allCutoff = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString()
      const { count: allCount, error: allErr } = await supabase
        .from('notifications')
        .delete({ count: 'exact' })
        .lt('created_at', allCutoff)
      if (allErr) {
        logger.warn(`[cleanup-data] old notifications cleanup error: ${allErr.message}`)
      } else {
        notificationsCleaned += allCount ?? 0
      }
      if (notificationsCleaned > 0) {
        logger.info(`[cleanup-data] Cleaned up ${notificationsCleaned} old notifications (read>90d + all>365d)`)
      }
    } catch (err) {
      logger.warn(`[cleanup-data] notifications cleanup failed: ${err}`)
    }

    // Cleanup old pipeline_logs (>90 days) — operational logs only
    // Uses batched delete (50k/batch) to handle backlog if cleanup was missed
    let pipelineLogsCleaned = 0
    try {
      const logsCutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
      let batchDeleted = 0
      do {
        const { count, error: logsErr } = await supabase
          .from('pipeline_logs')
          .delete({ count: 'exact' })
          .lt('started_at', logsCutoff)
          .limit(50000)
        if (logsErr) {
          logger.warn(`[cleanup-data] pipeline_logs cleanup error: ${logsErr.message}`)
          break
        }
        batchDeleted = count ?? 0
        pipelineLogsCleaned += batchDeleted
      } while (batchDeleted === 50000)
      if (pipelineLogsCleaned > 0) {
        logger.info(`[cleanup-data] Cleaned up ${pipelineLogsCleaned} old pipeline_logs (>90d)`)
      }
    } catch (err) {
      logger.warn(`[cleanup-data] pipeline_logs cleanup failed: ${err}`)
    }

    // Cleanup old stripe_events (>30 days) — Stripe retries within 3 days max
    let stripeEventsCleaned = 0
    try {
      const stripeEventsCutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
      const { count, error: stripeErr } = await supabase
        .from('stripe_events')
        .delete({ count: 'exact' })
        .lt('processed_at', stripeEventsCutoff)
      if (stripeErr) {
        if (!stripeErr.message?.includes('does not exist')) {
          logger.warn(`[cleanup-data] stripe_events cleanup error: ${stripeErr.message}`)
        }
      } else {
        stripeEventsCleaned = count ?? 0
        if (stripeEventsCleaned > 0) {
          logger.info(`[cleanup-data] Cleaned up ${stripeEventsCleaned} old stripe_events (>30d)`)
        }
      }
    } catch (err) {
      logger.warn(`[cleanup-data] stripe_events cleanup failed: ${err}`)
    }

    // Cleanup old liquidations (>180 days) — market sentiment data only
    let liquidationsCleaned = 0
    try {
      const liqCutoff = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString()
      const { count, error: liqErr } = await supabase
        .from('liquidations')
        .delete({ count: 'exact' })
        .lt('created_at', liqCutoff)
        .limit(50000)
      if (liqErr) {
        if (!liqErr.message?.includes('does not exist')) {
          logger.warn(`[cleanup-data] liquidations cleanup error: ${liqErr.message}`)
        }
      } else {
        liquidationsCleaned = count ?? 0
        if (liquidationsCleaned > 0) {
          logger.info(`[cleanup-data] Cleaned up ${liquidationsCleaned} old liquidations (>180d)`)
        }
      }
    } catch (err) {
      logger.warn(`[cleanup-data] liquidations cleanup failed: ${err}`)
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

    const totalCleaned = hotTopicsCleaned + flashNewsCleaned + notificationsCleaned + pipelineLogsCleaned + stripeEventsCleaned + liquidationsCleaned

    const resultMeta = {
      hotTopicsCleaned,
      flashNewsCleaned,
      notificationsCleaned,
      pipelineLogsCleaned,
      stripeEventsCleaned,
      liquidationsCleaned,
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
