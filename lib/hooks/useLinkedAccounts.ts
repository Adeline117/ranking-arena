'use client'

import { useQuery } from '@tanstack/react-query'
import {
  parsePublicLinkedAggregate,
  type PublicLinkedAccount,
  type PublicLinkedAggregateData,
  type PublicLinkedAggregateResponse,
  type PublicLinkedSubject,
} from '@/lib/data/linked-trader-public'

export type LinkedAccountData = PublicLinkedAccount
export type AggregatedData = PublicLinkedAggregateData

type LinkedAccountsResponse = PublicLinkedAggregateResponse

export const linkedAccountsFetcher = async (
  url: string,
  expectedSubject: PublicLinkedSubject
): Promise<LinkedAccountsResponse> => {
  const res = await fetch(url)
  if (!res.ok) {
    const error = new Error(`Linked accounts request failed (${res.status})`) as Error & {
      status?: number
    }
    error.status = res.status
    throw error
  }
  const result = await res.json()
  if (result?.success !== true) {
    throw new Error('Linked accounts response failed its public contract')
  }
  const parsed = parsePublicLinkedAggregate(result?.data, expectedSubject)
  if (!parsed) throw new Error('Linked accounts response failed its public contract')
  return parsed
}

/**
 * React Query hook for the privacy-sensitive live linked-membership relation.
 * HTTP no-store is not enough: cached query data is hidden until this mount has
 * completed an exact subject-bound fetch, and it is hidden again while a live
 * revalidation is in flight or after an error.
 */
export function useLinkedAccounts(platform: string | undefined, traderKey: string | undefined) {
  const subject: PublicLinkedSubject | null = platform && traderKey ? { platform, traderKey } : null
  const shouldFetch = subject !== null
  const url = subject
    ? `/api/traders/aggregate?contract=2&platform=${encodeURIComponent(subject.platform)}&trader_key=${encodeURIComponent(subject.traderKey)}`
    : ''

  const {
    data: queryData,
    error,
    fetchStatus,
    isFetching,
    isFetchedAfterMount,
  } = useQuery<LinkedAccountsResponse>({
    queryKey: ['linked-accounts-v2', platform, traderKey],
    queryFn: () => linkedAccountsFetcher(url, subject!),
    enabled: shouldFetch,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    // Bound cross-device unlink staleness while the page stays continuously
    // visible; background tabs revalidate on focus instead of polling.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: 1,
  })

  const canPublishQueryData =
    shouldFetch && isFetchedAfterMount && fetchStatus === 'idle' && !isFetching && !error
  const data = canPublishQueryData ? queryData : undefined

  return {
    linkedAccounts: data?.accounts ?? [],
    aggregatedData: data?.aggregated ?? null,
    hasMultipleAccounts: (data?.accounts.length ?? 0) >= 2,
    isLoading: shouldFetch && (!isFetchedAfterMount || fetchStatus !== 'idle' || isFetching),
    error,
  }
}
