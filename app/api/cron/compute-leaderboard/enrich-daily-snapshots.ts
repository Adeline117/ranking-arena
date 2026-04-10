/**
 * compute-leaderboard / enrich-daily-snapshots
 *
 * Phase 4b2: last-mile fallback for sharpe / sortino / calmar / profit_factor
 * sourced from `trader_daily_snapshots`. This catches traders not reached by
 * Phase 4b (which uses trader_equity_curve) — typically traders below the
 * top-N enrichment cut-off whose equity_curve is empty.
 *
 * Daily returns are computed by preferring `daily_return_pct` first, falling
 * back to consecutive-day ROI diffs (clamped to ±1000% to filter outliers).
 *
 * Extracted from route.ts as part of the computeSeason main-loop split
 * (TASKS.md "Open follow-ups"). Mutates traderMap in place.
 */

import { getSupabaseAdmin } from '@/lib/api'
import { DATA_QUALITY_BOUNDARY } from '@/lib/pipeline/types'
import type { Period } from '@/lib/utils/arena-score'
import type { TraderRow } from './trader-row'

const periodDaysFor = (season: Period): number =>
  season === '7D' ? 7 : season === '30D' ? 30 : 90

export async function deriveAdvancedFromDailySnapshots(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  traderMap: Map<string, TraderRow>,
  season: Period,
  isOutOfTime: (minMs?: number) => boolean,
): Promise<number> {
  const stillNeedAdvanced = Array.from(traderMap.values())
    .filter(t => t.roi != null && (t.sharpe_ratio == null || t.sortino_ratio == null || t.calmar_ratio == null || t.profit_factor == null))
  if (stillNeedAdvanced.length === 0) return 0

  const dsBySource = new Map<string, string[]>()
  for (const t of stillNeedAdvanced) {
    const ids = dsBySource.get(t.source) || []
    ids.push(t.source_trader_id)
    dsBySource.set(t.source, ids)
  }

  let dailyDerived = 0
  const periodDays = periodDaysFor(season)

  await Promise.all(
    Array.from(dsBySource.entries()).map(async ([source, traderIds]) => {
      for (let i = 0; i < traderIds.length; i += 100) {
        if (isOutOfTime(40_000)) break
        const chunk = traderIds.slice(i, i + 100)
        const { data: dsRows } = await supabase
          .from('trader_daily_snapshots')
          .select('trader_key, date, daily_return_pct, roi')
          .eq('platform', source)
          .in('trader_key', chunk)
          .gte('date', DATA_QUALITY_BOUNDARY)
          .order('date', { ascending: true })
          .limit(10000)
        if (!dsRows?.length) continue

        // Group by trader — collect daily_return_pct AND roi for fallback computation
        const byTraderRaw = new Map<string, Array<{ daily_return_pct: number | null; roi: number | null }>>()
        for (const row of dsRows) {
          const tid = row.trader_key.startsWith('0x') ? row.trader_key.toLowerCase() : row.trader_key
          if (!byTraderRaw.has(tid)) byTraderRaw.set(tid, [])
          byTraderRaw.get(tid)!.push({
            daily_return_pct: row.daily_return_pct != null ? Number(row.daily_return_pct) : null,
            roi: row.roi != null ? Number(row.roi) : null,
          })
        }

        // Compute daily returns: prefer daily_return_pct, fallback to ROI diff between consecutive days
        const byTrader = new Map<string, number[]>()
        for (const [tid, rows] of byTraderRaw) {
          const returns: number[] = []
          for (let r = 0; r < rows.length; r++) {
            const ret = rows[r].daily_return_pct
            if (ret != null && !isNaN(ret)) {
              returns.push(ret)
            } else if (r > 0 && rows[r].roi != null && rows[r - 1].roi != null) {
              // Compute daily return from consecutive ROI values
              const diff = rows[r].roi! - rows[r - 1].roi!
              if (Math.abs(diff) < 1000) returns.push(diff)
            }
          }
          byTrader.set(tid, returns)
        }

        for (const [tid, dailyReturns] of byTrader) {
          const existing = traderMap.get(`${source}:${tid}`)
          if (!existing || dailyReturns.length < 3) continue

          // Sharpe ratio from daily snapshots
          if (existing.sharpe_ratio == null && dailyReturns.length >= 7) {
            const decReturns = dailyReturns.map(r => r / 100)
            const mean = decReturns.reduce((a, b) => a + b, 0) / decReturns.length
            const variance = decReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / decReturns.length
            const stdDev = Math.sqrt(variance)
            if (stdDev > 0) {
              const sharpe = (mean / stdDev) * Math.sqrt(365)
              existing.sharpe_ratio = Math.round(Math.max(-20, Math.min(20, sharpe)) * 10000) / 10000
              dailyDerived++
            }
          }

          // Sortino
          if (existing.sortino_ratio == null && dailyReturns.length >= 3) {
            const decReturns = dailyReturns.map(r => r / 100)
            const negReturns = decReturns.filter(r => r < 0)
            if (negReturns.length > 0) {
              const avg = decReturns.reduce((a, b) => a + b, 0) / decReturns.length
              const dsd = Math.sqrt(negReturns.reduce((s, r) => s + r * r, 0) / decReturns.length)
              if (dsd > 0) {
                existing.sortino_ratio = Math.round(Math.max(-10, Math.min(10, (avg / dsd) * Math.sqrt(365))) * 10000) / 10000
                dailyDerived++
              }
            } else {
              existing.sortino_ratio = 10
              dailyDerived++
            }
          }

          // Calmar
          if (existing.calmar_ratio == null && existing.roi != null && existing.max_drawdown != null && existing.max_drawdown > 0) {
            const annRoi = existing.roi * (365 / periodDays)
            existing.calmar_ratio = Math.round(Math.max(-10, Math.min(10, annRoi / Math.abs(existing.max_drawdown))) * 10000) / 10000
            dailyDerived++
          }

          // Profit factor
          if (existing.profit_factor == null && dailyReturns.length >= 3) {
            const gw = dailyReturns.filter(r => r > 0).reduce((s, r) => s + r, 0)
            const gl = Math.abs(dailyReturns.filter(r => r < 0).reduce((s, r) => s + r, 0))
            if (gl > 0) {
              existing.profit_factor = Math.round(Math.min(10, gw / gl) * 10000) / 10000
              dailyDerived++
            } else if (gw > 0) {
              existing.profit_factor = 10
              dailyDerived++
            }
          }
        }
      }
    }),
  )

  return dailyDerived
}
