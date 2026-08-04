'use client'

import { useState, useCallback, useRef, useEffect, useMemo, useLayoutEffect } from 'react'
import { supabase as _supabase } from '@/lib/supabase/client'
import type { SupabaseClient } from '@supabase/supabase-js'
const supabase = _supabase as SupabaseClient
import { authedFetch } from '@/lib/api/client'
import {
  fetchPostCommentsPage,
  isCreatedCommentAcknowledgement,
  isDefinitiveMutationRejection,
} from '@/lib/api/comments-client'
import { logger } from '@/lib/logger'
import { shouldLoadExpandedGroupComments } from '@/lib/comments/group-comment-read'
import { useViewerOwnedState } from '@/lib/state/viewer-owned-state'
import {
  postBelongsToPinScope,
  postPinScopeKey,
  readPostPinAcknowledgement,
} from '@/lib/posts/post-pin-client'
import { readPostEditApiAcknowledgement } from '@/lib/posts/post-edit-contract'
import {
  readPostDeleteAcknowledgement,
  readPostDeleteError,
} from '@/lib/posts/post-delete-contract'
import {
  POST_REACTION_OPERATION,
  createPostReactionRequestId,
  isDefinitivePostReactionRejection,
  nextPostReactionState,
  postReactionCountDelta,
  readPostReactionAcknowledgement,
  type PostReaction,
  type PostReactionAcknowledgement,
} from '@/lib/posts/post-reaction-client-contract'
import {
  POST_BOOKMARK_OPERATION,
  createPostBookmarkRequestId,
  isDefinitivePostBookmarkRejection,
  readPostBookmarkAcknowledgement,
  readPostBookmarkStatusAcknowledgement,
} from '@/lib/bookmarks/post-bookmark-client-contract'
import {
  POST_REPOST_OPERATION,
  createPostRepostRequestId,
  readPostRepostAcknowledgement,
} from '@/lib/reposts/post-repost-client-contract'

