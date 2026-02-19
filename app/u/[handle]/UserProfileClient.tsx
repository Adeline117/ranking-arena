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
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import TraderHeader from '@/app/components/trader/TraderHeader'
import TraderTabs from '@/app/components/trader/TraderTabs'
// Trader components for stats/portfolio tabs
// JoinedGroups, UserBookmarkFolders removed from profile
import { Box, Text } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { DynamicFollowListModal as FollowListModal } from '@/app/components/ui/Dynamic'
const UserFollowButton = dynamic(() => import('@/app/components/ui/UserFollowButton'), { ssr: false })
const MessageButton = dynamic(() => import('@/app/components/ui/MessageButton'), { ssr: false })
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import ProBadge, { ProBadgeOverlay } from '@/app/components/ui/ProBadge'
import LevelBadge from '@/app/components/user/LevelBadge'
import { logger } from '@/lib/logger'
// FollowersList removed from profile

import OverviewPerformanceCard, { type ExtendedPerformance } from '@/app/components/trader/OverviewPerformanceCard'
const EquityCurveSection = dynamic(() => import('@/app/components/trader/stats/components/EquityCurveSection').then(m => ({ default: m.EquityCurveSection })), { ssr: false })
const TraderFeed = dynamic(() => import('@/app/components/trader/TraderFeed'))
const SimilarTraders = dynamic(() => import('@/app/components/trader/SimilarTraders'))

// UserActivityFeed, ProfileBookshelf, ProfileActivityFeed removed from profile

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
  exp?: number
}

