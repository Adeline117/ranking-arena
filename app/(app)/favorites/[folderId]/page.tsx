'use client'

import { useEffect, useRef, useState, use } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { tokens, alpha } from '@/lib/design-tokens'
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
import { isViewerScopeCurrent, type ViewerKey } from '@/lib/auth/viewer-scope'
import dynamic from 'next/dynamic'
import { buildFavoriteFolderLoginHref } from './login-intent'

// Lazy load: modal only opens when user clicks a post
const PostDetailModal = dynamic(() => import('./components/PostDetailModal'), { ssr: false })

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
  created_at: string | null
  owner_handle?: string | null
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

type FolderDetailPayload = {
  folder: BookmarkFolder
  posts: BookmarkedPost[]
  isOwner: boolean
  isSubscribed: boolean
  pagination: {
    limit: number
    offset: number
    hasMore: boolean
  }
}

type FolderRequestScope = {
  viewerKey: ViewerKey
  sessionGeneration: number
  userId: string | null
  folderId: string
}

type OperationKind = 'save' | 'delete' | 'subscribe' | 'post-detail'
type PostsMoreStatus = 'idle' | 'loading' | 'error'

const FOLDER_REQUEST_TIMEOUT_MS = 15_000
const FOLDER_POST_PAGE_LIMIT = 20

class FolderDetailLoadError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string'
}

function isSafeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isBookmarkFolder(value: unknown, expectedFolderId: string): value is BookmarkFolder {
  if (!isRecord(value)) return false
  return (
    value.id === expectedFolderId &&
    typeof value.user_id === 'string' &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    isNullableString(value.description) &&
    isNullableString(value.avatar_url) &&
    typeof value.is_public === 'boolean' &&
    typeof value.is_default === 'boolean' &&
    isSafeCount(value.post_count) &&
    isSafeCount(value.subscriber_count) &&
    (value.created_at === null || typeof value.created_at === 'string') &&
    isNullableString(value.owner_handle) &&
    isNullableString(value.owner_avatar_url)
  )
}

function isBookmarkedPost(value: unknown): value is BookmarkedPost {
  if (!isRecord(value)) return false
  return (
    typeof value.bookmark_id === 'string' &&
    value.bookmark_id.length > 0 &&
    typeof value.bookmarked_at === 'string' &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.title === 'string' &&
    (value.content === null || typeof value.content === 'string') &&
    typeof value.author_id === 'string' &&
    (value.author_handle === null || typeof value.author_handle === 'string') &&
    isNullableString(value.group_id) &&
    (value.like_count === null || isSafeCount(value.like_count)) &&
    (value.comment_count === null || isSafeCount(value.comment_count)) &&
    (value.bookmark_count === null || isSafeCount(value.bookmark_count)) &&
    typeof value.created_at === 'string'
  )
}

function apiErrorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback
  const directError = payload.error
  if (typeof directError === 'string') return directError
  if (isRecord(directError) && typeof directError.message === 'string') {
    return directError.message
  }
  if (isRecord(payload.data)) {
    const nestedError = payload.data.error
    if (typeof nestedError === 'string') return nestedError
    if (isRecord(nestedError) && typeof nestedError.message === 'string') {
      return nestedError.message
    }
  }
  return fallback
}

