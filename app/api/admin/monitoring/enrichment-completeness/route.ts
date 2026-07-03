/**
 * GET /api/admin/monitoring/enrichment-completeness
 *
 * Returns per-platform enrichment completeness metrics:
 * - Traders with snapshots vs total in leaderboard
 * - Traders with equity curves
 * - Traders with stats detail (win_rate, max_drawdown)
 * - Dead letter queue depth
 * - Latest heartbeat status
 * - Enrichment success rate (last 24h from pipeline_logs)
 *
 * Used by /admin/monitoring enrichment completeness panel.
 */

import { withCron } from '@/lib/api/with-cron'
import { PipelineState } from '@/lib/services/pipeline-state'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export const GET = withCron('enrichment-completeness', async (_request, { supabase }) => {
  // 1. Per-platform leaderboard counts
  const { data: lrCounts } = await supabase
    .from('leaderboard_count_cache')
    .select('source, total_count, season_id')
    .eq('season_id', '90D')
    .not('source', 'eq', '_all')
    .not('source', 'like', '%_gt0')
    .gt('total_count', 0)
    .order('total_count', { ascending: false })

  const platforms = (lrCounts || []).map((r: Record<string, unknown>) => String(r.source))

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

    const lrRow = (lrCounts || []).find((r: Record<string, unknown>) => r.source === platform)
    const totalInLeaderboard = Number(lrRow?.total_count) || 0

    enrichmentStats.push({
      platform,
      total_in_leaderboard: totalInLeaderboard,
      with_equity_curve: ecResult.count || 0,
      with_stats_detail: sdResult.count || 0,
      ec_coverage_pct:
        totalInLeaderboard > 0 ? Math.round(((ecResult.count || 0) / totalInLeaderboard) * 100) : 0,
      sd_coverage_pct:
        totalInLeaderboard > 0 ? Math.round(((sdResult.count || 0) / totalInLeaderboard) * 100) : 0,
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

  // 6. Heartbeat status (if table exists)
  let heartbeats: Array<Record<string, unknown>> = []
  try {
    const { query } = await import('@/lib/db')
    const result = await query(
      `SELECT DISTINCT ON (platform) platform, source_host, status, trader_count, created_at,
              ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600, 1) AS hours_since
       FROM platform_heartbeats ORDER BY platform, created_at DESC`,
      []
    )
    heartbeats = (result.rows || []).map((r: Record<string, unknown>) => ({
      ...r,
      is_stale: Number(r.hours_since) > 6,
    }))
  } catch {
    // Table may not exist yet
  }

  return {
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
    heartbeats,
  }
})
