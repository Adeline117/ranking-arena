'use client'

import { localizedLabel } from '@/lib/utils/format'
import React, { memo } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { ThumbsUpIcon, ThumbsDownIcon, CommentIcon } from '../../ui/icons'
import { formatTimeAgo, type Locale } from '@/lib/utils/date'
import { ARENA_PURPLE, renderContentWithLinks, truncateText } from '@/lib/utils/content'
import { AvatarLink, ReactButton } from '../components'
import { type PostWithUserState } from '@/lib/types'

type Post = PostWithUserState

interface TranslatedPost {
  title?: string
  body?: string
}

interface PostListItemProps {
  post: Post
  isMasonry: boolean
  language: Locale
  currentUserId: string | null
  translatedListPosts: Record<string, TranslatedPost>
  onOpenPost: (post: Post) => void
  onToggleReaction: (postId: string, type: 'up' | 'down') => void
  onTogglePin: (post: Post, e: React.MouseEvent) => void
  onStartEdit: (post: Post, e: React.MouseEvent) => void
  onDeletePost: (post: Post, e: React.MouseEvent) => void
  onReport?: (post: Post) => void
  removeImagesFromContent: (content: string) => string
  t: (key: string) => string
}

export const PostListItem = memo(function PostListItem({
  post: p,
  isMasonry,
  language,
  currentUserId,
  translatedListPosts,
  onOpenPost,
  onToggleReaction,
  onReport,
  onTogglePin,
  onStartEdit,
  onDeletePost,
  removeImagesFromContent,
  t,
}: PostListItemProps) {
  return (
    <div
      onClick={(e: React.MouseEvent) => {
        // Don't hijack clicks on interactive elements
        if ((e.target as HTMLElement).closest('a, button, [role="button"], input, textarea, select')) return
        onOpenPost(p)
      }}
      style={isMasonry ? {
        breakInside: 'avoid',
        marginBottom: 12,
        padding: tokens.spacing[3],
        borderRadius: tokens.radius.xl,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
        cursor: 'pointer',
        color: tokens.colors.text.primary,
        transition: 'transform 0.2s ease, box-shadow 0.2s ease',
        minHeight: 160,
        display: 'flex',
        flexDirection: 'column',
      } : {
        width: '100%',
        textAlign: 'left',
        border: 'none',
        background: 'transparent',
        padding: `${tokens.spacing[3]} ${tokens.spacing[2]}`,
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        cursor: 'pointer',
        color: tokens.colors.text.primary,
        transition: `background-color 0.15s ease`,
        borderRadius: tokens.radius.md,
      }}
      onMouseEnter={(e) => {
        if (isMasonry) {
          e.currentTarget.style.transform = 'translateY(-2px)'
          e.currentTarget.style.boxShadow = '0 6px 20px var(--color-accent-primary-15)'
        } else {
          e.currentTarget.style.background = tokens.colors.bg.secondary
        }
      }}
      onMouseLeave={(e) => {
        if (isMasonry) {
          e.currentTarget.style.transform = 'translateY(0)'
          e.currentTarget.style.boxShadow = 'none'
        } else {
          e.currentTarget.style.background = 'transparent'
        }
      }}
    >
      {/* Header: Group + Author */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'nowrap', minWidth: 0 }}>
        {p.group_id ? (
          <Link
            href={`/groups/${p.group_id}`}
            onClick={(e) => e.stopPropagation()}
            style={{
              fontSize: 12,
              color: ARENA_PURPLE,
              textDecoration: 'none',
              cursor: 'pointer',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flexShrink: 1,
              minWidth: 0,
            }}
          >
            {localizedLabel(p.group_name || t('group'), p.group_name_en || p.group_name, language)}
          </Link>
        ) : null}
        <AvatarLink handle={p.author_handle} avatarUrl={p.author_avatar_url} isPro={p.author_is_pro} showProBadge={p.author_show_pro_badge} isOfficial={p.author_handle === 'arena_bot'} />
      </div>

      {/* Title + Tags */}
      <div style={{ marginTop: 6, fontWeight: 900, lineHeight: 1.25, display: 'flex', alignItems: 'center', gap: 8, flexWrap: isMasonry ? 'nowrap' : 'wrap', minWidth: 0 }}>
        <span style={{
          color: translatedListPosts[p.id]?.title ? tokens.colors.accent.translated : tokens.colors.text.primary,
          ...(isMasonry ? {
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          } : {}),
        }}>
          {translatedListPosts[p.id]?.title || p.title}
        </span>
        {/* Poll tag */}
        {p.poll_id && (
          <span
            style={{
              fontSize: 11,
              color: ARENA_PURPLE,
              fontWeight: 700,
              border: `1px solid ${tokens.colors.border.primary}`,
              padding: '2px 8px',
              borderRadius: tokens.radius.full,
              background: 'var(--color-accent-primary-10)',
            }}
          >
            {t('poll')}
          </span>
        )}
        {/* Image count tag */}
        {p.images && p.images.length > 0 && (
          <span style={{ fontSize: 11, color: tokens.colors.text.tertiary, fontWeight: 600 }}>
            {p.images.length} {t('img')}
          </span>
        )}
      </div>

      {/* Content preview */}
      {p.content && (
        <div style={{
          marginTop: 8,
          fontSize: 13,
          color: translatedListPosts[p.id]?.body ? tokens.colors.accent.translated : tokens.colors.text.secondary,
          lineHeight: 1.5,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
        }}>
          {renderContentWithLinks(truncateText(removeImagesFromContent(translatedListPosts[p.id]?.body || p.content), 150))}
        </div>
      )}

      {/* Image preview — single image as card, multiple as scroll-snap gallery */}
      {p.images && p.images.length > 0 && (
        p.images.length === 1 ? (
          <div style={{ marginTop: 10 }}>
            <div style={{
              width: 200, height: 150,
              borderRadius: tokens.radius.md,
              overflow: 'hidden',
              background: tokens.colors.bg.tertiary,
            }}>
              <img
                src={p.images[0]}
                alt="Image 1"
                loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            </div>
          </div>
        ) : (
          <div
            className="scroll-snap-x fade-edges"
            style={{
              marginTop: 10,
              display: 'flex',
              gap: 8,
              overflowX: 'auto',
              scrollSnapType: 'x mandatory',
              WebkitOverflowScrolling: 'touch',
              paddingBottom: 4,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {p.images.map((imgUrl, idx) => (
              <div
                key={idx}
                style={{
                  width: 120, height: 90,
                  borderRadius: tokens.radius.md,
                  overflow: 'hidden',
                  background: tokens.colors.bg.tertiary,
                  flexShrink: 0,
                  scrollSnapAlign: 'start',
                }}
              >
                <img
                  src={imgUrl}
                  alt={`Image ${idx + 1}`}
                  loading="lazy"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                />
              </div>
            ))}
          </div>
        )
      )}

      {/* Original post quote (for reposts) */}
      {p.original_post && (
        <div
          style={{
            marginTop: 10,
            padding: 12,
            background: tokens.colors.bg.tertiary,
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ marginBottom: 8 }}>
            <AvatarLink
              handle={p.original_post.author_handle}
              avatarUrl={p.original_post.author_avatar_url}
              isPro={p.original_post.author_is_pro}
              showProBadge={p.original_post.author_show_pro_badge}
            />
          </div>
          {p.original_post.title && (
            <div style={{ fontSize: 13, color: tokens.colors.text.primary, fontWeight: 600, marginBottom: 4 }}>
              {p.original_post.title}
            </div>
          )}
          <div style={{
            fontSize: 12,
            color: tokens.colors.text.secondary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}>
            {removeImagesFromContent(p.original_post.content).slice(0, 100)}
          </div>
          {/* Original post image preview */}
          {p.original_post.images && p.original_post.images.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', gap: 4 }}>
              {p.original_post.images.slice(0, 3).map((imgUrl, idx) => (
                <div key={idx} style={{ width: 48, height: 48, borderRadius: tokens.radius.sm, overflow: 'hidden', position: 'relative' }}>
                  <Image src={imgUrl} alt="Post image" fill sizes="(max-width: 768px) 100vw, 200px" loading="lazy" style={{ objectFit: 'cover' }} />
                </div>
              ))}
              {p.original_post.images.length > 3 && (
                <span style={{ fontSize: 11, color: tokens.colors.text.tertiary, alignSelf: 'center' }}>
                  +{p.original_post.images.length - 3}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Reactions + Meta */}
      <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', color: tokens.colors.text.secondary, fontSize: 12, alignItems: 'center' }}>
        <ReactButton
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onToggleReaction(p.id, 'up')
          }}
          active={p.user_reaction === 'up'}
          icon={<ThumbsUpIcon size={14} />}
          count={p.like_count}
          showCount={true}
        />
        <ReactButton
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onToggleReaction(p.id, 'down')
          }}
          active={p.user_reaction === 'down'}
          icon={<ThumbsDownIcon size={14} />}
          count={p.dislike_count}
          showCount={false}
        />
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <CommentIcon size={14} /> {p.comment_count}
        </span>
        <span style={{ color: tokens.colors.text.tertiary }}>
          {formatTimeAgo(p.created_at, language)}
        </span>

        {/* Pinned badge */}
        {p.is_pinned && (
          <span style={{
            fontSize: 11,
            color: ARENA_PURPLE,
            fontWeight: 700,
            padding: '2px 6px',
            background: 'var(--color-accent-primary-10)',
            borderRadius: tokens.radius.sm,
          }}>
            {t('pinned')}
          </span>
        )}

        {/* Report button for non-author posts */}
        {currentUserId && p.author_id !== currentUserId && onReport && (
          <button
            onClick={(e) => { e.stopPropagation(); onReport(p) }}
            style={{
              background: 'transparent', border: 'none', color: tokens.colors.text.tertiary,
              cursor: 'pointer', fontSize: 12, padding: '2px 6px', borderRadius: tokens.radius.sm, marginLeft: 'auto',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = tokens.colors.accent.error }}
            onMouseLeave={(e) => { e.currentTarget.style.color = tokens.colors.text.tertiary }}
            title={t('report')}
          >
            ⚑
          </button>
        )}
        {/* Author actions: Pin/Edit/Delete */}
        {currentUserId && p.author_id === currentUserId && (
          <span style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <button
              onClick={(e) => onTogglePin(p, e)}
              style={{
                background: p.is_pinned ? 'var(--color-accent-primary-10)' : 'transparent',
                border: 'none',
                color: p.is_pinned ? ARENA_PURPLE : tokens.colors.text.tertiary,
                cursor: 'pointer',
                fontSize: 12,
                padding: '2px 6px',
                borderRadius: tokens.radius.sm,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = ARENA_PURPLE
                e.currentTarget.style.background = 'var(--color-accent-primary-10)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = p.is_pinned ? ARENA_PURPLE : tokens.colors.text.tertiary
                e.currentTarget.style.background = p.is_pinned ? 'var(--color-accent-primary-10)' : 'transparent'
              }}
            >
              {p.is_pinned ? t('unpin') : t('pin')}
            </button>
            <button
              onClick={(e) => onStartEdit(p, e)}
              style={{
                background: 'transparent',
                border: 'none',
                color: tokens.colors.text.tertiary,
                cursor: 'pointer',
                fontSize: 12,
                padding: '2px 6px',
                borderRadius: tokens.radius.sm,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = `${tokens.colors.accent.brand}`
                e.currentTarget.style.background = 'var(--color-accent-primary-10)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = tokens.colors.text.tertiary
                e.currentTarget.style.background = 'transparent'
              }}
            >
              {t('edit')}
            </button>
            <button
              onClick={(e) => onDeletePost(p, e)}
              style={{
                background: 'transparent',
                border: 'none',
                color: tokens.colors.text.tertiary,
                cursor: 'pointer',
                fontSize: 12,
                padding: '2px 6px',
                borderRadius: tokens.radius.sm,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = tokens.colors.accent.error
                e.currentTarget.style.background = 'var(--color-accent-error-10)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = tokens.colors.text.tertiary
                e.currentTarget.style.background = 'transparent'
              }}
            >
              {t('delete')}
            </button>
          </span>
        )}
      </div>
    </div>
  )
}, (prev, next) => {
  // Custom comparison for performance - only re-render when post data changes
  return (
    prev.post.id === next.post.id &&
    prev.post.like_count === next.post.like_count &&
    prev.post.dislike_count === next.post.dislike_count &&
    prev.post.comment_count === next.post.comment_count &&
    prev.post.user_reaction === next.post.user_reaction &&
    prev.post.user_vote === next.post.user_vote &&
    prev.post.is_pinned === next.post.is_pinned &&
    prev.isMasonry === next.isMasonry &&
    prev.language === next.language &&
    prev.currentUserId === next.currentUserId &&
    prev.translatedListPosts[prev.post.id] === next.translatedListPosts[next.post.id]
  )
})
