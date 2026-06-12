'use client'

import { useEffect, useState, memo } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import SidebarCard from './SidebarCard'
import { useLanguage } from '../Providers/LanguageProvider'
import { apiFetch } from '@/lib/utils/api-fetch'

interface Hashtag {
  id: string
  tag: string
  post_count: number
}

export default memo(function TrendingHashtags() {
  const { t } = useLanguage()
  const [hashtags, setHashtags] = useState<Hashtag[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const data = await apiFetch<{ data?: { hashtags?: Hashtag[] } }>('/api/hashtags/trending')
        if (data.data?.hashtags) {
          setHashtags(data.data.hashtags.slice(0, 10))
        }
      } catch {
        // Intentionally swallowed: trending hashtags are non-critical sidebar content
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  if (loading || hashtags.length === 0) return null

  return (
    <SidebarCard title={t('trendingHashtags')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1.5] }}>
        {hashtags.map((h, i) => (
          <Link
            key={h.id}
            href={`/hashtag/${encodeURIComponent(h.tag)}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
              borderRadius: tokens.radius.md,
              textDecoration: 'none',
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.sm,
            }}
            className="hover-bg"
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              <span
                style={{
                  color: tokens.colors.text.tertiary,
                  fontSize: tokens.typography.fontSize.xs,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  minWidth: 16,
                }}
              >
                {i + 1}
              </span>
              <span
                style={{
                  color: 'var(--color-brand)',
                  fontWeight: tokens.typography.fontWeight.semibold,
                }}
              >
                #{h.tag}
              </span>
            </span>
            <span
              style={{
                fontSize: tokens.typography.fontSize.xs,
                color: tokens.colors.text.tertiary,
                background: tokens.colors.bg.tertiary,
                padding: `1px ${tokens.spacing[1.5]}`,
                borderRadius: tokens.radius.full,
              }}
            >
              {h.post_count}
            </span>
          </Link>
        ))}
      </div>
    </SidebarCard>
  )
})
