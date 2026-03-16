'use client'

import { useEffect, useState, useRef, Suspense, useTransition } from 'react'
import useSWR from 'swr'
import { fetcher as rawFetcher } from '@/lib/hooks/useSWR'
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
import TraderTabs from '@/app/components/trader/TraderTabs'
import OverviewPerformanceCard, { type ExtendedPerformance } from '@/app/components/trader/OverviewPerformanceCard'
// Phase 3A: Lazy-load heavy tab components (StatsPage imports lightweight-charts ~300KB)
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
// Phase 4: Lazy-load below-fold and secondary components
const TraderPageV2 = dynamic(() => import('@/app/components/trader/TraderPageV2'), {
  loading: () => <RankingSkeleton />,
})
const AlertConfig = dynamic(() => import('@/app/components/alerts/AlertConfig'), { ssr: false })
const _TraderAboutCard = dynamic(() => import('@/app/components/trader/TraderAboutCard'))
const SimilarTraders = dynamic(() => import('@/app/components/trader/SimilarTraders'))
const TraderFeed = dynamic(() => import('@/app/components/trader/TraderFeed'))
const TraderActivityTimeline = dynamic(() => import('@/app/components/feed/TraderActivityTimeline'), { ssr: false })
const StatsPage = dynamic(() => import('@/app/components/trader/stats/StatsPage'), {
  loading: () => <RankingSkeleton />,
})
const EquityCurveSection = dynamic(() => import('@/app/components/trader/stats/components/EquityCurveSection').then(m => ({ default: m.EquityCurveSection })), {
  ssr: false,
  loading: () => (
    <div style={{ minHeight: 200, borderRadius: 16, background: 'var(--color-bg-secondary, #1a1a2e)', border: '1px solid var(--color-border-primary, #2a2a3e)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px' }}>
        <div style={{ width: 120, height: 14, borderRadius: 4, background: 'var(--color-bg-tertiary, #252540)', animation: 'pulse 1.5s ease-in-out infinite' }} />
      </div>
      <div style={{ height: 160, margin: '0 20px 16px', borderRadius: 8, background: 'var(--color-bg-tertiary, #252540)', animation: 'pulse 1.5s ease-in-out infinite', animationDelay: '0.2s' }} />
    </div>
  ),
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
// Unwrap the API envelope { success, data } to get the raw TraderPageData
async function traderFetcher(url: string): Promise<TraderPageData> {
  const raw = await rawFetcher<{ success: boolean; data: TraderPageData }>(url)
  if (raw && typeof raw === 'object' && 'data' in raw && 'success' in raw) {
    return raw.data
  }
  return raw as unknown as TraderPageData
}

interface TraderPageData {
  profile: TraderProfile
  performance: TraderPerformance
  stats: TraderStats
  portfolio: PortfolioItem[]
  positionHistory: ExtendedPositionHistoryItem[]
  feed: TraderFeedItem[]
  similarTraders: (TraderProfile & { roi_90d?: number; arena_score?: number })[]
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
    traderFetcher,
    {
      revalidateOnFocus: false,
      refreshInterval: 300_000, // 5min — data only updates every few hours
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
  const [isTabPending, startTransition] = useTransition()

  const [showAlertConfig, setShowAlertConfig] = useState(false)

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
     
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setCurrentUserId(data.user?.id ?? null)
    }).catch(() => { /* Intentionally swallowed: auth check non-critical for trader page */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
  }, [])

  // Show error toast when SWR fetch fails with no cached data (skip 404s — empty state handles those)
  useEffect(() => {
    if (fetchError && !traderData) {
      const msg = fetchError?.message || ''
      if (!msg.includes('not found') && !msg.includes('404')) {
        showToastRef.current(
          tRef.current('loadFailedRetryMsg'),
          'error'
        )
      }
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
          { label: t('leaderboardBreadcrumb'), href: '/rankings' },
          { label: profile.handle || handle },
        ]} />
        {/* Header */}
        <TraderHeader
          handle={profile.handle || profile.trader_key || ''}
          displayName={profile.display_name || undefined}
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
          currentUserId={currentUserId}
          isBot={profile.source === 'web3_bot' || !!(profile as unknown as { is_bot?: boolean }).is_bot}
          lastUpdated={traderData?.trackedSince}
        />

        {/* Alert Config (Pro only) */}
        {isPro && currentUserId && (
          <>
            <Box style={{ display: 'flex', justifyContent: 'flex-end', marginTop: tokens.spacing[2], marginBottom: tokens.spacing[2] }}>
              <button
                onClick={() => setShowAlertConfig(true)}
                title={language === 'zh' ? '设置提醒' : 'Set Alerts'}
                style={{
                  background: 'none',
                  border: `1px solid var(--color-border-primary, ${tokens.colors.border.primary})`,
                  borderRadius: 8,
                  padding: '6px 12px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  color: tokens.colors.text.secondary,
                  fontSize: 13,
                  transition: `opacity ${tokens.transition.fast}`,
                }}
              >
                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
                {language === 'zh' ? '提醒' : 'Alerts'}
              </button>
            </Box>
            {showAlertConfig && (
              <Box
                style={{
                  position: 'fixed',
                  inset: 0,
                  zIndex: 1000,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--color-backdrop-heavy, rgba(0,0,0,0.5))',
                }}
                onClick={() => setShowAlertConfig(false)}
              >
                <Box onClick={(e: React.MouseEvent) => e.stopPropagation()} style={{ maxWidth: 500, width: '90%', maxHeight: '80vh', overflow: 'auto' }}>
                  <AlertConfig
                    traderId={profile.id}
                    traderHandle={profile.handle || handle}
                    source={profile.source}
                    userId={currentUserId}
                    onClose={() => setShowAlertConfig(false)}
                  />
                </Box>
              </Box>
            )}
          </>
        )}

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
            opacity: isTabPending ? 0.6 : 1,
            transition: 'opacity 0.2s ease',
          }}
        >
          {activeTab === 'overview' && (
            <Box
              className="profile-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: similarTraders.length > 0 ? '1fr 300px' : '1fr',
                gap: tokens.spacing[6],
              }}
            >
              <Box className="stagger-enter" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
                {performance ? (
                  <Box style={{ position: 'relative' }}>
                    <OverviewPerformanceCard
                      performance={performance as ExtendedPerformance}
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
                        height: '40%',
                        background: 'linear-gradient(to bottom, transparent 0%, var(--color-blur-overlay) 60%, var(--color-lock-bg) 100%)',
                        backdropFilter: tokens.glass.blur.xs,
                        WebkitBackdropFilter: tokens.glass.blur.xs,
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
                {/* Equity Curve Chart - visible on overview for all users */}
                {equityCurve && (
                  <EquityCurveSection
                    equityCurve={equityCurve}
                    traderHandle={profile.handle}
                    delay={0}
                  />
                )}
                <TraderFeed
                  items={feed.filter((f) => f.type !== 'group_post')}
                  title={t('activities')}
                  isRegistered={profile.isRegistered}
                  traderId={profile.id}
                  traderHandle={profile.handle}
                  source={profile.source}
                />
                {/* Auto-generated trader activity timeline */}
                {profile.handle && (
                  <TraderActivityTimeline handle={profile.handle} source={profile.source} />
                )}
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
                        <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                        <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
                      </svg>
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
