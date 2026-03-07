'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import Avatar from '@/app/components/ui/Avatar'
import { getSafeProfileUrl } from '@/lib/utils/profile-navigation'
import { formatLastSeen } from '@/lib/hooks/usePresence'
import type { OtherUser } from './types'

interface PresenceInfo {
  isOnline: boolean
  lastSeenAt: string | null
}

interface ConversationHeaderProps {
  otherUser: OtherUser | null
  userId: string | null
  remark: string | null
  otherPresence: PresenceInfo | null
  connectionStatus: 'connected' | 'disconnected' | 'reconnecting'
  email: string | null
  onSettingsOpen: () => void
  onSearchOpen: () => void
  t: (key: string) => string
}

function HeaderButton({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 36, height: 36, borderRadius: tokens.radius.full, border: 'none',
        background: 'transparent', color: tokens.colors.text.secondary, cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'all 0.2s', flexShrink: 0,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.tertiary || 'var(--glass-border-light)'; e.currentTarget.style.color = tokens.colors.text.primary }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = tokens.colors.text.secondary }}
      title={title}
    >
      {children}
    </button>
  )
}

export default function ConversationHeader({
  otherUser,
  userId,
  remark,
  otherPresence,
  connectionStatus,
  onSettingsOpen,
  onSearchOpen,
  t,
}: ConversationHeaderProps) {
  const displayName = otherUser ? (otherUser.handle || `User ${otherUser.id.slice(0, 8)}`) : ''
  const profileUrl = otherUser ? getSafeProfileUrl(otherUser, userId) : null

  return (
    <>
      <Box
        style={{
          display: 'flex', alignItems: 'center', gap: tokens.spacing[3],
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          background: tokens.colors.bg.secondary,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
          backdropFilter: tokens.glass.blur.lg, WebkitBackdropFilter: tokens.glass.blur.lg, boxShadow: tokens.shadow.xs,
        }}
      >
        {/* Back button */}
        <Link 
          href="/messages" 
          style={{ 
            color: tokens.colors.text.primary, textDecoration: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 38, height: 38, borderRadius: tokens.radius.full,
            background: tokens.colors.bg.tertiary, transition: `all ${tokens.transition.fast}`,
            boxShadow: tokens.shadow.xs,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.hover; e.currentTarget.style.transform = 'scale(1.05)'; e.currentTarget.style.boxShadow = tokens.shadow.sm }}
          onMouseLeave={(e) => { e.currentTarget.style.background = tokens.colors.bg.tertiary; e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = tokens.shadow.xs }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
        </Link>
        
        {/* User info */}
        {otherUser && (() => {
          if (!profileUrl) {
            return (
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], flex: 1, padding: `${tokens.spacing[2]} ${tokens.spacing[3]}` }}>
                <Avatar userId={otherUser.id} name={displayName} avatarUrl={otherUser.avatar_url} size={44} />
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Text size="base" weight="bold" style={{ color: tokens.colors.text.primary }}>{remark || displayName}</Text>
                  {remark && <Text size="xs" color="tertiary" style={{ marginTop: 2 }}>@{displayName}</Text>}
                </Box>
              </Box>
            )
          }
          return (
            <Link
              href={profileUrl}
              style={{
                textDecoration: 'none', display: 'flex', alignItems: 'center',
                gap: tokens.spacing[3], flex: 1, padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.lg, transition: 'background 0.2s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.tertiary || 'var(--overlay-hover)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <Box style={{ position: 'relative' }}>
                <Avatar userId={otherUser.id} name={displayName} avatarUrl={otherUser.avatar_url} size={44} />
                {otherPresence && (
                  <Box style={{
                    position: 'absolute', bottom: 1, right: 1, width: 12, height: 12,
                    borderRadius: tokens.radius.full,
                    background: otherPresence.isOnline ? tokens.colors.accent.success : tokens.colors.text.tertiary,
                    border: `2px solid ${tokens.colors.bg.secondary}`,
                    boxShadow: otherPresence.isOnline ? tokens.shadow.glowSuccess : 'none',
                    transition: 'background 0.3s',
                  }} />
                )}
              </Box>
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text size="base" weight="bold" style={{ color: tokens.colors.text.primary }}>{remark || displayName}</Text>
                {remark && <Text size="xs" color="tertiary" style={{ marginTop: 2 }}>@{displayName}</Text>}
                {!remark && otherPresence && (
                  <Text size="xs" style={{
                    marginTop: 2,
                    color: otherPresence.isOnline ? tokens.colors.accent.success : tokens.colors.text.tertiary,
                    fontWeight: otherPresence.isOnline ? 600 : 400,
                  }}>
                    {otherPresence.isOnline ? t('onlineNow') : formatLastSeen(otherPresence.lastSeenAt, t)}
                  </Text>
                )}
                {!remark && !otherPresence && otherUser.bio && (
                  <Text size="xs" color="tertiary" style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                    {otherUser.bio}
                  </Text>
                )}
              </Box>
            </Link>
          )
        })()}

        {/* Action buttons */}
        {otherUser && (
          <>
            <HeaderButton onClick={() => window.dispatchEvent(new CustomEvent('startCall', { detail: { targetUserId: otherUser.id, callType: 'voice' } }))} title={t('voiceCall')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
              </svg>
            </HeaderButton>
            <HeaderButton onClick={() => window.dispatchEvent(new CustomEvent('startCall', { detail: { targetUserId: otherUser.id, callType: 'video' } }))} title={t('videoCall')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg>
            </HeaderButton>
            <HeaderButton onClick={onSearchOpen} title={t('searchChatHistory')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
            </HeaderButton>
            <HeaderButton onClick={onSettingsOpen} title={t('chatSettings')}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="1" />
                <circle cx="19" cy="12" r="1" />
                <circle cx="5" cy="12" r="1" />
              </svg>
            </HeaderButton>
          </>
        )}
      </Box>

      {/* Connection status banner */}
      {connectionStatus !== 'connected' && (
        <Box style={{
          padding: '6px 16px',
          background: connectionStatus === 'reconnecting' ? 'var(--color-orange-subtle)' : 'var(--color-accent-error-15)',
          color: connectionStatus === 'reconnecting' ? tokens.colors.accent.warning : tokens.colors.accent.error,
          textAlign: 'center', fontSize: 12, fontWeight: 600,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          {connectionStatus === 'reconnecting' ? t('reconnectingMessage') : t('connectionLostMessage')}
        </Box>
      )}
    </>
  )
}
