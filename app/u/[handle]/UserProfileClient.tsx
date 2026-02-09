'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import useSWR from 'swr'
import { fetcher } from '@/lib/hooks/useSWR'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/layout/TopNav'
const JoinedGroups = dynamic(() => import('@/app/components/trader/JoinedGroups'), { ssr: false })
const UserBookmarkFolders = dynamic(() => import('@/app/components/trader/UserBookmarkFolders'), { ssr: false })
import { Box, Text } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { DynamicFollowListModal as FollowListModal } from '@/app/components/ui/Dynamic'
// Lazy-load interaction components (only needed when viewing other users' profiles)
const UserFollowButton = dynamic(() => import('@/app/components/ui/UserFollowButton'), { ssr: false })
const MessageButton = dynamic(() => import('@/app/components/ui/MessageButton'), { ssr: false })
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import ProBadge, { ProBadgeOverlay } from '@/app/components/ui/ProBadge'
import { logger } from '@/lib/logger'

const ActivityHeatmap = dynamic(() => import('@/app/components/profile/ActivityHeatmap'), { ssr: false })
const UserStreaks = dynamic(() => import('@/app/components/profile/UserStreaks'), { ssr: false })

// Trader components (lazy-loaded, only for users with bound exchange)
const OverviewPerformanceCard = dynamic(() => import('@/app/components/trader/OverviewPerformanceCard'), {
  loading: () => <RankingSkeleton />,
})
const StatsPage = dynamic(() => import('@/app/components/trader/stats/StatsPage'), {
  loading: () => <RankingSkeleton />,
})
const PortfolioTable = dynamic(() => import('@/app/components/trader/PortfolioTable'), {
  loading: () => <RankingSkeleton />,
})

const PostFeed = dynamic(() => import('@/app/components/post/PostFeed'), {
  ssr: false,
  loading: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {[1, 2, 3].map(i => (
        <div key={i} className="skeleton" style={{ height: 120, borderRadius: tokens.radius.lg }} />
      ))}
    </div>
  ),
})

function FollowersList({ profileId }: { profileId: string }) {
  const { t } = useLanguage()
  const [followers, setFollowers] = useState<Array<{ id: string; handle: string; avatar_url: string | null }>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const { data: follows } = await supabase
          .from('user_follows')
          .select('follower_id')
          .eq('following_id', profileId)
          .limit(100)
        if (follows && follows.length > 0) {
          const ids = follows.map((f: { follower_id: string }) => f.follower_id)
          const { data: profiles } = await supabase
            .from('user_profiles')
            .select('id, handle, avatar_url')
            .in('id', ids)
          setFollowers((profiles || []) as Array<{ id: string; handle: string; avatar_url: string | null }>)
        } else {
          setFollowers([])
        }
      } catch {
        setFollowers([])
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [profileId])

  if (loading) {
    return (
      <Box style={{ padding: tokens.spacing[6], textAlign: 'center' }}>
        <Text size="sm" color="tertiary">{t('loading') || '加载中...'}</Text>
      </Box>
    )
  }

  if (followers.length === 0) {
    return (
      <Box bg="secondary" p={6} radius="lg" border="primary" style={{ textAlign: 'center' }}>
        <Text size="sm" color="tertiary">{t('noFollowers') || '暂无粉丝'}</Text>
      </Box>
    )
  }

  return (
    <Box bg="secondary" p={4} radius="lg" border="primary">
      <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
        {t('followers') || '粉丝'} ({followers.length})
      </Text>
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
        {followers.map(f => (
          <Link key={f.id} href={`/u/${encodeURIComponent(f.handle)}`} style={{ textDecoration: 'none' }}>
            <Box style={{
              display: 'flex', alignItems: 'center', gap: tokens.spacing[3],
              padding: tokens.spacing[3], borderRadius: tokens.radius.md,
              transition: 'background 0.15s',
            }}
              onMouseEnter={e => { e.currentTarget.style.background = tokens.colors.bg.tertiary }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <Box style={{
                width: 40, height: 40, borderRadius: tokens.radius.full,
                background: f.avatar_url ? tokens.colors.bg.tertiary : getAvatarGradient(f.id),
                overflow: 'hidden', display: 'grid', placeItems: 'center',
                flexShrink: 0,
              }}>
                {f.avatar_url ? (
                  <Image src={`/api/avatar?url=${encodeURIComponent(f.avatar_url)}`} alt={f.handle} width={40} height={40} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <Text size="sm" weight="bold" style={{ color: tokens.colors.white }}>{getAvatarInitial(f.handle)}</Text>
                )}
              </Box>
              <Text size="sm" weight="semibold" style={{ color: tokens.colors.text.primary }}>
                @{f.handle}
              </Text>
            </Box>
          </Link>
        ))}
      </Box>
    </Box>
  )
}

