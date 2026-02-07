import { Suspense, lazy } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import TopNav from '../layout/TopNav'
import MobileBottomNav from '../layout/MobileBottomNav'
import ThreeColumnLayout from '../layout/ThreeColumnLayout'
import { JsonLd } from '../Providers/JsonLd'
import { generateWebSiteSchema, generateOrganizationSchema, combineSchemas } from '@/lib/seo'
import StatsBar from './StatsBar'
import HomePageClient from './HomePageClient'
import HomePageWithSubNav from './HomePageWithSubNav'
import type { InitialTrader } from '@/lib/getInitialTraders'

// Lazy-load sidebar widgets
const TrendingDiscussions = lazy(() => import('../sidebar/TrendingDiscussions'))
const WatchlistMarket = lazy(() => import('../sidebar/WatchlistMarket'))
const NewsFlash = lazy(() => import('../sidebar/NewsFlash'))

interface HomePageProps {
  initialTraders?: InitialTrader[]
  initialLastUpdated?: string | null
}

export default function HomePage({
  initialTraders,
  initialLastUpdated,
}: HomePageProps) {
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
          background: 'linear-gradient(135deg, rgba(139, 111, 168, 0.08) 0%, transparent 40%, rgba(124, 58, 237, 0.05) 100%)',
          opacity: 0.5,
          pointerEvents: 'none',
          zIndex: 0,
          transform: 'translateZ(0)',
          backfaceVisibility: 'hidden',
          contain: 'strict layout paint',
        }}
      />

      <JsonLd data={combineSchemas(generateWebSiteSchema(), generateOrganizationSchema())} />
      <TopNav email={null} />

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
        <Suspense fallback={<div style={{ height: 40 }} />}>
          <StatsBar />
        </Suspense>

        <HomePageWithSubNav
          recommendedContent={
            <ThreeColumnLayout
              leftSidebar={
                <Suspense fallback={<div className="skeleton" style={{ height: 400, borderRadius: 12 }} />}>
                  <TrendingDiscussions />
                </Suspense>
              }
              rightSidebar={
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                  <Suspense fallback={<div className="skeleton" style={{ height: 200, borderRadius: 12 }} />}>
                    <WatchlistMarket />
                  </Suspense>
                  <Suspense fallback={<div className="skeleton" style={{ height: 300, borderRadius: 12 }} />}>
                    <NewsFlash />
                  </Suspense>
                </div>
              }
            >
              <Suspense fallback={
                <Box style={{ minHeight: '60vh' }}>
                  <div className="skeleton" style={{ height: 400, borderRadius: 12 }} />
                </Box>
              }>
                <HomePageClient
                  initialTraders={initialTraders}
                  initialLastUpdated={initialLastUpdated}
                />
              </Suspense>
            </ThreeColumnLayout>
          }
        />
      </Box>

      <MobileBottomNav />
    </Box>
  )
}
