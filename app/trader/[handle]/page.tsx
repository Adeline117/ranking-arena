'use client'

import { useEffect, useState, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import TopNav from '@/app/components/layout/TopNav'
import TraderHeader from '@/app/components/trader/TraderHeader'
import TraderTabs from '@/app/components/trader/TraderTabs'
import OverviewPerformanceCard from '@/app/components/trader/OverviewPerformanceCard'
import TraderAboutCard from '@/app/components/trader/TraderAboutCard'
import SimilarTraders from '@/app/components/trader/SimilarTraders'
import TraderFeed from '@/app/components/trader/TraderFeed'
import StatsPage from '@/app/components/trader/stats/StatsPage'
// PinnedPost 组件已集成到 TraderFeed 中（置顶帖子自动显示在动态列表最上方）
import PortfolioTable from '@/app/components/trader/PortfolioTable'
import ScoreBreakdown from '@/app/components/premium/ScoreBreakdown'
import { Box, Text } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import type {
  TraderProfile,
  TraderPerformance,
  TraderStats,
  PortfolioItem,
  PositionHistoryItem,
  TraderFeedItem,
} from '@/lib/data/trader'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import {
  generateTraderProfilePageSchema,
  generateBreadcrumbSchema,
  combineSchemas,
} from '@/lib/seo'

type TabKey = 'overview' | 'stats' | 'portfolio'

// 新数据类型
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
  direction: string
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

function TraderContent(props: { params: { handle: string } | Promise<{ handle: string }> }) {
  const { t } = useLanguage()
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const { isPro } = useSubscription()
  
  const [handle, setHandle] = useState<string>('')
  const [email, setEmail] = useState<string | null>(null)
  const [profile, setProfile] = useState<TraderProfile | null>(null)
  const [performance, setPerformance] = useState<TraderPerformance | null>(null)
  const [stats, setStats] = useState<TraderStats | null>(null)
  const [portfolio, setPortfolio] = useState<PortfolioItem[]>([])
  const [positionHistory, setPositionHistory] = useState<PositionHistoryItem[]>([])
  const [extendedPositionHistory, setExtendedPositionHistory] = useState<ExtendedPositionHistoryItem[]>([])
  const [feed, setFeed] = useState<TraderFeedItem[]>([])
  const [similarTraders, setSimilarTraders] = useState<TraderProfile[]>([])
  const [loading, setLoading] = useState(true)
  
  // 新数据状态
  const [assetBreakdown, setAssetBreakdown] = useState<AssetBreakdownData | undefined>(undefined)
  const [equityCurve, setEquityCurve] = useState<EquityCurveData | undefined>(undefined)
  
  // Read tab from URL, default to 'overview'
  const urlTab = searchParams.get('tab') as TabKey | null
  const [activeTab, setActiveTab] = useState<TabKey>(
    urlTab && ['overview', 'stats', 'portfolio'].includes(urlTab) ? urlTab : 'overview'
  )

  // Update URL when tab changes
  const handleTabChange = (tab: TabKey) => {
    setActiveTab(tab)
    const params = new URLSearchParams(searchParams.toString())
    if (tab === 'overview') {
      params.delete('tab') // Don't show tab in URL for default
    } else {
      params.set('tab', tab)
    }
    const newUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname
    router.replace(newUrl, { scroll: false })
  }

  // Sync with URL changes
  useEffect(() => {
    const tab = searchParams.get('tab') as TabKey | null
    if (tab && ['overview', 'stats', 'portfolio'].includes(tab)) {
      setActiveTab(tab)
    } else if (!tab) {
      setActiveTab('overview')
    }
  }, [searchParams])

  // 解析 params
  useEffect(() => {
    const resolveHandle = (rawHandle: string) => {
      // Next.js 会自动解码 URL，但为了安全，我们再次解码
      try {
        return decodeURIComponent(rawHandle)
      } catch {
        return rawHandle
      }
    }
    
    if (props.params && typeof props.params === 'object' && 'then' in props.params) {
      (props.params as Promise<{ handle: string }>).then((resolved) => {
        setHandle(resolveHandle(resolved?.handle ?? ''))
      })
    } else {
      setHandle(resolveHandle(String((props.params as { handle: string })?.handle ?? '')))
    }
  }, [props.params])

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    })
  }, [])

  useEffect(() => {
    if (!handle) {
      return
    }

    const load = async () => {
      setLoading(true)

      try {
        // 通过 API 获取数据（服务端使用正确的 service role key）
        const response = await fetch(`/api/traders/${encodeURIComponent(handle)}`)
        
        if (!response.ok) {
          console.error('Error loading trader data:', response.status)
          setProfile(null)
          return
        }

        const data = await response.json()
        
        setProfile(data.profile)
        setPerformance(data.performance)
        setStats(data.stats)
        setPortfolio(data.portfolio || [])
        setPositionHistory(data.positionHistory || [])
        setExtendedPositionHistory(data.positionHistory || [])
        setFeed(data.feed || [])
        setSimilarTraders(data.similarTraders || [])
        
        // 设置新数据
        setAssetBreakdown(data.assetBreakdown)
        setEquityCurve(data.equityCurve)
      } catch (error) {
        console.error('Error loading trader data:', error)
        setProfile(null)
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [handle])

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

  // 结构化数据（JSON-LD）- 使用 SEO 模块生成
  const structuredData = profile ? combineSchemas(
    generateTraderProfilePageSchema({
      handle: profile.handle,
      id: profile.id,
      bio: profile.bio,
      avatarUrl: profile.avatar_url,
      source: profile.source,
      followers: profile.followers,
      roi90d: performance?.roi_90d,
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
      {/* 结构化数据（JSON-LD） */}
      {structuredData && <JsonLd data={structuredData} />}
      
      <TopNav email={email} />

      <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
        {/* Header */}
        <TraderHeader
          handle={profile.handle}
          traderId={profile.id}
          avatarUrl={profile.avatar_url}
          coverUrl={profile.cover_url}
          isRegistered={profile.isRegistered}
          followers={profile.followers}
          source={profile.source}
        />

        {/* Tabs */}
        <TraderTabs activeTab={activeTab} onTabChange={handleTabChange} />

        {/* Tab Content with animation */}
        <Box
          key={activeTab}
          style={{
            animation: 'fadeInUp 0.4s ease-out forwards',
          }}
        >
          {activeTab === 'overview' && (
            <Box
              className="profile-grid main-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 340px',
                gap: tokens.spacing[8],
              }}
            >
              {/* Left Column - 核心绩效指标和动态 */}
              <Box className="stagger-enter" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
                {performance && (
                  <OverviewPerformanceCard performance={performance} />
                )}
                {/* 交易员动态（置顶帖子自动显示在最上面） */}
                <TraderFeed items={feed.filter((f) => f.type !== 'group_post')} title={t('activities')} />
              </Box>

              {/* Right Column - 交易员卡片 */}
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
                <TraderAboutCard
                  handle={profile.handle}
                  traderId={profile.id}
                  avatarUrl={profile.avatar_url}
                  bio={profile.bio}
                  followers={profile.followers}
                  isRegistered={profile.isRegistered}
                />
                
                {/* 评分详情 - Pro 功能 */}
                {performance && (
                  <ScoreBreakdown
                    arenaScore={performance.arena_score ?? null}
                    returnScore={performance.return_score ?? null}
                    drawdownScore={performance.drawdown_score ?? null}
                    stabilityScore={performance.stability_score ?? null}
                    source={profile.source}
                    isPro={isPro}
                    onUnlock={() => router.push('/pricing')}
                  />
                )}
                
                {similarTraders.length > 0 && <SimilarTraders traders={similarTraders} />}
              </Box>
            </Box>
          )}

          {activeTab === 'stats' && stats && (
            <StatsPage 
              stats={stats} 
              traderHandle={profile.handle}
              assetBreakdown={assetBreakdown}
              equityCurve={equityCurve}
              positionHistory={extendedPositionHistory}
            />
          )}

          {activeTab === 'portfolio' && <PortfolioTable items={portfolio} history={positionHistory} />}
        </Box>
      </Box>
    </Box>
  )
}

export default function TraderPage(props: { params: { handle: string } | Promise<{ handle: string }> }) {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <RankingSkeleton />
        </Box>
      </Box>
    }>
      <TraderContent {...props} />
    </Suspense>
  )
}
