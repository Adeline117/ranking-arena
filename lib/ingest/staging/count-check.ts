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

/**
 * Rolling median of the last 7 passing crawls for (source, timeframe);
 * falls back to expectedCount until enough history exists (spec: the
 * survey number is ONLY the day-one floor before 7 crawls exist).
 */
export async function getCountBaseline(
  sourceId: number,
  timeframe: number,
  expectedCount: number | null
): Promise<number | null> {
  const { rows } = await getIngestPool().query<{ actual_count: number }>(
    `SELECT actual_count
       FROM arena.leaderboard_snapshots
      WHERE source_id = $1 AND timeframe = $2 AND count_check_passed
      ORDER BY scraped_at DESC
      LIMIT 7`,
    [sourceId, timeframe]
  )
  if (rows.length >= 7) {
    return median(rows.map((r) => r.actual_count))
  }
  return expectedCount
}
