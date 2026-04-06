
'use client'

import { Suspense, lazy, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import TopNav from '../layout/TopNav'
// MobileBottomNav is rendered in root layout.tsx -- do not duplicate here
import ThreeColumnLayout from '../layout/ThreeColumnLayout'
const Footer = lazy(() => import('../layout/Footer'))
import FoundingMemberBanner from './FoundingMemberBanner'
const ExchangePartners = lazy(() => import('./ExchangePartners'))
const GuestSignupPrompt = lazy(() => import('./GuestSignupPrompt'))
// HomeHero renders in Phase 2 — safe because Phase 2 is deferred until user interaction
// (HomePageLoader gates on scroll/click/keypress), so LCP is already locked at SSR time.
import HomeHero from './HomeHero'
// WelcomeModal removed — blocks entire page for first-time visitors
import HomePageClient from './HomePageClient'
import { SectionErrorBoundary } from '../utils/ErrorBoundary'
import { features } from '@/lib/features'
// Lazy-load sidebar widgets
const HotDiscussions = lazy(() => import('../sidebar/HotDiscussions'))
const WatchlistMarket = lazy(() => import('../sidebar/WatchlistMarket'))
const NewsFlash = lazy(() => import('../sidebar/NewsFlash'))
const TrendingHashtags = lazy(() => import('../sidebar/TrendingHashtags'))

import type { InitialTrader } from '@/lib/getInitialTraders'

interface HomePageProps {
  initialTraders?: InitialTrader[]
  initialLastUpdated?: string | null
  heroStats?: { traderCount: number; exchangeCount: number }
}

export default function HomePage({ initialTraders, initialLastUpdated, heroStats }: HomePageProps) {
  // SSR ranking table: hidden by CSS :has(#homepage-interactive) — instant, zero CLS.
  // SSR hero: NEVER hidden by JS. It IS the LCP element (~1.3s on slow 4G).
  //   Phase 2 hero renders on top via z-index (same visual content).
  //   SSR hero stays underneath indefinitely — invisible to user but preserves LCP.
  // Cleanup: remove SSR shells after idle (safe: Phase 2 is already rendered).
  useEffect(() => {
    const cleanup = () => {
      document.getElementById('ssr-hero-shell')?.remove()
      document.getElementById('ssr-ranking-table')?.remove()
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
        {/* Phase 2 hero — safe because HomePageLoader defers rendering until user interaction,
            which locks LCP at SSR time. CSS hides the SSR hero when this renders. */}
        <div className="contain-content">
          <Suspense fallback={null}><HomeHero traderCount={heroStats?.traderCount} exchangeCount={heroStats?.exchangeCount} /></Suspense>
        </div>
        <div className="contain-content">
          <FoundingMemberBanner />
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
            <Suspense fallback={
              <div className="contain-layout-style" style={{ minHeight: '80vh' }}>
                <div className="skeleton" style={{ minHeight: 800, borderRadius: tokens.radius.lg }} />
              </div>
            }>
                <HomePageClient initialTraders={initialTraders} initialLastUpdated={initialLastUpdated} />
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
