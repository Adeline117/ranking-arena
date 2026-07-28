'use client'

import dynamic from 'next/dynamic'
import { useState, useEffect } from 'react'
import type { InitialTrader, CategoryCounts } from '@/lib/getInitialTraders'

/**
 * HomePageLoader — keeps the provider-heavy Phase 2 graph out of the initial
 * homepage client chunk, then activates it after hydration.
 *
 * Why: LCP = LAST largest paint before user input. On slow 3G, the Phase 2
 * interactive table takes 8-13s to load and paint, resetting LCP from 1.2s
 * to 8-13s. By deferring Phase 2 until scroll/click/keypress, LCP stays
 * locked at the SSR paint time (~1.2s).
 *
 * The SSR hero + ranking table (rendered by page.tsx) remain visible and
 * fully usable until Phase 2 takes over.
 *
 * The async root owns Providers and every interactive homepage dependency, so
 * importing this loader cannot eagerly pull auth, QueryClient, or web3 code into
 * the first-paint dependency graph.
 */
const HomeInteractiveRoot = dynamic(() => import('./HomeInteractiveRoot'), {
  ssr: false,
  loading: () => null,
})

export interface HomePageLoaderProps {
  initialTraders?: InitialTrader[]
  initialLastUpdated?: string | null
  initialIsStale?: boolean
  heroStats?: { traderCount: number; sourceBoardCount: number }
  initialTotalCount?: number
  initialCategoryCounts?: CategoryCounts
}

export default function HomePageLoader(props: HomePageLoaderProps) {
  const [activated, setActivated] = useState(false)

  useEffect(() => {
    // Activate immediately — no deferral.
    // Previously deferred up to 2.5s to "lock LCP at SSR time" for Lighthouse.
    // But this caused a visible flash: users saw the rough SSR table for 2.5s,
    // then it abruptly swapped to the refined React table. The visual jump was
    // worse than any Lighthouse score improvement.
    setActivated(true)
  }, [])

  // SSR topnav removal is handled by HomePage.useLayoutEffect.
  // SSR ranking table is hidden by HomePageClient's useLayoutEffect
  // AFTER Phase 2 content has rendered (prevents CLS).

  if (!activated) {
    // Subtle top-of-viewport progress bar while Phase 2 loads.
    // SSR content is fully visible + interactive during this window;
    // the bar just signals that interactive features are coming.
    // Fades out automatically when Phase 2 mounts and this component
    // re-renders with activated=true.
    return (
      <div
        className="ssr-loading-bar"
        aria-hidden="true"
        role="progressbar"
        aria-label="Loading interactive features"
      />
    )
  }
  return <HomeInteractiveRoot {...props} />
}
