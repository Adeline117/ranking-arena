'use client'

import { lazy, Suspense } from 'react'
import TopNav from '@/app/components/layout/TopNav'
import ThreeColumnLayout from '@/app/components/layout/ThreeColumnLayout'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import { Box, Text } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import { useEffect, useState } from 'react'
import NewsFlash from '@/app/components/sidebar/NewsFlash'
import RecommendedGroups from '@/app/components/sidebar/RecommendedGroups'

const MarketOverviewBar = lazy(() => import('@/app/components/market/MarketOverviewBar'))
const FearGreedGauge = lazy(() => import('@/app/components/market/FearGreedGauge'))
const TopMovers = lazy(() => import('@/app/components/market/TopMovers'))
const ArbitrageOpportunities = lazy(() => import('@/app/components/market/ArbitrageOpportunities'))
const DefiOverview = lazy(() => import('@/app/components/market/DefiOverview'))
const SectorPerformance = lazy(() => import('@/app/components/market/SectorPerformance'))
const ExchangeVolume = lazy(() => import('@/app/components/market/ExchangeVolume'))
const LiveTradesFeed = lazy(() => import('@/app/components/market/LiveTradesFeed'))

function LoadingCard() {
  return <div className="skeleton" style={{ height: 200, borderRadius: 12 }} />
}

export default function MarketPage() {
  const { t } = useLanguage()
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null))
  }, [])

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      {/* Market Overview Bar */}
      <Suspense fallback={<LoadingCard />}>
        <MarketOverviewBar />
      </Suspense>

      <ThreeColumnLayout
        leftSidebar={
          <Suspense fallback={<LoadingCard />}>
            <RecommendedGroups />
          </Suspense>
        }
        rightSidebar={
          <Suspense fallback={<LoadingCard />}>
            <NewsFlash />
          </Suspense>
        }
      >
        <Text size="xl" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
          {t('market') || '市场'}
        </Text>

        {/* Two-column grid for market widgets */}
        <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: tokens.spacing[4] }}>
          <Suspense fallback={<LoadingCard />}>
            <FearGreedGauge />
          </Suspense>

          <Suspense fallback={<LoadingCard />}>
            <TopMovers />
          </Suspense>

          <Suspense fallback={<LoadingCard />}>
            <SectorPerformance />
          </Suspense>

          <Suspense fallback={<LoadingCard />}>
            <ExchangeVolume />
          </Suspense>

          <Suspense fallback={<LoadingCard />}>
            <ArbitrageOpportunities />
          </Suspense>

          <Suspense fallback={<LoadingCard />}>
            <DefiOverview />
          </Suspense>
        </Box>

        {/* Full-width live trades */}
        <Box style={{ marginTop: tokens.spacing[4] }}>
          <Suspense fallback={<LoadingCard />}>
            <LiveTradesFeed />
          </Suspense>
        </Box>
      </ThreeColumnLayout>

      <FloatingActionButton />
      <MobileBottomNav />
    </Box>
  )
}
