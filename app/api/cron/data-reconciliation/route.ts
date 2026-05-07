/**
 * Cron: Data Reconciliation — detect and report data gaps
 * Schedule: Daily at 04:00 UTC
 *
 * Calls find_data_gaps() RPC to identify traders in trader_sources
 * that have no recent leaderboard data (>48h stale). Reports per-platform
 * summary via Telegram alert and stores results in pipeline_state for
 * the retry-dead-letters cron to act on.
 */

import { withCron } from '@/lib/api/with-cron'
import { PipelineState } from '@/lib/services/pipeline-state'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export const GET = withCron('data-reconciliation', async (_request, { supabase }) => {
  // 1. Get per-platform gap summary
  const { data: summary, error: summaryErr } = await supabase.rpc('get_data_gap_summary', {
    p_max_age_hours: 48,
  })

  if (summaryErr) {
    throw new Error(`get_data_gap_summary failed: ${summaryErr.message}`)
  }

  const gaps = (summary || []) as Array<{
    source: string
    gap_count: number
    avg_gap_hours: number
    max_gap_hours: number
  }>

  if (gaps.length === 0) {
    return { count: 0, message: 'No data gaps detected' }
  }

  // 2. Get detailed gap list for top platforms (limited to 500 total)
  const { data: details, error: detailErr } = await supabase.rpc('find_data_gaps', {
    p_max_age_hours: 48,
    p_limit: 500,
  })

  if (detailErr) {
    throw new Error(`find_data_gaps failed: ${detailErr.message}`)
  }

  const gapDetails = (details || []) as Array<{
    source: string
    source_trader_id: string
    last_computed: string | null
    gap_hours: number
  }>

  // 3. Group by platform and store in PipelineState for retry-dead-letters
  const byPlatform: Record<string, string[]> = {}
  for (const gap of gapDetails) {
    if (!byPlatform[gap.source]) byPlatform[gap.source] = []
    byPlatform[gap.source].push(gap.source_trader_id)
  }

  for (const [platform, traderIds] of Object.entries(byPlatform)) {
    await PipelineState.set(`reconciliation:gaps:${platform}`, {
      traderIds: traderIds.slice(0, 100), // Cap per platform
      detectedAt: new Date().toISOString(),
      count: traderIds.length,
    })
  }

  // 4. Send summary alert
  const totalGaps = gaps.reduce((sum, g) => sum + g.gap_count, 0)
  const summaryLines = gaps
    .sort((a, b) => b.gap_count - a.gap_count)
    .slice(0, 15)
    .map(
      (g) =>
        `  ${g.source}: ${g.gap_count} traders (avg ${g.avg_gap_hours}h, max ${g.max_gap_hours}h)`
    )

  await sendRateLimitedAlert(
    {
      title: `数据缺口报告: ${totalGaps} traders across ${gaps.length} platforms`,
      message: summaryLines.join('\n'),
      level: totalGaps > 1000 ? 'critical' : 'warning',
      details: { platforms: gaps.length, total_gaps: totalGaps },
    },
    'data-reconciliation:daily',
    20 * 60 * 60 * 1000 // 20h cooldown (daily job)
  )

  return {
    count: totalGaps,
    platforms_affected: gaps.length,
    top_gaps: gaps.slice(0, 10),
  }
})
