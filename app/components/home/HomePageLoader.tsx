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

// Web Vitals + SpeedInsights: homepage uses root layout (not (app)/layout.tsx
// where these live), so we lazy-load them here when Phase 2 activates.
const WelcomeBanner = dynamic(() => import('./WelcomeBanner'), { ssr: false })

// 对比浮条(2026-07-04 #5):首页走 root layout 无 Providers,CompareFloatingBar
// 只挂在 (app)/layout,导致首页勾选交易员后浮条不出现、对比功能被隐藏。在 Phase 2
// 激活后(已进 Providers,含 LanguageProvider)挂载它,不进 LCP/SSR 路径。
// 数据来自 zustand comparisonStore(无需 provider),仅依赖 useLanguage。
const CompareFloatingBar = dynamic(() => import('../trader/CompareFloatingBar'), { ssr: false })

const WebVitals = dynamic(
  () => import('../Providers/WebVitals').then((m) => ({ default: m.WebVitals })),
  { ssr: false }
)
const SpeedInsights = dynamic(
  () => import('@vercel/speed-insights/next').then((m) => ({ default: m.SpeedInsights })),
  { ssr: false }
)

interface HomePageLoaderProps {
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
  // Homepage root layout has no Providers (for LCP optimization).
  // Phase 2 needs ToastProvider, QueryClient, etc. — wrap here on client only.
  return (
    <Providers>
      <WelcomeBanner />
      <HomePage {...props} />
      <CompareFloatingBar />
      <WebVitals />
      <SpeedInsights />
    </Providers>
  )
}
