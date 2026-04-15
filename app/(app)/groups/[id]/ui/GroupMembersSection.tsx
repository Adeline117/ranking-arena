'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useVirtualizer } from '@tanstack/react-virtual'
import { getLocaleFromLanguage } from '@/lib/utils/format'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { ListSkeleton } from '@/app/components/ui/Skeleton'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

/** Shared hook for modal behavior: scroll lock + Escape key */
function useModalBehavior(onClose: () => void) {
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => {
      document.body.style.overflow = ''
      window.removeEventListener('keydown', handler)
    }
  }, [onClose])
}

interface Group {
  id: string
  name: string
  name_en?: string | null
  description?: string | null
  description_en?: string | null
  member_count?: number | null
  created_at?: string | null
  rules?: string | null
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

// Shared modal backdrop styles
const modalBackdropStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: 'var(--color-backdrop)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: tokens.zIndex.modal,
}

// Shared close button component
function CloseButton({ onClick }: { onClick: () => void }): React.ReactElement {
  return (
    <button aria-label="Close"
      onClick={onClick}
      style={{
        background: 'transparent',
        border: 'none',
        fontSize: 20,
        cursor: 'pointer',
        color: tokens.colors.text.tertiary,
        width: 44,
        height: 44,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: tokens.radius.md,
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
        position: 'relative',
      }}
    >
      {avatarUrl ? (
        <Image src={avatarUrl} alt={handle || 'User'} fill sizes="36px" style={{ objectFit: 'cover' }} />
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
}

function RoleBadge({ role }: RoleBadgeProps): React.ReactElement {
  const { t } = useLanguage()
  const isOwner = role === 'owner'
  const isAdmin = role === 'admin'
  const isSpecial = isOwner || isAdmin

  const background = isOwner
    ? 'linear-gradient(135deg, #FFD700, #FFA500)'
    : isAdmin
      ? `linear-gradient(135deg, ${tokens.colors.accent.brand}, var(--color-brand-deep))`
      : tokens.colors.bg.tertiary || tokens.colors.bg.secondary

  const label = isOwner
    ? t('owner')
    : isAdmin
      ? t('admin')
      : t('groupMember')

  return (
    <span
      style={{
        fontSize: tokens.typography.fontSize.xs,
        padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
        borderRadius: tokens.radius.full,
        background,
        color: isSpecial ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
        fontWeight: tokens.typography.fontWeight.semibold,
      }}
    >
      {label}
    </span>
  )
}

export function GroupInfoModal({ group, language, onClose, onShowMembers }: GroupInfoModalProps): React.ReactElement {
  const { t } = useLanguage()
  useModalBehavior(onClose)
  const description = (language === 'en' && group.description_en) ? group.description_en : group.description
  // Use rules_json for bilingual rules, fallback to rules
  const rules = group.rules_json
    ? group.rules_json.map(r => language === 'en' ? r.en : r.zh).filter(Boolean).join('\n')
    : group.rules
  const createdDate = group.created_at
    ? new Date(group.created_at).toLocaleDateString(getLocaleFromLanguage(language), {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : t('unknown')

  return (
    <Box role="dialog" aria-modal="true" aria-label={t('groupInfo')} style={modalBackdropStyle} onClick={onClose}>
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
        <ModalHeader title={t('groupInfo')} onClose={onClose} />

        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          <InfoRow label={t('owner')}>
            <Text size="md">
              {group.owner_handle ? (
                <Link href={`/u/${encodeURIComponent(group.owner_handle)}`} style={{ color: tokens.colors.accent?.primary || tokens.colors.accent.brand, textDecoration: 'none' }}>
                  @{group.owner_handle}
                </Link>
              ) : t('none')}
            </Text>
          </InfoRow>

          <InfoRow label={t('groupDescription')}>
            <Text size="md" style={{ lineHeight: 1.6 }}>
              {description || t('noDescription')}
            </Text>
          </InfoRow>

          <InfoRow label={t('groupRules')}>
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
                {rules || t('noRulesSet')}
              </Text>
            )}
          </InfoRow>

          <InfoRow label={t('createdAt')}>
            <Text size="md">{createdDate}</Text>
          </InfoRow>

          <InfoRow label={t('memberCount')}>
            <Text
              size="md"
              style={{ cursor: 'pointer', textDecoration: 'underline' }}
              onClick={() => { onClose(); onShowMembers() }}
            >
              {group.member_count || 0} {t('membersUnit')}
            </Text>
          </InfoRow>
        </Box>

        <Box style={{ marginTop: tokens.spacing[6], textAlign: 'right' }}>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('close')}
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
}

function MemberRow({ member }: MemberRowProps): React.ReactElement {
  return (
    <Link
      href={`/u/${encodeURIComponent(member.handle || member.user_id)}`}
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
      <RoleBadge role={member.role} />
    </Link>
  )
}

// Virtualized member list for large groups (>20 members)
const MEMBER_ROW_HEIGHT = 52 // px, matches padding + avatar size
const VIRTUALIZE_THRESHOLD = 20

function VirtualizedMemberList({ members }: { members: GroupMember[] }): React.ReactElement {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: members.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => MEMBER_ROW_HEIGHT,
    overscan: 10,
  })

  return (
    <div
      ref={parentRef}
      style={{
        maxHeight: 400,
        overflow: 'auto',
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map(virtualItem => (
          <div
            key={members[virtualItem.index].user_id}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualItem.start}px)`,
            }}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
          >
            <MemberRow member={members[virtualItem.index]} />
          </div>
        ))}
      </div>
    </div>
  )
}

export function MembersListModal({ members, memberCount, loading, language: _language, onClose }: MembersListModalProps): React.ReactElement {
  const { t } = useLanguage()
  useModalBehavior(onClose)
  const title = `${t('groupMembers')} (${memberCount})`

  function renderContent(): React.ReactElement {
    if (loading) {
      return <ListSkeleton count={5} gap={8} />
    }
    if (members.length === 0) {
      return (
        <Text color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
          {t('noMembersData')}
        </Text>
      )
    }
    // Use virtualization for large lists, simple render for small ones
    if (members.length > VIRTUALIZE_THRESHOLD) {
      return <VirtualizedMemberList members={members} />
    }
    return (
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
        {members.map((member) => (
          <MemberRow key={member.user_id} member={member} />
        ))}
      </Box>
    )
  }

  return (
    <Box role="dialog" aria-modal="true" aria-label={title} style={modalBackdropStyle} onClick={onClose}>
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
            {t('close')}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}
