/**
 * Cron: Data Reconciliation — detect and report data gaps
 * Schedule: Daily at 04:00 UTC
 *
 * Calls get_data_gap_summary() to identify traders in trader_sources that
 * have no fresh SEALED public publication (>48h; judged on
 * public_ranked_leaderboard + seal time since 20261114104438, not
 * leaderboard_ranks.computed_at) and reports a per-platform summary via alert. Detection + alert only: the former hand-off to
 * retry-dead-letters (reconciliation:gaps:* → enrich:retry:*) had no consumer
 * and silently discarded the gaps, so it was removed (2026-11 audit P2-2).
 */

import { withCron } from '@/lib/api/with-cron'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export const GET = withCron(
  'data-reconciliation',
  async (_request, { supabase }) => {
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

    // 2. Send summary alert
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
  },
  { maxDurationSec: maxDuration }
)
