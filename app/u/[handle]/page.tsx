'use client'

import { useEffect, useState, Suspense } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/layout/TopNav'
import PostFeed from '@/app/components/post/PostFeed'
import JoinedGroups from '@/app/components/trader/JoinedGroups'
import UserBookmarkFolders from '@/app/components/trader/UserBookmarkFolders'
import { Box, Text, Button } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
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
import { DynamicFollowListModal as FollowListModal } from '@/app/components/ui/dynamic'
import UserFollowButton from '@/app/components/ui/UserFollowButton'
import MessageButton from '@/app/components/ui/MessageButton'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import { ProBadgeOverlay } from '@/app/components/ui/ProBadge'

// 简化的用户资料头部组件
interface UserProfileHeaderProps {
  profile: TraderProfile
  isOwnProfile: boolean
  proBadgeTier: 'pro' | null
  socialLinks: { twitter?: string; telegram?: string; discord?: string; github?: string; website?: string }
  currentUserId: string | null
}

function UserProfileHeader({
  profile,
  isOwnProfile,
  proBadgeTier,
  socialLinks,
  currentUserId,
}: UserProfileHeaderProps) {
  const router = useRouter()
  const { t, language } = useLanguage()
  const isZh = language === 'zh'
  const [modalType, setModalType] = useState<'followers' | 'following' | null>(null)
  const [followersCount, setFollowersCount] = useState(profile.followers || 0)
  const followingCount = (profile.following || 0) + (profile.followingTraders || 0)

  const hasCover = Boolean(profile.cover_url)
  const containerBackground = hasCover
    ? `linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.6) 100%), url(${profile.cover_url}) center/cover no-repeat`
    : `linear-gradient(135deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}E8 100%)`

  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: tokens.spacing[6],
        background: containerBackground,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}50`,
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.1)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* 装饰背景 */}
      {!hasCover && (
        <Box style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
          <Box
            style={{
              position: 'absolute',
              top: -100,
              left: -100,
              width: 300,
              height: 300,
              background: `radial-gradient(circle, ${tokens.colors.accent.primary}08 0%, transparent 70%)`,
            }}
          />
        </Box>
      )}

      {/* 头像 */}
      <Box style={{ position: 'relative', marginBottom: tokens.spacing[4] }}>
        <Box
          style={{
            width: 96,
            height: 96,
            borderRadius: tokens.radius.full,
            background: profile.avatar_url ? tokens.colors.bg.secondary : getAvatarGradient(profile.id),
            border: `3px solid ${tokens.colors.border.primary}`,
            display: 'grid',
            placeItems: 'center',
            overflow: 'hidden',
            boxShadow: tokens.shadow.lg,
          }}
        >
          {profile.avatar_url ? (
            <img
              src={`/api/avatar?url=${encodeURIComponent(profile.avatar_url)}`}
              alt={profile.handle}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={(e) => {
                const img = e.target as HTMLImageElement
                img.style.display = 'none'
              }}
            />
          ) : (
            <Text size="2xl" weight="black" style={{ color: '#fff', fontSize: 40 }}>
              {getAvatarInitial(profile.handle)}
            </Text>
          )}
        </Box>
        {proBadgeTier === 'pro' && <ProBadgeOverlay position="bottom-right" />}
      </Box>

      {/* 名字 */}
      <Text
        size="2xl"
        weight="black"
        style={{
          color: hasCover ? '#fff' : tokens.colors.text.primary,
          textShadow: hasCover ? '0 2px 8px rgba(0,0,0,0.5)' : undefined,
          marginBottom: tokens.spacing[2],
        }}
      >
        {profile.handle}
      </Text>

      {/* 个人简介 */}
      {profile.bio ? (
        <Text
          size="sm"
          style={{
            color: hasCover ? 'rgba(255,255,255,0.85)' : tokens.colors.text.secondary,
            textShadow: hasCover ? '0 1px 4px rgba(0,0,0,0.3)' : undefined,
            textAlign: 'center',
            maxWidth: 400,
            marginBottom: tokens.spacing[4],
            lineHeight: 1.6,
          }}
        >
          {profile.bio}
        </Text>
      ) : isOwnProfile ? (
        <Text
          size="sm"
          style={{
            color: hasCover ? 'rgba(255,255,255,0.6)' : tokens.colors.text.tertiary,
            fontStyle: 'italic',
            marginBottom: tokens.spacing[4],
          }}
        >
          {isZh ? '点击编辑添加个人简介' : 'Click edit to add a bio'}
        </Text>
      ) : null}

      {/* Following / Followers */}
      <Box style={{ display: 'flex', gap: tokens.spacing[6], marginBottom: tokens.spacing[4] }}>
        {/* Following */}
        <Box
          onClick={() => isOwnProfile && router.push('/following')}
          style={{
            cursor: isOwnProfile ? 'pointer' : 'default',
            textAlign: 'center',
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.md,
            transition: 'background 0.2s',
          }}
          onMouseEnter={(e) => {
            if (isOwnProfile) e.currentTarget.style.background = `${tokens.colors.accent.primary}15`
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
          }}
        >
          <Text
            size="lg"
            weight="black"
            style={{
              color: hasCover ? '#fff' : tokens.colors.text.primary,
              textShadow: hasCover ? '0 1px 4px rgba(0,0,0,0.3)' : undefined,
            }}
          >
            {followingCount}
          </Text>
          <Text
            size="xs"
            style={{
              color: hasCover ? 'rgba(255,255,255,0.7)' : tokens.colors.text.tertiary,
              textShadow: hasCover ? '0 1px 2px rgba(0,0,0,0.2)' : undefined,
            }}
          >
            {t('following')}
          </Text>
        </Box>

        {/* Followers */}
        <Box
          onClick={() => {
            if (profile.isRegistered && (isOwnProfile || profile.showFollowers)) {
              setModalType('followers')
            }
          }}
          style={{
            cursor: profile.isRegistered && (isOwnProfile || profile.showFollowers) ? 'pointer' : 'default',
            textAlign: 'center',
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.md,
            transition: 'background 0.2s',
          }}
          onMouseEnter={(e) => {
            if (profile.isRegistered && (isOwnProfile || profile.showFollowers)) {
              e.currentTarget.style.background = `${tokens.colors.accent.primary}15`
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
          }}
        >
          <Text
            size="lg"
            weight="black"
            style={{
              color: hasCover ? '#fff' : tokens.colors.text.primary,
              textShadow: hasCover ? '0 1px 4px rgba(0,0,0,0.3)' : undefined,
            }}
          >
            {followersCount}
          </Text>
          <Text
            size="xs"
            style={{
              color: hasCover ? 'rgba(255,255,255,0.7)' : tokens.colors.text.tertiary,
              textShadow: hasCover ? '0 1px 2px rgba(0,0,0,0.2)' : undefined,
            }}
          >
            {t('followers')}
          </Text>
        </Box>
      </Box>

      {/* 社交链接 */}
      {socialLinks && Object.values(socialLinks).some(v => v) && (
        <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[4], flexWrap: 'wrap', justifyContent: 'center' }}>
          {socialLinks.twitter && (
            <a
              href={`https://x.com/${socialLinks.twitter}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                borderRadius: tokens.radius.md,
                background: `${tokens.colors.bg.tertiary}80`,
                color: tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.xs,
                textDecoration: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span style={{ fontSize: 11 }}>𝕏</span>
              <span>@{socialLinks.twitter}</span>
            </a>
          )}
          {socialLinks.telegram && (
            <a
              href={`https://t.me/${socialLinks.telegram}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                borderRadius: tokens.radius.md,
                background: `${tokens.colors.bg.tertiary}80`,
                color: tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.xs,
                textDecoration: 'none',
              }}
            >
              TG @{socialLinks.telegram}
            </a>
          )}
        </Box>
      )}

      {/* 操作按钮 */}
      <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
        {isOwnProfile ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => router.push('/settings')}
            style={{
              background: `${tokens.colors.accent.primary}15`,
              border: `1px solid ${tokens.colors.accent.primary}40`,
            }}
          >
            {t('editProfile')}
          </Button>
        ) : profile.isRegistered && currentUserId ? (
          <>
            <UserFollowButton
              targetUserId={profile.id}
              currentUserId={currentUserId}
              size="sm"
              onFollowChange={(isFollowing) => {
                setFollowersCount(prev => isFollowing ? prev + 1 : prev - 1)
              }}
            />
            <MessageButton
              targetUserId={profile.id}
              currentUserId={currentUserId}
              size="sm"
            />
          </>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => router.push('/')}>
          ← {t('back')}
        </Button>
      </Box>

      {/* 关注列表弹窗 */}
      {profile.isRegistered && (
        <FollowListModal
          isOpen={modalType === 'followers'}
          onClose={() => setModalType(null)}
          type="followers"
          handle={profile.handle}
          currentUserId={currentUserId}
          isOwnProfile={isOwnProfile}
          isPublic={profile.showFollowers}
        />
      )}
    </Box>
  )
}

function UserHomeContent(props: { params: { handle: string } | Promise<{ handle: string }> }) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const { showToast } = useToast()
  const { language } = useLanguage()
  const isZh = language === 'zh'

  const [handle, setHandle] = useState<string>('')
  const [email, setEmail] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [profile, setProfile] = useState<TraderProfile | null>(null)
  const [performance, setPerformance] = useState<TraderPerformance | null>(null)
  const [stats, setStats] = useState<TraderStats | null>(null)
  const [portfolio, setPortfolio] = useState<PortfolioItem[]>([])
  const [_feed, setFeed] = useState<TraderFeedItem[]>([])
  const [similarTraders, setSimilarTraders] = useState<TraderProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [proBadgeTier, setProBadgeTier] = useState<'pro' | null>(null)
  const [socialLinks, setSocialLinks] = useState<{ twitter?: string; telegram?: string; discord?: string; github?: string; website?: string }>({})

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
        let _isTraderInRanking = !!profileData // 标记是否在排行榜上

        // 如果找不到，从 user_profiles 表获取注册用户信息（profiles 表不存在）
        if (!profileData) {
          
          // 检查是否在排行榜上 - 使用单一查询替代循环
          const { data: rankingData } = await supabase
            .from('trader_sources')
            .select('source_trader_id')
            .eq('handle', decodedHandle)
            .limit(1)

          const foundInRanking = !!(rankingData && rankingData.length > 0)
          _isTraderInRanking = foundInRanking

          // 直接使用 user_profiles 表（因为 profiles 表不存在）
          // 先通过 handle 查询（使用解码后的 handle）
          let userProfile = null

          // 先尝试解码后的 handle
          const { data: profileByHandle, error: _handleError } = await supabase
            .from('user_profiles')
            .select('*, show_followers, show_following, uid, cover_url')
            .eq('handle', decodedHandle)
            .maybeSingle()

          if (profileByHandle) {
            userProfile = profileByHandle
          } else {
            // 如果通过 handle 找不到，尝试通过 id 查询（handle 可能是 userId）
            // 注意：只有当 handle 看起来像 UUID 时才尝试通过 id 查询
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            if (uuidRegex.test(handle)) {
              const { data: profileById, error: _idError } = await supabase
                .from('user_profiles')
                .select('*, uid, cover_url')
                .eq('id', handle)
                .maybeSingle()
              
              if (profileById) {
                userProfile = profileById
                // 如果用户有设置 handle，重定向到正确的 URL（防止重定向循环）
                const targetHandle = profileById.handle
                if (targetHandle && targetHandle !== decodedHandle && targetHandle !== handle) {
                  const targetUrl = `/u/${encodeURIComponent(targetHandle)}`
                  if (typeof window !== 'undefined' && window.location.pathname !== targetUrl) {
                    window.location.href = targetUrl
                    return
                  }
                }
              }
            }
            
            // If user profile still not found, only match current user
            // if the URL handle explicitly matches the current user's ID
            if (!userProfile) {
              const { data: { user: currentUser } } = await supabase.auth.getUser()
              if (currentUser && handle === currentUser.id) {
                // URL contains the current user's UUID - load their profile
                const { data: currentUserProfile } = await supabase
                  .from('user_profiles')
                  .select('*, uid, cover_url')
                  .eq('id', currentUser.id)
                  .maybeSingle()

                if (currentUserProfile) {
                  userProfile = currentUserProfile
                  // If the current user has a handle, redirect to the canonical URL (prevent loops)
                  const targetHandle = currentUserProfile.handle
                  if (targetHandle && targetHandle !== decodedHandle && targetHandle !== handle) {
                    const targetUrl = `/u/${encodeURIComponent(targetHandle)}`
                    if (typeof window !== 'undefined' && window.location.pathname !== targetUrl) {
                      window.location.href = targetUrl
                      return
                    }
                  }
                }
              }
              // Do NOT fall back to showing the current user's profile
              // for arbitrary handles that don't match anyone
            }
          }

          if (userProfile) {
            // 获取粉丝数（关注他的人）- 使用 user_follows 表
            const { count: followersCount } = await supabase
              .from('user_follows')
              .select('*', { count: 'exact', head: true })
              .eq('following_id', userProfile.id)
            
            // 获取关注的人数量（他关注的人）- 使用 user_follows 表
            const { count: followingCount } = await supabase
              .from('user_follows')
              .select('*', { count: 'exact', head: true })
              .eq('follower_id', userProfile.id)

            profileData = {
              handle: userProfile.handle || decodedHandle,
              id: userProfile.id,
              uid: userProfile.uid || undefined, // 数字用户编号
              bio: userProfile.bio || null,
              followers: followersCount || 0,
              following: followingCount || 0,
              copiers: 0,
              // 如果用户在排行榜上但没有设置头像，不生成头像（avatar_url为null）
              // 如果用户不在排行榜上且没有设置头像，在Avatar组件中会生成头像
              avatar_url: userProfile.avatar_url || (foundInRanking ? null : undefined),
              cover_url: userProfile.cover_url || undefined,
              isRegistered: true,
              // 隐私设置
              showFollowers: userProfile.show_followers !== false,
              showFollowing: userProfile.show_following !== false,
            }
          }
        } else {
          // 如果从 trader_sources 找到了（是trader），确保获取正确的粉丝数和关注数
          // 但保留 trader 的原始头像（avatar_url 已经由 getTraderByHandle 设置）
          // 重要：保存 trader 的原始头像，防止被覆盖
          const traderOriginalAvatarUrl = profileData.avatar_url
          
          const { count: followersCount } = await supabase
            .from('user_follows')
            .select('*', { count: 'exact', head: true })
            .eq('following_id', profileData.id)
          
          const { count: followingCount } = await supabase
            .from('user_follows')
            .select('*', { count: 'exact', head: true })
            .eq('follower_id', profileData.id)

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
          
          if (user && user.email) {
            const emailHandle = user.email.split('@')[0]
            
            // Only auto-create profile if the URL handle explicitly matches
            // the current user's email prefix or full user ID
            if (handle === emailHandle || handle === user.id) {
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
                  newProfile = userProfileData
                } else if (userProfileError) {
                  // 如果错误是因为缺少 handle 列，提示用户运行修复脚本
                  if (userProfileError.message?.includes('handle') || userProfileError.code === 'PGRST204') {
                    showToast(isZh ? '数据库表结构不完整，请联系管理员' : 'Database schema incomplete, please contact admin', 'error')
                    console.error('Database schema issue: Run scripts/fix_user_profiles_complete.sql to fix')
                  }
                }

                if (newProfile) {
                  // 获取粉丝数和关注数 - 使用 user_follows 表
                  const { count: followersCount } = await supabase
                    .from('user_follows')
                    .select('*', { count: 'exact', head: true })
                    .eq('following_id', newProfile.id)
                  
                  const { count: followingCount } = await supabase
                    .from('user_follows')
                    .select('*', { count: 'exact', head: true })
                    .eq('follower_id', newProfile.id)

                  // 检查新创建的用户是否在排行榜上 - 使用单一查询
                  const { data: rankingCheck } = await supabase
                    .from('trader_sources')
                    .select('source_trader_id')
                    .eq('handle', newProfile.handle || defaultHandle)
                    .limit(1)

                  const foundInRankingForNewProfile = !!(rankingCheck && rankingCheck.length > 0)
                  
                  // 使用新创建的 profile
                  profileData = {
                    handle: newProfile.handle || defaultHandle,
                    id: newProfile.id,
                    uid: newProfile.uid || undefined,
                    bio: newProfile.bio || null,
                    followers: followersCount || 0,
                    following: followingCount || 0,
                    copiers: 0,
                    // 如果设置了头像使用设置的头像，否则根据是否在排行榜上决定是否生成头像
                    avatar_url: newProfile.avatar_url || (foundInRankingForNewProfile ? null : undefined),
                    cover_url: newProfile.cover_url || undefined,
                    isRegistered: true,
                    // 新创建的用户默认公开
                    showFollowers: true,
                    showFollowing: true,
                  }
                }
              } catch {
                // 创建 profile 失败，静默处理
              }
            }
            // IMPORTANT: When the URL handle does NOT match the current user's
            // email prefix or ID, we should NOT show the current user's profile.
            // This prevents the bug where clicking someone else's profile shows your own.
            // Simply do nothing here - profileData remains null and the "user not found" page will show.
            // When the URL handle does NOT match the current user's identifiers,
            // do NOT show the current user's profile - this prevents the bug where
            // clicking someone else's avatar shows your own profile.
          }
          
          if (!profileData) {
            setLoading(false)
            return
          }
        }

        // 获取关注的交易员数量 (trader_follows)
        if (profileData && profileData.id) {
          const { count: tradersCount } = await supabase
            .from('trader_follows')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', profileData.id)
          
          if (tradersCount !== null) {
            profileData.followingTraders = tradersCount
          }
        }

        // 先设置 profile 让页面尽快显示
        setProfile(profileData)
        setLoading(false) // 提前结束 loading 状态

        // 并行加载其他数据（非阻塞）
        const [performanceData, statsData, portfolioData, feedData, similarData] = await Promise.all([
          getTraderPerformance(handle).catch(() => null),
          getTraderStats(handle).catch(() => null),
          getTraderPortfolio(handle).catch(() => []),
          getTraderFeed(handle).catch(() => []),
          getSimilarTraders(handle).catch(() => []),
        ])

        setPerformance(performanceData)
        setStats(statsData)
        setPortfolio(portfolioData)
        setFeed(feedData)
        setSimilarTraders(similarData)

        // 异步加载 Pro 徽章和社交链接（不阻塞主流程）
        if (profileData?.id) {
          // 使用 Promise.all 并行加载 Pro 状态和社交链接
          Promise.all([
            // Pro 徽章
            (async () => {
              try {
                const { data: userSettings } = await supabase
                  .from('user_profiles')
                  .select('show_pro_badge, subscription_tier')
                  .eq('id', profileData.id)
                  .maybeSingle()

                if (userSettings?.show_pro_badge !== false) {
                  // 优先检查 subscriptions 表
                  const { data: subscription } = await supabase
                    .from('subscriptions')
                    .select('tier, status')
                    .eq('user_id', profileData.id)
                    .in('status', ['active', 'trialing'])
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle()

                  if (subscription && subscription.tier === 'pro') {
                    setProBadgeTier('pro')
                  } else if (userSettings?.subscription_tier === 'pro') {
                    // 备用：检查 user_profiles.subscription_tier（webhook 可能有延迟）
                    setProBadgeTier('pro')
                  }
                }
              } catch { /* ignore */ }
            })(),
            // 社交链接
            (async () => {
              try {
                const { data: socialData } = await supabase
                  .from('user_profiles')
                  .select('social_twitter, social_telegram, social_discord, social_github, social_website')
                  .eq('id', profileData.id)
                  .maybeSingle()

                if (socialData) {
                  setSocialLinks({
                    twitter: (socialData as Record<string, unknown>).social_twitter as string || undefined,
                    telegram: (socialData as Record<string, unknown>).social_telegram as string || undefined,
                    discord: (socialData as Record<string, unknown>).social_discord as string || undefined,
                    github: (socialData as Record<string, unknown>).social_github as string || undefined,
                    website: (socialData as Record<string, unknown>).social_website as string || undefined,
                  })
                }
              } catch { /* ignore */ }
            })(),
          ])
        }
      } catch (error) {
        console.error('Error loading user data:', error)
        setProfile(null)
        setLoadError(true)
        setLoading(false) // 确保错误时也关闭 loading
        showToast(isZh ? '加载用户数据失败' : 'Failed to load user data', 'error')
      }
    }

    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  if (!profile && loadError) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], textAlign: 'center' }}>
          <Text size="xl" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
            {isZh ? '加载失败' : 'Failed to Load'}
          </Text>
          <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
            {isZh ? '无法加载用户数据，请检查网络后重试' : 'Unable to load user data. Please check your network and try again.'}
          </Text>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              background: tokens.colors.accent.primary,
              color: '#fff',
              border: 'none',
              borderRadius: tokens.radius.md,
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            {isZh ? '重试' : 'Retry'}
          </button>
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
            {isZh ? '该用户尚未在平台注册' : 'This user has not registered on the platform'}
          </Text>
          <Link
            href="/"
            style={{
              color: tokens.colors.accent?.primary || '#8b6fa8',
              textDecoration: 'none',
              fontSize: tokens.typography.fontSize.sm,
            }}
          >
            ← {isZh ? '返回首页' : 'Back to Home'}
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
    description: profile.bio || `User ${profile.handle}`,
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

      <Box className="page-container" style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], paddingBottom: 100 }}>
        {/* 简化的个人信息栏 */}
        <UserProfileHeader
          profile={profile}
          isOwnProfile={isOwnProfile}
          proBadgeTier={proBadgeTier}
          socialLinks={socialLinks}
          currentUserId={currentUserId}
        />

        {/* 主要内容区域 */}
        <Box
          className="profile-content"
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 320px',
            gap: tokens.spacing[6],
            marginTop: tokens.spacing[6],
          }}
        >
          {/* 左侧 - 动态 */}
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
            <Box bg="secondary" p={4} radius="lg" border="primary">
              <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[4] }}>
                <Text size="lg" weight="black">{isZh ? '动态' : 'Posts'}</Text>
                {isOwnProfile && (
                  <button
                    onClick={() => router.push(`/u/${handle}/new`)}
                    style={{
                      padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                      borderRadius: tokens.radius.md,
                      border: 'none',
                      background: tokens.colors.accent.brand,
                      color: '#FFFFFF',
                      fontSize: tokens.typography.fontSize.sm,
                      fontWeight: tokens.typography.fontWeight.black,
                      cursor: 'pointer',
                    }}
                  >
                    {isZh ? '发动态' : 'New Post'}
                  </button>
                )}
              </Box>
              <PostFeed authorHandle={profile.handle} variant="compact" showSortButtons />
            </Box>
          </Box>

          {/* 右侧 - 加入的小组 + 收藏夹 */}
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
            {/* 加入的小组 */}
            <JoinedGroups userId={profile.id} />
            {/* 公开收藏夹 */}
            <UserBookmarkFolders userId={profile.id} isOwnProfile={isOwnProfile} />
          </Box>
        </Box>

        {/* 响应式样式 */}
        <style>{`
          @media (max-width: 768px) {
            .profile-content {
              grid-template-columns: 1fr !important;
            }
          }
        `}</style>
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



