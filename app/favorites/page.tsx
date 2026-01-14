'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text } from '@/app/components/Base'
import { RankingSkeleton } from '@/app/components/UI/Skeleton'
import EmptyState from '@/app/components/UI/EmptyState'
import { formatTimeAgo } from '@/lib/utils/date'

interface FavoritePost {
  id: string
  post_id: string
  created_at: string
  post: {
    id: string
    title: string
    content: string | null
    author_handle: string | null
    created_at: string
    like_count: number | null
    comment_count: number | null
  } | null
}

export default function FavoritesPage() {
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [favorites, setFavorites] = useState<FavoritePost[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)
    })
  }, [])

  useEffect(() => {
    if (!userId) {
      setLoading(false)
      return
    }

    const load = async () => {
      setLoading(true)
      try {
        // 获取用户收藏的帖子
        const { data: bookmarks, error: bookmarksError } = await supabase
          .from('post_bookmarks')
          .select(`
            id,
            post_id,
            created_at,
            post:posts (
              id,
              title,
              content,
              author_handle,
              created_at,
              like_count,
              comment_count
            )
          `)
          .eq('user_id', userId)
          .order('created_at', { ascending: false })

        if (bookmarksError) {
          console.error('Error fetching bookmarks:', bookmarksError)
          setFavorites([])
          setLoading(false)
          return
        }

        setFavorites((bookmarks || []) as unknown as FavoritePost[])
      } catch (error) {
        console.error('Error loading favorites:', error)
        setFavorites([])
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [userId])

  if (!userId) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            我的收藏
          </Text>
          <EmptyState
            icon="❤️"
            title="请先登录"
            description="登录后可以查看您收藏的帖子"
            action={
              <Link
                href="/login"
                style={{
                  padding: '12px 24px',
                  background: tokens.colors.accent.primary,
                  color: '#fff',
                  borderRadius: tokens.radius.md,
                  textDecoration: 'none',
                  fontWeight: 900,
                  fontSize: '14px',
                }}
              >
                前往登录
              </Link>
            }
          />
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[6] }}>
          我的收藏
        </Text>
        
        {loading ? (
          <RankingSkeleton />
        ) : favorites.length === 0 ? (
          <EmptyState
            icon="❤️"
            title="暂无收藏"
            description="收藏一些感兴趣的帖子后，它们会显示在这里"
            action={
              <Link
                href="/groups"
                style={{
                  padding: '12px 24px',
                  background: tokens.colors.accent.primary,
                  color: '#fff',
                  borderRadius: tokens.radius.md,
                  textDecoration: 'none',
                  fontWeight: 900,
                  fontSize: '14px',
                }}
              >
                浏览帖子
              </Link>
            }
          />
        ) : (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            {favorites.map((fav) => {
              const post = fav.post
              if (!post) return null
              
              return (
                <Link
                  key={fav.id}
                  href={`/groups?post=${post.id}`}
                  style={{
                    display: 'block',
                    padding: tokens.spacing[4],
                    borderRadius: tokens.radius.lg,
                    background: tokens.colors.bg.secondary,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    textDecoration: 'none',
                    color: 'inherit',
                    transition: `all ${tokens.transition.base}`,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = tokens.colors.bg.tertiary || 'rgba(255,255,255,0.05)'
                    e.currentTarget.style.borderColor = tokens.colors.border.secondary || tokens.colors.border.primary
                    e.currentTarget.style.transform = 'translateX(4px)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = tokens.colors.bg.secondary
                    e.currentTarget.style.borderColor = tokens.colors.border.primary
                    e.currentTarget.style.transform = 'translateX(0)'
                  }}
                >
                  <Text size="base" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                    {post.title}
                  </Text>
                  
                  {post.content && (
                    <Text 
                      size="sm" 
                      color="secondary" 
                      style={{ 
                        marginBottom: tokens.spacing[3],
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                        lineHeight: 1.5,
                      }}
                    >
                      {post.content}
                    </Text>
                  )}
                  
                  <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4] }}>
                    {post.author_handle && (
                      <Text size="xs" color="tertiary">
                        @{post.author_handle}
                      </Text>
                    )}
                    <Text size="xs" color="tertiary">
                      {formatTimeAgo(post.created_at)}
                    </Text>
                    <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
                      <Text size="xs" color="tertiary">
                        ❤️ {post.like_count || 0}
                      </Text>
                      <Text size="xs" color="tertiary">
                        💬 {post.comment_count || 0}
                      </Text>
                    </Box>
                  </Box>
                </Link>
              )
            })}
          </Box>
        )}
      </Box>
    </Box>
  )
}

