'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/Layout/TopNav'
import TraderHeader from '@/app/components/trader/TraderHeader'
import TraderTabs from '@/app/components/trader/TraderTabs'
import OverviewPerformanceCard from '@/app/components/trader/OverviewPerformanceCard'
import TraderAboutCard from '@/app/components/trader/TraderAboutCard'
import SimilarTraders from '@/app/components/trader/SimilarTraders'
import TraderFeed from '@/app/components/trader/TraderFeed'
import ExpectedDividends from '@/app/components/trader/stats/ExpectedDividends'
import TradingStats from '@/app/components/trader/stats/TradingStats'
import FrequentlyTraded from '@/app/components/trader/stats/FrequentlyTraded'
import AdditionalStats from '@/app/components/trader/stats/AdditionalStats'
import PerformanceChart from '@/app/components/trader/stats/PerformanceChart'
import PortfolioTable from '@/app/components/trader/PortfolioTable'
import TradingViewShell from '@/app/components/trader/TradingViewShell'
import { Box, Text } from '@/app/components/Base'
import { RankingSkeleton } from '@/app/components/UI/Skeleton'
import {
  getTraderByHandle,
  getTraderPerformance,
  getTraderStats,
  getTraderPortfolio,
  getTraderFeed,
  getSimilarTraders,
  type TraderProfile,
  type TraderPerformance,
  type TraderStats,
  type PortfolioItem,
  type TraderFeedItem,
} from '@/lib/data/trader'

type TabKey = 'overview' | 'stats' | 'portfolio' | 'chart'

export default function TraderPage(props: { params: { handle: string } | Promise<{ handle: string }> }) {
  const [handle, setHandle] = useState<string>('')
  const [email, setEmail] = useState<string | null>(null)
  const [profile, setProfile] = useState<TraderProfile | null>(null)
  const [performance, setPerformance] = useState<TraderPerformance | null>(null)
  const [stats, setStats] = useState<TraderStats | null>(null)
  const [portfolio, setPortfolio] = useState<PortfolioItem[]>([])
  const [feed, setFeed] = useState<TraderFeedItem[]>([])
  const [similarTraders, setSimilarTraders] = useState<TraderProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<TabKey>('overview')

  // 解析 params
  useEffect(() => {
    if (props.params && typeof props.params === 'object' && 'then' in props.params) {
      (props.params as Promise<{ handle: string }>).then((resolved) => {
        setHandle(resolved?.handle ?? '')
      })
    } else {
      setHandle(String((props.params as { handle: string })?.handle ?? ''))
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
        const [profileData, performanceData, statsData, portfolioData, feedData, similarData] = await Promise.all([
          getTraderByHandle(handle),
          getTraderPerformance(handle),
          getTraderStats(handle),
          getTraderPortfolio(handle),
          getTraderFeed(handle),
          getSimilarTraders(handle),
        ])

        setProfile(profileData)
        setPerformance(performanceData)
        setStats(statsData)
        setPortfolio(portfolioData)
        setFeed(feedData)
        setSimilarTraders(similarData)
      } catch (error) {
        console.error('Error loading trader data:', error)
        setProfile(null)
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [handle])

  const handleViewPerformance = () => {
    // View 按钮点击后，在当前页面展开 Performance 详情
    // 这里可以滚动到 Performance 区域或展开更多详情
    // 暂时不做特殊处理，保持在同一页面
  }

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
            交易员不存在
          </Text>
          <Text size="sm" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
            Handle: {handle || '(empty)'}
          </Text>
          <Link href="/" style={{ color: tokens.colors.text.secondary, textDecoration: 'none', marginTop: tokens.spacing[2], display: 'inline-block' }}>
            ← 返回首页
          </Link>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
        {/* Header */}
        <TraderHeader
          handle={profile.handle}
          avatarUrl={profile.avatar_url}
          isRegistered={profile.isRegistered}
          followers={profile.followers}
        />

        {/* Tabs */}
        <TraderTabs activeTab={activeTab} onTabChange={setActiveTab} />

        {/* Tab Content */}
        {activeTab === 'overview' && (
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 320px',
              gap: tokens.spacing[8],
            }}
          >
            {/* Left Column - 核心绩效指标 */}
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[8] }}>
              {performance && <OverviewPerformanceCard performance={performance} />}
              {/* 交易员动态 - 系统生成内容为主，标记为认证交易员 */}
              <TraderFeed items={feed.filter((f) => f.type !== 'group_post')} title="交易员动态" />
            </Box>

            {/* Right Column - 交易员卡片 */}
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
              <TraderAboutCard
                handle={profile.handle}
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
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
            <TrustStats stats={stats} />
          </Box>
        )}

        {activeTab === 'portfolio' && <PortfolioTable items={portfolio} />}

        {activeTab === 'chart' && <TradingViewShell symbol={profile.handle} timeframe="1Y" />}
      </Box>
    </Box>
  )
}

