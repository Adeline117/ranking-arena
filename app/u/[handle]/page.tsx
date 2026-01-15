'use client'

import { useEffect, useState, Suspense } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
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
import AccountRequiredStats from '@/app/components/trader/AccountRequiredStats'
import CreatedGroups from '@/app/components/trader/CreatedGroups'
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

type TabKey = 'overview' | 'stats' | 'portfolio'

function UserHomeContent(props: { params: { handle: string } | Promise<{ handle: string }> }) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  
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
        // 解码 URL 编码的 handle（中文等特殊字符会被编码）
        const decodedHandle = decodeURIComponent(handle)
        
        // 先尝试从 trader_sources 获取（如果用户也是交易员）
        let profileData: TraderProfile | null = await getTraderByHandle(handle)
        let isTraderInRanking = !!profileData // 标记是否在排行榜上

        // 如果找不到，从 user_profiles 表获取注册用户信息（profiles 表不存在）
        if (!profileData) {
          
          // 检查是否在排行榜上（即使不是trader，也可能在trader_sources中）
          // 尝试所有数据源查找
          const sources = ['binance_web3', 'binance', 'bybit', 'bitget', 'mexc', 'coinex']
          let foundInRanking = false
          
          for (const sourceType of sources) {
            const { data: sourceData } = await supabase
              .from('trader_sources')
              .select('source_trader_id')
              .eq('source', sourceType)
              .eq('handle', decodedHandle)
              .maybeSingle()
            
            if (sourceData) {
              foundInRanking = true
              break
            }
          }
          
          isTraderInRanking = foundInRanking
          
          // 直接使用 user_profiles 表（因为 profiles 表不存在）
          // 先通过 handle 查询（使用解码后的 handle）
          let userProfile = null
          console.log('[UserPage] Querying user_profiles by handle:', handle, '(decoded:', decodedHandle, ')')
          
          // 先尝试解码后的 handle
          const { data: profileByHandle, error: handleError } = await supabase
            .from('user_profiles')
            .select('*')
            .eq('handle', decodedHandle)
            .maybeSingle()

          console.log('[UserPage] Query by handle result:', profileByHandle, 'error:', handleError)

          if (profileByHandle) {
            userProfile = profileByHandle
          } else {
            // 如果通过 handle 找不到，尝试通过 id 查询（handle 可能是 userId）
            // 注意：只有当 handle 看起来像 UUID 时才尝试通过 id 查询
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            if (uuidRegex.test(handle)) {
              console.log('[UserPage] Querying user_profiles by id:', handle)
              const { data: profileById, error: idError } = await supabase
                .from('user_profiles')
                .select('*')
                .eq('id', handle)
                .maybeSingle()
              
              console.log('[UserPage] Query by id result:', profileById, 'error:', idError)
              
              if (profileById) {
                userProfile = profileById
                // 如果用户有设置 handle，重定向到正确的 URL
                if (profileById.handle && profileById.handle !== decodedHandle) {
                  console.log('[UserPage] Redirecting to correct handle:', profileById.handle)
                  window.location.href = `/u/${encodeURIComponent(profileById.handle)}`
                  return
                }
              }
            }
            
            // 如果还是找不到，检查当前登录用户
            if (!userProfile) {
              const { data: { user: currentUser } } = await supabase.auth.getUser()
              if (currentUser) {
                console.log('[UserPage] Checking current user profile by userId:', currentUser.id)
                const { data: currentUserProfile } = await supabase
                  .from('user_profiles')
                  .select('*')
                  .eq('id', currentUser.id)
                  .maybeSingle()
                
                console.log('[UserPage] Current user profile:', currentUserProfile)
                
                if (currentUserProfile) {
                  // 找到当前用户的 profile
                  // 如果用户有 handle 且与 URL 不同，重定向
                  if (currentUserProfile.handle && currentUserProfile.handle !== decodedHandle) {
                    console.log('[UserPage] Redirecting to user handle:', currentUserProfile.handle)
                    window.location.href = `/u/${encodeURIComponent(currentUserProfile.handle)}`
                    return
                  }
                  // 如果 handle 匹配或用户没有设置 handle，使用该 profile
                  if (currentUserProfile.handle === decodedHandle || !currentUserProfile.handle) {
                    userProfile = currentUserProfile
                  }
                }
              }
            }
          }

          if (userProfile) {
            // 获取粉丝数（关注他的人）- 使用 trader_follows 表
            const { count: followersCount } = await supabase
              .from('trader_follows')
              .select('*', { count: 'exact', head: true })
              .eq('trader_id', userProfile.id)
            
            // 获取关注的人数量（他关注的人）- 使用 trader_follows 表
            const { count: followingCount } = await supabase
              .from('trader_follows')
              .select('*', { count: 'exact', head: true })
              .eq('user_id', userProfile.id)

            profileData = {
              handle: userProfile.handle || decodedHandle,
              id: userProfile.id,
              bio: userProfile.bio || null,
              followers: followersCount || 0,
              following: followingCount || 0,
              copiers: 0,
              // 如果用户在排行榜上但没有设置头像，不生成头像（avatar_url为null）
              // 如果用户不在排行榜上且没有设置头像，在Avatar组件中会生成头像
              avatar_url: userProfile.avatar_url || (foundInRanking ? null : undefined),
              isRegistered: true,
            }
          }
        } else {
          // 如果从 trader_sources 找到了（是trader），确保获取正确的粉丝数和关注数
          // 但保留 trader 的原始头像（avatar_url 已经由 getTraderByHandle 设置）
          // 重要：保存 trader 的原始头像，防止被覆盖
          const traderOriginalAvatarUrl = profileData.avatar_url
          
          const { count: followersCount } = await supabase
            .from('trader_follows')
            .select('*', { count: 'exact', head: true })
            .eq('trader_id', profileData.id)
          
          const { count: followingCount } = await supabase
            .from('trader_follows')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', profileData.id)

          if (followersCount !== null) {
            profileData.followers = followersCount
          }
          if (followingCount !== null) {
            profileData.following = followingCount
          }
          // 确保 avatar_url 永远使用 trader 的原始头像，即使 trader 也在平台注册了
          // 永远不使用 user_profiles 中的 avatar_url 覆盖 trader 的原始头像
          profileData.avatar_url = traderOriginalAvatarUrl
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
                  // 获取粉丝数和关注数 - 使用 trader_follows 表
                  const { count: followersCount } = await supabase
                    .from('trader_follows')
                    .select('*', { count: 'exact', head: true })
                    .eq('trader_id', newProfile.id)
                  
                  const { count: followingCount } = await supabase
                    .from('trader_follows')
                    .select('*', { count: 'exact', head: true })
                    .eq('user_id', newProfile.id)

                  // 检查新创建的用户是否在排行榜上
                  let foundInRankingForNewProfile = false
                  const sources = ['binance_web3', 'binance', 'bybit', 'bitget', 'mexc', 'coinex']
                  for (const sourceType of sources) {
                    const { data: sourceData } = await supabase
                      .from('trader_sources')
                      .select('source_trader_id')
                      .eq('source', sourceType)
                      .eq('handle', newProfile.handle || defaultHandle)
                      .maybeSingle()
                    
                    if (sourceData) {
                      foundInRankingForNewProfile = true
                      break
                    }
                  }
                  
                  // 使用新创建的 profile
                  profileData = {
                    handle: newProfile.handle || defaultHandle,
                    id: newProfile.id,
                    bio: newProfile.bio || null,
                    followers: followersCount || 0,
                    following: followingCount || 0,
                    copiers: 0,
                    // 如果设置了头像使用设置的头像，否则根据是否在排行榜上决定是否生成头像
                    avatar_url: newProfile.avatar_url || (foundInRankingForNewProfile ? null : undefined),
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
                // 如果找到用户且有 handle，重定向到正确的 handle
                if (profileById.handle && profileById.handle !== handle) {
                  console.log('[UserPage] Found profile by ID, redirecting to:', profileById.handle)
                  window.location.href = `/u/${profileById.handle}`
                  return
                }
                // 如果用户没有设置 handle，使用当前 profile 数据显示页面
                console.log('[UserPage] Found profile by ID, using profile data')
                const { count: followersCount } = await supabase
                  .from('trader_follows')
                  .select('*', { count: 'exact', head: true })
                  .eq('trader_id', profileById.id)
                
                const { count: followingCount } = await supabase
                  .from('trader_follows')
                  .select('*', { count: 'exact', head: true })
                  .eq('user_id', profileById.id)

                profileData = {
                  handle: profileById.handle || decodedHandle,
                  id: profileById.id,
                  bio: profileById.bio || null,
                  followers: followersCount || 0,
                  following: followingCount || 0,
                  copiers: 0,
                  avatar_url: profileById.avatar_url || undefined,
                  isRegistered: true,
                }
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
                    console.log('[UserPage] User profile created:', userProfileData.handle)
                    // 如果新创建的 handle 与当前 URL 不同，重定向
                    if (userProfileData.handle && userProfileData.handle !== decodedHandle) {
                      console.log('[UserPage] Redirecting to:', userProfileData.handle)
                      window.location.href = `/u/${encodeURIComponent(userProfileData.handle)}`
                      return
                    }
                    // 否则直接使用创建的数据
                    const { count: followersCount } = await supabase
                      .from('trader_follows')
                      .select('*', { count: 'exact', head: true })
                      .eq('trader_id', userProfileData.id)
                    
                    const { count: followingCount } = await supabase
                      .from('trader_follows')
                      .select('*', { count: 'exact', head: true })
                      .eq('user_id', userProfileData.id)

                    profileData = {
                      handle: userProfileData.handle || decodedHandle,
                      id: userProfileData.id,
                      bio: userProfileData.bio || null,
                      followers: followersCount || 0,
                      following: followingCount || 0,
                      copiers: 0,
                      avatar_url: userProfileData.avatar_url || undefined,
                      isRegistered: true,
                    }
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
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], textAlign: 'center' }}>
          <Box
            style={{
              width: 80,
              height: 80,
              borderRadius: '50%',
              background: tokens.colors.bg.secondary,
              border: `2px solid ${tokens.colors.border.primary}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto',
              marginBottom: tokens.spacing[4],
            }}
          >
            <Text size="2xl" weight="bold" color="tertiary">
              {handle?.charAt(0)?.toUpperCase() || '?'}
            </Text>
          </Box>
          <Text size="xl" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
            @{handle}
          </Text>
          <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
            该用户尚未在平台注册
          </Text>
          <Link 
            href="/" 
            style={{ 
              color: tokens.colors.accent?.primary || '#8b6fa8', 
              textDecoration: 'none',
              fontSize: tokens.typography.fontSize.sm,
            }}
          >
            ← 返回首页
          </Link>
        </Box>
      </Box>
    )
  }

  const isOwnProfile = currentUserId === profile.id

  // 结构化数据（JSON-LD）
  const structuredData = profile ? {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: profile.handle,
    description: profile.bio || `用户 ${profile.handle}`,
    url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'}/u/${encodeURIComponent(handle)}`,
    image: profile.avatar_url || undefined,
    identifier: profile.id,
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
          isOwnProfile={isOwnProfile}
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
              {/* 创办的小组 */}
              <CreatedGroups userId={profile.id} />
              {isOwnProfile && currentUserId && (
                <AccountRequiredStats userId={currentUserId} />
              )}
              {similarTraders.length > 0 && <SimilarTraders traders={similarTraders} />}
            </Box>
          </Box>
        )}

        {activeTab === 'stats' && stats && (
          <StatsPage stats={stats} traderHandle={profile.handle} />
        )}

        {activeTab === 'portfolio' && <PortfolioTable items={portfolio} />}
      </Box>
    </Box>
  )
}

export default function UserHomePage(props: { params: { handle: string } | Promise<{ handle: string }> }) {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <RankingSkeleton />
        </Box>
      </Box>
    }>
      <UserHomeContent {...props} />
    </Suspense>
  )
}



