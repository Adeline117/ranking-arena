'use client'

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { supabase as _supabase } from '@/lib/supabase/client'
import type { SupabaseClient } from '@supabase/supabase-js'
const supabase = _supabase as SupabaseClient
import { authedFetch } from '@/lib/api/client'
import {
  fetchPostCommentsPage,
  isCreatedCommentAcknowledgement,
  isDefinitiveMutationRejection,
} from '@/lib/api/comments-client'
import {
  parsePostReactionAcknowledgement,
  type PostReaction,
} from '@/lib/api/post-reactions-client'
import { logger } from '@/lib/logger'
import { shouldLoadExpandedGroupComments } from '@/lib/comments/group-comment-read'
import { useViewerOwnedState } from '@/lib/state/viewer-owned-state'

export interface Post {
  id: string
  group_id: string
  title: string
  content?: string | null
  created_at: string
  author_handle?: string | null
  author_id?: string | null
  author_avatar_url?: string | null
  like_count?: number | null
  dislike_count?: number | null
  comment_count?: number | null
  bookmark_count?: number | null
  repost_count?: number | null
  is_pinned?: boolean | null
  user_liked?: boolean
  user_reaction?: PostReaction | null
  user_bookmarked?: boolean
  user_reposted?: boolean
}

export interface CommentWithAuthor {
  id: string
  post_id: string
  user_id: string
  content: string
  parent_id?: string | null
  like_count: number
  created_at: string
  updated_at: string
  author_handle?: string | null
  author_avatar_url?: string | null
  replies?: CommentWithAuthor[]
}

interface UseGroupPostsOptions {
  groupId: string
  userId: string | null
  accessToken: string | null
  authChecked: boolean
  viewerKey: string
  sessionGeneration: number
  isMember: boolean
  groupVisibility: 'open' | 'apply' | null
  audienceResolved: boolean
  language: string
  t: (key: string) => string
  showToast: (msg: string, type: 'success' | 'error' | 'warning') => void
  showDangerConfirm: (title: string, message: string) => Promise<boolean>
}

const POST_PAGE_SIZE = 20
const POST_SELECT_FIELDS =
  'id, group_id, title, content, created_at, author_handle, author_id, like_count, dislike_count, comment_count, bookmark_count, repost_count, is_pinned'

// Generic fetch for boolean user interactions such as bookmarks.
async function fetchUserInteractions(
  table: string,
  postIds: string[],
  userId: string
): Promise<Record<string, boolean>> {
  if (!userId || postIds.length === 0) return {}
  const { data } = await supabase
    .from(table)
    .select('post_id')
    .eq('user_id', userId)
    .in('post_id', postIds)
  const map: Record<string, boolean> = {}
  data?.forEach((item) => {
    map[item.post_id] = true
  })
  return map
}

async function fetchUserPostReactions(
  postIds: string[],
  userId: string
): Promise<Record<string, PostReaction>> {
  if (!userId || postIds.length === 0) return {}
  const { data, error } = await supabase
    .from('post_likes')
    .select('post_id, reaction_type')
    .eq('user_id', userId)
    .in('post_id', postIds)

  if (error) {
    logger.warn('[useGroupPosts] reaction status query failed:', error)
    return {}
  }

  const reactions: Record<string, PostReaction> = {}
  data?.forEach((item) => {
    if (item.reaction_type === 'up' || item.reaction_type === 'down') {
      reactions[item.post_id] = item.reaction_type
    }
  })
  return reactions
}

// Reposts are canonical post rows authored by the viewer whose
// original_post_id points at the root post. The legacy `reposts` table has not
// been written since reposts were redesigned as posts in 2026-01.
async function fetchUserReposts(
  postIds: string[],
  userId: string
): Promise<Record<string, boolean>> {
  if (!userId || postIds.length === 0) return {}
  const { data, error } = await supabase
    .from('posts')
    .select('original_post_id')
    .eq('author_id', userId)
    .in('original_post_id', postIds)
    .is('deleted_at', null)

  if (error) {
    logger.warn('[useGroupPosts] canonical repost status query failed:', error)
    return {}
  }

  const map: Record<string, boolean> = {}
  data?.forEach((item) => {
    if (item.original_post_id) map[item.original_post_id] = true
  })
  return map
}

// Fetch author avatars in batch and mutate posts
async function enrichPostsWithAvatars(postsList: Post[]): Promise<void> {
  const authorIds = [...new Set(postsList.map((p) => p.author_id).filter(Boolean))] as string[]
  if (authorIds.length === 0) return
  const { data: profiles } = await supabase
    .from('user_profiles')
    .select('id, avatar_url')
    .in('id', authorIds)
  if (profiles) {
    const avatarMap = new Map(profiles.map((p) => [p.id, p.avatar_url]))
    postsList.forEach((post) => {
      if (post.author_id) {
        post.author_avatar_url = avatarMap.get(post.author_id) || null
      }
    })
  }
}

// Enrich posts with user interactions
async function enrichPostsWithUserState(postsList: Post[], userId: string): Promise<void> {
  const postIds = postsList.map((p) => p.id)
  const [reactionMap, bookmarkMap, repostMap] = await Promise.all([
    fetchUserPostReactions(postIds, userId),
    fetchUserInteractions('post_bookmarks', postIds, userId),
    fetchUserReposts(postIds, userId),
  ])
  postsList.forEach((post) => {
    post.user_reaction = reactionMap[post.id] || null
    post.user_liked = post.user_reaction === 'up'
    post.user_bookmarked = bookmarkMap[post.id] || false
    post.user_reposted = repostMap[post.id] || false
  })
}

