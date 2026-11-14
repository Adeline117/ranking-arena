/**
 * Web daily digest cron — one Telegram summary of the WEB side:
 * - Vercel cron success rate and top errors (pipeline_logs, 24h)
 * - buffered web WARNING alerts (the only reader of that buffer)
 *
 * Not to be confused with the ingest worker's `maint:daily-digest`
 * (worker/src/ingest/processors/daily-digest.ts), which reports source
 * coverage, rejects and worker health. The per-platform freshness section
 * this route used to send was judged on leaderboard_ranks.computed_at (cannot
 * see unsealed publication) and duplicated the worker digest, so it was
 * removed (2026-11 audit S3).
 */

import { NextRequest } from 'next/server'
import { sendDailyDigest, type DailyDigestData } from '@/lib/notifications/telegram'
import { withCron } from '@/lib/api/with-cron'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export const GET = withCron(
  'daily-digest',
  async (_request: NextRequest, { supabase }) => {
    // Pipeline success rate (24h)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: logs, error: logsError } = await supabase
      .from('pipeline_logs')
      .select('status')
      .gte('started_at', oneDayAgo)
    if (logsError) throw new Error(`pipeline_logs read failed: ${logsError.message}`)

    const totalRuns = logs?.length || 0
    const successRuns = logs?.filter((l) => l.status === 'success').length || 0
    const pipelineSuccessRate = totalRuns > 0 ? (successRuns / totalRuns) * 100 : 0
    const alertCount24h =
      logs?.filter((l) => l.status === 'error' || l.status === 'timeout').length || 0

    // Top errors
    const { data: errorLogs, error: errorLogsError } = await supabase
      .from('pipeline_logs')
      .select('job_name')
      .gte('started_at', oneDayAgo)
      .in('status', ['error', 'timeout'])
    if (errorLogsError) throw new Error(`pipeline_logs read failed: ${errorLogsError.message}`)

    const errorCounts = new Map<string, number>()
    for (const log of errorLogs || []) {
      errorCounts.set(log.job_name, (errorCounts.get(log.job_name) || 0) + 1)
    }
    const topErrors = Array.from(errorCounts.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([job, count]) => ({ job, count }))

    const digestData: DailyDigestData = { alertCount24h, pipelineSuccessRate, topErrors }

    const sent = await sendDailyDigest(digestData)

    return { count: sent ? 1 : 0, pipelineSuccessRate, alertCount24h }
  },
  { maxDurationSec: maxDuration }
)
