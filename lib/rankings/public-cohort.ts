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
 * Ranking LISTS hide idle-window rows by default.
 *
 * An idle-window row (public_ranked_leaderboard.idle_window) had no ROI and no
 * PnL in the period: it is published and ranked at the tail, but it is not
 * scored, and on a full board more than half of all rows are of this kind.
 * Lists leave them out unless the reader explicitly asks to see them
 * (`/api/traders?idle=1`); a trader's own profile and `/api/rankings` are not
 * lists in this sense and still serve them.
 */
export function excludeIdleWindowRows<Q extends { eq(column: string, value: boolean): Q }>(
  query: Q
): Q {
  return query.eq('idle_window', false)
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

type CohortMembershipResult = { data: unknown[] | null; error: { message: string } | null }

interface CohortMembershipQuery extends PromiseLike<CohortMembershipResult> {
  select(columns: string): CohortMembershipQuery
  eq(column: string, value: string): CohortMembershipQuery
  in(column: string, values: string[]): CohortMembershipQuery
  gt(column: string, value: number): CohortMembershipQuery
  gte(column: string, value: number | string): CohortMembershipQuery
  lte(column: string, value: number): CohortMembershipQuery
}

type CohortMembershipClient = {
  from(relation: 'public_ranked_leaderboard'): CohortMembershipQuery
}

function isCohortMembershipClient(value: unknown): value is CohortMembershipClient {
  return (
    typeof value === 'object' &&
    value !== null &&
    'from' in value &&
    typeof value.from === 'function'
  )
}

/**
 * Whether every cached row is still a member of the live public cohort.
 *
 * A database-level withdrawal (source isolation by migration, serving-head /
 * season fence invalidation) removes rows from `public_ranked_leaderboard`
 * without advancing the shared Redis write fence, so a cached page cannot see
 * it. One indexed membership read per cache hit makes the withdrawal visible
 * at once instead of after the cache TTL. Throws when the read fails: an
 * unverifiable cached page must not be served as current.
 *
 * The idle-window flag is part of membership: a row that became idle after
 * the page was cached would otherwise keep being shown as a scored trader for
 * the rest of the TTL. A cached row without the flag counts as not idle.
 */
export async function cachedRowsStillInPublicCohort(
  supabase: unknown,
  season: string,
  rows: ReadonlyArray<{ source?: unknown; source_trader_id?: unknown; idle_window?: unknown }>
): Promise<boolean> {
  if (rows.length === 0) return true
  if (!isCohortMembershipClient(supabase)) {
    throw new TypeError('Supabase client does not expose a public view reader')
  }
  const key = (source: unknown, id: unknown) => `${String(source)}\u0000${String(id)}`
  const ids = [...new Set(rows.map((row) => String(row.source_trader_id)))]
  const { data, error } = await applyPublicCohortFilters(
    supabase
      .from('public_ranked_leaderboard')
      .select('source, source_trader_id, idle_window')
      .eq('season_id', season)
      .in('source_trader_id', ids)
  )
  if (error) throw new Error(`public cohort membership read failed: ${error.message}`)
  const live = new Map<string, boolean>(
    (data ?? []).flatMap((row) =>
      typeof row === 'object' && row !== null && 'source' in row && 'source_trader_id' in row
        ? [
            [
              key(row.source, row.source_trader_id),
              (row as { idle_window?: unknown }).idle_window === true,
            ] as const,
          ]
        : []
    )
  )
  return rows.every((row) => {
    const liveIdle = live.get(key(row.source, row.source_trader_id))
    return liveIdle !== undefined && liveIdle === (row.idle_window === true)
  })
}
