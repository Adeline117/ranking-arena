'use client'

import useSWR from 'swr'

export interface LinkedAccountData {
  id: string
  platform: string
  traderKey: string
  handle: string | null
  label: string | null
  isPrimary: boolean
  roi: number | null
  pnl: number | null
  arenaScore: number | null
  winRate: number | null
  maxDrawdown: number | null
  rank: number | null
}

export interface AggregatedData {
  combinedPnl: number
  bestRoi: { value: number; platform: string; traderKey: string } | null
  weightedScore: number
}

interface LinkedAccountsResponse {
  accounts: LinkedAccountData[]
  aggregated: AggregatedData | null
}

const linkedAccountsFetcher = async (url: string): Promise<LinkedAccountsResponse | null> => {
  const res = await fetch(url)
  if (!res.ok) return null
  const result = await res.json()
  if (result?.data?.totalAccounts >= 2) {
    return {
      accounts: result.data.accounts,
      aggregated: result.data.aggregated,
    }
  }
  return null
}

/**
 * P7: Parse bundled aggregate data (from merged trader detail endpoint) into LinkedAccountsResponse.
 * Returns null if the bundled data doesn't contain 2+ accounts.
 */
function parseBundledAggregate(
  bundled: { aggregated: unknown; accounts: unknown[]; totalAccounts: number } | undefined | null
): LinkedAccountsResponse | null {
  if (!bundled || bundled.totalAccounts < 2) return null
  return {
    accounts: bundled.accounts as LinkedAccountData[],
    aggregated: bundled.aggregated as AggregatedData | null,
  }
}

/**
 * SWR-based hook for fetching linked trader accounts.
 * Replaces raw useEffect + fetch in TraderProfileClient and TraderProfileView.
 *
 * P7: Accepts optional `bundledData` from the merged trader detail endpoint.
 * When bundled data is available, skips the separate /api/traders/aggregate call.
 */
export function useLinkedAccounts(
  platform: string | undefined,
  traderKey: string | undefined,
  bundledData?: { aggregated: unknown; accounts: unknown[]; totalAccounts: number } | null,
) {
  const parsedBundled = parseBundledAggregate(bundledData)

  // P7: Skip separate fetch when bundled data is available
  const key = (!parsedBundled && platform && traderKey)
    ? `/api/traders/aggregate?platform=${encodeURIComponent(platform)}&trader_key=${encodeURIComponent(traderKey)}`
    : null

  const { data: swrData, error, isLoading } = useSWR<LinkedAccountsResponse | null>(
    key,
    linkedAccountsFetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 60_000,
      errorRetryCount: 1,
    }
  )

  // Prefer bundled data, fall back to SWR data
  const data = parsedBundled ?? swrData

  return {
    linkedAccounts: data?.accounts ?? [],
    aggregatedData: data?.aggregated ?? null,
    hasMultipleAccounts: (data?.accounts?.length ?? 0) >= 2,
    isLoading: !parsedBundled && isLoading,
    error: parsedBundled ? undefined : error,
  }
}
