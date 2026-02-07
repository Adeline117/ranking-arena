'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
// date utils not needed for compact view

type TrendingPost = {
  id: string
  title: string
  body: string | null
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
        .select('id, title, body, author_handle, comment_count, like_count, created_at, group_id')
        .eq('status', 'active')
        .order('hot_score', { ascending: false })
        .limit(8)
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
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{
                  fontSize: 13, fontWeight: 600, color: tokens.colors.text.primary, lineHeight: 1.3,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  margin: 0,
                }}>
                  {post.title}
                </p>
                {post.body && (
                  <p style={{
                    fontSize: 12, color: tokens.colors.text.secondary, lineHeight: 1.3,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    margin: '2px 0 0 0',
                  }}>
                    {post.body.slice(0, 80)}
                  </p>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
