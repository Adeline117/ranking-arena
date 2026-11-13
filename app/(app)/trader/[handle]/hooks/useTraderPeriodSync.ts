'use client'

/**
 * useTraderPeriodSync — bidirectional URL ↔ period store sync.
 *
 * Extracted from TraderProfileClient.tsx as part of the conservative
 * refactor (2026-04-09 perf session) before the planned full Suspense
 * split. Zero behavioral change — same hook order, same effects, same
 * dependencies. The extraction just gives the period sync its own home
 * so it can be reasoned about and tested in isolation.
 *
 * Sync rules:
 *  - On mount: read `?period=` from URL and push it into the zustand store
 *  - On store change: write the new period back to URL (shallow
 *    history.replaceState — no RSC round-trip, no scroll)
 *  - Skip the very first store-change tick (mount race — the init effect
 *    above hasn't propagated yet, so a naive sync would strip ?period=)
 *
 * Returns the current store period for the caller to render.
 */

import { useEffect, useRef } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { usePeriodStore } from '@/lib/stores/periodStore'
import { replaceUrlShallow } from './replaceUrlShallow'

type Period = '7D' | '30D' | '90D'

export function useTraderPeriodSync(): Period {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const selectedPeriod = usePeriodStore((s) => s.period)
  const setPeriod = usePeriodStore((s) => s.setPeriod)

  // 1. URL → store on mount. The store is module-global, so without a reset a
  // trader opened in-app inherited the previous trader's period (e.g. 7D)
  // while its URL (no ?period=) meant the 90D default, and shared links
  // disagreed with what was shown. The URL is the source of truth.
  const urlPeriod = searchParams.get('period')
  useEffect(() => {
    setPeriod(urlPeriod && ['7D', '30D', '90D'].includes(urlPeriod) ? (urlPeriod as Period) : '90D')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount
  }, [])

  // 2. store → URL on change (skip first fire to avoid mount race)
  const periodSyncCountRef = useRef(0)
  useEffect(() => {
    if (periodSyncCountRef.current === 0) {
      periodSyncCountRef.current = 1
      return
    }
    const params = new URLSearchParams(searchParams.toString())
    if (selectedPeriod === '90D') {
      params.delete('period')
    } else {
      params.set('period', selectedPeriod)
    }
    const qs = params.toString()
    const newPath = `${pathname}${qs ? `?${qs}` : ''}`
    const currentPath = `${pathname}${searchParams.toString() ? `?${searchParams.toString()}` : ''}`
    if (newPath !== currentPath) {
      // Shallow: the server page does not read ?period=, avoid an RSC refetch.
      replaceUrlShallow(newPath)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only sync when period changes
  }, [selectedPeriod])

  return selectedPeriod
}
