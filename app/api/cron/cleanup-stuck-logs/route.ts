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

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  
  if (!cronSecret) {
    if (process.env.NODE_ENV !== 'development') {
      return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
    }
  } else if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()

  try {
    const supabase = getSupabaseAdmin()

    // Find stuck logs (running for >30 minutes)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()

    const { data: stuckLogs, error: fetchError } = await supabase
      .from('pipeline_logs')
      .select('id, job_name, started_at')
      .eq('status', 'running')
      .lt('started_at', thirtyMinutesAgo)
      .order('started_at', { ascending: false })

    if (fetchError) {
      logger.error('[cleanup-stuck-logs] Failed to fetch stuck logs', {}, fetchError)
      return NextResponse.json({
        error: 'Failed to fetch stuck logs',
        details: fetchError.message
      }, { status: 500 })
    }

    if (!stuckLogs || stuckLogs.length === 0) {
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

    if (updateError) {
      logger.error('[cleanup-stuck-logs] Failed to update stuck logs', {}, updateError)
      return NextResponse.json({
        error: 'Failed to update stuck logs',
        details: updateError.message,
        found: stuckLogs.length,
      }, { status: 500 })
    }

    const cleaned = count || 0
    logger.warn(`[cleanup-stuck-logs] Successfully marked ${cleaned} stuck logs as timeout`)

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
    logger.error('[cleanup-stuck-logs] Unexpected error', {}, error)
    return NextResponse.json({
      error: 'Internal server error',
      durationMs: Date.now() - startTime,
    }, { status: 500 })
  }
}
