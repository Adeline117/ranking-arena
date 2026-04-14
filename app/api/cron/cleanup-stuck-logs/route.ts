/**
 * Cleanup Stuck Pipeline Logs
 *
 * Marks pipeline_logs that have been "running" for >30min as "timeout".
 * Prevents false alarms in health monitoring.
 *
 * Schedule: every 15 minutes (see vercel.json)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { env } from '@/lib/env'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  const cronSecret = env.CRON_SECRET
  
  if (!cronSecret) {
    if (process.env.NODE_ENV !== 'development') {
      return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
    }
  } else if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const plog = await PipelineLogger.start('cleanup-stuck-logs')

  try {
    const supabase = getSupabaseAdmin()

    // Find stuck logs (running for >30 minutes)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()

    const { data: stuckLogs, error: fetchError } = await supabase
      .from('pipeline_logs')
      .select('id, job_name, started_at')
      .eq('status', 'running')
      .lt('started_at', thirtyMinutesAgo)
      .is('ended_at', null) // Only fetch truly stuck jobs (not already ended)
      .order('started_at', { ascending: false })

    if (fetchError) {
      logger.error('[cleanup-stuck-logs] Failed to fetch stuck logs', {}, fetchError)
      return NextResponse.json({
        error: 'Failed to fetch stuck logs',
      }, { status: 500 })
    }

    if (!stuckLogs || stuckLogs.length === 0) {
      await plog.success(0, { message: 'No stuck logs found' })
      return NextResponse.json({
        ok: true,
        cleaned: 0,
        durationMs: Date.now() - startTime,
        message: 'No stuck logs found',
      })
    }

    logger.warn(`[cleanup-stuck-logs] Found ${stuckLogs.length} stuck logs, marking as timeout`, {
      jobs: stuckLogs.map(l => l.job_name),
    })

    // Mark them as timeout
    const now = new Date().toISOString()
    const { error: updateError, count } = await supabase
      .from('pipeline_logs')
      .update({
        status: 'timeout',
        ended_at: now,
        error_message: 'Marked as timeout by cleanup-stuck-logs cron (stuck >30min)',
      })
      .eq('status', 'running')
      .lt('started_at', thirtyMinutesAgo)
      .is('ended_at', null) // Only update jobs that haven't ended yet

    if (updateError) {
      logger.error('[cleanup-stuck-logs] Failed to update stuck logs', {}, updateError)
      return NextResponse.json({
        error: 'Failed to update stuck logs',
        found: stuckLogs.length,
      }, { status: 500 })
    }

    const cleaned = count || 0
    logger.warn(`[cleanup-stuck-logs] Successfully marked ${cleaned} stuck logs as timeout`)

    // Delete pipeline_logs older than 30 days to prevent unbounded growth
    let oldLogsDeleted = 0
    let rotationFailed = false
    let rotationError: string | null = null
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const MAX_LOG_CLEANUP_BATCHES = 5 // max 25K rows per run
      for (let batch = 0; batch < MAX_LOG_CLEANUP_BATCHES; batch++) {
        const { count: deletedCount, error: deleteErr } = await supabase
          .from('pipeline_logs')
          .delete({ count: 'exact' })
          .lt('started_at', thirtyDaysAgo)
          .limit(5000)
        if (deleteErr) {
          rotationFailed = true
          rotationError = deleteErr.message
          logger.error('[cleanup-stuck-logs] Failed to delete old pipeline_logs:', { error: deleteErr.message })
          break
        }
        const deleted = deletedCount ?? 0
        oldLogsDeleted += deleted
        if (deleted < 5000) break
      }
      if (oldLogsDeleted > 0) {
        logger.info(`[cleanup-stuck-logs] Deleted ${oldLogsDeleted} pipeline_logs older than 30 days`)
      }
    } catch (deleteErr) {
      rotationFailed = true
      rotationError = deleteErr instanceof Error ? deleteErr.message : String(deleteErr)
      logger.error('[cleanup-stuck-logs] pipeline_logs rotation failed:', {}, deleteErr)
    }

    // Report rotation failure visibly — don't hide it behind plog.success()
    if (rotationFailed) {
      await plog.success(cleaned, {
        jobs: stuckLogs.map(l => l.job_name),
        oldLogsDeleted,
        rotationFailed: true,
        rotationError,
      })
      // Alert on rotation failure — unbounded pipeline_logs growth is a ticking bomb
      await sendRateLimitedAlert({
        title: 'Pipeline logs 轮转失败',
        message: `pipeline_logs 30天清理失败: ${rotationError}\n旧日志未被删除，表将无限增长。`,
        level: 'warning',
        details: { rotationError, oldLogsDeleted },
      }, 'cleanup:rotation-failed', 12 * 60 * 60 * 1000) // 12h cooldown
    } else {
      await plog.success(cleaned, { jobs: stuckLogs.map(l => l.job_name), oldLogsDeleted })
    }

    // Only alert if many jobs stuck (>3) — occasional 1-2 stuck is normal timeout
    // Rate-limited: same stuck jobs won't re-alert for 6 hours
    if (cleaned >= 3) {
      const jobDetails = stuckLogs
        .map(l => {
          const stuckMin = Math.round(
            (Date.now() - new Date(l.started_at).getTime()) / 60000
          )
          return `  ${l.job_name}: stuck ${stuckMin}min`
        })
        .join('\n')
      const jobKey = stuckLogs.map(l => l.job_name).sort().join(',')
      await sendRateLimitedAlert({
        title: `卡住任务清理: ${cleaned} 个任务超时`,
        message: `以下任务运行超过30分钟，已标记为 timeout:\n${jobDetails}`,
        level: 'warning',
        details: {
          cleaned,
          jobs: stuckLogs.map(l => l.job_name).join(', '),
        },
      }, `cleanup-stuck:${jobKey}`, 6 * 60 * 60 * 1000)
    }

    return NextResponse.json({
      ok: true,
      cleaned,
      jobs: stuckLogs.map(l => ({
        name: l.job_name,
        stuckSince: l.started_at,
        stuckMinutes: Math.round((Date.now() - new Date(l.started_at).getTime()) / 60000),
      })),
      durationMs: Date.now() - startTime,
    })
  } catch (error) {
    await plog.error(error instanceof Error ? error : new Error(String(error)))
    logger.error('[cleanup-stuck-logs] Unexpected error', {}, error)
    return NextResponse.json({
      error: 'Internal server error',
      durationMs: Date.now() - startTime,
    }, { status: 500 })
  }
}
