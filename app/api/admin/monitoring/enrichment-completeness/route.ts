/**
 * GET /api/admin/monitoring/enrichment-completeness
 *
 * Returns per-platform enrichment completeness metrics:
 * - Traders with snapshots vs total in leaderboard
 * - Traders with equity curves
 * - Traders with stats detail (win_rate, max_drawdown)
 * - Dead letter queue depth
 * - Heartbeat-history publication status
 * - Enrichment success rate (last 24h from pipeline_logs)
 *
 * Used by /admin/monitoring enrichment completeness panel.
 */

import { NextResponse } from 'next/server'
import { verifyAdminAuth } from '@/lib/auth/verify-service-auth'
import { V1_HEARTBEAT_HISTORY_NOT_PUBLISHED_CODE } from '@/lib/monitoring/v1-heartbeat-history-publication'
import { PipelineState } from '@/lib/services/pipeline-state'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/utils/logger'
import { readServedRankingSources } from '@/lib/data/served-ranking-sources'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 30

const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

/**
 * This is an administrator dashboard read, not a scheduled job. Keep it out
 * of the cron wrapper so the V1 cron publication gate cannot retire the panel.
 */
export async function GET(request: Request) {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: PRIVATE_NO_STORE_HEADERS }
    )
  }

  const startedAt = Date.now()

  try {
    const supabase = getSupabaseAdmin()

    // 1. Per-platform published counts, for the sources the public board is
    //    serving (issue #554), largest first.
    const servedSources = (await readServedRankingSources(supabase)).sort(
      (left, right) => right.publishedCount - left.publishedCount
    )
    const platforms = servedSources.map((served) => served.source)

    // 2. Per-platform enrichment completeness (equity curve coverage)
    const enrichmentStats: Array<Record<string, unknown>> = []

    // Batch query: count traders with equity curves per platform
    for (const platform of platforms.slice(0, 30)) {
      const [ecResult, sdResult] = await Promise.all([
        // Equity curve coverage
        supabase
          .from('trader_equity_curve')
          .select('source', { count: 'exact', head: true })
          .eq('source', platform),
        // Stats detail coverage (has win_rate OR max_drawdown)
        supabase
          .from('trader_stats_detail')
          .select('source', { count: 'exact', head: true })
          .eq('source', platform),
      ])

      const totalInLeaderboard =
        servedSources.find((served) => served.source === platform)?.publishedCount ?? 0

      enrichmentStats.push({
        platform,
        total_in_leaderboard: totalInLeaderboard,
        with_equity_curve: ecResult.count || 0,
        with_stats_detail: sdResult.count || 0,
        ec_coverage_pct:
          totalInLeaderboard > 0
            ? Math.round(((ecResult.count || 0) / totalInLeaderboard) * 100)
            : 0,
        sd_coverage_pct:
          totalInLeaderboard > 0
            ? Math.round(((sdResult.count || 0) / totalInLeaderboard) * 100)
            : 0,
      })
    }

    // 3. Dead letter queue depth
    const deadLetters = await PipelineState.getByPrefix('enrich:dead:')
    const deadLetterSummary = deadLetters
      .map((e) => {
        const value = e.value as { traderIds?: string[]; failCount?: number } | null
        return {
          key: e.key.replace('enrich:dead:', ''),
          count: value?.traderIds?.length || 0,
          fail_count: value?.failCount || 0,
        }
      })
      .filter((d) => d.count > 0)
      .sort((a, b) => b.count - a.count)

    // 4. Gap detection summary
    const { data: gapSummary } = await supabase.rpc('get_data_gap_summary', {
      p_max_age_hours: 48,
    })

    // 5. Pipeline success rate (last 24h)
    const cutoff24h = new Date(Date.now() - 24 * 3600_000).toISOString()
    const { data: pipelineLogs } = await supabase
      .from('pipeline_logs')
      .select('job_name, status')
      .gte('started_at', cutoff24h)
      .like('job_name', 'enrich-%')

    const enrichLogs = pipelineLogs || []
    const successCount = enrichLogs.filter(
      (l: Record<string, unknown>) => l.status === 'success'
    ).length
    const totalLogs = enrichLogs.length
    const successRate = totalLogs > 0 ? Math.round((successCount / totalLogs) * 100) : 0

    return NextResponse.json(
      {
        // Preserve the response shape previously added by the cron wrapper so
        // existing dashboard consumers do not need a migration.
        ok: true,
        elapsed_ms: Date.now() - startedAt,
        count: enrichmentStats.length,
        enrichment_stats: enrichmentStats,
        dead_letter_queue: deadLetterSummary,
        dead_letter_total: deadLetterSummary.reduce((sum, d) => sum + d.count, 0),
        gap_summary: gapSummary || [],
        pipeline_24h: {
          total: totalLogs,
          success: successCount,
          success_rate_pct: successRate,
        },
        // Retain the legacy array for dashboard compatibility, but never turn
        // a missing history dependency into a misleading healthy 0/0 result.
        heartbeats: [],
        heartbeat_history: {
          availability: false,
          code: V1_HEARTBEAT_HISTORY_NOT_PUBLISHED_CODE,
        },
      },
      { headers: PRIVATE_NO_STORE_HEADERS }
    )
  } catch (error) {
    logger.error('[enrichment-completeness] panel read failed', error)
    return NextResponse.json(
      {
        ok: false,
        error: 'Internal server error',
        elapsed_ms: Date.now() - startedAt,
      },
      { status: 500, headers: PRIVATE_NO_STORE_HEADERS }
    )
  }
}
