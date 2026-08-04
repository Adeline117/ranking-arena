/**
 * Transport-neutral contract shared by the search API and its UI consumers.
 * Keep this module free of Next.js route/runtime imports so client code never
 * depends on an `app/api` implementation module.
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

export interface UnifiedSearchResponse {
  query: string
  results: {
    traders: UnifiedSearchResult[]
    posts: UnifiedSearchResult[]
    users: UnifiedSearchResult[]
    groups: UnifiedSearchResult[]
  }
  total: number
  /** "Did you mean" suggestions when few results are found. */
  suggestions?: string[]
  /** Matched exchange platform filter when the query matches an exchange name. */
  matchedExchange?: string
  /** Facet distribution from Meilisearch. */
  facetDistribution?: Record<string, Record<string, number>>
  /** Whether search fell back to the slower Supabase implementation. */
  degraded?: boolean
}
