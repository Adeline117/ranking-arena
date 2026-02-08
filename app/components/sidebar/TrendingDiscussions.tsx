'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import SidebarCard from './SidebarCard'

type TrendingPost = {
  id: string
  title: string
  content: string | null
  author_handle: string | null
  comment_count: number
  like_count: number
  view_count: number
  hot_score: number
  created_at: string
  group_id: string | null
  group_name: string | null
}

function formatTimeAgo(dateStr: string, isZh: boolean): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMin = Math.floor((now - then) / 60000)
  if (diffMin < 1) return isZh ? '刚刚' : 'just now'
  if (diffMin < 60) return isZh ? `${diffMin}分钟前` : `${diffMin}m`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return isZh ? `${diffH}小时前` : `${diffH}h`
  const diffD = Math.floor(diffH / 24)
  if (diffD < 30) return isZh ? `${diffD}天前` : `${diffD}d`
  return isZh ? '很久以前' : 'long ago'
}

export default function TrendingDiscussions() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [posts, setPosts] = useState<TrendingPost[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchPosts() {
      const { data } = await supabase
        .from('posts')
        .select('id, title, content, author_handle, comment_count, like_count, view_count, hot_score, created_at, group_id')
        .eq('status', 'active')
        .order('hot_score', { ascending: false })
        .limit(8)

      // Fetch group names for posts with group_id
      const postsData = (data as TrendingPost[]) || []
      if (postsData.length > 0) {
        const groupIds = postsData.map(p => p.group_id).filter(Boolean) as string[]
        if (groupIds.length > 0) {
          const { data: groupData } = await supabase
            .from('groups')
            .select('id, name')
            .in('id', groupIds)
          const groupMap = new Map((groupData || []).map(g => [g.id, g.name]))
          postsData.forEach(p => {
            p.group_name = p.group_id ? groupMap.get(p.group_id) || null : null
          })
        }
      }

      setPosts(postsData)
      setLoading(false)
    }
    fetchPosts()
  }, [])

  return (
    <SidebarCard title={isZh ? '热门讨论' : 'Trending'}>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="skeleton" style={{ height: 72, borderRadius: 8 }} />
          ))}
        </div>
      ) : posts.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '24px 12px' }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.25, color: tokens.colors.text.tertiary, marginBottom: 8 }}>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <p style={{ fontSize: 13, color: tokens.colors.text.tertiary, marginBottom: 4 }}>
            {isZh ? '暂无讨论' : 'No discussions yet'}
          </p>
          <p style={{ fontSize: 11, color: tokens.colors.text.tertiary, opacity: 0.6 }}>
            {isZh ? '加入小组发起话题吧' : 'Join a group to start a topic'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {posts.map((post, idx) => (
            <Link
              key={post.id}
              href={`/hot?post=${post.id}`}
              style={{
                display: 'block',
                padding: '10px 8px',
                textDecoration: 'none',
                borderRadius: 8,
                transition: 'background 0.15s',
                borderBottom: idx < posts.length - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = tokens.colors.bg.tertiary)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              {/* Group tag + time */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                {post.group_name && (
                  <span style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: tokens.colors.accent.brand,
                    background: 'rgba(139,111,168,0.1)',
                    padding: '1px 6px',
                    borderRadius: 4,
                    lineHeight: '16px',
                  }}>
                    {post.group_name}
                  </span>
                )}
                <span style={{ fontSize: 10, color: tokens.colors.text.tertiary }}>
                  {formatTimeAgo(post.created_at, isZh)}
                </span>
              </div>

              {/* Title */}
              <p style={{
                fontSize: 13,
                fontWeight: 600,
                color: tokens.colors.text.primary,
                lineHeight: 1.4,
                margin: '0 0 3px 0',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
              }}>
                {post.title}
              </p>

              {/* Body preview */}
              {post.content && (
                <p style={{
                  fontSize: 11,
                  color: tokens.colors.text.secondary,
                  lineHeight: 1.4,
                  margin: '0 0 6px 0',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {post.content.slice(0, 60)}
                </p>
              )}

              {/* Stats row */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                fontSize: 11,
                color: tokens.colors.text.tertiary,
              }}>
                {post.author_handle && (
                  <span style={{ fontWeight: 500 }}>@{post.author_handle}</span>
                )}
                <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 9V5a3 3 0 0 0-6 0v4" /><path d="M5 9h14l1 12H4L5 9z" />
                  </svg>
                  {post.like_count}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  {post.comment_count}
                </span>
{/* view_count removed — not reliably tracked */}
              </div>
            </Link>
          ))}
        </div>
      )}
    </SidebarCard>
  )
}
