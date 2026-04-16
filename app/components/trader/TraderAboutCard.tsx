'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { Box, Text } from '../base'
import TraderFollowButton from '../ui/TraderFollowButton'
import UserFollowButton from '../ui/UserFollowButton'
import MessageButton from '../ui/MessageButton'
import { DynamicFollowListModal as FollowListModal } from '../ui/Dynamic'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

// Sub-components
import { TraderAnimatedAvatar } from './TraderAnimatedAvatar'
import { TraderSocialLinksSection, type SocialLinks } from './TraderSocialLinks'
import { TraderStatItem } from './TraderStatItem'

interface TraderAboutCardProps {
  handle: string
  traderId?: string
  avatarUrl?: string
  bio?: string
  followers?: number
  following?: number
  isRegistered?: boolean
  isOwnProfile?: boolean
  showFollowers?: boolean
  showFollowing?: boolean
  socialLinks?: SocialLinks
}

/**
 * Trader profile about card -- glass-morphism side panel.
 */
export default function TraderAboutCard({
  handle,
  traderId,
  avatarUrl,
  bio,
  followers = 0,
  following = 0,
  isRegistered,
  isOwnProfile = false,
  showFollowers = true,
  socialLinks,
}: TraderAboutCardProps) {
  const [userId, setUserId] = useState<string | null>(null)
  const [modalType, setModalType] = useState<'followers' | null>(null)
  const [mounted, setMounted] = useState(false)
  const [followersCount, setFollowersCount] = useState(followers)
  const { t } = useLanguage()

  useEffect(() => {
    setMounted(true)
    supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null)
    }).catch(() => { /* Intentionally swallowed: auth check non-critical for about card */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
  }, [])

  const handleFollowersClick = () => {
    if (!isRegistered) return
    if (isOwnProfile || showFollowers) {
      setModalType('followers')
    }
  }

  return (
    <Box
      className="about-card glass-card"
      style={{
        background: `linear-gradient(165deg, ${tokens.colors.bg.secondary}F0 0%, ${tokens.colors.bg.primary}E8 100%)`,
        backdropFilter: tokens.glass.blur.lg,
        WebkitBackdropFilter: tokens.glass.blur.lg,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
        padding: tokens.spacing[6],
        boxShadow: `0 8px 32px var(--color-overlay-light), inset 0 1px 0 var(--glass-bg-light)`,
        transition: `all ${tokens.transition.smooth}`,
        zIndex: 10,
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateX(0)' : 'translateX(30px)',
        overflow: 'hidden',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-4px)'
        e.currentTarget.style.boxShadow = '0 20px 48px var(--color-overlay-light), inset 0 1px 0 var(--glass-bg-light)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)'
        e.currentTarget.style.boxShadow = '0 8px 32px var(--color-overlay-light), inset 0 1px 0 var(--glass-bg-light)'
      }}
    >
      {/* Decorative background */}
      <Box
        style={{
          position: 'absolute',
          top: -60,
          right: -60,
          width: 180,
          height: 180,
          background: `radial-gradient(circle, ${tokens.colors.accent.primary}15 0%, transparent 70%)`,
          pointerEvents: 'none',
        }}
      />

      {/* Avatar */}
      <Box style={{ display: 'flex', justifyContent: 'center', position: 'relative', zIndex: 1 }}>
        <TraderAnimatedAvatar
          avatarUrl={avatarUrl}
          handle={handle}
          traderId={traderId || handle}
          size={80}
        />
      </Box>

      {/* Trader ID */}
      <Text
        size="xl"
        weight="black"
        style={{
          marginBottom: tokens.spacing[2],
          color: tokens.colors.text.primary,
          lineHeight: tokens.typography.lineHeight.tight,
          textAlign: 'center',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {handle}
      </Text>

      {/* Bio */}
      {bio ? (
        <Text
          size="sm"
          color="secondary"
          style={{
            marginBottom: tokens.spacing[5],
            lineHeight: tokens.typography.lineHeight.relaxed,
            textAlign: 'center',
            position: 'relative',
            zIndex: 1,
          }}
        >
          {bio.length > 60 ? bio.slice(0, 60) + '...' : bio}
        </Text>
      ) : isOwnProfile ? (
        <Text
          size="sm"
          color="tertiary"
          style={{
            marginBottom: tokens.spacing[5],
            lineHeight: tokens.typography.lineHeight.relaxed,
            textAlign: 'center',
            position: 'relative',
            zIndex: 1,
            fontStyle: 'italic',
          }}
        >
          {t('addBioHint')}
        </Text>
      ) : null}

      {/* Social Links */}
      {socialLinks && <TraderSocialLinksSection socialLinks={socialLinks} />}

      {/* Action buttons -- only on other profiles */}
      <Box style={{ position: 'relative', zIndex: 1 }}>
        {!isOwnProfile && traderId && userId ? (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2], marginBottom: tokens.spacing[5] }}>
            {isRegistered ? (
              <>
                <UserFollowButton
                  targetUserId={traderId}
                  currentUserId={userId}
                  fullWidth
                  size="lg"
                  onFollowChange={(isFollowing) => {
                    setFollowersCount(prev => isFollowing ? prev + 1 : prev - 1)
                  }}
                />
                <MessageButton
                  targetUserId={traderId}
                  currentUserId={userId}
                  fullWidth
                  size="md"
                />
              </>
            ) : (
              <TraderFollowButton
                traderId={traderId}
                userId={userId}
                onFollowChange={(isFollowing) => {
                  setFollowersCount(prev => isFollowing ? prev + 1 : prev - 1)
                }}
              />
            )}
          </Box>
        ) : null}
      </Box>

      {/* Stats grid: Following + Followers */}
      <Box
        style={{
          paddingTop: tokens.spacing[5],
          borderTop: `1px solid ${tokens.colors.border.primary}40`,
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: tokens.spacing[3],
          position: 'relative',
          zIndex: 1,
        }}
      >
        {isOwnProfile ? (
          <Link href="/following" style={{ textDecoration: 'none' }}>
            <TraderStatItem label={t('following')} value={following} clickable />
          </Link>
        ) : (
          <TraderStatItem label={t('following')} value={following} clickable={false} />
        )}

        <TraderStatItem
          label={t('followers')}
          value={followersCount}
          onClick={handleFollowersClick}
          clickable={isRegistered && (isOwnProfile || showFollowers)}
        />
      </Box>

      {/* Followers list modal */}
      {isRegistered && (
        <FollowListModal
          isOpen={modalType === 'followers'}
          onClose={() => setModalType(null)}
          type="followers"
          handle={handle}
          currentUserId={userId}
          isOwnProfile={isOwnProfile}
          isPublic={showFollowers}
        />
      )}
    </Box>
  )
}
