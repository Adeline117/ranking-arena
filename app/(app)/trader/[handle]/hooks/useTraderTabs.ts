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

import { useState, useMemo, useCallback, useEffect } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'

export type TraderTabKey = 'overview' | 'stats' | 'portfolio' | 'posts'

export interface UseTraderTabsResult {
  tabKeys: TraderTabKey[]
  activeTab: TraderTabKey
  visitedTabs: Set<TraderTabKey>
  handleTabChange: (tab: TraderTabKey) => void
}

interface UrlTabSelection {
  tab: TraderTabKey
  invalid: boolean
}

interface PendingTabSelection {
  /** Exact search snapshot from which the replacement navigation began. */
  sourceSearchParams: string
  tab: TraderTabKey
}

export function useTraderTabs(claimedUser: unknown): UseTraderTabsResult {
  const { replace } = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const searchParamsString = searchParams.toString()
  const canViewPosts = Boolean(claimedUser)

  const tabKeys = useMemo<TraderTabKey[]>(() => {
    const keys: TraderTabKey[] = ['overview', 'stats', 'portfolio']
    if (canViewPosts) keys.push('posts')
    return keys
  }, [canViewPosts])

  const urlSelection = useMemo<UrlTabSelection>(() => {
    const params = new URLSearchParams(searchParamsString)
    const values = params.getAll('tab')
    if (values.length === 0) return { tab: 'overview', invalid: false }
    if (values.length !== 1) return { tab: 'overview', invalid: true }

    const value = values[0]
    return tabKeys.includes(value as TraderTabKey)
      ? { tab: value as TraderTabKey, invalid: false }
      : { tab: 'overview', invalid: true }
  }, [searchParamsString, tabKeys])

  const [pendingSelection, setPendingSelection] = useState<PendingTabSelection | null>(null)
  const [storedVisitedTabs, setStoredVisitedTabs] = useState<Set<TraderTabKey>>(
    () => new Set([urlSelection.tab])
  )

  // The URL is authoritative after any search snapshot change. The sole
  // exception is the optimistic selection between a click and its replace()
  // navigation landing. Capability loss invalidates both sources immediately.
  const pendingTab =
    pendingSelection?.sourceSearchParams === searchParamsString &&
    tabKeys.includes(pendingSelection.tab)
      ? pendingSelection.tab
      : null
  const activeTab: TraderTabKey = urlSelection.invalid
    ? 'overview'
    : (pendingTab ?? urlSelection.tab)

  // Include the URL-selected tab synchronously so a back/forward navigation
  // cannot render a one-frame empty lazy panel. Also prune Posts immediately
  // when claimed identity is withdrawn.
  const visitedTabs = useMemo(() => {
    const next = new Set<TraderTabKey>()
    for (const tab of storedVisitedTabs) {
      if (tabKeys.includes(tab)) next.add(tab)
    }
    next.add(activeTab)
    return next
  }, [activeTab, storedVisitedTabs, tabKeys])

  useEffect(() => {
    // A changed URL snapshot (including browser history) is authoritative.
    // Capability withdrawal also clears a pending Posts click so it cannot
    // resurface if the claimed value later changes again.
    setPendingSelection(null)

    if (!urlSelection.invalid) return
    const params = new URLSearchParams(searchParamsString)
    params.delete('tab')
    const query = params.toString()
    replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false })
  }, [canViewPosts, pathname, replace, searchParamsString, urlSelection.invalid])

  useEffect(() => {
    setStoredVisitedTabs((previous) => {
      const next = new Set<TraderTabKey>()
      for (const tab of previous) {
        if (tabKeys.includes(tab)) next.add(tab)
      }
      next.add(activeTab)
      if (next.size === previous.size && [...next].every((tab) => previous.has(tab)))
        return previous
      return next
    })
  }, [activeTab, tabKeys])

  const handleTabChange = useCallback(
    (tab: TraderTabKey) => {
      const nextTab = tabKeys.includes(tab) ? tab : 'overview'
      setPendingSelection({ sourceSearchParams: searchParamsString, tab: nextTab })
      setStoredVisitedTabs((previous) => {
        if (previous.has(nextTab)) return previous
        const next = new Set(previous)
        next.add(nextTab)
        return next
      })
      const params = new URLSearchParams(searchParamsString)
      if (nextTab === 'overview') {
        params.delete('tab')
      } else {
        params.set('tab', nextTab)
      }
      const qs = params.toString()
      replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
      // Scroll tab content into view on tab change (prevents seeing previous tab's scroll position)
      requestAnimationFrame(() => {
        document
          .getElementById('trader-tab-content')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    },
    [pathname, replace, searchParamsString, tabKeys]
  )

  return { tabKeys, activeTab, visitedTabs, handleTabChange }
}