interface ServerProfile {
  id: string
  handle: string
  bio?: string
  avatar_url?: string
  cover_url?: string
  show_followers?: boolean
  show_following?: boolean
  followers: number
  following: number
  followingTraders: number
  isRegistered: boolean
  isVerifiedTrader?: boolean
  proBadgeTier: 'pro' | null
  role?: string
  traderHandle?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TraderPageData = any

interface UserProfileClientProps {
  handle: string
  serverProfile: ServerProfile | null
  serverTraderData?: TraderPageData | null
}

export default function UserProfileClient({ handle, serverProfile, serverTraderData }: UserProfileClientProps) {
  const router = useRouter()
  const { showToast } = useToast()
  const { t, language } = useLanguage()
  const isZh = language === 'zh'
  const { isPro } = useSubscription()

  const [email, setEmail] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [profile, setProfile] = useState<ServerProfile | null>(serverProfile)
  const [avatarHovered, setAvatarHovered] = useState(false)
  const [modalType, setModalType] = useState<'followers' | 'following' | null>(null)
  const [followersCount, setFollowersCount] = useState(serverProfile?.followers || 0)
  const profileCreationRef = useRef(false) // Prevent race condition in profile creation
  const searchParams = useSearchParams()
  const pathname = usePathname()

  // Trader data - SWR with server fallback
  const isTrader = !!serverProfile?.traderHandle
  const { data: traderData } = useSWR<TraderPageData>(
    isTrader ? `/api/traders/${encodeURIComponent(serverProfile!.traderHandle!)}` : null,
    fetcher,
    {
      revalidateOnFocus: false,
      refreshInterval: 60_000,
      dedupingInterval: 5000,
      errorRetryCount: 2,
      fallbackData: serverTraderData ?? undefined,
    }
  )

  const traderProfile = traderData?.profile ?? null
  const traderPerformance = traderData?.performance ?? null
  const traderStats = traderData?.stats ?? null
  const traderPortfolio = traderData?.portfolio ?? []
  const traderPositionHistory = traderData?.positionHistory ?? []
  const traderEquityCurve = traderData?.equityCurve
  const traderAssetBreakdown = traderData?.assetBreakdown

  type ProfileTabKey = 'overview' | 'stats' | 'portfolio' | 'followers' | 'groups' | 'bookmarks'
  const validTabs: ProfileTabKey[] = isTrader
    ? ['overview', 'stats', 'portfolio', 'followers', 'groups', 'bookmarks']
    : ['overview', 'followers', 'groups', 'bookmarks']
  const urlTab = searchParams.get('tab') as ProfileTabKey | null
  const [activeTab, setActiveTab] = useState<ProfileTabKey>(
    urlTab && validTabs.includes(urlTab) ? urlTab : 'overview'
  )
  const [_followersList, _setFollowersList] = useState<Array<{ id: string; handle: string; avatar_url: string | null }>>([])
  const [_loadingFollowers, _setLoadingFollowers] = useState(false)
  const handleTabChange = useCallback((tab: ProfileTabKey) => {
    setActiveTab(tab)
    const params = new URLSearchParams(searchParams.toString())
    if (tab === 'overview') {
      params.delete('tab')
    } else {
      params.set('tab', tab)
    }
    const qs = params.toString()
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
  }, [searchParams, pathname, router])

  // Auth check - lightweight, runs once
  useEffect(() => {
    // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setCurrentUserId(data.user?.id ?? null)

      // If server didn't find profile, check if this is the current user's own profile
      if (!serverProfile && data.user) {
        const emailHandle = data.user.email?.split('@')[0]
        const isOwnProfile = handle === data.user.id || handle === emailHandle
        if (isOwnProfile) {
          handleOwnProfileCreation(data.user.id, emailHandle)
        }
      }
    }).catch((err) => {
      logger.error('[UserProfile] Auth check failed:', err)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleOwnProfileCreation(userId: string, emailHandle?: string) {
    // Prevent race condition - only one profile creation at a time
    if (profileCreationRef.current) return
    profileCreationRef.current = true

    try {
      // Check if profile exists by user ID
      const { data: existingProfile } = await supabase
        .from('user_profiles')
        .select('id, handle, bio, avatar_url, cover_url, show_followers, show_following, subscription_tier, role')
        .eq('id', userId)
        .maybeSingle()

      if (existingProfile) {
        if (existingProfile.handle && existingProfile.handle !== handle) {
          router.replace(`/u/${encodeURIComponent(existingProfile.handle)}`)
          return
        }
        setProfile({
          id: existingProfile.id,
          handle: existingProfile.handle || handle,
          bio: existingProfile.bio || undefined,
          avatar_url: existingProfile.avatar_url || undefined,
          cover_url: existingProfile.cover_url || undefined,
          followers: 0,
          following: 0,
          followingTraders: 0,
          isRegistered: true,
          proBadgeTier: null,
          role: existingProfile.role || undefined,
        })
      } else {
        const defaultHandle = emailHandle || userId.slice(0, 8)
        // Try insert first; ignore conflict (row may exist from handle_new_user trigger)
        const { error: insertError } = await supabase
          .from('user_profiles')
          .insert({ id: userId, handle: defaultHandle })
        
        if (insertError && insertError.code !== '23505') {
          logger.warn('Profile insert failed (non-conflict):', insertError)
        }
          
        // Always fetch the current profile state
        const { data: newProfile, error: createError } = await supabase
          .from('user_profiles')
          .select('id, handle, bio, avatar_url, cover_url')
          .eq('id', userId)
          .maybeSingle()

        if (newProfile && !createError) {
          if (newProfile.handle && newProfile.handle !== handle) {
            router.replace(`/u/${encodeURIComponent(newProfile.handle)}`)
            return
          }
          setProfile({
            id: newProfile.id,
            handle: newProfile.handle || handle,
            bio: newProfile.bio || undefined,
            avatar_url: newProfile.avatar_url || undefined,
            cover_url: newProfile.cover_url || undefined,
            followers: 0,
            following: 0,
            followingTraders: 0,
            isRegistered: true,
            proBadgeTier: null,
          })
        }
      }
    } catch (error) {
      logger.error('Error creating own profile:', error)
      showToast(t('loadUserDataFailed'), 'error')
    }
  }

  // Not found state
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
              color: tokens.colors.accent.brand,
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
  const followingCount = (profile.following || 0) + (profile.followingTraders || 0)

  const profileTabs: Array<{ key: ProfileTabKey; label: string }> = [
    { key: 'overview', label: t('overview') || '概览' },
    ...(isTrader ? [
      { key: 'stats' as ProfileTabKey, label: t('stats') || '统计' },
      { key: 'portfolio' as ProfileTabKey, label: t('portfolio') || '持仓' },
    ] : []),
    { key: 'followers', label: `${t('followers') || '粉丝'} (${followersCount})` },
    { key: 'groups', label: t('groups') || '群组' },
    { key: 'bookmarks', label: t('bookmarks') || '收藏' },
  ]

  return (
    <Box
      className="user-profile-page"
      style={{
        minHeight: '100vh',
        background: `linear-gradient(180deg, ${tokens.colors.bg.primary} 0%, ${tokens.colors.bg.secondary}30 100%)`,
        color: tokens.colors.text.primary,
      }}
    >
      <TopNav email={email} />

      <Box className="page-container" style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], paddingBottom: 100 }}>
        {/* Profile Header - matching trader page style */}
        <Box
          className="profile-header"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            marginBottom: tokens.spacing[6],
            padding: tokens.spacing[6],
            background: `linear-gradient(135deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}E8 100%)`,
            borderRadius: tokens.radius.xl,
            border: `1px solid ${tokens.colors.border.primary}50`,
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
            position: 'relative',
            overflow: 'visible',
            minHeight: 200, // Prevent CLS while cover image loads
          }}
        >
          {/* Background: cover image or decorative gradient */}
          <Box style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: tokens.radius.xl, pointerEvents: 'none' }}>
            {profile.cover_url ? (
              <>
                <Image
                  src={profile.cover_url}
                  alt=""
                  fill
                  priority
                  sizes="(max-width: 768px) 100vw, 800px"
                  style={{ objectFit: 'cover' }}
                />
                {/* Dark overlay for text readability */}
                <Box style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'linear-gradient(135deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.3) 100%)',
                }} />
              </>
            ) : (
              <>
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
              </>
            )}
          </Box>

          {/* Profile Info */}
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
            {/* Avatar with Pro Badge wrapper */}
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
                  fontWeight: tokens.typography.fontWeight.black,
                  fontSize: tokens.typography.fontSize.xl,
                  color: tokens.colors.white,
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
                  <Image
                    src={`/api/avatar?url=${encodeURIComponent(profile.avatar_url)}`}
                    alt={profile.handle}
                    width={72}
                    height={72}
                    priority
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={(e) => {
                      const img = e.target as HTMLImageElement
                      img.style.display = 'none'
                    }}
                  />
                ) : (
                  <Text
                    size="2xl"
                    weight="black"
                    style={{
                      color: tokens.colors.white,
                      textShadow: '0 2px 8px rgba(0, 0, 0, 0.4)',
                      fontSize: '32px',
                      lineHeight: '1',
                    }}
                  >
                    {getAvatarInitial(profile.handle)}
                  </Text>
                )}
              </Box>
              {profile.proBadgeTier === 'pro' && <ProBadgeOverlay position="bottom-right" />}
            </Box>

            {/* Info */}
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], marginBottom: tokens.spacing[2] }}>
                <Text
                  size="2xl"
                  weight="black"
                  style={{
                    color: tokens.colors.text.primary,
                    lineHeight: tokens.typography.lineHeight.tight,
                  }}
                >
                  {profile.handle}
                </Text>

                {/* Arena Score badge for traders */}
                {isTrader && traderPerformance?.arena_score != null && (
                  <Box
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '2px 8px',
                      background: `linear-gradient(135deg, ${tokens.colors.accent.primary}25, ${tokens.colors.accent.brand}15)`,
                      border: `1px solid ${tokens.colors.accent.primary}30`,
                      borderRadius: tokens.radius.full,
                    }}
                    title="Arena Score"
                  >
                    <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.primary, fontSize: 11 }}>
                      Arena {Math.round(traderPerformance.arena_score)}
                    </Text>
                  </Box>
                )}

                {profile.isVerifiedTrader && (
                  <Box
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 22,
                      height: 22,
                      background: `linear-gradient(135deg, ${tokens.colors.accent.success}, var(--color-accent-success))`,
                      borderRadius: tokens.radius.full,
                      boxShadow: `0 2px 8px ${tokens.colors.accent.success}40`,
                    }}
                    title={t('verifiedTrader') || t('verifiedUser')}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </Box>
                )}

                {profile.proBadgeTier === 'pro' && (
                  <ProBadge size="sm" showLabel={true} />
                )}

                {/* Developer Badge */}
                {profile.role === 'developer' && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '2px 8px',
                      background: 'linear-gradient(135deg, var(--color-brand), var(--color-brand-hover))',
                      borderRadius: tokens.radius.full,
                      fontSize: 11,
                      fontWeight: 700,
                      color: 'var(--color-on-accent)',
                      letterSpacing: '0.02em',
                      boxShadow: '0 2px 8px rgba(139, 111, 168, 0.4)',
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="16 18 22 12 16 6" />
                      <polyline points="8 6 2 12 8 18" />
                    </svg>
                    {isZh ? '开发者' : 'Developer'}
                  </span>
                )}

                {/* Admin Badge */}
                {profile.role === 'admin' && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '2px 8px',
                      background: 'linear-gradient(135deg, var(--color-medal-gold), var(--color-medal-gold-end))',
                      borderRadius: tokens.radius.full,
                      fontSize: 11,
                      fontWeight: 700,
                      color: tokens.colors.black,
                      letterSpacing: '0.02em',
                      boxShadow: '0 2px 8px rgba(255, 215, 0, 0.4)',
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 1l3.22 6.636 7.28.96-5.25 5.18 1.24 7.224L12 17.77 5.51 21l1.24-7.224L1.5 8.596l7.28-.96z" />
                    </svg>
                    {isZh ? '管理员' : 'Admin'}
                  </span>
                )}
              </Box>

              {/* Bio */}
              {profile.bio && (
                <Text
                  size="sm"
                  style={{
                    color: tokens.colors.text.secondary,
                    marginBottom: tokens.spacing[3],
                    maxWidth: 500,
                  }}
                >
                  {profile.bio}
                </Text>
              )}

              {/* Stats row */}
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], flexWrap: 'wrap' }}>
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
                  <Text size="sm" style={{ color: tokens.colors.text.secondary }}>
                    <Text as="span" weight="bold" style={{ color: tokens.colors.text.primary, marginRight: 4 }}>
                      {followingCount}
                    </Text>
                    {t('following')}
                  </Text>
                </Box>

                <Box
                  onClick={() => {
                    if (profile.isRegistered && (isOwnProfile || profile.show_followers !== false)) {
                      setModalType('followers')
                    }
                  }}
                  style={{
                    cursor: profile.isRegistered && (isOwnProfile || profile.show_followers !== false) ? 'pointer' : 'default',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                    borderRadius: tokens.radius.md,
                  }}
                >
                  <Text size="sm" style={{ color: tokens.colors.text.secondary }}>
                    <Text as="span" weight="bold" style={{ color: tokens.colors.text.primary, marginRight: 4 }}>
                      {followersCount}
                    </Text>
                    {t('followers')}
                  </Text>
                </Box>
              </Box>
            </Box>
          </Box>

          {/* Action buttons */}
          <Box
            className="profile-header-actions action-buttons"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
              flexShrink: 0,
              flexWrap: 'wrap',
              position: 'relative',
              zIndex: 1,
            }}
          >
            {isOwnProfile ? (
              <button
                onClick={() => router.push('/settings')}
                style={{
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.lg,
                  background: `${tokens.colors.accent.primary}15`,
                  border: `1px solid ${tokens.colors.accent.primary}40`,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[2],
                  fontWeight: tokens.typography.fontWeight.medium,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
                {t('editProfile')}
              </button>
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

            <button
              onClick={() => router.push('/')}
              style={{
                color: tokens.colors.text.tertiary,
                fontSize: tokens.typography.fontSize.sm,
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.lg,
                background: tokens.colors.bg.tertiary,
                border: `1px solid ${tokens.colors.border.primary}`,
                cursor: 'pointer',
                fontWeight: tokens.typography.fontWeight.medium,
              }}
            >
              {t('back')}
            </button>
          </Box>
        </Box>

        {/* Tabs - matching trader page style */}
        <Box
          className="profile-tabs"
          role="tablist"
          style={{
            display: 'flex',
            gap: tokens.spacing[2],
            marginBottom: tokens.spacing[4],
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            paddingBottom: tokens.spacing[3],
            overflowX: 'auto',
            WebkitOverflowScrolling: 'touch',
            scrollbarWidth: 'none',
          }}
        >
          {profileTabs.map((tab) => (
            <button
              key={tab.key}
              className="profile-tab-button interactive-scale"
              onClick={() => handleTabChange(tab.key)}
              role="tab"
              aria-selected={activeTab === tab.key}
              tabIndex={activeTab === tab.key ? 0 : -1}
              style={{
                background: activeTab === tab.key
                  ? `linear-gradient(135deg, ${tokens.colors.accent.primary}15, ${tokens.colors.accent.primary}08)`
                  : 'transparent',
                border: activeTab === tab.key
                  ? `1px solid ${tokens.colors.accent.primary}30`
                  : '1px solid transparent',
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                minHeight: 44,
                cursor: 'pointer',
                borderRadius: tokens.radius.lg,
                transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
              }}
              onMouseEnter={(e) => {
                if (activeTab !== tab.key) {
                  e.currentTarget.style.background = `${tokens.colors.bg.tertiary}80`
                }
              }}
              onMouseLeave={(e) => {
                if (activeTab !== tab.key) {
                  e.currentTarget.style.background = 'transparent'
                }
              }}
            >
              <Text
                size="sm"
                weight={activeTab === tab.key ? 'black' : 'medium'}
                style={{
                  color: activeTab === tab.key ? tokens.colors.text.primary : tokens.colors.text.secondary,
                  transition: 'color 0.3s ease',
                }}
              >
                {tab.label}
              </Text>
            </button>
          ))}
        </Box>

        {/* Tab Content with animation */}
        <Box
          key={activeTab}
          style={{ animation: 'fadeInUp 0.4s ease-out forwards' }}
        >
          {/* Trading overview card for traders */}
          {activeTab === 'overview' && isTrader && traderPerformance && (
            <Box style={{ marginBottom: tokens.spacing[6] }}>
              <OverviewPerformanceCard
                performance={traderPerformance}
                equityCurve={traderEquityCurve?.['90D']}
                source={traderProfile?.source}
              />
            </Box>
          )}

          {/* Stats tab (traders only) */}
          {activeTab === 'stats' && isTrader && (
            traderStats ? (
              <StatsPage
                stats={traderStats}
                traderHandle={serverProfile?.traderHandle || ''}
                assetBreakdown={traderAssetBreakdown}
                equityCurve={traderEquityCurve}
                positionHistory={traderPositionHistory}
                isPro={isPro || (currentUserId === profile.id)}
                onUnlock={() => router.push('/pricing')}
              />
            ) : (
              <Box style={{
                padding: tokens.spacing[6],
                background: tokens.colors.bg.secondary,
                borderRadius: tokens.radius.xl,
                border: `1px solid ${tokens.colors.border.primary}`,
                textAlign: 'center',
              }}>
                <Text size="sm" color="tertiary">
                  {t('noStatsData') || '暂无统计数据'}
                </Text>
              </Box>
            )
          )}

          {/* Portfolio tab (traders only) */}
          {activeTab === 'portfolio' && isTrader && (
            <PortfolioTable
              items={traderPortfolio}
              history={traderPositionHistory}
              isPro={isPro || (currentUserId === profile.id)}
              onUnlock={() => router.push('/pricing')}
            />
          )}

          {activeTab === 'overview' && (
            <Box
              className="profile-content"
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 320px',
                gap: tokens.spacing[6],
              }}
            >
              {/* Posts */}
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
                {/* UF33: Guidance cards for own empty profile */}
                {isOwnProfile && (
                  <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                    {[
                      {
                        icon: null,
                        iconSvg: <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="2" y="10" width="4" height="8" rx="1" fill="var(--color-accent-primary)"/><rect x="8" y="6" width="4" height="12" rx="1" fill="var(--color-accent-primary)" opacity="0.7"/><rect x="14" y="2" width="4" height="16" rx="1" fill="var(--color-accent-primary)" opacity="0.4"/></svg>,
                        text: t('guidanceBindExchange'),
                        action: () => router.push('/exchange/auth/api-key'),
                        actionLabel: t('guidanceGo'),
                      },
                      {
                        icon: null,
                        iconSvg: <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 14l4-4 3 3 7-7" stroke="var(--color-accent-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M14 3h3v3" stroke="var(--color-accent-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
                        text: t('guidanceFirstPost'),
                        action: () => router.push(`/u/${handle}/new`),
                        actionLabel: t('newPost'),
                      },
                      {
                        icon: null,
                        iconSvg: <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="var(--color-accent-primary)" strokeWidth="2"/><circle cx="10" cy="10" r="3" fill="var(--color-accent-primary)"/></svg>,
                        text: t('guidanceFollowTraders'),
                        action: () => router.push('/rankings'),
                        actionLabel: t('guidanceBrowse'),
                      },
                    ].map((card, i) => (
                      <Box key={i} style={{
                        display: 'flex', alignItems: 'center', gap: tokens.spacing[3],
                        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                        borderRadius: tokens.radius.lg,
                        background: `${tokens.colors.accent.primary}08`,
                        border: `1px solid ${tokens.colors.accent.primary}20`,
                      }}>
                        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32 }}>{card.iconSvg || card.icon}</span>
                        <Text size="sm" style={{ flex: 1, color: tokens.colors.text.secondary }}>{card.text}</Text>
                        <button onClick={card.action} style={{
                          padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                          borderRadius: tokens.radius.md,
                          border: `1px solid ${tokens.colors.accent.primary}40`,
                          background: `${tokens.colors.accent.primary}10`,
                          color: tokens.colors.accent.primary,
                          fontSize: tokens.typography.fontSize.xs,
                          fontWeight: 600, cursor: 'pointer',
                        }}>
                          {card.actionLabel}
                        </button>
                      </Box>
                    ))}
                  </Box>
                )}
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
                          color: tokens.colors.white,
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

              {/* Sidebar - joined groups + bookmarks summary */}
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
                <Box bg="secondary" p={4} radius="lg" border="primary">
                  <UserStreaks userId={profile.id} />
                </Box>
                <Box bg="secondary" p={4} radius="lg" border="primary">
                  <ActivityHeatmap userId={profile.id} />
                </Box>
                <JoinedGroups userId={profile.id} />
                <UserBookmarkFolders userId={profile.id} isOwnProfile={isOwnProfile} />
              </Box>
            </Box>
          )}

          {activeTab === 'followers' && (
            <Box style={{ maxWidth: 600 }}>
              <FollowersList profileId={profile.id} />
            </Box>
          )}

          {activeTab === 'groups' && (
            <Box style={{ maxWidth: 800 }}>
              <JoinedGroups userId={profile.id} expanded />
            </Box>
          )}

          {activeTab === 'bookmarks' && (
            <Box style={{ maxWidth: 800 }}>
              <UserBookmarkFolders userId={profile.id} isOwnProfile={isOwnProfile} expanded />
            </Box>
          )}
        </Box>

        {/* Followers modal */}
        {profile.isRegistered && (
          <FollowListModal
            isOpen={modalType === 'followers'}
            onClose={() => setModalType(null)}
            type="followers"
            handle={profile.handle}
            currentUserId={currentUserId}
            isOwnProfile={isOwnProfile}
            isPublic={profile.show_followers !== false}
          />
        )}

        {/* Responsive styles */}
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
