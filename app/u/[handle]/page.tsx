'use client'

import { useEffect, useState, Suspense } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
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
import { DynamicFollowListModal as FollowListModal } from '@/app/components/ui/dynamic'
import UserFollowButton from '@/app/components/ui/UserFollowButton'
import MessageButton from '@/app/components/ui/MessageButton'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import { ProBadgeOverlay } from '@/app/components/ui/ProBadge'

interface UserProfile {
  id: string
  handle: string
  uid?: number
  bio?: string
  avatar_url?: string
  cover_url?: string
  followers: number
  following: number
  followingTraders?: number
  isRegistered?: boolean
  showFollowers?: boolean
  showFollowing?: boolean
}

function UserHomeContent(props: { params: { handle: string } | Promise<{ handle: string }> }) {
  const router = useRouter()
  const { showToast } = useToast()
  const { t, language } = useLanguage()
  const isZh = language === 'zh'

  const [handle, setHandle] = useState<string>('')
  const [email, setEmail] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [proBadgeTier, setProBadgeTier] = useState<'pro' | null>(null)
  const [socialLinks, setSocialLinks] = useState<{ twitter?: string; telegram?: string; discord?: string; github?: string; website?: string }>({})
  const [mounted, setMounted] = useState(false)
  const [avatarHovered, setAvatarHovered] = useState(false)
  const [modalType, setModalType] = useState<'followers' | 'following' | null>(null)
  const [followersCount, setFollowersCount] = useState(0)

  useEffect(() => {
    setMounted(true)
  }, [])

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
    if (!handle) return

    const load = async () => {
      setLoading(true)
      setLoadError(false)

      try {
        const decodedHandle = decodeURIComponent(handle)
        let userProfile = null

        // 通过 handle 查询
        const { data: profileByHandle } = await supabase
          .from('user_profiles')
          .select('*, show_followers, show_following, uid, cover_url')
          .eq('handle', decodedHandle)
          .maybeSingle()

        if (profileByHandle) {
          userProfile = profileByHandle
        } else {
          // 尝试通过 id 查询
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
          if (uuidRegex.test(handle)) {
            const { data: profileById } = await supabase
              .from('user_profiles')
              .select('*, uid, cover_url')
              .eq('id', handle)
              .maybeSingle()

            if (profileById) {
              userProfile = profileById
              // 重定向到正确的 handle URL
              if (profileById.handle && profileById.handle !== handle) {
                window.location.href = `/u/${encodeURIComponent(profileById.handle)}`
                return
              }
            }
          }

          // 尝试当前用户（通过 ID 或邮箱前缀匹配）
          if (!userProfile) {
            const { data: { user: currentUser } } = await supabase.auth.getUser()
            if (currentUser) {
              const emailHandle = currentUser.email?.split('@')[0]
              const isOwnProfile = handle === currentUser.id || handle === emailHandle

              if (isOwnProfile) {
                // 尝试获取现有 profile
                const { data: currentUserProfile } = await supabase
                  .from('user_profiles')
                  .select('*, uid, cover_url')
                  .eq('id', currentUser.id)
                  .maybeSingle()

                if (currentUserProfile) {
                  userProfile = currentUserProfile
                  // 如果有 handle 且不匹配当前 URL，重定向
                  if (currentUserProfile.handle && currentUserProfile.handle !== handle) {
                    window.location.href = `/u/${encodeURIComponent(currentUserProfile.handle)}`
                    return
                  }
                } else {
                  // 为当前用户创建 profile
                  const defaultHandle = emailHandle || currentUser.id.slice(0, 8)
                  const { data: newProfile, error: createError } = await supabase
                    .from('user_profiles')
                    .upsert({
                      id: currentUser.id,
                      handle: defaultHandle,
                    }, { onConflict: 'id' })
                    .select('*, uid, cover_url')
                    .single()

                  if (newProfile && !createError) {
                    userProfile = newProfile
                    // 重定向到正确的 handle URL
                    if (newProfile.handle && newProfile.handle !== handle) {
                      window.location.href = `/u/${encodeURIComponent(newProfile.handle)}`
                      return
                    }
                  }
                }
              }
            }
          }
        }

        if (!userProfile) {
          setProfile(null)
          setLoading(false)
          return
        }

        // 获取平台粉丝数和关注数
        const [{ count: followers }, { count: following }, { count: tradersCount }] = await Promise.all([
          supabase.from('user_follows').select('*', { count: 'exact', head: true }).eq('following_id', userProfile.id),
          supabase.from('user_follows').select('*', { count: 'exact', head: true }).eq('follower_id', userProfile.id),
          supabase.from('trader_follows').select('*', { count: 'exact', head: true }).eq('user_id', userProfile.id),
        ])

        const profileData: UserProfile = {
          id: userProfile.id,
          handle: userProfile.handle || decodedHandle,
          uid: userProfile.uid || undefined,
          bio: userProfile.bio || undefined,
          avatar_url: userProfile.avatar_url || undefined,
          cover_url: userProfile.cover_url || undefined,
          followers: followers || 0,
          following: following || 0,
          followingTraders: tradersCount || 0,
          isRegistered: true,
          showFollowers: userProfile.show_followers !== false,
          showFollowing: userProfile.show_following !== false,
        }

        setProfile(profileData)
        setFollowersCount(profileData.followers)
        setLoading(false)

        // 异步加载 Pro 徽章和社交链接
        Promise.all([
          (async () => {
            try {
              const { data: userSettings } = await supabase
                .from('user_profiles')
                .select('show_pro_badge, subscription_tier')
                .eq('id', userProfile.id)
                .maybeSingle()

              if (userSettings?.show_pro_badge !== false) {
                const { data: subscription } = await supabase
                  .from('subscriptions')
                  .select('tier, status')
                  .eq('user_id', userProfile.id)
                  .in('status', ['active', 'trialing'])
                  .order('created_at', { ascending: false })
                  .limit(1)
                  .maybeSingle()

                if (subscription?.tier === 'pro' || userSettings?.subscription_tier === 'pro') {
                  setProBadgeTier('pro')
                }
              }
            } catch { /* ignore */ }
          })(),
          (async () => {
            try {
              const { data: socialData } = await supabase
                .from('user_profiles')
                .select('social_twitter, social_telegram, social_discord, social_github, social_website')
                .eq('id', userProfile.id)
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
      } catch (error) {
        console.error('Error loading user data:', error)
        setProfile(null)
        setLoadError(true)
        setLoading(false)
        showToast(t('loadUserDataFailed'), 'error')
      }
    }

    load()
  }, [handle, t, showToast])

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
            {t('failedToLoad')}
          </Text>
          <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
            {t('unableToLoadUserData')}
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
            {t('retry')}
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
            {t('userNotRegistered')}
          </Text>
          <Link
            href="/"
            style={{
              color: tokens.colors.accent?.primary || '#8b6fa8',
              textDecoration: 'none',
              fontSize: tokens.typography.fontSize.sm,
            }}
          >
            ← {t('backToHome')}
          </Link>
        </Box>
      </Box>
    )
  }

  const isOwnProfile = currentUserId === profile.id
  const hasCover = Boolean(profile.cover_url)
  const followingCount = (profile.following || 0) + (profile.followingTraders || 0)

  const containerBackground = hasCover
    ? `linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.6) 100%), url(${profile.cover_url}) center/cover no-repeat`
    : `linear-gradient(135deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}E8 100%)`

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box className="page-container" style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], paddingBottom: 100 }}>
        {/* Header - 类似交易员主页的横向布局 */}
        <Box
          className="profile-header"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            marginBottom: tokens.spacing[6],
            padding: tokens.spacing[6],
            background: containerBackground,
            borderRadius: tokens.radius.xl,
            border: `1px solid ${tokens.colors.border.primary}50`,
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
            position: 'relative',
            overflow: 'visible',
            opacity: mounted ? 1 : 0,
            transform: mounted ? 'translateY(0)' : 'translateY(-20px)',
            transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          {/* 装饰背景 */}
          {!hasCover && (
            <Box style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: tokens.radius.xl, pointerEvents: 'none' }}>
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
              <Box
                style={{
                  position: 'absolute',
                  bottom: -80,
                  right: -80,
                  width: 200,
                  height: 200,
                  background: `radial-gradient(circle, ${tokens.colors.accent.brand}06 0%, transparent 70%)`,
                }}
              />
            </Box>
          )}

          {/* 左侧：Avatar + Info */}
          <Box
            className="profile-header-info"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[5],
              flex: 1,
              position: 'relative',
              zIndex: 1,
            }}
          >
            {/* Avatar */}
            <Box
              style={{ position: 'relative', flexShrink: 0 }}
              onMouseEnter={() => setAvatarHovered(true)}
              onMouseLeave={() => setAvatarHovered(false)}
            >
              <Box
                className="profile-header-avatar"
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: tokens.radius.full,
                  background: profile.avatar_url ? tokens.colors.bg.secondary : getAvatarGradient(profile.id),
                  border: `3px solid ${avatarHovered ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                  display: 'grid',
                  placeItems: 'center',
                  overflow: 'hidden',
                  boxShadow: avatarHovered
                    ? `0 8px 32px rgba(139, 111, 168, 0.4), 0 0 0 4px ${tokens.colors.accent.primary}20`
                    : `0 4px 16px rgba(0, 0, 0, 0.15)`,
                  transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                  transform: avatarHovered ? 'scale(1.08)' : 'scale(1)',
                  cursor: 'pointer',
                }}
              >
                {profile.avatar_url ? (
                  <img
                    src={`/api/avatar?url=${encodeURIComponent(profile.avatar_url)}`}
                    alt={profile.handle}
                    loading="lazy"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={(e) => {
                      const img = e.target as HTMLImageElement
                      img.style.display = 'none'
                    }}
                  />
                ) : (
                  <Text size="2xl" weight="black" style={{ color: '#fff', fontSize: 32, textShadow: '0 2px 8px rgba(0,0,0,0.4)' }}>
                    {getAvatarInitial(profile.handle)}
                  </Text>
                )}
              </Box>
              {proBadgeTier === 'pro' && <ProBadgeOverlay position="bottom-right" />}
            </Box>

            {/* Info */}
            <Box style={{ flex: 1, minWidth: 0 }}>
              {/* 用户名 + 已认证标记 */}
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], marginBottom: tokens.spacing[2] }}>
                <Text
                  size="2xl"
                  weight="black"
                  style={{
                    color: hasCover ? '#ffffff' : tokens.colors.text.primary,
                    textShadow: hasCover ? '0 2px 8px rgba(0,0,0,0.5)' : undefined,
                  }}
                >
                  {profile.handle}
                </Text>

                {profile.uid && (
                  <Box
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      padding: `3px ${tokens.spacing[2]}`,
                      background: `${tokens.colors.accent.primary}18`,
                      borderRadius: tokens.radius.full,
                      border: `1px solid ${tokens.colors.accent.primary}40`,
                    }}
                    title="用户编号"
                  >
                    <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.primary, fontFamily: 'monospace' }}>
                      #{profile.uid.toString().padStart(6, '0')}
                    </Text>
                  </Box>
                )}

                {profile.isRegistered && (
                  <Box
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 22,
                      height: 22,
                      background: `linear-gradient(135deg, ${tokens.colors.accent.success}, #00D4AA)`,
                      borderRadius: tokens.radius.full,
                      boxShadow: `0 2px 8px ${tokens.colors.accent.success}40`,
                    }}
                    title={t('verifiedUser')}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </Box>
                )}
              </Box>

              {/* 个人简介 */}
              {profile.bio && (
                <Text
                  size="sm"
                  style={{
                    color: hasCover ? 'rgba(255,255,255,0.85)' : tokens.colors.text.secondary,
                    textShadow: hasCover ? '0 1px 4px rgba(0,0,0,0.3)' : undefined,
                    marginBottom: tokens.spacing[3],
                    maxWidth: 500,
                  }}
                >
                  {profile.bio}
                </Text>
              )}

              {/* Following / Followers - 只显示平台数据 */}
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4], flexWrap: 'wrap' }}>
                <Box
                  onClick={() => isOwnProfile && router.push('/following')}
                  style={{
                    cursor: isOwnProfile ? 'pointer' : 'default',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                    borderRadius: tokens.radius.md,
                  }}
                >
                  <Text size="sm" style={{ color: hasCover ? 'rgba(255,255,255,0.8)' : tokens.colors.text.secondary }}>
                    <Text as="span" weight="bold" style={{ color: hasCover ? '#fff' : tokens.colors.text.primary, marginRight: 4 }}>
                      {followingCount}
                    </Text>
                    {t('following')}
                  </Text>
                </Box>

                <Box
                  onClick={() => {
                    if (profile.isRegistered && (isOwnProfile || profile.showFollowers)) {
                      setModalType('followers')
                    }
                  }}
                  style={{
                    cursor: profile.isRegistered && (isOwnProfile || profile.showFollowers) ? 'pointer' : 'default',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                    borderRadius: tokens.radius.md,
                  }}
                >
                  <Text size="sm" style={{ color: hasCover ? 'rgba(255,255,255,0.8)' : tokens.colors.text.secondary }}>
                    <Text as="span" weight="bold" style={{ color: hasCover ? '#fff' : tokens.colors.text.primary, marginRight: 4 }}>
                      {followersCount}
                    </Text>
                    {t('followers')}
                  </Text>
                </Box>
              </Box>

              {/* 社交链接 */}
              {socialLinks && Object.values(socialLinks).some(v => v) && (
                <Box style={{ display: 'flex', gap: tokens.spacing[2], marginTop: tokens.spacing[3], flexWrap: 'wrap' }}>
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
            </Box>
          </Box>

          {/* 右侧：操作按钮 */}
          <Box
            className="profile-header-actions"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
              flexShrink: 0,
              position: 'relative',
              zIndex: 1,
            }}
          >
            {isOwnProfile ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push('/settings')}
                style={{
                  color: tokens.colors.text.primary,
                  background: `${tokens.colors.accent.primary}15`,
                  border: `1px solid ${tokens.colors.accent.primary}40`,
                  borderRadius: tokens.radius.lg,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
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
        </Box>

        {/* 主要内容区域 - 双栏布局 */}
        <Box
          className="profile-content"
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 320px',
            gap: tokens.spacing[6],
          }}
        >
          {/* 左侧 - 动态 */}
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
            <Box bg="secondary" p={4} radius="lg" border="primary">
              <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[4] }}>
                <Text size="lg" weight="black">{t('posts')}</Text>
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
                    {t('newPost')}
                  </button>
                )}
              </Box>
              <PostFeed authorHandle={profile.handle} variant="compact" showSortButtons />
            </Box>
          </Box>

          {/* 右侧 - 加入的小组 + 收藏夹 */}
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
            <JoinedGroups userId={profile.id} />
            <UserBookmarkFolders userId={profile.id} isOwnProfile={isOwnProfile} />
          </Box>
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

        {/* 响应式样式 */}
        <style>{`
          @media (max-width: 768px) {
            .profile-content {
              grid-template-columns: 1fr !important;
            }
            .profile-header {
              flex-direction: column !important;
              align-items: center !important;
              text-align: center !important;
            }
            .profile-header-info {
              flex-direction: column !important;
              align-items: center !important;
            }
            .profile-header-actions {
              margin-top: ${tokens.spacing[4]} !important;
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
