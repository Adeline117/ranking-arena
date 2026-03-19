'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { ThumbsUpIcon, ThumbsDownIcon, CommentIcon } from '../../ui/icons'
import { formatTimeAgo } from '@/lib/utils/date'
import { renderContentWithLinks, ARENA_PURPLE, truncateText } from '@/lib/utils/content'
import { type PollChoice, type PostWithUserState, getPollWinner } from '@/lib/types'
import { ReactButton } from './PostActions'
import { AvatarLink } from './AvatarLink'
import { SensitiveContentWrapper } from './SensitiveContentWrapper'
import LevelBadge from '@/app/components/user/LevelBadge'
import { memo, useRef, useEffect } from 'react'
import { useLanguage } from '../../Providers/LanguageProvider'

// Visibility icon paths
const VISIBILITY_ICONS: Record<string, string> = {
  public: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z',
  followers: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
  group: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z',
}

// Module-level Set to prevent duplicate impression reports
const reportedImpressions = new Set<string>()

type Post = PostWithUserState

interface PostCardProps {
  post: Post
  variant?: 'compact' | 'full'
  onClick?: () => void
  onReact?: (postId: string, reactionType: 'up' | 'down') => void
  onVote?: (postId: string, choice: PollChoice) => void
  translatedTitle?: string
  translatedContent?: string
}

// 投票标签
function pollLabel(choice: PollChoice | 'tie', t: (key: string) => string) {
  if (choice === 'bull') return t('bullish')
  if (choice === 'bear') return t('bearish')
  return t('wait')
}

function pollColor(choice: PollChoice | 'tie') {
  if (choice === 'bull') return tokens.colors.sentiment.bull
  if (choice === 'bear') return tokens.colors.sentiment.bear
  return tokens.colors.sentiment.neutral
}

