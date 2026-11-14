/**
 * Transport-neutral response type for GET /api/traders/[handle] (the `data`
 * member of the standard success envelope).
 *
 * `toTraderPageData` returns TraderDetailPageData, the route sends it with
 * `satisfies TraderDetailResponseData`, and lib/contracts/core-api.ts asserts
 * it against the runtime zod contract. Only the fields the contract names are
 * typed precisely; the legacy page payload carries many more, which stay
 * `unknown` until they are bound too. Keep this module free of Next.js
 * route/runtime imports.
 */

export interface TraderDetailProfile {
  handle: string
  id: string
  /**
   * Absent (not null) when the source has no follower count: the bridge
   * deliberately sends `undefined`, which JSON omits.
   */
  followers?: number
  copiers: number | null
  avatar_url: string | null
  isRegistered: boolean
  source: string
  market_type: string | null
  profile_url: string | null
  bio: string | null
}

/** Null means the source did not provide the metric. */
export interface TraderDetailPerformance {
  roi_7d: number | null
  roi_30d: number | null
  roi_90d: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  arena_score: number | null
  arena_score_7d: number | null
  arena_score_30d: number | null
  arena_score_90d: number | null
  [field: string]: unknown
}

/** What `toTraderPageData` returns. */
export interface TraderDetailPageData {
  profile: TraderDetailProfile
  performance: TraderDetailPerformance
  [field: string]: unknown
}

/** The `data` member of a GET /api/traders/[handle] success response. */
export interface TraderDetailResponseData extends TraderDetailPageData {
  /** Every public response recomputes the projection. */
  cached: false
  /** Server-side resolve + detail time in milliseconds. */
  fetchTime: number
}
