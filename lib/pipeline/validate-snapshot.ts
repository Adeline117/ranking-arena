/**
 * Unified Snapshot Validation Layer
 *
 * Validates trader snapshot rows before DB upsert to catch data quality issues
 * such as ROI/PnL confusion, extreme outliers, and missing required fields.
 *
 * Used by: lib/cron/fetchers/shared.ts (inline fetchers), pipeline storage, openclaw scripts
 */

export interface ValidationResult {
  valid: boolean
  reasons: string[]
}

/**
 * Validate a snapshot row before persisting.
 * Returns { valid: true } if the row is safe to write, or { valid: false, reasons: [...] }
 * with human-readable reasons explaining why the row was rejected.
 */
export function validateSnapshot(row: Record<string, unknown>): ValidationResult {
  const reasons: string[] = []

  // trader_key must exist
  if (!row.trader_key) {
    reasons.push('Missing trader_key')
  }

  // platform must exist
  if (!row.platform) {
    reasons.push('Missing platform')
  }

  // ROI range check: reject values outside [-100%, 100000%]
  // Values beyond this range indicate normalization bugs (e.g., decimal vs percentage confusion)
  const roiPct = row.roi_pct ?? row.roi
  if (roiPct != null && (Math.abs(Number(roiPct)) > 100000)) {
    reasons.push(`ROI out of range: ${roiPct}`)
  }

  // ROI ~= PnL check: detect data mapping errors where ROI was set to PnL value
  // (e.g., Hyperliquid bug where roi=pnl in USD). Only flag when ROI is large enough
  // that the coincidence is suspicious.
  const pnlUsd = row.pnl_usd ?? row.pnl
  if (
    roiPct != null &&
    pnlUsd != null &&
    Math.abs(Number(roiPct)) > 1000 &&
    Math.abs(Number(roiPct) - Number(pnlUsd)) < 1
  ) {
    reasons.push('ROI ≈ PnL (data mapping error)')
  }

  // Win rate: must be 0-100% if present
  const winRate = row.win_rate
  if (winRate != null && (Number(winRate) < 0 || Number(winRate) > 100)) {
    reasons.push(`Win rate out of range: ${winRate}`)
  }

  // Max drawdown: must be 0-100% if present
  const maxDrawdown = row.max_drawdown
  if (maxDrawdown != null && (Number(maxDrawdown) < 0 || Number(maxDrawdown) > 100)) {
    reasons.push(`Max drawdown out of range: ${maxDrawdown}`)
  }

  return { valid: reasons.length === 0, reasons }
}
