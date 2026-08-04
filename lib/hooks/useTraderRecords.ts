'use client'

/**
 * useTraderRecords — heavy-tab record pages, fetched ONLY when the tab is
 * actually opened (spec §2.4-3; wire `enabled` to the existing visitedTabs
 * lazy-mount mechanism so lazy-mount becomes lazy-fetch).
 *
 * useCopierAggregate — the copiers tab is aggregate-only (spec §6); it is
 * a plain query, never paginated rows.
 */

import { useEffect, useMemo } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetcher } from '@/lib/hooks/fetchers'
import { STALE_STANDARD } from '@/lib/hooks/cache-presets'
import {
  RECORDS_CURSOR_INVALIDATED_CODE,
  type CopierAggregate,
  type HistoryCompleteness,
  type RecordKind,
  type RecordProvenance,
  type RecordsPage,
  type ServingTimeframe,
} from '@/lib/data/serving/types'
import type { ApiSuccessResponse } from '@/lib/types/index'

const POSITION_HISTORY_RECORDS_CONTRACT = 'vph3' as const

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
  // This stable generation marker changes the CDN/browser cache key at the
  // quarantined -> verified rollout boundary. Older cacheable first pages cannot
  // be replayed into the new cursor-reset protocol.
  if (kind === 'position_history') {
    params.set('records_contract', POSITION_HISTORY_RECORDS_CONTRACT)
  }
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isRecordsCursorInvalidated(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const candidate = error as { status?: unknown; info?: unknown }
  if (candidate.status !== 409 || !isPlainRecord(candidate.info)) return false
  const detail = candidate.info.error
  return isPlainRecord(detail) && detail.code === RECORDS_CURSOR_INVALIDATED_CODE
}

function combinedHistoryCompleteness(
  kind: Exclude<RecordKind, 'copiers'>,
  pages: RecordsPage[]
): HistoryCompleteness | null {
  if (kind !== 'position_history' || pages.length === 0) return null

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

function mayDisplayPageRows(kind: Exclude<RecordKind, 'copiers'>, page: RecordsPage): boolean {
  // Tier-C rows are an explicitly labelled partial preview. Warm rows claim
  // durable authority and therefore require the exact complete verdict that
  // the server derived from the @2 publication envelope.
  return (
    kind !== 'position_history' ||
    page.cacheState === 'cold-fetched' ||
    page.completeness?.state === 'complete'
  )
}

function mayRequestNextPage(kind: Exclude<RecordKind, 'copiers'>, page: RecordsPage): boolean {
  return kind !== 'position_history' || page.completeness?.state === 'complete'
}

export function useTraderRecords({
  source,
  exchangeTraderId,
  kind,
  tf = 90,
  enabled = false,
}: UseTraderRecordsOptions) {
  const queryClient = useQueryClient()
  const queryKey = useMemo(
    () =>
      [
        'trader-records',
        source,
        exchangeTraderId,
        kind,
        tf,
        kind === 'position_history' ? POSITION_HISTORY_RECORDS_CONTRACT : null,
      ] as const,
    [exchangeTraderId, kind, source, tf]
  )
  const query = useInfiniteQuery<RecordsPage>({
    queryKey,
    queryFn: async ({ pageParam }) => {
      const res = await fetcher<ApiSuccessResponse<RecordsPage>>(
        recordsUrl(exchangeTraderId, source, kind, tf, pageParam as string | undefined)
      )
      return res.data
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      mayRequestNextPage(kind, lastPage) ? (lastPage.nextCursor ?? undefined) : undefined,
    enabled: enabled && Boolean(source) && Boolean(exchangeTraderId),
    staleTime: STALE_STANDARD,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) => !isRecordsCursorInvalidated(error) && failureCount < 2,
  })

  const cursorInvalidated = isRecordsCursorInvalidated(query.error)
  useEffect(() => {
    if (!cursorInvalidated) return
    // resetQueries discards every old page/pageParam before refetching page 1;
    // retrying only the rejected cursor would preserve a mixed generation.
    void queryClient.resetQueries({
      queryKey,
      exact: true,
    })
  }, [cursorInvalidated, queryClient, queryKey])

  const pages = query.data?.pages ?? []
  const rows = pages.flatMap((page) => (mayDisplayPageRows(kind, page) ? page.rows : []))
  const completeness = combinedHistoryCompleteness(kind, pages)
  const provenance = combinedRecordProvenance(source, pages)

  return {
    rows,
    provenance,
    completeness,
    /** First page is still cold-fetching upstream (Tier-C pending). */
    isPendingUpstream: pages.length === 1 && pages[0].cacheState === 'pending',
    isLoading: query.isLoading || cursorInvalidated,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    error: cursorInvalidated ? null : query.error,
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
