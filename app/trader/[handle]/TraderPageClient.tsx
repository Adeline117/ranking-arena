'use client'

import { useEffect, useState, useRef, Suspense, useTransition } from 'react'
import useSWR from 'swr'
import { fetcher } from '@/lib/hooks/useSWR'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import TopNav from '@/app/components/layout/TopNav'
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import TraderHeader from '@/app/components/trader/TraderHeader'
import ExportButton from '@/app/components/common/ExportButton'
import TraderTabs from '@/app/components/trader/TraderTabs'
import OverviewPerformanceCard from '@/app/components/trader/OverviewPerformanceCard'
// Phase 3A: Lazy-load heavy tab components (StatsPage imports lightweight-charts ~300KB)
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
// Phase 4: Lazy-load below-fold and secondary components
const TraderPageV2 = dynamic(() => import('@/app/components/trader/TraderPageV2'), {
  loading: () => <RankingSkeleton />,
})
const TraderAboutCard = dynamic(() => import('@/app/components/trader/TraderAboutCard'))
const SimilarTraders = dynamic(() => import('@/app/components/trader/SimilarTraders'))
const TraderFeed = dynamic(() => import('@/app/components/trader/TraderFeed'))
const StatsPage = dynamic(() => import('@/app/components/trader/stats/StatsPage'), {
  loading: () => <RankingSkeleton />,
})
const PortfolioTable = dynamic(() => import('@/app/components/trader/PortfolioTable'), {
  loading: () => <RankingSkeleton />,
})
import { Box, Text } from '@/app/components/base'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import type {
  TraderProfile,
  TraderPerformance,
  TraderStats,
  PortfolioItem,
  TraderFeedItem,
} from '@/lib/data/trader'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import { TraderPageStylesheets } from '@/app/components/Providers/AsyncStylesheets'
import {
  generateTraderProfilePageSchema,
  generateBreadcrumbSchema,
  combineSchemas,
} from '@/lib/seo'

type TabKey = 'overview' | 'stats' | 'portfolio'

interface AssetBreakdownData {
  '90D': Array<{ symbol: string; weightPct: number }>
  '30D': Array<{ symbol: string; weightPct: number }>
  '7D': Array<{ symbol: string; weightPct: number }>
}

interface EquityCurveData {
  '90D': Array<{ date: string; roi: number; pnl: number }>
  '30D': Array<{ date: string; roi: number; pnl: number }>
  '7D': Array<{ date: string; roi: number; pnl: number }>
}

interface ExtendedPositionHistoryItem {
  symbol: string
  direction: 'long' | 'short'
  positionType: string
  marginMode: string
  openTime: string
  closeTime: string
  entryPrice: number
  exitPrice: number
  maxPositionSize: number
  closedSize: number
  pnlUsd: number
  pnlPct: number
  status: string
}

// SWR response type for /api/traders/[handle]
interface TraderPageData {
  profile: TraderProfile
  performance: TraderPerformance
  stats: TraderStats
  portfolio: PortfolioItem[]
  positionHistory: ExtendedPositionHistoryItem[]
  feed: TraderFeedItem[]
  similarTraders: TraderProfile[]
  assetBreakdown?: AssetBreakdownData
  equityCurve?: EquityCurveData
  trackedSince?: string
}

