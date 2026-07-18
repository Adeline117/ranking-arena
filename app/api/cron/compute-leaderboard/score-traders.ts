/**
 * Score traders — pure transformation from TraderRow[] to scored leaderboard entries.
 * Extracted from computeSeason to reduce route.ts by ~140 lines.
 */

import {
  calculateArenaScore,
  computeArenaScoresV4,
  type Period,
  type ArenaScoreV4Result,
} from '@/lib/utils/arena-score'
import { sanitizeDisplayName } from '@/lib/utils/profanity'
import { getExchangeLogoUrl } from '@/lib/utils/avatar'
import { canonicalizeLocalExchangeLogoPath } from '@/lib/utils/exchange-logo-path'
import type { Database } from '@/lib/supabase/database.types'
import { detectTraderType } from './helpers'
import { markOutliers, applyArenaFollowers } from './scoring-helpers'
import type { TraderRow } from './trader-row'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('compute-leaderboard')

export interface ScoredTrader {
  source: string
  source_trader_id: string
  /** Exchange/protocol snapshot time. Never substitute score computed_at. */
  source_as_of: string
  arena_score: number | null // NOW the v4 score (served + ranked); filled by the batch pass
  arena_score_v3: number | null // rollback: pre-v4 (ROI+PnL) score; also the serving-population gate
  arena_score_v4: number | null // = arena_score (labeled shadow, kept for continuity)
  score_factors: ArenaScoreV4Result['factors'] | null // v4 breakdown for the score UI
  roi: number
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  followers: number
  copiers: number | null
  trades_count: number | null
  handle: string | null
  avatar_url: string
  profitability_score: number // v4: 盈利维度(PnL+ROI 百分位),0-100,喂现有拆解 UI
  risk_control_score: number // v4: 风险维度(回撤+Sharpe 百分位),0-100
  execution_score: number | null // v4: 一致性百分位,0-100(缺则 null)
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
  supabase: SupabaseClient<Database>
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
      source_as_of: t.captured_at,
      arena_score: null as number | null, // v4 — filled by the batch pass below (SERVED + RANKED)
      arena_score_v3: finalScore, // rollback + serving-population gate (real ROI/PnL present)
      arena_score_v4: null as number | null, // = arena_score, filled below
      score_factors: null as ArenaScoreV4Result['factors'] | null,
      roi: t.roi ?? 0,
      pnl: t.pnl,
      win_rate: normalizedWinRate,
      max_drawdown: t.max_drawdown,
      followers: t.followers ?? 0,
      copiers: t.copiers ?? null,
      trades_count: t.trades_count,
      handle: displayHandle,
      avatar_url: canonicalizeLocalExchangeLogoPath(
        info.avatar_url || getExchangeLogoUrl(t.source)
      ),
      profitability_score: Math.round(scoreResult.returnScore * 100) / 100,
      risk_control_score: Math.round(scoreResult.pnlScore * 100) / 100,
      execution_score: null as number | null,
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

  // Mark outliers (uses roi/pnl, independent of the score)
  const outlierCount = markOutliers(scored)
  if (outlierCount > 0) {
    logger.info(
      `[${season}] Marked ${outlierCount} outliers (kept in leaderboard with is_outlier=true)`
    )
  }

  // Replace exchange followers with Arena internal follower counts
  const { applied, uniqueAccounts } = await applyArenaFollowers(supabase, scored, season)
  logger.info(
    `[${season}] Arena followers: ${applied} traders have followers (${uniqueAccounts} unique exchange accounts queried)`
  )

  // Served population = traders with a real (v3) score — the SAME quality gate as
  // pre-cutover (real ROI/PnL present). Only the score/rank VALUE changes to v4.
  const scoredFiltered = scored.filter((t) => t.arena_score_v3 != null)

  // ── Arena Score v4 — NOW THE FLAGSHIP ──
  // Batch percentile over the SERVED cohort (percentiles are relative to what
  // users actually see). Writes arena_score (served + ranked by the rerank RPC /
  // in-memory sort), arena_score_v4 (= arena_score, labeled), and score_factors
  // (UI breakdown). arena_score_v3 (set above) is the rollback value.
  const v4Results = computeArenaScoresV4(
    scoredFiltered.map((t) => ({
      roi: t.roi,
      pnl: t.pnl,
      maxDrawdown: t.max_drawdown,
      winRate: t.win_rate,
      sharpeRatio: t.sharpe_ratio,
      profitFactor: t.profit_factor,
      tradesCount: t.trades_count,
    })),
    season
  )
  scoredFiltered.forEach((t, i) => {
    const r = v4Results[i]
    t.arena_score = r ? r.totalScore : 0
    t.arena_score_v4 = t.arena_score
    t.score_factors = r ? r.factors : null
    // Repopulate the 3 existing breakdown sub-scores from v4 factors so the
    // radar/bars UI stays v4-consistent (0-100), no frontend plumbing change:
    //   盈利能力 = earnings(PnL 0.30 + ROI 0.20), 风控 = avg(回撤,Sharpe 百分位),
    //   执行力 = 一致性百分位.
    const f = r?.factors
    if (f) {
      t.profitability_score = Math.round((100 * (0.3 * f.pnl + 0.2 * f.roi)) / 0.5)
      const riskDims = [f.drawdown, f.sharpe].filter((v): v is number => v != null)
      t.risk_control_score = riskDims.length
        ? Math.round((100 * riskDims.reduce((a, b) => a + b, 0)) / riskDims.length)
        : 0
      t.execution_score = f.consistency != null ? Math.round(100 * f.consistency) : null
    }
  })

  logger.info(`[${season}] Arena Score v4 is now the flagship (${scoredFiltered.length} traders)`)
  return { scored, scoredFiltered }
}
