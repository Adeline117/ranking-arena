'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'

type Group = {
  id: string
  name: string
  name_en?: string | null
  avatar_url?: string | null
  member_count?: number | null
  owner_handle?: string | null
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
}: GroupHeaderProps) {
  return (
    <Box
      style={{
        marginBottom: tokens.spacing[6],
        padding: tokens.spacing[6],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      <Box style={{ display: 'flex', gap: tokens.spacing[4], alignItems: 'flex-start' }}>
        {/* Avatar */}
        <Box
          style={{
            width: 80,
            height: 80,
            borderRadius: tokens.radius.xl,
            background: tokens.colors.bg.tertiary || tokens.colors.bg.primary,
            border: `2px solid ${tokens.colors.border.primary}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          {group.avatar_url ? (
            <img
              src={group.avatar_url}
              alt={group.name}
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
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[2] }}>
            <Box>
              <Text
                size="2xl"
                weight="black"
                style={{
                  marginBottom: tokens.spacing[1],
                  cursor: 'pointer',
                }}
                onClick={onShowGroupInfo}
              >
                {language === 'en' && group.name_en ? group.name_en : group.name}
                <span style={{
                  fontSize: tokens.typography.fontSize.xs,
                  color: tokens.colors.text.tertiary,
                  marginLeft: tokens.spacing[2],
                }}>
                  ▼
                </span>
              </Text>

              {group.member_count !== null && group.member_count !== undefined && (
                <Text
                  size="sm"
                  color="tertiary"
                  style={{ cursor: 'pointer' }}
                  onClick={onShowMembers}
                >
                  <span style={{
                    textDecoration: 'underline',
                    textDecorationStyle: 'dotted',
                  }}>
                    {group.member_count} {language === 'zh' ? '位成员' : 'members'}
                  </span>
                </Text>
              )}

              {group.owner_handle && (
                <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
                  {language === 'zh' ? '组长' : 'Owner'}:
                  <Link
                    href={`/u/${encodeURIComponent(group.owner_handle)}`}
                    style={{
                      color: tokens.colors.accent?.primary || tokens.colors.accent.brand,
                      textDecoration: 'none',
                      marginLeft: tokens.spacing[1],
                    }}
                  >
                    @{group.owner_handle}
                  </Link>
                </Text>
              )}
            </Box>
            <Link
              href="/groups"
              style={{
                color: tokens.colors.accent?.primary || tokens.colors.text.secondary,
                textDecoration: 'none',
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.semibold,
              }}
            >
              ← {language === 'zh' ? '返回' : 'Back'}
            </Link>
          </Box>

          {/* Join/Leave Button */}
          <Box style={{ marginTop: tokens.spacing[4] }}>
            {userId ? (
              isMember ? (
                <Box style={{ display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
                  <Link href={`/groups/${groupId}/new`} style={{ textDecoration: 'none' }}>
                    <Button variant="primary" size="sm">
                      {language === 'zh' ? '+ 发帖' : '+ Post'}
                    </Button>
                  </Link>
                  {(userRole === 'owner' || userRole === 'admin') && (
                    <Link href={`/groups/${groupId}/manage`}>
                      <Button variant="secondary" size="sm">
                        {language === 'zh' ? '管理' : 'Manage'}
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
                      ? (language === 'zh' ? '退出中...' : 'Leaving...')
                      : (language === 'zh' ? '退出小组' : 'Leave')}
                  </Button>
                </Box>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={onJoin}
                  disabled={joining}
                >
                  {joining
                    ? (language === 'zh' ? '加入中...' : 'Joining...')
                    : (language === 'zh' ? '+ 加入小组' : '+ Join')}
                </Button>
              )
            ) : (
              <Link href="/login">
                <Button variant="primary" size="sm">
                  {language === 'zh' ? '登录后加入' : 'Login to join'}
                </Button>
              </Link>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
