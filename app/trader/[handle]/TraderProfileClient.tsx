'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import dynamic from 'next/dynamic'
import useSWR from 'swr'
import { fetcher } from '@/lib/hooks/useSWR'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import { supabase } from '@/lib/supabase/client'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { Box, Text } from '@/app/components/base'
import TopNav from '@/app/components/layout/TopNav'
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import TraderHeader from '@/app/components/trader/TraderHeader'
import TraderTabs from '@/app/components/trader/TraderTabs'
import OverviewPerformanceCard, { type ExtendedPerformance } from '@/app/components/trader/OverviewPerformanceCard'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { formatDisplayName } from '@/app/components/ranking/utils'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import {
  generateTraderProfilePageSchema,
  generateBreadcrumbSchema,
  combineSchemas,
} from '@/lib/seo'

const EquityCurveSection = dynamic(() => import('@/app/components/trader/stats/components/EquityCurveSection').then(m => ({ default: m.EquityCurveSection })), { ssr: false })
const SimilarTraders = dynamic(() => import('@/app/components/trader/SimilarTraders'))
const ClaimTraderButton = dynamic(() => import('@/app/components/trader/ClaimTraderButton'), { ssr: false })
const StatsPage = dynamic(() => import('@/app/components/trader/stats/StatsPage'), {
  loading: () => <RankingSkeleton />,
})
const PortfolioTable = dynamic(() => import('@/app/components/trader/PortfolioTable'), {
  loading: () => <RankingSkeleton />,
})

export interface UnregisteredTraderData {
  handle: string
  avatar_url?: string | null
  source: string
  source_trader_id: string
  rank?: number | null
  arena_score?: number | null
  roi?: number | null
  pnl?: number | null
  win_rate?: number | null
  max_drawdown?: number | null
  sharpe_ratio?: number | null
  sortino_ratio?: number | null
  profit_factor?: number | null
  calmar_ratio?: number | null
  trading_style?: string | null
  avg_holding_hours?: number | null
  profitability_score?: number | null
  risk_control_score?: number | null
  execution_score?: number | null
}

type TraderTabKey = 'overview' | 'stats' | 'portfolio'
type TraderPageData = any

interface TraderProfileClientProps {
  data: UnregisteredTraderData
  serverTraderData?: TraderPageData | null
}

