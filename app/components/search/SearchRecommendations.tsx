'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

interface Recommendation {
  type: 'trader' | 'post' | 'user'
  id: string
  title: string
  subtitle: string
  reason: 'trending' | 'similar' | 'following'
  url: string
  [key: string]: any
}

interface SearchRecommendationsProps {
  userId?: string
  basedOn?: string
  type?: 'all' | 'trending' | 'similar' | 'following'
  limit?: number
}

export default function SearchRecommendations({
  userId,
  basedOn,
  type = 'all',
  limit = 10,
}: SearchRecommendationsProps) {
  const router = useRouter()
  const { t } = useLanguage()
  const [recommendations, setRecommendations] = useState<Recommendation[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadRecommendations()
  }, [userId, basedOn, type, limit])

  const loadRecommendations = async () => {
    try {
      setLoading(true)

      const params = new URLSearchParams({
        type,
        limit: limit.toString(),
      })

      if (userId) params.append('userId', userId)
      if (basedOn) params.append('basedOn', basedOn)

      const response = await fetch(`/api/search/recommend?${params}`)

      if (!response.ok) {
        throw new Error('Failed to load recommendations')
      }

      const data = await response.json()

      if (data.success) {
        setRecommendations(data.data.recommendations || [])
      }
    } catch (error) {
      console.error('Load recommendations error:', error)
      setRecommendations([])
    } finally {
      setLoading(false)
    }
  }

  const getReasonLabel = (reason: string) => {
    switch (reason) {
      case 'trending':
        return '🔥 Trending'
      case 'similar':
        return '✨ Similar'
      case 'following':
        return '👥 Following'
      default:
        return ''
    }
  }

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'trader':
        return '👤'
      case 'post':
        return '📝'
      case 'user':
        return '🙋'
      default:
        return '📌'
    }
  }

  if (loading) {
    return (
      <Box style={{ padding: tokens.spacing[4] }}>
        <Text size="sm" color="tertiary">
          {t('loadingRecommendations') || 'Loading recommendations...'}
        </Text>
      </Box>
    )
  }

  if (recommendations.length === 0) {
    return null
  }

  return (
    <Box
      style={{
        padding: tokens.spacing[4],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
        {t('recommendedForYou') || 'Recommended for You'}
      </Text>

      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
        {recommendations.map((rec, idx) => (
          <button
            key={`${rec.type}-${rec.id}-${idx}`}
            onClick={() => router.push(rec.url)}
            style={{
              width: '100%',
              padding: tokens.spacing[3],
              background: tokens.colors.bg.tertiary,
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.md,
              textAlign: 'left',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = tokens.colors.bg.hover
              e.currentTarget.style.borderColor = tokens.colors.accent.primary
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = tokens.colors.bg.tertiary
              e.currentTarget.style.borderColor = tokens.colors.border.primary
            }}
          >
            <Box style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.spacing[2] }}>
              {/* Icon */}
              <Box
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: tokens.radius.full,
                  background: tokens.colors.bg.secondary,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '16px',
                  flexShrink: 0,
                }}
              >
                {getTypeIcon(rec.type)}
              </Box>

              {/* Content */}
              <Box style={{ flex: 1, minWidth: 0 }}>
                {/* Title */}
                <Text
                  size="sm"
                  weight="bold"
                  style={{
                    color: tokens.colors.text.primary,
                    marginBottom: tokens.spacing[1],
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {rec.title}
                </Text>

                {/* Subtitle */}
                <Text
                  size="xs"
                  color="secondary"
                  style={{
                    marginBottom: tokens.spacing[1],
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {rec.subtitle}
                </Text>

                {/* Reason Badge */}
                <Box
                  style={{
                    display: 'inline-block',
                    padding: `2px ${tokens.spacing[2]}`,
                    background: `${tokens.colors.accent.primary}20`,
                    borderRadius: tokens.radius.full,
                  }}
                >
                  <Text size="xs" style={{ color: tokens.colors.accent.primary, fontWeight: 600 }}>
                    {getReasonLabel(rec.reason)}
                  </Text>
                </Box>
              </Box>

              {/* Arrow */}
              <Box style={{ color: tokens.colors.text.tertiary, flexShrink: 0 }}>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </Box>
            </Box>
          </button>
        ))}
      </Box>
    </Box>
  )
}