async function readFolderDetail(
  response: Response,
  expectedFolderId: string,
  fallbackError: string,
  expectedOffset = 0
): Promise<FolderDetailPayload> {
  const payload: unknown = await response.json()
  if (!response.ok) throw new FolderDetailLoadError(apiErrorMessage(payload, fallbackError))
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.data)) {
    throw new FolderDetailLoadError(fallbackError)
  }

  const { folder, posts, is_owner: isOwner, is_subscribed: isSubscribed, pagination } = payload.data
  if (
    !isBookmarkFolder(folder, expectedFolderId) ||
    !Array.isArray(posts) ||
    !posts.every(isBookmarkedPost) ||
    new Set(posts.map((post) => post.bookmark_id)).size !== posts.length ||
    new Set(posts.map((post) => post.id)).size !== posts.length ||
    typeof isOwner !== 'boolean' ||
    typeof isSubscribed !== 'boolean' ||
    (isOwner && isSubscribed) ||
    (!folder.is_public && !isOwner) ||
    (!folder.is_public && isSubscribed) ||
    !isRecord(pagination) ||
    pagination.limit !== FOLDER_POST_PAGE_LIMIT ||
    pagination.offset !== expectedOffset ||
    typeof pagination.has_more !== 'boolean' ||
    posts.length > FOLDER_POST_PAGE_LIMIT ||
    (pagination.has_more &&
      (posts.length !== FOLDER_POST_PAGE_LIMIT ||
        folder.post_count <= expectedOffset + FOLDER_POST_PAGE_LIMIT)) ||
    (!pagination.has_more &&
      posts.length > 0 &&
      folder.post_count !== expectedOffset + posts.length) ||
    (!pagination.has_more && posts.length === 0 && folder.post_count > expectedOffset)
  ) {
    throw new FolderDetailLoadError(fallbackError)
  }

  return {
    folder,
    posts,
    isOwner,
    isSubscribed,
    pagination: {
      limit: FOLDER_POST_PAGE_LIMIT,
      offset: expectedOffset,
      hasMore: pagination.has_more,
    },
  }
}

function readUpdatedFolder(payload: unknown, expectedFolderId: string) {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.data)) return null
  const folder = payload.data.folder
  if (
    !isRecord(folder) ||
    folder.id !== expectedFolderId ||
    typeof folder.user_id !== 'string' ||
    typeof folder.name !== 'string' ||
    folder.name.length === 0 ||
    !isNullableString(folder.description) ||
    !isNullableString(folder.avatar_url) ||
    typeof folder.is_public !== 'boolean' ||
    typeof folder.is_default !== 'boolean' ||
    !isSafeCount(folder.post_count)
  ) {
    return null
  }
  return {
    name: folder.name,
    description: folder.description as string | null | undefined,
    avatar_url: folder.avatar_url as string | null | undefined,
    is_public: folder.is_public,
    is_default: folder.is_default,
    post_count: folder.post_count,
  }
}

function readSubscriptionMutation(payload: unknown) {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.data)) return null
  const { is_subscribed: isSubscribed, subscriber_count: subscriberCount } = payload.data
  if (typeof isSubscribed !== 'boolean' || !isSafeCount(subscriberCount)) return null
  if (isSubscribed && subscriberCount < 1) return null
  return { isSubscribed, subscriberCount }
}

function readBookmarkRemoval(payload: unknown, expected: { bookmarkId: string; folderId: string }) {
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, [
      'action',
      'already_removed',
      'bookmark_count',
      'bookmark_id',
      'bookmarked',
      'folder_id',
    ]) ||
    payload.action !== 'removed' ||
    payload.bookmarked !== false ||
    payload.bookmark_id !== expected.bookmarkId ||
    payload.folder_id !== expected.folderId ||
    typeof payload.already_removed !== 'boolean' ||
    !isSafeCount(payload.bookmark_count)
  ) {
    return null
  }
  return { bookmarkCount: payload.bookmark_count }
}

function isFolderRequestScopeCurrent(
  expected: FolderRequestScope,
  current: FolderRequestScope
): boolean {
  return (
    expected.viewerKey === current.viewerKey &&
    expected.sessionGeneration === current.sessionGeneration &&
    expected.userId === current.userId &&
    expected.folderId === current.folderId &&
    isViewerScopeCurrent(expected)
  )
}

