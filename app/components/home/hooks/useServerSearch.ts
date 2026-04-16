'use client'

/**
 * useServerSearch — server-side search fallback for ranking table.
 *
 * When client-side search returns 0 results, this hook makes an API call
 * to search across all traders in the database.
 */

import { useState, useEffect, useRef } from 'react'
import type { Trader } from '../../ranking/RankingTable'
import type { TimeRange } from '../hooks/useTraderData'

interface UseServerSearchOptions {
  searchQuery: string
  activeTimeRange: TimeRange
  clientHasResults: boolean
}

export function useServerSearch({ searchQuery, activeTimeRange, clientHasResults }: UseServerSearchOptions) {
  const [serverSearchResults, setServerSearchResults] = useState<Trader[]>([])
  const serverSearchAbortRef = useRef<AbortController | null>(null)
  const lastServerQueryRef = useRef('')

  useEffect(() => {
    const q = searchQuery.trim().toLowerCase()
    if (q.length < 2) {
      setServerSearchResults([])
      lastServerQueryRef.current = ''
      return
    }

    // Skip server search if client already has results
    if (clientHasResults) {
      setServerSearchResults([])
      return
    }

    // Debounce server search
    if (q === lastServerQueryRef.current) return

    const timeout = setTimeout(async () => {
      if (serverSearchAbortRef.current) serverSearchAbortRef.current.abort()
      const controller = new AbortController()
      serverSearchAbortRef.current = controller

      try {
        lastServerQueryRef.current = q
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(q)}&period=${activeTimeRange || '90D'}&limit=20`,
          { signal: controller.signal }
        )
        if (!res.ok) return
        const json = await res.json()
        if (json.success && Array.isArray(json.data)) {
          setServerSearchResults(json.data)
        }
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          console.warn('[ServerSearch] failed:', err.message)
        }
      }
    }, 500)

    return () => {
      clearTimeout(timeout)
      if (serverSearchAbortRef.current) serverSearchAbortRef.current.abort()
    }
  }, [searchQuery, activeTimeRange, clientHasResults])

  return { serverSearchResults }
}
