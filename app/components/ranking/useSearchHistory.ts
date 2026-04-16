/**
 * Search history management via localStorage.
 * Provides helpers to load, save, add, remove, and clear search history.
 */

const LS_KEY_SEARCH_HISTORY = 'arena_search_history'
const MAX_HISTORY_ITEMS = 10

export function getSearchHistory(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const stored = localStorage.getItem(LS_KEY_SEARCH_HISTORY)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
        return parsed.slice(0, MAX_HISTORY_ITEMS)
      }
    }
  } catch {
    /* ignore */
  }
  return []
}

export function saveSearchHistory(history: string[]) {
  try {
    localStorage.setItem(LS_KEY_SEARCH_HISTORY, JSON.stringify(history.slice(0, MAX_HISTORY_ITEMS)))
  } catch {
    /* ignore */
  }
}

export function addToHistory(query: string): string[] {
  const trimmed = query.trim()
  if (!trimmed) return getSearchHistory()
  const existing = getSearchHistory().filter((h) => h !== trimmed)
  const updated = [trimmed, ...existing].slice(0, MAX_HISTORY_ITEMS)
  saveSearchHistory(updated)
  return updated
}

export function removeFromHistory(query: string): string[] {
  const updated = getSearchHistory().filter((h) => h !== query)
  saveSearchHistory(updated)
  return updated
}

export function clearAllHistory(): string[] {
  saveSearchHistory([])
  return []
}
