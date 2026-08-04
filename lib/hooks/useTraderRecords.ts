'use client'

/**
 * useTraderRecords — heavy-tab record pages, fetched ONLY when the tab is
 * actually opened (spec §2.4-3; wire `enabled` to the existing visitedTabs
 * lazy-mount mechanism so lazy-mount becomes lazy-fetch).
 *
 * useCopierAggregate — the copiers tab is aggregate-only (spec §6); it is
 * a plain query, never paginated rows.
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { fetcher } from '@/lib/hooks/fetchers'
import { STALE_STANDARD } from '@/lib/hooks/cache-presets'
import type {
  CopierAggregate,
  HistoryCompleteness,
  RecordKind,
  RecordsPage,
  ServingTimeframe,
} from '@/lib/data/serving/types'
import type { ApiSuccessResponse } from '@/lib/types/index'

export interface UseTraderRecordsOptions {
  source: string
  exchangeTraderId: string
  kind: Exclude<RecordKind, 'copiers'>
  tf?: ServingTimeframe
  /** Wire to visitedTabs.has(tab) — no fetch until the tab is opened. */
  enabled?: boolean
}

function recordsUrl(
  exchangeTraderId: string,
  source: string,
  kind: RecordKind,
  tf: ServingTimeframe,
  cursor?: string
): string {
  const params = new URLSearchParams({ kind, source, tf: String(tf) })
  if (cursor) params.set('cursor', cursor)
  return `/api/traders/${encodeURIComponent(exchangeTraderId)}/records?${params.toString()}`
}

const UNBOUND_HISTORY: HistoryCompleteness = {
  state: 'unknown',
  reason: 'history_evidence_not_bound',
}

const LEGACY_TIER_C_PREVIEW: HistoryCompleteness = {
  state: 'partial',
  reason: 'interactive_preview',
}

function combinedHistoryCompleteness(
  kind: Exclude<RecordKind, 'copiers'>,
  pages: RecordsPage[]
): HistoryCompleteness | null {
  if (kind === 'positions' || pages.length === 0) return null

  const pageCompleteness = pages.map(
    (page) =>
      page.completeness ??
      (page.cacheState === 'cold-fetched' ? LEGACY_TIER_C_PREVIEW : UNBOUND_HISTORY)
  )

  // Pagination can only preserve or lower trust. One page without bound
  // evidence makes the combined history unknown; otherwise any partial page
  // keeps the whole result partial. Only an all-complete set is complete.
  return (
    pageCompleteness.find(({ state }) => state === 'unknown') ??
    pageCompleteness.find(({ state }) => state === 'partial') ??
    pageCompleteness[0]
  )
}

export function useTraderRecords({
  source,
  exchangeTraderId,
  kind,
  tf = 90,
  enabled = false,
}: UseTraderRecordsOptions) {
  const query = useInfiniteQuery<RecordsPage>({
    queryKey: ['trader-records', source, exchangeTraderId, kind, tf],
    queryFn: async ({ pageParam }) => {
      const res = await fetcher<ApiSuccessResponse<RecordsPage>>(
        recordsUrl(exchangeTraderId, source, kind, tf, pageParam as string | undefined)
      )
      return res.data
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: enabled && Boolean(source) && Boolean(exchangeTraderId),
    staleTime: STALE_STANDARD,
    refetchOnWindowFocus: false,
    retry: 2,
  })

  const pages = query.data?.pages ?? []
  const rows = pages.flatMap((p) => p.rows)
  const lastPage = pages[pages.length - 1]
  const completeness = combinedHistoryCompleteness(kind, pages)

  return {
    rows,
    provenance: lastPage?.provenance ?? null,
    completeness,
    /** First page is still cold-fetching upstream (Tier-C pending). */
    isPendingUpstream: pages.length === 1 && pages[0].cacheState === 'pending',
    isLoading: query.isLoading,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    error: query.error,
    refetch: query.refetch,
  }
}

export function useCopierAggregate(opts: {
  source: string
  exchangeTraderId: string
  enabled?: boolean
}) {
  const { source, exchangeTraderId, enabled = false } = opts
  const query = useQuery<CopierAggregate | { cacheState: 'pending' }>({
    queryKey: ['trader-copiers', source, exchangeTraderId],
    queryFn: async () => {
      const res = await fetcher<ApiSuccessResponse<CopierAggregate | { cacheState: 'pending' }>>(
        recordsUrl(exchangeTraderId, source, 'copiers', 90)
      )
      return res.data
    },
    enabled: enabled && Boolean(source) && Boolean(exchangeTraderId),
    staleTime: STALE_STANDARD,
    refetchOnWindowFocus: false,
  })

  const data = query.data
  const aggregate: CopierAggregate | null =
    data && 'copierCount' in data ? (data as CopierAggregate) : null

  return {
    aggregate,
    isPendingUpstream: Boolean(data && !('copierCount' in data)),
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  }
}
