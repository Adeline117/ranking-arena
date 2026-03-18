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
 * SWR-based hook for fetching linked trader accounts.
 * Replaces raw useEffect + fetch in TraderProfileClient and TraderProfileView.
 */
export function useLinkedAccounts(platform: string | undefined, traderKey: string | undefined) {
  const key = platform && traderKey
    ? `/api/traders/aggregate?platform=${encodeURIComponent(platform)}&trader_key=${encodeURIComponent(traderKey)}`
    : null

  const { data, error, isLoading } = useSWR<LinkedAccountsResponse | null>(
    key,
    linkedAccountsFetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 60_000,
      errorRetryCount: 1,
    }
  )

  return {
    linkedAccounts: data?.accounts ?? [],
    aggregatedData: data?.aggregated ?? null,
    hasMultipleAccounts: (data?.accounts?.length ?? 0) >= 2,
    isLoading,
    error,
  }
}
