import type { UnifiedSearchResult } from '@/app/api/search/route'

export type SearchResultType = 'group' | 'post' | 'trader' | 'user'

export interface SearchResult {
  type: SearchResultType
  id: string
  title: string
  subtitle?: string
  meta?: string
  /**
   * Pre-built destination URL from the API. Trader and user identities are
   * composite/handle-based respectively, so callers must not derive a path
   * from the result id.
   */
  href?: string
  avatar?: string | null
  /** Structured metrics used only by trader rows. */
  roi?: number | null
  score?: number | null
}

export function mapPeopleSearchResults(users: UnifiedSearchResult[]): SearchResult[] {
  return users
    .filter((user) => user.type === 'user')
    .map((user) => ({
      type: 'user' as const,
      id: user.id,
      title: user.title,
      subtitle: user.subtitle && user.subtitle !== user.title ? user.subtitle : undefined,
      href: user.href,
      avatar: user.avatar,
    }))
}

export function getSearchResultHref(result: SearchResult): string {
  if (result.type === 'group') return `/groups/${result.id}`
  if (result.type === 'post') return `/post/${result.id}`
  // These URLs encode identity information that is not recoverable from id:
  // traders carry ?platform= and users route by public handle rather than UUID.
  if (result.type === 'trader' || result.type === 'user') return result.href ?? '#'
  return '#'
}
