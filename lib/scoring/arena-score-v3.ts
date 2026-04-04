/**
 * @deprecated NOT used in production pipeline. Production uses lib/utils/arena-score.ts (tanh-based).
 * This V3 percentile-rank system was prototyped for peer-relative scoring but never integrated.
 * Only referenced by lib/harness/pipeline-evaluator.ts for health checks.
 * DO NOT use for leaderboard computation — that uses lib/utils/arena-score.ts.
 *
 * Arena Score V3 — Three-Dimension Weighted Scoring System
 *
 * Dimensions:
 *   收益能力 (Profitability)  35%: ROI(20%) + Alpha(15%)
 *   风险控制 (Risk Control)   40%: MaxDrawdown(20%) + Sortino(10%) + Calmar(10%)
 *   执行质量 (Execution)      25%: WinRate(15%) + ProfitLossRatio(10%)
 *
 * Normalization: percentile ranking (0-100 within peer group)
 * Time windows: 7D×0.20 + 30D×0.45 + 90D×0.35
 *
 * Data completeness levels:
 *   full:         has ROI + drawdown + winRate → normal scoring
 *   partial:      missing Sortino/Calmar → -5 penalty, redistribute weights
 *   minimal:      only ROI → -15 penalty, cap at 60
 *   insufficient: no ROI → no score
 */

// ============================================
// Types
// ============================================

export type DataCompleteness = 'full' | 'partial' | 'minimal' | 'insufficient'

export interface ArenaScoreV3Input {
  roi: number | null
  alpha: number | null
  max_drawdown: number | null  // negative percentage, e.g. -25
  sortino_ratio: number | null
  calmar_ratio: number | null
  win_rate: number | null      // 0-100 or 0-1 (auto-detected)
  profit_factor: number | null // gross_profit / gross_loss
}

export interface ArenaScoreV3Result {
  total: number                // 0-100
  profitability: number        // 0-35
  risk_control: number         // 0-40
  execution: number            // 0-25
  completeness: DataCompleteness
  penalty: number              // points deducted
  components: {
    roi_score: number          // 0-20
    alpha_score: number        // 0-15
    drawdown_score: number     // 0-20
    sortino_score: number      // 0-10
    calmar_score: number       // 0-10
    winrate_score: number      // 0-15
    plr_score: number          // 0-10
  }
}

export interface PercentileContext {
  /** Sorted ascending arrays of peer values for percentile computation */
  roi_values: number[]
  alpha_values: number[]
  drawdown_values: number[]    // absolute values, lower = better
  sortino_values: number[]
  calmar_values: number[]
  winrate_values: number[]
  plr_values: number[]
}

export interface MultiWindowInput {
  '7D'?: { input: ArenaScoreV3Input; peers: PercentileContext }
  '30D'?: { input: ArenaScoreV3Input; peers: PercentileContext }
  '90D'?: { input: ArenaScoreV3Input; peers: PercentileContext }
}

// ============================================
// Constants
// ============================================

const WEIGHTS = {
  profitability: {
    roi: 20,
    alpha: 15,
  },
  risk_control: {
    max_drawdown: 20,
    sortino: 10,
    calmar: 10,
  },
  execution: {
    win_rate: 15,
    profit_loss_ratio: 10,
  },
} as const

const TIME_WEIGHTS: Record<string, number> = {
  '7D': 0.20,
  '30D': 0.45,
  '90D': 0.35,
}

// ============================================
// Helpers
// ============================================

const clip = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
const round2 = (v: number) => Math.round(v * 100) / 100

/**
 * Compute percentile rank (0-100) of `value` within a sorted ascending array.
 * Uses linear interpolation for ties.
 */
export function percentileRank(sortedValues: number[], value: number): number {
  const n = sortedValues.length
  if (n === 0) return 50 // no peers → neutral
  if (n === 1) return value >= sortedValues[0] ? 75 : 25

  let below = 0
  let equal = 0
  for (const v of sortedValues) {
    if (v < value) below++
    else if (v === value) equal++
  }
  // Percentile = (below + 0.5 * equal) / n * 100
  return clip(((below + 0.5 * equal) / n) * 100, 0, 100)
}

/**
 * Inverted percentile: lower values are better (e.g., drawdown).
 */
function invertedPercentileRank(sortedValues: number[], value: number): number {
  return 100 - percentileRank(sortedValues, value)
}

