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

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { sendDailyDigest, type DailyDigestData } from '@/lib/notifications/telegram'
import { DEAD_BLOCKED_PLATFORMS } from '@/lib/constants/exchanges'
import { getSupportedInlinePlatforms } from '@/lib/cron/fetchers'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = env.CRON_SECRET
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('daily-digest')

  try {
    const supabase = getSupabaseAdmin()

    const deadSet = new Set(DEAD_BLOCKED_PLATFORMS as string[])
    const activePlatforms = getSupportedInlinePlatforms().filter(p => !deadSet.has(p))

    // Pipeline success rate (24h)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: logs } = await supabase
      .from('pipeline_logs')
      .select('status')
      .gte('started_at', oneDayAgo)

    const totalRuns = logs?.length || 0
    const successRuns = logs?.filter(l => l.status === 'success').length || 0
    const pipelineSuccessRate = totalRuns > 0 ? (successRuns / totalRuns) * 100 : 0
    const alertCount24h = logs?.filter(l => l.status === 'error' || l.status === 'timeout').length || 0

    // Platform freshness
    const { data: freshness } = await supabase
      .from('trader_snapshots_v2')
      .select('platform, as_of_ts')
      .order('as_of_ts', { ascending: false })

    const latestByPlatform = new Map<string, string>()
    for (const row of freshness || []) {
      if (!latestByPlatform.has(row.platform)) {
        latestByPlatform.set(row.platform, row.as_of_ts)
      }
    }

    const platformFreshness: DailyDigestData['platformFreshness'] = activePlatforms.map(p => {
      const latest = latestByPlatform.get(p)
      const hoursAgo = latest ? (Date.now() - new Date(latest).getTime()) / (60 * 60 * 1000) : 999
      return {
        name: p,
        hoursAgo,
        status: hoursAgo > 24 ? 'critical' as const : hoursAgo > 8 ? 'stale' as const : 'ok' as const,
      }
    })

    // Snapshot counts
    const { count: snapshotCount24h } = await supabase
      .from('trader_snapshots_v2')
      .select('*', { count: 'exact', head: true })
      .gte('as_of_ts', oneDayAgo)

    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
    const { count: snapshotCountYesterday } = await supabase
      .from('trader_snapshots_v2')
      .select('*', { count: 'exact', head: true })
      .gte('as_of_ts', twoDaysAgo)
      .lt('as_of_ts', oneDayAgo)

    // Top errors
    const { data: errorLogs } = await supabase
      .from('pipeline_logs')
      .select('job_name')
      .gte('started_at', oneDayAgo)
      .in('status', ['error', 'timeout'])

    const errorCounts = new Map<string, number>()
    for (const log of errorLogs || []) {
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

    await plog.success(sent ? 1 : 0, { pipelineSuccessRate, alertCount24h })
    return NextResponse.json({ ok: true, sent, data: digestData })
  } catch (err) {
    await plog.error(err instanceof Error ? err : new Error(String(err)))
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
