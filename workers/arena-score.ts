/**
 * Arena Score calculation for the worker
 * Mirrors lib/utils/arena-score.ts logic
 */

import type { Window } from '../connectors/base/types';

const ARENA_CONFIG = {
  PNL_THRESHOLD: { '7d': 300, '30d': 1000, '90d': 3000 } as Record<Window, number>,
  PARAMS: {
    '7d': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
    '30d': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
    '90d': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
  } as Record<Window, { tanhCoeff: number; roiExponent: number; mddThreshold: number; winRateCap: number }>,
  MAX_RETURN_SCORE: 85,
  MAX_DRAWDOWN_SCORE: 8,
  MAX_STABILITY_SCORE: 7,
};

const clip = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const safeLog1p = (x: number) => x <= -1 ? 0 : Math.log(1 + x);
const getPeriodDays = (p: Window) => p === '7d' ? 7 : p === '30d' ? 30 : 90;

export function calculateArenaScore(
  roi: number | null,
  pnl: number | null,
  maxDrawdown: number | null,
  winRate: number | null,
  window: Window,
): number | null {
  if (roi == null) return null;

  const params = ARENA_CONFIG.PARAMS[window] || ARENA_CONFIG.PARAMS['90d'];
  const days = getPeriodDays(window);

  // Normalize win rate to percentage
  const wr = winRate != null
    ? (winRate <= 1 ? winRate * 100 : winRate)
    : null;

  // Return score (0-85)
  const intensity = (365 / days) * safeLog1p(roi / 100);
  const r0 = Math.tanh(params.tanhCoeff * intensity);
  const returnScore = r0 > 0
    ? clip(ARENA_CONFIG.MAX_RETURN_SCORE * Math.pow(r0, params.roiExponent), 0, 85)
    : 0;

  // Drawdown score (0-8)
  const drawdownScore = maxDrawdown != null
    ? clip(ARENA_CONFIG.MAX_DRAWDOWN_SCORE * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, 8)
    : 4; // Default if missing

  // Stability score (0-7)
  const stabilityScore = wr != null
    ? clip(ARENA_CONFIG.MAX_STABILITY_SCORE * clip((wr - 45) / (params.winRateCap - 45), 0, 1), 0, 7)
    : 3.5; // Default if missing

  return Math.round((returnScore + drawdownScore + stabilityScore) * 100) / 100;
}
