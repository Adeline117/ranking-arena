'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import { Box, Text } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { DynamicFollowListModal as FollowListModal } from '@/app/components/ui/Dynamic'

import type { ServerProfile, ProfileTabKey, TraderPageData } from './types'
import { userProfileStyles } from './profileStyles'
import UserProfileHeader from './UserProfileHeader'
import UserProfileTabs from './UserProfileTabs'

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

interface NonTraderProfileViewProps {
  email: string | null
  handle: string
  profile: ServerProfile
  serverProfile: ServerProfile | null
  currentUserId: string | null
  isPro: boolean
  mounted: boolean
  activeTab: ProfileTabKey
  onTabChange: (tab: ProfileTabKey) => void
  followersCount: number
  onFollowersCountChange: (delta: number) => void
  traderData: TraderPageData | null | undefined
}

export default function NonTraderProfileView({
  email,
  handle,
  profile,
  serverProfile: _serverProfile,
  currentUserId,
  isPro: _isPro,
  mounted,
  activeTab,
  onTabChange,
  followersCount,
  onFollowersCountChange,
  traderData,
}: NonTraderProfileViewProps) {
  const router = useRouter()
  const { t } = useLanguage()
  const [modalType, setModalType] = useState<'followers' | 'following' | null>(null)

  const isOwnProfile = currentUserId === profile.id
  const followingCount = (profile.following || 0) + (profile.followingTraders || 0)

  const traderProfile = traderData?.profile ?? null
  const traderStats = traderData?.stats ?? null
  const traderPortfolio = traderData?.portfolio ?? []
  const traderPositionHistory = traderData?.positionHistory ?? []
  const traderEquityCurve = traderData?.equityCurve
  const traderAssetBreakdown = traderData?.assetBreakdown

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
          { label: t('userProfileCommunity'), href: '/' },
          { label: `@${profile.handle}` },
        ]} />

        {/* Profile Header */}
        <UserProfileHeader
          profile={profile}
          handle={handle}
          isOwnProfile={isOwnProfile}
          currentUserId={currentUserId}
          mounted={mounted}
          followersCount={followersCount}
          followingCount={followingCount}
          onFollowersCountChange={onFollowersCountChange}
          onFollowersClick={() => {
            if (profile.isRegistered && (isOwnProfile || profile.show_followers !== false)) {
              setModalType('followers')
            }
          }}
        />

        {/* Tabs */}
        <UserProfileTabs activeTab={activeTab} onTabChange={onTabChange} />

        {/* Tab Content */}
        <Box key={activeTab} style={{ animation: 'fadeInUp 0.4s ease-out forwards' }}>
          {activeTab === 'overview' && (
            <Box className="profile-content" style={{ maxWidth: 900 }}>
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
                <PostFeed
                  authorHandle={profile.handle}
                  variant="compact"
                  showSortButtons
                  createPostHref={isOwnProfile ? `/u/${profile.handle}/new` : undefined}
                />
              </Box>
            </Box>
          )}

          {activeTab === 'stats' && (
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
                  <Text size="sm" color="tertiary">{t('userProfileNoStatsYet')}</Text>
                </Box>
              )}
            </Box>
          )}

          {activeTab === 'portfolio' && (
            <Box style={{ maxWidth: 900 }}>
              <PortfolioTable items={traderPortfolio} history={traderPositionHistory} isPro={true} onUnlock={() => router.push('/pricing')} />
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

        <style>{userProfileStyles}</style>
      </Box>
    </Box>
  )
}
