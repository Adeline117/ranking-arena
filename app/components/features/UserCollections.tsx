'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { getCsrfHeaders } from '@/lib/api/client'
import { logger } from '@/lib/logger'

interface Collection {
  id: string
  name: string
  description?: string | null
  is_public: boolean
  item_count: number
  created_at: string
}

interface UserCollectionsProps {
  /** If provided, show public collections for this user handle */
  userHandle?: string
  /** If true, show own collections with management */
  isOwnProfile?: boolean
}

const COLORS = [
  'var(--color-accent-error)',
  'var(--color-chart-teal)',
  'var(--color-chart-blue)',
  'var(--color-chart-sage)',
  'var(--color-chart-yellow)',
  'var(--color-chart-pink)',
  'var(--color-chart-mint)',
]

function getColor(name: string) {
  return COLORS[name.charCodeAt(0) % COLORS.length]
}

export default function UserCollections({ userHandle, isOwnProfile }: UserCollectionsProps) {
  const { accessToken } = useAuthSession()
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const isZh = language === 'zh'

  const [collections, setCollections] = useState<Collection[]>([])
  const [loading, setLoading] = useState(true)

  const fetchCollections = useCallback(async () => {
    try {
      const url = isOwnProfile
        ? '/api/collections'
        : `/api/users/${encodeURIComponent(userHandle!)}/collections`
      const headers: Record<string, string> = {}
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`

      const res = await fetch(url, { headers })
      const data = await res.json()
      if (res.ok) {
        setCollections(data.data?.collections || [])
      }
    } catch (err) {
      logger.error('Failed to load collections', err)
    } finally {
      setLoading(false)
    }
  }, [isOwnProfile, userHandle, accessToken])

  useEffect(() => {
    if (isOwnProfile && !accessToken) {
      setLoading(false)
      return
    }
    if (!isOwnProfile && !userHandle) {
      setLoading(false)
      return
    }
    fetchCollections()
  }, [fetchCollections, isOwnProfile, accessToken, userHandle])

  if (loading) {
    return (
      <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: tokens.spacing[3] }}>
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="skeleton" style={{ height: 120, borderRadius: tokens.radius.lg }} />
        ))}
      </Box>
    )
  }

  if (collections.length === 0) {
    return (
      <Box style={{ padding: tokens.spacing[6], textAlign: 'center' }}>
        <Text size="sm" color="tertiary">
          {isOwnProfile
            ? (isZh ? '还没有收藏夹，去发现内容吧！' : 'No collections yet. Start exploring!')
            : (isZh ? '暂无公开收藏夹' : 'No public collections')}
        </Text>
      </Box>
    )
  }

  return (
    <Box>
      {isOwnProfile && (
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[3] }}>
          <Text size="lg" weight="bold">
            {isZh ? '我的收藏夹' : 'My Collections'}
          </Text>
        </Box>
      )}
      <Box style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
        gap: tokens.spacing[3],
      }}>
        {collections.map((col) => (
          <Link
            key={col.id}
            href={`/api/collections/${col.id}`}
            onClick={(e) => {
              // For now just show a toast with items - will navigate to detail page
              e.preventDefault()
              showToast(`${col.name}: ${col.item_count} items`, 'info')
            }}
            style={{ textDecoration: 'none', color: 'inherit' }}
          >
            <Box
              style={{
                padding: tokens.spacing[4],
                borderRadius: tokens.radius.lg,
                background: tokens.colors.bg.secondary,
                border: `1px solid ${tokens.colors.border.primary}`,
                transition: `all ${tokens.transition.base}`,
                cursor: 'pointer',
                minHeight: 120,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = tokens.colors.border.secondary || tokens.colors.border.primary
                ;(e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = tokens.colors.border.primary
                ;(e.currentTarget as HTMLElement).style.transform = 'translateY(0)'
              }}
            >
              {/* Icon */}
              <Box
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: tokens.radius.md,
                  background: getColor(col.name),
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: tokens.spacing[3],
                }}
              >
                <Text size="lg" weight="bold" style={{ color: tokens.colors.white }}>
                  {col.name.charAt(0).toUpperCase()}
                </Text>
              </Box>

              {/* Info */}
              <Box>
                <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], marginBottom: 4 }}>
                  <Text size="sm" weight="bold" style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {col.name}
                  </Text>
                  {col.is_public && (
                    <span style={{
                      fontSize: 9,
                      padding: '1px 4px',
                      background: tokens.colors.accent.success + '20',
                      color: tokens.colors.accent.success,
                      borderRadius: tokens.radius.sm,
                    }}>
                      {isZh ? '公开' : 'Public'}
                    </span>
                  )}
                </Box>
                <Text size="xs" color="tertiary">
                  {col.item_count} {isZh ? '项' : 'items'}
                </Text>
              </Box>
            </Box>
          </Link>
        ))}
      </Box>
    </Box>
  )
}
