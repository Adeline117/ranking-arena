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
import type { SupabaseClient } from '@supabase/supabase-js'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { refreshComputedMetrics } from '@/lib/cron/metrics-backfill'
import { env } from '@/lib/env'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin() as SupabaseClient
  const startTime = Date.now()
  const plog = await PipelineLogger.start('cleanup-data')

  // Time budget: stop scheduling new operations after 240s (leave 60s buffer for maxDuration=300)
  const TIME_BUDGET_MS = 240_000
  const elapsed = () => Date.now() - startTime
  const hasTimeBudget = () => elapsed() < TIME_BUDGET_MS

  // Reduced batch size to stay within Supabase 30s statement_timeout
  const DELETE_BATCH_SIZE = 5000

  try {
    const stepErrors: string[] = []
    const skippedSteps: string[] = []

    // ── Ephemeral data cleanup (NOT trader/snapshot data) ──────────

    // Cleanup old hot_topics (>180 days) — ephemeral market news
    let hotTopicsCleaned = 0
    if (hasTimeBudget()) {
      try {
        const hotTopicsCutoff = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString()
        const { count, error: htErr } = await supabase
          .from('hot_topics')
          .delete({ count: 'exact' })
          .lt('created_at', hotTopicsCutoff)
          .limit(DELETE_BATCH_SIZE)
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
    } else {
      skippedSteps.push('hot_topics')
    }

    // Cleanup old flash_news (>365 days) — ephemeral news feed
    let flashNewsCleaned = 0
    if (hasTimeBudget()) {
      try {
        const flashNewsCutoff = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString()
        const { count, error: fnErr } = await supabase
          .from('flash_news')
          .delete({ count: 'exact' })
          .lt('created_at', flashNewsCutoff)
          .limit(DELETE_BATCH_SIZE)
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
    } else {
      skippedSteps.push('flash_news')
    }

    // Cleanup read notifications (>90 days) + all notifications (>365 days)
    let notificationsCleaned = 0
    if (hasTimeBudget()) {
      try {
        // Delete read notifications older than 90 days
        const readCutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
        const { count: readCount, error: readErr } = await supabase
          .from('notifications')
          .delete({ count: 'exact' })
          .eq('read', true)
          .lt('created_at', readCutoff)
          .limit(DELETE_BATCH_SIZE)
        if (readErr) {
          logger.warn(`[cleanup-data] read notifications cleanup error: ${readErr.message}`)
        } else {
          notificationsCleaned += readCount ?? 0
        }
        // Delete ALL notifications older than 365 days (including unread)
        if (hasTimeBudget()) {
          const allCutoff = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString()
          const { count: allCount, error: allErr } = await supabase
            .from('notifications')
            .delete({ count: 'exact' })
            .lt('created_at', allCutoff)
            .limit(DELETE_BATCH_SIZE)
          if (allErr) {
            logger.warn(`[cleanup-data] old notifications cleanup error: ${allErr.message}`)
          } else {
            notificationsCleaned += allCount ?? 0
          }
        }
        if (notificationsCleaned > 0) {
          logger.info(`[cleanup-data] Cleaned up ${notificationsCleaned} old notifications (read>90d + all>365d)`)
        }
      } catch (err) {
        logger.warn(`[cleanup-data] notifications cleanup failed: ${err}`)
      }
    } else {
      skippedSteps.push('notifications')
    }

    // Cleanup old pipeline_logs (>90 days) — operational logs only
    // Uses batched delete (5k/batch) to stay within 30s statement_timeout
    let pipelineLogsCleaned = 0
    if (hasTimeBudget()) {
      try {
        const logsCutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
        let batchDeleted = 0
        const MAX_BATCHES = 10 // Cap at 10 batches (50k total) per run
        let batchCount = 0
        do {
          if (!hasTimeBudget()) {
            logger.warn(`[cleanup-data] pipeline_logs: time budget exceeded after ${batchCount} batches, ${pipelineLogsCleaned} deleted`)
            break
          }
          const { count, error: logsErr } = await supabase
            .from('pipeline_logs')
            .delete({ count: 'exact' })
            .lt('started_at', logsCutoff)
            .limit(DELETE_BATCH_SIZE)
          if (logsErr) {
            logger.warn(`[cleanup-data] pipeline_logs cleanup error: ${logsErr.message}`)
            break
          }
          batchDeleted = count ?? 0
          pipelineLogsCleaned += batchDeleted
          batchCount++
        } while (batchDeleted === DELETE_BATCH_SIZE && batchCount < MAX_BATCHES)
        if (pipelineLogsCleaned > 0) {
          logger.info(`[cleanup-data] Cleaned up ${pipelineLogsCleaned} old pipeline_logs (>90d) in ${batchCount} batches`)
        }
      } catch (err) {
        logger.warn(`[cleanup-data] pipeline_logs cleanup failed: ${err}`)
      }
    } else {
      skippedSteps.push('pipeline_logs')
    }

    // Cleanup old pipeline_rejected_writes (>7 days) — diagnostic data, ~18k rows/day
    let rejectedWritesCleaned = 0
    if (hasTimeBudget()) {
      try {
        const rejectedCutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
        const { count, error: rejErr } = await supabase
          .from('pipeline_rejected_writes')
          .delete({ count: 'exact' })
          .lt('created_at', rejectedCutoff)
          .limit(5000)
        if (!rejErr && count) rejectedWritesCleaned = count
        if (rejectedWritesCleaned > 0) {
          logger.info(`[cleanup-data] Cleaned ${rejectedWritesCleaned} old pipeline_rejected_writes (>7d)`)
        }
      } catch (err) {
        logger.warn(`[cleanup-data] pipeline_rejected_writes cleanup failed: ${err}`)
      }
    } else {
      skippedSteps.push('pipeline_rejected_writes')
    }

    // Cleanup old stripe_events (>30 days) — Stripe retries within 3 days max
    let stripeEventsCleaned = 0
    if (hasTimeBudget()) {
      try {
        const stripeEventsCutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
        const { count, error: stripeErr } = await supabase
          .from('stripe_events')
          .delete({ count: 'exact' })
          .lt('processed_at', stripeEventsCutoff)
          .limit(DELETE_BATCH_SIZE)
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
    } else {
      skippedSteps.push('stripe_events')
    }

    // Cleanup old liquidations (>180 days) — market sentiment data only
    let liquidationsCleaned = 0
    if (hasTimeBudget()) {
      try {
        const liqCutoff = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString()
        const { count, error: liqErr } = await supabase
          .from('liquidations')
          .delete({ count: 'exact' })
          .lt('created_at', liqCutoff)
          .limit(DELETE_BATCH_SIZE)
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
    } else {
      skippedSteps.push('liquidations')
    }

    // Cleanup stale pipeline_state entries (>7 days untouched)
    // Removes abandoned checkpoints, old dead counters, stale evaluator feedback
    let pipelineStateCleaned = 0
    if (hasTimeBudget()) {
      try {
        const { PipelineState } = await import('@/lib/services/pipeline-state')
        pipelineStateCleaned = await PipelineState.cleanupStale(7 * 24 * 3600 * 1000)
        if (pipelineStateCleaned > 0) {
          logger.info(`[cleanup-data] Cleaned up ${pipelineStateCleaned} stale pipeline_state entries (>7d)`)
        }
      } catch (err) {
        logger.warn(`[cleanup-data] pipeline_state cleanup failed: ${err}`)
      }
    } else {
      skippedSteps.push('pipeline_state')
    }

    // ── Metrics refresh (with timeout to prevent hang) ────────────
    // Only run if we have at least 60s left in the time budget
    let metricsResult = null
    const metricsTimeRemaining = Math.max(0, TIME_BUDGET_MS - elapsed())
    if (metricsTimeRemaining >= 60_000) {
      try {
        const metricsTimeout = Math.min(metricsTimeRemaining, 90_000) // cap at 90s
        metricsResult = await Promise.race([
          refreshComputedMetrics(supabase),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Metrics refresh timed out after ${Math.round(metricsTimeout / 1000)}s`)), metricsTimeout)
          ),
        ])
        logger.info(`[cleanup-data] Metrics refresh: sharpe=${metricsResult.sharpeUpdated}, wr=${metricsResult.winRateUpdated}, mdd=${metricsResult.maxDrawdownUpdated}, score=${metricsResult.arenaScoreUpdated}`)
      } catch (err) {
        logger.warn(`[cleanup-data] Metrics refresh failed: ${err}`)
        stepErrors.push(`metrics_refresh: ${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      skippedSteps.push('metrics_refresh')
      logger.warn(`[cleanup-data] Skipping metrics refresh — only ${Math.round(metricsTimeRemaining / 1000)}s left in time budget`)
    }

    // ── ANALYZE on large tables (with per-table timeout) ─────────
    // Run ANALYZE periodically to keep planner stats fresh on growing tables
    if (hasTimeBudget()) {
      for (const table of ['trader_snapshots_v2', 'trader_daily_snapshots']) {
        if (!hasTimeBudget()) {
          skippedSteps.push(`analyze_${table}`)
          break
        }
        try {
          await Promise.race([
            supabase.rpc('exec_sql', { sql: `ANALYZE ${table}` }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`ANALYZE ${table} timed out after 25s`)), 25_000)
            ),
          ])
          logger.info(`[cleanup-data] ANALYZE ${table} completed`)
        } catch (analyzeErr) {
          logger.warn(`[cleanup-data] ANALYZE ${table} failed: ${analyzeErr}`)
        }
      }
    } else {
      skippedSteps.push('analyze_tables')
    }

    const duration = Date.now() - startTime
    const hasErrors = stepErrors.length > 0

    const totalCleaned = hotTopicsCleaned + flashNewsCleaned + notificationsCleaned + pipelineLogsCleaned + stripeEventsCleaned + liquidationsCleaned + pipelineStateCleaned

    if (skippedSteps.length > 0) {
      logger.warn(`[cleanup-data] Time budget: skipped ${skippedSteps.length} steps after ${Math.round(duration / 1000)}s: ${skippedSteps.join(', ')}`)
    }

    const resultMeta = {
      hotTopicsCleaned,
      flashNewsCleaned,
      notificationsCleaned,
      pipelineLogsCleaned,
      stripeEventsCleaned,
      liquidationsCleaned,
      pipelineStateCleaned,
      metricsRefresh: metricsResult,
      skippedSteps: skippedSteps.length > 0 ? skippedSteps : undefined,
      stepErrors: hasErrors ? stepErrors : undefined,
      note: 'trader snapshots/daily/positions are NEVER deleted (long-term archival)',
    }

    if (skippedSteps.length > 0 || hasErrors) {
      await plog.partialSuccess(totalCleaned, [...stepErrors, ...skippedSteps.map(s => `skipped:${s}`)], resultMeta)
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
