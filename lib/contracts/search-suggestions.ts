/**
 * Transport-neutral response type for GET /api/search/suggestions (the `data`
 * member of the standard success envelope).
 *
 * The route builds its payload with these types and lib/contracts/core-api.ts
 * asserts them against the runtime zod contract. Keep this module free of
 * Next.js route/runtime imports.
 */

export interface SearchSuggestion {
  type: 'trader' | 'symbol' | 'keyword'
  value: string
  label: string
  subLabel?: string
  avatar?: string | null
  source?: string
  roi?: number
  arenaScore?: number
  rankingVisibility?: 'verified' | 'unknown'
}

/** Answer to a non-empty `q`. */
export interface SearchSuggestionsData {
  query: string
  suggestions: SearchSuggestion[]
}

/** Answer to a missing or blank `q`: no `query` key. */
export type EmptySearchSuggestionsData = Omit<SearchSuggestionsData, 'query'>
