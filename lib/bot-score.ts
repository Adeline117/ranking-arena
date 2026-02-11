/**
 * Bot Arena Score Calculation
 *
 * Weighted composite score for Web3 bots/agents/vaults:
 *   Volume Score    (25%): Trading volume percentile rank
 *   Performance     (30%): ROI/APY percentile rank
 *   Risk Score      (20%): Drawdown control + Sharpe
 *   Adoption Score  (15%): Users + TVL
 *   Longevity Score (10%): Operating time + stability
 */

export interface BotSnapshot {
  bot_id: string
  total_volume: number | null
  unique_users: number | null
  tvl: number | null
  apy: number | null
  roi: number | null
  max_drawdown: number | null
  sharpe_ratio: number | null
  launch_date: string | null // ISO date
  token_price: number | null
  market_cap: number | null
  mindshare_score: number | null
}

export interface BotScoreBreakdown {
  arena_score: number
  volume_score: number
  performance_score: number
  risk_score: number
  adoption_score: number
  longevity_score: number
}

const WEIGHTS = {
  volume: 0.25,
  performance: 0.30,
  risk: 0.20,
  adoption: 0.15,
  longevity: 0.10,
}

/** Compute percentile rank (0-100) for a value in a sorted ascending array */
function percentileRank(value: number, allValues: number[]): number {
  if (allValues.length === 0) return 50
  const below = allValues.filter(v => v < value).length
  return (below / allValues.length) * 100
}

/** Clamp value between 0 and 100 */
function clamp(v: number): number {
  return Math.max(0, Math.min(100, v))
}

/**
 * Calculate Arena Scores for a batch of bot snapshots.
 * Scores are relative (percentile-based) so the full set is needed.
 */
export function calculateBotScores(
  snapshots: BotSnapshot[]
): Map<string, BotScoreBreakdown> {
  const results = new Map<string, BotScoreBreakdown>()
  if (snapshots.length === 0) return results

  // Collect arrays for percentile calculations
  const volumes = snapshots.map(s => s.total_volume ?? 0).sort((a, b) => a - b)
  const users = snapshots.map(s => s.unique_users ?? 0).sort((a, b) => a - b)
  const tvls = snapshots.map(s => s.tvl ?? 0).sort((a, b) => a - b)
  const rois = snapshots.map(s => s.roi ?? s.apy ?? 0).sort((a, b) => a - b)

  const now = Date.now()

  for (const snap of snapshots) {
    // Volume Score (25%)
    const volumeScore = percentileRank(snap.total_volume ?? 0, volumes)

    // Performance Score (30%): use ROI if available, else APY
    const perfValue = snap.roi ?? snap.apy ?? 0
    const performanceScore = percentileRank(perfValue, rois)

    // Risk Score (20%): lower drawdown = better, higher sharpe = better
    let riskScore = 50 // default
    if (snap.max_drawdown != null) {
      // Drawdown: 0% = perfect (100), 50%+ = terrible (0)
      riskScore = clamp(100 - (snap.max_drawdown * 2))
    }
    if (snap.sharpe_ratio != null) {
      // Sharpe: 0 = 0, 1 = 50, 2+ = 100
      const sharpeScore = clamp(snap.sharpe_ratio * 50)
      riskScore = snap.max_drawdown != null
        ? riskScore * 0.6 + sharpeScore * 0.4
        : sharpeScore
    }

    // Adoption Score (15%): users + TVL
    const userScore = percentileRank(snap.unique_users ?? 0, users)
    const tvlScore = percentileRank(snap.tvl ?? 0, tvls)
    const adoptionScore = (userScore * 0.5 + tvlScore * 0.5)

    // Longevity Score (10%): months since launch
    let longevityScore = 30 // default
    if (snap.launch_date) {
      const months = (now - new Date(snap.launch_date).getTime()) / (30 * 24 * 60 * 60 * 1000)
      // 0 months = 10, 6 months = 40, 12+ months = 70, 24+ months = 90
      longevityScore = clamp(10 + months * 3.5)
    }

    const arena_score = Math.round(
      (WEIGHTS.volume * volumeScore +
       WEIGHTS.performance * performanceScore +
       WEIGHTS.risk * riskScore +
       WEIGHTS.adoption * adoptionScore +
       WEIGHTS.longevity * longevityScore) * 10
    ) / 10

    results.set(snap.bot_id, {
      arena_score: clamp(arena_score),
      volume_score: Math.round(volumeScore * 10) / 10,
      performance_score: Math.round(performanceScore * 10) / 10,
      risk_score: Math.round(riskScore * 10) / 10,
      adoption_score: Math.round(adoptionScore * 10) / 10,
      longevity_score: Math.round(longevityScore * 10) / 10,
    })
  }

  return results
}