function TraderContent({ handle, serverData }: { handle: string; serverData: TraderPageData | null }) {
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const { isPro } = useSubscription()

  // Use refs to avoid unnecessary refetches when language/showToast/t changes
  const showToastRef = useRef(showToast)
  const languageRef = useRef(language)
  const tRef = useRef(t)
  useEffect(() => { showToastRef.current = showToast }, [showToast])
  useEffect(() => { languageRef.current = language }, [language])
  useEffect(() => { tRef.current = t }, [t])

  // handle is now resolved server-side and passed as a prop
  const [email, setEmail] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)

  // SWR with server-side fallback data for instant render
  const { data: traderData, error: fetchError, isLoading: swrLoading } = useSWR<TraderPageData>(
    handle ? `/api/traders/${encodeURIComponent(handle)}` : null,
    fetcher,
    {
      revalidateOnFocus: false,
      refreshInterval: 60_000,
      dedupingInterval: 5000,
      errorRetryCount: 2,
      fallbackData: serverData ?? undefined,
    }
  )

  // Derive display state from SWR response
  const profile = traderData?.profile ?? null
  const performance = traderData?.performance ?? null
  const stats = traderData?.stats ?? null
  const portfolio = traderData?.portfolio ?? []
  const positionHistory = traderData?.positionHistory ?? []
  const extendedPositionHistory = traderData?.positionHistory ?? []
  const feed = traderData?.feed ?? []
  const similarTraders = traderData?.similarTraders ?? []
  const assetBreakdown = traderData?.assetBreakdown
  const equityCurve = traderData?.equityCurve
  // With serverData, loading is only true when SWR hasn't returned AND no fallback
  const loading = swrLoading && !serverData

  // Phase 3B: useTransition for non-urgent tab switches
  const [, startTransition] = useTransition()

  // Read tab from URL, default to 'overview'
  const urlTab = searchParams.get('tab') as TabKey | null
  const [activeTab, setActiveTab] = useState<TabKey>(
    urlTab && ['overview', 'stats', 'portfolio'].includes(urlTab) ? urlTab as TabKey : 'overview'
  )

  // Update URL when tab changes — wrap state update in startTransition
  const handleTabChange = (tab: TabKey) => {
    startTransition(() => {
      setActiveTab(tab)
    })
    // URL update stays outside transition (synchronous)
    const params = new URLSearchParams(searchParams.toString())
    if (tab === 'overview') {
      params.delete('tab') // Don't show tab in URL for default
    } else {
      params.set('tab', tab)
    }
    const newUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname
    router.replace(newUrl, { scroll: false })
  }

  // Sync with URL changes (allow all users to view stats/portfolio with blurred data)
  useEffect(() => {
    const tab = searchParams.get('tab') as TabKey | null
    if (tab && ['overview', 'stats', 'portfolio'].includes(tab)) {
      setActiveTab(tab)
    } else if (!tab) {
      setActiveTab('overview')
    }
  }, [searchParams])

  useEffect(() => {
    // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setCurrentUserId(data.user?.id ?? null)
    })
  }, [])

  // Show error toast when SWR fetch fails with no cached data
  useEffect(() => {
    if (fetchError && !traderData) {
      showToastRef.current(
        tRef.current('loadFailedRetryMsg'),
        'error'
      )
    }
  }, [fetchError, traderData])

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <RankingSkeleton />
        </Box>
      </Box>
    )
  }

  if (!profile) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg" weight="bold">
            {t('noTraderData')}
          </Text>
          <Text size="sm" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
            Handle: {handle || '(empty)'}
          </Text>
          <Link href="/" style={{ color: tokens.colors.text.secondary, textDecoration: 'none', marginTop: tokens.spacing[2], display: 'inline-block' }}>
            ← {t('home')}
          </Link>
        </Box>
      </Box>
    )
  }

  // JSON-LD structured data
  const structuredData = profile ? combineSchemas(
    generateTraderProfilePageSchema({
      handle: profile.handle,
      id: profile.id,
      bio: profile.bio,
      avatarUrl: profile.avatar_url,
      source: profile.source,
      followers: profile.followers,
      roi90d: performance?.roi_90d,
      winRate: performance?.win_rate,
      maxDrawdown: performance?.max_drawdown,
      arenaScore: performance?.arena_score ?? undefined,
    }),
    generateBreadcrumbSchema([
      { name: '首页', url: process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org' },
      { name: '交易员', url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'}/search?type=trader` },
      { name: profile.handle },
    ])
  ) : null

  return (
    <Box
      className="trader-page-container"
      style={{
        minHeight: '100vh',
        background: `linear-gradient(180deg, ${tokens.colors.bg.primary} 0%, ${tokens.colors.bg.secondary}30 100%)`,
        color: tokens.colors.text.primary,
      }}
    >
      {structuredData && <JsonLd data={structuredData} />}
      <TraderPageStylesheets />
      <TopNav email={email} />

      <Box className="page-container" style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], paddingBottom: 100 }}>
        <Breadcrumb items={[
          { label: language === 'zh' ? '排行榜' : 'Leaderboard', href: '/rankings' },
          { label: profile.handle || handle },
        ]} />
        {/* Header + Export */}
        <Box style={{ position: 'relative' }}>
          <Box style={{ position: 'absolute', top: 0, right: 0, zIndex: 2 }}>
            <ExportButton
              hidePDF
              onExport={async (format) => {
                const { exportToCSV, exportToJSON } = await import('@/lib/utils/export')
                const row = [{
                  handle: profile.handle || handle,
                  source: profile.source || '',
                  followers: profile.followers ?? '',
                  copiers: profile.copiers ?? '',
                  roi_90d: performance?.roi_90d ?? '',
                  max_drawdown: performance?.max_drawdown ?? '',
                  win_rate: performance?.win_rate ?? '',
                }]
                const filename = `trader-${profile.handle || handle}`
                if (format === 'json') exportToJSON(row[0], filename)
                else exportToCSV(row as unknown as Record<string, unknown>[], filename)
              }}
            />
          </Box>
        </Box>
        <TraderHeader
          handle={profile.handle}
          traderId={profile.id}
          avatarUrl={profile.avatar_url}
          coverUrl={profile.cover_url}
          isRegistered={profile.isRegistered}
          followers={profile.followers}
          copiers={profile.copiers}
          source={profile.source}
          isPro={isPro}
          roi90d={performance?.roi_90d}
          maxDrawdown={performance?.max_drawdown}
          winRate={performance?.win_rate}
        />

        {/* Tabs */}
        <TraderTabs
          activeTab={activeTab}
          onTabChange={handleTabChange}
          isPro={isPro}
          onProRequired={() => router.push('/pricing')}
        />

        {/* Tab Content with animation */}
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
                gap: tokens.spacing[8],
              }}
            >
              <Box className="stagger-enter" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
                {performance ? (
                  <Box style={{ position: 'relative' }}>
                    <OverviewPerformanceCard
                      performance={performance}
                      equityCurve={equityCurve?.['90D']}
                      source={profile?.source}
                    />
                    {/* Blur overlay for non-logged-in users */}
                    {!email && equityCurve?.['90D'] && (
                      <Box style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        height: '60%',
                        background: 'linear-gradient(to bottom, transparent 0%, rgba(10,10,15,0.85) 50%, rgba(10,10,15,0.95) 100%)',
                        backdropFilter: 'blur(4px)',
                        WebkitBackdropFilter: 'blur(4px)',
                        borderRadius: `0 0 ${tokens.radius.xl} ${tokens.radius.xl}`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 5,
                      }}>
                        <Link href={`/login?returnUrl=${encodeURIComponent(`/trader/${handle}`)}`} style={{ textDecoration: 'none' }}>
                          <Box style={{
                            padding: `${tokens.spacing[3]} ${tokens.spacing[6]}`,
                            background: `${tokens.colors.accent.primary}20`,
                            border: `1px solid ${tokens.colors.accent.primary}50`,
                            borderRadius: tokens.radius.lg,
                            cursor: 'pointer',
                            textAlign: 'center',
                          }}>
                            <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.primary }}>
                              {language === 'zh' ? '注册查看完整历史数据' : 'Sign up to view full history'}
                            </Text>
                          </Box>
                        </Link>
                      </Box>
                    )}
                  </Box>
                ) : (
                  <Box style={{
                    padding: tokens.spacing[6],
                    background: tokens.colors.bg.secondary,
                    borderRadius: tokens.radius.xl,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    textAlign: 'center',
                  }}>
                    <Text size="sm" color="tertiary">
                      {t('noPerformanceData')}
                    </Text>
                  </Box>
                )}
                <TraderFeed
                  items={feed.filter((f) => f.type !== 'group_post')}
                  title={t('activities')}
                  isRegistered={profile.isRegistered}
                  traderId={profile.id}
                  traderHandle={profile.handle}
                  source={profile.source}
                />
              </Box>

              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
                {similarTraders.length > 0 && <SimilarTraders traders={similarTraders} />}
              </Box>
            </Box>
          )}

          {(() => {
            const isOwnProfile = !!(currentUserId && profile.id === currentUserId)
            const canViewFull = isPro || isOwnProfile
            return (
              <>
                {activeTab === 'stats' && (
                  stats ? (
                    <StatsPage
                      stats={stats}
                      traderHandle={profile.handle}
                      assetBreakdown={assetBreakdown}
                      equityCurve={equityCurve}
                      positionHistory={extendedPositionHistory}
                      isPro={canViewFull}
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

                {activeTab === 'portfolio' && <PortfolioTable items={portfolio} history={positionHistory} isPro={canViewFull} onUnlock={() => router.push('/pricing')} />}
              </>
            )
          })()}
        </Box>
      </Box>
    </Box>
  )
}

function TraderPageV2Section({ platform, handle }: { platform: string; handle: string }) {
  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={null} />
      <TraderPageV2 platform={platform} traderKey={handle} />
    </Box>
  )
}

function TraderPageRouter({ handle, serverData }: { handle: string; serverData: TraderPageData | null }) {
  const searchParams = useSearchParams()
  const platform = searchParams.get('platform')

  // If platform query param is present, use the V2 page (pure DB read, fast)
  if (platform) {
    return <TraderPageV2Section platform={platform} handle={handle} />
  }

  // Default: existing behavior with server-side data
  return <TraderContent handle={handle} serverData={serverData} />
}

export default function TraderPageClient({ handle, serverData }: { handle: string; serverData: TraderPageData | null }) {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <RankingSkeleton />
        </Box>
      </Box>
    }>
      <TraderPageRouter handle={handle} serverData={serverData} />
    </Suspense>
  )
}