export default function TraderProfileClient({ data, serverTraderData }: TraderProfileClientProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const { t, language } = useLanguage()
  const { isPro } = useSubscription()

  const [currentUserId, setCurrentUserId] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data: userData }) => {
      setCurrentUserId(userData.user?.id ?? null)
    })
  }, [])

  const displayName = formatDisplayName(data.handle, data.source)
  const _exchangeName = EXCHANGE_NAMES[data.source] || data.source

  // Tabs
  const urlTab = searchParams.get('tab')
  const [activeTab, setActiveTab] = useState<TraderTabKey>(
    urlTab && ['overview', 'stats', 'portfolio'].includes(urlTab) ? urlTab as TraderTabKey : 'overview'
  )

  const handleTabChange = useCallback((tab: TraderTabKey) => {
    setActiveTab(tab)
    const params = new URLSearchParams(searchParams.toString())
    if (tab === 'overview') {
      params.delete('tab')
    } else {
      params.set('tab', tab)
    }
    const qs = params.toString()
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
  }, [searchParams, pathname, router])

  // SWR for full trader data from API — pass platform if available for disambiguation
  const platform = searchParams?.get('platform') || data.source || ''
  const traderApiUrl = platform
    ? `/api/traders/${encodeURIComponent(data.source_trader_id || data.handle)}?source=${encodeURIComponent(platform)}`
    : `/api/traders/${encodeURIComponent(data.source_trader_id || data.handle)}`
  const { data: traderData } = useSWR<TraderPageData>(
    traderApiUrl,
    fetcher,
    {
      revalidateOnFocus: false,
      refreshInterval: 60_000,
      dedupingInterval: 5000,
      errorRetryCount: 2,
      fallbackData: serverTraderData ?? undefined,
    }
  )

  const traderProfile = traderData?.profile ?? null
  const traderPerformance = traderData?.performance ?? null
  const traderStats = traderData?.stats ?? null
  const traderPortfolio = traderData?.portfolio ?? []
  const traderPositionHistory = traderData?.positionHistory ?? []
  const traderEquityCurve = traderData?.equityCurve
  const traderAssetBreakdown = traderData?.assetBreakdown
  const traderSimilar = traderData?.similarTraders ?? []

  // Structured data for SEO
  const structuredData = combineSchemas(
    generateTraderProfilePageSchema({
      handle: data.handle,
      id: data.source_trader_id,
      source: data.source,
      roi90d: data.roi ?? undefined,
      winRate: data.win_rate ?? undefined,
      maxDrawdown: data.max_drawdown ?? undefined,
      arenaScore: data.arena_score ?? undefined,
      avatarUrl: data.avatar_url ?? undefined,
    }),
    generateBreadcrumbSchema([
      { name: 'Home', url: process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org' },
      { name: 'Ranking', url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'}/rankings` },
      { name: data.handle },
    ])
  )

  return (
    <Box
      className="trader-page-container"
      style={{
        minHeight: '100vh',
        background: `linear-gradient(180deg, ${tokens.colors.bg.primary} 0%, ${tokens.colors.bg.secondary}30 100%)`,
        color: tokens.colors.text.primary,
      }}
    >
      <JsonLd data={structuredData} />
      <TopNav />

      <Box className="page-container" style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], paddingBottom: 100 }}>
        <Breadcrumb items={[
          { label: language === 'zh' ? '排行榜' : 'Leaderboard', href: '/rankings' },
          { label: displayName },
        ]} />

        {/* Trader Header */}
        <TraderHeader
          handle={traderProfile?.handle || data.handle}
          displayName={displayName}
          traderId={traderProfile?.id || data.source_trader_id}
          avatarUrl={traderProfile?.avatar_url || data.avatar_url || undefined}
          isRegistered={false}
          followers={traderProfile?.followers ?? 0}
          copiers={traderProfile?.copiers}
          source={traderProfile?.source || data.source}
          isPro={isPro}
          roi90d={traderPerformance?.roi_90d ?? (data.roi != null ? data.roi * 100 : undefined)}
          maxDrawdown={traderPerformance?.max_drawdown ?? data.max_drawdown ?? undefined}
          winRate={traderPerformance?.win_rate ?? data.win_rate ?? undefined}
          rank={data.rank ?? null}
          currentUserId={currentUserId}
        />

        {/* Tabs */}
        <TraderTabs
          activeTab={activeTab}
          onTabChange={handleTabChange}
          isPro={isPro}
          onProRequired={() => router.push('/pricing')}
        />

        {/* Tab Content */}
        <Box
          key={activeTab}
          style={{
            animation: 'fadeInUp 0.4s ease-out forwards',
          }}
        >
          {activeTab === 'overview' && (
            <Box
              className="profile-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: traderSimilar.length > 0 ? '1fr 300px' : '1fr',
                gap: tokens.spacing[6],
              }}
            >
              <Box className="stagger-enter" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
                {traderPerformance ? (
                  <OverviewPerformanceCard
                    performance={traderPerformance as ExtendedPerformance}
                    equityCurve={traderEquityCurve?.['90D']}
                    source={traderProfile?.source || data.source}
                  />
                ) : (
                  <Box style={{
                    padding: `${tokens.spacing[8]} ${tokens.spacing[6]}`,
                    background: tokens.colors.bg.secondary,
                    borderRadius: tokens.radius.xl,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    textAlign: 'center',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: tokens.spacing[3],
                  }}>
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--color-text-tertiary)', opacity: 0.4 }}>
                      <path d="M3 3v18h18" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M7 16l4-8 4 4 4-6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <Text size="sm" color="tertiary">
                      {t('noPerformanceData')}
                    </Text>
                  </Box>
                )}

                {/* Equity Curve Chart */}
                {traderEquityCurve && (
                  <EquityCurveSection
                    equityCurve={traderEquityCurve}
                    traderHandle={traderProfile?.handle || data.handle}
                    delay={0}
                  />
                )}

                {/* Claim this profile CTA — replaces activity feed for unclaimed traders */}
                <Box
                  style={{
                    padding: tokens.spacing[8],
                    background: tokens.colors.bg.secondary,
                    borderRadius: tokens.radius.xl,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    textAlign: 'center',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: tokens.spacing[4],
                  }}
                >
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-text-tertiary)', opacity: 0.5 }}>
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                    <line x1="12" y1="11" x2="12" y2="17" />
                    <line x1="9" y1="14" x2="15" y2="14" />
                  </svg>
                  <Text size="base" weight="bold" style={{ color: 'var(--color-text-secondary)' }}>
                    {t('traderNotRegistered')}
                  </Text>
                  <Text size="sm" color="tertiary">
                    {t('traderNotRegisteredDesc')}
                  </Text>
                  {currentUserId && (
                    <Box style={{ marginTop: tokens.spacing[2] }}>
                      <ClaimTraderButton
                        traderId={traderProfile?.id || data.source_trader_id}
                        handle={traderProfile?.handle || data.handle}
                        userId={currentUserId}
                        source={traderProfile?.source || data.source}
                      />
                    </Box>
                  )}
                </Box>
              </Box>

              {traderSimilar.length > 0 && (
                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
                  <SimilarTraders traders={traderSimilar} />
                </Box>
              )}
            </Box>
          )}

          {activeTab === 'stats' && (
            traderStats ? (
              <StatsPage
                stats={traderStats}
                traderHandle={traderProfile?.handle || data.handle}
                assetBreakdown={traderAssetBreakdown}
                equityCurve={traderEquityCurve}
                positionHistory={traderPositionHistory}
                isPro={isPro}
                onUnlock={() => router.push('/pricing')}
              />
            ) : (
              <Box style={{
                padding: tokens.spacing[6],
                background: tokens.colors.bg.secondary,
                borderRadius: tokens.radius.xl,
                border: `1px solid ${tokens.colors.border.primary}`,
                textAlign: 'center',
              }}>
                <Text size="sm" color="tertiary">
                  {t('noStatsData')}
                </Text>
              </Box>
            )
          )}

          {activeTab === 'portfolio' && (
            <PortfolioTable
              items={traderPortfolio}
              history={traderPositionHistory}
              isPro={isPro}
              onUnlock={() => router.push('/pricing')}
            />
          )}
        </Box>

        <style>{`
          .profile-tabs::-webkit-scrollbar { display: none; }
          @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @media (max-width: 768px) {
            .page-container {
              padding: ${tokens.spacing[3]} !important;
              padding-bottom: 100px !important;
            }
            .profile-grid {
              grid-template-columns: 1fr !important;
            }
          }
        `}</style>
      </Box>
    </Box>
  )
}