export const PostCard = memo(function PostCard({
  post,
  variant = 'compact',
  onClick,
  onReact,
  onVote,
  translatedTitle,
  translatedContent,
}: PostCardProps) {
  const { t, language } = useLanguage()
  const cardRef = useRef<HTMLDivElement>(null)

  // Track impression when post enters viewport (deduplicated)
  useEffect(() => {
    const el = cardRef.current
    if (!el || reportedImpressions.has(post.id)) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !reportedImpressions.has(post.id)) {
          reportedImpressions.add(post.id)
          navigator.sendBeacon('/api/track', JSON.stringify({
            type: 'impression',
            post_id: post.id,
          }))
          observer.disconnect()
        }
      },
      { threshold: 0.5 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [post.id])

  const isCompact = variant === 'compact'

  // 显示的标题和内容
  const displayTitle = translatedTitle || post.title
  const displayContent = translatedContent || post.content
  const isTranslated = !!(translatedTitle || translatedContent)

  // 计算投票结果
  const pollWinner = post.poll_enabled ? getPollWinner({
    bull: post.poll_bull || 0,
    bear: post.poll_bear || 0,
    wait: post.poll_wait || 0,
  }) : null

  // 紧凑模式
  if (isCompact) {
    return (
      <div
        ref={cardRef}
        onClick={onClick}
        className="list-item-hover"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`,
          borderRadius: tokens.radius.lg,
          background: tokens.glass.bg.light,
          border: tokens.glass.border.light,
          cursor: 'pointer',
          transition: tokens.transition.all,
          minHeight: 80,
          position: 'relative',
          overflow: 'hidden',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = tokens.glass.bg.medium
          e.currentTarget.style.borderColor = `${tokens.colors.accent.primary}30`
          e.currentTarget.style.boxShadow = tokens.shadow.sm
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = tokens.glass.bg.light
          e.currentTarget.style.borderColor = 'var(--glass-border-light)'
          e.currentTarget.style.boxShadow = 'none'
        }}
      >
        {/* 标题 */}
        <div style={{
          fontWeight: tokens.typography.fontWeight.bold,
          fontSize: tokens.typography.fontSize.sm,
          color: isTranslated ? 'var(--color-translated)' : tokens.colors.text.primary,
          lineHeight: 1.4,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {displayTitle}
          {isTranslated && <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-translated)', background: 'var(--color-translated-08)', padding: '0 4px', borderRadius: tokens.radius.full, marginLeft: 4 }}>译</span>}
        </div>
        
        {/* 底部信息 */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: tokens.typography.fontSize.xs,
          color: tokens.colors.text.tertiary,
        }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <AvatarLink handle={post.author_handle} avatarUrl={post.author_avatar_url} isPro={post.author_is_pro} showProBadge={post.author_show_pro_badge} />
            <LevelBadge exp={post.author_exp || 0} size="sm" />
          </span>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
            {/* 投票结果指示器 */}
            {pollWinner && (
              <span style={{
                color: pollColor(pollWinner),
                fontWeight: 700,
                fontSize: 12,
              }}>
                {pollLabel(pollWinner, t)}
              </span>
            )}
            
            <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <CommentIcon size={12} />
              {post.comment_count || 0}
            </span>
            
            <span>{formatTimeAgo(post.created_at, language)}</span>
          </div>
        </div>
      </div>
    )
  }

  // 完整模式
  return (
    <div
      ref={cardRef}
      onClick={onClick}
      className="glass-card-hover"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacing[3],
        padding: tokens.spacing[4],
        borderRadius: tokens.radius.xl,
        background: tokens.glass.bg.secondary,
        backdropFilter: tokens.glass.blur.md,
        WebkitBackdropFilter: tokens.glass.blur.md,
        border: tokens.glass.border.light,
        cursor: 'pointer',
        transition: tokens.transition.all,
        position: 'relative',
        overflow: 'hidden',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = tokens.glass.bg.tertiary
        e.currentTarget.style.transform = 'translateY(-2px)'
        e.currentTarget.style.boxShadow = tokens.shadow.md
        e.currentTarget.style.borderColor = `${tokens.colors.accent.primary}25`
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = tokens.glass.bg.secondary
        e.currentTarget.style.transform = 'translateY(0)'
        e.currentTarget.style.boxShadow = 'none'
        e.currentTarget.style.borderColor = 'var(--glass-border-light)'
      }}
    >
      {/* 头部 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <AvatarLink handle={post.author_handle} avatarUrl={post.author_avatar_url} isPro={post.author_is_pro} showProBadge={post.author_show_pro_badge} />
          <LevelBadge exp={post.author_exp || 0} size="sm" />
        </span>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          {post.group_name && post.group_id && (
            <Link
              href={`/groups/${post.group_id}`}
              onClick={(e) => e.stopPropagation()}
              style={{
                fontSize: tokens.typography.fontSize.xs,
                color: ARENA_PURPLE,
                textDecoration: 'none',
                padding: `2px 8px`,
                background: `${ARENA_PURPLE}20`,
                borderRadius: tokens.radius.sm,
              }}
            >
              {post.group_name}
            </Link>
          )}
          {/* Visibility indicator */}
          {post.visibility && post.visibility !== 'public' && (
            <span title={t(post.visibility === 'followers' ? 'visibilityFollowers' : 'visibilityGroup')} style={{ display: 'inline-flex', alignItems: 'center' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill={tokens.colors.text.tertiary}>
                <path d={VISIBILITY_ICONS[post.visibility] || VISIBILITY_ICONS.public} />
              </svg>
            </span>
          )}
          <span style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>
            {formatTimeAgo(post.created_at, language)}
          </span>
        </div>
      </div>

      {/* Content wrapper: blur if sensitive */}
      {post.is_sensitive || post.content_warning ? (
        <SensitiveContentWrapper contentWarning={post.content_warning}>
          {/* 标题 */}
          <div style={{
            fontWeight: tokens.typography.fontWeight.bold,
            fontSize: tokens.typography.fontSize.base,
            color: isTranslated ? 'var(--color-translated)' : tokens.colors.text.primary,
            lineHeight: 1.4,
          }}>
            {displayTitle}
            {isTranslated && <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-translated)', background: 'var(--color-translated-08)', border: '1px solid var(--color-translated-20)', padding: '1px 5px', borderRadius: tokens.radius.full, marginLeft: 6, verticalAlign: 'middle' }}>译</span>}
          </div>

          {/* 内容预览 */}
          {displayContent && (
            <div style={{
              fontSize: tokens.typography.fontSize.sm,
              color: isTranslated ? 'var(--color-translated)' : tokens.colors.text.secondary,
              opacity: isTranslated ? 0.8 : 1,
              lineHeight: 1.6,
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}>
              {renderContentWithLinks(truncateText(displayContent, 200))}
            </div>
          )}
        </SensitiveContentWrapper>
      ) : (
        <>
          {/* 标题 */}
          <div style={{
            fontWeight: tokens.typography.fontWeight.bold,
            fontSize: tokens.typography.fontSize.base,
            color: isTranslated ? 'var(--color-translated)' : tokens.colors.text.primary,
            lineHeight: 1.4,
          }}>
            {displayTitle}
            {isTranslated && <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-translated)', background: 'var(--color-translated-08)', border: '1px solid var(--color-translated-20)', padding: '1px 5px', borderRadius: tokens.radius.full, marginLeft: 6, verticalAlign: 'middle' }}>译</span>}
          </div>

          {/* 内容预览 */}
          {displayContent && (
            <div style={{
              fontSize: tokens.typography.fontSize.sm,
              color: isTranslated ? 'var(--color-translated)' : tokens.colors.text.secondary,
              opacity: isTranslated ? 0.8 : 1,
              lineHeight: 1.6,
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}>
              {renderContentWithLinks(truncateText(displayContent, 200))}
            </div>
          )}
        </>
      )}
      
      {/* 投票显示 */}
      {post.poll_enabled && (
        <div style={{
          display: 'flex',
          gap: tokens.spacing[2],
          padding: tokens.spacing[2],
          background: tokens.colors.bg.tertiary,
          borderRadius: tokens.radius.md,
        }}>
          {(['bull', 'bear', 'wait'] as PollChoice[]).map((choice) => {
            const count = choice === 'bull' ? post.poll_bull : choice === 'bear' ? post.poll_bear : post.poll_wait
            const total = (post.poll_bull || 0) + (post.poll_bear || 0) + (post.poll_wait || 0)
            const percent = total > 0 ? Math.round((count || 0) / total * 100) : 0
            const isSelected = post.user_vote === choice
            
            return (
              <button
                key={choice}
                onClick={(e) => {
                  e.stopPropagation()
                  onVote?.(post.id, choice)
                }}
                style={{
                  flex: 1,
                  padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                  background: isSelected ? `${pollColor(choice)}30` : 'transparent',
                  border: `1px solid ${isSelected ? pollColor(choice) : tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.sm,
                  color: pollColor(choice),
                  fontSize: tokens.typography.fontSize.xs,
                  fontWeight: isSelected ? 700 : 500,
                  cursor: 'pointer',
                  transition: `all ${tokens.transition.fast}`,
                }}
              >
                {pollLabel(choice, t)} {percent}%
              </button>
            )
          })}
        </div>
      )}
      
      {/* 底部操作 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
        paddingTop: tokens.spacing[2],
        marginTop: tokens.spacing[1],
        borderTop: `1px solid ${tokens.colors.border.primary}`,
      }}>
        <ReactButton
          onClick={(e) => {
            e.stopPropagation()
            onReact?.(post.id, 'up')
          }}
          active={post.user_reaction === 'up'}
          icon={<ThumbsUpIcon size={16} />}
          count={post.like_count || 0}
        />
        
        <ReactButton
          onClick={(e) => {
            e.stopPropagation()
            onReact?.(post.id, 'down')
          }}
          active={post.user_reaction === 'down'}
          icon={<ThumbsDownIcon size={16} />}
          count={post.dislike_count || 0}
        />
        
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          color: tokens.colors.text.tertiary,
          fontSize: tokens.typography.fontSize.sm,
        }}>
          <CommentIcon size={16} />
          {post.comment_count || 0}
        </div>
      </div>
    </div>
  )
})

export default PostCard

