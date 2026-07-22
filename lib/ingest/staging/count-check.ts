/**
 * Rolling-baseline count check (spec §5.1).
 *
 * expected = median(actual_count of the last 7 independent PASSING crawl
 * cycles); a cycle outside the allowed count envelope is marked
 * count_check_passed=false, entries are NOT published, and the last good
 * snapshot stays live. The hard-coded survey count (sources.expected_count)
 * is the day-one sanity floor only, used until 3 passing cycles exist.
 *
 * evaluateCount is pure; getCountBaseline does the DB read (worker-only).
 */

import { getIngestPool } from '../db'
import type { PoolClient } from 'pg'

export type CountBaselineQueryExecutor = Pick<PoolClient, 'query'>

export interface CountVerdict {
  passed: boolean
  /** The baseline compared against (stored as snapshots.baseline_used). */
  baselineUsed: number | null
  deviationPct: number | null
}

/**
 * Small upstream boards grow in whole traders, so a strict percentage gate
 * becomes misleading: +3 is 50% at a baseline of 6, while +6 is 30% at 20.
 * Both shapes have been observed as complete, naturally expanding boards.
 *
 * This allowance is deliberately:
 * - limited to small baselines;
 * - growth-only (a short crawl is still judged by the strict drop threshold);
 * - bounded by an absolute OR relative growth ceiling.
 */
export const SMALL_BOARD_BASELINE_MAX = 25
export const SMALL_BOARD_GROWTH_ABSOLUTE_TOLERANCE = 3
export const SMALL_BOARD_GROWTH_RELATIVE_TOLERANCE_PCT = 30

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
  const growth = actual - baseline
  const smallBoardGrowth =
    baseline <= SMALL_BOARD_BASELINE_MAX &&
    growth > 0 &&
    (growth <= SMALL_BOARD_GROWTH_ABSOLUTE_TOLERANCE ||
      deviationPct <= SMALL_BOARD_GROWTH_RELATIVE_TOLERANCE_PCT)
  return {
    passed: deviationPct <= maxDeviationPct || smallBoardGrowth,
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

export interface CountObservation {
  actualCount: number
  /**
   * Stable identity of one scheduled crawl cycle. BullMQ retries MUST reuse
   * this id; otherwise retries can impersonate independent confirmations.
   * null disables the sustained-shift escape hatch for this observation.
   */
  cycleId: string | null
  /**
   * Versioned producer contract for this count. A new generation starts from
   * expectedCount instead of inheriting incompatible historical observations.
   * null/omitted is the legacy generation.
   */
  baselineGeneration?: string | null
}

interface StoredCountObservation {
  actual_count: number
  cycle_id: string
  explicit_cycle: boolean
}

/**
 * Read the newest attempt from each independent observation cycle.
 *
 * Older snapshots predate cycle ids. Treat each legacy row as its own cycle
 * rather than collapsing unrelated history; all new Tier-A writes carry the
 * explicit id. The same de-duplication applies to the passing baseline and to
 * level-shift evidence, because a partly successful multi-window job is
 * retried as a whole.
 */
async function getRecentDistinctObservations(
  sourceId: number,
  timeframe: number,
  limit: number,
  options: {
    passedOnly: boolean
    excludeCycleId?: string
    baselineGeneration: string | null
  },
  queryExecutor: CountBaselineQueryExecutor
): Promise<StoredCountObservation[]> {
  const { rows } = await queryExecutor.query<StoredCountObservation>(
    `WITH observations AS (
       SELECT id, actual_count, scraped_at,
              NULLIF(meta->>'observation_cycle_id', '') AS explicit_cycle_id,
              COALESCE(
                NULLIF(meta->>'observation_cycle_id', ''),
                'legacy:' || id::text
              ) AS cycle_id
         FROM arena.leaderboard_snapshots
        WHERE source_id = $1
          AND timeframe = $2
          AND ($4::boolean = false OR count_check_passed)
          AND (
            ($6::text IS NULL AND NULLIF(meta->>'count_baseline_generation', '') IS NULL)
            OR NULLIF(meta->>'count_baseline_generation', '') = $6
          )
     ),
     latest_per_cycle AS (
       SELECT DISTINCT ON (cycle_id)
              id, actual_count, scraped_at, cycle_id, explicit_cycle_id
         FROM observations
        WHERE ($5::text IS NULL OR cycle_id <> $5)
        ORDER BY cycle_id, scraped_at DESC, id DESC
     )
     SELECT actual_count, cycle_id,
            (explicit_cycle_id IS NOT NULL) AS explicit_cycle
       FROM latest_per_cycle
      ORDER BY scraped_at DESC, id DESC
      LIMIT $3`,
    [
      sourceId,
      timeframe,
      limit,
      options.passedOnly,
      options.excludeCycleId ?? null,
      options.baselineGeneration,
    ]
  )
  return rows
}

/**
 * Rolling median of up to the last 7 passing crawls for (source, TF).
 * With ≥3 passing crawls the median of real data replaces the survey
 * number; below that, expectedCount is the (loose) day-one sanity floor.
 */
export async function getCountBaseline(
  sourceId: number,
  timeframe: number,
  expectedCount: number | null,
  currentObservation: CountObservation,
  queryExecutor?: CountBaselineQueryExecutor
): Promise<CountBaseline> {
  // A publisher may provide its transaction client after taking the source
  // publication lock. Keeping every baseline/shift read on that executor
  // prevents a concurrent commit from changing the evidence mid-verdict.
  // Legacy callers retain the pool-backed behavior.
  const executor = queryExecutor ?? getIngestPool()
  const baselineGeneration = currentObservation.baselineGeneration?.trim() || null
  const rows = await getRecentDistinctObservations(
    sourceId,
    timeframe,
    7,
    {
      passedOnly: true,
      // A retry may revisit a window that already passed earlier in this same
      // multi-window job. That earlier attempt is not independent history and
      // must not help the current retry cross the 3-cycle rolling threshold.
      excludeCycleId: currentObservation.cycleId ?? undefined,
      baselineGeneration,
    },
    executor
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
  // Detect a SUSTAINED level from the CURRENT observation plus the previous
  // N-1 INDEPENDENT cycles. The current cycle id is excluded from history, so
  // BullMQ retries of the same scheduled job can never fill the confirmation
  // quorum. A one-off truncated crawl also cannot qualify.
  if (
    baseline !== null &&
    baseline > 0 &&
    currentObservation.cycleId !== null &&
    currentObservation.cycleId.length > 0
  ) {
    const recent = await getRecentDistinctObservations(
      sourceId,
      timeframe,
      SHIFT_CONFIRM_CRAWLS - 1,
      {
        passedOnly: false,
        excludeCycleId: currentObservation.cycleId,
        baselineGeneration,
      },
      executor
    )
    // Pre-deploy/manual snapshots carry no trustworthy job-instance identity.
    // They stay visible in the newest-N sequence and break the quorum instead
    // of being filtered out to expose older rows that were not consecutive.
    if (
      recent.length === SHIFT_CONFIRM_CRAWLS - 1 &&
      recent.every((observation) => observation.explicit_cycle)
    ) {
      const counts = [currentObservation.actualCount, ...recent.map((r) => r.actual_count)]
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
