/**
 * Mobile ranking secondary-metric preference (ROI / PnL / Win% / MDD).
 *
 * Plain module (no 'use client') so the server layout can inline the
 * pre-paint bootstrap script. The visible metric is chosen by CSS from
 * `html[data-rank-metric]` (see the .mrow block in lib/performance/critical-css.ts).
 */

export const MOBILE_METRICS = ['roi', 'pnl', 'win', 'mdd'] as const
export type MobileMetric = (typeof MOBILE_METRICS)[number]
/** localStorage key — same `arena.ranking.*` namespace as the density toggle. */
export const LS_KEY_MOBILE_METRIC = 'arena.ranking.mobileMetric'
/** Attribute on <html> read by the `.mrow-m-*` visibility rules. */
export const MOBILE_METRIC_ATTR = 'data-rank-metric'

export function isMobileMetric(value: unknown): value is MobileMetric {
  return typeof value === 'string' && (MOBILE_METRICS as readonly string[]).includes(value)
}

export function readStoredMobileMetric(): MobileMetric {
  try {
    const stored = localStorage.getItem(LS_KEY_MOBILE_METRIC)
    if (isMobileMetric(stored)) return stored
  } catch {
    /* localStorage unavailable (private mode) — default ROI */
  }
  return 'roi'
}

export function applyMobileMetric(metric: MobileMetric): void {
  document.documentElement.setAttribute(MOBILE_METRIC_ATTR, metric)
}

/**
 * Pre-paint script (app/layout.tsx): applies a stored non-default choice before
 * the SSR rows paint. MobileRankHeader re-applies it after mount, so a blocked
 * inline script degrades to a text-only swap in a fixed-width column (no shift).
 */
export const MOBILE_METRIC_BOOTSTRAP_SCRIPT = `try{var m=localStorage.getItem('${LS_KEY_MOBILE_METRIC}');if(m==='pnl'||m==='win'||m==='mdd')document.documentElement.setAttribute('${MOBILE_METRIC_ATTR}',m)}catch(e){}`
