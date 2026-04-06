'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import ProBadge, { ProBadgeOverlay } from '@/app/components/ui/ProBadge'
import LevelBadge from '@/app/components/user/LevelBadge'

import { features } from '@/lib/features'
import type { ServerProfile } from './types'

const UserFollowButton = dynamic(() => import('@/app/components/ui/UserFollowButton'), { ssr: false })
const MessageButton = dynamic(() => import('@/app/components/ui/MessageButton'), { ssr: false })

interface UserProfileHeaderProps {
  profile: ServerProfile
  handle: string
  isOwnProfile: boolean
  currentUserId: string | null
  mounted: boolean
  followersCount: number
  followingCount: number
  onFollowersCountChange: (delta: number) => void
  onFollowersClick: () => void
}

export default function UserProfileHeader({
  profile,
  handle,
  isOwnProfile,
  currentUserId,
  mounted,
  followersCount,
  followingCount,
  onFollowersCountChange,
  onFollowersClick,
}: UserProfileHeaderProps) {
  const router = useRouter()
  const { t } = useLanguage()
  const [avatarHovered, setAvatarHovered] = useState(false)

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
              background: getAvatarGradient(profile.id),
              border: `3px solid ${avatarHovered ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
              display: 'grid', placeItems: 'center',
              overflow: 'hidden',
              position: 'relative',
              boxShadow: avatarHovered
                ? `0 8px 32px var(--color-accent-primary-40), 0 0 0 4px ${tokens.colors.accent.primary}20`
                : '0 4px 16px var(--color-overlay-light)',
              transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
              transform: avatarHovered ? 'scale(1.08)' : 'scale(1)',
              cursor: 'pointer',
            }}
          >
            <Text size="2xl" weight="black" style={{ color: tokens.colors.white, textShadow: 'var(--text-shadow-md)', fontSize: '32px', lineHeight: '1' }}>
              {getAvatarInitial(profile.handle)}
            </Text>
            {profile.avatar_url && (
              <Image
                src={`/api/avatar?url=${encodeURIComponent(profile.avatar_url)}`}
                alt={profile.handle} width={72} height={72}
                style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0, transition: 'all 0.4s ease' }}
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
              />
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
                {t('userProfileDeveloper')}
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
                {t('admin')}
              </span>
            )}
          </Box>

          {profile.bio && (
            <Text size="sm" style={{ color: secondaryTextColor, marginBottom: tokens.spacing[3], maxWidth: 500, textShadow }}>
              {profile.bio}
            </Text>
          )}

          {/* Stats row — social follower/following counts hidden when social is off */}
          {features.social && (
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
                onClick={onFollowersClick}
                style={{ cursor: profile.isRegistered && (isOwnProfile || profile.show_followers !== false) ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 4, padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`, borderRadius: tokens.radius.md }}
              >
                <Text size="sm" style={{ color: secondaryTextColor, textShadow }}>
                  <Text as="span" weight="bold" style={{ color: textColor, marginRight: 4, textShadow }}>{followersCount}</Text>
                  {t('followers')}
                </Text>
              </Box>
            </Box>
          )}
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

        {features.social && !isOwnProfile && profile.isRegistered && currentUserId && (
          <>
            <UserFollowButton
              targetUserId={profile.id}
              currentUserId={currentUserId}
              size="sm"
              onFollowChange={(isFollowing) => {
                onFollowersCountChange(isFollowing ? 1 : -1)
              }}
            />
            <MessageButton targetUserId={profile.id} currentUserId={currentUserId} size="sm" />
          </>
        )}

        {features.social && !isOwnProfile && profile.isRegistered && !currentUserId && mounted && (
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
            {t('userProfileLoginToFollow')}
          </Link>
        )}
      </Box>
    </Box>
  )
}
