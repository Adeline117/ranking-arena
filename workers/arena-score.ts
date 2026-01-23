/**
 * Arena Score calculation for the worker
 * Delegates to lib/utils/arena-score.ts to ensure consistency
 */

import type { Window } from '../connectors/base/types';
import {
  calculateArenaScore as libCalculateArenaScore,
  calculateDrawdownScore,
  calculateStabilityScore,
  calculateReturnScore,
  type Period,
  type TraderScoreInput,
} from '../lib/utils/arena-score';

/** Convert worker Window format ('7d') to lib Period format ('7D') */
function toPeriod(window: Window): Period {
  const map: Record<string, Period> = { '7d': '7D', '30d': '30D', '90d': '90D' };
  return map[window] || '90D';
}

export function calculateArenaScore(
  roi: number | null,
  pnl: number | null,
  maxDrawdown: number | null,
  winRate: number | null,
  window: Window,
): number | null {
  if (roi == null) return null;

  const period = toPeriod(window);

  const input: TraderScoreInput = {
    roi,
    pnl: pnl ?? 0,
    maxDrawdown,
    winRate,
  };

  const result = libCalculateArenaScore(input, period);
  return result.totalScore;
}

// Re-export for compatibility
export { calculateDrawdownScore, calculateStabilityScore, calculateReturnScore };