export interface Post {
  id: string
  group_id: string
  title: string
  content?: string | null
  created_at: string
  updated_at: string
  content_version: number
  language?: string | null
  mentions?: string[] | null
  hashtags?: string[] | null
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

type GroupReactionTruth = {
  reaction: PostReaction | null
  likeCount: number
  dislikeCount: number
}

type GroupReactionContext = {
  scope: { viewerKey: string; sessionGeneration: number; userId: string | null }
  groupId: string
}

type GroupReactionLane = {
  key: string
  context: GroupReactionContext
  postId: string
  desired: PostReaction | null
  revision: number
  confirmed: GroupReactionTruth
  confirmedTruthIsCertain: boolean
  promise: Promise<void>
}

function applyGroupReactionDesired(post: Post, desired: PostReaction | null): Post {
  const current = post.user_reaction ?? null
  const delta = postReactionCountDelta(current, desired)
  return {
    ...post,
    user_liked: desired === 'up',
    user_reaction: desired,
    like_count: Math.max(0, (post.like_count ?? 0) + delta.likeCount),
    dislike_count: Math.max(0, (post.dislike_count ?? 0) + delta.dislikeCount),
  }
}

function applyGroupReactionAcknowledgement(
  post: Post,
  acknowledgement: PostReactionAcknowledgement,
  latestDesired: PostReaction | null
): Post {
  return applyGroupReactionDesired(
    {
      ...post,
      user_liked: acknowledgement.reaction === 'up',
      user_reaction: acknowledgement.reaction,
      like_count: acknowledgement.likeCount,
      dislike_count: acknowledgement.dislikeCount,
    },
    latestDesired
  )
}

function groupReactionKey(context: GroupReactionContext, postId: string): string {
  return `${context.scope.viewerKey}\u0000${context.scope.sessionGeneration}\u0000${context.groupId}\u0000${postId}`
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
  'id, group_id, title, content, created_at, updated_at, content_version, language, mentions, hashtags, author_handle, author_id, like_count, dislike_count, comment_count, bookmark_count, repost_count, is_pinned'

class BookmarkStatusReadError extends Error {
  constructor() {
    super('Bookmark status authority unavailable')
    this.name = 'BookmarkStatusReadError'
  }
}

// A failed personalized bookmark query is not equivalent to an explicit
// empty result. Throw so the caller preserves its last-known viewer state.
async function fetchUserBookmarks(
  postIds: string[],
  userId: string
): Promise<Record<string, boolean>> {
  if (!userId || postIds.length === 0) return {}
  const { data, error } = await supabase
    .from('post_bookmarks')
    .select('post_id')
    .eq('user_id', userId)
    .in('post_id', postIds)
  if (error || !Array.isArray(data)) {
    throw new BookmarkStatusReadError()
  }

  const requestedPostIds = new Set(postIds)
  const seenPostIds = new Set<string>()
  const map: Record<string, boolean> = {}
  for (const item of data) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).length !== 1 ||
      typeof item.post_id !== 'string' ||
      !requestedPostIds.has(item.post_id) ||
      seenPostIds.has(item.post_id)
    ) {
      throw new BookmarkStatusReadError()
    }
    seenPostIds.add(item.post_id)
    map[item.post_id] = true
  }
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
    fetchUserBookmarks(postIds, userId),
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
  const mountedRef = useRef(true)
  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
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
        mountedRef.current &&
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
  const postsRef = useRef(posts)
  postsRef.current = posts
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
  const likeRequestLaneRef = useRef<Map<string, GroupReactionLane>>(new Map())
  const reactionStateRevisionRef = useRef<Map<string, number>>(new Map())
  const bookmarkRequestLockRef = useRef<Set<string>>(new Set())
  const repostRequestLockRef = useRef<Set<string>>(new Set())
  const editRequestLockRef = useRef<Set<string>>(new Set())
  const pinRequestLockRef = useRef<Set<string>>(new Set())
  const deleteRequestLockRef = useRef<Set<string>>(new Set())

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
  const loadCommentsRef = useRef<(postId: string, showError?: boolean) => Promise<boolean>>(() =>
    Promise.resolve(false)
  )
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
    likeRequestLaneRef.current.clear()
    reactionStateRevisionRef.current.clear()
    bookmarkRequestLockRef.current.clear()
    repostRequestLockRef.current.clear()
    pinRequestLockRef.current.clear()
    editRequestLockRef.current.clear()
    deleteRequestLockRef.current.clear()
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

  const markReactionStateChanged = useCallback((key: string) => {
    reactionStateRevisionRef.current.set(key, (reactionStateRevisionRef.current.get(key) || 0) + 1)
  }, [])

  const preserveNewerReactionState = useCallback(
    (
      incoming: Post[],
      revisionAtStart: ReadonlyMap<string, number>,
      context: GroupReactionContext
    ): Post[] => {
      const currentById = new Map(postsRef.current.map((post) => [post.id, post]))
      return incoming.map((post) => {
        const key = groupReactionKey(context, post.id)
        const changedAfterReadStarted =
          (reactionStateRevisionRef.current.get(key) || 0) !== (revisionAtStart.get(key) || 0)
        if (!changedAfterReadStarted && !likeRequestLaneRef.current.has(key)) return post
        const current = currentById.get(post.id)
        if (!current) return post
        return {
          ...post,
          user_liked: current.user_liked,
          user_reaction: current.user_reaction,
          like_count: current.like_count,
          dislike_count: current.dislike_count,
        }
      })
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
      const capturedScope = activeScopeRef.current
      const reactionRevisionAtStart = new Map(reactionStateRevisionRef.current)
      const reactionContext = { scope: capturedScope, groupId }
      if (!scopeIsCurrent(capturedScope)) return
      if (!groupId) {
        setPosts([])
        setHasMorePosts(false)
        return
      }

      const requestGeneration = ++postsRequestGenerationRef.current
      try {
        const postsList = await fetchPosts()
        if (
          !scopeIsCurrent(capturedScope) ||
          requestGeneration !== postsRequestGenerationRef.current
        ) {
          return
        }
        await enrichPosts(postsList)
        if (
          !scopeIsCurrent(capturedScope) ||
          requestGeneration !== postsRequestGenerationRef.current
        ) {
          return
        }
        setPosts(preserveNewerReactionState(postsList, reactionRevisionAtStart, reactionContext))
        setHasMorePosts(postsList.length === POST_PAGE_SIZE)
      } catch (err) {
        if (
          !scopeIsCurrent(capturedScope) ||
          requestGeneration !== postsRequestGenerationRef.current
        ) {
          return
        }
        const error =
          err instanceof BookmarkStatusReadError
            ? t('loadBookmarksFailed')
            : err instanceof Error
              ? err.message
              : 'Failed to load posts'
        showToast(error, 'error')
      }
    },
    [
      enrichPosts,
      fetchPosts,
      groupId,
      preserveNewerReactionState,
      scopeIsCurrent,
      setHasMorePosts,
      setPosts,
      showToast,
      t,
    ]
  )

  // Infinite scroll: load more
  const loadMorePosts = useCallback(async () => {
    const capturedScope = activeScopeRef.current
    const reactionRevisionAtStart = new Map(reactionStateRevisionRef.current)
    const reactionContext = { scope: capturedScope, groupId }
    if (!scopeIsCurrent(capturedScope) || loadingMore || !hasMorePosts || posts.length === 0) return
    const requestGeneration = ++postsRequestGenerationRef.current
    setLoadingMore(true)
    try {
      const lastPost = posts[posts.length - 1]
      const postsList = await fetchPosts(lastPost.created_at)
      if (
        !scopeIsCurrent(capturedScope) ||
        requestGeneration !== postsRequestGenerationRef.current
      ) {
        return
      }

      if (postsList.length > 0) {
        await enrichPosts(postsList)
        if (
          !scopeIsCurrent(capturedScope) ||
          requestGeneration !== postsRequestGenerationRef.current
        ) {
          return
        }
        const safePosts = preserveNewerReactionState(
          postsList,
          reactionRevisionAtStart,
          reactionContext
        )
        setPosts((prev) => [...prev, ...safePosts])
        setHasMorePosts(postsList.length === POST_PAGE_SIZE)
      } else {
        setHasMorePosts(false)
      }
    } catch (err) {
      if (!scopeIsCurrent(capturedScope) || requestGeneration !== postsRequestGenerationRef.current)
        return
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
    groupId,
    hasMorePosts,
    loadingMore,
    posts,
    preserveNewerReactionState,
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

  const runReactionLane = useCallback(
    async (lane: GroupReactionLane): Promise<void> => {
      while (
        likeRequestLaneRef.current.get(lane.key) === lane &&
        mutationContextIsCurrent(lane.context)
      ) {
        const desired = lane.desired
        const revision = lane.revision
        const requestId = createPostReactionRequestId()
        let result: Awaited<ReturnType<typeof apiCall>> | null = null
        let acknowledgement: PostReactionAcknowledgement | null = null
        for (let attempt = 0; attempt < 2; attempt += 1) {
          result = await apiCall(
            `/api/posts/${lane.postId}/like`,
            {
              body: {
                operation: POST_REACTION_OPERATION,
                request_id: requestId,
                desired_reaction: desired,
              },
            },
            lane.context.scope
          )

          if (
            likeRequestLaneRef.current.get(lane.key) !== lane ||
            !mutationContextIsCurrent(lane.context) ||
            result.stale
          ) {
            return
          }

          acknowledgement =
            result.ok && result.status === 200 && lane.context.scope.userId
              ? readPostReactionAcknowledgement(result.data, {
                  actorId: lane.context.scope.userId,
                  postId: lane.postId,
                  requestId,
                  desiredReaction: desired,
                })
              : null
          if (acknowledgement || isDefinitivePostReactionRejection(result.status)) break
          lane.confirmedTruthIsCertain = false
        }

        if (!result) return

        if (acknowledgement) {
          lane.confirmed = {
            reaction: acknowledgement.reaction,
            likeCount: acknowledgement.likeCount,
            dislikeCount: acknowledgement.dislikeCount,
          }
          lane.confirmedTruthIsCertain = true
          const latestDesired = lane.desired
          markReactionStateChanged(lane.key)
          setPosts((previous) =>
            previous.map((post) =>
              post.id === lane.postId
                ? applyGroupReactionAcknowledgement(post, acknowledgement, latestDesired)
                : post
            )
          )
          if (lane.revision === revision || latestDesired === desired) return
          continue
        }

        const definitiveRejection = isDefinitivePostReactionRejection(result.status)
        if (lane.revision !== revision) continue

        if (definitiveRejection && lane.confirmedTruthIsCertain) {
          const confirmedReaction = lane.confirmed.reaction
          markReactionStateChanged(lane.key)
          setPosts((previous) =>
            previous.map((post) =>
              post.id === lane.postId ? applyGroupReactionDesired(post, confirmedReaction) : post
            )
          )
        }

        showToast(result.error || t('operationFailed'), 'error')
        return
      }
    },
    [apiCall, markReactionStateChanged, mutationContextIsCurrent, setPosts, showToast, t]
  )

  // Like handler
  const handleLike = useCallback(
    async (postId: string) => {
      if (!accessToken) {
        showToast(t('pleaseLoginFirst'), 'warning')
        return
      }
      const context = captureMutationContext()
      if (!context.scope.userId || !mutationContextIsCurrent(context)) return
      const post = postsRef.current.find((candidate) => candidate.id === postId)
      if (!post) return
      const key = groupReactionKey(context, postId)
      const existingLane = likeRequestLaneRef.current.get(key)
      if (existingLane) {
        const desired = nextPostReactionState(existingLane.desired, 'up')
        if (existingLane.desired === desired) return existingLane.promise
        existingLane.desired = desired
        existingLane.revision += 1
        markReactionStateChanged(key)
        setPosts((previous) =>
          previous.map((candidate) =>
            candidate.id === postId ? applyGroupReactionDesired(candidate, desired) : candidate
          )
        )
        return existingLane.promise
      }

      const desired = nextPostReactionState(post.user_reaction ?? null, 'up')
      const lane: GroupReactionLane = {
        key,
        context,
        postId,
        desired,
        revision: 1,
        confirmed: {
          reaction: post.user_reaction ?? null,
          likeCount: post.like_count ?? 0,
          dislikeCount: post.dislike_count ?? 0,
        },
        confirmedTruthIsCertain: true,
        promise: Promise.resolve(),
      }
      likeRequestLaneRef.current.set(key, lane)
      markReactionStateChanged(key)
      setPosts((previous) =>
        previous.map((candidate) =>
          candidate.id === postId ? applyGroupReactionDesired(candidate, desired) : candidate
        )
      )
      setPostLoading(setLikeLoading, postId, true)
      try {
        lane.promise = runReactionLane(lane)
        await lane.promise
      } finally {
        if (
          likeRequestLaneRef.current.get(key) === lane &&
          likeRequestLaneRef.current.delete(key) &&
          mutationContextIsCurrent(context)
        ) {
          setPostLoading(setLikeLoading, postId, false)
        }
      }
    },
    [
      accessToken,
      captureMutationContext,
      mutationContextIsCurrent,
      markReactionStateChanged,
      runReactionLane,
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
      const context = captureMutationContext()
      if (!context.scope.userId || !mutationContextIsCurrent(context)) return
      const requestId = createPostBookmarkRequestId()
      const lockKey = `${context.scope.viewerKey}\u0000${context.scope.sessionGeneration}\u0000${context.groupId}\u0000${postId}`
      if (bookmarkRequestLockRef.current.has(lockKey)) return
      bookmarkRequestLockRef.current.add(lockKey)
      setPostLoading(setBookmarkLoading, postId, true)
      const previousPost = postsRef.current.find((post) => post.id === postId)
      const previousBookmarked = previousPost?.user_bookmarked ?? false
      const previousCount = previousPost?.bookmark_count ?? 0
      const requestedBookmarked = !previousBookmarked
      try {
        const result = await apiCall(
          `/api/posts/${postId}/bookmark`,
          {
            body: { operation: POST_BOOKMARK_OPERATION, request_id: requestId },
          },
          context.scope
        )
        if (!mutationContextIsCurrent(context)) return
        const acknowledgement =
          result.ok && result.status === 200
            ? readPostBookmarkAcknowledgement(result.data, {
                actorId: context.scope.userId,
                postId,
                requestId,
              })
            : null
        if (acknowledgement) {
          setPosts((prev) =>
            prev.map((p) =>
              p.id === postId
                ? {
                    ...p,
                    user_bookmarked: acknowledgement.bookmarked,
                    bookmark_count: acknowledgement.bookmarkCount,
                  }
                : p
            )
          )
          return
        }

        if (isDefinitivePostBookmarkRejection(result.status)) {
          showToast(
            result.error || (result.status === 0 ? t('networkError') : t('operationFailed')),
            'error'
          )
          return
        }

        const statusRequestId = createPostBookmarkRequestId()
        const statusResult = await apiCall(
          '/api/posts/bookmarks/status',
          { body: { postIds: [postId], request_id: statusRequestId } },
          context.scope
        )
        if (!mutationContextIsCurrent(context)) return
        const statusAcknowledgement =
          statusResult.ok && statusResult.status === 200
            ? readPostBookmarkStatusAcknowledgement(statusResult.data, {
                actorId: context.scope.userId,
                requestId: statusRequestId,
                postIds: [postId],
              })
            : null
        if (!statusAcknowledgement) {
          showToast(
            result.error || (result.status === 0 ? t('networkError') : t('operationFailed')),
            'error'
          )
          return
        }

        const bookmarked = statusAcknowledgement.bookmarks[postId.toLowerCase()]
        const ownCountDelta = bookmarked === previousBookmarked ? 0 : bookmarked ? 1 : -1
        setPosts((prev) =>
          prev.map((p) =>
            p.id === postId
              ? {
                  ...p,
                  user_bookmarked: bookmarked,
                  bookmark_count: Math.max(0, (p.bookmark_count ?? previousCount) + ownCountDelta),
                }
              : p
          )
        )
        if (bookmarked !== requestedBookmarked) {
          showToast(t('operationFailed'), 'error')
        }
      } finally {
        if (bookmarkRequestLockRef.current.delete(lockKey) && mutationContextIsCurrent(context)) {
          setPostLoading(setBookmarkLoading, postId, false)
        }
      }
    },
    [
      accessToken,
      apiCall,
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
      const context = captureMutationContext()
      if (!context.scope.userId || !mutationContextIsCurrent(context)) return
      const post = postsRef.current.find((candidate) => candidate.id === postId)
      if (!post) {
        showToast(t('repostFailed'), 'error')
        return
      }
      if (post.author_id === context.scope.userId) {
        showToast(t('cannotRepostOwn'), 'warning')
        return
      }
      if (post.user_reposted) {
        showToast(t('alreadyReposted'), 'warning')
        return
      }
      const requestId = createPostRepostRequestId()
      const requestLockKey = `${context.scope.viewerKey}\u0000${context.scope.sessionGeneration}\u0000${context.groupId}\u0000${postId}`
      if (repostRequestLockRef.current.has(requestLockKey)) return
      repostRequestLockRef.current.add(requestLockKey)
      setPostLoading(setRepostLoading, postId, true)
      try {
        const result = await apiCall(
          `/api/posts/${postId}/repost`,
          {
            body: {
              operation: POST_REPOST_OPERATION,
              request_id: requestId,
              comment: comment ?? '',
            },
          },
          context.scope
        )
        if (!mutationContextIsCurrent(context)) return
        const expected = {
          actorId: context.scope.userId,
          sourcePostId: postId,
          rootPostId: postId,
          requestId,
        }
        const acknowledgement =
          result.ok && result.status === 201
            ? readPostRepostAcknowledgement(result.data, { ...expected, action: 'created' })
            : !result.ok && result.status === 409
              ? readPostRepostAcknowledgement(result.data, {
                  ...expected,
                  action: 'already_exists',
                })
              : null
        if (acknowledgement) {
          setPosts((prev) =>
            prev.map((p) =>
              p.id === acknowledgement.rootPostId
                ? { ...p, user_reposted: true, repost_count: acknowledgement.repostCount }
                : p
            )
          )
          setShowRepostModal(null)
          setRepostComment('')
          showToast(
            acknowledgement.action === 'created' ? t('repostSuccess') : t('alreadyReposted'),
            acknowledgement.action === 'created' ? 'success' : 'warning'
          )
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
      setPostLoading,
      setPosts,
      setRepostComment,
      setRepostLoading,
      setShowRepostModal,
      showToast,
      t,
    ]
  )

  // Delete post
  const handleDeletePost = useCallback(
    async (postId: string) => {
      const context = captureMutationContext()
      const requestLockKey = `${context.scope.viewerKey}\u0000${context.scope.sessionGeneration}\u0000${context.groupId}\u0000${postId}`
      if (deleteRequestLockRef.current.has(requestLockKey)) return
      deleteRequestLockRef.current.add(requestLockKey)
      try {
        const confirmed = await showDangerConfirm(t('deletePost'), t('deletePostConfirm'))
        if (!confirmed || !mutationContextIsCurrent(context)) return

        setDeletingPost(postId)
        const result = await apiCall(
          `/api/posts/${postId}/delete`,
          { method: 'DELETE' },
          context.scope
        )
        if (!mutationContextIsCurrent(context)) return
        if (result.ok && readPostDeleteAcknowledgement(result.data)) {
          setPosts((prev) => prev.filter((p) => p.id !== postId))
          showToast(t('postDeleted'), 'success')
        } else {
          showToast(readPostDeleteError(result.data) ?? result.error ?? t('deleteFailed'), 'error')
        }
      } finally {
        deleteRequestLockRef.current.delete(requestLockKey)
        if (mutationContextIsCurrent(context)) setDeletingPost(null)
      }
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
      const currentPost = postsRef.current.find((post) => post.id === postId)
      if (
        !currentPost ||
        currentPost.group_id !== context.groupId ||
        !Number.isSafeInteger(currentPost.content_version) ||
        currentPost.content_version < 0
      ) {
        showToast(t('editFailed'), 'error')
        return
      }
      const requestLockKey = `${context.scope.viewerKey}\u0000${context.scope.sessionGeneration}\u0000${context.groupId}\u0000${postId}`
      if (editRequestLockRef.current.has(requestLockKey)) return
      editRequestLockRef.current.add(requestLockKey)
      const submittedTitle = editTitle.trim()
      const submittedContent = editContent.trim()
      setSavingEdit(true)
      try {
        const result = await apiCall(
          `/api/posts/${postId}/edit`,
          {
            method: 'PUT',
            body: {
              title: submittedTitle,
              content: submittedContent,
              expected_version: currentPost.content_version,
            },
          },
          context.scope
        )
        if (!mutationContextIsCurrent(context)) return
        const acknowledgement = result.ok
          ? readPostEditApiAcknowledgement(result.data, postId)
          : null
        if (
          acknowledgement &&
          acknowledgement.author_id === context.scope.userId &&
          acknowledgement.group_id === context.groupId &&
          acknowledgement.content_version >= currentPost.content_version
        ) {
          setPosts((prev) =>
            prev.map((post) =>
              post.id === postId
                ? {
                    ...post,
                    title: acknowledgement.title,
                    content: acknowledgement.content,
                    language: acknowledgement.language,
                    mentions: acknowledgement.mentions,
                    hashtags: acknowledgement.hashtags,
                    updated_at: acknowledgement.updated_at,
                    content_version: acknowledgement.content_version,
                  }
                : post
            )
          )
          setEditingPost(null)
          showToast(t('editSaved'), 'success')
        } else {
          showToast(result.error || t('editFailed'), 'error')
        }
      } finally {
        editRequestLockRef.current.delete(requestLockKey)
        if (mutationContextIsCurrent(context)) setSavingEdit(false)
      }
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
      const currentPost = postsRef.current.find((post) => post.id === postId)
      const pinScope = currentPost ? postPinScopeKey(currentPost) : null
      if (!currentPost || !pinScope || currentPost.group_id !== context.groupId) return

      const desiredState = !Boolean(currentPost.is_pinned)
      const requestLockKey = `${context.scope.viewerKey}\u0000${context.scope.sessionGeneration}\u0000${pinScope}`
      if (pinRequestLockRef.current.has(requestLockKey)) return
      pinRequestLockRef.current.add(requestLockKey)

      try {
        const result = await apiCall(
          `/api/posts/${postId}/pin`,
          { body: { is_pinned: desiredState } },
          context.scope
        )
        if (!mutationContextIsCurrent(context)) return

        const acknowledgement = result.ok
          ? readPostPinAcknowledgement(result.data, {
              postId,
              authorId: currentPost.author_id,
              groupId: context.groupId,
              isPinned: desiredState,
            })
          : null

        if (!acknowledgement) {
          showToast(result.error || t('operationFailed'), 'error')
          return
        }

        setPosts((prev) =>
          prev.map((post) => {
            if (post.id === postId) return { ...post, is_pinned: acknowledgement.isPinned }
            if (
              acknowledgement.isPinned &&
              post.is_pinned &&
              postBelongsToPinScope(post, acknowledgement)
            ) {
              return { ...post, is_pinned: false }
            }
            return post
          })
        )
        showToast(acknowledgement.isPinned ? t('pinned') : t('unpinned'), 'success')
      } finally {
        pinRequestLockRef.current.delete(requestLockKey)
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
                if (scopeIsCurrent(capturedScope)) void loadCommentsRef.current(postId, false)
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
  loadCommentsRef.current = loadComments

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
