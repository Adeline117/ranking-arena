export interface SearchResult {
  type: 'library' | 'group' | 'post' | 'trader'
  id: string
  title: string
  subtitle?: string
  meta?: string
}

export const SECTION_LIMIT = 5
export const SEARCH_HISTORY_KEY = 'arena_search_history'
export const MAX_HISTORY = 10

export function getSearchHistory(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

export function saveSearchHistory(query: string) {
  if (typeof window === 'undefined' || !query.trim()) return
  try {
    const history = getSearchHistory().filter(h => h !== query.trim())
    history.unshift(query.trim())
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)))
  } catch { /* ignore */ }
}

export function clearSearchHistory() {
  if (typeof window === 'undefined') return
  try { localStorage.removeItem(SEARCH_HISTORY_KEY) } catch { /* ignore */ }
}

export function getHref(result: SearchResult): string {
  if (result.type === 'library') return `/library/${result.id}`
  if (result.type === 'group') return `/groups/${result.id}`
  if (result.type === 'post') return `/post/${result.id}`
  if (result.type === 'trader') return `/trader/${encodeURIComponent(result.id)}`
  return '#'
}
