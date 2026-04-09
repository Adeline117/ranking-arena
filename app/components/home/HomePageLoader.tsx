'use client'

import dynamic from 'next/dynamic'
import { useState, useEffect } from 'react'
import Providers from '../Providers'
import type { InitialTrader, CategoryCounts } from '@/lib/getInitialTraders'

/**
 * HomePageLoader — defers Phase 2 rendering until user interaction.
 *
 * Why: LCP = LAST largest paint before user input. On slow 3G, the Phase 2
 * interactive table takes 8-13s to load and paint, resetting LCP from 1.2s
 * to 8-13s. By deferring Phase 2 until scroll/click/keypress, LCP stays
 * locked at the SSR paint time (~1.2s).
 *
 * The SSR hero + ranking table (rendered by page.tsx) remain visible and
 * fully usable until Phase 2 takes over.
 *
 * Fallback: renders after 4s even without interaction (covers Lighthouse
 * where there's no user input).
 */
const HomePage = dynamic(() => import('./HomePage'), {
  ssr: false,
  loading: () => null,
})

interface HomePageLoaderProps {
  initialTraders?: InitialTrader[]
  initialLastUpdated?: string | null
  heroStats?: { traderCount: number; exchangeCount: number }
  initialTotalCount?: number
  initialCategoryCounts?: CategoryCounts
}

export default function HomePageLoader(props: HomePageLoaderProps) {
  const [activated, setActivated] = useState(false)

  useEffect(() => {
    // Render Phase 2 on first user interaction (locks LCP at SSR time).
    //
    // Critical: do NOT listen for `scroll` or `touchstart` — on mobile, the first
    // scroll gesture fires touchstart immediately, which would activate Phase 2
    // mid-gesture. Phase 2 chunks loading + SSR table swap in the middle of a
    // scroll interrupts the user's motion and feels janky.
    //
    // Instead: listen for `pointermove` (fires on hover/drag AFTER acquisition),
    // `pointerdown` on non-scroll elements (buttons), and `keydown`. Scroll itself
    // is handled by the idle-callback fallback below, which preloads Phase 2
    // during idle time BEFORE the user scrolls.
    let done = false
    const activate = () => {
      if (done) return
      done = true
      setActivated(true)
      cleanup()
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', activate)
      window.removeEventListener('click', activate)
      window.removeEventListener('keydown', activate)
    }
    window.addEventListener('pointermove', activate, { once: true, passive: true })
    window.addEventListener('click', activate, { once: true })
    window.addEventListener('keydown', activate, { once: true })

    // Preload Phase 2 proactively during idle time.
    // On fast devices: fires almost immediately after LCP paint, so Phase 2 is
    // ready by the time the user scrolls. On throttled devices (Lighthouse,
    // slow CPUs): 2.5s hard cap. Shorter than the previous 4s so Phase 2 is
    // usually ready before the first real user interaction.
    const ric = typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback
      : ((cb: IdleRequestCallback) => setTimeout(cb, 100)) as typeof requestIdleCallback
    const idleHandle = ric(activate, { timeout: 2500 })
    return () => {
      cleanup()
      if (typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleHandle)
      }
    }
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
  // Homepage root layout has no Providers (for LCP optimization).
  // Phase 2 needs ToastProvider, QueryClient, etc. — wrap here on client only.
  return <Providers><HomePage {...props} /></Providers>
}
