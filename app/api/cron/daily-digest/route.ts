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

export const GET = withCron(
  'daily-digest',
  async (_request: NextRequest, { supabase }) => {
    const dataSignal = AbortSignal.timeout(40_000)
    const freshnessSignal = AbortSignal.any([dataSignal, AbortSignal.timeout(30_000)])

    // Pipeline success rate (24h)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
    const [
      logResult,
      freshnessReport,
      snapshotCount24hResult,
      snapshotCountYesterdayResult,
      errorLogResult,
    ] = await Promise.all([
      supabase
        .from('pipeline_logs')
        .select('status')
        .gte('started_at', oneDayAgo)
        .abortSignal(dataSignal),
      buildFreshnessReport(freshnessSignal),
      supabase
        .from('trader_daily_snapshots')
        .select('id', { count: 'estimated', head: true })
        .gte('created_at', oneDayAgo)
        .abortSignal(dataSignal),
      supabase
        .from('trader_daily_snapshots')
        .select('id', { count: 'estimated', head: true })
        .gte('created_at', twoDaysAgo)
        .lt('created_at', oneDayAgo)
        .abortSignal(dataSignal),
      supabase
        .from('pipeline_logs')
        .select('job_name')
        .gte('started_at', oneDayAgo)
        .in('status', ['error', 'timeout'])
        .abortSignal(dataSignal),
    ])

    const { data: logs, error: logsError } = logResult
    if (logsError || !Array.isArray(logs)) {
      throw new Error(
        `Daily digest pipeline query failed: ${logsError?.message ?? 'invalid payload'}`
      )
    }

    const totalRuns = logs?.length || 0
    const successRuns = logs?.filter((l) => l.status === 'success').length || 0
    const pipelineSuccessRate = totalRuns > 0 ? (successRuns / totalRuns) * 100 : 0
    const alertCount24h =
      logs?.filter((l) => l.status === 'error' || l.status === 'timeout').length || 0

    // Registry promises, visible sealed generations, and source watermarks must
    // agree. A recent leftover rank row is not freshness authority.
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
    const { count: snapshotCount24h, error: snapshotCount24hError } = snapshotCount24hResult
    const { count: snapshotCountYesterday, error: snapshotCountYesterdayError } =
      snapshotCountYesterdayResult
    const snapshotCountError = snapshotCount24hError ?? snapshotCountYesterdayError
    if (
      snapshotCountError ||
      typeof snapshotCount24h !== 'number' ||
      !Number.isSafeInteger(snapshotCount24h) ||
      snapshotCount24h < 0 ||
      typeof snapshotCountYesterday !== 'number' ||
      !Number.isSafeInteger(snapshotCountYesterday) ||
      snapshotCountYesterday < 0
    ) {
      throw new Error(
        `Daily snapshot count query failed: ${snapshotCountError?.message ?? 'invalid count payload'}`
      )
    }

    // Top errors
    const { data: errorLogs, error: errorLogsError } = errorLogResult
    if (errorLogsError || !Array.isArray(errorLogs)) {
      throw new Error(
        `Daily digest error summary query failed: ${errorLogsError?.message ?? 'invalid payload'}`
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
      snapshotCount24h,
      snapshotCountYesterday,
    }

    const sent = await sendDailyDigest(digestData)
    if (!sent) {
      throw new Error('Daily digest delivery failed')
    }

    return { count: 1, pipelineSuccessRate, alertCount24h }
  },
  { safetyTimeoutMs: 115_000 }
)
