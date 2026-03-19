
'use client'

import { Suspense, lazy } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import TopNav from '../layout/TopNav'
// MobileBottomNav is rendered in root layout.tsx -- do not duplicate here
import ThreeColumnLayout from '../layout/ThreeColumnLayout'
const Footer = lazy(() => import('../layout/Footer'))
import HomeSubNav from './HomeSubNav'
import FoundingMemberBanner from './FoundingMemberBanner'
const ExchangePartners = lazy(() => import('./ExchangePartners'))
const GuestSignupPrompt = lazy(() => import('./GuestSignupPrompt'))
// HomeHero is above-fold (LCP element) — must NOT be lazy-loaded
import HomeHero from './HomeHero'
const WelcomeModal = lazy(() => import('../onboarding/WelcomeModal'))
import HomePageClient from './HomePageClient'
import { SectionErrorBoundary } from '../utils/ErrorBoundary'
import { features } from '@/lib/features'
// Lazy-load sidebar widgets
const HotDiscussions = lazy(() => import('../sidebar/HotDiscussions'))
const WatchlistMarket = lazy(() => import('../sidebar/WatchlistMarket'))
const NewsFlash = lazy(() => import('../sidebar/NewsFlash'))

import type { InitialTrader } from '@/lib/getInitialTraders'

interface HomePageProps {
  initialTraders?: InitialTrader[]
  initialLastUpdated?: string | null
  heroStats?: { traderCount: number; exchangeCount: number }
  ssrTable?: React.ReactNode
}

export default function HomePage({ initialTraders, initialLastUpdated, heroStats, ssrTable }: HomePageProps) {
  return (
    <Box
      id="homepage-interactive"
      suppressHydrationWarning
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
        position: 'relative',
      }}
    >
      <Box
        className="mesh-gradient-bg"
        style={{
          position: 'fixed',
          inset: 0,
          background: 'linear-gradient(135deg, var(--color-accent-primary-08) 0%, transparent 40%, var(--color-accent-primary-08) 100%)',
          opacity: 0.5,
          pointerEvents: 'none',
          zIndex: 0,
          transform: 'translateZ(0)',
          backfaceVisibility: 'hidden',
          contain: 'strict layout paint',
        }}
      />

      <TopNav email={null} />

      <Box
        className="container-padding page-enter has-mobile-nav"
        style={{
          maxWidth: 1400,
          margin: '0 auto',
          position: 'relative',
          zIndex: 1,
          padding: '8px 16px',
        }}
      >
        <h1 className="sr-only">Arena</h1>
        {/* HomeHero is eagerly imported — renders immediately. Suspense is for lazy NumberTicker inside it. */}
        <div style={{ contain: 'content' }}>
          <Suspense fallback={null}><HomeHero traderCount={heroStats?.traderCount} exchangeCount={heroStats?.exchangeCount} /></Suspense>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, contain: 'content' }}>
          <HomeSubNav />
          <FoundingMemberBanner />
        </div>
        <Suspense fallback={<div style={{ minHeight: 48, height: 48, contain: 'layout style' }} />}><ExchangePartners /></Suspense>
        <ThreeColumnLayout
          leftSidebar={
            features.social ? (
              <SectionErrorBoundary>
                <Suspense fallback={<div className="skeleton" style={{ minHeight: 400, height: 400, borderRadius: tokens.radius.lg, contain: 'layout style' }} />}>
                  <HotDiscussions />
                </Suspense>
              </SectionErrorBoundary>
            ) : null
          }
          rightSidebar={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, contain: 'layout style' }}>
              <div style={{ flexShrink: 0 }}>
                <SectionErrorBoundary>
                  <Suspense fallback={<div className="skeleton" style={{ minHeight: 200, height: 200, borderRadius: tokens.radius.lg, contain: 'layout style' }} />}>
                    <WatchlistMarket />
                  </Suspense>
                </SectionErrorBoundary>
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <SectionErrorBoundary>
                  <Suspense fallback={<div className="skeleton" style={{ minHeight: 300, height: 300, borderRadius: tokens.radius.lg, contain: 'layout style' }} />}>
                    <NewsFlash />
                  </Suspense>
                </SectionErrorBoundary>
              </div>
            </div>
          }
        >
          <SectionErrorBoundary>
            <Suspense fallback={
              <Box style={{ minHeight: '60vh' }}>
                <div className="skeleton" style={{ height: 400, borderRadius: tokens.radius.lg }} />
              </Box>
            }>
                <HomePageClient initialTraders={initialTraders} initialLastUpdated={initialLastUpdated} ssrTable={ssrTable} />
            </Suspense>
          </SectionErrorBoundary>
        </ThreeColumnLayout>
      </Box>

      <div style={{ contain: 'content' }}>
        <Suspense fallback={<div style={{ minHeight: 200 }} />}><Footer /></Suspense>
      </div>
      {/* MobileBottomNav rendered in root layout.tsx */}
      <Suspense fallback={null}><GuestSignupPrompt /></Suspense>
      <Suspense fallback={null}><WelcomeModal /></Suspense>
    </Box>
  )
}
