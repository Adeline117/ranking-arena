/**
 * compute-leaderboard / scoring-helpers
 *
 * Pure in-memory transforms used by computeSeason after enrichment but before
 * (or just after) the scoring loop. Extracted from route.ts as part of the
 * ~1400-line main-loop split tracked in TASKS.md "Open follow-ups".
 *
 * Everything here mutates its input. No DB calls, no logger calls — the route
 * still owns the surrounding info logs so per-season counts stay co-located
 * with the rest of the season log line.
 */

import type { Period } from '@/lib/utils/arena-score'
import { createLogger } from '@/lib/utils/logger'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { TraderRow } from './trader-row'

const logger = createLogger('compute-leaderboard')

const periodDaysFor = (season: Period): number => (season === '7D' ? 7 : season === '30D' ? 30 : 90)

/**
 * Phase 4b3: Last resort — compute calmar ratio from ROI + |MDD| for any
 * trader still missing it after Phases 4 / 4b / 4b2. Doesn't require daily
 * returns, only the rolled-up ROI and max drawdown. Returns the count filled
 * so the caller can log it inline with the rest of the season summary.
 *
 * Calmar = annualized_ROI / |MDD|, clamped to ±10.
 */
export function computeLastResortCalmar(traderMap: Map<string, TraderRow>, season: Period): number {
  let calmarOnly = 0
  const periodDays = periodDaysFor(season)
  for (const snap of traderMap.values()) {
    if (snap.calmar_ratio != null) continue
    if (snap.roi == null || snap.max_drawdown == null || snap.max_drawdown <= 0) continue
    const annRoi = snap.roi * (365 / periodDays)
    snap.calmar_ratio =
      Math.round(Math.max(-10, Math.min(10, annRoi / Math.abs(snap.max_drawdown))) * 10000) / 10000
    calmarOnly++
  }
  return calmarOnly
}

/**
 * Phase 4c: Classify `trading_style` for any trader missing one. Tries three
 * fallback ladders in order:
 *   1. avg_holding_hours buckets   (highest confidence: 0.5–0.8)
 *   2. trades_per_day heuristic     (medium: 0.3–0.4)
 *   3. risk profile from ROI/MDD/WR (lowest: 0.15–0.25)
 *
 * Mutates each TraderRow with `trading_style` + `style_confidence` in place.
 */
export function classifyTradingStyle(traderMap: Map<string, TraderRow>, season: Period): void {
  const periodDays = periodDaysFor(season)
  for (const snap of traderMap.values()) {
    if (snap.trading_style != null) continue
    if (snap.avg_holding_hours != null) {
      const h = snap.avg_holding_hours
      if (h < 1) {
        snap.trading_style = 'scalper'
        snap.style_confidence = 0.8
      } else if (h < 24) {
        snap.trading_style = 'day_trader'
        snap.style_confidence = 0.7
      } else if (h < 168) {
        snap.trading_style = 'swing'
        snap.style_confidence = 0.6
      } else {
        snap.trading_style = 'position'
        snap.style_confidence = 0.5
      }
    } else if (snap.trades_count != null && snap.trades_count > 0 && snap.roi != null) {
      // Heuristic: high trade count relative to period → likely scalper/day trader
      const tradesPerDay = snap.trades_count / periodDays
      if (tradesPerDay > 10) {
        snap.trading_style = 'scalper'
        snap.style_confidence = 0.4
      } else if (tradesPerDay > 2) {
        snap.trading_style = 'day_trader'
        snap.style_confidence = 0.3
      } else if (tradesPerDay > 0.3) {
        snap.trading_style = 'swing'
        snap.style_confidence = 0.3
      } else {
        snap.trading_style = 'position'
        snap.style_confidence = 0.3
      }
    } else if (snap.roi != null && snap.max_drawdown != null && snap.win_rate != null) {
      // Last resort: classify by risk profile (ROI magnitude + MDD + WR pattern)
      // This enables trading_style for ALL traders that have the basic 3 metrics
      const absRoi = Math.abs(snap.roi)
      const mdd = snap.max_drawdown
      const wr = snap.win_rate
      if (absRoi > 500 && mdd > 30) {
        snap.trading_style = 'aggressive'
        snap.style_confidence = 0.25
      } else if (wr > 65 && mdd < 15) {
        snap.trading_style = 'conservative'
        snap.style_confidence = 0.25
      } else if (absRoi > 100 && mdd > 15 && mdd < 50) {
        snap.trading_style = 'swing'
        snap.style_confidence = 0.2
      } else if (absRoi < 50 && mdd < 20) {
        snap.trading_style = 'conservative'
        snap.style_confidence = 0.2
      } else {
        snap.trading_style = 'balanced'
        snap.style_confidence = 0.15
      }
    }
  }
}

/**
 * Minimal shape that markOutliers needs from each scored row. The actual
 * scored elements have ~25 fields, but outlier detection only looks at four.
 * `is_outlier` is added by this function.
 */
export interface ScoredRowForOutlier {
  source: string
  roi: number
  pnl: number | null
  is_outlier?: boolean
}

/**
 * Pre-write validation: flag rows that look like data corruption with
 * `is_outlier = true`. They stay in the array (counted toward ranking
 * totals) but get filtered out of public leaderboards downstream by the
 * `is_outlier` column. Returns the flagged count for logging.
 *
 * Heuristics:
 *   • |ROI| >= 10,000%                           → corruption (clamp ceiling = ROI_CAP)
 *   • |PnL| > $100M from non-whale source        → bad equity proxy
 *   • PnL/ROI sign mismatch (>$500 vs >50% ROI)  → field-mapping bug
 *   • |ROI| > 500% with PnL == 0 or null         → equity-proxy mismatch
 */
