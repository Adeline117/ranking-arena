'use client'

import { Suspense, lazy } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import ThreeColumnLayout from '@/app/components/layout/ThreeColumnLayout'
import ExchangePartners from '@/app/components/home/ExchangePartners'
import HomePageClient from '@/app/components/home/HomePageClient'
import { SectionErrorBoundary } from '@/app/components/utils/ErrorBoundary'

const HotDiscussions = lazy(() => import('@/app/components/sidebar/HotDiscussions'))
const WatchlistMarket = lazy(() => import('@/app/components/sidebar/WatchlistMarket'))
const NewsFlash = lazy(() => import('@/app/components/sidebar/NewsFlash'))

/**
 * /rankings/traders — identical layout to homepage
 * TopNav + SubNav provided by rankings/layout.tsx
 */
export default function RankingsTradersPage() {
  return (
    <Box
      className="container-padding page-enter has-mobile-nav"
      style={{
        maxWidth: 1400,
        margin: '0 auto',
        position: 'relative',
        zIndex: 1,
        padding: '16px 16px',
      }}
    >
      <ExchangePartners />
      <div style={{ height: 16 }} />
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
  )
}