export function useGroupPosts({
  groupId,
  userId,
  accessToken,
  authChecked,
  viewerKey,
  sessionGeneration,
  isMember,
  groupVisibility,
  audienceResolved,
  language: _language,
  t,
  showToast,
  showDangerConfirm,
}: UseGroupPostsOptions) {
  const activeScopeRef = useRef({ viewerKey, sessionGeneration, userId })
  activeScopeRef.current = { viewerKey, sessionGeneration, userId }
  const accessTokenRef = useRef(accessToken)
  accessTokenRef.current = accessToken
  const activeGroupIdRef = useRef(groupId)
  activeGroupIdRef.current = groupId
  const scopeKey = `${viewerKey}\u0000${sessionGeneration}`
  const previousScopeKeyRef = useRef(scopeKey)
  const scopeIsCurrent = useCallback(
    (scope: { viewerKey: string; sessionGeneration: number; userId: string | null }) => {
      const current = activeScopeRef.current
      return (
        current.viewerKey === scope.viewerKey &&
        current.sessionGeneration === scope.sessionGeneration &&
        current.userId === scope.userId
      )
    },
    []
  )
  const captureMutationContext = useCallback(
    () => ({ scope: activeScopeRef.current, groupId: activeGroupIdRef.current }),
    []
  )
  const mutationContextIsCurrent = useCallback(
    (context: ReturnType<typeof captureMutationContext>) =>
      scopeIsCurrent(context.scope) && activeGroupIdRef.current === context.groupId,
    [scopeIsCurrent]
  )
  // Core state
  const [posts, setPosts] = useViewerOwnedState<Post[]>([], () => [], scopeKey)
  const [sortMode, setSortMode] = useState<'latest' | 'hot'>('latest')
  const [viewMode, setViewMode] = useState<'list' | 'masonry'>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('group-view-mode') as 'list' | 'masonry') || 'masonry'
    }
    return 'masonry'
  })
  const [hasMorePosts, setHasMorePosts] = useViewerOwnedState(true, () => true, scopeKey)
  const [loadingMore, setLoadingMore] = useViewerOwnedState(false, () => false, scopeKey)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Post editing state
  const [editingPost, setEditingPost] = useViewerOwnedState<string | null>(
    null,
    () => null,
    scopeKey
  )
  const [editTitle, setEditTitle] = useViewerOwnedState('', () => '', scopeKey)
  const [editContent, setEditContent] = useViewerOwnedState('', () => '', scopeKey)
  const [savingEdit, setSavingEdit] = useViewerOwnedState(false, () => false, scopeKey)
  const [deletingPost, setDeletingPost] = useViewerOwnedState<string | null>(
    null,
    () => null,
    scopeKey
  )

  // Interaction loading states (using single object for each type)
  const [likeLoading, setLikeLoading] = useViewerOwnedState<Record<string, boolean>>(
    {},
    () => ({}),
    scopeKey
  )
  const [bookmarkLoading, setBookmarkLoading] = useViewerOwnedState<Record<string, boolean>>(
    {},
    () => ({}),
    scopeKey
  )
  const [repostLoading, setRepostLoading] = useViewerOwnedState<Record<string, boolean>>(
    {},
    () => ({}),
    scopeKey
  )
  const [showRepostModal, setShowRepostModal] = useViewerOwnedState<string | null>(
    null,
    () => null,
    scopeKey
  )
  const [repostComment, setRepostComment] = useViewerOwnedState('', () => '', scopeKey)
  const likeRequestLockRef = useRef<Set<string>>(new Set())
  const repostRequestLockRef = useRef<Set<string>>(new Set())

  // Comments state
  // Expansion is resource UI state rather than viewer data. Preserve it across
  // identity changes so the newly authenticated viewer rehydrates the same
  // visible thread from its own canonical read.
  const [expandedComments, setExpandedComments] = useState<Record<string, boolean>>({})
  const [expandedPosts, setExpandedPosts] = useViewerOwnedState<Record<string, boolean>>(
    {},
    () => ({}),
    scopeKey
  )
  const [comments, setCommentsOwned] = useViewerOwnedState<Record<string, CommentWithAuthor[]>>(
    {},
    () => ({}),
    scopeKey
  )
  const commentStateRevisionRef = useRef(new Map<string, number>())
  const setComments: React.Dispatch<React.SetStateAction<Record<string, CommentWithAuthor[]>>> =
    useCallback(
      (action) => {
        const invocationScopeKey = `${activeScopeRef.current.viewerKey}\u0000${activeScopeRef.current.sessionGeneration}`
        commentStateRevisionRef.current.set(
          invocationScopeKey,
          (commentStateRevisionRef.current.get(invocationScopeKey) || 0) + 1
        )
        setCommentsOwned(action)
      },
      [setCommentsOwned]
    )
  const [newComment, setNewCommentOwned] = useViewerOwnedState<Record<string, string>>(
    {},
    () => ({}),
    scopeKey
  )
  const newCommentWorkingRef = useRef({ scopeKey, value: newComment })
  if (newCommentWorkingRef.current.scopeKey !== scopeKey) {
    newCommentWorkingRef.current = { scopeKey, value: newComment }
  } else if (newCommentWorkingRef.current.value !== newComment) {
    newCommentWorkingRef.current.value = newComment
  }
  const newCommentRef = useRef(newComment)
  newCommentRef.current = newComment
  const [commentLoading, setCommentLoading] = useViewerOwnedState<Record<string, boolean>>(
    {},
    () => ({}),
    scopeKey
  )
  const [replyingTo, setReplyingTo] = useViewerOwnedState<Record<string, string | null>>(
    {},
    () => ({}),
    scopeKey
  )
  const [replyContent, setReplyContentOwned] = useViewerOwnedState<Record<string, string>>(
    {},
    () => ({}),
    scopeKey
  )
  const replyContentWorkingRef = useRef({ scopeKey, value: replyContent })
  if (replyContentWorkingRef.current.scopeKey !== scopeKey) {
    replyContentWorkingRef.current = { scopeKey, value: replyContent }
  } else if (replyContentWorkingRef.current.value !== replyContent) {
    replyContentWorkingRef.current.value = replyContent
  }
  const replyContentRef = useRef(replyContent)
  replyContentRef.current = replyContent
  const [expandedReplies, setExpandedReplies] = useViewerOwnedState<Record<string, boolean>>(
    {},
    () => ({}),
    scopeKey
  )
  const commentLoadGenerationRef = useRef(new Map<string, number>())
  const commentLoadPromisesRef = useRef(new Map<string, Promise<boolean>>())
  const commentMutationLocksRef = useRef(new Map<string, symbol>())
  const replyMutationLocksRef = useRef(new Map<string, symbol>())
  const postsRequestGenerationRef = useRef(0)

  // Debounce timers for draft persistence
  const commentDraftTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const replyDraftTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const commentDraftVersionRef = useRef(new Map<string, number>())
  const replyDraftVersionRef = useRef(new Map<string, number>())

  // Wrapped setters that auto-save drafts to localStorage
  const setNewComment: React.Dispatch<React.SetStateAction<Record<string, string>>> = useCallback(
    (action) => {
      const capturedScope = activeScopeRef.current
      const invocationScopeKey = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}`
      const draftViewerKey = capturedScope.viewerKey
      const ownedPrevious =
        newCommentWorkingRef.current.scopeKey === invocationScopeKey
          ? newCommentWorkingRef.current.value
          : {}
      const next = typeof action === 'function' ? action(ownedPrevious) : action
      newCommentWorkingRef.current = { scopeKey: invocationScopeKey, value: next }
      newCommentRef.current = next
      // Persist changed entries and advance a per-resource version even when a
      // user edits back to the exact text an older request captured. Resolve
      // the action once at invocation time so Strict Mode cannot duplicate the
      // persistence side effects by replaying a React updater.
      const postIds = new Set([...Object.keys(ownedPrevious), ...Object.keys(next)])
      for (const postId of postIds) {
        if (next[postId] !== ownedPrevious[postId]) {
          const timerKey = `${draftViewerKey}\u0000${postId}`
          commentDraftVersionRef.current.set(
            timerKey,
            (commentDraftVersionRef.current.get(timerKey) || 0) + 1
          )
          if (commentDraftTimerRef.current[timerKey]) {
            clearTimeout(commentDraftTimerRef.current[timerKey])
          }
          const val = next[postId]
          commentDraftTimerRef.current[timerKey] = setTimeout(() => {
            try {
              const storageKey = `group-comment-draft-v2:${draftViewerKey}:${postId}`
              if (val?.trim()) localStorage.setItem(storageKey, val)
              else localStorage.removeItem(storageKey)
            } catch {
              /* ignore */
            }
          }, 500)
        }
      }
      setNewCommentOwned(next)
    },
    [setNewCommentOwned]
  )

  const setReplyContent: React.Dispatch<React.SetStateAction<Record<string, string>>> = useCallback(
    (action) => {
      const capturedScope = activeScopeRef.current
      const invocationScopeKey = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}`
      const draftViewerKey = capturedScope.viewerKey
      const ownedPrevious =
        replyContentWorkingRef.current.scopeKey === invocationScopeKey
          ? replyContentWorkingRef.current.value
          : {}
      const next = typeof action === 'function' ? action(ownedPrevious) : action
      replyContentWorkingRef.current = { scopeKey: invocationScopeKey, value: next }
      replyContentRef.current = next
      const commentIds = new Set([...Object.keys(ownedPrevious), ...Object.keys(next)])
      for (const commentId of commentIds) {
        if (next[commentId] !== ownedPrevious[commentId]) {
          const timerKey = `${draftViewerKey}\u0000${commentId}`
          replyDraftVersionRef.current.set(
            timerKey,
            (replyDraftVersionRef.current.get(timerKey) || 0) + 1
          )
          if (replyDraftTimerRef.current[timerKey]) {
            clearTimeout(replyDraftTimerRef.current[timerKey])
          }
          const val = next[commentId]
          replyDraftTimerRef.current[timerKey] = setTimeout(() => {
            try {
              const storageKey = `group-reply-draft-v2:${draftViewerKey}:${commentId}`
              if (val?.trim()) localStorage.setItem(storageKey, val)
              else localStorage.removeItem(storageKey)
            } catch {
              /* ignore */
            }
          }, 500)
        }
      }
      setReplyContentOwned(next)
    },
    [setReplyContentOwned]
  )

  // Restore drafts when comments are expanded
  const restoreCommentDraft = useCallback(
    (postId: string) => {
      try {
        const saved = localStorage.getItem(
          `group-comment-draft-v2:${activeScopeRef.current.viewerKey}:${postId}`
        )
        if (saved) setNewComment((prev) => ({ ...prev, [postId]: saved }))
      } catch {
        /* ignore */
      }
    },
    [setNewComment]
  )

  const restoreReplyDraft = useCallback(
    (commentId: string) => {
      try {
        const saved = localStorage.getItem(
          `group-reply-draft-v2:${activeScopeRef.current.viewerKey}:${commentId}`
        )
        if (saved) setReplyContent((prev) => ({ ...prev, [commentId]: saved }))
      } catch {
        /* ignore */
      }
    },
    [setReplyContent]
  )

  useEffect(() => {
    if (previousScopeKeyRef.current === scopeKey) return
    previousScopeKeyRef.current = scopeKey
    postsRequestGenerationRef.current += 1
    commentLoadGenerationRef.current.clear()
    commentLoadPromisesRef.current.clear()
    commentMutationLocksRef.current.clear()
    replyMutationLocksRef.current.clear()
    likeRequestLockRef.current.clear()
    setPosts([])
    setHasMorePosts(true)
    setLoadingMore(false)
    setComments({})
    setNewComment({})
    setReplyContent({})
    setCommentLoading({})
    setReplyingTo({})
    setExpandedReplies({})
    setExpandedPosts({})
    setEditingPost(null)
    setEditTitle('')
    setEditContent('')
    setSavingEdit(false)
    setDeletingPost(null)
    setLikeLoading({})
    setBookmarkLoading({})
    setRepostLoading({})
    setShowRepostModal(null)
    setRepostComment('')
  }, [
    scopeKey,
    setBookmarkLoading,
    setCommentLoading,
    setComments,
    setDeletingPost,
    setEditContent,
    setEditingPost,
    setEditTitle,
    setExpandedPosts,
    setExpandedReplies,
    setHasMorePosts,
    setLikeLoading,
    setLoadingMore,
    setNewComment,
    setPosts,
    setReplyContent,
    setReplyingTo,
    setRepostComment,
    setRepostLoading,
    setSavingEdit,
    setShowRepostModal,
  ])

  // Helper to set loading state for a specific post
  const setPostLoading = useCallback(
    (
      setter: React.Dispatch<React.SetStateAction<Record<string, boolean>>>,
      postId: string,
      loading: boolean
    ) => {
      setter((prev) => ({ ...prev, [postId]: loading }))
    },
    []
  )

  // Fetch posts from database with optional cursor
  const fetchPosts = useCallback(
    async (cursor?: string): Promise<Post[]> => {
      let query = supabase
        .from('posts')
        .select(POST_SELECT_FIELDS)
        .eq('group_id', groupId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(POST_PAGE_SIZE)

      if (cursor) {
        query = query.lt('created_at', cursor)
      }

      const { data, error } = await query
      if (error) throw error
      return (data || []) as Post[]
    },
    [groupId]
  )

  // Enrich posts with avatars and user state
  const enrichPosts = useCallback(
    async (postsList: Post[]): Promise<void> => {
      const promises: Promise<void>[] = [enrichPostsWithAvatars(postsList)]
      if (userId) {
        promises.push(enrichPostsWithUserState(postsList, userId))
      }
      await Promise.all(promises)
    },
    [userId]
  )

  // Load initial posts
  const loadPosts = useCallback(
    async (_forceLoad = false) => {
      if (!groupId) {
        setPosts([])
        setHasMorePosts(false)
        return
      }

      const capturedScope = activeScopeRef.current
      const requestGeneration = ++postsRequestGenerationRef.current
      try {
        const postsList = await fetchPosts()
        await enrichPosts(postsList)
        if (
          !scopeIsCurrent(capturedScope) ||
          requestGeneration !== postsRequestGenerationRef.current
        ) {
          return
        }
        setPosts(postsList)
        setHasMorePosts(postsList.length === POST_PAGE_SIZE)
      } catch (err) {
        if (!scopeIsCurrent(capturedScope)) return
        const error = err instanceof Error ? err.message : 'Failed to load posts'
        showToast(error, 'error')
      }
    },
    [enrichPosts, fetchPosts, groupId, scopeIsCurrent, setHasMorePosts, setPosts, showToast]
  )

  // Infinite scroll: load more
  const loadMorePosts = useCallback(async () => {
    if (loadingMore || !hasMorePosts || posts.length === 0) return

    const capturedScope = activeScopeRef.current
    const requestGeneration = ++postsRequestGenerationRef.current
    setLoadingMore(true)
    try {
      const lastPost = posts[posts.length - 1]
      const postsList = await fetchPosts(lastPost.created_at)

      if (postsList.length > 0) {
        await enrichPosts(postsList)
        if (
          !scopeIsCurrent(capturedScope) ||
          requestGeneration !== postsRequestGenerationRef.current
        ) {
          return
        }
        setPosts((prev) => [...prev, ...postsList])
        setHasMorePosts(postsList.length === POST_PAGE_SIZE)
      } else {
        setHasMorePosts(false)
      }
    } catch (err) {
      if (!scopeIsCurrent(capturedScope)) return
      logger.error('Load more posts error:', err)
    } finally {
      if (
        scopeIsCurrent(capturedScope) &&
        requestGeneration === postsRequestGenerationRef.current
      ) {
        setLoadingMore(false)
      }
    }
  }, [
    enrichPosts,
    fetchPosts,
    hasMorePosts,
    loadingMore,
    posts,
    scopeIsCurrent,
    setHasMorePosts,
    setLoadingMore,
    setPosts,
  ])

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMorePosts && !loadingMore) {
          loadMorePosts()
        }
      },
      { threshold: 0.1 }
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [loadMorePosts, hasMorePosts, loadingMore])

  // Sorted posts (memoized)
  const sortedPosts = useMemo(() => {
    if (posts.length === 0) return []

    let sorted: Post[]
    if (sortMode === 'latest') {
      sorted = [...posts].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )
    } else {
      const now = Date.now()
      sorted = [...posts].sort((a, b) => {
        const hoursA = (now - new Date(a.created_at).getTime()) / (1000 * 60 * 60)
        const hoursB = (now - new Date(b.created_at).getTime()) / (1000 * 60 * 60)
        const scoreA = ((a.like_count || 0) * 2 + (a.comment_count || 0) * 1) / (1 + hoursA / 24)
        const scoreB = ((b.like_count || 0) * 2 + (b.comment_count || 0) * 1) / (1 + hoursB / 24)
        return scoreB - scoreA
      })
    }

    return sorted.sort((a, b) => {
      if (a.is_pinned && !b.is_pinned) return -1
      if (!a.is_pinned && b.is_pinned) return 1
      return 0
    })
  }, [posts, sortMode])

  // Heat color
  const maxComments = sortedPosts.reduce((max, post) => Math.max(max, post.comment_count || 0), 0)

  const getHeatColor = (commentCount: number): string => {
    if (maxComments === 0) return 'var(--color-orange-bg-light)'
    const ratio = Math.min(commentCount / maxComments, 1)
    const r = 255
    const g = Math.round(228 - ratio * (228 - 107))
    const b = Math.round(204 - ratio * 204)
    return `rgb(${r}, ${g}, ${b})`
  }

  // Generic API call helper
  const apiCall = useCallback(
    async (
      url: string,
      options: {
        method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'
        body?: Record<string, unknown>
      } = {},
      capturedScope = activeScopeRef.current
    ): Promise<{
      ok: boolean
      status: number
      data?: unknown
      error?: string
      stale?: boolean
    }> => {
      if (!scopeIsCurrent(capturedScope)) {
        return { ok: false, status: 0, error: 'STALE_AUTH_SCOPE', stale: true }
      }
      try {
        const response = await authedFetch<Record<string, unknown>>(
          url,
          options.method || 'POST',
          accessTokenRef.current,
          options.body,
          15_000,
          {
            expectedUserId: capturedScope.userId,
            expectedSessionGeneration: capturedScope.sessionGeneration,
          }
        )
        if (response.stale || !scopeIsCurrent(capturedScope)) {
          return { ok: false, status: response.status, error: 'STALE_AUTH_SCOPE', stale: true }
        }
        const data = response.data
        const rawError = data?.error
        const error =
          typeof rawError === 'string'
            ? rawError
            : rawError && typeof rawError === 'object' && 'message' in rawError
              ? String(rawError.message)
              : undefined
        return { ok: response.ok, status: response.status, data, error }
      } catch {
        if (!scopeIsCurrent(capturedScope)) {
          return { ok: false, status: 0, error: 'STALE_AUTH_SCOPE', stale: true }
        }
        return { ok: false, status: 0, error: t('networkError') }
      }
    },
    [scopeIsCurrent, t]
  )

  // Like handler
  const handleLike = useCallback(
    async (postId: string) => {
      if (!accessToken) {
        showToast(t('pleaseLoginFirst'), 'warning')
        return
      }
      const context = captureMutationContext()
      const lockKey = `${context.scope.viewerKey}\u0000${context.scope.sessionGeneration}\u0000${context.groupId}\u0000${postId}`
      if (likeRequestLockRef.current.has(lockKey)) return
      likeRequestLockRef.current.add(lockKey)
      setPostLoading(setLikeLoading, postId, true)
      try {
        const result = await apiCall(
          `/api/posts/${postId}/like`,
          { body: { reaction_type: 'up' } },
          context.scope
        )
        if (!mutationContextIsCurrent(context)) return

        const acknowledgement = result.ok
          ? parsePostReactionAcknowledgement(result.data, 'up')
          : null
        if (!acknowledgement) {
          showToast(result.error || t('operationFailed'), 'error')
          return
        }

        setPosts((prev) =>
          prev.map((post) =>
            post.id === postId
              ? {
                  ...post,
                  user_liked: acknowledgement.reaction === 'up',
                  user_reaction: acknowledgement.reaction,
                  like_count: acknowledgement.like_count ?? post.like_count,
                  dislike_count: acknowledgement.dislike_count ?? post.dislike_count,
                }
              : post
          )
        )
      } finally {
        if (likeRequestLockRef.current.delete(lockKey) && mutationContextIsCurrent(context)) {
          setPostLoading(setLikeLoading, postId, false)
        }
      }
    },
    [
      accessToken,
      apiCall,
      captureMutationContext,
      mutationContextIsCurrent,
      setLikeLoading,
      setPostLoading,
      setPosts,
      showToast,
      t,
    ]
  )

  // Bookmark handler
  const handleBookmark = useCallback(
    async (postId: string) => {
      if (!accessToken) {
        showToast(t('pleaseLoginFirst'), 'warning')
        return
      }
      if (bookmarkLoading[postId]) return // prevent double-click
      const context = captureMutationContext()
      setPostLoading(setBookmarkLoading, postId, true)
      const result = await apiCall(`/api/posts/${postId}/bookmark`, {}, context.scope)
      if (!mutationContextIsCurrent(context)) return
      if (result.ok) {
        const data = result.data as { bookmarked: boolean; bookmark_count: number }
        setPosts((prev) =>
          prev.map((p) =>
            p.id === postId
              ? { ...p, user_bookmarked: data.bookmarked, bookmark_count: data.bookmark_count }
              : p
          )
        )
      } else {
        showToast(result.error || t('operationFailed'), 'error')
      }
      setPostLoading(setBookmarkLoading, postId, false)
    },
    [
      accessToken,
      apiCall,
      bookmarkLoading,
      captureMutationContext,
      mutationContextIsCurrent,
      setBookmarkLoading,
      setPostLoading,
      setPosts,
      showToast,
      t,
    ]
  )

  // Repost handler
  const handleRepost = useCallback(
    async (postId: string, comment?: string) => {
      if (!accessToken) {
        showToast(t('pleaseLoginFirst'), 'warning')
        return
      }
      const post = posts.find((p) => p.id === postId)
      if (post?.author_id === userId) {
        showToast(t('cannotRepostOwn'), 'warning')
        return
      }
      if (post?.user_reposted) {
        showToast(t('alreadyReposted'), 'warning')
        return
      }
      const context = captureMutationContext()
      const requestLockKey = `${context.scope.viewerKey}\u0000${context.scope.sessionGeneration}\u0000${context.groupId}\u0000${postId}`
      if (repostRequestLockRef.current.has(requestLockKey)) return
      repostRequestLockRef.current.add(requestLockKey)
      setPostLoading(setRepostLoading, postId, true)
      try {
        const result = await apiCall(
          `/api/posts/${postId}/repost`,
          { body: { comment } },
          context.scope
        )
        if (!mutationContextIsCurrent(context)) return
        if (result.ok) {
          const data = result.data as { repost_count: number }
          setPosts((prev) =>
            prev.map((p) =>
              p.id === postId ? { ...p, user_reposted: true, repost_count: data.repost_count } : p
            )
          )
          setShowRepostModal(null)
          setRepostComment('')
          showToast(t('repostSuccess'), 'success')
        } else {
          showToast(result.error || t('repostFailed'), 'error')
        }
      } finally {
        repostRequestLockRef.current.delete(requestLockKey)
        if (mutationContextIsCurrent(context)) {
          setPostLoading(setRepostLoading, postId, false)
        }
      }
    },
    [
      accessToken,
      apiCall,
      captureMutationContext,
      mutationContextIsCurrent,
      posts,
      setPostLoading,
      setPosts,
      setRepostComment,
      setRepostLoading,
      setShowRepostModal,
      showToast,
      t,
      userId,
    ]
  )

  // Delete post
  const handleDeletePost = useCallback(
    async (postId: string) => {
      const context = captureMutationContext()
      const confirmed = await showDangerConfirm(t('deletePost'), t('deletePostConfirm'))
      if (!confirmed || !mutationContextIsCurrent(context)) return

      setDeletingPost(postId)
      const result = await apiCall(
        `/api/posts/${postId}/delete`,
        { method: 'DELETE' },
        context.scope
      )
      if (!mutationContextIsCurrent(context)) return
      if (result.ok) {
        setPosts((prev) => prev.filter((p) => p.id !== postId))
        showToast(t('postDeleted'), 'success')
      } else {
        showToast(result.error || t('deleteFailed'), 'error')
      }
      setDeletingPost(null)
    },
    [
      apiCall,
      captureMutationContext,
      mutationContextIsCurrent,
      setDeletingPost,
      setPosts,
      showDangerConfirm,
      showToast,
      t,
    ]
  )

  // Save edit
  const handleSaveEdit = useCallback(
    async (postId: string) => {
      if (!editTitle.trim()) {
        showToast(t('titleRequired'), 'warning')
        return
      }
      const context = captureMutationContext()
      const submittedTitle = editTitle.trim()
      const submittedContent = editContent.trim()
      setSavingEdit(true)
      const result = await apiCall(
        `/api/posts/${postId}/edit`,
        {
          method: 'PUT',
          body: { title: submittedTitle, content: submittedContent },
        },
        context.scope
      )
      if (!mutationContextIsCurrent(context)) return
      if (result.ok) {
        setPosts((prev) =>
          prev.map((p) =>
            p.id === postId ? { ...p, title: submittedTitle, content: submittedContent } : p
          )
        )
        setEditingPost(null)
        showToast(t('editSaved'), 'success')
      } else {
        showToast(result.error || t('editFailed'), 'error')
      }
      setSavingEdit(false)
    },
    [
      apiCall,
      captureMutationContext,
      editContent,
      editTitle,
      mutationContextIsCurrent,
      setEditingPost,
      setPosts,
      setSavingEdit,
      showToast,
      t,
    ]
  )

  // Pin/unpin
  const handlePinPost = useCallback(
    async (postId: string) => {
      const context = captureMutationContext()
      const result = await apiCall(`/api/posts/${postId}/pin`, {}, context.scope)
      if (!mutationContextIsCurrent(context)) return
      if (result.ok) {
        const data = result.data as { data?: { is_pinned: boolean }; is_pinned?: boolean }
        const newPinned = data.data?.is_pinned ?? data.is_pinned
        setPosts((prev) =>
          prev.map((p) => {
            if (p.id === postId) return { ...p, is_pinned: newPinned }
            if (newPinned) return { ...p, is_pinned: false }
            return p
          })
        )
        showToast(newPinned ? t('pinned') : t('unpinned'), 'success')
      } else {
        showToast(result.error || t('operationFailed'), 'error')
      }
    },
    [apiCall, captureMutationContext, mutationContextIsCurrent, setPosts, showToast, t]
  )

  // Load comments for a post
  const loadComments = useCallback(
    (postId: string, showError = true): Promise<boolean> => {
      const canRead =
        authChecked &&
        audienceResolved &&
        (groupVisibility === 'open' ||
          (groupVisibility === 'apply' && isMember && !!accessTokenRef.current))
      if (!canRead) return Promise.resolve(false)

      const capturedScope = activeScopeRef.current
      const scopedPostKey = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}\u0000${postId}`
      const existingRequest = commentLoadPromisesRef.current.get(scopedPostKey)
      if (existingRequest) return existingRequest

      const generation = (commentLoadGenerationRef.current.get(scopedPostKey) || 0) + 1
      commentLoadGenerationRef.current.set(scopedPostKey, generation)
      const revisionKey = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}`
      const requestStartRevision = commentStateRevisionRef.current.get(revisionKey) || 0
      setPostLoading(setCommentLoading, postId, true)

      let retryAfterNewerState = false
      const request: Promise<boolean> = (async () => {
        try {
          const page = await fetchPostCommentsPage<CommentWithAuthor>(
            postId,
            accessTokenRef.current,
            {
              viewerScope: {
                expectedUserId: capturedScope.userId,
                expectedSessionGeneration: capturedScope.sessionGeneration,
              },
            }
          )
          if (
            !page.ok ||
            !scopeIsCurrent(capturedScope) ||
            commentLoadGenerationRef.current.get(scopedPostKey) !== generation
          ) {
            if (
              showError &&
              scopeIsCurrent(capturedScope) &&
              commentLoadGenerationRef.current.get(scopedPostKey) === generation
            ) {
              showToast(t('loadCommentsFailed'), 'error')
            }
            return false
          }

          if (page.resourceAbsent) {
            setComments((previous) => {
              const next = { ...previous }
              delete next[postId]
              return next
            })
            setPosts((previous) => previous.filter((post) => post.id !== postId))
            setExpandedComments((previous) => ({ ...previous, [postId]: false }))
            return true
          }

          if ((commentStateRevisionRef.current.get(revisionKey) || 0) !== requestStartRevision) {
            retryAfterNewerState = true
            return false
          }

          setComments((prev) => ({ ...prev, [postId]: page.comments }))
          setPosts((prev) =>
            prev.map((post) =>
              post.id === postId ? { ...post, comment_count: page.commentCount } : post
            )
          )
          return true
        } catch {
          if (
            showError &&
            scopeIsCurrent(capturedScope) &&
            commentLoadGenerationRef.current.get(scopedPostKey) === generation
          ) {
            showToast(t('networkError'), 'error')
          }
          return false
        } finally {
          if (
            scopeIsCurrent(capturedScope) &&
            commentLoadGenerationRef.current.get(scopedPostKey) === generation
          ) {
            setPostLoading(setCommentLoading, postId, false)
            commentLoadPromisesRef.current.delete(scopedPostKey)
            commentLoadGenerationRef.current.delete(scopedPostKey)
            if (retryAfterNewerState) {
              queueMicrotask(() => {
                if (scopeIsCurrent(capturedScope)) void loadComments(postId, false)
              })
            }
          }
        }
      })()

      commentLoadPromisesRef.current.set(scopedPostKey, request)
      return request
    },
    [
      audienceResolved,
      authChecked,
      groupVisibility,
      isMember,
      scopeIsCurrent,
      setCommentLoading,
      setComments,
      setPostLoading,
      setPosts,
      showToast,
      t,
    ]
  )

  const reconcileCommentsAfterMutation = useCallback(
    async (postId: string, capturedScope = activeScopeRef.current): Promise<boolean> => {
      if (!scopeIsCurrent(capturedScope)) return false
      // An already-running read may have started before the write and therefore
      // cannot prove its outcome. Let it settle, then issue a fresh token-bound read.
      const scopedPostKey = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}\u0000${postId}`
      await commentLoadPromisesRef.current.get(scopedPostKey)
      if (!scopeIsCurrent(capturedScope)) return false
      return loadComments(postId, false)
    },
    [loadComments, scopeIsCurrent]
  )

  const toggleComments = useCallback(
    (postId: string) => {
      const isExpanded = expandedComments[postId]
      setExpandedComments((prev) => ({ ...prev, [postId]: !isExpanded }))
      if (!isExpanded) {
        restoreCommentDraft(postId)
        if (
          shouldLoadExpandedGroupComments({
            accessToken,
            authChecked,
            audienceResolved,
            groupVisibility,
            isMember,
            expanded: true,
            hasCachedComments: Object.prototype.hasOwnProperty.call(comments, postId),
            loading: commentLoadPromisesRef.current.has(
              `${viewerKey}\u0000${sessionGeneration}\u0000${postId}`
            ),
          })
        ) {
          void loadComments(postId)
        }
      }
    },
    [
      accessToken,
      audienceResolved,
      authChecked,
      comments,
      expandedComments,
      groupVisibility,
      isMember,
      loadComments,
      restoreCommentDraft,
      sessionGeneration,
      viewerKey,
    ]
  )

  // URL/session restoration can expand a thread before the member token is
  // available. When auth arrives, retry only uncached expanded threads.
  useEffect(() => {
    for (const [postId, expanded] of Object.entries(expandedComments)) {
      if (
        shouldLoadExpandedGroupComments({
          accessToken,
          authChecked,
          audienceResolved,
          groupVisibility,
          isMember,
          expanded,
          hasCachedComments: Object.prototype.hasOwnProperty.call(comments, postId),
          loading: commentLoadPromisesRef.current.has(
            `${viewerKey}\u0000${sessionGeneration}\u0000${postId}`
          ),
        })
      ) {
        void loadComments(postId)
      }
    }
  }, [
    accessToken,
    audienceResolved,
    authChecked,
    comments,
    expandedComments,
    groupVisibility,
    isMember,
    loadComments,
    scopeKey,
    sessionGeneration,
    viewerKey,
  ])

  const submitComment = useCallback(
    async (postId: string) => {
      if (!authChecked) return
      if (!accessToken) {
        showToast(t('pleaseLoginFirst'), 'warning')
        return
      }
      const content = newComment[postId]?.trim()
      if (!content) return
      const capturedScope = activeScopeRef.current
      const lockKey = `${capturedScope.viewerKey}\u0000${postId}`
      if (commentMutationLocksRef.current.has(lockKey)) return
      const operation = Symbol('group-comment')
      commentMutationLocksRef.current.set(lockKey, operation)
      const draftVersion = commentDraftVersionRef.current.get(lockKey) || 0

      setPostLoading(setCommentLoading, postId, true)
      try {
        const result = await authedFetch<{
          success?: boolean
          data?: { comment?: unknown }
          error?: string
        }>(`/api/posts/${postId}/comments`, 'POST', accessToken, { content }, 15_000, {
          expectedUserId: capturedScope.userId,
          expectedSessionGeneration: capturedScope.sessionGeneration,
        })
        if (!scopeIsCurrent(capturedScope) || result.stale) return
        const data = result.data
        const rawComment = data?.data?.comment

        if (
          result.ok &&
          data?.success === true &&
          isCreatedCommentAcknowledgement(rawComment, {
            postId,
            userId: capturedScope.userId,
          })
        ) {
          const timerKey = `${capturedScope.viewerKey}\u0000${postId}`
          const pendingDraft = commentDraftTimerRef.current[timerKey]
          if (pendingDraft) {
            clearTimeout(pendingDraft)
            delete commentDraftTimerRef.current[timerKey]
          }
          if (
            commentDraftVersionRef.current.get(lockKey) === draftVersion &&
            newCommentRef.current[postId]?.trim() === content
          ) {
            setNewComment((prev) => ({ ...prev, [postId]: '' }))
            try {
              localStorage.removeItem(`group-comment-draft-v2:${capturedScope.viewerKey}:${postId}`)
            } catch {
              /* ignore */
            }
          }
          setExpandedComments((prev) => ({ ...prev, [postId]: true }))

          // Prefer the authenticated absolute tree/count. If that read is
          // unavailable, the strict ACK is still safe to render without
          // guessing a post count from a possibly stale base.
          if (!(await reconcileCommentsAfterMutation(postId, capturedScope))) {
            if (!scopeIsCurrent(capturedScope)) return
            setComments((prev) => {
              const existing = prev[postId] || []
              if (existing.some((comment) => comment.id === rawComment.id)) return prev
              return { ...prev, [postId]: [...existing, rawComment] }
            })
          }
        } else if (isDefinitiveMutationRejection(result)) {
          if (scopeIsCurrent(capturedScope)) {
            showToast(data?.error || t('postCommentFailed'), 'error')
          }
        } else if (!(await reconcileCommentsAfterMutation(postId, capturedScope))) {
          // Network/408/5xx/malformed 2xx leaves commit state unknown. Keep the
          // current tree and draft when the authoritative read is unavailable.
          if (scopeIsCurrent(capturedScope)) showToast(t('networkError'), 'error')
        }
      } catch {
        if (
          scopeIsCurrent(capturedScope) &&
          !(await reconcileCommentsAfterMutation(postId, capturedScope))
        ) {
          if (scopeIsCurrent(capturedScope)) showToast(t('networkError'), 'error')
        }
      } finally {
        if (commentMutationLocksRef.current.get(lockKey) === operation) {
          commentMutationLocksRef.current.delete(lockKey)
          if (scopeIsCurrent(capturedScope)) {
            setPostLoading(setCommentLoading, postId, false)
          }
        }
      }
    },
    [
      accessToken,
      authChecked,
      newComment,
      reconcileCommentsAfterMutation,
      scopeIsCurrent,
      setCommentLoading,
      setComments,
      setNewComment,
      setPostLoading,
      showToast,
      t,
    ]
  )

  const submitReply = useCallback(
    async (postId: string, commentId: string) => {
      if (!authChecked || !accessToken) return
      const content = replyContent[commentId]?.trim()
      if (!content) return
      const capturedScope = activeScopeRef.current
      const lockKey = `${capturedScope.viewerKey}\u0000${commentId}`
      if (replyMutationLocksRef.current.has(lockKey)) return
      const operation = Symbol('group-reply')
      replyMutationLocksRef.current.set(lockKey, operation)
      const draftVersion = replyDraftVersionRef.current.get(lockKey) || 0
      try {
        const result = await authedFetch<{
          success?: boolean
          data?: { comment?: unknown }
          error?: string
        }>(
          `/api/posts/${postId}/comments`,
          'POST',
          accessToken,
          { content, parent_id: commentId },
          15_000,
          {
            expectedUserId: capturedScope.userId,
            expectedSessionGeneration: capturedScope.sessionGeneration,
          }
        )
        if (!scopeIsCurrent(capturedScope) || result.stale) return
        const data = result.data
        const rawComment = data?.data?.comment

        if (
          result.ok &&
          data?.success === true &&
          isCreatedCommentAcknowledgement(rawComment, {
            postId,
            parentId: commentId,
            userId: capturedScope.userId,
          })
        ) {
          const timerKey = `${capturedScope.viewerKey}\u0000${commentId}`
          const pendingDraft = replyDraftTimerRef.current[timerKey]
          if (pendingDraft) {
            clearTimeout(pendingDraft)
            delete replyDraftTimerRef.current[timerKey]
          }
          if (
            replyDraftVersionRef.current.get(lockKey) === draftVersion &&
            replyContentRef.current[commentId]?.trim() === content
          ) {
            setReplyContent((prev) => ({ ...prev, [commentId]: '' }))
            try {
              localStorage.removeItem(
                `group-reply-draft-v2:${capturedScope.viewerKey}:${commentId}`
              )
            } catch {
              /* ignore */
            }
            setReplyingTo((prev) => ({ ...prev, [postId]: null }))
          }
          if (!(await reconcileCommentsAfterMutation(postId, capturedScope))) {
            if (!scopeIsCurrent(capturedScope)) return
            setComments((prev) => ({
              ...prev,
              [postId]: (prev[postId] || []).map((comment) =>
                comment.id === commentId
                  ? {
                      ...comment,
                      replies: [...(comment.replies || []), rawComment],
                    }
                  : comment
              ),
            }))
          }
        } else if (isDefinitiveMutationRejection(result)) {
          if (scopeIsCurrent(capturedScope)) {
            showToast(data?.error || t('postCommentFailed'), 'error')
          }
        } else if (!(await reconcileCommentsAfterMutation(postId, capturedScope))) {
          if (scopeIsCurrent(capturedScope)) showToast(t('networkError'), 'error')
        }
      } catch {
        if (
          scopeIsCurrent(capturedScope) &&
          !(await reconcileCommentsAfterMutation(postId, capturedScope))
        ) {
          if (scopeIsCurrent(capturedScope)) showToast(t('networkError'), 'error')
        }
      } finally {
        if (replyMutationLocksRef.current.get(lockKey) === operation) {
          replyMutationLocksRef.current.delete(lockKey)
        }
      }
    },
    [
      accessToken,
      authChecked,
      reconcileCommentsAfterMutation,
      replyContent,
      scopeIsCurrent,
      setComments,
      setReplyContent,
      setReplyingTo,
      showToast,
      t,
    ]
  )

  // View mode setter
  const setViewModeWithPersist = useCallback((mode: 'list' | 'masonry') => {
    setViewMode(mode)
    localStorage.setItem('group-view-mode', mode)
  }, [])

  return {
    posts,
    setPosts,
    sortedPosts,
    sortMode,
    setSortMode,
    viewMode,
    setViewMode: setViewModeWithPersist,
    hasMorePosts,
    loadingMore,
    sentinelRef,
    loadPosts,

    // Post editing
    editingPost,
    setEditingPost,
    editTitle,
    setEditTitle,
    editContent,
    setEditContent,
    savingEdit,
    deletingPost,

    // Interactions
    likeLoading,
    bookmarkLoading,
    repostLoading,
    showRepostModal,
    // Auth-gated: anonymous users get the login modal immediately instead of
    // the repost editor (gate only when opening; null = close, always allowed).
    setShowRepostModal: useCallback(
      (id: string | null) => {
        if (id !== null && !accessToken) {
          import('@/lib/hooks/useLoginModal').then(({ useLoginModal }) =>
            useLoginModal.getState().openLoginModal()
          )
          return
        }
        setShowRepostModal(id)
      },
      [accessToken, setShowRepostModal]
    ),
    repostComment,
    setRepostComment,

    // Comments
    expandedComments,
    comments,
    newComment,
    setNewComment,
    commentLoading,
    replyingTo,
    setReplyingTo: useCallback(
      (action: React.SetStateAction<Record<string, string | null>>) => {
        setReplyingTo((prev) => {
          const next = typeof action === 'function' ? action(prev) : action
          // Restore reply drafts for newly opened reply boxes
          for (const [postId, commentId] of Object.entries(next)) {
            if (commentId && commentId !== prev[postId]) restoreReplyDraft(commentId)
          }
          return next
        })
      },
      [restoreReplyDraft, setReplyingTo]
    ),
    replyContent,
    setReplyContent,
    expandedReplies,
    setExpandedReplies,

    // Content expand
    expandedPosts,
    setExpandedPosts,

    // Actions
    handleLike,
    handleBookmark,
    handleRepost,
    handleDeletePost,
    handleSaveEdit,
    handlePinPost,
    toggleComments,
    submitComment,
    submitReply,
    getHeatColor,
    maxComments,
  }
}
