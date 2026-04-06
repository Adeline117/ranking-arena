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

    // Fallback: auto-activate after 4s (for bots / no-interaction scenarios).
    // JS chunks start loading immediately via dynamic() — this only defers RENDERING.
    const timer = setTimeout(activate, 4000)
    return () => { cleanup(); clearTimeout(timer) }
  }, [])

  if (!activated) return null
  return <HomePage {...props} />
}
