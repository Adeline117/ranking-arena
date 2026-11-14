/**
 * Composite (overall) Arena Score ranking: 90D × 0.70 + 30D × 0.25 + 7D × 0.05
 * via calculateOverallScore — the single rule shared by /api/rankings
 * `window=composite` and the trader detail `overall_score`.
 *
 * Membership is the published 90D cohort (90D carries 70% of the weight; a
 * trader without a published 90D score has no composite). A missing 30D or 7D
 * score is never borrowed from 90D; calculateOverallScore's missing-period
 * rules apply instead (90D only → 0.9 × S90; 90D + one of 30D/7D → 0.70 × S90
 * + 0.30 × the other; momentum needs both 7D and 30D).
 */

import { ARENA_CONFIG, calculateOverallScore } from '@/lib/utils/arena-score'

/** Deepest composite position a request may ask for (offset + limit). */
export const COMPOSITE_MAX_DEPTH = 500
/** 90D rows read per scan step. */
export const COMPOSITE_SCAN_BATCH = 500
/** Hard bound on 90D rows scanned for one request. */
export const COMPOSITE_MAX_SCAN = 20_000

export function compositeArenaScore(
  score90d: number | null,
  score30d: number | null,
  score7d: number | null
): number | null {
  if (score90d == null) return null
  return calculateOverallScore({ score90d, score30d, score7d })
}

/**
 * Highest composite any trader with 90D score `s90` can reach: 30D/7D at most
 * 100 and the momentum bonus at most MOMENTUM_MAX_BONUS (every
 * calculateOverallScore branch with a 90D score stays below this).
 */
export function compositeUpperBound(s90: number): number {
  return Math.min(100, 0.7 * s90 + 30 + ARENA_CONFIG.MOMENTUM_MAX_BONUS)
}

export interface Composite90Row {
  key: string
  score90d: number
}

export interface CompositeRanked<R extends Composite90Row> {
  row: R
  composite: number
}

export type CompositeScanResult<R extends Composite90Row> =
  | { status: 'ranked'; ranked: CompositeRanked<R>[] }
  | { status: 'scan_bounded' }

/**
 * Exact top-`need` composite ranking without reading the whole cohort.
 * `fetch90` returns 90D rows ordered by 90D score desc (then 90D rank), so
 * once the `need`-th best composite seen reaches compositeUpperBound of the
 * last 90D score read, no unread row can outrank it (an equal unread row
 * sorts after: ties break by 90D order).
 */
export async function rankCompositeCohort<R extends Composite90Row>(opts: {
  need: number
  fetch90: (from: number, to: number) => Promise<R[]>
  fetchShortScores: (
    rows: R[]
  ) => Promise<Map<string, { score30d: number | null; score7d: number | null }>>
  batch?: number
  maxScan?: number
}): Promise<CompositeScanResult<R>> {
  const batch = opts.batch ?? COMPOSITE_SCAN_BATCH
  const maxScan = opts.maxScan ?? COMPOSITE_MAX_SCAN
  const seen: Array<CompositeRanked<R> & { order: number }> = []
  for (let from = 0; ; from += batch) {
    if (from >= maxScan) return { status: 'scan_bounded' }
    const rows = await opts.fetch90(from, from + batch - 1)
    const short = await opts.fetchShortScores(rows)
    for (const row of rows) {
      const s = short.get(row.key)
      seen.push({
        row,
        order: seen.length,
        composite: compositeArenaScore(row.score90d, s?.score30d ?? null, s?.score7d ?? null)!,
      })
    }
    seen.sort((a, b) => b.composite - a.composite || a.order - b.order)
    const exhausted = rows.length < batch
    const last = rows.at(-1)
    const converged =
      last != null &&
      seen.length >= opts.need &&
      seen[opts.need - 1].composite >= compositeUpperBound(last.score90d)
    if (exhausted || converged) {
      return {
        status: 'ranked',
        ranked: seen.slice(0, opts.need).map(({ row, composite }) => ({ row, composite })),
      }
    }
  }
}
