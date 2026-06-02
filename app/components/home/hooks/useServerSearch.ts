'use client'

/**
 * useServerSearch — server-side search fallback for ranking table.
 *
 * When client-side search returns 0 results, this hook makes an API call
 * to search across all traders in the database.
 *
 * Uses React Query for automatic deduplication, caching, and abort handling.
 */

import { useQuery } from '@tanstack/react-query'
import { STALE_STANDARD } from '@/lib/hooks/cache-presets'
import type { Trader } from '../../ranking/RankingTable'
import type { TimeRange } from '../hooks/useTraderData'

interface UseServerSearchOptions {
  searchQuery: string
  activeTimeRange: TimeRange
  clientHasResults: boolean
}

async function fetchServerSearch(
  query: string,
  period: string,
  signal: AbortSignal
): Promise<Trader[]> {
  const res = await fetch(
    `/api/search?q=${encodeURIComponent(query)}&period=${period || '90D'}&limit=20`,
    { signal }
  )
  if (!res.ok) return []
  const json = await res.json()
  return json.success && Array.isArray(json.data) ? json.data : []
}

export function useServerSearch({
  searchQuery,
  activeTimeRange,
  clientHasResults,
}: UseServerSearchOptions) {
  const q = searchQuery.trim().toLowerCase()
  const enabled = q.length >= 2 && !clientHasResults

  const { data: serverSearchResults = [] } = useQuery<Trader[]>({
    queryKey: ['server-search', q, activeTimeRange],
    queryFn: ({ signal }) => fetchServerSearch(q, activeTimeRange, signal),
    enabled,
    staleTime: STALE_STANDARD,
    gcTime: 60_000, // 1min cache
    placeholderData: (prev) => prev ?? [], // Keep previous results during refetch
    retry: false,
  })

  return { serverSearchResults: enabled ? serverSearchResults : [] }
}
