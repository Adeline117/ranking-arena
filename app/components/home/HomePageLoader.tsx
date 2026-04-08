'use client'

import dynamic from 'next/dynamic'
import { useState, useEffect, useLayoutEffect } from 'react'
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
    // Render Phase 2 on first user interaction (locks LCP at SSR time)
    let done = false
    const activate = () => {
      if (done) return
      done = true
      setActivated(true)
      cleanup()
    }
    const cleanup = () => {
      window.removeEventListener('scroll', activate)
      window.removeEventListener('click', activate)
      window.removeEventListener('keydown', activate)
      window.removeEventListener('touchstart', activate)
    }
    window.addEventListener('scroll', activate, { once: true, passive: true })
    window.addEventListener('click', activate, { once: true })
    window.addEventListener('keydown', activate, { once: true })
    window.addEventListener('touchstart', activate, { once: true, passive: true })

    // Fallback: activate via requestIdleCallback (fires when CPU is free).
    // On fast devices: ~50ms. On throttled Lighthouse: after JS parsing finishes.
    // 4s hard cap — shorter timeout reduces Lighthouse LCP (Phase 2 renders sooner).
    const ric = typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback
      : ((cb: IdleRequestCallback) => setTimeout(cb, 100)) as typeof requestIdleCallback
    const idleHandle = ric(activate, { timeout: 4000 })
    return () => {
      cleanup()
      if (typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleHandle)
      }
    }
  }, [])

  // Hide SSR ranking table BEFORE the browser paints Phase 2 (useLayoutEffect
  // runs synchronously after DOM mutations, before paint). Without this, both
  // SSR content (~2600px) and Phase 2 content coexist for one frame → CLS.
  //
  // #ssr-topnav is NOT hidden — Phase 2 portals its interactive TopNav into it.
  // This keeps the 56px container in place, preventing a separate CLS source.
  useLayoutEffect(() => {
    if (!activated) return
    const ssrTable = document.getElementById('ssr-ranking-table')
    if (ssrTable) ssrTable.style.display = 'none'
    // Clear SSR topnav HTML so Phase 2 can portal into the empty container
    const ssrNav = document.getElementById('ssr-topnav')
    if (ssrNav) ssrNav.innerHTML = ''
    // Fully remove ranking table from DOM after paint
    requestAnimationFrame(() => {
      ssrTable?.remove()
    })
  }, [activated])

  if (!activated) return null
  // Homepage root layout has no Providers (for LCP optimization).
  // Phase 2 needs ToastProvider, QueryClient, etc. — wrap here on client only.
  return <Providers><HomePage {...props} /></Providers>
}
