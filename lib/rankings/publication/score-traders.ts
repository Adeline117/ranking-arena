/**
 * Score traders — pure transformation from TraderRow[] to scored leaderboard entries.
 * Extracted from computeSeason to reduce route.ts by ~140 lines.
 */

import {
  calculateArenaScore,
  computeArenaScoresV4WithOptions,
  type Period,
  type ArenaScoreV4Options,
  type ArenaScoreV4Result,
} from '@/lib/utils/arena-score'
import { sanitizeDisplayName } from '@/lib/utils/profanity'
import { getExchangeLogoUrl } from '@/lib/utils/avatar'
import { canonicalizeLocalExchangeLogoPath } from '@/lib/utils/exchange-logo-path'
import { detectTraderType } from './helpers'
import { markOutliers, applyArenaFollowers, type ArenaFollowersClient } from './scoring-helpers'
import type { TraderRow } from './trader-row'
import { createLogger } from '@/lib/utils/logger'
import {
  hasConcretePublicRankingMetrics,
  PUBLIC_RANKING_ROW_ELIGIBILITY,
  type PublicRankingRowEligibility,
} from '@/lib/rankings/publication-policy'
import {
  isRankEligiblePnl,
  isRankEligibleRoi,
  normalizeRankDrawdown,
  normalizeRankProfitFactor,
  normalizeRankSharpe,
  normalizeRankTradesCount,
  normalizeRankWinRate,
} from '@/lib/rankings/metric-eligibility'

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

export interface ScoreTradersOptions {
  /** Defaults to PUBLIC_RANKING_ROW_ELIGIBILITY; explicit for tests and offline comparison. */
  rowEligibility?: PublicRankingRowEligibility
}

/**
 * Score semantics per writer eligibility. 'four_metrics' is the exact previous
 * behavior (legacy v4 options), so the rollback switch restores old scores.
 */
export function arenaScoreOptionsForRowEligibility(
  rowEligibility: PublicRankingRowEligibility
): ArenaScoreV4Options {
  return rowEligibility === 'roi_pnl'
    ? { zeroRiskMetricsAreKnown: true }
    : { zeroRiskMetricsAreKnown: false }
}

type RankEligibleTrader = TraderRow & { roi: number; pnl: number }

function hasRankEligibleMetrics(trader: TraderRow, season: Period): trader is RankEligibleTrader {
  return isRankEligibleRoi(trader.roi, season) && isRankEligiblePnl(trader.pnl, trader.source)
}

/**
 * Calculate arena scores for all traders and apply post-processing.
 * Returns scored + ranking-eligible arrays.
 */
