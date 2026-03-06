/**
 * Weekly Pipeline Report Cron
 * Runs every Monday at 08:00 UTC — sends summary of pipeline health,
 * error counts, and new trader counts via configured alert channels.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { sendAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'

export const maxDuration = 30

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = getSupabaseAdmin()
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    // 1. Pipeline job stats (last 7 days)
    const jobStats = await PipelineLogger.getJobStats()
    const totalRuns = jobStats.reduce((sum, j) => sum + j.total_runs, 0)
    const totalErrors = jobStats.reduce((sum, j) => sum + j.error_count, 0)
    const avgSuccessRate = jobStats.length > 0
      ? jobStats.reduce((sum, j) => sum + j.success_rate, 0) / jobStats.length
      : 0

    // Top 5 failing jobs
    const topFailing = jobStats
      .filter(j => j.error_count > 0)
      .sort((a, b) => b.error_count - a.error_count)
      .slice(0, 5)

    // 2. New traders this week
    const { count: newTraders } = await supabase
      .from('trader_sources')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', weekAgo)

    // 3. Total traders
    const { count: totalTraders } = await supabase
      .from('trader_sources')
      .select('id', { count: 'exact', head: true })

    // 4. Recent failures
    const recentFailures = await PipelineLogger.getRecentFailures(10)
    const uniqueFailedJobs = new Set(recentFailures.map(f => f.job_name))

    // 5. Data freshness — sources with stale data
    const { data: staleSources } = await supabase
      .from('trader_sources')
      .select('source')
      .lt('updated_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .limit(100)

    const staleSourceCounts: Record<string, number> = {}
    staleSources?.forEach(s => {
      staleSourceCounts[s.source] = (staleSourceCounts[s.source] || 0) + 1
    })
    const staleExchanges = Object.entries(staleSourceCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)

    // 6. User growth
    const { count: newUsers } = await supabase
      .from('user_profiles')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', weekAgo)

    // Build report
    const failingJobLines = topFailing.length > 0
      ? topFailing.map(j => `  • ${j.job_name}: ${j.error_count} errors (${(j.success_rate * 100).toFixed(0)}% success)`).join('\n')
      : '  None'

    const staleLines = staleExchanges.length > 0
      ? staleExchanges.map(([src, cnt]) => `  • ${src}: ${cnt} stale traders`).join('\n')
      : '  All fresh'

    const message = [
      `Pipeline runs: ${totalRuns} | Errors: ${totalErrors} | Avg success: ${(avgSuccessRate * 100).toFixed(1)}%`,
      '',
      `Traders: ${(totalTraders ?? 0).toLocaleString()} total | +${newTraders ?? 0} new this week`,
      `Users: +${newUsers ?? 0} new this week`,
      '',
      `Top failing jobs:`,
      failingJobLines,
      '',
      `Stale exchanges:`,
      staleLines,
      '',
      `Unique failed jobs (recent): ${uniqueFailedJobs.size}`,
    ].join('\n')

    const level = avgSuccessRate < 0.8 ? 'warning' : 'info'

    await sendAlert({
      title: `📊 Arena Weekly Report — ${new Date().toISOString().split('T')[0]}`,
      message,
      level,
      details: {
        'Total Runs': totalRuns,
        'Error Count': totalErrors,
        'Success Rate': `${(avgSuccessRate * 100).toFixed(1)}%`,
        'New Traders': newTraders ?? 0,
        'New Users': newUsers ?? 0,
      },
    })

    logger.info('[Weekly Report] Sent successfully')
    return NextResponse.json({ ok: true, totalRuns, totalErrors, avgSuccessRate, newTraders, newUsers })
  } catch (err) {
    logger.error('[Weekly Report] Error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
