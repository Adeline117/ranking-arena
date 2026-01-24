'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { ListSkeleton } from '@/app/components/ui/Skeleton'

type Group = {
  id: string
  name: string
  name_en?: string | null
  description?: string | null
  description_en?: string | null
  member_count?: number | null
  created_at?: string | null
  rules?: string | null
  owner_handle?: string | null
}

type GroupMember = {
  user_id: string
  role: string
  handle?: string | null
  avatar_url?: string | null
}

interface GroupInfoModalProps {
  group: Group
  language: string
  onClose: () => void
  onShowMembers: () => void
}

export function GroupInfoModal({ group, language, onClose, onShowMembers }: GroupInfoModalProps) {
  return (
    <Box
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: tokens.zIndex.modal,
      }}
      onClick={onClose}
    >
      <Box
        style={{
          background: tokens.colors.bg.primary,
          borderRadius: tokens.radius.xl,
          padding: tokens.spacing[6],
          width: '90%',
          maxWidth: 500,
          maxHeight: '80vh',
          overflowY: 'auto',
          border: `1px solid ${tokens.colors.border.primary}`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
          <Text size="xl" weight="bold">
            {language === 'zh' ? '小组信息' : 'Group Info'}
          </Text>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: 20,
              cursor: 'pointer',
              color: tokens.colors.text.tertiary,
            }}
          >
            ×
          </button>
        </Box>

        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          <Box>
            <Text size="sm" weight="semibold" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
              {language === 'zh' ? '组长' : 'Owner'}
            </Text>
            <Text size="md">
              {group.owner_handle ? (
                <Link
                  href={`/u/${group.owner_handle}`}
                  style={{ color: tokens.colors.accent?.primary || '#8b6fa8', textDecoration: 'none' }}
                >
                  @{group.owner_handle}
                </Link>
              ) : (
                language === 'zh' ? '暂无' : 'None'
              )}
            </Text>
          </Box>

          <Box>
            <Text size="sm" weight="semibold" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
              {language === 'zh' ? '小组简介' : 'Description'}
            </Text>
            <Text size="md" style={{ lineHeight: 1.6 }}>
              {(language === 'en' && group.description_en ? group.description_en : group.description) ||
                (language === 'zh' ? '暂无简介' : 'No description')}
            </Text>
          </Box>

          <Box>
            <Text size="sm" weight="semibold" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
              {language === 'zh' ? '发言规则' : 'Rules'}
            </Text>
            <Text size="md" style={{ lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {group.rules || (language === 'zh' ? '暂无规则' : 'No rules set')}
            </Text>
          </Box>

          <Box>
            <Text size="sm" weight="semibold" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
              {language === 'zh' ? '创建时间' : 'Created'}
            </Text>
            <Text size="md">
              {group.created_at
                ? new Date(group.created_at).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })
                : (language === 'zh' ? '未知' : 'Unknown')
              }
            </Text>
          </Box>

          <Box>
            <Text size="sm" weight="semibold" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
              {language === 'zh' ? '成员数' : 'Members'}
            </Text>
            <Text
              size="md"
              style={{ cursor: 'pointer', textDecoration: 'underline' }}
              onClick={() => {
                onClose()
                onShowMembers()
              }}
            >
              {group.member_count || 0} {language === 'zh' ? '位成员' : 'members'}
            </Text>
          </Box>
        </Box>

        <Box style={{ marginTop: tokens.spacing[6], textAlign: 'right' }}>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {language === 'zh' ? '关闭' : 'Close'}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}

interface MembersListModalProps {
  members: GroupMember[]
  memberCount: number
  loading: boolean
  language: string
  onClose: () => void
}

export function MembersListModal({ members, memberCount, loading, language, onClose }: MembersListModalProps) {
  return (
    <Box
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: tokens.zIndex.modal,
      }}
      onClick={onClose}
    >
      <Box
        style={{
          background: tokens.colors.bg.primary,
          borderRadius: tokens.radius.xl,
          padding: tokens.spacing[6],
          width: '90%',
          maxWidth: 400,
          maxHeight: '80vh',
          overflowY: 'auto',
          border: `1px solid ${tokens.colors.border.primary}`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
          <Text size="xl" weight="bold">
            {language === 'zh' ? '小组成员' : 'Members'} ({memberCount})
          </Text>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: 20,
              cursor: 'pointer',
              color: tokens.colors.text.tertiary,
            }}
          >
            ×
          </button>
        </Box>

        {loading ? (
          <ListSkeleton count={5} gap={8} />
        ) : members.length === 0 ? (
          <Text color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
            {language === 'zh' ? '暂无成员' : 'No members'}
          </Text>
        ) : (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
            {members.map((member) => (
              <Link
                key={member.user_id}
                href={`/u/${member.handle || member.user_id}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[3],
                  padding: tokens.spacing[2],
                  borderRadius: tokens.radius.md,
                  textDecoration: 'none',
                  color: tokens.colors.text.primary,
                  transition: `background ${tokens.transition.base}`,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = tokens.colors.bg.secondary
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <Box
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: '50%',
                    background: tokens.colors.bg.tertiary || tokens.colors.bg.secondary,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden',
                    flexShrink: 0,
                  }}
                >
                  {member.avatar_url ? (
                    <img
                      src={member.avatar_url}
                      alt={member.handle || 'User'}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      referrerPolicy="no-referrer"
                      onError={(e) => { e.currentTarget.style.display = 'none' }}
                    />
                  ) : (
                    <Text size="sm" color="tertiary">
                      {(member.handle || 'U').charAt(0).toUpperCase()}
                    </Text>
                  )}
                </Box>

                <Box style={{ flex: 1 }}>
                  <Text size="sm" weight="medium">
                    @{member.handle || 'Unknown'}
                  </Text>
                </Box>

                <span
                  style={{
                    fontSize: tokens.typography.fontSize.xs,
                    padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                    borderRadius: tokens.radius.full,
                    background: member.role === 'owner'
                      ? 'linear-gradient(135deg, #FFD700, #FFA500)'
                      : member.role === 'admin'
                        ? 'linear-gradient(135deg, #8b6fa8, #6b4f88)'
                        : tokens.colors.bg.tertiary || tokens.colors.bg.secondary,
                    color: member.role === 'owner' || member.role === 'admin'
                      ? '#fff'
                      : tokens.colors.text.secondary,
                    fontWeight: tokens.typography.fontWeight.semibold,
                  }}
                >
                  {member.role === 'owner'
                    ? (language === 'zh' ? '组长' : 'Owner')
                    : member.role === 'admin'
                      ? (language === 'zh' ? '管理员' : 'Admin')
                      : (language === 'zh' ? '成员' : 'Member')
                  }
                </span>
              </Link>
            ))}
          </Box>
        )}

        <Box style={{ marginTop: tokens.spacing[4], textAlign: 'right' }}>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {language === 'zh' ? '关闭' : 'Close'}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}
