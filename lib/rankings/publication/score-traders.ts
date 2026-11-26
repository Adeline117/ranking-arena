/**
 * Score traders — pure transformation from TraderRow[] to scored leaderboard entries.
 * Extracted from computeSeason to reduce route.ts by ~140 lines.
 */

import {
  calculateArenaScore,
  computeArenaScoresV4,
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
  publicRankingRowEligibility,
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
  score_factors: RankScoreFactors | null // v4 breakdown for the score UI
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
 * Smallest positive arena_score the numeric(10,2) column stores. Under
 * 'roi_pnl' it is the score of every idle-window row (see isIdleWindowRow).
 */
export const MIN_RANKED_ARENA_SCORE = 0.01

/**
 * Display-score floor of a row that HAS performance in the window ('roi_pnl').
 * One step above the idle score, so the lowest scored trader never shares a
 * score with the idle rows: the rerank breaks score ties by row id, and rows
 * already in the table keep their id, so a shared score could put an idle
 * account ahead of a trader who traded.
 */
export const MIN_ACTIVE_ARENA_SCORE = 0.02

/**
 * score_factors as written to leaderboard_ranks.score_factors (jsonb).
 * `idle_window: true` marks a row that was not scored on any dimension because
 * the account shows no performance in the window; the UI can say "no trading
 * in this period". Absent on every scored row.
 * `mdd_contradiction: true` marks a scored row whose reported drawdown was
 * refused (see hasContradictoryDrawdown): its max_drawdown is written empty
 * and the drawdown dimension scored nothing.
 * `mdd_zero_unverified: true` marks a scored row whose 0% drawdown was kept
 * and shown but scored neutrally (see hasUnverifiedZeroDrawdown).
 */
export type RankScoreFactors = ArenaScoreV4Result['factors'] & {
  idle_window?: true
  mdd_contradiction?: true
  mdd_zero_unverified?: true
}

/**
 * Contradictory drawdown ('roi_pnl' only): the window closed at a loss (ROI < 0
 * or PnL < 0) and the reported max drawdown is 0. A loss in the window implies
 * a drawdown, so a 0 is a placeholder or a different definition, not a
 * measurement. The value is refused like an out-of-range one: emptied, the
 * row kept, the dimension scored as missing, and the refusal recorded. It is
 * not replaced by anything derived.
 *
 * Every side is read at the precision the row is stored with (ROI
 * numeric(12,4), PnL numeric(18,2), max_drawdown numeric(5,2)), as for the
 * idle-window rule. An idle row has ROI 0 and PnL 0 and is never contradictory.
 */
export function hasContradictoryDrawdown(row: {
  roi: number
  pnl: number | null
  max_drawdown: number | null
}): boolean {
  if (row.max_drawdown === null || Math.round(row.max_drawdown * 1e2) !== 0) return false
  return Math.round(row.roi * 1e4) < 0 || (row.pnl !== null && Math.round(row.pnl * 1e2) < 0)
}

/**
 * Unverified zero drawdown ('roi_pnl' only): the drawdown is 0 at stored
 * precision (numeric(5,2)) and the win rate is unknown or below 100% at stored
 * precision (numeric(5,2)). Checked after hasContradictoryDrawdown, so a
 * losing window never gets here (its drawdown is already refused).
 *
 * Binance futures computes its window drawdown on the daily ROI curve, so an
 * account whose daily equity only rose reports 0 even with losing trades
 * inside a day. The 0 is the exchange's real value, not a placeholder and not
 * an error, but it does not show the account never lost: the value is kept,
 * written and shown as it is; only the score treats the drawdown dimension as
 * neutral (no factor, no weight). A 100% win rate with a 0 drawdown is
 * self-consistent and scored as a real value. An idle row is never scored and
 * never flagged.
 */
export function hasUnverifiedZeroDrawdown(row: {
  max_drawdown: number | null
  win_rate: number | null
}): boolean {
  if (row.max_drawdown === null || Math.round(row.max_drawdown * 1e2) !== 0) return false
  return row.win_rate === null || Math.round(row.win_rate * 1e2) < 10_000
}

/**
 * Idle window ('roi_pnl' only): ROI is 0 and PnL is 0. There is no performance
 * to rank, so the row takes no part in any dimension of the score (it is not
 * in the percentile cohort either) and gets the floor score. This is not
 * "0 read as missing": its win rate and drawdown are kept and shown as they
 * are, 0 included.
 *
 * "Is 0" is decided at the precision the row is stored and shown with:
 * leaderboard_ranks.roi is numeric(12,4) and pnl numeric(18,2). A row whose
 * ROI is 0.00003% and PnL $0.004 is written as 0.0000 / 0.00; treating it as
 * scored would leave a row that reads "ROI 0, PnL 0" ranked among the traders
 * who traded, indistinguishable in the table from the idle rows below it.
 */
export function isIdleWindowRow(row: { roi: number; pnl: number | null }): boolean {
  return row.pnl !== null && Math.round(row.roi * 1e4) === 0 && Math.round(row.pnl * 1e2) === 0
}

/**
 * Sign mismatch: ROI and PnL have opposite signs at the stored precision (one
 * positive, one negative). Counted per source in the publication log and
 * nothing else: the row is ranked and scored as it is. Rows the outlier rule
 * already excludes for a LARGE opposite-sign pair (markOutliers) never reach
 * the cohort and are not counted here.
 */
export function hasSignMismatch(row: { roi: number; pnl: number | null }): boolean {
  if (row.pnl === null) return false
  const roi = Math.round(row.roi * 1e4)
  const pnl = Math.round(row.pnl * 1e2)
  return (roi > 0 && pnl < 0) || (roi < 0 && pnl > 0)
}

const IDLE_WINDOW_SCORE_FACTORS: RankScoreFactors = Object.freeze({
  roi: 0,
  pnl: 0,
  drawdown: null,
  sharpe: null,
  consistency: null,
  idle_window: true,
})

export interface ScoreTradersOptions {
  /**
   * Defaults to the process switch (publicRankingRowEligibility(): 'four_metrics'
   * unless the environment turns 'roi_pnl' on). Explicit from the orchestrator,
   * tests and the offline comparison.
   */
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
    ? { zeroRiskMetricsAreKnown: true, missingRiskPolicy: 'zero', neutralDrawdownInputs: true }
    : { zeroRiskMetricsAreKnown: false, missingRiskPolicy: 'renormalize' }
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
  const rowEligibility = options.rowEligibility ?? publicRankingRowEligibility()
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

  // A win rate outside 0..100 or a drawdown outside [0, 100) is not a
  // measurement. The metric is emptied, the row stays; count it so an upstream
  // regression is visible in the publication log.
  let winRateNulled = 0
  let maxDrawdownNulled = 0
  // Rows whose reported 0% drawdown contradicts a losing window ('roi_pnl').
  const contradictoryDrawdownKeys = new Set<string>()
  const scored = rankEligibleTraders.map((t) => {
    const normalizedWinRate = normalizeRankWinRate(t.win_rate)
    let normalizedMaxDrawdown = normalizeRankDrawdown(t.max_drawdown)
    if (t.win_rate != null && normalizedWinRate === null) winRateNulled += 1
    if (t.max_drawdown != null && normalizedMaxDrawdown === null) maxDrawdownNulled += 1
    if (
      rowEligibility === 'roi_pnl' &&
      hasContradictoryDrawdown({ roi: t.roi, pnl: t.pnl, max_drawdown: normalizedMaxDrawdown })
    ) {
      normalizedMaxDrawdown = null
      contradictoryDrawdownKeys.add(`${t.source}\u0000${t.source_trader_id}`)
    }
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
      score_factors: null as RankScoreFactors | null,
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

  if (winRateNulled > 0 || maxDrawdownNulled > 0) {
    logger.warn(
      `[${season}] Emptied out-of-range risk metrics (row kept): win_rate=${winRateNulled}, max_drawdown=${maxDrawdownNulled}`
    )
  }

  if (contradictoryDrawdownKeys.size > 0) {
    logger.warn(
      `[${season}] Refused contradictory drawdowns (ROI < 0 or PnL < 0 with a 0% max drawdown; metric emptied, row kept): ${contradictoryDrawdownKeys.size}`
    )
  }

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

  // Only rows with a concrete, non-estimated ROI + PnL basis participate in
  // the percentile cohort. 'roi_pnl': a row without a win rate or drawdown is
  // ranked with that metric empty. 'four_metrics': such rows are left out.
  const requireWinRateAndDrawdown = rowEligibility === 'four_metrics'
  const scoredFiltered = scored.filter((trader) =>
    hasConcretePublicRankingMetrics(trader, { requireWinRateAndDrawdown })
  )
  const excludedForTrust = scored.length - scoredFiltered.length
  if (excludedForTrust > 0) {
    logger.warn(
      `[${season}] Excluded ${excludedForTrust} trader(s) from ranking: ${
        requireWinRateAndDrawdown ? 'partial, ' : ''
      }estimated, outlier, or untrusted metric basis`
    )
  }
  const completeness = { full: 0, partial: 0, minimal: 0 }
  for (const trader of scoredFiltered) completeness[trader.score_completeness] += 1
  logger.info(
    `[${season}] Ranking cohort completeness (${rowEligibility}): full=${completeness.full}, partial=${completeness.partial}, minimal=${completeness.minimal}`
  )

  // ── Arena Score v4 — NOW THE FLAGSHIP ──
  // Batch percentile over the SERVED cohort (percentiles are relative to what
  // users actually see). Writes arena_score (served + ranked by the rerank RPC /
  // in-memory sort), arena_score_v4 (= arena_score, labeled), and score_factors
  // (UI breakdown). arena_score_v3 (set above) is the rollback value.
  // 'roi_pnl': idle-window rows are set aside before the batch pass. They do
  // not shape anyone's percentile and are not scored on any dimension.
  const idleRows =
    rowEligibility === 'roi_pnl' ? scoredFiltered.filter((trader) => isIdleWindowRow(trader)) : []
  const idleSet = new Set(idleRows)
  const scoredRows =
    idleSet.size > 0 ? scoredFiltered.filter((t) => !idleSet.has(t)) : scoredFiltered
  // 'roi_pnl': a 0% drawdown that a win rate below 100% (or unknown) does not
  // corroborate is scored neutrally. Contradictory drawdowns were emptied above
  // and never match (max_drawdown is null).
  const neutralDrawdownRows = new Set(
    rowEligibility === 'roi_pnl' ? scoredRows.filter((t) => hasUnverifiedZeroDrawdown(t)) : []
  )
  const v4Inputs = scoredRows.map((t) => ({
    roi: t.roi,
    pnl: t.pnl,
    maxDrawdown: t.max_drawdown,
    winRate: t.win_rate,
    sharpeRatio: t.sharpe_ratio,
    profitFactor: t.profit_factor,
    tradesCount: t.trades_count,
    source: t.source,
    ...(neutralDrawdownRows.has(t) ? { maxDrawdownNeutral: true } : {}),
  }))
  // 'four_metrics' calls the signed historical contract itself, the same call
  // this module made before the switch existed.
  const v4Results =
    rowEligibility === 'four_metrics'
      ? computeArenaScoresV4(v4Inputs, season)
      : computeArenaScoresV4WithOptions(
          v4Inputs,
          season,
          arenaScoreOptionsForRowEligibility(rowEligibility)
        )
  scoredRows.forEach((t, i) => {
    const r = v4Results[i]
    // 'roi_pnl': the lowest composite of a cohort maps to a display score of
    // 0.00 (percentile 0), which the (0, 100] score domain reads as "not
    // scored". Floor a computed score so the last trader is still ranked, and
    // ranked above the idle rows (MIN_ACTIVE_ARENA_SCORE). The domain and every
    // `> 0` gate stay as they are; a row without a result keeps 0 and is dropped.
    t.arena_score = r
      ? rowEligibility === 'roi_pnl'
        ? Math.max(MIN_ACTIVE_ARENA_SCORE, r.totalScore)
        : r.totalScore
      : 0
    t.arena_score_v4 = t.arena_score
    t.score_factors = r
      ? contradictoryDrawdownKeys.has(`${t.source}\u0000${t.source_trader_id}`)
        ? { ...r.factors, mdd_contradiction: true }
        : neutralDrawdownRows.has(t)
          ? { ...r.factors, mdd_zero_unverified: true }
          : r.factors
      : null
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
  for (const t of idleRows) {
    t.arena_score = MIN_RANKED_ARENA_SCORE
    t.arena_score_v4 = MIN_RANKED_ARENA_SCORE
    t.score_factors = { ...IDLE_WINDOW_SCORE_FACTORS }
    t.profitability_score = 0
    t.risk_control_score = 0
    t.execution_score = null
  }
  if (rowEligibility === 'roi_pnl') {
    logger.info(
      `[${season}] Idle-window rows (ROI 0 and PnL 0, not scored, score ${MIN_RANKED_ARENA_SCORE}): ${idleRows.length} of ${scoredFiltered.length}`
    )
  }
  if (rowEligibility === 'roi_pnl' && neutralDrawdownRows.size > 0) {
    const neutralBySource: Record<string, number> = {}
    for (const t of neutralDrawdownRows) {
      neutralBySource[t.source] = (neutralBySource[t.source] ?? 0) + 1
    }
    const bySource = Object.fromEntries(
      Object.entries(neutralBySource).sort(([left], [right]) => (left < right ? -1 : 1))
    )
    logger.info(
      `[${season}] mdd_zero_unverified (0% drawdown with a win rate below 100% or unknown; value kept, drawdown scored neutrally): ${neutralDrawdownRows.size} ${JSON.stringify(bySource)}`
    )
  }
  if (rowEligibility === 'roi_pnl') {
    // Counted for the record only; ranking and scoring are unchanged.
    const signMismatchBySource: Record<string, number> = {}
    let signMismatch = 0
    for (const t of scoredFiltered) {
      if (!hasSignMismatch(t)) continue
      signMismatch += 1
      signMismatchBySource[t.source] = (signMismatchBySource[t.source] ?? 0) + 1
    }
    if (signMismatch > 0) {
      const bySource = Object.fromEntries(
        Object.entries(signMismatchBySource).sort(([left], [right]) => (left < right ? -1 : 1))
      )
      logger.warn(
        `[${season}] sign_mismatch (ROI and PnL have opposite signs; counted only, rows ranked unchanged): ${signMismatch} ${JSON.stringify(bySource)}`
      )
    }
  }

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
