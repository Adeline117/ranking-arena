'use client'

import { useEffect, useState, use } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
// MobileBottomNav is rendered by root layout — do not duplicate here
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import { Box, Text, Button } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import EmptyState from '@/app/components/ui/EmptyState'
import { formatTimeAgo } from '@/lib/utils/date'
import { getCsrfHeaders } from '@/lib/api/client'
import { useToast } from '@/app/components/ui/Toast'
import { useDialog } from '@/app/components/ui/Dialog'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'
import PostDetailModal from './components/PostDetailModal'

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
  const { t } = useLanguage()
  const resolvedParams = use(params)
  const folderId = resolvedParams.folderId
  const router = useRouter()
  const { showToast } = useToast()
  const { showDangerConfirm } = useDialog()
  const { accessToken, email } = useAuthSession()

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
            : data.error?.message || t('failedToLoad')
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
        logger.error('Error loading folder:', err)
        setError(t('networkError'))
      } finally {
        setLoading(false)
      }
    }

    loadFolder()
  }, [folderId, accessToken, t])

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
        showToast(t('saved'), 'success')
      } else {
        showToast(data.error || t('saveFailed2'), 'error')
      }
    } catch (err) {
      logger.error('Error saving folder:', err)
      showToast(t('networkError'), 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!accessToken || !folder) return

    const confirmed = await showDangerConfirm(
      t('deleteFolder'),
      t('deleteFolderConfirm')
    )
    if (!confirmed) {
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
        showToast(t('folderDeleted'), 'success')
        router.push('/favorites')
      } else {
        showToast(data.error || t('deleteFailed'), 'error')
      }
    } catch (err) {
      logger.error('Error deleting folder:', err)
      showToast(t('networkError'), 'error')
    }
  }

  const handleSubscribe = async () => {
    if (!accessToken) {
      router.push('/login?redirect=/favorites')
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
        showToast(data.data?.is_subscribed ? t('bookmarked') : t('unbookmarked'), 'success')
      } else {
        showToast(data.error || (isSubscribed ? t('unbookmarkFailed') : t('bookmarkFailed')), 'error')
      }
    } catch (err) {
      logger.error('Error subscribing to folder:', err)
      showToast(t('networkError'), 'error')
    } finally {
      setSubscribing(false)
    }
  }

  const getDefaultAvatar = (name: string) => {
    const colors = ['var(--color-accent-error)', 'var(--color-chart-teal)', 'var(--color-chart-blue)', 'var(--color-chart-sage)', 'var(--color-chart-yellow)', 'var(--color-chart-pink)', 'var(--color-chart-mint)']
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
        logger.error('Error loading post:', err)
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
        showToast(t('removedFromFavorites'), 'success')
      } else {
        const data = await response.json()
        // 如果帖子不存在，也从列表中移除
        if (response.status === 404) {
          setPosts(prev => prev.filter(p => p.bookmark_id !== bookmarkId))
          if (folder) {
            setFolder({ ...folder, post_count: Math.max(0, folder.post_count - 1) })
          }
        } else {
          showToast(data.error || t('removeFailed'), 'error')
        }
      }
    } catch (err) {
      logger.error('Error removing bookmark:', err)
      showToast(t('networkError'), 'error')
    } finally {
      setRemovingBookmark(prev => ({ ...prev, [postId]: false }))
    }
  }

  // PostDetailModal is now extracted to components/PostDetailModal.tsx

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
            title={error || t('folderNotFound')}
            description={t('folderNotFoundDesc')}
            action={
              <Link
                href="/favorites"
                style={{
                  padding: '12px 24px',
                  background: tokens.colors.accent.primary,
                  color: tokens.colors.white,
                  borderRadius: tokens.radius.md,
                  textDecoration: 'none',
                  fontWeight: 900,
                  fontSize: '14px',
                }}
              >
                {t('backToFavorites')}
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
      <Box className="has-mobile-nav" style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6], paddingBottom: 100 }}>
        <Breadcrumb items={[
          { label: t('favorites'), href: '/favorites' },
          { label: folder.name },
        ]} />
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
          ← {t('backToFolderList')}
        </Link>

        {/* 收藏夹头部 */}
        <Box
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            flexWrap: 'wrap',
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
              <Text size="2xl" weight="bold" style={{ color: tokens.colors.white }}>
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
                  placeholder={t('bookmarkFolderName')}
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
                  placeholder={t('addDescription')}
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
                  <Text size="sm">{t('publicFolderShowOnProfile')}</Text>
                </label>
                <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
                  <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
                    {saving ? t('saving') : t('save')}
                  </Button>
                  <Button variant="text" size="sm" onClick={() => setIsEditing(false)}>
                    {t('cancel')}
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
                      {t('defaultLabel')}
                    </span>
                  )}
                  {folder.is_public ? (
                    <span
                      style={{
                        fontSize: 10,
                        padding: '2px 6px',
                        background: 'var(--color-accent-success-20)',
                        color: 'var(--color-accent-success)',
                        borderRadius: tokens.radius.sm,
                      }}
                    >
                      {t('publicFolder')}
                    </span>
                  ) : (
                    <span
                      style={{
                        fontSize: 10,
                        padding: '2px 6px',
                        background: 'var(--glass-bg-medium)',
                        color: tokens.colors.text.tertiary,
                        borderRadius: tokens.radius.sm,
                      }}
                    >
                      {t('privateFolder')}
                    </span>
                  )}
                </Box>
                {folder.description && (
                  <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
                    {folder.description}
                  </Text>
                )}
                <Text size="xs" color="tertiary">
                  {t('itemCount').replace('{n}', String(folder.post_count))}
                  {subscriberCount > 0 && ` · ${t('subscriberCount').replace('{n}', String(subscriberCount))}`}
                  {folder.owner_handle && (
                    <>
                      {' · '}
                      <Link
                        href={`/u/${encodeURIComponent(folder.owner_handle)}`}
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
                {t('edit')}
              </Button>
              {!folder.is_default && (
                <Button 
                  variant="text" 
                  size="sm" 
                  onClick={handleDelete}
                  style={{ color: tokens.colors.accent?.error || 'var(--color-accent-error)' }}
                >
                  {t('delete')}
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
                t('processing')
              ) : isSubscribed ? (
                <>
                  <span style={{ fontSize: 14 }}>✓</span>
                  {t('bookmarked')}
                </>
              ) : (
                <>
                  <span style={{ fontSize: 14 }}>☆</span>
                  {t('bookmark')}
                </>
              )}
            </Button>
          )}
        </Box>

        {/* 帖子列表 */}
        {posts.length === 0 ? (
          <EmptyState
            title={t('noBookmarks')}
            description={t('noBookmarksDesc')}
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
                  e.currentTarget.style.background = tokens.colors.bg.tertiary || 'var(--overlay-hover)'
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
                
                <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacing[3], flexWrap: 'wrap' }}>
                  <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], flexWrap: 'wrap', minWidth: 0 }}>
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
                        {t('likesCount').replace('{n}', String(post.like_count || 0))}
                      </Text>
                      <Text size="xs" color="tertiary">
                        {t('commentsCount').replace('{n}', String(post.comment_count || 0))}
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
                        e.currentTarget.style.color = tokens.colors.accent?.error || 'var(--color-accent-error)'
                        e.currentTarget.style.background = 'var(--color-accent-error-10)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = tokens.colors.text.tertiary
                        e.currentTarget.style.background = 'transparent'
                      }}
                    >
                      {removingBookmark[post.id] ? t('removing') : t('remove')}
                    </button>
                  )}
                </Box>
              </Box>
            ))}
          </Box>
        )}
      </Box>
      
      {/* 帖子详情弹窗 */}
      <PostDetailModal
        post={selectedPost}
        fullContent={fullPostContent}
        loading={postDetailLoading}
        t={t}
        onClose={handleClosePost}
      />
      {/* MobileBottomNav rendered in root layout */}
    </Box>
  )
}
