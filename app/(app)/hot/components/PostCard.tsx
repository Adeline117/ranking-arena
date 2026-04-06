'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { CommentIcon, ThumbsUpIcon } from '@/app/components/ui/icons'
import { renderContentWithLinks } from '@/lib/utils/content'
import type { Post } from '../types'

const ARENA_PURPLE = tokens.colors.accent.brand

interface PostCardProps {
  post: Post
  rank: number
  hotTag: { label: string; color: string } | null
  translatedTitle?: string
  translatedBody?: string
  isExpanded: boolean
  onToggleExpand: () => void
  onOpenPost: (post: Post) => void
  localizedName: (zh: string, en?: string | null) => string
  t: (key: string) => string
}

export function PostCard({
  post: p, rank, hotTag, translatedTitle, translatedBody,
  isExpanded, onToggleExpand, onOpenPost, localizedName, t,
}: PostCardProps) {
  const displayBody = translatedBody || p.body
  const isLongContent = displayBody.length > 100
  const contentToShow = isExpanded || !isLongContent
    ? displayBody
    : displayBody.slice(0, 100) + '...'

  return (
    <Box
      className="hot-post-item"
      style={{
        cursor: 'pointer',
        padding: '14px 16px',
        borderRadius: tokens.radius.lg,
        background: 'var(--color-bg-secondary)',
        border: `1px solid var(--color-border-primary)`,
        boxShadow: 'none',
        transition: `all 0.2s cubic-bezier(0.4, 0, 0.2, 1)`,
      }}
      onClick={(e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest('a, button, [role="button"], input, textarea, select')) return
        onOpenPost(p)
      }}
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
      {/* Top row: rank + badges + group */}
      <Box className="hot-post-meta" style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[1], flexWrap: 'wrap', alignItems: 'center' }}>
        <Text className="hot-post-rank" size="sm" weight="black" style={{
          color: rank <= 3 ? 'var(--color-accent-warning)' : 'var(--color-text-tertiary)',
          fontSize: rank <= 3 ? '15px' : '13px',
          minWidth: 28,
        }}>
          #{rank}
        </Text>
        {hotTag && (
          <span style={{
            fontSize: 11,
            fontWeight: 800,
            color: tokens.colors.white,
            background: hotTag.color,
            padding: '2px 8px',
            borderRadius: tokens.radius.full,
            lineHeight: '16px',
            letterSpacing: '0.5px',
            textTransform: 'uppercase',
          }}>
            {hotTag.label}
          </span>
        )}
        {p.group_id ? (
          <Link
            href={`/groups/${p.group_id}`}
            onClick={(e) => e.stopPropagation()}
            style={{
              fontSize: tokens.typography.fontSize.xs,
              color: ARENA_PURPLE,
              textDecoration: 'none',
              padding: '2px 10px',
              background: `${ARENA_PURPLE}12`,
              borderRadius: tokens.radius.full,
              fontWeight: 600,
              transition: 'background 0.15s ease',
            }}
          >
            {localizedName(p.group, p.group_en)}
          </Link>
        ) : (
          <Text size="xs" color="secondary" style={{ padding: '2px 10px', background: `var(--color-text-tertiary-10)`, borderRadius: 999 }}>
            {localizedName(p.group, p.group_en)}
          </Text>
        )}
      </Box>

      {/* Title */}
      <Link
        href={`/post/${p.id}`}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onOpenPost(p)
        }}
        style={{ textDecoration: 'none', color: 'inherit' }}
      >
        <Text className="hot-post-title" size="base" weight="bold" style={{
          marginBottom: tokens.spacing[1],
          lineHeight: 1.4,
          fontSize: '14px',
          cursor: 'pointer',
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {translatedTitle || (p.title && p.title !== 'Untitled' && p.title !== 'untitled' ? p.title : (p.body?.slice(0, 80) || ''))}
          {translatedTitle && (
            <span style={{
              fontSize: 11, fontWeight: 500, marginLeft: 6,
              padding: '1px 6px', borderRadius: tokens.radius.sm,
              background: `${'var(--color-text-tertiary)'}15`,
              color: 'var(--color-text-tertiary)',
              verticalAlign: 'middle',
            }}>
              {t('hotTranslatedBadge')}
            </span>
          )}
        </Text>
      </Link>

      {/* Body preview */}
      <Text className="hot-post-body" size="sm" color="secondary" style={{
        marginBottom: tokens.spacing[1],
        lineHeight: 1.5,
        fontSize: '12px',
        color: translatedBody ? 'var(--color-text-tertiary)' : 'var(--color-text-secondary)',
      }}>
        {renderContentWithLinks(contentToShow)}
      </Text>
      {isLongContent && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand()
          }}
          style={{
            background: 'transparent',
            border: 'none',
            color: ARENA_PURPLE,
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 600,
            marginBottom: tokens.spacing[2],
            padding: 0,
          }}
        >
          {isExpanded ? t('showLess') : t('showMore')}
        </button>
      )}

      {/* Footer: author, time, stats */}
      <Box className="hot-post-footer" style={{
        display: 'flex',
        gap: tokens.spacing[2],
        fontSize: '12px',
        color: 'var(--color-text-tertiary)',
        flexWrap: 'wrap',
        alignItems: 'center',
        marginTop: tokens.spacing[1],
        paddingTop: tokens.spacing[1],
        borderTop: 'none',
      }}>
        {p.author_handle ? (
          <Link
            href={`/u/${encodeURIComponent(p.author_handle)}`}
            onClick={(e) => e.stopPropagation()}
            style={{
              fontSize: tokens.typography.fontSize.xs,
              color: 'var(--color-text-secondary)',
              textDecoration: 'none',
              fontWeight: 700,
            }}
          >
            @{p.author}
          </Link>
        ) : (
          <Text size="xs" color="tertiary">{p.author}</Text>
        )}
        <Text size="xs" color="tertiary">{p.time}</Text>
        {p.comments > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--color-text-tertiary)' }}>
            <CommentIcon size={12} /> {p.comments}
          </span>
        )}
        {p.likes > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--color-text-tertiary)' }}>
            <ThumbsUpIcon size={12} /> {p.likes}
          </span>
        )}
        {(p.views ?? 0) > 0 && (
          <Text size="xs" color="tertiary" style={{ marginLeft: 'auto' }}>
            {(p.views ?? 0).toLocaleString('en-US')} {t('views')}
          </Text>
        )}
      </Box>
    </Box>
  )
}