export function markOutliers<T extends ScoredRowForOutlier>(scored: T[]): number {
  let outlierCount = 0
  for (const t of scored) {
    let isOutlier = false
    // |ROI| >= 10,000% is almost certainly data corruption. MUST be `>=`, not `>`:
    // ingest CLAMPS roi to exactly ±10000 (the ROI_CAP ceiling, lib/ingest/staging/
    // validate.ts clampRoi), so a corrupt whale lands at exactly 10000 — a strict `>`
    // let every clamped row through un-flagged onto the public board (0-trade, no-name,
    // 10000% "traders" reaching the 90D flagship). Clamp ceiling reached = true ROI unknown.
    if (Math.abs(t.roi) >= 10000) isOutlier = true
    // PnL > $100M from non-whale sources
    if (t.pnl != null && Math.abs(t.pnl) > 100_000_000 && !['hyperliquid'].includes(t.source))
      isOutlier = true
    // ROI and PnL sign mismatch — positive ROI with significant negative PnL or vice versa
    // Lowered from 1000/1000 threshold: audit found ROI=6086% with PnL=-$8K passing through
    if (t.pnl != null && t.pnl > 500 && t.roi < -50) isOutlier = true
    if (t.pnl != null && t.pnl < -500 && t.roi > 50) isOutlier = true
    // High ROI but PnL is 0 — data inconsistency (e.g. Bitfinex equity proxy mismatch)
    if (Math.abs(t.roi) > 500 && (t.pnl == null || t.pnl === 0)) isOutlier = true
    // web3_bot entries are excluded upstream in uniqueTraders filter, no need to check here

    if (isOutlier) {
      t.is_outlier = true
      outlierCount++
    }
  }
  return outlierCount
}

/**
 * Minimal shape that applyArenaFollowers needs from each scored row. The
 * function rewrites `followers` in place with Arena's internal follow count
 * (from trader_follows), discarding whatever the exchange returned.
 */
export interface ScoredRowForArenaFollowers {
  source: string
  source_trader_id: string
  followers: number
}

function traderAccountKey(traderId: string, source: string): string {
  return JSON.stringify([traderId, source])
}

/**
 * Replace exchange `followers` counts with Arena internal follower counts
 * from the `trader_follows` table. Uses the source-scoped account RPC for
 * batched aggregation, falling back to a bounded exact-identity SELECT if the
 * RPC fails.
 *
 * Mutates `scored[].followers` in place. Returns the count of traders that
 * have at least one Arena follower so the caller can log a single summary line.
 */
export async function applyArenaFollowers<T extends ScoredRowForArenaFollowers>(
  supabase: SupabaseClient,
  scored: T[],
  season: Period
): Promise<{ applied: number; uniqueAccounts: number }> {
  const accountMap = new Map<string, { traderId: string; source: string }>()
  for (const trader of scored) {
    const traderId = trader.source_trader_id.trim()
    const source = trader.source.trim()
    if (!traderId || !source) continue
    accountMap.set(traderAccountKey(traderId, source), { traderId, source })
  }
  const accounts = [...accountMap.values()]
  const arenaFollowerMap = new Map<string, number>()

  // Query trader_follows in chunks of 500 exact exchange accounts.
  for (let i = 0; i < accounts.length; i += 500) {
    const chunk = accounts.slice(i, i + 500)
    try {
      const { data, error } = await supabase.rpc('count_trader_account_followers', {
        p_trader_ids: chunk.map((account) => account.traderId),
        p_sources: chunk.map((account) => account.source),
      })
      if (error) throw error

      for (const row of (data ?? []) as {
        trader_id: string
        source: string
        cnt: number
      }[]) {
        const count = Number(row.cnt)
        if (!Number.isFinite(count) || count < 0) continue
        arenaFollowerMap.set(traderAccountKey(row.trader_id, row.source), count)
      }
    } catch (e) {
      logger.warn(
        `[${season}] arena follower batch query failed, using fallback: ${e instanceof Error ? e.message : String(e)}`
      )
      const requestedKeys = new Set(
        chunk.map((account) => traderAccountKey(account.traderId, account.source))
      )
      const fallbackCounts = new Map<string, number>()
      const pageSize = 1000
      let fallbackComplete = true
      for (let offset = 0; ; offset += pageSize) {
        const { data: fallbackData, error: fallbackError } = await supabase
          .from('trader_follows')
          .select('trader_id, source')
          .in('trader_id', [...new Set(chunk.map((account) => account.traderId))])
          .in('source', [...new Set(chunk.map((account) => account.source))])
          .range(offset, offset + pageSize - 1)
        if (fallbackError) {
          logger.warn(`[${season}] arena follower fallback failed: ${fallbackError.message}`)
          fallbackComplete = false
          break
        }
        for (const row of fallbackData ?? []) {
          if (typeof row.source !== 'string') continue
          const key = traderAccountKey(row.trader_id, row.source)
          if (!requestedKeys.has(key)) continue
          fallbackCounts.set(key, (fallbackCounts.get(key) || 0) + 1)
        }
        if ((fallbackData?.length ?? 0) < pageSize) break
      }
      if (fallbackComplete) {
        for (const [key, count] of fallbackCounts) {
          arenaFollowerMap.set(key, count)
        }
      }
    }
  }

  // Apply Arena follower counts to scored array
  let applied = 0
  for (const t of scored) {
    const count =
      arenaFollowerMap.get(traderAccountKey(t.source_trader_id.trim(), t.source.trim())) || 0
    t.followers = count
    if (count > 0) applied++
  }
  return { applied, uniqueAccounts: accounts.length }
}
