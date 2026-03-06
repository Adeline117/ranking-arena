
'use client'

import { Suspense, lazy } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import TopNav from '../layout/TopNav'
// MobileBottomNav is rendered in root layout.tsx -- do not duplicate here
import ThreeColumnLayout from '../layout/ThreeColumnLayout'
const Footer = lazy(() => import('../layout/Footer'))
import HomeSubNav from './HomeSubNav'
const ExchangePartners = lazy(() => import('./ExchangePartners'))
const GuestSignupPrompt = lazy(() => import('./GuestSignupPrompt'))
import HomePageClient from './HomePageClient'
import { SectionErrorBoundary } from '../utils/ErrorBoundary'
// HomePageWithSubNav removed from homepage - only used in groups page
// Lazy-load sidebar widgets
const HotDiscussions = lazy(() => import('../sidebar/HotDiscussions'))
const WatchlistMarket = lazy(() => import('../sidebar/WatchlistMarket'))
const NewsFlash = lazy(() => import('../sidebar/NewsFlash'))

export default function HomePage() {
  return (
    <Box
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
        <h1 className="sr-only">Arena — Crypto Trader Rankings</h1>
        <HomeSubNav />
        <Suspense fallback={null}><ExchangePartners /></Suspense>
        <ThreeColumnLayout
          leftSidebar={
            <SectionErrorBoundary>
              <Suspense fallback={<div className="skeleton" style={{ height: 400, borderRadius: tokens.radius.lg }} />}>
                <HotDiscussions />
              </Suspense>
            </SectionErrorBoundary>
          }
          rightSidebar={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ flexShrink: 0 }}>
                <SectionErrorBoundary>
                  <Suspense fallback={<div className="skeleton" style={{ height: 200, borderRadius: tokens.radius.lg }} />}>
                    <WatchlistMarket />
                  </Suspense>
                </SectionErrorBoundary>
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <SectionErrorBoundary>
                  <Suspense fallback={<div className="skeleton" style={{ height: 300, borderRadius: tokens.radius.lg }} />}>
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
                <HomePageClient />
            </Suspense>
          </SectionErrorBoundary>
        </ThreeColumnLayout>
      </Box>

      <Suspense fallback={null}><Footer /></Suspense>
      {/* MobileBottomNav rendered in root layout.tsx */}
      <Suspense fallback={null}><GuestSignupPrompt /></Suspense>
    </Box>
  )
}
