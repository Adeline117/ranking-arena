/**
 * Transport-neutral search contract shared by the search API route and its UI
 * consumers. Keep this module free of Next.js route/runtime imports so client
 * code never depends on an `app/api` implementation module.
 */

export interface UnifiedSearchResult {
  id: string
  type: 'trader' | 'post' | 'user' | 'group'
  title: string
  subtitle?: string
  href: string
  avatar?: string | null
  meta?: Record<string, unknown>
}

/** A result of one known category, so a trader list can only hold traders. */
export type UnifiedSearchResultOf<T extends UnifiedSearchResult['type']> = UnifiedSearchResult & {
  type: T
}

export interface UnifiedSearchResponse {
  query: string
  results: {
    traders: UnifiedSearchResultOf<'trader'>[]
    posts: UnifiedSearchResultOf<'post'>[]
    users: UnifiedSearchResultOf<'user'>[]
    groups: UnifiedSearchResultOf<'group'>[]
  }
  total: number
  /** "Did you mean" suggestions when few results found */
  suggestions?: string[]
  /** Matched exchange platform filter (when query matches an exchange name) */
  matchedExchange?: string
  /** Facet distribution from Meilisearch (platform counts, trader_type counts, etc.) */
  facetDistribution?: Record<string, Record<string, number>>
  /** true when Meilisearch is unavailable and results fell back to Supabase (slower, less fuzzy) */
  degraded?: boolean
}
