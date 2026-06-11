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
}

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
  if (rows.length >= 3) {
    return { baseline: median(rows.map((r) => r.actual_count)), isBootstrap: false }
  }
  return { baseline: expectedCount, isBootstrap: true }
}
