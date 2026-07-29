/**
 * Daily Digest Cron — sends a Telegram summary at UTC 00:00
 *
 * Content:
 * - Pipeline success rate (24h)
 * - Normal/stale/critical platform counts
 * - Enrichment completion rate
 * - Snapshot counts (24h vs yesterday)
 * - Buffered warnings summary
 * - Top errors
 */

import { NextRequest } from 'next/server'
import { sendDailyDigest, type DailyDigestData } from '@/lib/notifications/telegram'
import { withCron } from '@/lib/api/with-cron'
import { buildFreshnessReport } from '@/lib/rankings/build-freshness-report'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export const GET = withCron('daily-digest', async (_request: NextRequest, { supabase }) => {
  // Pipeline success rate (24h)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: logs, error: logsError } = await supabase
    .from('pipeline_logs')
    .select('status')
    .gte('started_at', oneDayAgo)
  if (logsError || logs === null) {
    throw new Error(`Daily digest pipeline query failed: ${logsError?.message ?? 'null payload'}`)
  }

  const totalRuns = logs?.length || 0
  const successRuns = logs?.filter((l) => l.status === 'success').length || 0
  const pipelineSuccessRate = totalRuns > 0 ? (successRuns / totalRuns) * 100 : 0
  const alertCount24h =
    logs?.filter((l) => l.status === 'error' || l.status === 'timeout').length || 0

  // Registry promises, visible sealed generations, and source watermarks must
  // agree. A recent leftover rank row is not freshness authority.
  const freshnessReport = await buildFreshnessReport(AbortSignal.timeout(30_000))
  const platformFreshness: DailyDigestData['platformFreshness'] = freshnessReport.platforms.map(
    (platform) => {
      const status =
        platform.status === 'fresh'
          ? ('ok' as const)
          : platform.status === 'stale'
            ? ('stale' as const)
            : ('critical' as const)
      return {
        name: platform.platform,
        hoursAgo: platform.ageHours ?? 999,
        status,
      }
    }
  )

  // Count actual daily snapshots, not mutable leaderboard rows recomputed in
  // multiple seasons.
  const { count: snapshotCount24h, error: snapshotCount24hError } = await supabase
    .from('trader_daily_snapshots')
    .select('id', { count: 'estimated', head: true })
    .gte('created_at', oneDayAgo)
  if (snapshotCount24hError) {
    throw new Error(`Daily snapshot count query failed: ${snapshotCount24hError.message}`)
  }

  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  const { count: snapshotCountYesterday, error: snapshotCountYesterdayError } = await supabase
    .from('trader_daily_snapshots')
    .select('id', { count: 'estimated', head: true })
    .gte('created_at', twoDaysAgo)
    .lt('created_at', oneDayAgo)
  if (snapshotCountYesterdayError) {
    throw new Error(
      `Previous daily snapshot count query failed: ${snapshotCountYesterdayError.message}`
    )
  }

  // Top errors
  const { data: errorLogs, error: errorLogsError } = await supabase
    .from('pipeline_logs')
    .select('job_name')
    .gte('started_at', oneDayAgo)
    .in('status', ['error', 'timeout'])
  if (errorLogsError || errorLogs === null) {
    throw new Error(
      `Daily digest error summary query failed: ${errorLogsError?.message ?? 'null payload'}`
    )
  }

  const errorCounts = new Map<string, number>()
  for (const log of errorLogs) {
    errorCounts.set(log.job_name, (errorCounts.get(log.job_name) || 0) + 1)
  }
  const topErrors = Array.from(errorCounts.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([job, count]) => ({ job, count }))

  const digestData: DailyDigestData = {
    alertCount24h,
    pipelineSuccessRate,
    platformFreshness,
    topErrors,
    snapshotCount24h: snapshotCount24h || 0,
    snapshotCountYesterday: snapshotCountYesterday || 0,
  }

  const sent = await sendDailyDigest(digestData)
  if (!sent) {
    throw new Error('Daily digest delivery failed')
  }

  return { count: 1, pipelineSuccessRate, alertCount24h }
})
