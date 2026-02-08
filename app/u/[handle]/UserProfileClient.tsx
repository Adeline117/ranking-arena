'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
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
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { DynamicFollowListModal as FollowListModal } from '@/app/components/ui/Dynamic'
// Lazy-load interaction components (only needed when viewing other users' profiles)
const UserFollowButton = dynamic(() => import('@/app/components/ui/UserFollowButton'), { ssr: false })
const MessageButton = dynamic(() => import('@/app/components/ui/MessageButton'), { ssr: false })
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import ProBadge, { ProBadgeOverlay } from '@/app/components/ui/ProBadge'

const PostFeed = dynamic(() => import('@/app/components/post/PostFeed'), {
  ssr: false,
  loading: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {[1, 2, 3].map(i => (
        <div key={i} className="skeleton" style={{ height: 120, borderRadius: 12 }} />
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
}

interface UserProfileClientProps {
  handle: string
  serverProfile: ServerProfile | null
}

export default function UserProfileClient({ handle, serverProfile }: UserProfileClientProps) {
  const router = useRouter()
  const { showToast } = useToast()
  const { t } = useLanguage()

  const [email, setEmail] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [profile, setProfile] = useState<ServerProfile | null>(serverProfile)
  const [avatarHovered, setAvatarHovered] = useState(false)
  const [modalType, setModalType] = useState<'followers' | 'following' | null>(null)
  const [followersCount, setFollowersCount] = useState(serverProfile?.followers || 0)
  const profileCreationRef = useRef(false) // Prevent race condition in profile creation

  // Auth check - lightweight, runs once
  useEffect(() => {
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
      console.error('[UserProfile] Auth check failed:', err)
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
        .select('id, handle, bio, avatar_url, cover_url, show_followers, show_following, subscription_tier')
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
        })
      } else {
        const defaultHandle = emailHandle || userId.slice(0, 8)
        const { data: newProfile, error: createError } = await supabase
          .from('user_profiles')
          .upsert({ id: userId, handle: defaultHandle }, { onConflict: 'id' })
          .select('id, handle, bio, avatar_url, cover_url')
          .single()

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
      console.error('Error creating own profile:', error)
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
  const searchParams = useSearchParams()
  const pathname = usePathname()

  type ProfileTabKey = 'overview' | 'groups' | 'bookmarks'
  const urlTab = searchParams.get('tab') as ProfileTabKey | null
  const [activeTab, setActiveTab] = useState<ProfileTabKey>(
    urlTab && ['overview', 'groups', 'bookmarks'].includes(urlTab) ? urlTab : 'overview'
  )

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

  const profileTabs: Array<{ key: ProfileTabKey; label: string }> = [
    { key: 'overview', label: t('overview') || '概览' },
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
                  color: '#ffffff',
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
                      color: '#ffffff',
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

                {profile.isVerifiedTrader && (
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
                <JoinedGroups userId={profile.id} />
                <UserBookmarkFolders userId={profile.id} isOwnProfile={isOwnProfile} />
              </Box>
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
