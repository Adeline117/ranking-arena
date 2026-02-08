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

export default function HotDiscussions({ limit = 8 }: { limit?: number }) {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [posts, setPosts] = useState<HotPost[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    async function fetch() {
      const { data } = await supabase
        .from('posts')
        .select('id, title, content, hot_score, like_count, comment_count, created_at, author_id')
        .order('hot_score', { ascending: false })
        .limit(limit)

      if (!alive || !data) return

      // Fetch author handles
      const authorIds = [...new Set(data.map(p => p.author_id).filter(Boolean))]
      let handleMap: Record<string, string> = {}
      if (authorIds.length) {
        const { data: profiles } = await supabase
          .from('user_profiles')
          .select('id, handle')
          .in('id', authorIds)
        if (profiles) {
          handleMap = Object.fromEntries(profiles.map(p => [p.id, p.handle]))
        }
      }

      setPosts(data.map(p => ({
        ...p,
        author_handle: handleMap[p.author_id] || null,
      })))
      setLoading(false)
    }
    fetch()
    return () => { alive = false }
  }, [limit])

  // Extract preview text from content (strip stickers, trim)
  function getPreview(post: HotPost): string {
    const text = (post.title || post.content || '').replace(/\[sticker:\w+\]/g, '').trim()
    return text.length > 50 ? text.slice(0, 50) + '...' : text
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
    <SidebarCard title={isZh ? '热门讨论' : 'Hot Discussions'}>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 48, borderRadius: 8 }} />
          ))}
        </div>
      ) : posts.length === 0 ? (
        <p style={{ fontSize: tokens.typography.fontSize.sm, color: 'var(--color-text-tertiary)', textAlign: 'center', padding: '12px 0' }}>
          {isZh ? '暂无讨论' : 'No discussions yet'}
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {posts.map((post, idx) => (
            <Link
              key={post.id}
              href={`/post/${post.id}`}
              style={{
                display: 'flex',
                gap: 8,
                padding: '8px 4px',
                borderRadius: tokens.radius.md,
                textDecoration: 'none',
                color: 'inherit',
                transition: `background ${tokens.transition.fast}`,
                borderBottom: idx < posts.length - 1 ? `1px solid var(--color-border-primary)` : 'none',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              {/* Rank number */}
              <span style={{
                flexShrink: 0,
                width: 20,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: 700,
                color: idx < 3 ? 'var(--color-accent-error)' : 'var(--color-text-tertiary)',
                lineHeight: '20px',
              }}>
                {idx + 1}
              </span>

              {/* Content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: 500,
                  color: 'var(--color-text-primary)',
                  lineHeight: 1.4,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {getPreview(post)}
                </p>
                <div style={{
                  display: 'flex',
                  gap: 8,
                  fontSize: 11,
                  color: 'var(--color-text-tertiary)',
                  marginTop: 2,
                }}>
                  {post.author_handle && (
                    <span>{post.author_handle}</span>
                  )}
                  <span>{post.like_count} {isZh ? '赞' : 'likes'}</span>
                  <span>{post.comment_count} {isZh ? '评论' : 'comments'}</span>
                  <span>{timeAgo(post.created_at)}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </SidebarCard>
  )
}
