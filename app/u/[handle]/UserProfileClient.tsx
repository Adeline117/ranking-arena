'use client'

import TopNav from '@/app/components/layout/TopNav'
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import { Box } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import { DynamicFollowListModal as FollowListModal } from '@/app/components/ui/Dynamic'

import { features } from '@/lib/features'
import type { ServerProfile, TraderPageData, ProfileTabKey } from './components/types'
import { userProfileStyles } from './components/profileStyles'
import ProfileNotFound from './components/ProfileNotFound'
import { TraderLoading, TraderError } from './components/TraderLoadingError'
import TraderProfileView from './components/TraderProfileView'
import UserProfileHeader from './components/UserProfileHeader'
import UserProfileTabs from './components/UserProfileTabs'
import UserProfileContent from './components/UserProfileContent'
import { useUserProfile } from './hooks/useUserProfile'

// Re-export types for backward compatibility
export type { ServerProfile, TraderPageData, ProfileTabKey }

interface UserProfileClientProps {
  handle: string
  serverProfile: ServerProfile | null
  serverTraderData?: TraderPageData | null
}

export default function UserProfileClient({ handle, serverProfile, serverTraderData }: UserProfileClientProps) {
  const {
    email,
    currentUserId,
    profile,
    mounted,
    isPro,
    isOwnProfile,
    t,

    modalType,
    setModalType,
    followersCount,
    setFollowersCount,
    followingCount,

    activeProfileTab,
    handleProfileTabChange,

    isTrader,
    traderData,
    isTraderDataLoading,
    isTraderDataError,
    isBlocked,
  } = useUserProfile({ handle, serverProfile, serverTraderData })

  // Not found state
  if (!profile) {
    return <ProfileNotFound handle={handle} email={email} />
  }

  // Blocked state — show minimal page
  if (isBlocked) {
    return (
      <>
        <TopNav email={email} />
        <Box style={{ ...userProfileStyles.wrapper, textAlign: 'center', padding: '80px 20px' }}>
          <Box style={{ fontSize: 48, marginBottom: 16 }}>🚫</Box>
          <Box style={{ color: tokens.colors.text.secondary, fontSize: 16 }}>
            {t('profileUnavailable') || 'This profile is not available.'}
          </Box>
        </Box>
      </>
    )
  }

  // Trader loading state
  if (isTraderDataLoading) {
    return <TraderLoading email={email} />
  }

  // Trader error state
  if (isTraderDataError) {
    return <TraderError email={email} />
  }

  // Trader mode: identical to TraderPageClient layout
  if (isTrader) {
    return (
      <TraderProfileView
        email={email}
        handle={handle}
        profile={profile}
        serverProfile={serverProfile}
        currentUserId={currentUserId}
        isPro={isPro}
        activeTab={activeProfileTab}
        onTabChange={handleProfileTabChange}
        traderData={traderData}
      />
    )
  }

  // Non-trader mode: user profile layout
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
          onFollowersCountChange={(delta) => setFollowersCount(prev => prev + delta)}
          onFollowersClick={() => {
            if (profile.isRegistered && (isOwnProfile || profile.show_followers !== false)) {
              setModalType('followers')
            }
          }}
        />

        {/* Tabs */}
        <UserProfileTabs
          activeTab={activeProfileTab}
          onTabChange={handleProfileTabChange}
        />

        {/* Tab Content */}
        <UserProfileContent
          profile={profile}
          handle={handle}
          isOwnProfile={isOwnProfile}
          activeTab={activeProfileTab}
          traderData={traderData}
        />

        {/* Followers modal — hidden when social is off */}
        {features.social && profile.isRegistered && (
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

// FollowersList extracted to ./components/FollowersList.tsx
