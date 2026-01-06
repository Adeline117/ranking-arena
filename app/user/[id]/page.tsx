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

export default function UserPage(props: { params: { id: string } | Promise<{ id: string }> }) {
  const [userId, setUserId] = useState<string>('')
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
      (props.params as Promise<{ id: string }>).then((resolved) => {
        setUserId(resolved?.id ?? '')
      })
    } else {
      setUserId(String((props.params as { id: string })?.id ?? ''))
    }
  }, [props.params])

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setCurrentUserId(data.user?.id ?? null)
    })
  }, [])

  useEffect(() => {
    if (!userId) {
      return
    }

    const load = async () => {
      setLoading(true)

      try {
        // 从 profiles 表获取用户信息，如果找不到再尝试 user_profiles 表
        let profileFromDb: any = null
        
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .maybeSingle()
        
        if (profileError) {
          console.error('Error fetching from profiles:', profileError)
        }
        
        if (profile) {
          profileFromDb = profile
        } else {
          const { data: userProfile, error: userProfileError } = await supabase
            .from('user_profiles')
            .select('*')
            .eq('id', userId)
            .maybeSingle()
          
          if (userProfileError) {
            console.error('Error fetching from user_profiles:', userProfileError)
          }
          
          if (userProfile) {
            profileFromDb = userProfile
          }
        }

        if (!profileFromDb) {
          console.log('User not found in profiles or user_profiles, userId:', userId)
          setLoading(false)
          return
        }

        // 获取粉丝数
        const { count } = await supabase
          .from('follows')
          .select('*', { count: 'exact', head: true })
          .eq('trader_id', profileFromDb.id)

        // 如果有 handle，尝试从 trader_sources 获取交易员数据
        let profileData: TraderProfile | null = null
        if (profileFromDb.handle) {
          profileData = await getTraderByHandle(profileFromDb.handle)
        }

        // 如果找不到交易员数据，使用 profiles 表的数据
        if (!profileData) {
          profileData = {
            handle: profileFromDb.handle || userId.slice(0, 8),
            id: profileFromDb.id,
            bio: profileFromDb.bio || null,
            followers: count || 0,
            copiers: 0,
            avatar_url: profileFromDb.avatar_url || null,
            isRegistered: true,
          }
        } else {
          // 如果从 trader_sources 找到了，更新粉丝数
          if (count !== null) {
            profileData.followers = count
          }
        }

        const handle = profileData.handle

        // 并行获取其他数据
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
  }, [userId])

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
            ID: {userId || '(empty)'}
          </Text>
          <Link href="/" style={{ color: tokens.colors.text.secondary, textDecoration: 'none', marginTop: tokens.spacing[2], display: 'inline-block' }}>
            ← 返回首页
          </Link>
        </Box>
      </Box>
    )
  }

  const isOwnProfile = currentUserId === userId

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
                onPostClick={() => router.push(`/u/${profile.handle}/new`)}
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
