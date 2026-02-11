/**
 * Shared scoring utilities for import scripts
 */

export const sleep = ms => new Promise(r => setTimeout(r, ms))
export const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/**
 * Calculate arena/composite score from trader metrics
 * @param {number|null} roi - Return on investment (%)
 * @param {number|null} p - PnL (unused in formula but kept for signature compat)
 * @param {number|null} d - Max drawdown (%)
 * @param {number|null} w - Win rate (%)
 * @returns {number|null}
 */
export function cs(roi, p, d, w) {
  if (roi == null) return null
  return clip(
    Math.round(
      (Math.min(70, roi > 0 ? Math.log(1 + roi / 100) * 25 : Math.max(-70, roi / 100 * 50)) +
        (d != null ? Math.max(0, 15 * (1 - d / 100)) : 7.5) +
        (w != null ? Math.min(15, w / 100 * 15) : 7.5)) * 10
    ) / 10,
    0,
    100
  )
}
