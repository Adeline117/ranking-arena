'use client'

import Link from 'next/link'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { ThumbsUpIcon, ThumbsDownIcon, CommentIcon } from '../../ui/icons'
import { formatTimeAgo, type Locale } from '@/lib/utils/date'
import { ARENA_PURPLE } from '@/lib/utils/content'
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
  removeImagesFromContent: (content: string) => string
  t: (key: string) => string
}

export function PostListItem({
  post: p,
  isMasonry,
  language,
  currentUserId,
  translatedListPosts,
  onOpenPost,
  onToggleReaction,
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
        marginBottom: 10,
        padding: tokens.spacing[2],
        borderRadius: tokens.radius.lg,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
        cursor: 'pointer',
        color: tokens.colors.text.primary,
        transition: 'transform 0.2s ease, box-shadow 0.2s ease',
      } : {
        width: '100%',
        textAlign: 'left',
        border: 'none',
        background: 'transparent',
        padding: `${tokens.spacing[3]} 0`,
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        cursor: 'pointer',
        color: tokens.colors.text.primary,
        transition: `background-color ${tokens.transition.base}`,
      }}
      onMouseEnter={(e) => {
        if (isMasonry) {
          e.currentTarget.style.transform = 'translateY(-2px)'
          e.currentTarget.style.boxShadow = '0 6px 20px rgba(139,111,168,0.15)'
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
            {language === 'zh' ? (p.group_name || t('group')) : (p.group_name_en || p.group_name || t('group'))}
          </Link>
        ) : null}
        <AvatarLink handle={p.author_handle} avatarUrl={p.author_avatar_url} isPro={p.author_is_pro} showProBadge={p.author_show_pro_badge} />
      </div>

      {/* Title + Tags */}
      <div style={{ marginTop: 6, fontWeight: 950, lineHeight: 1.25, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: translatedListPosts[p.id]?.title ? tokens.colors.accent.translated : tokens.colors.text.primary }}>
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
              borderRadius: 999,
              background: 'rgba(139,111,168,0.1)',
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
          {removeImagesFromContent(translatedListPosts[p.id]?.body || p.content).slice(0, 150)}
        </div>
      )}

      {/* Image preview - max 4 images */}
      {p.images && p.images.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {p.images.slice(0, 4).map((imgUrl, idx) => (
            <div
              key={idx}
              style={{
                width: p.images!.length === 1 ? 200 : 80,
                height: p.images!.length === 1 ? 150 : 80,
                borderRadius: 8,
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <img
                src={imgUrl}
                alt={`Image ${idx + 1}`}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
              {idx === 3 && p.images!.length > 4 && (
                <div style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(0,0,0,0.5)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#fff',
                  fontSize: 14,
                  fontWeight: 700,
                }}>
                  +{p.images!.length - 4}
                </div>
              )}
            </div>
          ))}
        </div>
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
                <div key={idx} style={{ width: 48, height: 48, borderRadius: 4, overflow: 'hidden', position: 'relative' }}>
                  <Image src={imgUrl} alt="" fill style={{ objectFit: 'cover' }} unoptimized />
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
      <div style={{ marginTop: 10, display: 'flex', gap: 10, flexWrap: 'wrap', color: tokens.colors.text.secondary, fontSize: 12, alignItems: 'center' }}>
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
            background: 'rgba(139,111,168,0.1)',
            borderRadius: 4,
          }}>
            {t('pinned')}
          </span>
        )}

        {/* Author actions: Pin/Edit/Delete */}
        {currentUserId && p.author_id === currentUserId && (
          <span style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <button
              onClick={(e) => onTogglePin(p, e)}
              style={{
                background: p.is_pinned ? 'rgba(139,111,168,0.1)' : 'transparent',
                border: 'none',
                color: p.is_pinned ? ARENA_PURPLE : tokens.colors.text.tertiary,
                cursor: 'pointer',
                fontSize: 12,
                padding: '2px 6px',
                borderRadius: 4,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = ARENA_PURPLE
                e.currentTarget.style.background = 'rgba(139,111,168,0.1)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = p.is_pinned ? ARENA_PURPLE : tokens.colors.text.tertiary
                e.currentTarget.style.background = p.is_pinned ? 'rgba(139,111,168,0.1)' : 'transparent'
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
                borderRadius: 4,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#8b6fa8'
                e.currentTarget.style.background = 'rgba(139,111,168,0.1)'
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
                borderRadius: 4,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#ff4d4d'
                e.currentTarget.style.background = 'rgba(255,77,77,0.1)'
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
}