export default function FolderDetailPage({ params }: { params: Promise<{ folderId: string }> }) {
  const { t, language } = useLanguage()
  const tRef = useRef(t)
  tRef.current = t
  const resolvedParams = use(params)
  const folderId = resolvedParams.folderId
  const router = useRouter()
  const { showToast } = useToast()
  const { showDangerConfirm } = useDialog()
  const { accessToken, authChecked, userId, viewerKey, sessionGeneration } = useAuthSession()

  const [folder, setFolder] = useState<BookmarkFolder | null>(null)
  const [posts, setPosts] = useState<BookmarkedPost[]>([])
  const [isOwner, setIsOwner] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dataResourceKey, setDataResourceKey] = useState<string | null>(null)
  const [postsHasMore, setPostsHasMore] = useState(false)
  const [postsNextOffset, setPostsNextOffset] = useState(0)
  const [postsMoreStatus, setPostsMoreStatus] = useState<PostsMoreStatus>('idle')

  // 编辑状态
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editIsPublic, setEditIsPublic] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

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

  const resourceKey = `${viewerKey}\u0000${sessionGeneration}\u0000${folderId}`
  const currentScopeRef = useRef<FolderRequestScope>({
    viewerKey,
    sessionGeneration,
    userId,
    folderId,
  })
  currentScopeRef.current = { viewerKey, sessionGeneration, userId, folderId }
  const stateResourceKeyRef = useRef(resourceKey)
  const loadRequestIdRef = useRef(0)
  const loadControllerRef = useRef<AbortController | null>(null)
  const postsPageRequestIdRef = useRef(0)
  const postsPageControllerRef = useRef<AbortController | null>(null)
  const operationIdsRef = useRef<Record<OperationKind, number>>({
    save: 0,
    delete: 0,
    subscribe: 0,
    'post-detail': 0,
  })
  const removeRequestIdsRef = useRef<Record<string, number>>({})
  const postDetailControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const resourceChanged = stateResourceKeyRef.current !== resourceKey
    if (resourceChanged) {
      stateResourceKeyRef.current = resourceKey
      loadControllerRef.current?.abort()
      postsPageControllerRef.current?.abort()
      postDetailControllerRef.current?.abort()
      loadRequestIdRef.current += 1
      postsPageRequestIdRef.current += 1
      for (const operation of Object.keys(operationIdsRef.current) as OperationKind[]) {
        operationIdsRef.current[operation] += 1
      }
      removeRequestIdsRef.current = {}
      setFolder(null)
      setPosts([])
      setIsOwner(false)
      setIsSubscribed(false)
      setSubscriberCount(0)
      setIsEditing(false)
      setSaving(false)
      setDeleting(false)
      setSubscribing(false)
      setSelectedPost(null)
      setFullPostContent(null)
      setPostDetailLoading(false)
      setRemovingBookmark({})
      setError(null)
      setDataResourceKey(null)
      setPostsHasMore(false)
      setPostsNextOffset(0)
      setPostsMoreStatus('idle')
    }

    if (!folderId) {
      setLoading(false)
      return
    }

    // 硬加载/刷新时,useAuthSession 初始 accessToken=null、authChecked=false。
    // 若此刻就发请求,会以未鉴权身份打 /api/bookmark-folders/[id],owner 访问
    // 自己的私密夹被误判无权(403)。更糟:该未鉴权失败响应可能晚于随后的鉴权
    // 重试返回,覆盖已成功的 state → 用户在硬加载/分享链接/刷新时稳定看到
    // 「无权访问」。对策:等 authChecked 后再取数(此时 token 已就绪),并用
    // viewer generation + folder request ownership 忽略陈旧响应。
    if (!authChecked) {
      setLoading(true)
      return
    }

    loadControllerRef.current?.abort()
    postsPageControllerRef.current?.abort()
    postsPageRequestIdRef.current += 1
    setPostsMoreStatus('idle')
    const controller = new AbortController()
    loadControllerRef.current = controller
    const requestId = ++loadRequestIdRef.current
    const scope: FolderRequestScope = {
      viewerKey,
      sessionGeneration,
      userId,
      folderId,
    }
    let timedOut = false
    const timeoutId = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, FOLDER_REQUEST_TIMEOUT_MS)

    const loadFolder = async () => {
      setLoading(true)
      setError(null)

      try {
        const headers: Record<string, string> = {}
        if (accessToken) {
          headers['Authorization'] = `Bearer ${accessToken}`
        }

        const response = await fetch(`/api/bookmark-folders/${folderId}`, {
          headers,
          signal: controller.signal,
        })
        const detail = await readFolderDetail(response, folderId, tRef.current('failedToLoad'))
        if (
          controller.signal.aborted ||
          loadRequestIdRef.current !== requestId ||
          !isFolderRequestScopeCurrent(scope, currentScopeRef.current)
        ) {
          return
        }

        setFolder(detail.folder)
        setPosts(detail.posts)
        setPostsHasMore(detail.pagination.hasMore)
        setPostsNextOffset(detail.pagination.offset + detail.posts.length)
        setPostsMoreStatus('idle')
        setIsOwner(detail.isOwner)
        setIsSubscribed(detail.isSubscribed)
        setSubscriberCount(detail.folder.subscriber_count)
        setDataResourceKey(resourceKey)

        // 初始化编辑表单
        setEditName(detail.folder.name)
        setEditDescription(detail.folder.description || '')
        setEditIsPublic(detail.folder.is_public)
      } catch (err) {
        if (
          (!timedOut && controller.signal.aborted) ||
          loadRequestIdRef.current !== requestId ||
          !isFolderRequestScopeCurrent(scope, currentScopeRef.current)
        ) {
          return
        }
        logger.error('Error loading folder:', err)
        setFolder(null)
        setPosts([])
        setPostsHasMore(false)
        setPostsNextOffset(0)
        setPostsMoreStatus('idle')
        setError(err instanceof FolderDetailLoadError ? err.message : tRef.current('networkError'))
        setDataResourceKey(resourceKey)
      } finally {
        clearTimeout(timeoutId)
        if (
          loadRequestIdRef.current === requestId &&
          isFolderRequestScopeCurrent(scope, currentScopeRef.current)
        ) {
          setLoading(false)
        }
        if (loadControllerRef.current === controller) {
          loadControllerRef.current = null
        }
      }
    }

    void loadFolder()

    return () => {
      clearTimeout(timeoutId)
      controller.abort()
    }
  }, [folderId, accessToken, authChecked, resourceKey, sessionGeneration, userId, viewerKey])

  useEffect(
    () => () => {
      loadControllerRef.current?.abort()
      postsPageControllerRef.current?.abort()
      postDetailControllerRef.current?.abort()
      loadRequestIdRef.current += 1
      postsPageRequestIdRef.current += 1
      for (const operation of Object.keys(operationIdsRef.current) as OperationKind[]) {
        operationIdsRef.current[operation] += 1
      }
      removeRequestIdsRef.current = {}
    },
    []
  )

  const captureScope = (): FolderRequestScope => ({
    viewerKey,
    sessionGeneration,
    userId,
    folderId,
  })

  const isOperationCurrent = (
    operation: OperationKind,
    operationId: number,
    scope: FolderRequestScope
  ): boolean =>
    operationIdsRef.current[operation] === operationId &&
    isFolderRequestScopeCurrent(scope, currentScopeRef.current)

  const handleLoadMorePosts = async () => {
    if (
      !folder ||
      loading ||
      dataResourceKey !== resourceKey ||
      postsMoreStatus === 'loading' ||
      !postsHasMore ||
      postsPageControllerRef.current
    ) {
      return
    }

    const scope = captureScope()
    if (!isFolderRequestScopeCurrent(scope, currentScopeRef.current)) return
    const expectedOffset = postsNextOffset
    const existingPosts = posts
    const expectedOwnerId = folder.user_id
    const expectedIsOwner = isOwner
    if (expectedOffset !== existingPosts.length) {
      logger.error('Folder post pagination offset no longer matches the visible list')
      setPostsMoreStatus('error')
      return
    }

    const controller = new AbortController()
    postsPageControllerRef.current = controller
    const requestId = ++postsPageRequestIdRef.current
    let timedOut = false
    const timeoutId = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, FOLDER_REQUEST_TIMEOUT_MS)
    setPostsMoreStatus('loading')

    try {
      const headers: Record<string, string> = {}
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`
      const response = await fetch(
        `/api/bookmark-folders/${folderId}?limit=${FOLDER_POST_PAGE_LIMIT}&offset=${expectedOffset}`,
        { headers, signal: controller.signal }
      )
      const detail = await readFolderDetail(
        response,
        folderId,
        tRef.current('loadMoreFailed'),
        expectedOffset
      )
      if (
        controller.signal.aborted ||
        postsPageRequestIdRef.current !== requestId ||
        !isFolderRequestScopeCurrent(scope, currentScopeRef.current)
      ) {
        return
      }
      if (detail.folder.user_id !== expectedOwnerId || detail.isOwner !== expectedIsOwner) {
        throw new FolderDetailLoadError(tRef.current('loadMoreFailed'))
      }
      const bookmarkIds = new Set(existingPosts.map((post) => post.bookmark_id))
      const postIds = new Set(existingPosts.map((post) => post.id))
      if (detail.posts.some((post) => bookmarkIds.has(post.bookmark_id) || postIds.has(post.id))) {
        throw new FolderDetailLoadError(tRef.current('loadMoreFailed'))
      }

      setPosts([...existingPosts, ...detail.posts])
      setPostsHasMore(detail.pagination.hasMore)
      setPostsNextOffset(detail.pagination.offset + detail.posts.length)
      setPostsMoreStatus('idle')
      setFolder((currentFolder) =>
        currentFolder?.id === folderId
          ? { ...currentFolder, post_count: detail.folder.post_count }
          : currentFolder
      )
    } catch (err) {
      if (
        (!timedOut && controller.signal.aborted) ||
        postsPageRequestIdRef.current !== requestId ||
        !isFolderRequestScopeCurrent(scope, currentScopeRef.current)
      ) {
        return
      }
      logger.error('Error loading more folder posts:', err)
      setPostsMoreStatus('error')
    } finally {
      clearTimeout(timeoutId)
      if (postsPageControllerRef.current === controller) {
        postsPageControllerRef.current = null
      }
    }
  }

  const handleSave = async () => {
    if (!accessToken || !folder) return

    const scope = captureScope()
    if (!isFolderRequestScopeCurrent(scope, currentScopeRef.current)) return
    const operationId = ++operationIdsRef.current.save

    setSaving(true)
    try {
      const response = await fetch(`/api/bookmark-folders/${folderId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          name: editName,
          description: editDescription,
          is_public: editIsPublic,
        }),
      })

      const data: unknown = await response.json()
      if (!isOperationCurrent('save', operationId, scope)) return

      if (response.ok) {
        const updatedFolder = readUpdatedFolder(data, folderId)
        if (!updatedFolder) throw new Error('Folder update returned an invalid payload')
        setFolder((currentFolder) =>
          currentFolder
            ? {
                ...currentFolder,
                name: updatedFolder.name,
                description: updatedFolder.description,
                avatar_url: updatedFolder.avatar_url,
                is_public: updatedFolder.is_public,
                is_default: updatedFolder.is_default,
                post_count: updatedFolder.post_count,
              }
            : currentFolder
        )
        if (!updatedFolder.is_public) setSubscriberCount(0)
        setIsEditing(false)
        showToast(t('saved'), 'success')
      } else {
        showToast(apiErrorMessage(data, t('saveFailed2')), 'error')
      }
    } catch (err) {
      if (!isOperationCurrent('save', operationId, scope)) return
      logger.error('Error saving folder:', err)
      showToast(t('saveFailed2'), 'error')
    } finally {
      if (isOperationCurrent('save', operationId, scope)) setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!accessToken || !folder || deleting) return

    const scope = captureScope()
    if (!isFolderRequestScopeCurrent(scope, currentScopeRef.current)) return
    const operationId = ++operationIdsRef.current.delete
    setDeleting(true)

    let confirmed = false
    try {
      confirmed = await showDangerConfirm(t('deleteFolder'), t('deleteFolderConfirm'))
    } catch (err) {
      if (isOperationCurrent('delete', operationId, scope)) {
        setDeleting(false)
        logger.error('Error confirming folder deletion:', err)
        showToast(t('deleteFailed'), 'error')
      }
      return
    }
    if (!confirmed || !isOperationCurrent('delete', operationId, scope)) {
      if (isOperationCurrent('delete', operationId, scope)) setDeleting(false)
      return
    }

    try {
      const response = await fetch(`/api/bookmark-folders/${folderId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
      })

      const data: unknown = await response.json()
      if (!isOperationCurrent('delete', operationId, scope)) return

      if (response.ok) {
        showToast(t('folderDeleted'), 'success')
        router.push('/favorites')
      } else {
        showToast(apiErrorMessage(data, t('deleteFailed')), 'error')
      }
    } catch (err) {
      if (!isOperationCurrent('delete', operationId, scope)) return
      logger.error('Error deleting folder:', err)
      showToast(t('networkError'), 'error')
    } finally {
      if (isOperationCurrent('delete', operationId, scope)) setDeleting(false)
    }
  }

  const handleSubscribe = async () => {
    if (!accessToken) {
      router.push(buildFavoriteFolderLoginHref(folderId))
      return
    }

    if (!folder || subscribing) return

    const scope = captureScope()
    if (!isFolderRequestScopeCurrent(scope, currentScopeRef.current)) return
    const operationId = ++operationIdsRef.current.subscribe
    const actionWasSubscribed = isSubscribed

    setSubscribing(true)
    try {
      const response = await fetch(`/api/bookmark-folders/${folderId}/subscribe`, {
        method: actionWasSubscribed ? 'DELETE' : 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
      })

      const data: unknown = await response.json()
      if (!isOperationCurrent('subscribe', operationId, scope)) return

      if (response.ok) {
        const mutation = readSubscriptionMutation(data)
        if (!mutation || mutation.isSubscribed === actionWasSubscribed) {
          throw new Error('Folder subscription returned an invalid payload')
        }
        setIsSubscribed(mutation.isSubscribed)
        setSubscriberCount(mutation.subscriberCount)
        showToast(mutation.isSubscribed ? t('bookmarked') : t('unbookmarked'), 'success')
      } else {
        showToast(
          apiErrorMessage(data, actionWasSubscribed ? t('unbookmarkFailed') : t('bookmarkFailed')),
          'error'
        )
      }
    } catch (err) {
      if (!isOperationCurrent('subscribe', operationId, scope)) return
      logger.error('Error subscribing to folder:', err)
      showToast(actionWasSubscribed ? t('unbookmarkFailed') : t('bookmarkFailed'), 'error')
    } finally {
      if (isOperationCurrent('subscribe', operationId, scope)) setSubscribing(false)
    }
  }

  const getDefaultAvatar = (name: string) => {
    const colors = [
      'var(--color-accent-error)',
      'var(--color-chart-teal)',
      'var(--color-chart-blue)',
      'var(--color-chart-sage)',
      'var(--color-chart-yellow)',
      'var(--color-chart-pink)',
      'var(--color-chart-mint)',
    ]
    const index = name.charCodeAt(0) % colors.length
    return colors[index]
  }

  // 打开帖子详情弹窗
  const handleOpenPost = async (post: BookmarkedPost) => {
    const scope = captureScope()
    if (!isFolderRequestScopeCurrent(scope, currentScopeRef.current)) return
    postDetailControllerRef.current?.abort()
    const controller = new AbortController()
    postDetailControllerRef.current = controller
    const operationId = ++operationIdsRef.current['post-detail']
    setSelectedPost(post)
    setFullPostContent(post.content)

    // 如果内容被截断，加载完整内容
    if (post.content && post.content.length >= 200) {
      setPostDetailLoading(true)
      try {
        const response = await fetch(`/api/posts/${post.id}`, { signal: controller.signal })
        const data: unknown = await response.json()
        if (!isOperationCurrent('post-detail', operationId, scope)) return
        if (
          response.ok &&
          isRecord(data) &&
          isRecord(data.data) &&
          typeof data.data.content === 'string'
        ) {
          setFullPostContent(data.data.content)
        }
      } catch (err) {
        if (controller.signal.aborted || !isOperationCurrent('post-detail', operationId, scope)) {
          return
        }
        logger.error('Error loading post:', err)
      } finally {
        if (isOperationCurrent('post-detail', operationId, scope)) {
          setPostDetailLoading(false)
        }
        if (postDetailControllerRef.current === controller) {
          postDetailControllerRef.current = null
        }
      }
    } else if (postDetailControllerRef.current === controller) {
      postDetailControllerRef.current = null
    }
  }

  // 关闭帖子详情弹窗
  const handleClosePost = () => {
    postDetailControllerRef.current?.abort()
    postDetailControllerRef.current = null
    operationIdsRef.current['post-detail'] += 1
    setSelectedPost(null)
    setFullPostContent(null)
    setPostDetailLoading(false)
  }

  // 移除收藏
  const handleRemoveBookmark = async (e: React.MouseEvent, postId: string, bookmarkId: string) => {
    e.stopPropagation()

    if (!accessToken || removingBookmark[postId]) return

    const scope = captureScope()
    if (!isFolderRequestScopeCurrent(scope, currentScopeRef.current)) return
    const requestId = (removeRequestIdsRef.current[postId] ?? 0) + 1
    removeRequestIdsRef.current[postId] = requestId
    const requestIsCurrent = () =>
      removeRequestIdsRef.current[postId] === requestId &&
      isFolderRequestScopeCurrent(scope, currentScopeRef.current)
    const removeFromVisiblePage = () => {
      // Removing an item from the loaded prefix shifts every later offset by
      // one. Cancel any page using the old offset before updating local state.
      postsPageControllerRef.current?.abort()
      postsPageControllerRef.current = null
      postsPageRequestIdRef.current += 1
      setPostsMoreStatus('idle')
      setPostsNextOffset((currentOffset) => Math.max(0, currentOffset - 1))
      setPosts((currentPosts) => currentPosts.filter((post) => post.bookmark_id !== bookmarkId))
      setFolder((currentFolder) =>
        currentFolder
          ? { ...currentFolder, post_count: Math.max(0, currentFolder.post_count - 1) }
          : currentFolder
      )
    }

    setRemovingBookmark((prev) => ({ ...prev, [postId]: true }))

    try {
      const response = await fetch(`/api/posts/${postId}/bookmark`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          action: 'remove',
          bookmark_id: bookmarkId,
          folder_id: folderId,
        }),
      })

      if (!requestIsCurrent()) return

      if (response.ok) {
        const data: unknown = await response.json()
        if (!requestIsCurrent()) return
        if (!readBookmarkRemoval(data, { bookmarkId, folderId })) {
          logger.error('Bookmark removal returned an invalid acknowledgement')
          showToast(t('removeFailed'), 'error')
          return
        }
        removeFromVisiblePage()
        showToast(t('removedFromFavorites'), 'success')
      } else {
        const data: unknown = await response.json()
        if (!requestIsCurrent()) return
        // 如果帖子不存在，也从列表中移除
        if (response.status === 404) {
          removeFromVisiblePage()
        } else {
          showToast(apiErrorMessage(data, t('removeFailed')), 'error')
        }
      }
    } catch (err) {
      if (!requestIsCurrent()) return
      logger.error('Error removing bookmark:', err)
      showToast(t('networkError'), 'error')
    } finally {
      if (requestIsCurrent()) {
        setRemovingBookmark((prev) => ({ ...prev, [postId]: false }))
      }
    }
  }

  // PostDetailModal is now extracted to components/PostDetailModal.tsx

  const viewerDataReady = dataResourceKey === resourceKey

  if (!viewerDataReady || loading) {
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
        }}
      >
        <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
          <RankingSkeleton />
        </Box>
      </Box>
    )
  }

  if (error || !folder) {
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
        }}
      >
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
                  fontWeight: tokens.typography.fontWeight.black,
                  fontSize: tokens.typography.fontSize.base,
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

  // Default folder is created DB-side with a Chinese name ('默认收藏夹'); localize it
  // to match the list view (FavoritesPageClient) so EN/ja/ko don't leak raw Chinese.
  const displayName = folder.is_default ? t('defaultFolderName') : folder.name

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <Box
        className="has-mobile-nav"
        style={{
          maxWidth: 900,
          margin: '0 auto',
          paddingTop: tokens.spacing[6],
          paddingRight: tokens.spacing[6],
          paddingBottom: 100,
          paddingLeft: tokens.spacing[6],
        }}
      >
        <Breadcrumb
          items={[{ label: t('favorites'), href: '/favorites' }, { label: displayName }]}
        />
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
              backgroundColor: folder.avatar_url ? undefined : getDefaultAvatar(displayName),
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
                {displayName.charAt(0).toUpperCase()}
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
                    fontWeight: tokens.typography.fontWeight.bold,
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
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[2],
                    cursor: 'pointer',
                  }}
                >
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
                <Box
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[2],
                    marginBottom: tokens.spacing[1],
                  }}
                >
                  <Text size="xl" weight="bold">
                    {displayName}
                  </Text>
                  {folder.is_default && (
                    <span
                      style={{
                        // eslint-disable-next-line no-restricted-syntax -- off-scale micro badge by design
                        fontSize: 10,
                        padding: '2px 6px',
                        background: alpha(tokens.colors.accent.primary, 13),
                        color: tokens.colors.accent.primary,
                        borderRadius: tokens.radius.sm,
                      }}
                    >
                      {t('defaultLabel')}
                    </span>
                  )}
                  {folder.is_public ? (
                    <span
                      style={{
                        // eslint-disable-next-line no-restricted-syntax -- off-scale micro badge by design
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
                        // eslint-disable-next-line no-restricted-syntax -- off-scale micro badge by design
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
                  {subscriberCount > 0 &&
                    ` · ${t('subscriberCount').replace('{n}', String(subscriberCount))}`}
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
              <Button
                variant="text"
                size="sm"
                onClick={() => setIsEditing(true)}
                disabled={deleting}
              >
                {t('edit')}
              </Button>
              {!folder.is_default && (
                <Button
                  variant="text"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleting}
                  style={{ color: tokens.colors.accent?.error || 'var(--color-accent-error)' }}
                >
                  {deleting ? t('processing') : t('delete')}
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
                  <span aria-hidden="true" style={{ fontSize: tokens.typography.fontSize.base }}>
                    ✓
                  </span>
                  {t('bookmarked')}
                </>
              ) : (
                <>
                  <span aria-hidden="true" style={{ fontSize: tokens.typography.fontSize.base }}>
                    ☆
                  </span>
                  {t('bookmark')}
                </>
              )}
            </Button>
          )}
        </Box>

        {/* 帖子列表 */}
        {posts.length === 0 ? (
          <EmptyState title={t('noBookmarks')} description={t('noBookmarksDesc')} />
        ) : (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            {posts.map((post) => (
              <Box
                key={post.bookmark_id}
                role="button"
                tabIndex={0}
                aria-label={post.title}
                onClick={() => handleOpenPost(post)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    handleOpenPost(post)
                  }
                }}
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
                  e.currentTarget.style.background =
                    tokens.colors.bg.tertiary || 'var(--overlay-hover)'
                  e.currentTarget.style.borderColor =
                    tokens.colors.border.secondary || tokens.colors.border.primary
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

                <Box
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: tokens.spacing[3],
                    flexWrap: 'wrap',
                  }}
                >
                  <Box
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacing[3],
                      flexWrap: 'wrap',
                      minWidth: 0,
                    }}
                  >
                    {post.author_handle && (
                      <Text size="xs" color="tertiary">
                        @{post.author_handle}
                      </Text>
                    )}
                    <Text size="xs" color="tertiary">
                      {formatTimeAgo(post.created_at, language)}
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
                        fontSize: tokens.typography.fontSize.xs,
                        cursor: removingBookmark[post.id] ? 'wait' : 'pointer',
                        opacity: removingBookmark[post.id] ? 0.5 : 1,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color =
                          tokens.colors.accent?.error || 'var(--color-accent-error)'
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
            {postsHasMore && (
              <Box
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: tokens.spacing[2],
                  paddingTop: tokens.spacing[2],
                }}
              >
                {postsMoreStatus === 'error' && (
                  <Text role="alert" size="sm" color="secondary">
                    {t('loadMoreFailed')}
                  </Text>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleLoadMorePosts()}
                  disabled={postsMoreStatus === 'loading'}
                  aria-busy={postsMoreStatus === 'loading'}
                >
                  {postsMoreStatus === 'loading' ? t('loadingMore') : t('loadMore')}
                </Button>
              </Box>
            )}
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
