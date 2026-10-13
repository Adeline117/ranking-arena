/**
 * Public rank-history boundary.
 *
 * `rank_history` is currently populated from mutable raw leaderboard snapshots.
 * It has no immutable publication proof, so it must never supply public rank
 * trajectories or be cached as one. Keep the response shape explicit until a
 * historical serving projection binds each point to a published generation.
 */

export const PUBLIC_RANK_HISTORY_UNAVAILABLE_REASON = 'historical_rank_evidence_unavailable'

export const PUBLIC_RANK_HISTORY_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const

export function unavailablePublicRankHistoryProvenance() {
  return {
    ranking_visibility: 'partial' as const,
    ranking_visibility_reason: PUBLIC_RANK_HISTORY_UNAVAILABLE_REASON,
    ranking_visibility_reasons: [PUBLIC_RANK_HISTORY_UNAVAILABLE_REASON],
    history_completeness: {
      state: 'unknown' as const,
      reason: PUBLIC_RANK_HISTORY_UNAVAILABLE_REASON,
    },
  }
}

export function noStorePublicRankHistory<T extends { headers: Headers }>(response: T): T {
  for (const [name, value] of Object.entries(PUBLIC_RANK_HISTORY_NO_STORE_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
}
