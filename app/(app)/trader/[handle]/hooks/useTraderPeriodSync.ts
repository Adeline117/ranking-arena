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
 *  - On store change: write the new period back to URL (replace, no scroll)
 *  - Skip the very first store-change tick (mount race — the init effect
 *    above hasn't propagated yet, so a naive sync would strip ?period=)
 *
 * Returns the current store period for the caller to render.
 */

import { useEffect, useRef } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { usePeriodStore } from '@/lib/stores/periodStore'

type Period = '7D' | '30D' | '90D'

export function useTraderPeriodSync(): Period {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const selectedPeriod = usePeriodStore(s => s.period)
  const setPeriod = usePeriodStore(s => s.setPeriod)

  // 1. URL → store on mount
  const urlPeriod = searchParams.get('period')
  useEffect(() => {
    if (urlPeriod && ['7D', '30D', '90D'].includes(urlPeriod)) {
      setPeriod(urlPeriod as Period)
    }
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
      router.replace(newPath, { scroll: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only sync when period changes
  }, [selectedPeriod])

  return selectedPeriod
}
