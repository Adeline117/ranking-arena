'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text, Button } from '@/app/components/base'
import { PostSkeleton } from '@/app/components/ui/Skeleton'
import EmptyState from '@/app/components/ui/EmptyState'
import { formatTimeAgo } from '@/lib/utils/date'
import { useToast } from '@/app/components/ui/Toast'
import { useDialog } from '@/app/components/ui/Dialog'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

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
    name_en?: string | null
  } | null
}


export default function MyPostsPage() {
  const router = useRouter()
  const { showToast } = useToast()
  const { showDangerConfirm } = useDialog()
  const { language, t } = useLanguage()
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [userHandle, setUserHandle] = useState<string | null>(null)
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const PAGE_SIZE = 20
  const offsetRef = useRef(0)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)

      if (data.user?.id) {
        loadUserHandle(data.user.id)
      }
    }).catch(() => { /* Intentionally swallowed: auth check non-critical for my-posts page init */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
  }, [])

  const loadUserHandle = async (uid: string) => {
    try {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('handle')
        .eq('id', uid)
        .maybeSingle()

      if (profile?.handle) {
        setUserHandle(profile.handle)
      }
    } catch (error) {
      logger.error('Error loading user handle:', error)
    }
  }

  const fetchPosts = useCallback(async (offset: number, append: boolean) => {
    if (!userId) return
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`

      const params = new URLSearchParams({
        author_id: userId,
        sort_by: 'created_at',
        sort_order: 'desc',
        limit: String(PAGE_SIZE),
        offset: String(offset),
      })
      const res = await fetch(`/api/posts?${params.toString()}`, { headers })
      const data = await res.json()

      if (!res.ok) {
        logger.error('Error fetching posts:', data.error)
        if (!append) setPosts([])
        showToast(t('loadPostsFailed'), 'error')
        return
      }

      const loadedPosts = (data.data?.posts || []).map((p: Record<string, unknown>) => ({
        id: p.id,
        title: p.title || '',
        content: p.content || null,
        created_at: p.created_at as string,
        like_count: (p.like_count as number) || 0,
        comment_count: (p.comment_count as number) || 0,
        group_id: p.group_id || null,
        group: p.group_name ? { name: p.group_name as string, name_en: p.group_name_en as string | null } : null,
      })) as Post[]

      if (append) {
        setPosts(prev => [...prev, ...loadedPosts])
      } else {
        setPosts(loadedPosts)
      }
      offsetRef.current = offset + loadedPosts.length
      setHasMore(loadedPosts.length >= PAGE_SIZE)
    } catch (error) {
      logger.error('Error loading posts:', error)
      if (!append) setPosts([])
      showToast(t('loadPostsFailed'), 'error')
    }
  }, [userId, showToast, t])

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    await fetchPosts(offsetRef.current, true)
    setLoadingMore(false)
  }, [loadingMore, hasMore, fetchPosts])

  useEffect(() => {
    if (!userId) {
      setLoading(false)
      return
    }

    const load = async () => {
      setLoading(true)
      offsetRef.current = 0
      await fetchPosts(0, false)
      setLoading(false)
    }

    load()
  }, [userId, fetchPosts])

  const handleDelete = async (postId: string) => {
    const confirmed = await showDangerConfirm(
      t('deletePostTitle'),
      t('deletePostMessage')
    )
    
    if (!confirmed) return

    setDeleting(postId)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`

      const res = await fetch(`/api/posts/${postId}`, { method: 'DELETE', headers })
      if (!res.ok) {
        showToast(t('deleteFailedRetry'), 'error')
        return
      }

      setPosts(prev => prev.filter(p => p.id !== postId))
      showToast(t('postDeleted'), 'success')
    } catch (error) {
      logger.error('Error deleting post:', error)
      showToast(t('deleteFailedRetry'), 'error')
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
            {t('myPosts')}
          </Text>
          <EmptyState
            title={t('pleaseLoginFirst')}
            description={t('loginToManagePosts')}
            action={
              <Link
                href="/login?redirect=/my-posts"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minHeight: 44,
                  padding: '12px 24px',
                  background: tokens.colors.accent.primary,
                  color: tokens.colors.white,
                  borderRadius: tokens.radius.md,
                  textDecoration: 'none',
                  fontWeight: 900,
                  fontSize: '14px',
                }}
              >
                {t('goToLogin')}
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
      <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6], paddingBottom: 100 }}>
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[6] }}>
          <Text size="2xl" weight="black">
            {t('myPosts')}
          </Text>
          {userHandle && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => router.push(`/u/${userHandle}/new`)}
            >
              {t('publishNewPost')}
            </Button>
          )}
        </Box>
        
        {loading ? (
          <>
            <PostSkeleton />
            <PostSkeleton />
            <PostSkeleton />
          </>
        ) : posts.length === 0 ? (
          <EmptyState
            title={t('noPosts')}
            description={t('noPostsDescription')}
            action={userHandle ? (
              <Button
                variant="primary"
                onClick={() => router.push(`/u/${userHandle}/new`)}
              >
                {t('publishPost')}
              </Button>
            ) : undefined}
          />
        ) : (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3], animation: 'fadeIn 0.3s ease-out' }}>
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
                    href={`/post/${post.id}`}
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
                          {language === 'zh' ? post.group.name : (post.group.name_en || post.group.name)}
                        </Text>
                      )}
                      <Text size="xs" color="tertiary">
                        {formatTimeAgo(post.created_at)}
                      </Text>
                      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
                        <Text size="xs" color="tertiary">
                          {post.like_count || 0} {t('likes')}
                        </Text>
                        <Text size="xs" color="tertiary">
                          {post.comment_count || 0} {t('comment')}
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
                      {t('edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(post.id)}
                      disabled={deleting === post.id}
                      style={{ color: tokens.colors.accent.error }}
                    >
                      {deleting === post.id ? t('deleting') : t('delete')}
                    </Button>
                  </Box>
                </Box>
              </Box>
            ))}
            {hasMore && (
              <Box style={{ display: 'flex', justifyContent: 'center', padding: tokens.spacing[4] }}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore
                    ? (language === 'zh' ? '加载中...' : 'Loading...')
                    : (language === 'zh' ? '加载更多' : 'Load More')}
                </Button>
              </Box>
            )}
          </Box>
        )}
      </Box>
    </Box>
  )
}