/**
 * Normalize win rate to 0-100 range.
 */
function normalizeWinRate(wr: number | null): number | null {
  if (wr == null) return null
  return wr <= 1 ? wr * 100 : wr
}

// ============================================
// Data Completeness Detection
// ============================================

export function detectCompleteness(input: ArenaScoreV3Input): DataCompleteness {
  if (input.roi == null) return 'insufficient'

  const hasDrawdown = input.max_drawdown != null
  const hasWinRate = input.win_rate != null

  if (!hasDrawdown && !hasWinRate) return 'minimal'

  const hasSortino = input.sortino_ratio != null
  const hasCalmar = input.calmar_ratio != null

  if (hasDrawdown && hasWinRate && hasSortino && hasCalmar) return 'full'
  if (hasDrawdown || hasWinRate) return 'partial'

  return 'minimal'
}

// ============================================
// Single Window Score
// ============================================

export function calculateArenaScoreV3(
  input: ArenaScoreV3Input,
  peers: PercentileContext
): ArenaScoreV3Result {
  const completeness = detectCompleteness(input)

  // Insufficient → no score
  if (completeness === 'insufficient') {
    return {
      total: 0,
      profitability: 0,
      risk_control: 0,
      execution: 0,
      completeness,
      penalty: 0,
      components: {
        roi_score: 0, alpha_score: 0, drawdown_score: 0,
        sortino_score: 0, calmar_score: 0, winrate_score: 0, plr_score: 0,
      },
    }
  }

  const wr = normalizeWinRate(input.win_rate)

  // --- Profitability (35) ---
  const roiPctl = percentileRank(peers.roi_values, input.roi!)
  const roi_score = (roiPctl / 100) * WEIGHTS.profitability.roi

  let alpha_score = 0
  if (input.alpha != null) {
    const alphaPctl = percentileRank(peers.alpha_values, input.alpha)
    alpha_score = (alphaPctl / 100) * WEIGHTS.profitability.alpha
  }

  // --- Risk Control (40) ---
  let drawdown_score = 0
  if (input.max_drawdown != null) {
    const absMdd = Math.abs(input.max_drawdown)
    const mddPctl = invertedPercentileRank(peers.drawdown_values, absMdd)
    drawdown_score = (mddPctl / 100) * WEIGHTS.risk_control.max_drawdown
  }

  let sortino_score = 0
  if (input.sortino_ratio != null) {
    const sortinoPctl = percentileRank(peers.sortino_values, input.sortino_ratio)
    sortino_score = (sortinoPctl / 100) * WEIGHTS.risk_control.sortino
  }

  let calmar_score = 0
  if (input.calmar_ratio != null) {
    const calmarPctl = percentileRank(peers.calmar_values, input.calmar_ratio)
    calmar_score = (calmarPctl / 100) * WEIGHTS.risk_control.calmar
  }

  // --- Execution (25) ---
  let winrate_score = 0
  if (wr != null) {
    const wrPctl = percentileRank(peers.winrate_values, wr)
    winrate_score = (wrPctl / 100) * WEIGHTS.execution.win_rate
  }

  let plr_score = 0
  if (input.profit_factor != null) {
    const plrPctl = percentileRank(peers.plr_values, input.profit_factor)
    plr_score = (plrPctl / 100) * WEIGHTS.execution.profit_loss_ratio
  }

  // --- Weight redistribution for missing metrics ---
  let profitability = roi_score + alpha_score
  let risk_control = drawdown_score + sortino_score + calmar_score
  let execution = winrate_score + plr_score

  // Redistribute within dimensions when sub-metrics are missing
  if (completeness === 'partial' || completeness === 'full') {
    // Risk control: redistribute missing sortino/calmar weight to drawdown
    const riskAvailable = [
      input.max_drawdown != null ? WEIGHTS.risk_control.max_drawdown : 0,
      input.sortino_ratio != null ? WEIGHTS.risk_control.sortino : 0,
      input.calmar_ratio != null ? WEIGHTS.risk_control.calmar : 0,
    ]
    const riskUsed = riskAvailable.reduce((a, b) => a + b, 0)
    if (riskUsed > 0 && riskUsed < 40) {
      const riskRaw = drawdown_score + sortino_score + calmar_score
      risk_control = (riskRaw / riskUsed) * 40
    }

    // Profitability: redistribute if alpha missing
    if (input.alpha == null && input.roi != null) {
      profitability = (roi_score / WEIGHTS.profitability.roi) * 35
    }

    // Execution: redistribute if profit_factor missing
    const execAvailable = [
      wr != null ? WEIGHTS.execution.win_rate : 0,
      input.profit_factor != null ? WEIGHTS.execution.profit_loss_ratio : 0,
    ]
    const execUsed = execAvailable.reduce((a, b) => a + b, 0)
    if (execUsed > 0 && execUsed < 25) {
      const execRaw = winrate_score + plr_score
      execution = (execRaw / execUsed) * 25
    }
  }

  // Minimal: only ROI available → scale up but cap
  if (completeness === 'minimal') {
    profitability = (roi_score / WEIGHTS.profitability.roi) * 35
    risk_control = 20 // neutral 50th percentile equivalent for 40
    execution = 12.5  // neutral for 25
  }

  // --- Penalty ---
  let penalty = 0
  if (completeness === 'partial') penalty = 5
  if (completeness === 'minimal') penalty = 15

  let total = profitability + risk_control + execution - penalty

  // Cap for minimal
  if (completeness === 'minimal') total = Math.min(total, 60)

  total = clip(round2(total), 0, 100)

  return {
    total,
    profitability: round2(clip(profitability, 0, 35)),
    risk_control: round2(clip(risk_control, 0, 40)),
    execution: round2(clip(execution, 0, 25)),
    completeness,
    penalty,
    components: {
      roi_score: round2(roi_score),
      alpha_score: round2(alpha_score),
      drawdown_score: round2(drawdown_score),
      sortino_score: round2(sortino_score),
      calmar_score: round2(calmar_score),
      winrate_score: round2(winrate_score),
      plr_score: round2(plr_score),
    },
  }
}