type TraderPageData = Record<string, any>

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
  const [modalType, setModalType] = useState<'followers' | 'following' | null>(null)
  const [followersCount, setFollowersCount] = useState(serverProfile?.followers || 0)
  const [mounted, setMounted] = useState(false)
  const [avatarHovered, setAvatarHovered] = useState(false)
  const profileCreationRef = useRef(false)
  const searchParams = useSearchParams()
  const pathname = usePathname()

  useEffect(() => { setMounted(true) }, [])

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
  const _traderFeed = traderData?.feed ?? []
  const _traderSimilar = traderData?.similarTraders ?? []

  // Tabs: unified profile tabs (includes trading tabs when user is a trader)
  type ProfileTabKey = 'overview' | 'stats' | 'portfolio'
  const urlTab = searchParams.get('tab')
  const [activeProfileTab, setActiveProfileTab] = useState<ProfileTabKey>(
    urlTab && ['overview', 'stats', 'portfolio'].includes(urlTab) ? urlTab as ProfileTabKey : 'overview'
  )

  const updateUrl = useCallback((tab: string) => {
    const params = new URLSearchParams(searchParams.toString())
    if (tab === 'overview') {
      params.delete('tab')
    } else {
      params.set('tab', tab)
    }
    const qs = params.toString()
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
  }, [searchParams, pathname, router])

  const handleProfileTabChange = useCallback((tab: ProfileTabKey) => {
    setActiveProfileTab(tab)
    updateUrl(tab)
  }, [updateUrl])

  // Auth check
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setCurrentUserId(data.user?.id ?? null)

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
    if (profileCreationRef.current) return
    profileCreationRef.current = true

    try {
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
        const { error: insertError } = await supabase
          .from('user_profiles')
          .insert({ id: userId, handle: defaultHandle })

        if (insertError && insertError.code !== '23505') {
          logger.warn('Profile insert failed (non-conflict):', insertError)
        }

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
              width: 80, height: 80, borderRadius: '50%',
              background: tokens.colors.bg.secondary,
              border: `2px solid ${tokens.colors.border.primary}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto', marginBottom: tokens.spacing[4],
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
            {t('backToHome')}
          </Link>
        </Box>
      </Box>
    )
  }

  const isOwnProfile = currentUserId === profile.id

  // ============================================================
  // UNIFIED PROFILE — trading data + social data in one layout
  // ============================================================
  const _canViewFull = isPro || isOwnProfile
  const followingCount = (profile.following || 0) + (profile.followingTraders || 0)

  // Trader tab type (matches TraderPageClient exactly)
  type TraderTabKey = 'overview' | 'stats' | 'portfolio'
  const traderActiveTab = (activeProfileTab === 'overview' || activeProfileTab === 'stats' || activeProfileTab === 'portfolio')
    ? activeProfileTab as TraderTabKey
    : 'overview'

  const profileTabs: Array<{ key: ProfileTabKey; label: string }> = [
    { key: 'overview', label: t('overview') || (isZh ? '概览' : 'Overview') },
    { key: 'stats', label: t('stats') || (isZh ? '统计' : 'Stats') },
    { key: 'portfolio', label: t('portfolio') || (isZh ? '持仓' : 'Portfolio') },
    /* bookshelf/followers/groups/bookmarks tabs removed per Adeline */
  ]

  // ============================================================
  // TRADER MODE: identical to TraderPageClient layout
  // ============================================================
  if (isTrader) {
    return (
      <Box
        className="trader-page-container"
        style={{
          minHeight: '100vh',
          background: `linear-gradient(180deg, ${tokens.colors.bg.primary} 0%, ${tokens.colors.bg.secondary}30 100%)`,
          color: tokens.colors.text.primary,
        }}
      >
        <TopNav email={email} />

        <Box className="page-container" style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], paddingBottom: 100 }}>
          <Breadcrumb items={[
            { label: language === 'zh' ? '排行榜' : 'Leaderboard', href: '/rankings' },
            { label: traderProfile?.handle || profile.handle || handle },
          ]} />

          {/* TraderHeader — identical to trader page */}
          <TraderHeader
            handle={traderProfile?.handle || traderProfile?.trader_key || serverProfile?.traderHandle || ''}
            displayName={traderProfile?.display_name || undefined}
            traderId={traderProfile?.id || profile.id}
            avatarUrl={traderProfile?.avatar_url || profile.avatar_url}
            coverUrl={traderProfile?.cover_url || profile.cover_url}
            isRegistered={traderProfile?.isRegistered ?? profile.isRegistered}
            followers={traderProfile?.followers ?? profile.followers}
            copiers={traderProfile?.copiers}
            source={traderProfile?.source}
            isPro={isPro}
            roi90d={traderPerformance?.roi_90d}
            maxDrawdown={traderPerformance?.max_drawdown}
            winRate={traderPerformance?.win_rate}
            currentUserId={currentUserId}
          />

          {/* TraderTabs — identical to trader page */}
          <TraderTabs
            activeTab={traderActiveTab}
            onTabChange={(tab) => handleProfileTabChange(tab as ProfileTabKey)}
            isPro={isPro}
            onProRequired={() => router.push('/pricing')}
          />

          {/* Tab Content with animation — identical to trader page */}
          <Box
            key={traderActiveTab}
            style={{
              animation: 'fadeInUp 0.4s ease-out forwards',
            }}
          >
            {traderActiveTab === 'overview' && (
              <Box
                className="profile-grid"
                style={{
                  display: 'grid',
                  gridTemplateColumns: _traderSimilar.length > 0 ? '1fr 300px' : '1fr',
                  gap: tokens.spacing[8],
                }}
              >
                <Box className="stagger-enter" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
                  {traderPerformance ? (
                    <Box style={{ position: 'relative' }}>
                      <OverviewPerformanceCard
                        performance={traderPerformance as ExtendedPerformance}
                        equityCurve={traderEquityCurve?.['90D']}
                        source={traderProfile?.source}
                      />
                      {!email && traderEquityCurve?.['90D'] && (
                        <Box style={{
                          position: 'absolute', bottom: 0, left: 0, right: 0, height: '40%',
                          background: 'linear-gradient(to bottom, transparent 0%, var(--color-blur-overlay) 60%, var(--color-lock-bg) 100%)',
                          backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)',
                          borderRadius: `0 0 ${tokens.radius.xl} ${tokens.radius.xl}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5,
                        }}>
                          <Link href={`/login?returnUrl=${encodeURIComponent(`/u/${handle}`)}`} style={{ textDecoration: 'none' }}>
                            <Box style={{
                              padding: `${tokens.spacing[3]} ${tokens.spacing[6]}`,
                              background: `${tokens.colors.accent.primary}20`, border: `1px solid ${tokens.colors.accent.primary}50`,
                              borderRadius: tokens.radius.lg, cursor: 'pointer', textAlign: 'center',
                            }}>
                              <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.primary }}>
                                {language === 'zh' ? '注册查看完整历史数据' : 'Sign up to view full history'}
                              </Text>
                            </Box>
                          </Link>
                        </Box>
                      )}
                    </Box>
                  ) : (
                    <Box style={{
                      padding: tokens.spacing[6],
                      background: tokens.colors.bg.secondary,
                      borderRadius: tokens.radius.xl,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      textAlign: 'center',
                    }}>
                      <Text size="sm" color="tertiary">
                        {t('noPerformanceData')}
                      </Text>
                    </Box>
                  )}
                  {/* Equity Curve Chart */}
                  {traderEquityCurve && (
                    <EquityCurveSection
                      equityCurve={traderEquityCurve}
                      traderHandle={traderProfile?.handle || serverProfile?.traderHandle || ''}
                      delay={0}
                    />
                  )}
                  <TraderFeed
                    items={_traderFeed.filter((f: { type: string }) => f.type !== 'group_post')}
                    title={t('activities')}
                    isRegistered={traderProfile?.isRegistered}
                    traderId={traderProfile?.id || ''}
                    traderHandle={traderProfile?.handle || ''}
                    source={traderProfile?.source}
                  />
                </Box>

                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
                  {_traderSimilar.length > 0 && <SimilarTraders traders={_traderSimilar} />}
                </Box>
              </Box>
            )}

            {(() => {
              const isOwn = !!(currentUserId && profile.id === currentUserId)
              const canView = isPro || isOwn
              return (
                <>
                  {traderActiveTab === 'stats' && (
                    traderStats ? (
                      <StatsPage
                        stats={traderStats}
                        traderHandle={traderProfile?.handle || serverProfile?.traderHandle || ''}
                        assetBreakdown={traderAssetBreakdown}
                        equityCurve={traderEquityCurve}
                        positionHistory={traderPositionHistory}
                        isPro={canView}
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
                          {t('noStatsData')}
                        </Text>
                      </Box>
                    )
                  )}

                  {traderActiveTab === 'portfolio' && <PortfolioTable items={traderPortfolio} history={traderPositionHistory} isPro={canView} onUnlock={() => router.push('/pricing')} />}
                </>
              )
            })()}
          </Box>

          <style>{`
            .profile-tabs::-webkit-scrollbar { display: none; }
            @keyframes fadeInUp {
              from { opacity: 0; transform: translateY(8px); }
              to { opacity: 1; transform: translateY(0); }
            }
            @media (max-width: 768px) {
              .page-container {
                padding: ${tokens.spacing[3]} !important;
              }
              .profile-grid {
                grid-template-columns: 1fr !important;
              }
            }
          `}</style>
        </Box>
      </Box>
    )
  }

  // ============================================================
  // NON-TRADER MODE: original user profile layout
  // ============================================================
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
        <Breadcrumb items={[
          { label: isZh ? '社区' : 'Community', href: '/' },
          { label: `@${profile.handle}` },
        ]} />
        {/* Profile Header with gradient extending to tabs */}
        {(() => {
          const hasCover = Boolean(profile.cover_url)
          const containerBackground = hasCover
            ? `linear-gradient(to bottom, var(--color-overlay-subtle) 0%, var(--color-backdrop) 100%), url(${profile.cover_url}) center/cover no-repeat`
            : `linear-gradient(135deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}E8 100%)`
          const textColor = hasCover ? tokens.colors.white : tokens.colors.text.primary
          const secondaryTextColor = hasCover ? 'var(--glass-bg-medium)' : tokens.colors.text.secondary
          const textShadow = hasCover ? '0 1px 4px var(--color-overlay-dark)' : undefined
          return (
        <Box
          className="profile-header"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            marginBottom: 0,
            padding: tokens.spacing[6],
            paddingBottom: tokens.spacing[3],
            background: containerBackground,
            borderRadius: `${tokens.radius.xl} ${tokens.radius.xl} 0 0`,
            border: `1px solid ${tokens.colors.border.primary}50`,
            borderBottom: 'none',
            boxShadow: '0 8px 32px var(--color-overlay-subtle), inset 0 1px 0 var(--overlay-hover)',
            position: 'relative',
            overflow: 'visible',
            opacity: mounted ? 1 : 0,
            transition: 'opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          {!hasCover && (
          <Box style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: tokens.radius.xl, pointerEvents: 'none' }}>
                <Box style={{ position: 'absolute', top: -100, left: -100, width: 300, height: 300, background: `radial-gradient(circle, ${tokens.colors.accent.primary}08 0%, transparent 70%)` }} />
                <Box style={{ position: 'absolute', bottom: -80, right: -80, width: 200, height: 200, background: `radial-gradient(circle, ${tokens.colors.accent.brand}06 0%, transparent 70%)` }} />
          </Box>
          )}

          {/* Profile Info */}
          <Box className="profile-header-info" style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[5], flex: 1, position: 'relative', zIndex: 1 }}>
            {/* Avatar */}
            <Box
              style={{ position: 'relative', flexShrink: 0 }}
              onMouseEnter={() => setAvatarHovered(true)}
              onMouseLeave={() => setAvatarHovered(false)}
            >
              <Box
                className="profile-header-avatar"
                style={{
                  width: 72, height: 72, borderRadius: tokens.radius.full,
                  background: profile.avatar_url ? tokens.colors.bg.secondary : getAvatarGradient(profile.id),
                  border: `3px solid ${avatarHovered ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                  display: 'grid', placeItems: 'center',
                  overflow: 'hidden',
                  boxShadow: avatarHovered
                    ? `0 8px 32px var(--color-accent-primary-40), 0 0 0 4px ${tokens.colors.accent.primary}20`
                    : '0 4px 16px var(--color-overlay-light)',
                  transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                  transform: avatarHovered ? 'scale(1.08)' : 'scale(1)',
                  cursor: 'pointer',
                }}
              >
                {profile.avatar_url ? (
                  <Image
                    src={`/api/avatar?url=${encodeURIComponent(profile.avatar_url)}`}
                    alt={profile.handle} width={72} height={72}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', transition: 'all 0.4s ease' }}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                ) : (
                  <Text size="2xl" weight="black" style={{ color: tokens.colors.white, textShadow: 'var(--text-shadow-md)', fontSize: '32px', lineHeight: '1' }}>
                    {getAvatarInitial(profile.handle)}
                  </Text>
                )}
              </Box>
              {profile.proBadgeTier === 'pro' && <ProBadgeOverlay position="bottom-right" />}
            </Box>

            {/* Info */}
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], marginBottom: tokens.spacing[2], flexWrap: 'wrap' }}>
                <Text size="2xl" weight="black" className="trader-name-truncate" style={{
                  color: textColor,
                  lineHeight: tokens.typography.lineHeight.tight,
                  textShadow,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%',
                }}>
                  {profile.handle}
                </Text>

                <LevelBadge exp={profile.exp || 0} size="md" />

                {profile.isVerifiedTrader && (
                  <Box
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 22, height: 22,
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

                {profile.proBadgeTier === 'pro' && <ProBadge size="sm" showLabel={true} />}

                {profile.role === 'developer' && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px',
                    background: 'linear-gradient(135deg, var(--color-brand), var(--color-brand-hover))',
                    borderRadius: tokens.radius.full, fontSize: 11, fontWeight: 700,
                    color: 'var(--color-on-accent)', letterSpacing: '0.02em',
                    boxShadow: '0 2px 8px var(--color-accent-primary-40)',
                  }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="16 18 22 12 16 6" />
                      <polyline points="8 6 2 12 8 18" />
                    </svg>
                    {isZh ? '开发者' : 'Developer'}
                  </span>
                )}

                {profile.role === 'admin' && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px',
                    background: 'linear-gradient(135deg, var(--color-medal-gold), var(--color-medal-gold-end))',
                    borderRadius: tokens.radius.full, fontSize: 11, fontWeight: 700,
                    color: tokens.colors.black, letterSpacing: '0.02em',
                    boxShadow: '0 2px 8px var(--color-gold-glow)',
                  }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 1l3.22 6.636 7.28.96-5.25 5.18 1.24 7.224L12 17.77 5.51 21l1.24-7.224L1.5 8.596l7.28-.96z" />
                    </svg>
                    {isZh ? '管理员' : 'Admin'}
                  </span>
                )}
              </Box>

              {profile.bio && (
                <Text size="sm" style={{ color: secondaryTextColor, marginBottom: tokens.spacing[3], maxWidth: 500, textShadow }}>
                  {profile.bio}
                </Text>
              )}

              {/* Stats row */}
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], flexWrap: 'wrap' }}>
                <Box
                  onClick={() => isOwnProfile && router.push('/following')}
                  style={{ cursor: isOwnProfile ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 4, padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`, borderRadius: tokens.radius.md }}
                >
                  <Text size="sm" style={{ color: secondaryTextColor, textShadow }}>
                    <Text as="span" weight="bold" style={{ color: textColor, marginRight: 4, textShadow }}>{followingCount}</Text>
                    {t('following')}
                  </Text>
                </Box>

                <Box
                  onClick={() => {
                    if (profile.isRegistered && (isOwnProfile || profile.show_followers !== false)) {
                      setModalType('followers')
                    }
                  }}
                  style={{ cursor: profile.isRegistered && (isOwnProfile || profile.show_followers !== false) ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 4, padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`, borderRadius: tokens.radius.md }}
                >
                  <Text size="sm" style={{ color: secondaryTextColor, textShadow }}>
                    <Text as="span" weight="bold" style={{ color: textColor, marginRight: 4, textShadow }}>{followersCount}</Text>
                    {t('followers')}
                  </Text>
                </Box>
              </Box>
            </Box>
          </Box>

          {/* Action buttons */}
          <Box className="profile-header-actions action-buttons" style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap', position: 'relative', zIndex: 1 }}>
            <button
              onClick={() => router.push('/')}
              style={{
                color: tokens.colors.text.tertiary, fontSize: tokens.typography.fontSize.sm,
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`, borderRadius: tokens.radius.lg,
                background: tokens.colors.bg.tertiary, border: `1px solid ${tokens.colors.border.primary}`,
                cursor: 'pointer', fontWeight: tokens.typography.fontWeight.medium,
                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
              }}
            >
              ← {t('back')}
            </button>

            {isOwnProfile && (
              <button
                onClick={() => router.push('/settings')}
                style={{
                  color: tokens.colors.text.primary, fontSize: tokens.typography.fontSize.sm,
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`, borderRadius: tokens.radius.lg,
                  background: `${tokens.colors.accent.primary}15`, border: `1px solid ${tokens.colors.accent.primary}40`,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: tokens.spacing[2],
                  fontWeight: tokens.typography.fontWeight.medium,
                  transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
                {t('editProfile')}
              </button>
            )}

            {!isOwnProfile && profile.isRegistered && currentUserId && (
              <>
                <UserFollowButton
                  targetUserId={profile.id}
                  currentUserId={currentUserId}
                  size="sm"
                  onFollowChange={(isFollowing) => {
                    setFollowersCount(prev => isFollowing ? prev + 1 : prev - 1)
                  }}
                />
                <MessageButton targetUserId={profile.id} currentUserId={currentUserId} size="sm" />
              </>
            )}

            {!isOwnProfile && profile.isRegistered && !currentUserId && mounted && (
              <Link
                href={`/login?returnUrl=${encodeURIComponent(`/u/${handle}`)}`}
                style={{
                  color: tokens.colors.accent.primary, fontSize: tokens.typography.fontSize.sm,
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`, borderRadius: tokens.radius.lg,
                  background: `${tokens.colors.accent.primary}15`, border: `1px solid ${tokens.colors.accent.primary}40`,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: tokens.spacing[2],
                  fontWeight: tokens.typography.fontWeight.medium,
                  textDecoration: 'none',
                  transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                }}
              >
                {isZh ? 'Login to Follow' : 'Login to Follow'}
              </Link>
            )}
          </Box>
        </Box>
          )
        })()}

        {/* Tabs - continues header background */}
        <Box
          className="profile-tabs"
          role="tablist"
          style={{
            display: 'flex',
            gap: tokens.spacing[2],
            marginBottom: tokens.spacing[4],
            position: 'relative',
            padding: `${tokens.spacing[2]} ${tokens.spacing[6]}`,
            paddingBottom: tokens.spacing[3],
            overflowX: 'auto',
            WebkitOverflowScrolling: 'touch',
            scrollbarWidth: 'none',
            background: `linear-gradient(to bottom, ${tokens.colors.bg.secondary}40 0%, transparent 100%)`,
            borderRadius: `0 0 ${tokens.radius.xl} ${tokens.radius.xl}`,
            border: `1px solid ${tokens.colors.border.primary}50`,
            borderTop: 'none',
          }}
        >
          {profileTabs.map((tab) => {
            const isActive = activeProfileTab === tab.key
            return (
              <button
                key={tab.key}
                className="profile-tab-button interactive-scale"
                onClick={() => handleProfileTabChange(tab.key)}
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                style={{
                  background: isActive
                    ? `linear-gradient(135deg, ${tokens.colors.accent.primary}15, ${tokens.colors.accent.primary}08)`
                    : 'transparent',
                  border: isActive
                    ? `1px solid ${tokens.colors.accent.primary}30`
                    : '1px solid transparent',
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  minHeight: 44,
                  cursor: 'pointer',
                  position: 'relative',
                  borderRadius: tokens.radius.lg,
                  transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[2],
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = `${tokens.colors.bg.tertiary}80`
                    e.currentTarget.style.transform = 'translateY(-2px)'
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = 'transparent'
                    e.currentTarget.style.transform = 'translateY(0)'
                  }
                }}
              >
                <Text
                  size="sm"
                  weight={isActive ? 'black' : 'medium'}
                  style={{
                    color: isActive ? tokens.colors.text.primary : tokens.colors.text.secondary,
                    transition: 'color 0.3s ease',
                  }}
                >
                  {tab.label}
                </Text>
              </button>
            )
          })}
        </Box>

        {/* Tab Content */}
        <Box key={activeProfileTab} style={{ animation: 'fadeInUp 0.4s ease-out forwards' }}>
          {activeProfileTab === 'overview' && (
            <Box
              className="profile-content profile-grid"
              style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: tokens.spacing[8] }}
            >
              {/* Main column */}
              <Box className="stagger-enter" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
                {/* Guidance cards removed */}

                {/* Posts */}
                <Box bg="secondary" p={4} radius="lg" border="primary">
                  <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[4] }}>
                    <Text size="lg" weight="black">{t('posts')}</Text>
                    {isOwnProfile && (
                      <button
                        onClick={() => router.push(`/u/${handle}/new`)}
                        style={{
                          padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                          borderRadius: tokens.radius.md, border: 'none',
                          background: tokens.colors.accent.brand, color: tokens.colors.white,
                          fontSize: tokens.typography.fontSize.sm, fontWeight: tokens.typography.fontWeight.black,
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

              {/* Sidebar column removed per Adeline */}
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }} />
            </Box>
          )}

          {/* activity tab removed */}

          {activeProfileTab === 'stats' && (
            <Box style={{ maxWidth: 900 }}>
              {traderStats ? (
                <StatsPage
                  stats={traderStats}
                  traderHandle={traderProfile?.handle || profile.handle || ''}
                  assetBreakdown={traderAssetBreakdown}
                  equityCurve={traderEquityCurve}
                  positionHistory={traderPositionHistory}
                  isPro={true}
                  onUnlock={() => router.push('/pricing')}
                />
              ) : (
                <Box style={{ padding: tokens.spacing[6], background: tokens.colors.bg.secondary, borderRadius: tokens.radius.xl, border: `1px solid ${tokens.colors.border.primary}`, textAlign: 'center' }}>
                  <Text size="sm" color="tertiary">{isZh ? '暂无统计数据，绑定交易所后可查看' : 'No stats data yet. Link an exchange to view.'}</Text>
                </Box>
              )}
            </Box>
          )}

          {activeProfileTab === 'portfolio' && (
            <Box style={{ maxWidth: 900 }}>
              <PortfolioTable items={traderPortfolio} history={traderPositionHistory} isPro={true} onUnlock={() => router.push('/pricing')} />
            </Box>
          )}

          {/* bookshelf/followers/groups/bookmarks tabs removed */}
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
          .profile-tabs::-webkit-scrollbar { display: none; }
          @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @media (max-width: 768px) {
            .page-container {
              padding: ${tokens.spacing[3]} !important;
            }
            .profile-content, .profile-grid {
              grid-template-columns: 1fr !important;
            }
            .profile-header {
              flex-direction: column !important;
              align-items: center !important;
              text-align: center !important;
              padding: ${tokens.spacing[4]} !important;
              min-height: auto !important;
            }
            .profile-header-info {
              flex-direction: column !important;
              align-items: center !important;
            }
            .profile-header-avatar {
              width: 56px !important;
              height: 56px !important;
            }
            .profile-header-actions {
              margin-top: ${tokens.spacing[3]} !important;
              width: 100%;
              justify-content: center !important;
            }
            .profile-tabs {
              margin-left: -${tokens.spacing[3]} !important;
              margin-right: -${tokens.spacing[3]} !important;
              padding: 0 ${tokens.spacing[3]} !important;
            }
          }
        `}</style>
      </Box>
    </Box>
  )
}

// FollowersList extracted to ./components/FollowersList.tsx
