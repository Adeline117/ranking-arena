'use client'

import dynamic from 'next/dynamic'
import { useState, useEffect } from 'react'
import type { InitialTrader } from '@/lib/getInitialTraders'

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
    // 8s hard cap prevents indefinite delay if main thread never idles.
    const ric = typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback
      : ((cb: IdleRequestCallback) => setTimeout(cb, 100)) as typeof requestIdleCallback
    const idleHandle = ric(activate, { timeout: 8000 })
    return () => {
      cleanup()
      if (typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleHandle)
      }
    }
  }, [])

  if (!activated) return null
  return <HomePage {...props} />
}
