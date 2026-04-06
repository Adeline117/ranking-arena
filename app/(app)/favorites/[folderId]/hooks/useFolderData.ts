'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getCsrfHeaders } from '@/lib/api/client'
import { useToast } from '@/app/components/ui/Toast'
import { useDialog } from '@/app/components/ui/Dialog'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'
import type { BookmarkFolder, BookmarkedPost } from '../types'

export function useFolderData(folderId: string) {
  const { t } = useLanguage()
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

  return {
    // Data
    folder,
    posts,
    isOwner,
    loading,
    error,
    email,
    // Edit state
    isEditing,
    setIsEditing,
    editName,
    setEditName,
    editDescription,
    setEditDescription,
    editIsPublic,
    setEditIsPublic,
    saving,
    // Subscribe state
    isSubscribed,
    subscribing,
    subscriberCount,
    // Post detail state
    selectedPost,
    postDetailLoading,
    fullPostContent,
    // Remove bookmark state
    removingBookmark,
    // Actions
    handleSave,
    handleDelete,
    handleSubscribe,
    handleOpenPost,
    handleClosePost,
    handleRemoveBookmark,
    // i18n
    t,
  }
}
