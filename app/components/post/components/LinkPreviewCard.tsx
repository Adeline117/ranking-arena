'use client'

/**
 * Link Preview Card (like Slack/Discord/Mastodon)
 * Fetches OG metadata from /api/posts/link-preview and renders a card.
 * Graceful degradation: shows nothing on error (link is already rendered as <a>).
 */

import { useState, useEffect, memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../base'

interface LinkPreviewData {
  title?: string
  description?: string
  image?: string
  siteName?: string
  url: string
}

// Module-level cache to avoid duplicate fetches across renders
const previewCache = new Map<string, LinkPreviewData | null>()

export const LinkPreviewCard = memo(function LinkPreviewCard({ url }: { url: string }) {
  const [data, setData] = useState<LinkPreviewData | null>(previewCache.get(url) ?? null)
  const [loading, setLoading] = useState(!previewCache.has(url))

  useEffect(() => {
    if (previewCache.has(url)) {
      setData(previewCache.get(url) ?? null)
      setLoading(false)
      return
    }

    let alive = true
    const controller = new AbortController()

    fetch(`/api/posts/link-preview?url=${encodeURIComponent(url)}`, {
      signal: controller.signal,
    })
      .then(r => r.ok ? r.json() : null)
      .then(json => {
        if (!alive) return
        const preview = json?.data ? { ...json.data, url } : null
        previewCache.set(url, preview)
        setData(preview)
      })
      .catch(() => {
        if (alive) previewCache.set(url, null)
      })
      .finally(() => { if (alive) setLoading(false) })

    return () => { alive = false; controller.abort() }
  }, [url])

  if (loading) {
    return (
      <Box style={{
        marginTop: tokens.spacing[2],
        height: 72,
        borderRadius: tokens.radius.lg,
        background: tokens.colors.bg.tertiary,
        animation: 'shimmer 1.5s ease-in-out infinite',
        backgroundImage: `linear-gradient(90deg, ${tokens.colors.bg.tertiary} 0%, var(--glass-bg-light) 50%, ${tokens.colors.bg.tertiary} 100%)`,
        backgroundSize: '200% 100%',
      }} />
    )
  }

  if (!data || !data.title) return null

  const domain = (() => {
    try { return new URL(url).hostname.replace('www.', '') } catch { return url }
  })()

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      style={{ textDecoration: 'none', display: 'block', marginTop: tokens.spacing[2] }}
    >
      <Box
        className="glass-card-hover"
        style={{
          display: 'flex',
          overflow: 'hidden',
          borderRadius: tokens.radius.lg,
          border: `1px solid ${tokens.colors.border.primary}`,
          background: tokens.colors.bg.tertiary,
          maxHeight: 120,
        }}
      >
        {/* Image */}
        {data.image && (
          <div style={{
            width: 120,
            minHeight: 72,
            flexShrink: 0,
            background: tokens.colors.bg.secondary,
            overflow: 'hidden',
          }}>
            <img
              src={data.image}
              alt={data.title || 'Link preview'}
              loading="lazy"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          </div>
        )}

        {/* Content */}
        <Box style={{
          padding: tokens.spacing[3],
          display: 'flex',
          flexDirection: 'column',
          gap: tokens.spacing[1],
          minWidth: 0,
          flex: 1,
        }}>
          <Text size="xs" style={{
            color: tokens.colors.text.tertiary,
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
          }}>
            {data.siteName || domain}
          </Text>
          <Text size="sm" weight="bold" style={{
            color: tokens.colors.text.primary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {data.title}
          </Text>
          {data.description && (
            <Text size="xs" style={{
              color: tokens.colors.text.secondary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              lineHeight: 1.4,
            }}>
              {data.description}
            </Text>
          )}
        </Box>
      </Box>
    </a>
  )
})
