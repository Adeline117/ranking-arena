/**
 * Shared public-leaderboard cohort predicate.
 *
 * Every public reader of `public_ranked_leaderboard` — homepage SSR
 * (getInitialTraders → getLeaderboard), /api/traders (homepage client paging)
 * and /api/rankings — must select the SAME row set. Before this module the
 * three disagreed (SSR `arena_score > 10` + 6h, /api/traders 6h with no score
 * floor, /api/rankings `arena_score > 0` + |roi| ≤ 50 000 with no explicit
 * age), so the SSR first page and the client's later pages were different
 * cohorts: tail pages and `hasMore` did not line up.
 *
 * Choices:
 *  - Score floor `arena_score > 0`: the least restrictive of the previous
 *    floors that still drops unscored rows. A higher floor would silently
 *    shrink the documented /api/rankings contract; the homepage `> 10` only
 *    ever trimmed the tail.
 *  - |roi| ≤ 50 000: the anomaly bound /api/rankings already documented. The
 *    publication path's per-period ROI caps are tighter, so this is a
 *    defence-in-depth mirror and normally removes nothing.
 *  - Freshness = the sealed view's own 48h serving window
 *    (rank_valid_until = computed_at + 48h, migration 20260816184500). The
 *    old 6h reader window emptied the homepage between 6h and 48h while
 *    /api/rankings still served the same sealed rows. Staleness inside the
 *    window is surfaced through source freshness / isStale, not by hiding rows.
 */

export const PUBLIC_COHORT_MIN_ARENA_SCORE_EXCLUSIVE = 0
export const PUBLIC_COHORT_MAX_ABS_ROI = 50_000
export const PUBLIC_COHORT_MAX_COMPUTED_AGE_MS = 48 * 60 * 60 * 1000

export function publicCohortComputedCutoffIso(nowMs: number = Date.now()): string {
  return new Date(nowMs - PUBLIC_COHORT_MAX_COMPUTED_AGE_MS).toISOString()
}

/** Structural subset of a PostgREST filter builder. */
export interface PublicCohortFilterable<Q> {
  gt(column: string, value: number): Q
  gte(column: string, value: number | string): Q
  lte(column: string, value: number): Q
}

/** Apply the shared cohort predicate in SQL (before ordering / ranges). */
export function applyPublicCohortFilters<Q extends PublicCohortFilterable<Q>>(
  query: Q,
  nowMs: number = Date.now()
): Q {
  return query
    .gt('arena_score', PUBLIC_COHORT_MIN_ARENA_SCORE_EXCLUSIVE)
    .gte('roi', -PUBLIC_COHORT_MAX_ABS_ROI)
    .lte('roi', PUBLIC_COHORT_MAX_ABS_ROI)
    .gte('computed_at', publicCohortComputedCutoffIso(nowMs))
}

/**
 * The same predicate for rows read back from a cache. A cached row that no
 * longer satisfies it (aged out, or written under an older predicate) must
 * not be served.
 */
export function isInPublicCohort(
  row: { arena_score: unknown; roi: unknown; computed_at: unknown },
  nowMs: number = Date.now()
): boolean {
  const score = row.arena_score
  const roi = row.roi
  if (typeof score !== 'number' || !Number.isFinite(score)) return false
  if (!(score > PUBLIC_COHORT_MIN_ARENA_SCORE_EXCLUSIVE)) return false
  if (typeof roi !== 'number' || !Number.isFinite(roi)) return false
  if (roi < -PUBLIC_COHORT_MAX_ABS_ROI || roi > PUBLIC_COHORT_MAX_ABS_ROI) return false
  if (typeof row.computed_at !== 'string') return false
  const computedAtMs = Date.parse(row.computed_at)
  return Number.isFinite(computedAtMs) && computedAtMs >= nowMs - PUBLIC_COHORT_MAX_COMPUTED_AGE_MS
}
