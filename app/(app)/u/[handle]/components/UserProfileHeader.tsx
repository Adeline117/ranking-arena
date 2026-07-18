'use client'

import { useState } from 'react'
import type { CSSProperties } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import { formatDateLocalized } from '@/lib/utils/format'
import ProBadge, { ProBadgeOverlay } from '@/app/components/ui/ProBadge'
import LevelBadge from '@/app/components/user/LevelBadge'

import { features } from '@/lib/features'
import { avatarSrc, isSvgAvatarSource } from '@/lib/utils/avatar-proxy'
import type { ServerProfile } from './types'

const UserFollowButton = dynamic(() => import('@/app/components/ui/UserFollowButton'), {
  ssr: false,
})
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
  const { t, language } = useLanguage()
  const [avatarHovered, setAvatarHovered] = useState(false)

  const joinedLabel = profile.created_at
    ? formatDateLocalized(profile.created_at, language, { year: 'numeric', month: 'long' })
    : null

  const hasCover = Boolean(profile.cover_url)
  const containerBackground = hasCover
    ? `linear-gradient(to bottom, var(--color-overlay-subtle) 0%, var(--color-backdrop) 100%), url(${profile.cover_url}) center/cover no-repeat`
    : `linear-gradient(135deg, ${alpha(tokens.colors.bg.secondary, 97)} 0%, ${alpha(tokens.colors.bg.primary, 91)} 100%)`
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
        border: `1px solid ${alpha(tokens.colors.border.primary, 31)}`,
        borderBottom: 'none',
        boxShadow: '0 8px 32px var(--color-overlay-subtle), inset 0 1px 0 var(--overlay-hover)',
        position: 'relative',
        overflow: 'visible',
        opacity: mounted ? 1 : 0,
        transition: 'opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      {!hasCover && (
        <Box
          style={{
            position: 'absolute',
            inset: 0,
            overflow: 'hidden',
            borderRadius: tokens.radius.xl,
            pointerEvents: 'none',
          }}
        >
          <Box
            style={{
              position: 'absolute',
              top: -100,
              left: -100,
              width: 300,
              height: 300,
              background: `radial-gradient(circle, ${alpha(tokens.colors.accent.primary, 3)} 0%, transparent 70%)`,
            }}
          />
          <Box
            style={{
              position: 'absolute',
              bottom: -80,
              right: -80,
              width: 200,
              height: 200,
              background: `radial-gradient(circle, ${alpha(tokens.colors.accent.brand, 2)} 0%, transparent 70%)`,
            }}
          />
        </Box>
      )}

      {hasCover && (
        /* Contrast scrim — guarantees text legibility over arbitrary cover images
           (textShadow alone is insufficient on light/busy photos) */
        <Box
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: `${tokens.radius.xl} ${tokens.radius.xl} 0 0`,
            background:
              'linear-gradient(to top, var(--color-overlay-dark) 0%, var(--color-overlay-subtle) 55%, transparent 100%)',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />
      )}

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
              background: getAvatarGradient(profile.id),
              border: `3px solid ${avatarHovered ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
              display: 'grid',
              placeItems: 'center',
              overflow: 'hidden',
              position: 'relative',
              boxShadow: avatarHovered
                ? `0 8px 32px var(--color-accent-primary-40), 0 0 0 4px ${alpha(tokens.colors.accent.primary, 13)}`
                : '0 4px 16px var(--color-overlay-light)',
              transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
              transform: avatarHovered ? 'scale(1.08)' : 'scale(1)',
              cursor: 'pointer',
            }}
          >
            <Text
              size="2xl"
              weight="black"
              style={{
                color: tokens.colors.white,
                textShadow: 'var(--text-shadow-md)',
                fontSize: '32px',
                lineHeight: '1',
              }}
            >
              {getAvatarInitial(profile.handle)}
            </Text>
            {profile.avatar_url && (
              <Image
                src={avatarSrc(profile.avatar_url)}
                alt={profile.handle}
                width={72}
                height={72}
                // dicebear/SVG avatars 400 through /_next/image (dangerouslyAllowSVG:false)
                unoptimized={isSvgAvatarSource(profile.avatar_url)}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  position: 'absolute',
                  inset: 0,
                  transition: 'all 0.4s ease',
                }}
                onError={(e) => {
                  ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                }}
              />
            )}
          </Box>
          {profile.proBadgeTier === 'pro' && <ProBadgeOverlay position="bottom-right" />}
        </Box>

        {/* Info */}
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[3],
              marginBottom: tokens.spacing[2],
              flexWrap: 'wrap',
            }}
          >
            <Text
              size="2xl"
              weight="black"
              className="trader-name-truncate"
              style={{
                color: textColor,
                lineHeight: tokens.typography.lineHeight.tight,
                textShadow,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '100%',
              }}
            >
              {profile.handle}
            </Text>

            <LevelBadge exp={profile.exp || 0} size="md" />

            {profile.isVerifiedTrader && (
              <Box
                role="img"
                aria-label={t('verifiedTrader')}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 22,
                  height: 22,
                  background: `linear-gradient(135deg, ${tokens.colors.accent.success}, var(--color-accent-success))`,
                  borderRadius: tokens.radius.full,
                  boxShadow: `0 2px 8px ${alpha(tokens.colors.accent.success, 25)}`,
                }}
                title={t('verifiedTrader')}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="white"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  focusable="false"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </Box>
            )}

            {profile.proBadgeTier === 'pro' && <ProBadge size="sm" showLabel={true} />}

            {profile.role === 'developer' && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 8px',
                  background:
                    'linear-gradient(135deg, var(--color-brand), var(--color-brand-hover))',
                  borderRadius: tokens.radius.full,
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'var(--color-on-accent)',
                  letterSpacing: '0.02em',
                  boxShadow: '0 2px 8px var(--color-accent-primary-40)',
                }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="16 18 22 12 16 6" />
                  <polyline points="8 6 2 12 8 18" />
                </svg>
                {t('userProfileDeveloper')}
              </span>
            )}

            {profile.role === 'admin' && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 8px',
                  background:
                    'linear-gradient(135deg, var(--color-medal-gold), var(--color-medal-gold-end))',
                  borderRadius: tokens.radius.full,
                  fontSize: 11,
                  fontWeight: 700,
                  color: tokens.colors.black,
                  letterSpacing: '0.02em',
                  boxShadow: '0 2px 8px var(--color-gold-glow)',
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 1l3.22 6.636 7.28.96-5.25 5.18 1.24 7.224L12 17.77 5.51 21l1.24-7.224L1.5 8.596l7.28-.96z" />
                </svg>
                {t('admin')}
              </span>
            )}
          </Box>

          {profile.bio && (
            <Text
              size="sm"
              style={{
                color: secondaryTextColor,
                marginBottom: tokens.spacing[3],
                maxWidth: 500,
                textShadow,
              }}
            >
              {profile.bio}
            </Text>
          )}

          {/* Stats row — social follower/following counts hidden when social is off */}
          {features.social && (
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[3],
                flexWrap: 'wrap',
              }}
            >
              {(() => {
                const followingInteractive = isOwnProfile
                const followersInteractive =
                  profile.isRegistered && (isOwnProfile || profile.show_followers !== false)
                const statButtonStyle = (interactive: boolean): CSSProperties => ({
                  appearance: 'none',
                  background: 'transparent',
                  border: 'none',
                  font: 'inherit',
                  textAlign: 'left',
                  cursor: interactive ? 'pointer' : 'default',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                  borderRadius: tokens.radius.md,
                })
                return (
                  <>
                    <button
                      type="button"
                      onClick={() => followingInteractive && router.push('/following')}
                      disabled={!followingInteractive}
                      aria-label={`${followingCount} ${t('following')}`}
                      style={statButtonStyle(followingInteractive)}
                    >
                      <Text size="sm" style={{ color: secondaryTextColor, textShadow }}>
                        <Text
                          as="span"
                          weight="bold"
                          style={{ color: textColor, marginRight: 4, textShadow }}
                        >
                          {followingCount}
                        </Text>
                        {t('following')}
                      </Text>
                    </button>

                    <button
                      type="button"
                      onClick={() => followersInteractive && onFollowersClick()}
                      disabled={!followersInteractive}
                      aria-label={`${followersCount} ${t('followers')}`}
                      style={statButtonStyle(followersInteractive)}
                    >
                      <Text size="sm" style={{ color: secondaryTextColor, textShadow }}>
                        <Text
                          as="span"
                          weight="bold"
                          style={{ color: textColor, marginRight: 4, textShadow }}
                        >
                          {followersCount}
                        </Text>
                        {t('followers')}
                      </Text>
                    </button>
                  </>
                )
              })()}
            </Box>
          )}

          {/* About — joined date (only field that exists on user_profiles) */}
          {joinedLabel && (
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginTop: tokens.spacing[2],
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ color: secondaryTextColor, flexShrink: 0 }}
                aria-hidden="true"
                focusable="false"
              >
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              <Text size="sm" style={{ color: secondaryTextColor, textShadow }}>
                {t('joined')} {joinedLabel}
              </Text>
            </Box>
          )}
        </Box>
      </Box>

      {/* Action buttons */}
      <Box
        className="profile-header-actions action-buttons"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
          flexWrap: 'wrap',
          position: 'relative',
          zIndex: 1,
        }}
      >
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
            transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          ← {t('back')}
        </button>

        {isOwnProfile && (
          <button
            onClick={() => router.push('/settings')}
            style={{
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.sm,
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.lg,
              background: `${alpha(tokens.colors.accent.primary, 8)}`,
              border: `1px solid ${alpha(tokens.colors.accent.primary, 25)}`,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
              fontWeight: tokens.typography.fontWeight.medium,
              transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            {t('editProfile')}
          </button>
        )}

        {features.social && !isOwnProfile && profile.isRegistered && (
          <>
            <UserFollowButton
              targetUserId={profile.id}
              currentUserId={currentUserId}
              size="sm"
              loginReturnPath={`/u/${encodeURIComponent(handle)}`}
              onFollowChange={(isFollowing) => {
                onFollowersCountChange(isFollowing ? 1 : -1)
              }}
            />
            <MessageButton
              targetUserId={profile.id}
              currentUserId={currentUserId}
              size="sm"
              loginReturnPath={`/u/${encodeURIComponent(handle)}`}
            />
          </>
        )}
      </Box>
    </Box>
  )
}