export async function scoreTraders(
  uniqueTraders: TraderRow[],
  handleMap: Map<string, { handle: string | null; avatar_url: string | null }>,
  contractAddresses: Set<string>,
  season: Period,
  supabase: ArenaFollowersClient,
  options: ScoreTradersOptions = {}
): Promise<{ scored: ScoredTrader[]; scoredFiltered: ScoredTrader[] }> {
  const rowEligibility = options.rowEligibility ?? PUBLIC_RANKING_ROW_ELIGIBILITY
  // Defense in depth: callers other than the arena reader can still construct
  // TraderRows directly. ROI and PnL are both mandatory for ranking, so reject
  // missing, malformed-at-runtime, and non-finite values before either score
  // formula or the percentile cohort sees them. Finite zero/losses remain
  // eligible at this boundary; route-level product filters remain separate.
  const rankEligibleTraders = uniqueTraders.filter((trader): trader is RankEligibleTrader =>
    hasRankEligibleMetrics(trader, season)
  )
  const excludedForCoreMetrics = uniqueTraders.length - rankEligibleTraders.length
  if (excludedForCoreMetrics > 0) {
    logger.warn(
      `[${season}] Excluded ${excludedForCoreMetrics} trader(s) from scoring: ROI or PnL missing, malformed, non-finite, or out of bounds`
    )
  }

  const scored = rankEligibleTraders.map((t) => {
    const normalizedWinRate = normalizeRankWinRate(t.win_rate)
    const normalizedMaxDrawdown = normalizeRankDrawdown(t.max_drawdown)
    const normalizedSharpe = normalizeRankSharpe(t.sharpe_ratio)
    const normalizedProfitFactor = normalizeRankProfitFactor(t.profit_factor)
    const normalizedTradesCount = normalizeRankTradesCount(t.trades_count)

    const scoreResult = calculateArenaScore(
      {
        roi: t.roi,
        pnl: t.pnl,
        maxDrawdown: normalizedMaxDrawdown,
        winRate: normalizedWinRate,
      },
      season
    )

    // ROI + PnL completeness is enforced before scoring. Optional risk and
    // execution metrics remain represented separately by score_completeness.
    const estimationPenalty = t.metrics_estimated ? 0.92 : 1.0

    // Low trade count penalty: 1 trade → 0.64x, 10+ → 1.0x
    // trades_count=0 means "unknown" (API doesn't provide) — skip penalty (same as null)
    let tradeCountPenalty = 1.0
    if (normalizedTradesCount != null && normalizedTradesCount > 0 && normalizedTradesCount < 10) {
      tradeCountPenalty = 0.6 + 0.04 * normalizedTradesCount
    }

    const rawSubScores =
      scoreResult.returnScore +
      scoreResult.pnlScore +
      scoreResult.drawdownScore +
      scoreResult.stabilityScore
    const rawFinalScore =
      Math.round(
        Math.max(0, Math.min(100, rawSubScores * estimationPenalty * tradeCountPenalty)) * 100
      ) / 100
    // A legitimate zero score is still a computed score. Converting it to
    // null used to remove zero/losing traders from the v4 percentile cohort.
    const finalScore = rawFinalScore

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
      source_as_of: t.source_board_as_of,
      arena_score: null as number | null, // v4 — filled by the batch pass below (SERVED + RANKED)
      arena_score_v3: finalScore, // rollback + serving-population gate (real ROI/PnL present)
      arena_score_v4: null as number | null, // = arena_score, filled below
      score_factors: null as ArenaScoreV4Result['factors'] | null,
      roi: t.roi,
      pnl: t.pnl,
      win_rate: normalizedWinRate,
      max_drawdown: normalizedMaxDrawdown,
      followers: t.followers ?? 0,
      copiers: t.copiers ?? null,
      trades_count: normalizedTradesCount,
      handle: displayHandle,
      avatar_url: canonicalizeLocalExchangeLogoPath(
        info.avatar_url || getExchangeLogoUrl(t.source)
      ),
      profitability_score: Math.round(scoreResult.returnScore * 100) / 100,
      risk_control_score: Math.round(scoreResult.pnlScore * 100) / 100,
      execution_score: null as number | null,
      score_completeness: (normalizedMaxDrawdown != null && normalizedWinRate != null
        ? 'full'
        : normalizedMaxDrawdown != null || normalizedWinRate != null
          ? 'partial'
          : 'minimal') as 'full' | 'partial' | 'minimal',
      trading_style: t.trading_style,
      avg_holding_hours: t.avg_holding_hours,
      style_confidence: t.style_confidence,
      sharpe_ratio: normalizedSharpe,
      sortino_ratio: t.sortino_ratio ?? null,
      profit_factor: normalizedProfitFactor,
      calmar_ratio: t.calmar_ratio ?? null,
      trader_type: detectTraderType(
        t.source,
        t.source_trader_id,
        normalizedTradesCount,
        t.trader_type,
        t.avg_holding_hours,
        normalizedWinRate,
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

  // Only rows with a concrete, non-estimated metric basis participate in the
  // percentile cohort. Partial rows remain available in the upstream Arena
  // model for profiles, but cannot influence or enter the public ranking.
  const scoredFiltered = scored.filter(hasConcretePublicRankingMetrics)
  const excludedForTrust = scored.length - scoredFiltered.length
  if (excludedForTrust > 0) {
    logger.warn(
      `[${season}] Excluded ${excludedForTrust} trader(s) from ranking: partial, estimated, outlier, or untrusted metric basis`
    )
  }

  // ── Arena Score v4 — NOW THE FLAGSHIP ──
  // Batch percentile over the SERVED cohort (percentiles are relative to what
  // users actually see). Writes arena_score (served + ranked by the rerank RPC /
  // in-memory sort), arena_score_v4 (= arena_score, labeled), and score_factors
  // (UI breakdown). arena_score_v3 (set above) is the rollback value.
  const v4Results = computeArenaScoresV4WithOptions(
    scoredFiltered.map((t) => ({
      roi: t.roi,
      pnl: t.pnl,
      maxDrawdown: t.max_drawdown,
      winRate: t.win_rate,
      sharpeRatio: t.sharpe_ratio,
      profitFactor: t.profit_factor,
      tradesCount: t.trades_count,
      source: t.source,
    })),
    season,
    arenaScoreOptionsForRowEligibility(rowEligibility)
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

  const publishedCohort = scoredFiltered.filter(
    (trader) =>
      typeof trader.arena_score === 'number' &&
      Number.isFinite(trader.arena_score) &&
      trader.arena_score > 0 &&
      trader.arena_score <= 100
  )
  logger.info(`[${season}] Arena Score v4 is now the flagship (${publishedCohort.length} traders)`)
  return { scored, scoredFiltered: publishedCohort }
}
