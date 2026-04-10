/**
 * compute-leaderboard / enrich-stats-detail
 *
 * Phase 3: backfill missing metrics from `trader_stats_detail`. This catches
 * data from the enrichment cron that was written to stats_detail but never
 * propagated back to trader_snapshots_v2. Mutates traderMap in place.
 *
 * Extracted from route.ts as part of the computeSeason main-loop split
 * (TASKS.md "Open follow-ups").
 */

import { getSupabaseAdmin } from '@/lib/api'
import type { Period } from '@/lib/utils/arena-score'
import type { TraderRow } from './trader-row'

/**
 * Find traders missing any of: win_rate, max_drawdown, sharpe, sortino,
 * calmar, trades_count. Then look them up in trader_stats_detail and fill
 * the gaps in place. Per-source query in chunks of 100, parallelized across
 * sources.
 *
 * Returns the count of traders that were *attempted* (i.e. how many had at
 * least one missing field). The route.ts caller logs this number.
 *
 * Caller checks `isOutOfTime(90_000)` before invoking; we still pass it
 * through so the per-chunk loop can abort cleanly when the budget runs low.
 */
export async function enrichFromStatsDetail(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  traderMap: Map<string, TraderRow>,
  season: Period,
  isOutOfTime: (minMs?: number) => boolean,
): Promise<number> {
  const tradersNeedingEnrichment = Array.from(traderMap.values())
    .filter(t => t.win_rate == null || t.max_drawdown == null || t.sharpe_ratio == null ||
                 t.sortino_ratio == null || t.calmar_ratio == null || t.trades_count == null)

  if (tradersNeedingEnrichment.length === 0) return 0

  const enrichBySource = new Map<string, string[]>()
  for (const t of tradersNeedingEnrichment) {
    const ids = enrichBySource.get(t.source) || []
    ids.push(t.source_trader_id)
    enrichBySource.set(t.source, ids)
  }

  await Promise.all(
    Array.from(enrichBySource.entries()).map(async ([source, traderIds]) => {
      for (let i = 0; i < traderIds.length; i += 100) {
        if (isOutOfTime(60_000)) break // leave time for scoring + upsert
        const chunk = traderIds.slice(i, i + 100)
        const { data: statsRows } = await supabase
          .from('trader_stats_detail')
          .select('source_trader_id, profitable_trades_pct, max_drawdown, sharpe_ratio, winning_positions, total_positions, total_trades, avg_holding_time_hours, volatility, copiers_count, aum, period')
          .eq('source', source)
          .in('source_trader_id', chunk)
          .order('captured_at', { ascending: false })
          .limit(1000)
        if (!statsRows) continue

        // Dedup: keep the best row per trader (prefer matching season, then most recent)
        const bestPerTrader = new Map<string, typeof statsRows[0]>()
        for (const sr of statsRows) {
          const tid = sr.source_trader_id.startsWith('0x') ? sr.source_trader_id.toLowerCase() : sr.source_trader_id
          const existing = bestPerTrader.get(tid)
          if (!existing || (sr.period === season && existing.period !== season)) {
            bestPerTrader.set(tid, sr)
          }
        }

        for (const [tid, sr] of bestPerTrader) {
          const existing = traderMap.get(`${source}:${tid}`)
          if (!existing) continue
          // Validate enrichment values before applying (stats_detail may have bad data)
          if (sr.profitable_trades_pct != null && existing.win_rate == null &&
              sr.profitable_trades_pct >= 0 && sr.profitable_trades_pct <= 100) {
            existing.win_rate = sr.profitable_trades_pct
          }
          if (sr.max_drawdown != null && existing.max_drawdown == null &&
              sr.max_drawdown >= 0 && sr.max_drawdown <= 100) {
            existing.max_drawdown = sr.max_drawdown
          }
          if (sr.sharpe_ratio != null && existing.sharpe_ratio == null &&
              sr.sharpe_ratio >= -20 && sr.sharpe_ratio <= 20) {
            existing.sharpe_ratio = sr.sharpe_ratio
          }
          // Fill trades_count from total_trades or total_positions
          if (existing.trades_count == null) {
            const tc = sr.total_trades ?? sr.total_positions
            if (tc != null && tc > 0) existing.trades_count = tc
          }
          // Fill avg_holding_hours (used for trading_style classification)
          if (existing.avg_holding_hours == null && sr.avg_holding_time_hours != null) {
            existing.avg_holding_hours = sr.avg_holding_time_hours
          }
          // copiers_count from enrichment → exchange copy-trade count
          if (sr.copiers_count != null && sr.copiers_count > 0 && existing.copiers == null) {
            existing.copiers = sr.copiers_count
          }
          // Arena followers come from trader_follows table, applied after scoring
        }
      }
    }),
  )

  return tradersNeedingEnrichment.length
}
