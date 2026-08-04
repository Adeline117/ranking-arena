'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { getCsrfHeaders } from '@/lib/api/client'
import { usePostStore } from '@/lib/stores/postStore'
import { logger } from '@/lib/logger'
import { haptic } from '@/lib/utils/haptics'
import { getNetworkErrorMessage } from '@/lib/utils/network-error'
import { trackEvent } from '@/lib/analytics/track'
import { type PollChoice, type PostWithUserState } from '@/lib/types'
import {
  bookmarkPostTarget,
  consumePostBookmarkLogin,
  queueProfileActionLogin,
} from '@/lib/auth/profile-action-login'
import { savePostToBookmarkFolder } from '@/lib/bookmarks/folder-save-client'
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
  POST_REACTION_REQUEST_TIMEOUT_MS,
  readPostReactionAcknowledgement,
} from '@/lib/posts/post-reaction-client-contract'

type Post = PostWithUserState

const EMPTY_BOOKMARK_FLAGS: Record<string, boolean> = {}
const EMPTY_BOOKMARK_COUNTS: Record<string, number> = {}

function consumePromise(work: Promise<unknown>): void {
  void work.then(
    () => undefined,
    () => undefined
  )
}

function waitWithinAbortSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    consumePromise(work)
    return Promise.reject(
      signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
    )
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

interface CustomPollState {
  customPoll: {
    id: string
    question: string
    options: { text: string; votes: number | null }[]
    type: 'single' | 'multiple'
    endAt: string | null
    isExpired: boolean
    showResults: boolean
    totalVotes: number | null
  } | null
  customPollUserVotes: number[]
  loadingCustomPoll: boolean
  votingCustomPoll: boolean
  selectedPollOptions: number[]
  setSelectedPollOptions: React.Dispatch<React.SetStateAction<number[]>>
  loadCustomPoll: (postId: string) => Promise<void>
  submitCustomPollVote: (postId: string) => Promise<void>
}

interface BookmarkRepostState {
  bookmarkLoading: Record<string, boolean>
  repostLoading: Record<string, boolean>
  showRepostModal: string | null
  setShowRepostModal: (v: string | null) => void
  openRepostModal: (postId: string) => Promise<void>
  userBookmarks: Record<string, boolean>
  setUserBookmarks: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  bookmarkCounts: Record<string, number>
  setBookmarkCounts: React.Dispatch<React.SetStateAction<Record<string, number>>>
  showBookmarkModal: boolean
  setShowBookmarkModal: (v: boolean) => void
  bookmarkingPostId: string | null
  setBookmarkingPostId: (v: string | null) => void
  handleBookmark: (postId: string) => Promise<void>
  openBookmarkFolderModal: (postId: string) => void
  handleBookmarkToFolder: (folderId: string) => Promise<boolean>
  handleRepost: (postId: string, comment?: string) => Promise<boolean>
  loadUserBookmarksAndReposts: (postIds: string[]) => Promise<void>
}

interface EditDeletePinState {
  editingPost: Post | null
  setEditingPost: (v: Post | null) => void
  editTitle: string
  setEditTitle: (v: string) => void
  editContent: string
  setEditContent: (v: string) => void
  savingEdit: boolean
  handleStartEdit: (post: Post, e: React.MouseEvent) => void
  handleSaveEdit: () => Promise<void>
  handleDeletePost: (post: Post, e: React.MouseEvent) => Promise<void>
  handleTogglePin: (post: Post, e: React.MouseEvent) => Promise<void>
}

export interface PostActionsReturn
  extends CustomPollState, BookmarkRepostState, EditDeletePinState {
  toggleReaction: (postId: string, reactionType: 'up' | 'down') => Promise<void>
  _toggleVote: (postId: string, choice: PollChoice) => Promise<void>
}

