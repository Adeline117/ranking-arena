/**
 * Rolling-baseline count check (spec §5.1).
 *
 * expected = median(actual_count of last 7 PASSING crawls); a cycle fails
 * if actual deviates >10% from that rolling median → snapshot marked
 * count_check_passed=false, entries NOT published, last good snapshot
 * stays live. The hard-coded survey count (sources.expected_count) is the
 * day-one sanity floor only, used until 7 passing crawls exist.
 *
 * evaluateCount is pure; getCountBaseline does the DB read (worker-only).
 */

import { getIngestPool } from '../db'

export interface CountVerdict {
  passed: boolean
  /** The baseline compared against (stored as snapshots.baseline_used). */
  baselineUsed: number | null
  deviationPct: number | null
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Pure verdict given a baseline. baseline=null → pass (nothing to compare). */
export function evaluateCount(
  actual: number,
  baseline: number | null,
  maxDeviationPct = 10
): CountVerdict {
  if (baseline === null || baseline <= 0) {
    return { passed: true, baselineUsed: baseline, deviationPct: null }
  }
  const deviationPct = (Math.abs(actual - baseline) / baseline) * 100
  return {
    passed: deviationPct <= maxDeviationPct,
    baselineUsed: baseline,
    deviationPct,
  }
}

export interface CountBaseline {
  baseline: number | null
  /** true while we are still comparing against the stale survey number. */
  isBootstrap: boolean
  /** true when a SUSTAINED level-shift was adopted to break a deadlock. */
  shifted?: boolean
}

/** Consecutive consistent crawls required to ratify a level-shift. */
export const SHIFT_CONFIRM_CRAWLS = 3
/** Max spread among the confirming crawls for them to count as "consistent". */
export const SHIFT_MAX_SPREAD_PCT = 10

/**
 * Survey counts age (boards grow/shrink over months) — a 6-month-old
 * expected_count at ±10% would deadlock a drifted board out of ever
 * accumulating its 7 passing crawls. So the bootstrap fallback gets a
 * wider sanity tolerance; the strict ±10% only applies to the rolling
 * median of real recent crawls.
 */
export const BOOTSTRAP_DEVIATION_PCT = 30
export const ROLLING_DEVIATION_PCT = 10

/**
 * Rolling median of up to the last 7 passing crawls for (source, TF).
 * With ≥3 passing crawls the median of real data replaces the survey
 * number; below that, expectedCount is the (loose) day-one sanity floor.
 */
export async function getCountBaseline(
  sourceId: number,
  timeframe: number,
  expectedCount: number | null
): Promise<CountBaseline> {
  const { rows } = await getIngestPool().query<{ actual_count: number }>(
    `SELECT actual_count
       FROM arena.leaderboard_snapshots
      WHERE source_id = $1 AND timeframe = $2 AND count_check_passed
      ORDER BY scraped_at DESC
      LIMIT 7`,
    [sourceId, timeframe]
  )

  // Current baseline: rolling median of real passing crawls once we have ≥3,
  // else the (loose) day-one survey number.
  const hasRolling = rows.length >= 3
  const rollingMedian = hasRolling ? median(rows.map((r) => r.actual_count)) : null
  const baseline = hasRolling
    ? rollingMedian === null
      ? null
      : Math.round(rollingMedian)
    : expectedCount
  const isBootstrap = !hasRolling

  // Deadlock escape hatch (applies to BOTH the rolling median AND the bootstrap
  // survey number): either can deadlock a source out of ever passing —
  //  - rolling: a board that grew/shrank >10% never enters a new passing crawl,
  //    so the median stays frozen at the pre-shift level (gate_futures: stuck at
  //    734 while the board sat at ~971).
  //  - bootstrap: a stale/wrong survey count permanently rejects a board that
  //    never matched it (xt_spot: expected 84 vs a real ~35 board, and per-TF
  //    sizes differ so no single expected_count fits — 7d/30d/90d each need
  //    their own real level).
  // Detect a SUSTAINED level: the last N crawls (ANY status) clustered tightly
  // (spread ≤10%) around a level that deviates from the current baseline by more
  // than the applicable tolerance → adopt it. A one-off truncated crawl can't
  // qualify (not consistent across N consecutive), so transient anomalies are
  // still rejected; only a persistent new normal un-sticks the board.
  if (baseline !== null && baseline > 0) {
    const { rows: recent } = await getIngestPool().query<{ actual_count: number }>(
      `SELECT actual_count
         FROM arena.leaderboard_snapshots
        WHERE source_id = $1 AND timeframe = $2
        ORDER BY scraped_at DESC
        LIMIT $3`,
      [sourceId, timeframe, SHIFT_CONFIRM_CRAWLS]
    )
    if (recent.length === SHIFT_CONFIRM_CRAWLS) {
      const counts = recent.map((r) => r.actual_count)
      const recentMedian = median(counts)
      if (recentMedian && recentMedian > 0) {
        const spreadPct = ((Math.max(...counts) - Math.min(...counts)) / recentMedian) * 100
        const tolerance = isBootstrap ? BOOTSTRAP_DEVIATION_PCT : ROLLING_DEVIATION_PCT
        const driftPct = (Math.abs(recentMedian - baseline) / baseline) * 100
        if (spreadPct <= SHIFT_MAX_SPREAD_PCT && driftPct > tolerance) {
          return { baseline: Math.round(recentMedian), isBootstrap: false, shifted: true }
        }
      }
    }
  }

  // snapshots.baseline_used is an int column — an even-length median
  // (e.g. 1663.5) is already rounded above.
  return { baseline, isBootstrap }
}
