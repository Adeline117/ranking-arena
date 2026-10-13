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

/** Visible-tab polling cadence for the live membership relation. */
export const LINKED_ACCOUNTS_REFETCH_INTERVAL_MS = 60_000
/** A hung revalidation becomes an error (which withdraws data) after this. */
export const LINKED_ACCOUNTS_FETCH_TIMEOUT_MS = 15_000
/**
 * Maximum age of the last authoritative read that may stay visible while a
 * same-subject background revalidation is in flight. Together with the fetch
 * timeout this bounds cross-device unlink staleness to ~one polling interval;
 * older data (e.g. returning to a long-hidden tab) is withdrawn as before.
 */
export const LINKED_ACCOUNTS_MAX_HOLD_MS =
  LINKED_ACCOUNTS_REFETCH_INTERVAL_MS + LINKED_ACCOUNTS_FETCH_TIMEOUT_MS

function withFetchTimeout(signal: AbortSignal | undefined): AbortSignal | undefined {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') {
    return signal
  }
  const timeout = AbortSignal.timeout(LINKED_ACCOUNTS_FETCH_TIMEOUT_MS)
  if (!signal) return timeout
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal
}

export const linkedAccountsFetcher = async (
  url: string,
  expectedSubject: PublicLinkedSubject,
  signal?: AbortSignal
): Promise<LinkedAccountsResponse> => {
  const res = await fetch(url, { signal: withFetchTimeout(signal) })
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
 * completed an exact subject-bound fetch, and it is hidden again after a
 * revalidation error or while a revalidation is paused (offline).
 *
 * While a same-subject background revalidation is actively in flight (polling
 * or focus), the last authoritative read stays visible as long as it is at most
 * LINKED_ACCOUNTS_MAX_HOLD_MS old — withdrawing it on every poll made the
 * linked-accounts UI flicker / shift layout every interval. A subject change
 * never inherits the previous subject's data (the query key changes and the
 * new key must complete its own post-mount read).
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
    dataUpdatedAt,
  } = useQuery<LinkedAccountsResponse>({
    queryKey: ['linked-accounts-v2', platform, traderKey],
    queryFn: ({ signal }) => linkedAccountsFetcher(url, subject!, signal),
    enabled: shouldFetch,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    // Bound cross-device unlink staleness while the page stays continuously
    // visible; background tabs revalidate on focus instead of polling.
    refetchInterval: LINKED_ACCOUNTS_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: 1,
  })

  const settledReady =
    shouldFetch &&
    isFetchedAfterMount &&
    fetchStatus === 'idle' &&
    !isFetching &&
    !error &&
    queryData !== undefined
  // Same-subject background revalidation: keep the previous authoritative
  // read (bounded by age) instead of blanking the UI mid-fetch.
  const backgroundHold =
    shouldFetch &&
    isFetchedAfterMount &&
    fetchStatus === 'fetching' &&
    !error &&
    queryData !== undefined &&
    dataUpdatedAt > 0 &&
    Date.now() - dataUpdatedAt <= LINKED_ACCOUNTS_MAX_HOLD_MS
  const authoritativeReady = settledReady || backgroundHold
  const data = authoritativeReady ? queryData : undefined

  return {
    linkedAccounts: data?.accounts ?? [],
    aggregatedData: data?.aggregated ?? null,
    hasMultipleAccounts: (data?.accounts.length ?? 0) >= 2,
    isLoading:
      shouldFetch &&
      !backgroundHold &&
      (!isFetchedAfterMount || fetchStatus !== 'idle' || isFetching),
    authoritativeReady,
    error,
  }
}
