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
  RecordProvenance,
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
  const states = pages.map(
    (page) =>
      page.completeness ??
      (page.cacheState === 'cold-fetched' ? LEGACY_TIER_C_PREVIEW : UNBOUND_HISTORY)
  )
  // Pagination must never upgrade a weaker page. Unknown evidence is weaker
  // than a known partial preview; only an all-complete set may be complete.
  return (
    states.find((completeness) => completeness.state === 'unknown') ??
    states.find((completeness) => completeness.state === 'partial') ??
    states[0]
  )
}

function oldestCompleteClock(
  pages: RecordsPage[],
  key: 'sourceAsOf' | 'observedAt' | 'publishedAt'
): string | null {
  const values = pages.map((page) => page.provenance[key])
  if (
    values.some(
      (value) =>
        value === null ||
        typeof value !== 'string' ||
        value.trim() !== value ||
        !Number.isFinite(Date.parse(value))
    )
  ) {
    return null
  }
  return (values as string[]).reduce((oldest, value) =>
    Date.parse(value) < Date.parse(oldest) ? value : oldest
  )
}

function combinedRecordProvenance(source: string, pages: RecordsPage[]): RecordProvenance | null {
  if (pages.length === 0) return null
  return {
    source,
    sourceAsOf: oldestCompleteClock(pages, 'sourceAsOf'),
    observedAt: oldestCompleteClock(pages, 'observedAt'),
    publishedAt: oldestCompleteClock(pages, 'publishedAt'),
  }
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
  const completeness = combinedHistoryCompleteness(kind, pages)
  const provenance = combinedRecordProvenance(source, pages)

  return {
    rows,
    provenance,
    completeness,
    /** First page is still cold-fetching upstream (Tier-C pending). */
    isPendingUpstream: pages.length === 1 && pages[0].cacheState === 'pending',
    isLoading: query.isLoading,
    /** No cached page exists, so the module has nothing truthful to preserve. */
    isInitialError: query.isLoadingError,
    /** A later page failed; keep the successful pages visible and retry in place. */
    isFetchNextPageError: query.isFetchNextPageError,
    /** A background refresh failed; cached pages remain visible but must be disclosed. */
    isRefetchError: query.isRefetchError,
    isRefetching: query.isRefetching,
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
    data && 'copierCount' in data
      ? {
          ...data,
          // Old cached responses predate the completeness field. They must
          // fail closed instead of silently presenting an aggregate as whole.
          completeness: data.completeness ?? UNBOUND_HISTORY,
        }
      : null

  return {
    aggregate,
    isPendingUpstream: Boolean(data && !('copierCount' in data)),
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  }
}