// ============================================
// Multi-Window Weighted Score
// ============================================

export function calculateMultiWindowScore(
  windows: MultiWindowInput
): { total: number; completeness: DataCompleteness; byWindow: Record<string, ArenaScoreV3Result> } {
  const byWindow: Record<string, ArenaScoreV3Result> = {}
  let weightedTotal = 0
  let totalWeight = 0
  let worstCompleteness: DataCompleteness = 'full'
  const completenessOrder: DataCompleteness[] = ['full', 'partial', 'minimal', 'insufficient']

  for (const [window, data] of Object.entries(windows)) {
    if (!data) continue
    const result = calculateArenaScoreV3(data.input, data.peers)
    byWindow[window] = result

    if (result.completeness === 'insufficient') continue

    const w = TIME_WEIGHTS[window] || 0
    weightedTotal += result.total * w
    totalWeight += w

    if (completenessOrder.indexOf(result.completeness) > completenessOrder.indexOf(worstCompleteness)) {
      worstCompleteness = result.completeness
    }
  }

  const _total = totalWeight > 0 ? round2(clip(weightedTotal / totalWeight * totalWeight, 0, 100)) : 0
  // Normalize if not all windows present
  const finalTotal = totalWeight > 0 && totalWeight < 1
    ? round2(clip(weightedTotal / totalWeight, 0, 100))
    : round2(clip(weightedTotal, 0, 100))

  return { total: finalTotal, completeness: worstCompleteness, byWindow }
}

// ============================================
// Convenience: build peer context from DB arrays
// ============================================

export function buildPeerContext(
  peers: Array<{
    roi: number | null
    alpha: number | null
    max_drawdown: number | null
    sortino_ratio: number | null
    calmar_ratio: number | null
    win_rate: number | null
    profit_factor: number | null
  }>
): PercentileContext {
  const collect = (fn: (p: typeof peers[0]) => number | null | undefined) =>
    peers.map(fn).filter((v): v is number => v != null).sort((a, b) => a - b)

  return {
    roi_values: collect(p => p.roi),
    alpha_values: collect(p => p.alpha),
    drawdown_values: collect(p => p.max_drawdown != null ? Math.abs(p.max_drawdown) : null),
    sortino_values: collect(p => p.sortino_ratio),
    calmar_values: collect(p => p.calmar_ratio),
    winrate_values: collect(p => {
      if (p.win_rate == null) return null
      return p.win_rate <= 1 ? p.win_rate * 100 : p.win_rate
    }),
    plr_values: collect(p => p.profit_factor),
  }
}
