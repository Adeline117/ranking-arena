'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text, Button } from '@/app/components/Base'
import { RankingSkeleton } from '@/app/components/UI/Skeleton'
import EmptyState from '@/app/components/UI/EmptyState'
import { formatTimeAgo } from '@/lib/utils/date'
import { useToast } from '@/app/components/UI/Toast'
import { useDialog } from '@/app/components/UI/Dialog'

interface Post {
  id: string
  title: string
  content: string | null
  created_at: string
  like_count: number | null
  comment_count: number | null
  group_id: string | null
  group?: {
    name: string
  } | null
}

export default function MyPostsPage() {
  const router = useRouter()
  const { showToast } = useToast()
  const { showDangerConfirm } = useDialog()
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [userHandle, setUserHandle] = useState<string | null>(null)
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)
      
      if (data.user?.id) {
        loadUserHandle(data.user.id)
      }
    })
  }, [])

  const loadUserHandle = async (uid: string) => {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('handle')
      .eq('id', uid)
      .maybeSingle()
    
    if (profile?.handle) {
      setUserHandle(profile.handle)
    }
  }

  useEffect(() => {
    if (!userId) {
      setLoading(false)
      return
    }

    const load = async () => {
      setLoading(true)
      try {
        const { data: postsData, error: postsError } = await supabase
          .from('posts')
          .select(`
            id,
            title,
            content,
            created_at,
            like_count,
            comment_count,
            group_id,
            group:groups (
              name
            )
          `)
          .eq('author_id', userId)
          .order('created_at', { ascending: false })

        if (postsError) {
          console.error('Error fetching posts:', postsError)
          setPosts([])
          setLoading(false)
          return
        }

        setPosts((postsData || []) as unknown as Post[])
      } catch (error) {
        console.error('Error loading posts:', error)
        setPosts([])
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [userId])

  const handleDelete = async (postId: string) => {
    const confirmed = await showDangerConfirm(
      '删除帖子',
      '确定要删除这篇帖子吗？此操作不可撤销。'
    )
    
    if (!confirmed) return

    setDeleting(postId)
    try {
      const { error } = await supabase
        .from('posts')
        .delete()
        .eq('id', postId)
        .eq('author_id', userId)

      if (error) {
        showToast('删除失败，请重试', 'error')
        return
      }

      setPosts(prev => prev.filter(p => p.id !== postId))
      showToast('帖子已删除', 'success')
    } catch (error) {
      console.error('Error deleting post:', error)
      showToast('删除失败，请重试', 'error')
    } finally {
      setDeleting(null)
    }
  }

  if (!userId) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            我的帖子
          </Text>
          <EmptyState
            icon="📝"
            title="请先登录"
            description="登录后可以查看和管理您发布的帖子"
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
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[6] }}>
          <Text size="2xl" weight="black">
            我的帖子
          </Text>
          {userHandle && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => router.push(`/u/${userHandle}/new`)}
            >
              发布新帖子
            </Button>
          )}
        </Box>
        
        {loading ? (
          <RankingSkeleton />
        ) : posts.length === 0 ? (
          <EmptyState
            icon="📝"
            title="暂无帖子"
            description="发布您的第一篇帖子，分享交易见解"
            action={userHandle ? (
              <Button
                variant="primary"
                onClick={() => router.push(`/u/${userHandle}/new`)}
              >
                发布帖子
              </Button>
            ) : undefined}
          />
        ) : (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            {posts.map((post) => (
              <Box
                key={post.id}
                style={{
                  padding: tokens.spacing[4],
                  borderRadius: tokens.radius.lg,
                  background: tokens.colors.bg.secondary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                }}
              >
                <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: tokens.spacing[4] }}>
                  <Link
                    href={post.group_id ? `/groups/${post.group_id}?post=${post.id}` : `/groups?post=${post.id}`}
                    style={{
                      flex: 1,
                      textDecoration: 'none',
                      color: 'inherit',
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
                      {post.group && (
                        <Text size="xs" color="tertiary">
                          📁 {post.group.name}
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
                  
                  <Box style={{ display: 'flex', gap: tokens.spacing[2], flexShrink: 0 }}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => router.push(`/post/${post.id}/edit`)}
                    >
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(post.id)}
                      disabled={deleting === post.id}
                      style={{ color: tokens.colors.accent.error }}
                    >
                      {deleting === post.id ? '删除中...' : '删除'}
                    </Button>
                  </Box>
                </Box>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  )
}

