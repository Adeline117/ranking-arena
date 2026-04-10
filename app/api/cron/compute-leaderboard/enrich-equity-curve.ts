/**
 * compute-leaderboard / enrich-equity-curve
 *
 * Phase 4 + Phase 4b: derive missing metrics from `trader_equity_curve`. The
 * equity curve is a daily ROI/PnL series, so we can compute:
 *
 *   Phase 4  → win_rate (from daily PnL direction) and max_drawdown
 *              (peak-to-trough on the cumulative ROI/PnL curve)
 *   Phase 4b → sharpe / sortino / calmar / profit_factor / trades_count
 *              (the last is just `points.length` as a fallback)
 *
 * Both mutate `traderMap` in place. Extracted from route.ts as part of the
 * computeSeason main-loop split (TASKS.md "Open follow-ups").
 */

import { getSupabaseAdmin } from '@/lib/api'
import type { Period } from '@/lib/utils/arena-score'
import type { TraderRow } from './trader-row'

const periodDaysFor = (season: Period): number =>
  season === '7D' ? 7 : season === '30D' ? 30 : 90

/**
 * Phase 4: derive win_rate + max_drawdown from trader_equity_curve for any
 * trader still missing one or both. Returns the count of values filled (a
 * trader may contribute up to 2). Caller logs the summary line.
 */
export async function deriveWrMddFromEquityCurve(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  traderMap: Map<string, TraderRow>,
  isOutOfTime: (minMs?: number) => boolean,
): Promise<number> {
  const stillNeedingData = Array.from(traderMap.values())
    .filter(t => t.win_rate == null || t.max_drawdown == null)
  if (stillNeedingData.length === 0) return 0

  const eqBySource = new Map<string, string[]>()
  for (const t of stillNeedingData) {
    const ids = eqBySource.get(t.source) || []
    ids.push(t.source_trader_id)
    eqBySource.set(t.source, ids)
  }

  let derived = 0
  await Promise.all(
    Array.from(eqBySource.entries()).map(async ([source, traderIds]) => {
      // Query equity curves for these traders (all periods, prefer 90D)
      for (let i = 0; i < traderIds.length; i += 50) {
        if (isOutOfTime(60_000)) break
        const chunk = traderIds.slice(i, i + 50)
        const { data: eqRows } = await supabase
          .from('trader_equity_curve')
          .select('source_trader_id, pnl_usd, roi_pct, data_date')
          .eq('source', source)
          .in('source_trader_id', chunk)
          .order('data_date', { ascending: true })
          .limit(1000)
        if (!eqRows?.length) continue

        // Group by trader
        const byTrader = new Map<string, Array<{ pnl: number | null; roi: number | null }>>()
        for (const row of eqRows) {
          const tid = row.source_trader_id.startsWith('0x') ? row.source_trader_id.toLowerCase() : row.source_trader_id
          const arr = byTrader.get(tid) || []
          arr.push({ pnl: row.pnl_usd, roi: row.roi_pct })
          byTrader.set(tid, arr)
        }

        for (const [tid, points] of byTrader) {
          const existing = traderMap.get(`${source}:${tid}`)
          if (!existing) continue

          // Derive win_rate from daily PnL direction (lowered from 3 to 2 points)
          if (existing.win_rate == null && points.length >= 2) {
            let wins = 0, total = 0
            for (let j = 1; j < points.length; j++) {
              const prevPnl = points[j - 1].pnl ?? 0
              const currPnl = points[j].pnl ?? 0
              const dailyPnl = currPnl - prevPnl
              if (dailyPnl > 0) wins++
              if (Math.abs(dailyPnl) > 0.01) total++
            }
            if (total >= 1) {
              existing.win_rate = Math.round((wins / total) * 10000) / 100
              derived++
            }
          }

          // Derive max_drawdown from cumulative PnL or ROI curve (lowered from 3 to 2 points)
          if (existing.max_drawdown == null && points.length >= 2) {
            let peak = 0, maxDD = 0
            // Try ROI first, fall back to PnL
            const values = points.map(p => p.roi ?? p.pnl ?? 0)
            for (const v of values) {
              if (v > peak) peak = v
              if (peak > 0) {
                const dd = ((peak - v) / Math.abs(peak)) * 100
                if (dd > maxDD) maxDD = dd
              }
            }
            if (maxDD > 0.01 && maxDD <= 100) {
              existing.max_drawdown = Math.round(maxDD * 100) / 100
              derived++
            }
          }
        }
      }
    }),
  )

  return derived
}

/**
 * Phase 4b: compute advanced metrics (sharpe / sortino / calmar /
 * profit_factor) from trader_equity_curve for any trader still missing them.
 * Also estimates trades_count from `points.length` as a last-resort fallback
 * for platforms that don't return a real trade count.
 *
 * Same per-source 50-id chunked parallelism as Phase 4. Mutates traderMap.
 */
