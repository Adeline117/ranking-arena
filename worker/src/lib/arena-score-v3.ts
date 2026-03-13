/**
 * Arena Score V3 for Worker
 * Standalone version without path aliases — used by fetchers and job-runner.
 *
 * Formula:
 *   收益能力 35%: ROI(20%) + Alpha(15%)
 *   风险控制 40%: MaxDrawdown(20%) + Sortino(10%) + Calmar(10%)
 *   执行质量 25%: WinRate(15%) + ProfitLossRatio(10%)
 *
 * Uses percentile ranking for normalization.
 * Time windows: 7D×0.20 + 30D×0.45 + 90D×0.35
 */

export type DataCompleteness = 'full' | 'partial' | 'minimal' | 'insufficient'

export interface ScoreV3Input {
  roi: number | null
  alpha: number | null
  max_drawdown: number | null
  sortino_ratio: number | null
  calmar_ratio: number | null
  win_rate: number | null       // 0-100
  profit_factor: number | null
}

export interface ScoreV3Result {
  total: number
  profitability: number
  risk_control: number
  execution: number
  completeness: DataCompleteness
  penalty: number
}

const clip = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
const round2 = (v: number) => Math.round(v * 100) / 100

/**
 * Percentile rank of value within sorted ascending array. Returns 0-100.
 */
export function percentileRank(sorted: number[], value: number): number {
  const n = sorted.length
  if (n === 0) return 50
  if (n === 1) return value >= sorted[0] ? 75 : 25
  let below = 0, equal = 0
  for (const v of sorted) {
    if (v < value) below++
    else if (v === value) equal++
  }
  return clip(((below + 0.5 * equal) / n) * 100, 0, 100)
}

export function detectCompleteness(input: ScoreV3Input): DataCompleteness {
  if (input.roi == null) return 'insufficient'
  const hasMdd = input.max_drawdown != null
  const hasWr = input.win_rate != null
  if (!hasMdd && !hasWr) return 'minimal'
  const hasSortino = input.sortino_ratio != null
  const hasCalmar = input.calmar_ratio != null
  if (hasMdd && hasWr && hasSortino && hasCalmar) return 'full'
  if (hasMdd || hasWr) return 'partial'
  return 'minimal'
}

export interface PeerArrays {
  roi: number[]
  alpha: number[]
  drawdown: number[]   // absolute, sorted asc
  sortino: number[]
  calmar: number[]
  winrate: number[]
  plr: number[]
}

/**
 * Calculate Arena Score V3 for a single time window.
 */
export function calcScoreV3(input: ScoreV3Input, peers: PeerArrays): ScoreV3Result {
  const completeness = detectCompleteness(input)

  if (completeness === 'insufficient') {
    return { total: 0, profitability: 0, risk_control: 0, execution: 0, completeness, penalty: 0 }
  }

  const wr = input.win_rate != null ? (input.win_rate <= 1 ? input.win_rate * 100 : input.win_rate) : null

  // Profitability
  const roiPctl = percentileRank(peers.roi, input.roi!)
  let roi_s = (roiPctl / 100) * 20
  let alpha_s = 0
  if (input.alpha != null) alpha_s = (percentileRank(peers.alpha, input.alpha) / 100) * 15

  // Risk Control
  let mdd_s = 0
  if (input.max_drawdown != null) {
    const mddPctl = 100 - percentileRank(peers.drawdown, Math.abs(input.max_drawdown))
    mdd_s = (mddPctl / 100) * 20
  }
  let sortino_s = 0
  if (input.sortino_ratio != null) sortino_s = (percentileRank(peers.sortino, input.sortino_ratio) / 100) * 10
  let calmar_s = 0
  if (input.calmar_ratio != null) calmar_s = (percentileRank(peers.calmar, input.calmar_ratio) / 100) * 10

  // Execution
  let wr_s = 0
  if (wr != null) wr_s = (percentileRank(peers.winrate, wr) / 100) * 15
  let plr_s = 0
  if (input.profit_factor != null) plr_s = (percentileRank(peers.plr, input.profit_factor) / 100) * 10

  // Redistribute within dimensions
  let profitability = roi_s + alpha_s
  let risk_control = mdd_s + sortino_s + calmar_s
  let execution = wr_s + plr_s

  if (completeness !== 'minimal') {
    // Profitability redistribution
    if (input.alpha == null) profitability = (roi_s / 20) * 35

    // Risk redistribution
    const riskUsed = (input.max_drawdown != null ? 20 : 0) + (input.sortino_ratio != null ? 10 : 0) + (input.calmar_ratio != null ? 10 : 0)
    if (riskUsed > 0 && riskUsed < 40) risk_control = ((mdd_s + sortino_s + calmar_s) / riskUsed) * 40

    // Execution redistribution
    const execUsed = (wr != null ? 15 : 0) + (input.profit_factor != null ? 10 : 0)
    if (execUsed > 0 && execUsed < 25) execution = ((wr_s + plr_s) / execUsed) * 25
  } else {
    // Minimal: only ROI
    profitability = (roi_s / 20) * 35
    risk_control = 20  // neutral
    execution = 12.5   // neutral
  }

  let penalty = completeness === 'partial' ? 5 : completeness === 'minimal' ? 15 : 0
  let total = profitability + risk_control + execution - penalty
  if (completeness === 'minimal') total = Math.min(total, 60)
  total = clip(round2(total), 0, 100)

  return {
    total,
    profitability: round2(clip(profitability, 0, 35)),
    risk_control: round2(clip(risk_control, 0, 40)),
    execution: round2(clip(execution, 0, 25)),
    completeness,
    penalty,
  }
}

/**
 * Multi-window weighted score: 7D×0.20 + 30D×0.45 + 90D×0.35
 */
export function calcMultiWindowScoreV3(
  windows: Record<string, { input: ScoreV3Input; peers: PeerArrays }>
): { total: number; completeness: DataCompleteness } {
  const TIME_W: Record<string, number> = { '7D': 0.20, '30D': 0.45, '90D': 0.35 }
  let weightedSum = 0
  let totalW = 0
  let worst: DataCompleteness = 'full'
  const order: DataCompleteness[] = ['full', 'partial', 'minimal', 'insufficient']

  for (const [w, data] of Object.entries(windows)) {
    const r = calcScoreV3(data.input, data.peers)
    if (r.completeness === 'insufficient') continue
    const tw = TIME_W[w] || 0
    weightedSum += r.total * tw
    totalW += tw
    if (order.indexOf(r.completeness) > order.indexOf(worst)) worst = r.completeness
  }

  const total = totalW > 0 ? round2(clip(weightedSum / totalW, 0, 100)) : 0
  return { total, completeness: worst }
}
