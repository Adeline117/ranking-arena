'use client'

/**
 * <DeferredMount delayMs={N} fallback={...}>{children}</DeferredMount>
 *
 * Renders the fallback (or null) for `delayMs` after mount, then swaps in
 * children. Used to stagger expensive client widgets that all want to fetch
 * data on mount, preventing the simultaneous network burst.
 *
 * Audit P1-PERF-2: HomePage Phase 2 mounts 4 sidebar widgets that each fire
 * their own SWR fetch on first render. Without staggering this is a 4-way
 * network burst that competes with the LCP repaint and inflates INP/TBT
 * by 200-800ms on slow networks.
 *
 * Use offsets like 0 / 800 / 1500 / 2200 ms across the 4 widgets to spread
 * the network and main-thread cost out.
 */

import { useEffect, useState, type ReactNode } from 'react'

interface Props {
  /** Delay before mounting children, in milliseconds. */
  delayMs: number
  /** Optional placeholder shown during the delay. Defaults to null. */
  fallback?: ReactNode
  children: ReactNode
}

export default function DeferredMount({ delayMs, fallback = null, children }: Props) {
  const [show, setShow] = useState(delayMs <= 0)

  useEffect(() => {
    if (delayMs <= 0) return
    // requestIdleCallback gives the main thread room to paint LCP first;
    // setTimeout guarantees the children appear within delayMs even if the
    // browser is permanently busy.
    const idleId =
      typeof window !== 'undefined' && 'requestIdleCallback' in window
        ? (window as Window & { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number })
            .requestIdleCallback(() => setShow(true), { timeout: delayMs })
        : null
    const timer = window.setTimeout(() => setShow(true), delayMs)
    return () => {
      if (idleId !== null && 'cancelIdleCallback' in window) {
        (window as Window & { cancelIdleCallback: (id: number) => void }).cancelIdleCallback(idleId)
      }
      window.clearTimeout(timer)
    }
  }, [delayMs])

  return <>{show ? children : fallback}</>
}
