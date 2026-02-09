'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import Card from '@/app/components/ui/Card'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

type Group = {
  id: string
  name: string
  name_en?: string | null
  avatar_url?: string | null
  member_count?: number | null
  role?: string
}

type JoinedGroupsProps = {
  userId: string
  expanded?: boolean
}

export default function JoinedGroups({ userId }: JoinedGroupsProps) {
  const { language, t } = useLanguage()
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!userId) {
      setLoading(false)
      return
    }

    const load = async () => {
      try {
        // Get groups the user has joined through group_members table
        const { data: memberData, error: memberError } = await supabase
          .from('group_members')
          .select('group_id, role')
          .eq('user_id', userId)
          .is('deleted_at', null)

        if (memberError) {
          setLoading(false)
          return
        }

        if (!memberData || memberData.length === 0) {
          setGroups([])
          setLoading(false)
          return
        }

        const groupIds = memberData.map(m => m.group_id)
        const roleMap = new Map(memberData.map(m => [m.group_id, m.role]))

        // Get group details
        const { data: groupsData, error: groupsError } = await supabase
          .from('groups')
          .select('id, name, name_en, avatar_url, member_count')
          .in('id', groupIds)
          .order('member_count', { ascending: false })

        if (groupsError) {
          // intentionally empty
        }

        const groupsWithRole = (groupsData || []).map(g => ({
          ...g,
          role: roleMap.get(g.id) || 'member'
        }))

        setGroups(groupsWithRole)
      } catch (err) {
        logger.error('Error:', err)
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [userId])

  if (loading) {
    return null
  }

  if (groups.length === 0) {
    return null
  }

  const getRoleBadge = (role: string) => {
    if (role === 'owner') {
      return {
        label: t('owner'),
        bg: tokens.colors.accent?.warning,
        color: '#000'
      }
    }
    if (role === 'admin') {
      return {
        label: t('admin'),
        bg: tokens.colors.accent?.primary,
        color: tokens.colors.white
      }
    }
    return null
  }

  return (
    <Card title={t('joinedGroups')}>
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
        {groups.map((group) => {
          const badge = getRoleBadge(group.role || 'member')
          return (
            <Link
              key={group.id}
              href={`/groups/${group.id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[3],
                padding: tokens.spacing[2],
                borderRadius: tokens.radius.md,
                textDecoration: 'none',
                color: tokens.colors.text.primary,
                transition: `all ${tokens.transition.base}`,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = tokens.colors.bg.secondary
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
              }}
            >
              {/* Avatar */}
              <Box
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: tokens.radius.md,
                  background: tokens.colors.bg.tertiary || tokens.colors.bg.primary,
                  border: `1px solid ${tokens.colors.border.primary}`,
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
                    width={32}
                    height={32}
                    loading="lazy"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                ) : (
                  <Text size="sm" weight="bold" color="tertiary">
                    {group.name.charAt(0).toUpperCase()}
                  </Text>
                )}
              </Box>

              {/* Info */}
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" weight="semibold" style={{ marginBottom: 2 }}>
                  {language === 'en' && group.name_en ? group.name_en : group.name}
                </Text>
                {group.member_count != null && (
                  <Text size="xs" color="tertiary">
                    {group.member_count} {t('members')}
                  </Text>
                )}
              </Box>

              {/* Role badge */}
              {badge && (
                <Box
                  style={{
                    padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                    borderRadius: tokens.radius.sm,
                    background: badge.bg,
                    fontSize: tokens.typography.fontSize.xs,
                    fontWeight: tokens.typography.fontWeight.bold,
                    color: badge.color,
                  }}
                >
                  {badge.label}
                </Box>
              )}
            </Link>
          )
        })}
      </Box>
    </Card>
  )
}
