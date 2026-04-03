'use client'

import Link from 'next/link'
import { useLoginModal } from '@/lib/hooks/useLoginModal'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

type Group = {
  id: string
  name: string
  name_en?: string | null
  description?: string | null
  description_en?: string | null
  avatar_url?: string | null
  member_count?: number | null
  created_at?: string | null
  owner_handle?: string | null
  is_premium_only?: boolean | null
}

interface GroupHeaderProps {
  group: Group
  groupId: string
  language: string
  userId: string | null
  isMember: boolean
  userRole: 'owner' | 'admin' | 'member' | null
  joining: boolean
  onJoin: () => void
  onLeave: () => void
  onShowGroupInfo: () => void
  onShowMembers: () => void
  memberPreviews?: Array<{ avatar_url?: string | null; handle?: string | null }>
}

export default function GroupHeader({
  group,
  groupId,
  language,
  userId,
  isMember,
  userRole,
  joining,
  onJoin,
  onLeave,
  onShowGroupInfo,
  onShowMembers,
  memberPreviews = [],
}: GroupHeaderProps) {
  const { t } = useLanguage()
  return (
    <Box
      style={{
        marginBottom: tokens.spacing[6],
        padding: `${tokens.spacing[6]} ${tokens.spacing[6]} ${tokens.spacing[5]}`,
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Subtle gradient accent at top */}
      <Box
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: tokens.gradient.primary,
          borderRadius: `${tokens.radius.xl} ${tokens.radius.xl} 0 0`,
        }}
      />

      <Box className="group-header-layout" style={{ display: 'flex', gap: tokens.spacing[5], alignItems: 'flex-start' }}>
        {/* Avatar */}
        <Box
          style={{
            width: 72,
            height: 72,
            borderRadius: tokens.radius.xl,
            background: tokens.colors.bg.tertiary || tokens.colors.bg.primary,
            border: `2px solid ${tokens.colors.border.primary}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            flexShrink: 0,
            boxShadow: '0 2px 8px var(--color-overlay-subtle)',
          }}
        >
          {group.avatar_url ? (
            <img
              src={`/api/avatar?url=${encodeURIComponent(group.avatar_url)}`}
              alt={group.name}
              width={72}
              height={72}
              loading="lazy"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              referrerPolicy="no-referrer"
              onError={(e) => { e.currentTarget.style.display = 'none' }}
            />
          ) : (
            <Text size="2xl" weight="bold" color="tertiary">
              {group.name.charAt(0).toUpperCase()}
            </Text>
          )}
        </Box>

        {/* Info */}
        <Box className="group-header-info" style={{ flex: 1, minWidth: 0 }}>
          <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[2], flexWrap: 'wrap', gap: tokens.spacing[2] }}>
            <Box>
              <Text
                size="2xl"
                weight="black"
                style={{
                  marginBottom: tokens.spacing[1],
                  cursor: 'pointer',
                  lineHeight: 1.3,
                }}
                onClick={onShowGroupInfo}
              >
                {language === 'en' && group.name_en ? group.name_en : group.name}
                {group.is_premium_only && (
                  <span style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: tokens.colors.white,
                    background: 'var(--color-pro-badge-bg)',
                    padding: '2px 6px',
                    borderRadius: tokens.radius.full,
                    marginLeft: tokens.spacing[2],
                    verticalAlign: 'middle',
                  }}>
                    Pro
                  </span>
                )}
                <span style={{
                  fontSize: 11,
                  color: tokens.colors.text.tertiary,
                  marginLeft: tokens.spacing[2],
                  verticalAlign: 'middle',
                }}>
                  ▼
                </span>
              </Text>

              {/* Meta row: members + owner + created */}
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], flexWrap: 'wrap', marginTop: tokens.spacing[2] }}>
                {group.member_count !== null && group.member_count !== undefined && (
                  <span
                    className="member-badge"
                    style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    onClick={onShowMembers}
                  >
                    {memberPreviews.length > 0 ? (
                      <span style={{ display: 'inline-flex', marginRight: -2 }}>
                        {memberPreviews.slice(0, 4).map((m, i) => (
                          <span
                            key={i}
                            style={{
                              width: 20,
                              height: 20,
                              borderRadius: '50%',
                              border: `2px solid ${tokens.colors.bg.secondary}`,
                              marginLeft: i === 0 ? 0 : -8,
                              overflow: 'hidden',
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              background: tokens.colors.bg.tertiary,
                              fontSize: 10,
                              fontWeight: 700,
                              color: tokens.colors.text.tertiary,
                              zIndex: 4 - i,
                              position: 'relative',
                            }}
                          >
                            {m.avatar_url ? (
                              <img
                                src={`/api/avatar?url=${encodeURIComponent(m.avatar_url)}`}
                                alt={m.handle || 'Member'}
                                width={20}
                                height={20}
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                loading="lazy"
                                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                              />
                            ) : (
                              (m.handle?.[0] || '?').toUpperCase()
                            )}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
                      </svg>
                    )}
                    {group.member_count} {t('groupMembers')}
                  </span>
                )}

                {group.owner_handle && (
                  <Text size="xs" color="tertiary" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {t('groupOwner')}:
                    <Link
                      href={`/u/${encodeURIComponent(group.owner_handle)}`}
                      style={{
                        color: tokens.colors.accent?.primary || tokens.colors.accent.brand,
                        textDecoration: 'none',
                        fontWeight: 600,
                      }}
                    >
                      @{group.owner_handle}
                    </Link>
                  </Text>
                )}

                {group.created_at && (
                  <Text size="xs" color="tertiary" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
                      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                    </svg>
                    {new Date(group.created_at).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short' })}
                  </Text>
                )}
              </Box>
            </Box>

            <Link
              href="/groups"
              style={{
                color: tokens.colors.text.tertiary,
                textDecoration: 'none',
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.semibold,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                borderRadius: tokens.radius.md,
                transition: `all ${tokens.transition.base}`,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = tokens.colors.text.primary
                e.currentTarget.style.background = `${tokens.colors.text.tertiary}15`
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = tokens.colors.text.tertiary
                e.currentTarget.style.background = 'transparent'
              }}
            >
              ← {t('back')}
            </Link>
          </Box>

          {/* Description */}
          {(() => {
            const desc = (language === 'en' && group.description_en) ? group.description_en : group.description
            return desc ? (
              <Text size="sm" color="secondary" style={{ marginTop: tokens.spacing[2], lineHeight: 1.65, maxWidth: 600 }}>
                {desc}
              </Text>
            ) : null
          })()}

          {/* Join/Leave Button */}
          <Box className="group-header-actions" style={{ marginTop: tokens.spacing[4], display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
            {userId ? (
              isMember ? (
                <>
                  <Link href={`/groups/${groupId}/new`} style={{ textDecoration: 'none' }}>
                    <Button variant="primary" size="sm">
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                        </svg>
                        {t('groupPost')}
                      </span>
                    </Button>
                  </Link>
                  {(userRole === 'owner' || userRole === 'admin') && (
                    <Link href={`/groups/${groupId}/manage`} style={{ textDecoration: 'none' }}>
                      <Button variant="secondary" size="sm">
                        {t('groupManage')}
                      </Button>
                    </Link>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={onLeave}
                    disabled={joining}
                  >
                    {joining
                      ? t('groupLeaving')
                      : t('groupLeaveBtn')}
                  </Button>
                </>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={onJoin}
                  disabled={joining}
                >
                  {joining
                    ? t('groupJoining')
                    : t('groupJoinBtn')}
                </Button>
              )
            ) : (
              <Button variant="primary" size="sm" onClick={() => useLoginModal.getState().openLoginModal()}>
                {t('groupLoginToJoin')}
              </Button>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
