'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import PostCard from '@/app/components/post/components/PostCard'
import type { PostWithUserState } from '@/lib/types'

export default function FollowingFeed() {
  const { user, loading: authLoading } = useAuthSession()
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [posts, setPosts] = useState<PostWithUserState[]>([])
  const [loading, setLoading] = useState(true)
  const [followingIds, setFollowingIds] = useState<string[]>([])

  useEffect(() => {
    if (authLoading) return
    if (!user) { setLoading(false); return }

    async function fetchFollowingPosts() {
      setLoading(true)
      try {
        // Get following list
        const { data: follows } = await supabase
          .from('user_follows')
          .select('following_id')
          .eq('follower_id', user!.id)

        const ids = follows?.map(f => f.following_id) || []
        setFollowingIds(ids)

        if (ids.length === 0) { setLoading(false); return }

        // Get posts from followed users
        const { data: postsData } = await supabase
          .from('posts')
          .select('*')
          .in('author_id', ids)
          .eq('status', 'active')
          .order('created_at', { ascending: false })
          .limit(30)

        setPosts((postsData as PostWithUserState[]) || [])
      } catch (e) {
        console.error('Failed to fetch following feed:', e)
      } finally {
        setLoading(false)
      }
    }

    fetchFollowingPosts()
  }, [user, authLoading])

  // Not logged in
  if (!authLoading && !user) {
    return (
      <div style={{
        textAlign: 'center', padding: '60px 20px',
        color: tokens.colors.text.secondary,
      }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>--</div>
        <p style={{ fontSize: 16, marginBottom: 12 }}>
          {isZh ? '登录后查看关注动态' : 'Login to see your following feed'}
        </p>
        <a href="/login" style={{
          display: 'inline-block', padding: '8px 24px', borderRadius: 8,
          background: tokens.colors.accent.brand, color: tokens.colors.white,
          textDecoration: 'none', fontWeight: 600, fontSize: 14,
        }}>
          {isZh ? '去登录' : 'Login'}
        </a>
      </div>
    )
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {[1, 2, 3].map(i => (
          <div key={i} className="skeleton" style={{ height: 120, borderRadius: 12 }} />
        ))}
      </div>
    )
  }

  // No following
  if (followingIds.length === 0) {
    return (
      <div style={{
        textAlign: 'center', padding: '60px 20px',
        color: tokens.colors.text.secondary,
      }}>
        <img src="/stickers/happy.png" alt="No posts yet" width={48} height={48} style={{ margin: '0 auto 8px', display: 'block', opacity: 0.7 }} />
        <p style={{ fontSize: 16, marginBottom: 8 }}>
          {isZh ? '关注你感兴趣的交易员' : "You haven't followed anyone yet"}
        </p>
        <p style={{ fontSize: 13 }}>
          {isZh ? '去排行榜发现有趣的交易员吧' : 'Discover interesting traders on the leaderboard'}
        </p>
        <a href="/rankings" style={{
          display: 'inline-block', marginTop: 16, padding: '8px 24px', borderRadius: 8,
          background: tokens.colors.accent.brand, color: tokens.colors.white,
          textDecoration: 'none', fontWeight: 600, fontSize: 14,
        }}>
          {isZh ? '去看排行榜' : 'View Rankings'}
        </a>
      </div>
    )
  }

  if (posts.length === 0) {
    return (
      <div style={{
        textAlign: 'center', padding: '60px 20px',
        color: tokens.colors.text.secondary,
      }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>--</div>
        <p>{isZh ? '关注的人还没有发布内容' : 'No posts from people you follow yet'}</p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {posts.map(post => (
        <PostCard key={post.id} post={post} variant="compact" />
      ))}
    </div>
  )
}
