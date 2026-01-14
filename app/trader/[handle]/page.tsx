'use client'

import { useEffect, useState, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { useLanguage } from '@/app/components/Utils/LanguageProvider'
import TopNav from '@/app/components/Layout/TopNav'
import TraderHeader from '@/app/components/trader/TraderHeader'
import TraderTabs from '@/app/components/trader/TraderTabs'
import OverviewPerformanceCard from '@/app/components/trader/OverviewPerformanceCard'
import TraderAboutCard from '@/app/components/trader/TraderAboutCard'
import SimilarTraders from '@/app/components/trader/SimilarTraders'
import TraderFeed from '@/app/components/trader/TraderFeed'
import StatsPage from '@/app/components/trader/stats/StatsPage'
import PinnedPost from '@/app/components/trader/PinnedPost'
import PortfolioTable from '@/app/components/trader/PortfolioTable'
import { Box, Text } from '@/app/components/Base'
import { RankingSkeleton } from '@/app/components/UI/Skeleton'
import type {
  TraderProfile,
  TraderPerformance,
  TraderStats,
  PortfolioItem,
  PositionHistoryItem,
  TraderFeedItem,
} from '@/lib/data/trader'

type TabKey = 'overview' | 'stats' | 'portfolio'

function TraderContent(props: { params: { handle: string } | Promise<{ handle: string }> }) {
  const { t } = useLanguage()
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  
  const [handle, setHandle] = useState<string>('')
  const [email, setEmail] = useState<string | null>(null)
  const [profile, setProfile] = useState<TraderProfile | null>(null)
  const [performance, setPerformance] = useState<TraderPerformance | null>(null)
  const [stats, setStats] = useState<TraderStats | null>(null)
  const [portfolio, setPortfolio] = useState<PortfolioItem[]>([])
  const [positionHistory, setPositionHistory] = useState<PositionHistoryItem[]>([])
  const [feed, setFeed] = useState<TraderFeedItem[]>([])
  const [similarTraders, setSimilarTraders] = useState<TraderProfile[]>([])
  const [loading, setLoading] = useState(true)
  
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
        const response = await fetch(`/api/trader/${encodeURIComponent(handle)}`)
        
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
        setFeed(data.feed || [])
        setSimilarTraders(data.similarTraders || [])
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

  // 结构化数据（JSON-LD）
  const structuredData = profile ? {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: profile.handle,
    description: profile.bio || `交易员 ${profile.handle}`,
    url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'}/trader/${encodeURIComponent(handle)}`,
    image: profile.avatar_url || undefined,
    identifier: profile.id,
    knowsAbout: 'Cryptocurrency Trading',
    ...(performance?.roi_90d !== undefined && {
      mainEntity: {
        '@type': 'FinancialProduct',
        name: 'Trading Performance',
        description: `90天ROI: ${performance.roi_90d}%`,
      },
    }),
  } : null

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      {/* 结构化数据（JSON-LD） */}
      {structuredData && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
      )}
      
      <TopNav email={email} />

      <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
        {/* Header */}
        <TraderHeader
          handle={profile.handle}
          traderId={profile.id}
          avatarUrl={profile.avatar_url}
          isRegistered={profile.isRegistered}
          followers={profile.followers}
          source={profile.source}
        />

        {/* Tabs */}
        <TraderTabs activeTab={activeTab} onTabChange={handleTabChange} />

        {/* Tab Content */}
        {activeTab === 'overview' && (
          <Box
            className="profile-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 320px',
              gap: tokens.spacing[8],
            }}
          >
            {/* Left Column - 核心绩效指标和动态 */}
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
              {performance && (
                <OverviewPerformanceCard performance={performance} />
              )}
              {/* 置顶帖子 - Performance和动态之间 */}
              {feed.filter((f) => f.is_pinned && f.type !== 'group_post').length > 0 && (
                <PinnedPost item={feed.filter((f) => f.is_pinned && f.type !== 'group_post')[0]} />
              )}
              {/* 交易员动态 - 紧跟在Performance后面 */}
              <TraderFeed items={feed.filter((f) => f.type !== 'group_post' && !f.is_pinned)} title={t('activities')} />
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
              {similarTraders.length > 0 && <SimilarTraders traders={similarTraders} />}
            </Box>
          </Box>
        )}

        {activeTab === 'stats' && stats && (
          <StatsPage stats={stats} traderHandle={profile.handle} />
        )}

        {activeTab === 'portfolio' && <PortfolioTable items={portfolio} history={positionHistory} />}
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

