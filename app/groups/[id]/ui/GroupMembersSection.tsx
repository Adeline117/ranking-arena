'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { ListSkeleton } from '@/app/components/ui/Skeleton'

interface Group {
  id: string
  name: string
  name_en?: string | null
  description?: string | null
  description_en?: string | null
  member_count?: number | null
  created_at?: string | null
  rules?: string | null
  rules_en?: string | null
  rules_json?: Array<{ zh: string; en: string }> | null
  owner_handle?: string | null
}

interface GroupMember {
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

// Shared bilingual text helper
function t(zh: string, en: string, language: string): string {
  return language === 'zh' ? zh : en
}

// Shared modal backdrop styles
const modalBackdropStyle: React.CSSProperties = {
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
}

// Shared close button component
function CloseButton({ onClick }: { onClick: () => void }): React.ReactElement {
  return (
    <button
      onClick={onClick}
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
  )
}

// Shared modal header component
interface ModalHeaderProps {
  title: string
  onClose: () => void
}

function ModalHeader({ title, onClose }: ModalHeaderProps): React.ReactElement {
  return (
    <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
      <Text size="xl" weight="bold">{title}</Text>
      <CloseButton onClick={onClose} />
    </Box>
  )
}

// Info row component for consistent styling
interface InfoRowProps {
  label: string
  children: React.ReactNode
}

function InfoRow({ label, children }: InfoRowProps): React.ReactElement {
  return (
    <Box>
      <Text size="sm" weight="semibold" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
        {label}
      </Text>
      {children}
    </Box>
  )
}

// Member avatar component
interface MemberAvatarProps {
  avatarUrl?: string | null
  handle?: string | null
  size?: number
}

function MemberAvatar({ avatarUrl, handle, size = 36 }: MemberAvatarProps): React.ReactElement {
  return (
    <Box
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: tokens.colors.bg.tertiary || tokens.colors.bg.secondary,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt={handle || 'User'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <Text size="sm" color="tertiary">
          {(handle || 'U').charAt(0).toUpperCase()}
        </Text>
      )}
    </Box>
  )
}

// Role badge component
interface RoleBadgeProps {
  role: string
  language: string
}

function RoleBadge({ role, language }: RoleBadgeProps): React.ReactElement {
  const isOwner = role === 'owner'
  const isAdmin = role === 'admin'
  const isSpecial = isOwner || isAdmin

  const background = isOwner
    ? 'linear-gradient(135deg, #FFD700, #FFA500)'
    : isAdmin
      ? 'linear-gradient(135deg, #8b6fa8, #6b4f88)'
      : tokens.colors.bg.tertiary || tokens.colors.bg.secondary

  const label = isOwner
    ? t('组长', 'Owner', language)
    : isAdmin
      ? t('管理员', 'Admin', language)
      : t('成员', 'Member', language)

  return (
    <span
      style={{
        fontSize: tokens.typography.fontSize.xs,
        padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
        borderRadius: tokens.radius.full,
        background,
        color: isSpecial ? '#fff' : tokens.colors.text.secondary,
        fontWeight: tokens.typography.fontWeight.semibold,
      }}
    >
      {label}
    </span>
  )
}

export function GroupInfoModal({ group, language, onClose, onShowMembers }: GroupInfoModalProps): React.ReactElement {
  const description = (language === 'en' && group.description_en) ? group.description_en : group.description
  const rules = (language === 'en' && group.rules_en) ? group.rules_en : group.rules
  const createdDate = group.created_at
    ? new Date(group.created_at).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : t('未知', 'Unknown', language)

  return (
    <Box style={modalBackdropStyle} onClick={onClose}>
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
        <ModalHeader title={t('小组信息', 'Group Info', language)} onClose={onClose} />

        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          <InfoRow label={t('组长', 'Owner', language)}>
            <Text size="md">
              {group.owner_handle ? (
                <Link href={`/u/${group.owner_handle}`} style={{ color: tokens.colors.accent?.primary || '#8b6fa8', textDecoration: 'none' }}>
                  @{group.owner_handle}
                </Link>
              ) : t('暂无', 'None', language)}
            </Text>
          </InfoRow>

          <InfoRow label={t('小组简介', 'Description', language)}>
            <Text size="md" style={{ lineHeight: 1.6 }}>
              {description || t('暂无简介', 'No description', language)}
            </Text>
          </InfoRow>

          <InfoRow label={t('发言规则', 'Rules', language)}>
            {group.rules_json && group.rules_json.length > 0 ? (
              <Box as="ol" style={{ paddingLeft: tokens.spacing[4], margin: 0 }}>
                {group.rules_json.map((rule, index) => (
                  <Box as="li" key={index} style={{ marginBottom: tokens.spacing[1] }}>
                    <Text size="md" style={{ lineHeight: 1.6 }}>
                      {(language === 'en' && rule.en) ? rule.en : rule.zh}
                    </Text>
                  </Box>
                ))}
              </Box>
            ) : (
              <Text size="md" style={{ lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {rules || t('暂无规则', 'No rules set', language)}
              </Text>
            )}
          </InfoRow>

          <InfoRow label={t('创建时间', 'Created', language)}>
            <Text size="md">{createdDate}</Text>
          </InfoRow>

          <InfoRow label={t('成员数', 'Members', language)}>
            <Text
              size="md"
              style={{ cursor: 'pointer', textDecoration: 'underline' }}
              onClick={() => { onClose(); onShowMembers() }}
            >
              {group.member_count || 0} {t('位成员', 'members', language)}
            </Text>
          </InfoRow>
        </Box>

        <Box style={{ marginTop: tokens.spacing[6], textAlign: 'right' }}>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('关闭', 'Close', language)}
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

// Member row component
interface MemberRowProps {
  member: GroupMember
  language: string
}

function MemberRow({ member, language }: MemberRowProps): React.ReactElement {
  return (
    <Link
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
      onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.secondary }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      <MemberAvatar avatarUrl={member.avatar_url} handle={member.handle} />
      <Box style={{ flex: 1 }}>
        <Text size="sm" weight="medium">@{member.handle || 'Unknown'}</Text>
      </Box>
      <RoleBadge role={member.role} language={language} />
    </Link>
  )
}

export function MembersListModal({ members, memberCount, loading, language, onClose }: MembersListModalProps): React.ReactElement {
  const title = `${t('小组成员', 'Members', language)} (${memberCount})`

  function renderContent(): React.ReactElement {
    if (loading) {
      return <ListSkeleton count={5} gap={8} />
    }
    if (members.length === 0) {
      return (
        <Text color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
          {t('暂无成员', 'No members', language)}
        </Text>
      )
    }
    return (
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
        {members.map((member) => (
          <MemberRow key={member.user_id} member={member} language={language} />
        ))}
      </Box>
    )
  }

  return (
    <Box style={modalBackdropStyle} onClick={onClose}>
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
        <ModalHeader title={title} onClose={onClose} />
        {renderContent()}
        <Box style={{ marginTop: tokens.spacing[4], textAlign: 'right' }}>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('关闭', 'Close', language)}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}
