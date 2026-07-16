'use client'

import { useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { getCsrfHeaders } from '@/lib/api/client'
import { usePostStore } from '@/lib/stores/postStore'
import { logger } from '@/lib/logger'
import { haptic } from '@/lib/utils/haptics'
import { getNetworkErrorMessage } from '@/lib/utils/network-error'
import { trackEvent } from '@/lib/analytics/track'
import { type PollChoice, type PostWithUserState } from '@/lib/types'

type Post = PostWithUserState

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
  handleBookmarkToFolder: (folderId: string) => Promise<void>
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
  const userBookmarks = bookmarkOwnerScopeKeyRef.current === scopeKey ? userBookmarksState : {}
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
  const bookmarkCounts = bookmarkScopeOwned ? bookmarkCountsState : {}
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

      try {
        const response = await fetch(`/api/posts/${postId}/like`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ reaction_type: reactionType }),
        })
        const json = await response.json()
        if (!scopeIsCurrent(capturedScope)) return
        if (response.ok && json.success) {
          // Reconcile with server truth (overwrites optimistic)
          const result = json.data
          // The route intentionally returns null counts when its post-count
          // read fails after the reaction transaction commits. Preserve the
          // optimistic counts in that case; only the reaction ACK is required.
          const reconcileServer = (post: Post): Post => ({
            ...post,
            ...(typeof result.like_count === 'number' ? { like_count: result.like_count } : {}),
            ...(typeof result.dislike_count === 'number'
              ? { dislike_count: result.dislike_count }
              : {}),
            user_reaction: result.reaction,
          })
          setPosts((prev) => prev.map((p) => (p.id === postId ? reconcileServer(p) : p)))
          const resolvedLikeCount =
            typeof result.like_count === 'number'
              ? result.like_count
              : currentPost.like_count + likeDelta
          const resolvedDislikeCount =
            typeof result.dislike_count === 'number'
              ? result.dislike_count
              : currentPost.dislike_count + dislikeDelta
          usePostStore.getState().updatePostReaction(postId, {
            like_count: resolvedLikeCount,
            dislike_count: resolvedDislikeCount,
            reaction: result.reaction,
          })
          {
            const op = openPostRef.current
            if (!openPostAliasesPosts && op?.id === postId) setOpenPost(reconcileServer(op))
          }
          // Analytics: only count a NEW reaction, not an un-react (result.reaction null)
          if (result.reaction) {
            trackEvent('post_reaction', { post_id: postId, reaction: result.reaction })
          }
        } else {
          // Rollback — reverse the delta from CURRENT state (not a stale snapshot)
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
          {
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
          showToast(json.error || json.message || t('operationFailed'), 'error')
        }
      } catch (err) {
        if (!scopeIsCurrent(capturedScope)) return
        // Rollback — reverse delta from current state
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
        {
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
        logger.error('[PostFeed] toggleReaction error:', err)
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

  // Bookmark (with optimistic update, matching toggleReaction pattern)
  // Uses ref-based lock (synchronous) to prevent duplicate clicks — state-based
  // guards have a tiny race window because React batches setState calls.
  const handleBookmark = useCallback(
    async (postId: string) => {
      const capturedScope = captureRenderedScope()
      if (!scopeIsCurrent(capturedScope)) return
      if (!accessToken) {
        const { useLoginModal } = await import('@/lib/hooks/useLoginModal')
        if (scopeIsCurrent(capturedScope)) useLoginModal.getState().openLoginModal()
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
      setOpenPost,
      setPosts,
      scopeIsCurrent,
    ]
  )

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
    async (folderId: string) => {
      if (!accessToken || !bookmarkingPostId) return
      const capturedScope = captureRenderedScope()
      if (!scopeIsCurrent(capturedScope)) return
      const capturedPostId = bookmarkingPostId
      setBookmarkLoading((prev) => ({ ...prev, [capturedPostId]: true }))
      try {
        const response = await fetch(`/api/posts/${capturedPostId}/bookmark`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ folder_id: folderId }),
        })
        const result = await response.json()
        if (!scopeIsCurrent(capturedScope)) return
        if (response.ok) {
          setUserBookmarks((prev) => ({ ...prev, [capturedPostId]: result.bookmarked }))
          setBookmarkCounts((prev) => ({ ...prev, [capturedPostId]: result.bookmark_count }))
          showToast(t('bookmarked'), 'success')
        } else {
          showToast(result.error || t('operationFailed'), 'error')
        }
      } catch (err) {
        if (!scopeIsCurrent(capturedScope)) return
        showToast(getNetworkErrorMessage(err, t), 'error')
      } finally {
        if (scopeIsCurrent(capturedScope)) {
          setBookmarkLoading((prev) => ({ ...prev, [capturedPostId]: false }))
          setShowBookmarkModal(false)
          setBookmarkingPostId(null)
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accessToken, bookmarkingPostId, captureRenderedScope, scopeIsCurrent, showToast]
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
    if (!editingPost || !accessToken) return
    if (!editTitle.trim()) {
      showToast(t('titleRequired'), 'warning')
      return
    }
    const capturedPost = editingPost
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
        body: JSON.stringify({ title: capturedTitle, content: capturedContent }),
      })
      const data = await response.json()
      if (!scopeIsCurrent(capturedScope)) return
      if (response.ok) {
        setPosts((prev) =>
          prev.map((p) =>
            p.id === capturedPost.id ? { ...p, title: capturedTitle, content: capturedContent } : p
          )
        )
        const op = openPostRef.current
        if (!openPostAliasesPosts && op?.id === capturedPost.id)
          setOpenPost({ ...op, title: capturedTitle, content: capturedContent })
        setEditingPost(null)
        showToast(t('editSaved'), 'success')
      } else {
        showToast(data.error || t('editFailed'), 'error')
      }
    } catch (err) {
      if (!scopeIsCurrent(capturedScope)) return
      logger.error('[PostFeed] edit failed:', err)
      showToast(t('editFailed'), 'error')
    } finally {
      if (scopeIsCurrent(capturedScope)) setSavingEdit(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable refs t, setPosts, setOpenPost excluded to avoid re-creating callback
  }, [
    editingPost,
    accessToken,
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
      if (!(await showDangerConfirm(t('deletePost'), t('deletePostConfirm')))) return
      if (!scopeIsCurrent(capturedScope)) return
      try {
        const response = await fetch(`/api/posts/${post.id}/delete`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}`, ...getCsrfHeaders() },
        })
        const data = await response.json()
        if (!scopeIsCurrent(capturedScope)) return
        if (response.ok) {
          setPosts((prev) => prev.filter((p) => p.id !== post.id))
          if (openPost?.id === post.id) setOpenPost(null)
          showToast(t('deleted'), 'success')
        } else {
          showToast(data.error || t('deleteFailed'), 'error')
        }
      } catch {
        if (!scopeIsCurrent(capturedScope)) return
        showToast(t('deleteFailed'), 'error')
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
      try {
        const response = await fetch(`/api/posts/${post.id}/pin`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, ...getCsrfHeaders() },
        })
        const data = await response.json()
        if (!scopeIsCurrent(capturedScope)) return
        if (response.ok && data.success) {
          setPosts((prev) =>
            prev.map((p) => {
              if (p.id === post.id) return { ...p, is_pinned: data.data.is_pinned }
              if (data.data.is_pinned && p.is_pinned) return { ...p, is_pinned: false }
              return p
            })
          )
          showToast(data.data.message, 'success')
        } else {
          showToast(data.error || t('operationFailed'), 'error')
        }
      } catch {
        if (!scopeIsCurrent(capturedScope)) return
        showToast(t('operationFailed'), 'error')
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
