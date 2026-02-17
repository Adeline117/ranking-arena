'use client'

import Link from 'next/link'
import Image from 'next/image'
import useSWR from 'swr'
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
  author_avatar_url: string | null
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

async function fetchHotPosts(_key: string, limit: number): Promise<HotPost[]> {
  const { data } = await supabase
    .from('posts')
    .select('id, title, content, hot_score, like_count, comment_count, created_at, author_handle, author_avatar_url')
    .gt('hot_score', 0)
    .eq('status', 'active')
    .order('hot_score', { ascending: false })
    .limit(limit)

  if (!data) return []
  return data.map(p => ({
    id: p.id,
    title: p.title,
    content: p.content,
    hot_score: p.hot_score,
    like_count: p.like_count,
    comment_count: p.comment_count,
    created_at: p.created_at,
    author_handle: p.author_handle || null,
    author_avatar_url: p.author_avatar_url || null,
  }))
}

export default function HotDiscussions({ limit = 8 }: { limit?: number }) {
  const { language, t } = useLanguage()
  const isZh = language === 'zh'

  const { data: posts = [], isLoading: loading } = useSWR(
    ['hot-discussions', limit],
    ([key, lim]) => fetchHotPosts(key, lim),
    {
      revalidateOnFocus: false,
      dedupingInterval: 180000,
      errorRetryCount: 3,
      onErrorRetry: (err, _key, _config, revalidate, { retryCount }) => {
        if (retryCount >= 3) return
        setTimeout(() => revalidate({ retryCount }), 1000 * Math.pow(2, retryCount))
      },
    }
  )

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

                {/* Meta: avatar + author + comments + time */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: tokens.typography.fontSize.xs,
                  color: 'var(--color-text-tertiary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                }}>
                  {post.author_avatar_url ? (
                    <Image
                      src={post.author_avatar_url}
                      alt={post.author_handle || ''}
                      width={18}
                      height={18}
                      style={{ borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                    />
                  ) : post.author_handle ? (
                    <div style={{
                      width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                      background: 'var(--glass-bg-medium)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 10, fontWeight: 600, color: 'var(--color-text-secondary)',
                    }}>
                      {(post.author_handle[0] || '?').toUpperCase()}
                    </div>
                  ) : null}
                  {post.author_handle && (
                    <span style={{
                      fontWeight: tokens.typography.fontWeight.medium,
                      color: 'var(--color-text-secondary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      minWidth: 0,
                      flexShrink: 1,
                    }}>
                      {post.author_handle}
                    </span>
                  )}
                  <span style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 10v12"/><path d="M15 5.88L14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88z"/></svg>
                    {post.like_count || 0}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                    {post.comment_count}
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
