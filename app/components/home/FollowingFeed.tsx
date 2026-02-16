'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import PostCard from '@/app/components/post/components/PostCard'
import type { PostWithUserState } from '@/lib/types'
import { logger } from '@/lib/logger'
import { useToast } from '@/app/components/ui/Toast'

/** Score posts by freshness (10h half-life) + engagement */
function calculateFeedScore(post: PostWithUserState): number {
  const ageHours = (Date.now() - new Date(post.created_at).getTime()) / 3600000
  const freshness = Math.exp(-0.1 * ageHours)
  const engagement = (post.like_count || 0) * 2
    + (post.comment_count || 0) * 3
    + (post.repost_count || 0) * 4
  return freshness * 100 + engagement
}

export default function FollowingFeed() {
  const { user, loading: authLoading } = useAuthSession()
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const { showToast } = useToast()
  const [posts, setPosts] = useState<PostWithUserState[]>([])
  const [loading, setLoading] = useState(true)
  const [followingIds, setFollowingIds] = useState<string[]>([])

  useEffect(() => {
    if (authLoading) return
    if (!user) { setLoading(false); return }

    async function fetchFollowingPosts() {
      setLoading(true)
      try {
        // Get following list (needed for empty state check)
        const { data: follows } = await supabase
          .from('user_follows')
          .select('following_id')
          .eq('follower_id', user!.id)

        const ids = follows?.map(f => f.following_id) || []
        setFollowingIds(ids)

        if (ids.length === 0) { setLoading(false); return }

        // Get posts from followed users via RPC
        const { data: postsData, error: rpcError } = await supabase
          .rpc('get_following_feed', { p_user_id: user!.id, p_limit: 30 })

        if (rpcError) {
          logger.error('get_following_feed RPC error:', rpcError)
          throw rpcError
        }

        // Score and sort by relevance (freshness + engagement)
        const scoredPosts = ((postsData as PostWithUserState[]) || [])
          .sort((a, b) => calculateFeedScore(b) - calculateFeedScore(a))
        setPosts(scoredPosts)
      } catch (e) {
        logger.error('Failed to fetch following feed:', e)
        showToast(isZh ? '加载关注动态失败' : 'Failed to load feed', 'error')
      } finally {
        setLoading(false)
      }
    }

    fetchFollowingPosts()
  }, [user, authLoading, isZh, showToast])

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
          display: 'inline-block', padding: '8px 24px', borderRadius: tokens.radius.md,
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
          <div key={i} className="skeleton" style={{ height: 120, borderRadius: tokens.radius.lg }} />
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
        <Image src="/stickers/happy.png" alt="No posts yet" width={48} height={48} style={{ margin: '0 auto 8px', display: 'block', opacity: 0.7 }} />
        <p style={{ fontSize: 16, marginBottom: 8 }}>
          {isZh ? '关注你感兴趣的交易员' : "You haven't followed anyone yet"}
        </p>
        <p style={{ fontSize: 13 }}>
          {isZh ? '去排行榜发现有趣的交易员吧' : 'Discover interesting traders on the leaderboard'}
        </p>
        <a href="/rankings" style={{
          display: 'inline-block', marginTop: 16, padding: '8px 24px', borderRadius: tokens.radius.md,
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
