/**
 * Canonical numeric bounds for public ranking and snapshot writes.
 *
 * These values mirror the database CHECK constraints. Any bound change must
 * ship with a forward-only migration and matching validation tests.
 */
export const VALIDATION_BOUNDS = {
  roi_pct: { min: -10000, max: 10000 },
  pnl_usd: { min: -10_000_000, max: 100_000_000 },
  pnl_usd_dex_whale: { min: -10_000_000, max: 1_000_000_000 },
  win_rate_pct: { min: 0, max: 100 },
  max_drawdown_pct: { min: 0, max: 100 },
  sharpe_ratio: { min: -20, max: 20 },
  arena_score: { min: 0, max: 100 },
  trades_count: { min: 0 },
  followers: { min: 0 },
  copiers: { min: 0 },
} as const
