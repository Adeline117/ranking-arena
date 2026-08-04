/**
 * Compatibility adapter for legacy callers that use lowercase score windows
 * and positional nullable inputs.
 */

import {
  calculateArenaScore as calculateCanonicalArenaScore,
  calculateDrawdownScore,
  calculateReturnScore,
  calculateStabilityScore,
  type Period,
  type TraderScoreInput,
} from './arena-score'

export type LegacyArenaScoreWindow = '7d' | '30d' | '90d'

/** Convert the legacy lowercase window format to the canonical period format. */
function toPeriod(window: LegacyArenaScoreWindow): Period {
  const map: Record<string, Period> = { '7d': '7D', '30d': '30D', '90d': '90D' }
  return map[window] || '90D'
}

export function calculateArenaScore(
  roi: number | null,
  pnl: number | null,
  maxDrawdown: number | null,
  winRate: number | null,
  window: LegacyArenaScoreWindow
): number | null {
  if (roi == null) return null

  const period = toPeriod(window)

  const input: TraderScoreInput = {
    roi,
    pnl: pnl ?? 0,
    maxDrawdown,
    winRate,
  }

  const result = calculateCanonicalArenaScore(input, period)
  return result.totalScore
}

export { calculateDrawdownScore, calculateReturnScore, calculateStabilityScore }
