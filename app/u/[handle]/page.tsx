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
        let profileData: TraderProfile | null = await getTraderByHandle(handle)

        // 如果找不到，从 user_profiles 表获取注册用户信息（profiles 表不存在）
        if (!profileData) {
          // 直接使用 user_profiles 表（因为 profiles 表不存在）
          const { data: userProfile } = await supabase
            .from('user_profiles')
            .select('*')
            .eq('handle', handle)
            .maybeSingle()

          if (userProfile && userProfile.handle) {
            // 获取粉丝数（关注他的人）
            const { count: followersCount } = await supabase
              .from('follows')
              .select('*', { count: 'exact', head: true })
              .eq('trader_id', userProfile.id)
            
            // 获取关注的人数量（他关注的人）
            const { count: followingCount } = await supabase
              .from('follows')
              .select('*', { count: 'exact', head: true })
              .eq('user_id', userProfile.id)

            profileData = {
              handle: userProfile.handle || handle,
              id: userProfile.id,
              bio: userProfile.bio || null,
              followers: followersCount || 0,
              following: followingCount || 0,
              copiers: 0,
              avatar_url: userProfile.avatar_url || null,
              isRegistered: true,
            }
          }
        } else {
          // 如果从 trader_sources 找到了，确保获取正确的粉丝数和关注数
          const { count: followersCount } = await supabase
            .from('follows')
            .select('*', { count: 'exact', head: true })
            .eq('trader_id', profileData.id)
          
          const { count: followingCount } = await supabase
            .from('follows')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', profileData.id)

          if (followersCount !== null) {
            profileData.followers = followersCount
          }
          if (followingCount !== null) {
            profileData.following = followingCount
          }
        }

        if (!profileData) {
          // 如果找不到用户，尝试从当前登录用户创建 profile
          const { data: { user } } = await supabase.auth.getUser()
          console.log('[UserPage] No profileData found, checking user:', user?.id, 'handle:', handle)
          
          if (user && user.email) {
            const emailHandle = user.email.split('@')[0]
            console.log('[UserPage] Email handle:', emailHandle, 'current handle:', handle)
            
            // 如果 handle 匹配邮箱前缀，尝试创建 profile
            if (handle === emailHandle || handle === user.id.slice(0, 8)) {
              console.log('[UserPage] Handle matches, creating profile...')
              const defaultHandle = emailHandle
              try {
                // 尝试创建 profile（只使用 user_profiles 表，因为 profiles 表不存在）
                let newProfile = null
                
                // 先尝试插入包含 handle 的数据
                const { data: userProfileData, error: userProfileError } = await supabase
                  .from('user_profiles')
                  .upsert({
                    id: user.id,
                    handle: defaultHandle,
                  }, { onConflict: 'id' })
                  .select()
                  .single()
                
                if (userProfileData) {
                  console.log('[UserPage] Profile created in user_profiles table:', userProfileData)
                  newProfile = userProfileData
                } else if (userProfileError) {
                  console.log('[UserPage] Error creating in user_profiles table:', userProfileError)
                  console.log('[UserPage] Error details:', JSON.stringify(userProfileError, null, 2))
                  
                  // 如果错误是因为缺少 handle 列，提示用户运行修复脚本
                  if (userProfileError.message?.includes('handle') || userProfileError.code === 'PGRST204') {
                    console.error('[UserPage] ❌ user_profiles 表缺少 handle 列！')
                    console.error('[UserPage] 请运行 scripts/fix_user_profiles_complete.sql 来修复表结构')
                    alert('数据库表结构不完整，请运行 scripts/fix_user_profiles_complete.sql 来修复')
                  }
                }

                if (newProfile) {
                  console.log('[UserPage] Profile created successfully:', newProfile.handle)
                  // 获取粉丝数和关注数
                  const { count: followersCount } = await supabase
                    .from('follows')
                    .select('*', { count: 'exact', head: true })
                    .eq('trader_id', newProfile.id)
                  
                  const { count: followingCount } = await supabase
                    .from('follows')
                    .select('*', { count: 'exact', head: true })
                    .eq('user_id', newProfile.id)

                  // 使用新创建的 profile
                  profileData = {
                    handle: newProfile.handle || defaultHandle,
                    id: newProfile.id,
                    bio: newProfile.bio || null,
                    followers: followersCount || 0,
                    following: followingCount || 0,
                    copiers: 0,
                    avatar_url: newProfile.avatar_url || null,
                    isRegistered: true,
                  }
                  console.log('[UserPage] profileData set:', profileData.handle)
                } else {
                  console.log('[UserPage] Failed to create profile')
                }
              } catch (error) {
                console.error('[UserPage] Exception creating profile:', error)
                console.error('[UserPage] Exception details:', JSON.stringify(error, null, 2))
              }
            } else {
              console.log('[UserPage] Handle does not match, trying to find or create by ID...')
              // 如果 handle 不匹配，尝试通过 ID 查找
              // 直接使用 user_profiles 表（因为 profiles 表不存在）
              const { data: profileById } = await supabase
                .from('user_profiles')
                .select('*')
                .eq('id', user.id)
                .maybeSingle()
              
              if (profileById) {
                console.log('[UserPage] Found profile by ID, redirecting to:', profileById.handle)
                // 如果找到用户但 handle 不匹配，重定向到正确的 handle
                window.location.href = `/u/${profileById.handle}`
                return
              } else {
                console.log('[UserPage] No profile found by ID, creating new profile...')
                // 如果找不到，尝试创建新的 profile（不包含 email，因为 user_profiles 表没有这个列）
                try {
                  const { data: userProfileData, error: insertError } = await supabase
                    .from('user_profiles')
                    .upsert({
                      id: user.id,
                      handle: emailHandle,
                    }, { onConflict: 'id' })
                    .select()
                    .single()

                  if (userProfileData) {
                    console.log('[UserPage] User profile created, redirecting to:', emailHandle)
                    window.location.href = `/u/${emailHandle}`
                    return
                  } else if (insertError) {
                    console.log('[UserPage] Error creating user profile:', insertError)
                  }
                } catch (error) {
                  console.error('[UserPage] Error creating profile:', error)
                }
              }
            }
          }
          
          if (!profileData) {
            setLoading(false)
            return
          }
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
                traderId={profile.id}
                avatarUrl={profile.avatar_url}
                bio={profile.bio}
                followers={profile.followers}
                following={profile.following}
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



