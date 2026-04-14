/**
 * Search History Service
 *
 * Provides unified search history management:
 * - Anonymous users: localStorage only
 * - Logged-in users: Supabase sync with localStorage fallback
 *
 * Storage key: 'arena_search_history'
 */

import { supabase as _supabase } from '@/lib/supabase/client'
import type { SupabaseClient } from '@supabase/supabase-js'
const supabase = _supabase as SupabaseClient
import { logger } from '@/lib/logger'

const STORAGE_KEY = 'arena_search_history'
const MAX_HISTORY_ITEMS = 10

export interface SearchHistoryItem {
  query: string
  timestamp: number
}

/**
 * Get search history from localStorage
 */
export function getLocalHistory(): string[] {
  if (typeof window === 'undefined') return []

  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return []
    return JSON.parse(stored)
  } catch (err) {
    logger.debug('[search-history] failed to parse local history:', err instanceof Error ? err.message : String(err))
    return []
  }
}

/**
 * Save search history to localStorage
 */
export function saveLocalHistory(history: string[]): void {
  if (typeof window === 'undefined') return

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, MAX_HISTORY_ITEMS)))
  } catch (err) {
    logger.debug('[search-history] localStorage write failed:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Add a search query to history
 */
export async function addToHistory(query: string, userId?: string): Promise<string[]> {
  const trimmed = query.trim()
  if (!trimmed) return getLocalHistory()

  // Update local history first (for immediate UI feedback)
  const currentHistory = getLocalHistory()
  const newHistory = [
    trimmed,
    ...currentHistory.filter(item => item !== trimmed)
  ].slice(0, MAX_HISTORY_ITEMS)

  saveLocalHistory(newHistory)

  // Sync to server if user is logged in
  if (userId) {
    try {
      await syncHistoryToServer(userId, newHistory)
    } catch (error) {
      logger.error('Failed to sync search history:', error)
    }
  }

  return newHistory
}

/**
 * Remove a search query from history
 */
export async function removeFromHistory(query: string, userId?: string): Promise<string[]> {
  const currentHistory = getLocalHistory()
  const newHistory = currentHistory.filter(item => item !== query)

  saveLocalHistory(newHistory)

  // Sync to server if user is logged in
  if (userId) {
    try {
      await syncHistoryToServer(userId, newHistory)
    } catch (error) {
      logger.error('Failed to sync search history:', error)
    }
  }

  return newHistory
}

/**
 * Clear all search history
 */
export async function clearHistory(userId?: string): Promise<void> {
  saveLocalHistory([])

  // Clear on server if user is logged in
  if (userId) {
    try {
      await syncHistoryToServer(userId, [])
    } catch (error) {
      logger.error('Failed to clear search history:', error)
    }
  }
}

/**
 * Sync search history to Supabase
 */
async function syncHistoryToServer(userId: string, history: string[]): Promise<void> {
  const historyItems: SearchHistoryItem[] = history.map((query, index) => ({
    query,
    timestamp: Date.now() - index * 1000 // Preserve order
  }))

  const { error } = await supabase
    .from('user_profiles')
    .update({ search_history: historyItems })
    .eq('id', userId)

  if (error) {
    throw error
  }
}

/**
 * Load search history from server and merge with local
 */
export async function loadAndMergeHistory(userId: string): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('search_history')
      .eq('id', userId)
      .single()

    if (error) throw error

    const serverHistory = (data?.search_history as SearchHistoryItem[] | null) || []
    const localHistory = getLocalHistory()

    // Merge histories, preferring more recent items
    const mergedMap = new Map<string, number>()

    serverHistory.forEach(item => {
      mergedMap.set(item.query, item.timestamp)
    })

    localHistory.forEach((query, index) => {
      const localTimestamp = Date.now() - index * 1000
      if (!mergedMap.has(query) || mergedMap.get(query)! < localTimestamp) {
        mergedMap.set(query, localTimestamp)
      }
    })

    // Sort by timestamp (most recent first) and take top items
    const merged = Array.from(mergedMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_HISTORY_ITEMS)
      .map(([query]) => query)

    // Save merged history to both local and server
    saveLocalHistory(merged)

    // Update server with merged history
    const historyItems: SearchHistoryItem[] = merged.map((query, index) => ({
      query,
      timestamp: Date.now() - index * 1000
    }))

    await supabase
      .from('user_profiles')
      .update({ search_history: historyItems })
      .eq('id', userId)

    return merged
  } catch (error) {
    logger.error('Failed to load search history from server:', error)
    return getLocalHistory()
  }
}

/**
 * Hook-friendly function to initialize history
 */
export async function initializeHistory(userId?: string): Promise<string[]> {
  if (userId) {
    return loadAndMergeHistory(userId)
  }
  return getLocalHistory()
}