export function usePostActions({
  accessToken,
  currentUserId,
  viewerKey: suppliedViewerKey,
  sessionGeneration = 0,
  posts,
  setPosts,
  openPost,
  setOpenPost,
  openPostAliasesPosts = false,
  showToast,
  showDangerConfirm,
  t,
}: {
  accessToken: string | null
  currentUserId: string | null
  viewerKey?: string
  sessionGeneration?: number
  posts: Post[]
  setPosts: React.Dispatch<React.SetStateAction<Post[]>>
  openPost: Post | null
  setOpenPost: (v: Post | null) => void
  /**
   * True when `posts` and `openPost` are adapters over the same React state
   * (the standalone post-detail page). Record updates must then use only the
   * `setPosts` path or the second whole-object write can overwrite newer data.
   */
  openPostAliasesPosts?: boolean
  showToast: (msg: string, type: 'error' | 'success' | 'warning' | 'info') => void
  showDangerConfirm: (title: string, message: string) => Promise<boolean>
  t: (key: string) => string
}): PostActionsReturn {
  const router = useRouter()
  const viewerKey = suppliedViewerKey ?? (currentUserId ? `user:${currentUserId}` : 'anon')
  const scopeKey = `${viewerKey}\u0000${sessionGeneration}`
  const activeScopeRef = useRef({ viewerKey, sessionGeneration, userId: currentUserId })
  activeScopeRef.current = { viewerKey, sessionGeneration, userId: currentUserId }
  const captureRenderedScope = useCallback(
    () => ({ viewerKey, sessionGeneration, userId: currentUserId }),
    [currentUserId, sessionGeneration, viewerKey]
  )
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
  const lockRef = useRef<Set<string>>(new Set())
  const bookmarkLockRef = useRef<Set<string>>(new Set())
  const pinRequestLockRef = useRef<Set<string>>(new Set())
  const editRequestLockRef = useRef<Set<string>>(new Set())
  const deleteRequestLockRef = useRef<Set<string>>(new Set())
  const postsRef = useRef(posts)
  postsRef.current = posts
  // Always read the FRESHEST openPost. The toggleReaction callback is memoized on
  // openPost?.id, so a plain closure over `openPost` freezes its counts at whichever
  // render created the callback. On the single-post detail page `setPosts` and
  // `setOpenPost` alias the same state, so a stale-count literal in setOpenPost was
  // clobbering the correct functional setPosts update → a single like showed +2 (U8-3).
  const openPostRef = useRef(openPost)
  openPostRef.current = openPost

  // Edit state
  const [editingPostState, setEditingPostRaw] = useState<Post | null>(null)
  const [editTitleState, setEditTitleRaw] = useState('')
  const [editContentState, setEditContentRaw] = useState('')
  const [savingEditState, setSavingEditRaw] = useState(false)
  const editOwnerScopeKeyRef = useRef(scopeKey)
  const claimEditScope = useCallback(() => {
    const current = activeScopeRef.current
    const currentScopeKey = `${current.viewerKey}\u0000${current.sessionGeneration}`
    if (editOwnerScopeKeyRef.current === currentScopeKey) return
    editOwnerScopeKeyRef.current = currentScopeKey
    setEditingPostRaw(null)
    setEditTitleRaw('')
    setEditContentRaw('')
    setSavingEditRaw(false)
  }, [])
  const setEditingPost = useCallback(
    (value: Post | null) => {
      claimEditScope()
      setEditingPostRaw(value)
    },
    [claimEditScope]
  )
  const setEditTitle = useCallback(
    (value: string) => {
      claimEditScope()
      setEditTitleRaw(value)
    },
    [claimEditScope]
  )
  const setEditContent = useCallback(
    (value: string) => {
      claimEditScope()
      setEditContentRaw(value)
    },
    [claimEditScope]
  )
  const setSavingEdit = useCallback(
    (value: boolean) => {
      claimEditScope()
      setSavingEditRaw(value)
    },
    [claimEditScope]
  )
  const editScopeOwned = editOwnerScopeKeyRef.current === scopeKey
  const editingPost = editScopeOwned ? editingPostState : null
  const editTitle = editScopeOwned ? editTitleState : ''
  const editContent = editScopeOwned ? editContentState : ''
  const savingEdit = editScopeOwned ? savingEditState : false

  // Custom poll state
  const [customPoll, setCustomPoll] = useState<CustomPollState['customPoll']>(null)
  const [customPollUserVotes, setCustomPollUserVotes] = useState<number[]>([])
  const [loadingCustomPoll, setLoadingCustomPoll] = useState(false)
  const [votingCustomPoll, setVotingCustomPoll] = useState(false)
  const [selectedPollOptions, setSelectedPollOptionsRaw] = useState<number[]>([])
  const pollOwnerScopeKeyRef = useRef(scopeKey)
  const claimPollScope = useCallback(() => {
    const current = activeScopeRef.current
    const currentScopeKey = `${current.viewerKey}\u0000${current.sessionGeneration}`
    if (pollOwnerScopeKeyRef.current === currentScopeKey) return
    pollOwnerScopeKeyRef.current = currentScopeKey
    setCustomPoll(null)
    setCustomPollUserVotes([])
    setLoadingCustomPoll(false)
    setVotingCustomPoll(false)
    setSelectedPollOptionsRaw([])
  }, [])
  const setSelectedPollOptions = useCallback<React.Dispatch<React.SetStateAction<number[]>>>(
    (action) => {
      claimPollScope()
      setSelectedPollOptionsRaw(action)
    },
    [claimPollScope]
  )

  // Bookmark/repost state
  const [bookmarkLoadingState, setBookmarkLoadingRaw] = useState<Record<string, boolean>>({})
  const [repostLoadingState, setRepostLoadingRaw] = useState<Record<string, boolean>>({})
  const [showRepostModalState, setShowRepostModalRaw] = useState<string | null>(null)
  const [userBookmarksState, setUserBookmarksRaw] = useState<Record<string, boolean>>({})
  const [bookmarkCountsState, setBookmarkCountsRaw] = useState<Record<string, number>>({})
  const bookmarkOwnerScopeKeyRef = useRef(scopeKey)
  const [showBookmarkModalState, setShowBookmarkModalRaw] = useState(false)
  const [bookmarkingPostIdState, setBookmarkingPostIdRaw] = useState<string | null>(null)
  const claimBookmarkScope = useCallback(() => {
    const current = activeScopeRef.current
    const currentScopeKey = `${current.viewerKey}\u0000${current.sessionGeneration}`
    if (bookmarkOwnerScopeKeyRef.current === currentScopeKey) return
    bookmarkOwnerScopeKeyRef.current = currentScopeKey
    setBookmarkLoadingRaw({})
    setUserBookmarksRaw({})
    setBookmarkCountsRaw({})
    setShowBookmarkModalRaw(false)
    setBookmarkingPostIdRaw(null)
  }, [])
  const setBookmarkLoading = useCallback<
    React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  >(
    (action) => {
      claimBookmarkScope()
      setBookmarkLoadingRaw(action)
    },
    [claimBookmarkScope]
  )
  const userBookmarks =
    bookmarkOwnerScopeKeyRef.current === scopeKey ? userBookmarksState : EMPTY_BOOKMARK_FLAGS
  const setUserBookmarks = useCallback<
    React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  >(
    (action) => {
      claimBookmarkScope()
      setUserBookmarksRaw(action)
    },
    [claimBookmarkScope]
  )
  const setBookmarkCounts = useCallback<
    React.Dispatch<React.SetStateAction<Record<string, number>>>
  >(
    (action) => {
      claimBookmarkScope()
      setBookmarkCountsRaw(action)
    },
    [claimBookmarkScope]
  )
  const setShowBookmarkModal = useCallback(
    (value: boolean) => {
      claimBookmarkScope()
      setShowBookmarkModalRaw(value)
    },
    [claimBookmarkScope]
  )
  const setBookmarkingPostId = useCallback(
    (value: string | null) => {
      claimBookmarkScope()
      setBookmarkingPostIdRaw(value)
    },
    [claimBookmarkScope]
  )
  const bookmarkScopeOwned = bookmarkOwnerScopeKeyRef.current === scopeKey
  const bookmarkLoading = bookmarkScopeOwned ? bookmarkLoadingState : {}
  const bookmarkCounts = bookmarkScopeOwned ? bookmarkCountsState : EMPTY_BOOKMARK_COUNTS
  const showBookmarkModal = bookmarkScopeOwned ? showBookmarkModalState : false
  const bookmarkingPostId = bookmarkScopeOwned ? bookmarkingPostIdState : null
  const repostOwnerScopeKeyRef = useRef(scopeKey)
  const claimRepostScope = useCallback(() => {
    const current = activeScopeRef.current
    const currentScopeKey = `${current.viewerKey}\u0000${current.sessionGeneration}`
    if (repostOwnerScopeKeyRef.current === currentScopeKey) return
    repostOwnerScopeKeyRef.current = currentScopeKey
    setRepostLoadingRaw({})
    setShowRepostModalRaw(null)
  }, [])
  const setRepostLoading = useCallback<
    React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  >(
    (action) => {
      claimRepostScope()
      setRepostLoadingRaw(action)
    },
    [claimRepostScope]
  )
  const setShowRepostModal = useCallback(
    (value: string | null) => {
      claimRepostScope()
      setShowRepostModalRaw(value)
    },
    [claimRepostScope]
  )
  const repostScopeOwned = repostOwnerScopeKeyRef.current === scopeKey
  const repostLoading = repostScopeOwned ? repostLoadingState : {}
  const showRepostModal = repostScopeOwned ? showRepostModalState : null

  // Toggle reaction
  const toggleReaction = useCallback(
    async (postId: string, reactionType: 'up' | 'down') => {
      const capturedScope = captureRenderedScope()
      if (!scopeIsCurrent(capturedScope)) return
      if (!accessToken) {
        const { useLoginModal } = await import('@/lib/hooks/useLoginModal')
        if (scopeIsCurrent(capturedScope)) useLoginModal.getState().openLoginModal()
        return
      }
      if (!capturedScope.userId) return
      const key = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}\u0000react-${postId}`
      if (lockRef.current.has(key)) return
      lockRef.current.add(key)

      // Compute delta from CURRENT state (not a captured snapshot) to avoid
      // stale-reference bugs when parent re-renders during the fetch.
      const currentPost = postsRef.current.find((p) => p.id === postId)
      if (!currentPost) {
        lockRef.current.delete(key)
        return
      }

      const currentReaction = currentPost.user_reaction
      const newReaction = currentReaction === reactionType ? null : reactionType
      // Store the delta so rollback can reverse it from latest state
      const likeDelta =
        reactionType === 'up'
          ? currentReaction === 'up'
            ? -1
            : 1
          : currentReaction === 'up'
            ? -1
            : 0
      const dislikeDelta =
        reactionType === 'down'
          ? currentReaction === 'down'
            ? -1
            : 1
          : currentReaction === 'down'
            ? -1
            : 0

      // Optimistic update — apply delta
      setPosts((prev) =>
        prev.map((p) =>
          p.id === postId
            ? {
                ...p,
                like_count: p.like_count + likeDelta,
                dislike_count: p.dislike_count + dislikeDelta,
                user_reaction: newReaction,
              }
            : p
        )
      )
      {
        const op = openPostRef.current
        if (!openPostAliasesPosts && op?.id === postId)
          setOpenPost({
            ...op,
            like_count: op.like_count + likeDelta,
            dislike_count: op.dislike_count + dislikeDelta,
            user_reaction: newReaction,
          } as Post)
      }
      haptic('light')

      const rollback = () => {
        setPosts((prev) =>
          prev.map((p) =>
            p.id === postId
              ? {
                  ...p,
                  like_count: p.like_count - likeDelta,
                  dislike_count: p.dislike_count - dislikeDelta,
                  user_reaction: currentReaction,
                }
              : p
          )
        )
        const op = openPostRef.current
        if (!openPostAliasesPosts && op?.id === postId) {
          setOpenPost({
            ...op,
            like_count: op.like_count - likeDelta,
            dislike_count: op.dislike_count - dislikeDelta,
            user_reaction: currentReaction,
          } as Post)
        }
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(
        () => controller.abort(new DOMException('Post reaction request timed out', 'AbortError')),
        POST_REACTION_REQUEST_TIMEOUT_MS
      )

      try {
        const response = await waitWithinAbortSignal(
          fetch(`/api/posts/${postId}/like`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
              ...getCsrfHeaders(),
            },
            body: JSON.stringify({ reaction_type: reactionType }),
            cache: 'no-store',
            signal: controller.signal,
          }),
          controller.signal
        )
        const json: unknown = await waitWithinAbortSignal(response.json(), controller.signal)
        if (!scopeIsCurrent(capturedScope)) return
        const acknowledgement =
          response.ok && response.status === 200
            ? readPostReactionAcknowledgement(json, {
                actorId: capturedScope.userId,
                postId,
                requestedReaction: reactionType,
              })
            : null
        if (acknowledgement) {
          // Reconcile with server truth (overwrites optimistic)
          const reconcileServer = (post: Post): Post => ({
            ...post,
            like_count: acknowledgement.likeCount,
            dislike_count: acknowledgement.dislikeCount,
            user_reaction: acknowledgement.reaction,
          })
          setPosts((prev) => prev.map((p) => (p.id === postId ? reconcileServer(p) : p)))
          usePostStore.getState().updatePostReaction(postId, {
            like_count: acknowledgement.likeCount,
            dislike_count: acknowledgement.dislikeCount,
            reaction: acknowledgement.reaction,
          })
          {
            const op = openPostRef.current
            if (!openPostAliasesPosts && op?.id === postId) setOpenPost(reconcileServer(op))
          }
          // Analytics: only count a NEW reaction, not an un-react.
          if (acknowledgement.reaction) {
            trackEvent('post_reaction', {
              post_id: acknowledgement.postId,
              reaction: acknowledgement.reaction,
            })
          }
        } else {
          rollback()
          const errorMessage =
            json !== null && typeof json === 'object' && !Array.isArray(json)
              ? (json as Record<string, unknown>).error
              : null
          showToast(typeof errorMessage === 'string' ? errorMessage : t('operationFailed'), 'error')
        }
      } catch (err) {
        if (!scopeIsCurrent(capturedScope)) return
        rollback()
        logger.error('[PostFeed] toggleReaction error:', err)
        showToast(getNetworkErrorMessage(err, t), 'error')
      } finally {
        clearTimeout(timeoutId)
        lockRef.current.delete(key)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      accessToken,
      captureRenderedScope,
      openPost?.id,
      openPostAliasesPosts,
      scopeIsCurrent,
      showToast,
    ]
  )

  // Built-in poll voting
  const _toggleVote = useCallback(
    async (postId: string, choice: PollChoice) => {
      const capturedScope = captureRenderedScope()
      if (!scopeIsCurrent(capturedScope)) return
      if (!accessToken) {
        const { useLoginModal } = await import('@/lib/hooks/useLoginModal')
        if (scopeIsCurrent(capturedScope)) useLoginModal.getState().openLoginModal()
        return
      }
      const key = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}\u0000vote-${postId}-${choice}`
      if (lockRef.current.has(key)) return
      lockRef.current.add(key)
      try {
        const response = await fetch(`/api/posts/${postId}/vote`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ choice }),
        })
        const json = await response.json()
        if (!scopeIsCurrent(capturedScope)) return
        if (response.ok && json.success) {
          const result = json.data
          setPosts((prev) =>
            prev.map((p) =>
              p.id === postId
                ? {
                    ...p,
                    poll_bull: result.poll.bull,
                    poll_bear: result.poll.bear,
                    poll_wait: result.poll.wait,
                    user_vote: result.vote,
                  }
                : p
            )
          )
          if (!openPostAliasesPosts && openPost?.id === postId)
            setOpenPost({
              ...openPost!,
              poll_bull: result.poll.bull,
              poll_bear: result.poll.bear,
              poll_wait: result.poll.wait,
              user_vote: result.vote,
            })
        } else {
          showToast(json.error || json.message || t('voteFailed'), 'error')
        }
      } catch (err) {
        if (!scopeIsCurrent(capturedScope)) return
        logger.error('[PostFeed] toggleVote error:', err)
        showToast(getNetworkErrorMessage(err, t), 'error')
      } finally {
        lockRef.current.delete(key)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      accessToken,
      captureRenderedScope,
      openPost?.id,
      openPostAliasesPosts,
      scopeIsCurrent,
      showToast,
    ]
  )

  // Custom poll
  const loadCustomPoll = useCallback(
    async (postId: string) => {
      const capturedScope = captureRenderedScope()
      if (!scopeIsCurrent(capturedScope)) return
      claimPollScope()
      setLoadingCustomPoll(true)
      setCustomPoll(null)
      setCustomPollUserVotes([])
      setSelectedPollOptions([])
      try {
        const headers: Record<string, string> = {}
        if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`
        const response = await fetch(`/api/posts/${postId}/poll-vote`, { headers })
        const data = await response.json()
        if (!scopeIsCurrent(capturedScope)) return
        if (response.ok && data.success && data.data?.poll) {
          setCustomPoll(data.data.poll)
          setCustomPollUserVotes(data.data.userVotes || [])
          setSelectedPollOptions(data.data.userVotes || [])
        }
      } catch {
        /* silent */
      } finally {
        if (scopeIsCurrent(capturedScope)) setLoadingCustomPoll(false)
      }
    },
    [accessToken, captureRenderedScope, claimPollScope, scopeIsCurrent, setSelectedPollOptions]
  )

  const submitCustomPollVote = useCallback(
    async (postId: string) => {
      const capturedScope = captureRenderedScope()
      if (!scopeIsCurrent(capturedScope)) return
      if (!accessToken) {
        const { useLoginModal } = await import('@/lib/hooks/useLoginModal')
        if (scopeIsCurrent(capturedScope)) useLoginModal.getState().openLoginModal()
        return
      }
      if (selectedPollOptions.length === 0) {
        showToast(t('selectAtLeastOneOption'), 'warning')
        return
      }
      claimPollScope()
      setVotingCustomPoll(true)
      try {
        const response = await fetch(`/api/posts/${postId}/poll-vote`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ optionIndexes: selectedPollOptions }),
        })
        const data = await response.json()
        if (!scopeIsCurrent(capturedScope)) return
        if (response.ok && data.success) {
          setCustomPoll((prev) =>
            prev
              ? {
                  ...prev,
                  options: data.data.poll.options,
                  showResults: true,
                  totalVotes: data.data.poll.totalVotes,
                }
              : null
          )
          setCustomPollUserVotes(data.data.userVotes)
          showToast(t('voted'), 'success')
        } else {
          showToast(data.error || t('voteFailed'), 'error')
        }
      } catch (err) {
        if (!scopeIsCurrent(capturedScope)) return
        logger.error('[PostFeed] custom poll vote failed:', err)
        showToast(t('voteFailed'), 'error')
      } finally {
        if (scopeIsCurrent(capturedScope)) setVotingCustomPoll(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accessToken, captureRenderedScope, claimPollScope, scopeIsCurrent, selectedPollOptions]
  )

  const redirectBookmarkToLogin = useCallback(
    (postId: string) => {
      router.push(
        queueProfileActionLogin({
          action: 'bookmark-post',
          target: bookmarkPostTarget(postId),
          fallbackPath: `/post/${postId}`,
          initiatingUserId: currentUserId,
        })
      )
    },
    [currentUserId, router]
  )

  // Bookmark (with optimistic update, matching toggleReaction pattern)
  // Uses ref-based lock (synchronous) to prevent duplicate clicks — state-based
  // guards have a tiny race window because React batches setState calls.
  const handleBookmark = useCallback(
    async (postId: string) => {
      const capturedScope = captureRenderedScope()
      if (!scopeIsCurrent(capturedScope)) return
      if (!accessToken) {
        if (scopeIsCurrent(capturedScope)) redirectBookmarkToLogin(postId)
        return
      }
      const lockKey = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}\u0000${postId}`
      if (bookmarkLockRef.current.has(lockKey)) return
      bookmarkLockRef.current.add(lockKey)
      setBookmarkLoading((prev) => ({ ...prev, [postId]: true }))

      // Save previous state for rollback
      const prevBookmarked = userBookmarks[postId] ?? false
      const prevCount = bookmarkCounts[postId] ?? 0

      // Optimistic update: toggle bookmark immediately
      const optimisticBookmarked = !prevBookmarked
      setUserBookmarks((prev) => ({ ...prev, [postId]: optimisticBookmarked }))
      setBookmarkCounts((prev) => ({
        ...prev,
        [postId]: optimisticBookmarked ? prevCount + 1 : Math.max(0, prevCount - 1),
      }))

      try {
        const response = await fetch(`/api/posts/${postId}/bookmark`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
        })
        const result = await response.json()
        if (!scopeIsCurrent(capturedScope)) return
        if (response.ok) {
          // Reconcile with server state
          setUserBookmarks((prev) => ({ ...prev, [postId]: result.bookmarked }))
          setBookmarkCounts((prev) => ({ ...prev, [postId]: result.bookmark_count }))
          // Sync bookmark count to feed posts array
          setPosts((prev) =>
            prev.map((p) => (p.id === postId ? { ...p, bookmark_count: result.bookmark_count } : p))
          )
          const op = openPostRef.current
          if (!openPostAliasesPosts && op?.id === postId)
            setOpenPost({ ...op, bookmark_count: result.bookmark_count } as Post)
          // Analytics: only count adding a bookmark, not removing one
          if (result.bookmarked) {
            trackEvent('post_bookmark', { post_id: postId })
          }
          showToast(result.bookmarked ? t('bookmarked') : t('unbookmarked'), 'success')
        } else {
          // Rollback on server error
          setUserBookmarks((prev) => ({ ...prev, [postId]: prevBookmarked }))
          setBookmarkCounts((prev) => ({ ...prev, [postId]: prevCount }))
          if (response.status === 401) {
            showToast(t('loginExpiredPleaseRelogin'), 'error')
            redirectBookmarkToLogin(postId)
            return
          }
          showToast(result.error || t('operationFailed'), 'error')
        }
      } catch (err) {
        if (!scopeIsCurrent(capturedScope)) return
        // Rollback on network error
        setUserBookmarks((prev) => ({ ...prev, [postId]: prevBookmarked }))
        setBookmarkCounts((prev) => ({ ...prev, [postId]: prevCount }))
        showToast(getNetworkErrorMessage(err, t), 'error')
      } finally {
        bookmarkLockRef.current.delete(lockKey)
        if (scopeIsCurrent(capturedScope)) {
          setBookmarkLoading((prev) => ({ ...prev, [postId]: false }))
        }
      }
    },
    [
      accessToken,
      showToast,
      t,
      userBookmarks,
      bookmarkCounts,
      captureRenderedScope,
      openPostAliasesPosts,
      setBookmarkCounts,
      setBookmarkLoading,
      setOpenPost,
      setPosts,
      setUserBookmarks,
      scopeIsCurrent,
      redirectBookmarkToLogin,
    ]
  )

  useEffect(() => {
    if (!accessToken || !currentUserId) return
    const resumedPostId = consumePostBookmarkLogin({ currentUserId })
    if (resumedPostId) {
      void handleBookmark(resumedPostId)
    }
  }, [accessToken, currentUserId, handleBookmark])

  const openBookmarkFolderModal = useCallback(
    (postId: string) => {
      const capturedScope = captureRenderedScope()
      if (!scopeIsCurrent(capturedScope)) return
      if (!accessToken) {
        import('@/lib/hooks/useLoginModal').then(({ useLoginModal }) =>
          scopeIsCurrent(capturedScope) ? useLoginModal.getState().openLoginModal() : undefined
        )
        return
      }
      setBookmarkingPostId(postId)
      setShowBookmarkModal(true)
    },
    [accessToken, captureRenderedScope, scopeIsCurrent, setBookmarkingPostId, setShowBookmarkModal]
  )

  const handleBookmarkToFolder = useCallback(
    async (folderId: string): Promise<boolean> => {
      const capturedScope = captureRenderedScope()
      if (
        !accessToken ||
        !capturedScope.userId ||
        !bookmarkingPostId ||
        !scopeIsCurrent(capturedScope)
      ) {
        return false
      }
      const capturedPostId = bookmarkingPostId
      const lockKey = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}\u0000${capturedPostId}\u0000folder-save`
      if (bookmarkLockRef.current.has(lockKey)) return false
      bookmarkLockRef.current.add(lockKey)
      setBookmarkLoading((prev) => ({ ...prev, [capturedPostId]: true }))
      try {
        const result = await savePostToBookmarkFolder({
          accessToken,
          userId: capturedScope.userId,
          postId: capturedPostId,
          folderId,
          sessionGeneration: capturedScope.sessionGeneration,
        })
        if (!scopeIsCurrent(capturedScope)) return false
        if (!result.ok && result.stale) return false
        if (result.ok) {
          const acknowledgement = result.acknowledgement
          setUserBookmarks((prev) => ({ ...prev, [capturedPostId]: true }))
          setBookmarkCounts((prev) => ({
            ...prev,
            [capturedPostId]: acknowledgement.bookmark_count,
          }))
          setPosts((prev) =>
            prev.map((post) =>
              post.id === capturedPostId
                ? { ...post, bookmark_count: acknowledgement.bookmark_count }
                : post
            )
          )
          const openedPost = openPostRef.current
          if (!openPostAliasesPosts && openedPost?.id === capturedPostId) {
            setOpenPost({
              ...openedPost,
              bookmark_count: acknowledgement.bookmark_count,
            } as Post)
          }
          if (acknowledgement.status === 'added') {
            trackEvent('post_bookmark', { post_id: capturedPostId })
          }
          showToast(t('bookmarked'), 'success')
          return true
        }

        if (result.status === 401) {
          showToast(t('loginExpiredPleaseRelogin'), 'error')
          redirectBookmarkToLogin(capturedPostId)
        } else {
          showToast(
            result.error || t(result.status === 0 ? 'networkError' : 'operationFailed'),
            'error'
          )
        }
      } catch (err) {
        if (!scopeIsCurrent(capturedScope)) return false
        showToast(getNetworkErrorMessage(err, t), 'error')
      } finally {
        bookmarkLockRef.current.delete(lockKey)
        if (scopeIsCurrent(capturedScope)) {
          setBookmarkLoading((prev) => ({ ...prev, [capturedPostId]: false }))
        }
      }
      return false
    },
    [
      accessToken,
      bookmarkingPostId,
      captureRenderedScope,
      openPostAliasesPosts,
      redirectBookmarkToLogin,
      scopeIsCurrent,
      setBookmarkCounts,
      setBookmarkLoading,
      setOpenPost,
      setPosts,
      setUserBookmarks,
      showToast,
      t,
    ]
  )

  // Open repost editor — auth-gated so anonymous users get the login modal
  // immediately instead of after composing a repost comment.
  const openRepostModal = useCallback(
    async (postId: string) => {
      const capturedScope = captureRenderedScope()
      if (!scopeIsCurrent(capturedScope)) return
      if (!accessToken) {
        const { useLoginModal } = await import('@/lib/hooks/useLoginModal')
        if (scopeIsCurrent(capturedScope)) useLoginModal.getState().openLoginModal()
        return
      }
      setShowRepostModal(postId)
    },
    [accessToken, captureRenderedScope, scopeIsCurrent, setShowRepostModal]
  )

  // Repost
  const handleRepost = useCallback(
    async (postId: string, comment?: string): Promise<boolean> => {
      const capturedScope = captureRenderedScope()
      if (!scopeIsCurrent(capturedScope)) return false
      if (!accessToken) {
        const { useLoginModal } = await import('@/lib/hooks/useLoginModal')
        if (scopeIsCurrent(capturedScope)) useLoginModal.getState().openLoginModal()
        return false
      }
      const post = posts.find((p) => p.id === postId) || openPost
      if (post?.author_id === currentUserId) {
        showToast(t('cannotRepostOwn'), 'warning')
        return false
      }
      const key = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}\u0000repost-${postId}`
      if (lockRef.current.has(key)) return false
      lockRef.current.add(key)
      setRepostLoading((prev) => ({ ...prev, [postId]: true }))
      try {
        const response = await fetch(`/api/posts/${postId}/repost`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ comment }),
        })
        const result = await response.json()
        if (!scopeIsCurrent(capturedScope)) return false
        if (response.ok) {
          if (typeof result.repost_count === 'number') {
            const rootPostId =
              typeof result.root_post_id === 'string' ? result.root_post_id : postId
            setPosts((prev) =>
              prev.map((item) =>
                item.id === rootPostId ? { ...item, repost_count: result.repost_count } : item
              )
            )
            const op = openPostRef.current
            if (!openPostAliasesPosts && op && op.id === rootPostId) {
              setOpenPost({ ...op, repost_count: result.repost_count })
            }
          }
          trackEvent('post_repost', { post_id: postId, with_comment: comment ? 1 : 0 })
          showToast(t('reposted'), 'success')
          return true
        } else {
          showToast(result.error || t('repostFailed'), 'error')
          return false
        }
      } catch (err) {
        if (!scopeIsCurrent(capturedScope)) return false
        logger.error('[PostFeed] repost failed:', err)
        showToast(getNetworkErrorMessage(err, t), 'error')
        return false
      } finally {
        if (scopeIsCurrent(capturedScope)) {
          setRepostLoading((prev) => ({ ...prev, [postId]: false }))
        }
        lockRef.current.delete(key)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      accessToken,
      captureRenderedScope,
      posts,
      openPost,
      currentUserId,
      scopeIsCurrent,
      showToast,
      openPostAliasesPosts,
    ]
  )

  // Load user bookmarks
  const loadUserBookmarksAndReposts = useCallback(
    async (postIds: string[]) => {
      if (!accessToken || postIds.length === 0) return
      const capturedScope = captureRenderedScope()
      if (!scopeIsCurrent(capturedScope)) return
      try {
        const res = await fetch('/api/posts/bookmarks/status', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ postIds }),
        })
        const data = await res.json()
        if (!scopeIsCurrent(capturedScope)) return
        setUserBookmarks((prev) => ({ ...prev, ...(data.bookmarks || {}) }))
      } catch {
        // Bookmark status fetch is non-critical — silently ignore
      }
    },
    [accessToken, captureRenderedScope, scopeIsCurrent, setUserBookmarks]
  )

  // Edit
  const handleStartEdit = useCallback(
    (post: Post, e: React.MouseEvent) => {
      e.stopPropagation()
      router.push(`/post/${post.id}/edit`)
    },
    [router]
  )

  const handleSaveEdit = useCallback(async () => {
    const capturedScope = captureRenderedScope()
    if (!scopeIsCurrent(capturedScope)) return
    if (!editingPost || !accessToken || !currentUserId) return
    if (!editTitle.trim()) {
      showToast(t('titleRequired'), 'warning')
      return
    }
    const capturedPost = editingPost
    if (
      !Number.isSafeInteger(capturedPost.content_version) ||
      Number(capturedPost.content_version) < 0
    ) {
      showToast(t('editFailed'), 'error')
      return
    }
    const requestLockKey = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}\u0000${capturedPost.id}`
    if (editRequestLockRef.current.has(requestLockKey)) return
    editRequestLockRef.current.add(requestLockKey)
    const capturedTitle = editTitle.trim()
    const capturedContent = editContent.trim()
    setSavingEdit(true)
    try {
      const response = await fetch(`/api/posts/${capturedPost.id}/edit`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          title: capturedTitle,
          content: capturedContent,
          expected_version: capturedPost.content_version,
        }),
      })
      const data: unknown = await response.json()
      if (!scopeIsCurrent(capturedScope)) return
      const acknowledgement = response.ok
        ? readPostEditApiAcknowledgement(data, capturedPost.id)
        : null
      if (
        acknowledgement &&
        acknowledgement.author_id === currentUserId &&
        acknowledgement.content_version >= Number(capturedPost.content_version)
      ) {
        setPosts((prev) =>
          prev.map((p) =>
            p.id === capturedPost.id
              ? {
                  ...p,
                  title: acknowledgement.title,
                  content: acknowledgement.content,
                  images: acknowledgement.images,
                  language: acknowledgement.language,
                  mentions: acknowledgement.mentions,
                  hashtags: acknowledgement.hashtags,
                  updated_at: acknowledgement.updated_at,
                  content_version: acknowledgement.content_version,
                }
              : p
          )
        )
        const op = openPostRef.current
        if (!openPostAliasesPosts && op?.id === capturedPost.id)
          setOpenPost({
            ...op,
            title: acknowledgement.title,
            content: acknowledgement.content,
            images: acknowledgement.images,
            language: acknowledgement.language,
            mentions: acknowledgement.mentions,
            hashtags: acknowledgement.hashtags,
            updated_at: acknowledgement.updated_at,
            content_version: acknowledgement.content_version,
          })
        setEditingPost(null)
        showToast(t('editSaved'), 'success')
      } else {
        const message =
          data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
            ? data.error
            : t('editFailed')
        showToast(message, 'error')
      }
    } catch (err) {
      if (!scopeIsCurrent(capturedScope)) return
      logger.error('[PostFeed] edit failed:', err)
      showToast(t('editFailed'), 'error')
    } finally {
      editRequestLockRef.current.delete(requestLockKey)
      if (scopeIsCurrent(capturedScope)) setSavingEdit(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable refs t, setPosts, setOpenPost excluded to avoid re-creating callback
  }, [
    editingPost,
    accessToken,
    currentUserId,
    captureRenderedScope,
    editTitle,
    editContent,
    openPost?.id,
    openPostAliasesPosts,
    scopeIsCurrent,
    showToast,
  ])

  // Delete
  const handleDeletePost = useCallback(
    async (post: Post, e: React.MouseEvent) => {
      e.stopPropagation()
      const capturedScope = captureRenderedScope()
      if (!scopeIsCurrent(capturedScope)) return
      if (!accessToken) {
        showToast(t('pleaseLogin'), 'warning')
        return
      }
      const requestLockKey = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}\u0000${post.id}`
      if (deleteRequestLockRef.current.has(requestLockKey)) return
      deleteRequestLockRef.current.add(requestLockKey)
      try {
        if (!(await showDangerConfirm(t('deletePost'), t('deletePostConfirm')))) return
        if (!scopeIsCurrent(capturedScope)) return
        const response = await fetch(`/api/posts/${post.id}/delete`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}`, ...getCsrfHeaders() },
        })
        const data: unknown = await response.json()
        if (!scopeIsCurrent(capturedScope)) return
        if (response.ok && readPostDeleteAcknowledgement(data)) {
          setPosts((prev) => prev.filter((p) => p.id !== post.id))
          if (openPost?.id === post.id) setOpenPost(null)
          showToast(t('deleted'), 'success')
        } else {
          showToast(readPostDeleteError(data) ?? t('deleteFailed'), 'error')
        }
      } catch {
        if (!scopeIsCurrent(capturedScope)) return
        showToast(t('deleteFailed'), 'error')
      } finally {
        deleteRequestLockRef.current.delete(requestLockKey)
      }
    },
    [
      accessToken,
      captureRenderedScope,
      openPost?.id,
      scopeIsCurrent,
      setOpenPost,
      setPosts,
      showDangerConfirm,
      showToast,
      t,
    ]
  )

  // Pin
  const handleTogglePin = useCallback(
    async (post: Post, e: React.MouseEvent) => {
      e.stopPropagation()
      const capturedScope = captureRenderedScope()
      if (!scopeIsCurrent(capturedScope)) return
      if (!accessToken) {
        showToast(t('pleaseLogin'), 'warning')
        return
      }

      const currentPost = postsRef.current.find((candidate) => candidate.id === post.id)
      const pinScope = currentPost ? postPinScopeKey(currentPost) : null
      if (!currentPost || !pinScope) {
        showToast(t('operationFailed'), 'error')
        return
      }

      const desiredState = !Boolean(currentPost.is_pinned)
      const requestLockKey = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}\u0000pin-${pinScope}`
      if (pinRequestLockRef.current.has(requestLockKey)) return
      pinRequestLockRef.current.add(requestLockKey)

      try {
        const response = await fetch(`/api/posts/${post.id}/pin`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ is_pinned: desiredState }),
        })
        const data = await response.json()
        if (!scopeIsCurrent(capturedScope)) return

        const acknowledgement = response.ok
          ? readPostPinAcknowledgement(data, {
              postId: currentPost.id,
              authorId: currentPost.author_id,
              groupId: currentPost.group_id ?? null,
              isPinned: desiredState,
            })
          : null

        if (acknowledgement) {
          setPosts((prev) =>
            prev.map((p) => {
              if (p.id === post.id) return { ...p, is_pinned: acknowledgement.isPinned }
              if (
                acknowledgement.isPinned &&
                p.is_pinned &&
                postBelongsToPinScope(p, acknowledgement)
              ) {
                return { ...p, is_pinned: false }
              }
              return p
            })
          )
          showToast(acknowledgement.message, 'success')
        } else {
          showToast(typeof data?.error === 'string' ? data.error : t('operationFailed'), 'error')
        }
      } catch {
        if (!scopeIsCurrent(capturedScope)) return
        showToast(t('operationFailed'), 'error')
      } finally {
        pinRequestLockRef.current.delete(requestLockKey)
      }
    },
    [accessToken, captureRenderedScope, scopeIsCurrent, setPosts, showToast, t]
  )

  return {
    toggleReaction,
    _toggleVote,
    customPoll: pollOwnerScopeKeyRef.current === scopeKey ? customPoll : null,
    customPollUserVotes: pollOwnerScopeKeyRef.current === scopeKey ? customPollUserVotes : [],
    loadingCustomPoll: pollOwnerScopeKeyRef.current === scopeKey ? loadingCustomPoll : false,
    votingCustomPoll: pollOwnerScopeKeyRef.current === scopeKey ? votingCustomPoll : false,
    selectedPollOptions: pollOwnerScopeKeyRef.current === scopeKey ? selectedPollOptions : [],
    setSelectedPollOptions,
    loadCustomPoll,
    submitCustomPollVote,
    bookmarkLoading,
    repostLoading,
    showRepostModal,
    setShowRepostModal,
    openRepostModal,
    userBookmarks,
    setUserBookmarks,
    bookmarkCounts,
    setBookmarkCounts,
    showBookmarkModal,
    setShowBookmarkModal,
    bookmarkingPostId,
    setBookmarkingPostId,
    handleBookmark,
    openBookmarkFolderModal,
    handleBookmarkToFolder,
    handleRepost,
    loadUserBookmarksAndReposts,
    editingPost,
    setEditingPost,
    editTitle,
    setEditTitle,
    editContent,
    setEditContent,
    savingEdit,
    handleStartEdit,
    handleSaveEdit,
    handleDeletePost,
    handleTogglePin,
  }
}
