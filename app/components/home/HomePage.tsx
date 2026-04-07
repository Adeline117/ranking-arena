
'use client'

import { Suspense, lazy, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import TopNav from '../layout/TopNav'
// MobileBottomNav is rendered in root layout.tsx -- do not duplicate here
import ThreeColumnLayout from '../layout/ThreeColumnLayout'
const Footer = lazy(() => import('../layout/Footer'))
const FoundingMemberBanner = lazy(() => import('./FoundingMemberBanner'))
const ExchangePartners = lazy(() => import('./ExchangePartners'))
const GuestSignupPrompt = lazy(() => import('./GuestSignupPrompt'))
// HomeHero REMOVED from Phase 2 — SSR hero (HomeHeroSSR) stays visible permanently
// as the LCP element. Rendering Phase 2 hero created a new LCP paint at ~10s.
// WelcomeModal removed — blocks entire page for first-time visitors
import HomePageClient from './HomePageClient'
import { SectionErrorBoundary } from '../utils/ErrorBoundary'
import { features } from '@/lib/features'
// Lazy-load sidebar widgets
const HotDiscussions = lazy(() => import('../sidebar/HotDiscussions'))
const WatchlistMarket = lazy(() => import('../sidebar/WatchlistMarket'))
const NewsFlash = lazy(() => import('../sidebar/NewsFlash'))
const TrendingHashtags = lazy(() => import('../sidebar/TrendingHashtags'))

import type { InitialTrader, CategoryCounts } from '@/lib/getInitialTraders'

interface HomePageProps {
  initialTraders?: InitialTrader[]
  initialLastUpdated?: string | null
  heroStats?: { traderCount: number; exchangeCount: number }
  initialTotalCount?: number
  initialCategoryCounts?: CategoryCounts
}

export default function HomePage({ initialTraders, initialLastUpdated, heroStats, initialTotalCount, initialCategoryCounts }: HomePageProps) {
  // SSR hero: NEVER removed — it IS the LCP element (~1.2s on slow 4G).
  // Phase 2 does NOT render its own hero. SSR hero stays visible permanently.
  // SSR ranking table + topnav: removed from DOM during idle (Phase 2 renders its own).
  useEffect(() => {
    const cleanup = () => {
      document.getElementById('ssr-ranking-table')?.remove()
      document.getElementById('ssr-topnav')?.remove()
    }
    if ('requestIdleCallback' in window) {
      (window as Window).requestIdleCallback(cleanup)
    } else {
      setTimeout(cleanup, 1000)
    }
  }, [])

  return (
    <div
      id="homepage-interactive"
      suppressHydrationWarning
      className="home-page-root"
    >
      <TopNav email={null} />

      <div className="container-padding has-mobile-nav home-page-container">
        <h1 className="sr-only">Arena</h1>
        {/* Phase 2 hero REMOVED — SSR hero stays visible permanently as LCP element.
            Rendering a Phase 2 hero would paint a new large element at ~10s on slow 4G,
            resetting LCP from 1.2s to 10s. SSR hero is identical visual content. */}
        <div className="contain-content">
          <Suspense fallback={null}><FoundingMemberBanner /></Suspense>
        </div>
        {/* ExchangePartners fallback: padding:10px*2 + content~26px + border:1px = 47px.
            Must match actual rendered height to avoid CLS when component loads. */}
        <Suspense fallback={<div className="contain-layout-style" style={{ height: 47, borderBottom: '1px solid var(--color-border-primary)' }} />}><ExchangePartners /></Suspense>
        <ThreeColumnLayout
          leftSidebar={
            features.social ? (
              <SectionErrorBoundary>
                <Suspense fallback={<div className="skeleton contain-layout-style" style={{ minHeight: 400, borderRadius: tokens.radius.lg }} />}>
                  <HotDiscussions />
                </Suspense>
              </SectionErrorBoundary>
            ) : null
          }
          rightSidebar={
            <div className="contain-layout-style" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ flexShrink: 0 }}>
                <SectionErrorBoundary>
                  <Suspense fallback={<div className="skeleton contain-layout-style" style={{ minHeight: 200, borderRadius: tokens.radius.lg }} />}>
                    <WatchlistMarket />
                  </Suspense>
                </SectionErrorBoundary>
              </div>
              {features.social && (
                <div style={{ flexShrink: 0 }}>
                  <SectionErrorBoundary>
                    <Suspense fallback={<div className="skeleton contain-layout-style" style={{ minHeight: 120, borderRadius: tokens.radius.lg }} />}>
                      <TrendingHashtags />
                    </Suspense>
                  </SectionErrorBoundary>
                </div>
              )}
              <div style={{ flex: 1, minHeight: 0 }}>
                <SectionErrorBoundary>
                  <Suspense fallback={<div className="skeleton contain-layout-style" style={{ minHeight: 300, borderRadius: tokens.radius.lg }} />}>
                    <NewsFlash />
                  </Suspense>
                </SectionErrorBoundary>
              </div>
            </div>
          }
        >
          <SectionErrorBoundary>
            {/* Skeleton min-height matches SSR table (25 rows × 52px + header 40px = 1340px)
                so mobile-sidebar-widgets button doesn't shift when real content replaces skeleton */}
            <Suspense fallback={
              <div className="contain-layout-style" style={{ minHeight: 1340 }}>
                <div className="skeleton" style={{ minHeight: 1340, borderRadius: tokens.radius.lg }} />
              </div>
            }>
                <HomePageClient initialTraders={initialTraders} initialLastUpdated={initialLastUpdated} initialTotalCount={initialTotalCount} initialCategoryCounts={initialCategoryCounts} />
            </Suspense>
          </SectionErrorBoundary>
        </ThreeColumnLayout>
      </div>

      <div className="contain-content">
        <Suspense fallback={<div style={{ minHeight: 200 }} />}><Footer /></Suspense>
      </div>
      {/* MobileBottomNav rendered in root layout.tsx */}
      <Suspense fallback={null}><GuestSignupPrompt /></Suspense>
      {/* WelcomeModal removed — homepage content IS the onboarding */}
    </div>
  )
}
