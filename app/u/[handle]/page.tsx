'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
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

export default function UserHomePage(props: { params: { handle: string } | Promise<{ handle: string }> }) {
  const [handle, setHandle] = useState<string>('')
  const [email, setEmail] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [profile, setProfile] = useState<TraderProfile | null>(null)
  const [performance, setPerformance] = useState<TraderPerformance | null>(null)
  const [stats, setStats] = useState<TraderStats | null>(null)
  const [portfolio, setPortfolio] = useState<PortfolioItem[]>([])
  const [feed, setFeed] = useState<TraderFeedItem[]>([])
  const [similarTraders, setSimilarTraders] = useState<TraderProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<TabKey>('overview')
  const router = useRouter()

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
      setCurrentUserId(data.user?.id ?? null)
    })
  }, [])

  useEffect(() => {
    if (!handle) {
      return
    }

    const load = async () => {
      setLoading(true)

      try {
        // 先尝试从 trader_sources 获取（如果用户也是交易员）
        let profileData = await getTraderByHandle(handle)

        // 如果找不到，从 profiles 表获取注册用户信息
        if (!profileData) {
          // 先尝试 profiles 表
          const { data: profile } = await supabase
            .from('profiles')
            .select('*')
            .eq('handle', handle)
            .maybeSingle()

          if (profile) {
            // 获取粉丝数
            const { count } = await supabase
              .from('follows')
              .select('*', { count: 'exact', head: true })
              .eq('trader_id', profile.id)

            profileData = {
              handle: profile.handle || handle,
              id: profile.id,
              bio: profile.bio || null,
              followers: count || 0,
              copiers: 0,
              avatar_url: profile.avatar_url || null,
              isRegistered: true,
            }
          } else {
            // 再尝试 user_profiles 表
            const { data: userProfile } = await supabase
              .from('user_profiles')
              .select('*')
              .eq('handle', handle)
              .maybeSingle()

            if (userProfile) {
              // 获取粉丝数
              const { count } = await supabase
                .from('follows')
                .select('*', { count: 'exact', head: true })
                .eq('trader_id', userProfile.id)

              profileData = {
                handle: userProfile.handle || handle,
                id: userProfile.id,
                bio: userProfile.bio || null,
                followers: count || 0,
                copiers: 0,
                avatar_url: userProfile.avatar_url || null,
                isRegistered: true,
              }
            }
          }
        } else {
          // 如果从 trader_sources 找到了，确保获取正确的粉丝数
          const { count } = await supabase
            .from('follows')
            .select('*', { count: 'exact', head: true })
            .eq('trader_id', profileData.id)

          if (count !== null) {
            profileData.followers = count
          }
        }

        if (!profileData) {
          setLoading(false)
          return
        }

        const [performanceData, statsData, portfolioData, feedData, similarData] = await Promise.all([
          getTraderPerformance(handle).catch(() => null),
          getTraderStats(handle).catch(() => null),
          getTraderPortfolio(handle).catch(() => []),
          getTraderFeed(handle),
          getSimilarTraders(handle).catch(() => []),
        ])

        setProfile(profileData)
        setPerformance(performanceData)
        setStats(statsData)
        setPortfolio(portfolioData)
        setFeed(feedData)
        setSimilarTraders(similarData)
      } catch (error) {
        console.error('Error loading user data:', error)
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
            用户不存在
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

  const isOwnProfile = currentUserId === profile.id

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
        {/* Header */}
        <TraderHeader
          handle={profile.handle}
          traderId={profile.id}
          avatarUrl={profile.avatar_url}
          isRegistered={profile.isRegistered}
          followers={profile.followers}
          isOwnProfile={isOwnProfile}
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
            {/* Left Column - 核心绩效指标和动态 */}
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
              {performance && (
                <OverviewPerformanceCard
                  performance={performance}
                  profitableWeeksPct={stats?.additionalStats?.profitableWeeksPct}
                />
              )}
              {/* 置顶帖子 - Performance和动态之间 */}
              {feed.filter((f) => f.is_pinned && f.type !== 'group_post').length > 0 && (
                <PinnedPost item={feed.filter((f) => f.is_pinned && f.type !== 'group_post')[0]} />
              )}
              {/* 交易员动态 - 紧跟在Performance后面 */}
              <TraderFeed
                items={feed.filter((f) => f.type !== 'group_post' && !f.is_pinned)}
                title="动态"
                showPostButton={isOwnProfile}
                onPostClick={() => router.push(`/u/${handle}/new`)}
              />
            </Box>

            {/* Right Column - 交易员卡片 */}
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
              <TraderAboutCard
                handle={profile.handle}
                avatarUrl={profile.avatar_url}
                bio={profile.bio}
                followers={profile.followers}
                isRegistered={profile.isRegistered}
                isOwnProfile={isOwnProfile}
              />
              {similarTraders.length > 0 && <SimilarTraders traders={similarTraders} />}
            </Box>
          </Box>
        )}

        {activeTab === 'stats' && stats && (
          <StatsPage stats={stats} traderHandle={profile.handle} />
        )}

        {activeTab === 'portfolio' && <PortfolioTable items={portfolio} />}

        {activeTab === 'chart' && <TradingViewShell symbol={profile.handle} timeframe="1Y" />}
      </Box>
    </Box>
  )
}


