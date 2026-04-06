'use client'

import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'

const ARENA_PURPLE = tokens.colors.accent.brand

interface HotGroup {
  id: string
  name: string
  name_en?: string | null
  member_count: number
}

interface HotGroupsListProps {
  groups: HotGroup[]
  loading: boolean
  error?: boolean
  onRetry?: () => void
  localizedName: (zh: string, en?: string | null) => string
  t: (key: string) => string
}

export function HotGroupsList({ groups, loading, error, onRetry, localizedName, t }: HotGroupsListProps) {
  const router = useRouter()

  if (loading) {
    return (
      <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
        <Text color="tertiary">{t('loading')}</Text>
      </Box>
    )
  }

  if (error) {
    return (
      <Box style={{ padding: '48px 24px', textAlign: 'center' }}>
        <Text color="tertiary" style={{ marginBottom: 12 }}>{t('loadFailed')}</Text>
        {onRetry && (
          <button onClick={onRetry} style={{ color: tokens.colors.accent.primary, cursor: 'pointer', background: 'none', border: 'none', textDecoration: 'underline', fontSize: 14 }}>{t('retry')}</button>
        )}
      </Box>
    )
  }

  if (groups.length === 0) {
    return (
      <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
        <Text color="tertiary">{t('noData')}</Text>
      </Box>
    )
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      {groups.map((group, idx) => (
        <Box
          key={group.id}
          style={{
            padding: '12px 16px',
            borderRadius: tokens.radius.lg,
            background: 'var(--color-bg-secondary)',
            border: `1px solid var(--color-border-primary)`,
            boxShadow: 'none',
            cursor: 'pointer',
            transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
          onClick={() => router.push(`/groups/${group.id}`)}
          onMouseEnter={(e) => {
            e.currentTarget.style.boxShadow = `0 4px 16px var(--color-accent-primary-12)`
            e.currentTarget.style.borderColor = `${ARENA_PURPLE}40`
            e.currentTarget.style.transform = 'translateY(-1px)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.boxShadow = 'none'
            e.currentTarget.style.borderColor = 'var(--color-border-primary)'
            e.currentTarget.style.transform = 'translateY(0)'
          }}
        >
          <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              <Text size="sm" weight="black" style={{ color: idx < 3 ? 'var(--color-accent-warning)' : 'var(--color-text-secondary)' }}>
                #{idx + 1}
              </Text>
              <Text size="base" weight="bold">
                {localizedName(group.name, group.name_en)}
              </Text>
            </Box>
            <Text size="xs" color="tertiary">
              {group.member_count.toLocaleString('en-US')} {t('membersUnit')}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}
