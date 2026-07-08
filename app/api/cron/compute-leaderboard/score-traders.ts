/**
 * Score traders — pure transformation from TraderRow[] to scored leaderboard entries.
 * Extracted from computeSeason to reduce route.ts by ~140 lines.
 */

import { calculateArenaScore, computeArenaScoreV4, type Period } from '@/lib/utils/arena-score'
import { sanitizeDisplayName } from '@/lib/utils/profanity'
import { getExchangeLogoUrl } from '@/lib/utils/avatar'
import { detectTraderType } from './helpers'
import { markOutliers, applyArenaFollowers } from './scoring-helpers'
import type { TraderRow } from './trader-row'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('compute-leaderboard')

export interface ScoredTrader {
  source: string
  source_trader_id: string
  arena_score: number | null
  arena_score_v4: number | null // shadow: v4 score, parallel-computed, not served
  roi: number
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  followers: number
  copiers: number | null
  trades_count: number | null
  handle: string | null
  avatar_url: string
  profitability_score: number
  risk_control_score: number
  execution_score: null
  score_completeness: 'full' | 'partial' | 'minimal'
  trading_style: string | null
  avg_holding_hours: number | null
  style_confidence: number | null
  sharpe_ratio: number | null
  sortino_ratio: number | null
  profit_factor: number | null
  calmar_ratio: number | null
  trader_type: string | null
  metrics_estimated: boolean
  is_outlier?: boolean
}

/**
 * Calculate arena scores for all traders and apply post-processing.
 * Returns scored + filtered array (null scores excluded).
 */
export async function scoreTraders(
  uniqueTraders: TraderRow[],
  handleMap: Map<string, { handle: string | null; avatar_url: string | null }>,
  contractAddresses: Set<string>,
  season: Period,
  supabase: SupabaseClient
): Promise<{ scored: ScoredTrader[]; scoredFiltered: ScoredTrader[] }> {
  const scored = uniqueTraders.map((t) => {
    // Win rate normalization: clamp to 0-100, convert decimal if needed
    let normalizedWinRate: number | null = null
    if (t.win_rate != null && !isNaN(t.win_rate)) {
      const wr = t.win_rate > 0 && t.win_rate <= 1 ? t.win_rate * 100 : t.win_rate
      normalizedWinRate = Math.max(0, Math.min(100, wr))
    }

    const scoreResult = calculateArenaScore(
      {
        roi: t.roi!,
        pnl: t.pnl ?? null,
        maxDrawdown: t.max_drawdown,
        winRate: normalizedWinRate,
      },
      season
    )

    // Confidence: V3 scores ROI + PnL only
    const hasRoi = t.roi != null
    const hasPnl = t.pnl != null && Number(t.pnl) > 0
    const confidenceMultiplier = hasRoi && hasPnl ? 1.0 : hasRoi ? 0.85 : 0.5
    const estimationPenalty = t.metrics_estimated ? 0.92 : 1.0

    // Low trade count penalty: 1 trade → 0.64x, 10+ → 1.0x
    // trades_count=0 means "unknown" (API doesn't provide) — skip penalty (same as null)
    let tradeCountPenalty = 1.0
    if (t.trades_count != null && t.trades_count > 0 && t.trades_count < 10) {
      tradeCountPenalty = 0.6 + 0.04 * t.trades_count
    }

    const rawSubScores =
      scoreResult.returnScore +
      scoreResult.pnlScore +
      scoreResult.drawdownScore +
      scoreResult.stabilityScore
    const rawFinalScore =
      Math.round(
        Math.max(
          0,
          Math.min(100, rawSubScores * confidenceMultiplier * estimationPenalty * tradeCountPenalty)
        ) * 100
      ) / 100
    const finalScore = rawFinalScore > 0 ? rawFinalScore : null

    // ── Arena Score v4 (SHADOW — parallel-computed, written but not served) ──
    // v4's Quality×Confidence already bakes in sample-size + data-completeness,
    // so we take its totalScore directly (no v3 external penalties applied).
    const v4 = computeArenaScoreV4(
      {
        roi: t.roi ?? 0,
        pnl: t.pnl ?? null,
        maxDrawdown: t.max_drawdown,
        winRate: normalizedWinRate,
        sharpeRatio: t.sharpe_ratio,
        profitFactor: t.profit_factor ?? null,
        tradesCount: t.trades_count,
      },
      season
    )
    const finalScoreV4 = v4.totalScore > 0 ? v4.totalScore : null

    // Handle/avatar resolution
    const info = handleMap.get(`${t.source}:${t.source_trader_id}`) || {
      handle: null,
      avatar_url: null,
    }
    const rawHandle = info.handle?.trim() || null
    const isNumericUid = rawHandle && /^\d{7,}$/.test(rawHandle)
    const displayHandle = rawHandle && !isNumericUid ? sanitizeDisplayName(rawHandle) : null

    return {
      source: t.source,
      source_trader_id: t.source_trader_id,
      arena_score: finalScore,
      arena_score_v4: finalScoreV4,
      roi: t.roi ?? 0,
      pnl: t.pnl,
      win_rate: normalizedWinRate,
      max_drawdown: t.max_drawdown,
      followers: t.followers ?? 0,
      copiers: t.copiers ?? null,
      trades_count: t.trades_count,
      handle: displayHandle,
      avatar_url: info.avatar_url || getExchangeLogoUrl(t.source),
      profitability_score: Math.round(scoreResult.returnScore * 100) / 100,
      risk_control_score: Math.round(scoreResult.pnlScore * 100) / 100,
      execution_score: null as null,
      score_completeness: (t.max_drawdown != null && t.win_rate != null
        ? 'full'
        : t.max_drawdown != null || t.win_rate != null
          ? 'partial'
          : 'minimal') as 'full' | 'partial' | 'minimal',
      trading_style: t.trading_style,
      avg_holding_hours: t.avg_holding_hours,
      style_confidence: t.style_confidence,
      sharpe_ratio: t.sharpe_ratio,
      sortino_ratio: t.sortino_ratio ?? null,
      profit_factor: t.profit_factor ?? null,
      calmar_ratio: t.calmar_ratio ?? null,
      trader_type: detectTraderType(
        t.source,
        t.source_trader_id,
        t.trades_count,
        t.trader_type,
        t.avg_holding_hours,
        t.win_rate,
        contractAddresses.has(t.source_trader_id) || undefined
      ),
      metrics_estimated: t.metrics_estimated || false,
    }
  })

  // Mark outliers
  const outlierCount = markOutliers(scored)
  if (outlierCount > 0) {
    logger.info(
      `[${season}] Marked ${outlierCount} outliers (kept in leaderboard with is_outlier=true)`
    )
  }

  // Replace exchange followers with Arena internal follower counts
  const { applied, uniqueIds } = await applyArenaFollowers(supabase, scored, season)
  logger.info(
    `[${season}] Arena followers: ${applied} traders have followers (${uniqueIds} unique trader_ids queried)`
  )

  // Filter out null scores (ROI≈0 + PnL≈0)
  const scoredFiltered = scored.filter((t) => t.arena_score != null)

  return { scored, scoredFiltered }
}
