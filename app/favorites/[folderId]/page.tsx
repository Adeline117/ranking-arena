'use client'

import { useEffect, useState, use } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createPortal } from 'react-dom'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text, Button } from '@/app/components/Base'
import { RankingSkeleton } from '@/app/components/UI/Skeleton'
import EmptyState from '@/app/components/UI/EmptyState'
import { formatTimeAgo } from '@/lib/utils/date'
import { getCsrfHeaders } from '@/lib/api/client'
import { useToast } from '@/app/components/UI/Toast'

interface BookmarkFolder {
  id: string
  user_id: string
  name: string
  description?: string | null
  avatar_url?: string | null
  is_public: boolean
  is_default: boolean
  post_count: number
  subscriber_count: number
  created_at: string
  owner_handle?: string
  owner_avatar_url?: string | null
}

interface BookmarkedPost {
  bookmark_id: string
  bookmarked_at: string
  id: string
  title: string
  content: string | null
  author_id: string
  author_handle: string | null
  group_id?: string | null
  like_count: number | null
  comment_count: number | null
  bookmark_count: number | null
  created_at: string
}

export default function FolderDetailPage({ params }: { params: Promise<{ folderId: string }> }) {
  const resolvedParams = use(params)
  const folderId = resolvedParams.folderId
  const router = useRouter()
  const { showToast } = useToast()
  
  const [email, setEmail] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [folder, setFolder] = useState<BookmarkFolder | null>(null)
  const [posts, setPosts] = useState<BookmarkedPost[]>([])
  const [isOwner, setIsOwner] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  
  // 编辑状态
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editIsPublic, setEditIsPublic] = useState(false)
  const [saving, setSaving] = useState(false)
  
  // 订阅状态
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [subscribing, setSubscribing] = useState(false)
  const [subscriberCount, setSubscriberCount] = useState(0)
  
  // 帖子详情弹窗状态
  const [selectedPost, setSelectedPost] = useState<BookmarkedPost | null>(null)
  const [postDetailLoading, setPostDetailLoading] = useState(false)
  const [fullPostContent, setFullPostContent] = useState<string | null>(null)
  
  // 移除收藏状态
  const [removingBookmark, setRemovingBookmark] = useState<Record<string, boolean>>({})

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setEmail(data.session?.user?.email ?? null)
      setAccessToken(data.session?.access_token ?? null)
    })
  }, [])

  useEffect(() => {
    if (!folderId) {
      setLoading(false)
      return
    }

    const loadFolder = async () => {
      setLoading(true)
      setError(null)
      
      try {
        const headers: Record<string, string> = {}
        if (accessToken) {
          headers['Authorization'] = `Bearer ${accessToken}`
        }

        const response = await fetch(`/api/bookmark-folders/${folderId}`, { headers })
        const data = await response.json()

        if (!response.ok) {
          // data.error 可能是字符串或对象 {code, message}
          const errorMsg = typeof data.error === 'string' 
            ? data.error 
            : data.error?.message || '加载失败'
          setError(errorMsg)
          setLoading(false)
          return
        }

        setFolder(data.data?.folder || null)
        setPosts(data.data?.posts || [])
        setIsOwner(data.data?.is_owner || false)
        setIsSubscribed(data.data?.is_subscribed || false)
        setSubscriberCount(data.data?.folder?.subscriber_count || 0)
        
        // 初始化编辑表单
        if (data.data?.folder) {
          setEditName(data.data.folder.name)
          setEditDescription(data.data.folder.description || '')
          setEditIsPublic(data.data.folder.is_public)
        }
      } catch (err) {
        console.error('Error loading folder:', err)
        setError('网络错误')
      } finally {
        setLoading(false)
      }
    }

    loadFolder()
  }, [folderId, accessToken])

  const handleSave = async () => {
    if (!accessToken || !folder) return
    
    setSaving(true)
    try {
      const response = await fetch(`/api/bookmark-folders/${folderId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({
          name: editName,
          description: editDescription,
          is_public: editIsPublic,
        }),
      })

      const data = await response.json()
      
      if (response.ok) {
        setFolder(data.data?.folder || folder)
        setIsEditing(false)
      } else {
        showToast(data.error || '保存失败', 'error')
      }
    } catch (err) {
      showToast('网络错误', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!accessToken || !folder) return
    
    if (!confirm('确定要删除此收藏夹吗？收藏夹中的所有帖子将被移除。')) {
      return
    }

    try {
      const response = await fetch(`/api/bookmark-folders/${folderId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
      })

      const data = await response.json()
      
      if (response.ok) {
        router.push('/favorites')
      } else {
        showToast(data.error || '删除失败', 'error')
      }
    } catch (err) {
      showToast('网络错误', 'error')
    }
  }

  const handleSubscribe = async () => {
    if (!accessToken) {
      router.push('/login')
      return
    }
    
    if (!folder) return
    
    setSubscribing(true)
    try {
      const response = await fetch(`/api/bookmark-folders/${folderId}/subscribe`, {
        method: isSubscribed ? 'DELETE' : 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
      })

      const data = await response.json()
      
      if (response.ok) {
        setIsSubscribed(data.data?.is_subscribed ?? !isSubscribed)
        setSubscriberCount(data.data?.subscriber_count ?? subscriberCount)
      } else {
        showToast(data.error || (isSubscribed ? '取消收藏失败' : '收藏失败'), 'error')
      }
    } catch (err) {
      showToast('网络错误', 'error')
    } finally {
      setSubscribing(false)
    }
  }

  const getDefaultAvatar = (name: string) => {
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8']
    const index = name.charCodeAt(0) % colors.length
    return colors[index]
  }

  // 打开帖子详情弹窗
  const handleOpenPost = async (post: BookmarkedPost) => {
    setSelectedPost(post)
    setFullPostContent(post.content)
    
    // 如果内容被截断，加载完整内容
    if (post.content && post.content.length >= 200) {
      setPostDetailLoading(true)
      try {
        const response = await fetch(`/api/posts/${post.id}`)
        const data = await response.json()
        if (response.ok && data.data?.content) {
          setFullPostContent(data.data.content)
        }
      } catch (err) {
        console.error('Error loading post:', err)
      } finally {
        setPostDetailLoading(false)
      }
    }
  }

  // 关闭帖子详情弹窗
  const handleClosePost = () => {
    setSelectedPost(null)
    setFullPostContent(null)
  }

  // 移除收藏
  const handleRemoveBookmark = async (e: React.MouseEvent, postId: string, bookmarkId: string) => {
    e.stopPropagation()
    
    if (!accessToken) return
    
    setRemovingBookmark(prev => ({ ...prev, [postId]: true }))
    
    try {
      const response = await fetch(`/api/posts/${postId}/bookmark`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
      })
      
      if (response.ok) {
        // 从列表中移除
        setPosts(prev => prev.filter(p => p.bookmark_id !== bookmarkId))
        // 更新收藏夹计数
        if (folder) {
          setFolder({ ...folder, post_count: Math.max(0, folder.post_count - 1) })
        }
      } else {
        const data = await response.json()
        // 如果帖子不存在，也从列表中移除
        if (response.status === 404) {
          setPosts(prev => prev.filter(p => p.bookmark_id !== bookmarkId))
          if (folder) {
            setFolder({ ...folder, post_count: Math.max(0, folder.post_count - 1) })
          }
        } else {
          showToast(data.error || '移除失败', 'error')
        }
      }
    } catch (err) {
      console.error('Error removing bookmark:', err)
      showToast('网络错误', 'error')
    } finally {
      setRemovingBookmark(prev => ({ ...prev, [postId]: false }))
    }
  }

  // 帖子详情弹窗组件
  const PostDetailModal = () => {
    if (!selectedPost) return null
    
    const modalContent = (
      <div
        onClick={handleClosePost}
        role="dialog"
        aria-modal="true"
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.65)',
          display: 'grid',
          placeItems: 'center',
          padding: 16,
          zIndex: 1000,
          overflowY: 'auto',
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 'min(760px, 100%)',
            maxHeight: '90vh',
            overflowY: 'auto',
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: 16,
            background: tokens.colors.bg.secondary,
            padding: 24,
          }}
        >
          {/* 关闭按钮 */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
            <button
              onClick={handleClosePost}
              aria-label="关闭"
              style={{
                border: 'none',
                background: 'transparent',
                color: tokens.colors.text.secondary,
                cursor: 'pointer',
                fontSize: 24,
                width: 36,
                height: 36,
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ×
            </button>
          </div>
          
          {/* 帖子标题 */}
          <Text size="xl" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
            {selectedPost.title}
          </Text>
          
          {/* 帖子元信息 */}
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], marginBottom: tokens.spacing[4] }}>
            {selectedPost.author_handle && (
              <Link 
                href={`/u/${selectedPost.author_handle}`}
                style={{ color: tokens.colors.accent?.primary, textDecoration: 'none', fontSize: 14 }}
              >
                @{selectedPost.author_handle}
              </Link>
            )}
            <Text size="sm" color="tertiary">
              {formatTimeAgo(selectedPost.created_at)}
            </Text>
          </Box>
          
          {/* 帖子内容 */}
          {postDetailLoading ? (
            <Text size="sm" color="tertiary">加载中...</Text>
          ) : (
            <Text 
              size="base" 
              style={{ 
                lineHeight: 1.8, 
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {fullPostContent || selectedPost.content || ''}
            </Text>
          )}
          
          {/* 互动数据 */}
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4], marginTop: tokens.spacing[6], paddingTop: tokens.spacing[4], borderTop: `1px solid ${tokens.colors.border.primary}` }}>
            <Text size="sm" color="tertiary">
              {selectedPost.like_count || 0} 赞
            </Text>
            <Text size="sm" color="tertiary">
              {selectedPost.comment_count || 0} 评论
            </Text>
            <Text size="sm" color="tertiary">
              {selectedPost.bookmark_count || 0} 收藏
            </Text>
          </Box>
          
          {/* 查看完整帖子链接 */}
          <Box style={{ marginTop: tokens.spacing[4], textAlign: 'center' }}>
            <Link
              href={selectedPost.group_id ? `/groups/${selectedPost.group_id}?post=${selectedPost.id}` : `/groups?post=${selectedPost.id}`}
              style={{
                color: tokens.colors.accent?.primary,
                textDecoration: 'none',
                fontSize: 14,
              }}
            >
              查看完整帖子和评论 →
            </Link>
          </Box>
        </div>
      </div>
    )
    
    return createPortal(modalContent, document.body)
  }

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
          <RankingSkeleton />
        </Box>
      </Box>
    )
  }

  if (error || !folder) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
          <EmptyState
            title={error || '收藏夹不存在'}
            description="该收藏夹可能已被删除或您无权访问"
            action={
              <Link
                href="/favorites"
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
                返回我的收藏
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
        {/* 返回链接 */}
        <Link
          href="/favorites"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            color: tokens.colors.text.tertiary,
            textDecoration: 'none',
            fontSize: tokens.typography.fontSize.sm,
            marginBottom: tokens.spacing[4],
          }}
        >
          ← 返回收藏夹列表
        </Link>

        {/* 收藏夹头部 */}
        <Box
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: tokens.spacing[4],
            marginBottom: tokens.spacing[6],
            padding: tokens.spacing[4],
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          {/* 收藏夹头像 */}
          <Box
            style={{
              width: 64,
              height: 64,
              borderRadius: tokens.radius.lg,
              backgroundColor: folder.avatar_url ? undefined : getDefaultAvatar(folder.name),
              backgroundImage: folder.avatar_url ? `url(${folder.avatar_url})` : undefined,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {!folder.avatar_url && (
              <Text size="2xl" weight="bold" style={{ color: '#fff' }}>
                {folder.name.charAt(0).toUpperCase()}
              </Text>
            )}
          </Box>

          {/* 收藏夹信息 */}
          <Box style={{ flex: 1 }}>
            {isEditing ? (
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  disabled={folder.is_default}
                  placeholder="收藏夹名称"
                  style={{
                    padding: tokens.spacing[2],
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.primary,
                    color: tokens.colors.text.primary,
                    fontSize: tokens.typography.fontSize.lg,
                    fontWeight: 700,
                  }}
                />
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  placeholder="添加描述..."
                  style={{
                    padding: tokens.spacing[2],
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.primary,
                    color: tokens.colors.text.primary,
                    fontSize: tokens.typography.fontSize.sm,
                    minHeight: 60,
                    resize: 'vertical',
                  }}
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={editIsPublic}
                    onChange={(e) => setEditIsPublic(e.target.checked)}
                    style={{ width: 16, height: 16 }}
                  />
                  <Text size="sm">公开收藏夹（在主页展示）</Text>
                </label>
                <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
                  <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
                    {saving ? '保存中...' : '保存'}
                  </Button>
                  <Button variant="text" size="sm" onClick={() => setIsEditing(false)}>
                    取消
                  </Button>
                </Box>
              </Box>
            ) : (
              <>
                <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[1] }}>
                  <Text size="xl" weight="bold">{folder.name}</Text>
                  {folder.is_default && (
                    <span
                      style={{
                        fontSize: 10,
                        padding: '2px 6px',
                        background: tokens.colors.accent?.primary + '20',
                        color: tokens.colors.accent?.primary,
                        borderRadius: tokens.radius.sm,
                      }}
                    >
                      默认
                    </span>
                  )}
                  {folder.is_public ? (
                    <span
                      style={{
                        fontSize: 10,
                        padding: '2px 6px',
                        background: '#4ECDC420',
                        color: '#4ECDC4',
                        borderRadius: tokens.radius.sm,
                      }}
                    >
                      公开
                    </span>
                  ) : (
                    <span
                      style={{
                        fontSize: 10,
                        padding: '2px 6px',
                        background: 'rgba(255,255,255,0.1)',
                        color: tokens.colors.text.tertiary,
                        borderRadius: tokens.radius.sm,
                      }}
                    >
                      私密
                    </span>
                  )}
                </Box>
                {folder.description && (
                  <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
                    {folder.description}
                  </Text>
                )}
                <Text size="xs" color="tertiary">
                  {folder.post_count} 个收藏
                  {subscriberCount > 0 && ` · ${subscriberCount} 人收藏`}
                  {folder.owner_handle && (
                    <>
                      {' · '}
                      <Link 
                        href={`/u/${folder.owner_handle}`}
                        style={{ color: tokens.colors.text.tertiary, textDecoration: 'none' }}
                      >
                        @{folder.owner_handle}
                      </Link>
                    </>
                  )}
                </Text>
              </>
            )}
          </Box>

          {/* 操作按钮 */}
          {isOwner && !isEditing && (
            <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
              <Button variant="text" size="sm" onClick={() => setIsEditing(true)}>
                编辑
              </Button>
              {!folder.is_default && (
                <Button 
                  variant="text" 
                  size="sm" 
                  onClick={handleDelete}
                  style={{ color: tokens.colors.accent?.error || '#FF6B6B' }}
                >
                  删除
                </Button>
              )}
            </Box>
          )}
          
          {/* 非所有者的收藏按钮 */}
          {!isOwner && folder.is_public && (
            <Button
              variant={isSubscribed ? 'secondary' : 'primary'}
              size="sm"
              onClick={handleSubscribe}
              disabled={subscribing}
              style={{
                minWidth: 80,
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[1],
              }}
            >
              {subscribing ? (
                '处理中...'
              ) : isSubscribed ? (
                <>
                  <span style={{ fontSize: 14 }}>✓</span>
                  已收藏
                </>
              ) : (
                <>
                  <span style={{ fontSize: 14 }}>★</span>
                  收藏
                </>
              )}
            </Button>
          )}
        </Box>

        {/* 帖子列表 */}
        {posts.length === 0 ? (
          <EmptyState
            title="暂无收藏"
            description="收藏一些感兴趣的帖子后，它们会显示在这里"
          />
        ) : (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            {posts.map((post) => (
              <Box
                key={post.bookmark_id}
                onClick={() => handleOpenPost(post)}
                style={{
                  display: 'block',
                  padding: tokens.spacing[4],
                  borderRadius: tokens.radius.lg,
                  background: tokens.colors.bg.secondary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  cursor: 'pointer',
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
                
                <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacing[4] }}>
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
                        {post.like_count || 0} 赞
                      </Text>
                      <Text size="xs" color="tertiary">
                        {post.comment_count || 0} 评论
                      </Text>
                    </Box>
                  </Box>
                  
                  {/* 移除收藏按钮 - 只有所有者可以移除 */}
                  {isOwner && (
                    <button
                      onClick={(e) => handleRemoveBookmark(e, post.id, post.bookmark_id)}
                      disabled={removingBookmark[post.id]}
                      style={{
                        padding: '4px 8px',
                        borderRadius: tokens.radius.sm,
                        border: 'none',
                        background: 'transparent',
                        color: tokens.colors.text.tertiary,
                        fontSize: 12,
                        cursor: removingBookmark[post.id] ? 'wait' : 'pointer',
                        opacity: removingBookmark[post.id] ? 0.5 : 1,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = tokens.colors.accent?.error || '#FF6B6B'
                        e.currentTarget.style.background = 'rgba(255,107,107,0.1)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = tokens.colors.text.tertiary
                        e.currentTarget.style.background = 'transparent'
                      }}
                    >
                      {removingBookmark[post.id] ? '移除中...' : '移除'}
                    </button>
                  )}
                </Box>
              </Box>
            ))}
          </Box>
        )}
      </Box>
      
      {/* 帖子详情弹窗 */}
      <PostDetailModal />
    </Box>
  )
}
