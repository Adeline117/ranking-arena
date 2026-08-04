/**
 * GET /api/admin/monitoring/enrichment-completeness
 *
 * Returns per-platform enrichment completeness metrics:
 * - Traders with snapshots vs total in leaderboard
 * - Traders with equity curves
 * - Traders with stats detail (win_rate, max_drawdown)
 * - Current reconciliation gap summary
 *
 * Used by /admin/monitoring enrichment completeness panel.
 */

import { withCron } from '@/lib/api/with-cron'

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

  // 3. Gap detection summary
  const { data: gapSummary } = await supabase.rpc('get_data_gap_summary', {
    p_max_age_hours: 48,
  })

  return {
    count: enrichmentStats.length,
    enrichment_stats: enrichmentStats,
    gap_summary: gapSummary || [],
  }
})
