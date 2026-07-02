'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import ModalOverlay from '@/app/components/ui/ModalOverlay'
import { Box, Text } from '@/app/components/base'
import { formatTimeAgo } from '@/lib/utils/date'
import { getLanguage } from '@/lib/i18n'

interface BookmarkedPost {
  id: string
  title: string
  content: string | null
  author_handle: string | null
  like_count: number | null
  comment_count: number | null
  bookmark_count: number | null
  created_at: string
}

interface PostDetailModalProps {
  post: BookmarkedPost | null
  fullContent: string | null
  loading: boolean
  t: (key: string) => string
  onClose: () => void
}

export default function PostDetailModal({
  post,
  fullContent,
  loading,
  t,
  onClose,
}: PostDetailModalProps) {
  if (!post) return null

  return (
    <ModalOverlay open onClose={onClose} label={post.title} maxWidth={760} portal>
      <div style={{ padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
          <button
            onClick={onClose}
            aria-label={t('close')}
            style={{
              border: 'none',
              background: 'transparent',
              color: tokens.colors.text.secondary,
              cursor: 'pointer',
              // eslint-disable-next-line no-restricted-syntax -- off-scale icon glyph by design
              fontSize: 24,
              width: 36,
              height: 36,
              borderRadius: tokens.radius.md,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ✕
          </button>
        </div>

        <Text size="xl" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
          {post.title}
        </Text>

        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[3],
            marginBottom: tokens.spacing[4],
          }}
        >
          {post.author_handle && (
            <Link
              href={`/u/${encodeURIComponent(post.author_handle)}`}
              style={{
                color: tokens.colors.accent?.primary,
                textDecoration: 'none',
                fontSize: tokens.typography.fontSize.base,
              }}
            >
              @{post.author_handle}
            </Link>
          )}
          <Text size="sm" color="tertiary">
            {formatTimeAgo(post.created_at, getLanguage())}
          </Text>
        </Box>

        {loading ? (
          <Text size="sm" color="tertiary">
            {t('loading')}
          </Text>
        ) : (
          <Text
            size="base"
            style={{ lineHeight: 1.8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
          >
            {fullContent || post.content || ''}
          </Text>
        )}

        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[4],
            marginTop: tokens.spacing[6],
            paddingTop: tokens.spacing[4],
            borderTop: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Text size="sm" color="tertiary">
            {t('likesCount').replace('{n}', String(post.like_count || 0))}
          </Text>
          <Text size="sm" color="tertiary">
            {t('commentsCount').replace('{n}', String(post.comment_count || 0))}
          </Text>
          <Text size="sm" color="tertiary">
            {t('bookmarksCount').replace('{n}', String(post.bookmark_count || 0))}
          </Text>
        </Box>

        <Box style={{ marginTop: tokens.spacing[4], textAlign: 'center' }}>
          <Link
            href={`/post/${post.id}`}
            style={{
              color: tokens.colors.accent?.primary,
              textDecoration: 'none',
              fontSize: tokens.typography.fontSize.base,
            }}
          >
            {t('viewFullPost')} →
          </Link>
        </Box>
      </div>
    </ModalOverlay>
  )
}
