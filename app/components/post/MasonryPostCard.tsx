'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { ThumbsUpIcon, CommentIcon } from '@/app/components/icons'

interface MasonryPostCardProps {
  post: {
    id: string
    title: string
    content?: string | null
    author_handle?: string | null
    created_at: string
    like_count?: number | null
    comment_count?: number | null
    images?: string[]
    group_id?: string
  }
  language?: string
  onLike?: (postId: string) => void
  onComment?: (postId: string) => void
}

export default function MasonryPostCard({ post, language = 'zh', onLike, onComment }: MasonryPostCardProps) {
  const isDeletedUser = !post.author_handle || post.author_handle.startsWith('deleted_')

  return (
    <Link
      href={post.group_id ? `/groups/${post.group_id}?post=${post.id}` : '#'}
      style={{ textDecoration: 'none', color: 'inherit' }}
    >
      <Box
        className="masonry-card"
        style={{
          borderRadius: tokens.radius.xl,
          background: tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          overflow: 'hidden',
          transition: `all ${tokens.transition.base}`,
          cursor: 'pointer',
        }}
      >
        {/* Cover image */}
        {post.images && post.images.length > 0 && (
          <Box style={{ position: 'relative', width: '100%', aspectRatio: '4/3', overflow: 'hidden' }}>
            <img
              src={post.images[0]}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              loading="lazy"
            />
          </Box>
        )}

        {/* Content */}
        <Box style={{ padding: tokens.spacing[3] }}>
          {/* Title */}
          <Text
            size="sm"
            weight="bold"
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              lineHeight: 1.4,
            }}
          >
            {post.title}
          </Text>

          {/* Content preview */}
          {post.content && (
            <Text
              size="xs"
              color="secondary"
              style={{
                marginTop: tokens.spacing[2],
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                lineHeight: 1.5,
              }}
            >
              {post.content}
            </Text>
          )}

          {/* Author row */}
          <Box style={{
            marginTop: tokens.spacing[2],
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            {isDeletedUser ? (
              <Text size="xs" color="tertiary">
                {language === 'zh' ? '已注销用户' : 'Deleted user'}
              </Text>
            ) : (
              <Text size="xs" style={{ color: '#8b6fa8' }}>
                @{post.author_handle}
              </Text>
            )}
            <Text size="xs" color="tertiary">
              {new Date(post.created_at).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US')}
            </Text>
          </Box>

          {/* Action row */}
          <Box style={{
            marginTop: tokens.spacing[2],
            paddingTop: tokens.spacing[2],
            borderTop: `1px solid ${tokens.colors.border.primary}`,
            display: 'flex',
            gap: tokens.spacing[3],
          }}>
            <Box
              style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onLike?.(post.id) }}
            >
              <ThumbsUpIcon size={12} />
              <Text size="xs" color="secondary">{post.like_count || 0}</Text>
            </Box>
            <Box
              style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onComment?.(post.id) }}
            >
              <CommentIcon size={12} />
              <Text size="xs" color="secondary">{post.comment_count || 0}</Text>
            </Box>
          </Box>
        </Box>

        <style jsx>{`
          @media (hover: hover) {
            .masonry-card:hover {
              transform: scale(1.02);
              box-shadow: ${tokens.shadow.lg};
            }
          }
          .masonry-card:active {
            transform: scale(0.98);
          }
        `}</style>
      </Box>
    </Link>
  )
}
