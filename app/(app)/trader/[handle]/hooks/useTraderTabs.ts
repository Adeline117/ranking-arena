'use client'

/**
 * useTraderTabs — owns the trader-detail tab navigation state.
 *
 * Extracted from TraderProfileClient.tsx (2026-04-09 perf session).
 *
 * Manages:
 *  - Tab key list (overview/stats/portfolio + posts if claimed)
 *  - Active tab state (initialized from `?tab=` URL param)
 *  - Visited-tab tracking — only mount heavy tab content (StatsPage,
 *    PortfolioTable, charts) on first visit, while SwipeableView still
 *    lays out placeholders for non-visited tabs
 *  - Change handler that writes the active tab back to URL
 */

import { useState, useMemo, useCallback } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'

export type TraderTabKey = 'overview' | 'stats' | 'portfolio' | 'posts'

export interface UseTraderTabsResult {
  tabKeys: TraderTabKey[]
  activeTab: TraderTabKey
  visitedTabs: Set<TraderTabKey>
  handleTabChange: (tab: TraderTabKey) => void
}

export function useTraderTabs(claimedUser: unknown): UseTraderTabsResult {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const tabKeys = useMemo<TraderTabKey[]>(() => {
    const keys: TraderTabKey[] = ['overview', 'stats', 'portfolio']
    if (claimedUser) keys.push('posts')
    return keys
  }, [claimedUser])

  const urlTab = searchParams.get('tab')
  const initialTab: TraderTabKey =
    urlTab && tabKeys.includes(urlTab as TraderTabKey)
      ? (urlTab as TraderTabKey)
      : 'overview'
  const [activeTab, setActiveTab] = useState<TraderTabKey>(initialTab)
  const [visitedTabs, setVisitedTabs] = useState<Set<TraderTabKey>>(
    () => new Set([initialTab])
  )

  const handleTabChange = useCallback(
    (tab: TraderTabKey) => {
      setActiveTab(tab)
      setVisitedTabs((prev) => {
        if (prev.has(tab)) return prev
        const next = new Set(prev)
        next.add(tab)
        return next
      })
      const params = new URLSearchParams(searchParams.toString())
      if (tab === 'overview') {
        params.delete('tab')
      } else {
        params.set('tab', tab)
      }
      const qs = params.toString()
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [searchParams, pathname, router]
  )

  return { tabKeys, activeTab, visitedTabs, handleTabChange }
}
