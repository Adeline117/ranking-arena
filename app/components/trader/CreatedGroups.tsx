'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import Card from '@/app/components/ui/Card'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

type Group = {
  id: string
  name: string
  name_en?: string | null
  avatar_url?: string | null
  member_count?: number | null
}

type CreatedGroupsProps = {
  userId: string
}

export default function CreatedGroups({ userId }: CreatedGroupsProps) {
  const { language } = useLanguage()
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!userId) {
      setLoading(false)
      return
    }

    const load = async () => {
      try {
        const { data, error } = await supabase
          .from('groups')
          .select('id, name, name_en, avatar_url, member_count')
          .eq('created_by', userId)
          .order('created_at', { ascending: false })

        if (error) {
          console.error('Error loading created groups:', error)
        }
        setGroups(data || [])
      } catch (err) {
        console.error('Error:', err)
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

  return (
    <Card title={language === 'zh' ? '创办的小组' : 'Created Groups'}>
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
        {groups.map((group) => (
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
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
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
                  {group.member_count} {language === 'zh' ? '成员' : 'members'}
                </Text>
              )}
            </Box>

            {/* 组长标识 */}
            <Box
              style={{
                padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                borderRadius: tokens.radius.sm,
                background: tokens.colors.accent?.warning || '#FFB020',
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: tokens.typography.fontWeight.bold,
                color: '#000',
              }}
            >
              {language === 'zh' ? '组长' : 'Owner'}
            </Box>
          </Link>
        ))}
      </Box>
    </Card>
  )
}
