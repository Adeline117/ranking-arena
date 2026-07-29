import type { Period } from '@/lib/utils/arena-score'
import { VALIDATION_BOUNDS } from '@/lib/pipeline/types'

const ROI_ABS_MAX_BY_PERIOD: Record<Period, number> = {
  '7D': 2_000,
  '30D': 5_000,
  '90D': 10_000,
}

const PNL_WHALE_EXEMPT_SOURCES = new Set(['hyperliquid', 'gmx', 'dydx', 'drift'])

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Rank inputs never accept the ±10,000% ingest clamp sentinel. */
export function isRankEligibleRoi(value: unknown, period: Period): value is number {
  if (!finiteNumber(value)) return false
  const abs = Math.abs(value)
  return abs < VALIDATION_BOUNDS.roi_pct.max && abs <= ROI_ABS_MAX_BY_PERIOD[period]
}

/** Apply the same source-aware USD plausibility envelope before percentiles. */
export function isRankEligiblePnl(value: unknown, source: string): value is number {
  if (!finiteNumber(value)) return false
  const upperBound = PNL_WHALE_EXEMPT_SOURCES.has(source)
    ? VALIDATION_BOUNDS.pnl_usd_dex_whale.max
    : VALIDATION_BOUNDS.pnl_usd.max
  return value >= VALIDATION_BOUNDS.pnl_usd.min && value <= upperBound
}

export function normalizeRankWinRate(value: unknown): number | null {
  if (!finiteNumber(value) || value < 0 || value > 100) return null
  // Arena storage is already canonical percent (0..100). Adapter-specific
  // fraction conversion belongs at ingest; guessing here would turn a real
  // 0.6% observation into a fabricated 60% win rate.
  return value
}

export function normalizeRankDrawdown(value: unknown): number | null {
  return finiteNumber(value) && value >= 0 && value < VALIDATION_BOUNDS.max_drawdown_pct.max
    ? value
    : null
}

export function normalizeRankSharpe(value: unknown): number | null {
  return finiteNumber(value) &&
    value >= VALIDATION_BOUNDS.sharpe_ratio.min &&
    value <= VALIDATION_BOUNDS.sharpe_ratio.max
    ? value
    : null
}

/** Derived writers cap profit factor at 10; values outside that contract are unknown. */
export function normalizeRankProfitFactor(value: unknown): number | null {
  return finiteNumber(value) && value >= 0 && value <= 10 ? value : null
}

export function normalizeRankTradesCount(value: unknown): number | null {
  return finiteNumber(value) && Number.isSafeInteger(value) && value >= 0 ? value : null
}
