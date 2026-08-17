import type { ActivityType } from '@/lib/types/activities'

/**
 * Public activity-feed publication boundary.
 *
 * Historical activity rows do not carry an immutable ranking-publication
 * receipt. A row whose meaning depends on rank, ROI, PnL, or Arena Score
 * therefore cannot be republished simply because an account happens to be in
 * the current public leaderboard. Until an event-level attestation exists,
 * public readers may expose only activity kinds with an explicit structural
 * safety review and immutable event-time receipt. No legacy kind satisfies
 * that contract today.
 */

export const RANKING_ACTIVITY_TYPES = [
  'rank_up',
  'entered_top10',
  'roi_milestone',
  'score_high',
  'large_profit',
] as const

type KnownNonRankingActivityType = Exclude<ActivityType, (typeof RANKING_ACTIVITY_TYPES)[number]>

/**
 * This is deliberately an allowlist, not a denylist. New activity kinds stay
 * private by default until their publication evidence and display contract are
 * reviewed.
 */
// Keep this deliberately empty until a generator writes an immutable receipt
// that binds the displayed activity text and metric to source evidence at the
// event's occurrence time. Legacy free-form rows are not safe merely because
// their type labels sound non-ranking.
export const PUBLIC_NON_RANKING_ACTIVITY_TYPES: readonly KnownNonRankingActivityType[] =
  Object.freeze([])

// Bump this whenever the public activity admission contract changes so an open
// client does not reuse an earlier React Query payload under the new policy.
export const PUBLIC_ACTIVITY_CACHE_EPOCH = 'event-receipt-required-v2'

export const PUBLIC_ACTIVITY_VISIBILITY_REASON =
  'event_time_publication_evidence_unavailable' as const

export type PublicNonRankingActivityType = (typeof PUBLIC_NON_RANKING_ACTIVITY_TYPES)[number]

export type PublicActivityCandidate = {
  activity_type?: unknown
}

const publicNonRankingActivityTypeSet = new Set<string>(PUBLIC_NON_RANKING_ACTIVITY_TYPES)

export function hasPublicNonRankingActivityTypes(): boolean {
  return PUBLIC_NON_RANKING_ACTIVITY_TYPES.length > 0
}

/**
 * Preserve the established response shape while making an intentionally empty
 * public feed distinguishable from a successful query with no rows. Readers
 * must use this instead of touching legacy `trader_activities` when the
 * allowlist is empty.
 */
export function unavailablePublicActivityFeed(limit: number) {
  return {
    activities: [],
    pagination: { limit, hasMore: false, nextCursor: null },
    activity_visibility: 'unavailable' as const,
    activity_visibility_reason: PUBLIC_ACTIVITY_VISIBILITY_REASON,
  }
}

export const PUBLIC_ACTIVITY_NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const

export function isPublicNonRankingActivity(
  activity: PublicActivityCandidate | null | undefined
): activity is PublicActivityCandidate & { activity_type: PublicNonRankingActivityType } {
  return (
    typeof activity?.activity_type === 'string' &&
    publicNonRankingActivityTypeSet.has(activity.activity_type)
  )
}

/**
 * Apply the allowlist again at the release boundary. Database predicates make
 * pagination efficient; this check still protects API/page consumers if a
 * query is widened or a test double returns a forged row.
 */
export function filterPublicNonRankingActivities<T extends PublicActivityCandidate>(
  activities: readonly T[]
): T[] {
  return activities.filter(isPublicNonRankingActivity)
}

export function noStorePublicActivity<T extends { headers: Headers }>(response: T): T {
  for (const [name, value] of Object.entries(PUBLIC_ACTIVITY_NO_STORE_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
}
