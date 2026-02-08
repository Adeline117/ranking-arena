import { Suspense, lazy } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import TopNav from '../layout/TopNav'
import MobileBottomNav from '../layout/MobileBottomNav'
import ThreeColumnLayout from '../layout/ThreeColumnLayout'
import Footer from '../layout/Footer'
import { JsonLd } from '../Providers/JsonLd'
import { generateWebSiteSchema, generateOrganizationSchema, combineSchemas } from '@/lib/seo'
import StatsBar from './StatsBar'
import HeroStats from './HeroStats'
import HomePageClient from './HomePageClient'
// HomePageWithSubNav removed from homepage - only used in groups page
import type { InitialTrader } from '@/lib/getInitialTraders'

// Lazy-load sidebar widgets
const PopularTraders = lazy(() => import('../sidebar/PopularTraders'))
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
        {/* Hero Section */}
        <Box
          style={{
            textAlign: 'center',
            padding: '32px 16px 24px',
            marginBottom: 8,
          }}
        >
          <h1
            className="hero-title"
            style={{
              fontSize: 48,
              fontWeight: 900,
              color: tokens.colors.text.primary,
              margin: '0 0 8px',
              letterSpacing: '-0.02em',
              lineHeight: 1.1,
            }}
          >
            Arena
          </h1>
          <p
            className="hero-subtitle"
            style={{
              fontSize: 16,
              color: tokens.colors.text.secondary,
              margin: '0 0 20px',
              lineHeight: 1.5,
            }}
          >
            聚合全网交易员排名，发现最强交易者
          </p>
          <Suspense fallback={null}>
            <HeroStats />
          </Suspense>
        </Box>

        <Suspense fallback={<div style={{ height: 40 }} />}>
          <StatsBar />
        </Suspense>

        <ThreeColumnLayout
          leftSidebar={
            <Suspense fallback={<div className="skeleton" style={{ height: 400, borderRadius: 12 }} />}>
              <PopularTraders />
            </Suspense>
          }
          rightSidebar={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: 'calc(100vh - 72px)' }}>
              <div style={{ flexShrink: 0, maxHeight: '35%', overflow: 'auto' }}>
                <Suspense fallback={<div className="skeleton" style={{ height: 200, borderRadius: 12 }} />}>
                  <WatchlistMarket />
                </Suspense>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                <Suspense fallback={<div className="skeleton" style={{ height: 300, borderRadius: 12 }} />}>
                  <NewsFlash />
                </Suspense>
              </div>
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
      </Box>

      <Footer />
      <MobileBottomNav />
    </Box>
  )
}