export async function deriveAdvancedFromEquityCurve(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  traderMap: Map<string, TraderRow>,
  season: Period,
  isOutOfTime: (minMs?: number) => boolean,
): Promise<number> {
  const needAdvanced = Array.from(traderMap.values())
    .filter(t => t.roi != null && (t.sharpe_ratio == null || t.sortino_ratio == null || t.calmar_ratio == null || t.profit_factor == null || t.trades_count == null))
  if (needAdvanced.length === 0) return 0

  const advBySource = new Map<string, string[]>()
  for (const t of needAdvanced) {
    const ids = advBySource.get(t.source) || []
    ids.push(t.source_trader_id)
    advBySource.set(t.source, ids)
  }

  let advancedDerived = 0
  const periodDays = periodDaysFor(season)

  await Promise.all(
    Array.from(advBySource.entries()).map(async ([source, traderIds]) => {
      for (let i = 0; i < traderIds.length; i += 50) {
        if (isOutOfTime(50_000)) break
        const chunk = traderIds.slice(i, i + 50)
        const { data: eqRows } = await supabase
          .from('trader_equity_curve')
          .select('source_trader_id, roi_pct, pnl_usd, data_date')
          .eq('source', source)
          .in('source_trader_id', chunk)
          .order('data_date', { ascending: true })
          .limit(1000)
        if (!eqRows?.length) continue

        // Group by trader
        const byTrader = new Map<string, Array<{ roi: number; pnl: number | null; date: string }>>()
        for (const row of eqRows) {
          const tid = row.source_trader_id.startsWith('0x') ? row.source_trader_id.toLowerCase() : row.source_trader_id
          const arr = byTrader.get(tid) || []
          if (row.roi_pct != null) arr.push({ roi: Number(row.roi_pct), pnl: row.pnl_usd != null ? Number(row.pnl_usd) : null, date: row.data_date })
          byTrader.set(tid, arr)
        }

        for (const [tid, points] of byTrader) {
          const existing = traderMap.get(`${source}:${tid}`)
          if (!existing) continue

          // Estimate trades_count from equity curve data points (each point = a day with activity)
          if (existing.trades_count == null && points.length >= 2) {
            existing.trades_count = points.length
            advancedDerived++
          }

          if (points.length < 7) continue

          // Compute daily returns from cumulative ROI
          const dailyReturns: number[] = []
          for (let j = 1; j < points.length; j++) {
            dailyReturns.push(points[j].roi - points[j - 1].roi)
          }

          // Compute daily PnL changes for avg_profit/avg_loss/largest_win/largest_loss
          const dailyPnlChanges: number[] = []
          for (let j = 1; j < points.length; j++) {
            const prevPnl = points[j - 1].pnl
            const currPnl = points[j].pnl
            if (prevPnl != null && currPnl != null) {
              const change = currPnl - prevPnl
              if (Math.abs(change) > 0.01) dailyPnlChanges.push(change)
            }
          }

          // Sharpe ratio = (mean daily return / std dev of daily returns) * sqrt(365)
          if (existing.sharpe_ratio == null && dailyReturns.length >= 7) {
            const decimalReturns = dailyReturns.map(r => r / 100)
            const mean = decimalReturns.reduce((a, b) => a + b, 0) / decimalReturns.length
            const variance = decimalReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / decimalReturns.length
            const stdDev = Math.sqrt(variance)
            if (stdDev > 0) {
              const sharpe = (mean / stdDev) * Math.sqrt(365)
              existing.sharpe_ratio = Math.round(Math.max(-20, Math.min(20, sharpe)) * 10000) / 10000
              advancedDerived++
            }
          }

          // Sortino ratio
          if (existing.sortino_ratio == null && dailyReturns.length >= 3) {
            const decimalReturns = dailyReturns.map(r => r / 100)
            const negReturns = decimalReturns.filter(r => r < 0)
            if (negReturns.length > 0) {
              const avgReturn = decimalReturns.reduce((a, b) => a + b, 0) / decimalReturns.length
              const downsideDev = Math.sqrt(negReturns.reduce((s, r) => s + r * r, 0) / decimalReturns.length)
              if (downsideDev > 0) {
                const sortino = Math.max(-10, Math.min(10, (avgReturn / downsideDev) * Math.sqrt(365)))
                existing.sortino_ratio = Math.round(sortino * 10000) / 10000
                advancedDerived++
              }
            } else {
              existing.sortino_ratio = 10 // No negative returns
              advancedDerived++
            }
          }

          // Calmar ratio = annualized ROI / |MDD|
          if (existing.calmar_ratio == null && existing.roi != null && existing.max_drawdown != null && existing.max_drawdown > 0) {
            const annualizedRoi = existing.roi * (365 / periodDays)
            const calmar = annualizedRoi / Math.abs(existing.max_drawdown)
            existing.calmar_ratio = Math.round(Math.max(-10, Math.min(10, calmar)) * 10000) / 10000
            advancedDerived++
          }

          // Profit factor from daily returns (gross wins / gross losses)
          if (existing.profit_factor == null && dailyReturns.length >= 3) {
            const grossWin = dailyReturns.filter(r => r > 0).reduce((s, r) => s + r, 0)
            const grossLoss = Math.abs(dailyReturns.filter(r => r < 0).reduce((s, r) => s + r, 0))
            if (grossLoss > 0) {
              existing.profit_factor = Math.round(Math.min(10, grossWin / grossLoss) * 10000) / 10000
            } else if (grossWin > 0) {
              existing.profit_factor = 10
            }
            advancedDerived++
          }
        }
      }
    }),
  )

  return advancedDerived
}
