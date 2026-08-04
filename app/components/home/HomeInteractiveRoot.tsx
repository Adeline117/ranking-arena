'use client'

import dynamic from 'next/dynamic'
import Providers from '../Providers'
import PresenceHeartbeat from '../presence/PresenceHeartbeat'
import HomePage from './HomePage'
import WelcomeBanner from './WelcomeBanner'
import type { HomePageLoaderProps } from './HomePageLoader'

// The comparison bar is still independently lazy within Phase 2. It depends
// on LanguageProvider, so it remains a child of Providers.
const CompareFloatingBar = dynamic(() => import('../trader/CompareFloatingBar'), { ssr: false })

// Web Vitals + SpeedInsights: homepage uses root layout (not (app)/layout.tsx
// where these live), so load them with the deferred interactive graph.
const WebVitals = dynamic(
  () => import('../Providers/WebVitals').then((module) => ({ default: module.WebVitals })),
  { ssr: false }
)
const SpeedInsights = dynamic(
  () => import('@vercel/speed-insights/next').then((module) => ({ default: module.SpeedInsights })),
  { ssr: false }
)

/**
 * Owns the provider-heavy homepage graph behind HomePageLoader's async boundary.
 * The server-rendered hero and three-column shell stay outside this component.
 */
export default function HomeInteractiveRoot(props: HomePageLoaderProps) {
  return (
    <Providers>
      <PresenceHeartbeat />
      <WelcomeBanner />
      <HomePage {...props} />
      <CompareFloatingBar />
      <WebVitals />
      <SpeedInsights />
    </Providers>
  )
}
