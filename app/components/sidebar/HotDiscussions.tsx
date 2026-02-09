'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import SidebarCard from './SidebarCard'

type HotPost = {
  id: string
  title: string | null
  content: string
  hot_score: number
  like_count: number
  comment_count: number
  author_handle: string | null
  created_at: string
}

function HotTag({ score, isZh }: { score: number; isZh: boolean }) {
  const level = score >= 100 ? 'hot' : score >= 50 ? 'warm' : 'normal'
  const config = {
    hot: {
      label: isZh ? '热门' : 'Hot',
      bg: 'var(--color-red-subtle)',
      color: 'var(--color-accent-error)',
      border: 'var(--color-red-border)',
    },
    warm: {
      label: isZh ? '升温' : 'Rising',
      bg: 'var(--color-orange-subtle)',
      color: 'var(--color-accent-warning)',
      border: 'var(--color-orange-border)',
    },
    normal: {
      label: isZh ? '讨论' : 'Active',
      bg: 'var(--glass-bg-light)',
      color: 'var(--color-text-tertiary)',
      border: 'var(--glass-border-light)',
    },
  }
  const c = config[level]
  return (
    <span style={{
      fontSize: tokens.typography.fontSize.xs,
      fontWeight: tokens.typography.fontWeight.medium,
      color: c.color,
      background: c.bg,
      border: `1px solid ${c.border}`,
      padding: '1px 6px',
      borderRadius: tokens.radius.full,
      lineHeight: 1.6,
      letterSpacing: '0.01em',
      flexShrink: 0,
    }}>
      {c.label}
    </span>
  )
}

export default function HotDiscussions({ limit = 8 }: { limit?: number }) {
  const { language, t } = useLanguage()
  const isZh = language === 'zh'
  const [posts, setPosts] = useState<HotPost[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    async function fetchData() {
      const { data } = await supabase
        .from('posts')
        .select('id, title, content, hot_score, like_count, comment_count, created_at, author_handle')
        .gt('hot_score', 0)
        .eq('status', 'active')
        .order('hot_score', { ascending: false })
        .limit(limit)

      if (!alive || !data) return

      setPosts(data.map(p => ({
        id: p.id,
        title: p.title,
        content: p.content,
        hot_score: p.hot_score,
        like_count: p.like_count,
        comment_count: p.comment_count,
        created_at: p.created_at,
        author_handle: p.author_handle || null,
      })))
      setLoading(false)
    }
    fetchData()
    return () => { alive = false }
  }, [limit])

  function getTitle(post: HotPost): string {
    const text = (post.title || post.content || '').replace(/\[sticker:\w+\]/g, '').trim()
    return text.length > 60 ? text.slice(0, 60) + '...' : text
  }

  function getContentPreview(post: HotPost): string {
    // Show content preview below title; if title exists, show content; otherwise show more of content
    const raw = (post.content || '').replace(/\[sticker:\w+\]/g, '').trim()
    if (post.title) {
      return raw.length > 100 ? raw.slice(0, 100) + '...' : raw
    }
    // No title: content already shown as title, show more
    const remaining = raw.slice(60).trim()
    return remaining.length > 80 ? remaining.slice(0, 80) + '...' : remaining
  }

  function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return isZh ? `${mins}分钟前` : `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return isZh ? `${hours}小时前` : `${hours}h ago`
    const days = Math.floor(hours / 24)
    return isZh ? `${days}天前` : `${days}d ago`
  }

  return (
    <SidebarCard title={t('sidebarHotDiscussions')}>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 56, borderRadius: tokens.radius.md }} />
          ))}
        </div>
      ) : posts.length === 0 ? (
        <p style={{
          fontSize: tokens.typography.fontSize.sm,
          color: 'var(--color-text-tertiary)',
          textAlign: 'center',
          padding: '16px 0',
        }}>
          {t('sidebarNoDiscussions')}
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {posts.map((post) => {
            const contentPreview = getContentPreview(post)
            return (
              <Link
                key={post.id}
                href={`/post/${post.id}`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: '12px 14px',
                  borderRadius: tokens.radius.lg,
                  textDecoration: 'none',
                  color: 'inherit',
                  transition: `all ${tokens.transition.fast}`,
                  position: 'relative',
                  background: 'var(--glass-bg-light)',
                  border: '1px solid var(--glass-border-light)',
                }}
                onMouseEnter={e => {
                  const el = e.currentTarget
                  el.style.background = 'var(--glass-bg-medium)'
                  el.style.borderColor = 'var(--glass-border-medium)'
                }}
                onMouseLeave={e => {
                  const el = e.currentTarget
                  el.style.background = 'var(--glass-bg-light)'
                  el.style.borderColor = 'var(--glass-border-light)'
                }}
              >
                {/* Title + hot tag */}
                <div style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                }}>
                  <span style={{
                    fontSize: tokens.typography.fontSize.sm,
                    fontWeight: tokens.typography.fontWeight.semibold,
                    color: 'var(--color-text-primary)',
                    lineHeight: 1.4,
                    flex: 1,
                    minWidth: 0,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}>
                    {getTitle(post)}
                  </span>
                  <HotTag score={post.hot_score} isZh={isZh} />
                </div>

                {/* Content preview */}
                {contentPreview && (
                  <p style={{
                    fontSize: tokens.typography.fontSize.xs,
                    color: 'var(--color-text-secondary)',
                    lineHeight: 1.5,
                    margin: 0,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}>
                    {contentPreview}
                  </p>
                )}

                {/* Meta: author + comments + time */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  fontSize: tokens.typography.fontSize.xs,
                  color: 'var(--color-text-tertiary)',
                }}>
                  {post.author_handle && (
                    <span style={{
                      fontWeight: tokens.typography.fontWeight.medium,
                      color: 'var(--color-text-secondary)',
                    }}>
                      {post.author_handle}
                    </span>
                  )}
                  <span>
                    {post.comment_count} {t('comments')}
                  </span>
                  <span style={{ marginLeft: 'auto', opacity: 0.7 }}>
                    {timeAgo(post.created_at)}
                  </span>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </SidebarCard>
  )
}
