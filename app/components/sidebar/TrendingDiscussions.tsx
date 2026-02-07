'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { formatTimeAgo } from '@/lib/utils/date'

type TrendingPost = {
  id: string
  title: string
  author_handle: string | null
  comment_count: number
  like_count: number
  created_at: string
  group_id: string | null
}

export default function TrendingDiscussions() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [posts, setPosts] = useState<TrendingPost[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetch() {
      const { data } = await supabase
        .from('posts')
        .select('id, title, author_handle, comment_count, like_count, created_at, group_id')
        .eq('status', 'active')
        .order('hot_score', { ascending: false })
        .limit(20)
      setPosts((data as TrendingPost[]) || [])
      setLoading(false)
    }
    fetch()
  }, [])

  return (
    <div>
      <h3 style={{ fontSize: 14, fontWeight: 700, color: tokens.colors.text.primary, marginBottom: 12 }}>
        {isZh ? '热门讨论' : 'Trending Discussions'}
      </h3>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="skeleton" style={{ height: 48, borderRadius: 8 }} />
          ))}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {posts.map((post, idx) => (
            <Link
              key={post.id}
              href={`/hot?post=${post.id}`}
              style={{
                display: 'flex', gap: 8, padding: '8px 6px',
                textDecoration: 'none', borderRadius: 6,
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = tokens.colors.bg.secondary)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <span style={{
                fontSize: 12, fontWeight: 700, color: idx < 3 ? '#ff6b35' : tokens.colors.text.secondary,
                minWidth: 18, textAlign: 'right',
              }}>
                {idx + 1}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{
                  fontSize: 13, color: tokens.colors.text.primary, lineHeight: 1.3,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {post.title}
                </p>
                <div style={{ display: 'flex', gap: 8, fontSize: 11, color: tokens.colors.text.secondary, marginTop: 2 }}>
                  <span>{post.comment_count || 0} comments</span>
                  <span>{post.like_count || 0} likes</span>
                  <span>{formatTimeAgo(post.created_at, language)}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
