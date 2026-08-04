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
  POST_BOOKMARK_OPERATION,
  POST_BOOKMARK_REQUEST_TIMEOUT_MS,
  createPostBookmarkRequestId,
  isDefinitivePostBookmarkRejection,
  readPostBookmarkAcknowledgement,
  readPostBookmarkStatusAcknowledgement,
} from '@/lib/bookmarks/post-bookmark-client-contract'
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
  POST_REACTION_REQUEST_TIMEOUT_MS,
  createPostReactionRequestId,
  isDefinitivePostReactionRejection,
  nextPostReactionState,
  postReactionCountDelta,
  readPostReactionAcknowledgement,
  type PostReaction,
  type PostReactionAcknowledgement,
} from '@/lib/posts/post-reaction-client-contract'
import {
  POST_REPOST_OPERATION,
  POST_REPOST_REQUEST_TIMEOUT_MS,
  createPostRepostRequestId,
  readPostRepostAcknowledgement,
} from '@/lib/reposts/post-repost-client-contract'
import {
  POST_BUILT_IN_VOTE_OPERATION,
  POST_CUSTOM_POLL_READ_OPERATION,
  POST_CUSTOM_POLL_VOTE_OPERATION,
  POST_VOTE_REQUEST_TIMEOUT_MS,
  createPostVoteRequestId,
  isDefinitivePostBuiltInVoteRejection,
  nextPostBuiltInVoteState,
  postBuiltInVoteCountDelta,
  readPostBuiltInVoteAcknowledgement,
  readPostCustomPollAcknowledgement,
  readPostCustomPollVoteAcknowledgement,
  type PostCustomPoll,
  type PostCustomPollLoadState,
  type PostBuiltInVoteAcknowledgement,
} from '@/lib/polls/post-vote-client-contract'

type Post = PostWithUserState

type ReactionIntent = {
  desired: PostReaction | null
  revision: number
}

type ReactionTruth = {
  reaction: PostReaction | null
  likeCount: number
  dislikeCount: number
}

type ReactionCommandOutcome =
  | { kind: 'acknowledged'; acknowledgement: PostReactionAcknowledgement }
  | { kind: 'definitive-rejection'; error: string | null }
  | { kind: 'uncertain'; error: unknown }

type BuiltInVoteIntent = {
  desired: PollChoice | null
  revision: number
}

type BuiltInVoteTruth = {
  vote: PollChoice | null
  poll: { bull: number; bear: number; wait: number }
}

type BuiltInVoteCommandOutcome =
  | { kind: 'acknowledged'; acknowledgement: PostBuiltInVoteAcknowledgement }
  | { kind: 'definitive-rejection'; error: string | null }
  | { kind: 'uncertain'; error: unknown }

const EMPTY_BOOKMARK_FLAGS: Record<string, boolean> = {}
const EMPTY_BOOKMARK_COUNTS: Record<string, number> = {}

function applyDesiredReaction(post: Post, desired: PostReaction | null): Post {
  const current = post.user_reaction ?? null
  const delta = postReactionCountDelta(current, desired)
  return {
    ...post,
    like_count: Math.max(0, post.like_count + delta.likeCount),
    dislike_count: Math.max(0, post.dislike_count + delta.dislikeCount),
    user_reaction: desired,
  }
}

function applyReactionTruth(post: Post, truth: ReactionTruth): Post {
  return {
    ...post,
    like_count: truth.likeCount,
    dislike_count: truth.dislikeCount,
    user_reaction: truth.reaction,
  }
}

function applyDesiredBuiltInVote(post: Post, desired: PollChoice | null): Post {
  const current = post.user_vote ?? null
  const delta = postBuiltInVoteCountDelta(current, desired)
  return {
    ...post,
    poll_bull: Math.max(0, (post.poll_bull || 0) + delta.bull),
    poll_bear: Math.max(0, (post.poll_bear || 0) + delta.bear),
    poll_wait: Math.max(0, (post.poll_wait || 0) + delta.wait),
    user_vote: desired,
  }
}

function applyBuiltInVoteTruth(post: Post, truth: BuiltInVoteTruth): Post {
  return {
    ...post,
    poll_bull: truth.poll.bull,
    poll_bear: truth.poll.bear,
    poll_wait: truth.poll.wait,
    user_vote: truth.vote,
  }
}

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

async function readCurrentPostBookmarkStatus(input: {
  accessToken: string
  actorId: string
  postId: string
}): Promise<boolean | null> {
  const requestId = createPostBookmarkRequestId()
  const controller = new AbortController()
  const timeoutId = setTimeout(
    () => controller.abort(new DOMException('Bookmark status request timed out', 'AbortError')),
    POST_BOOKMARK_REQUEST_TIMEOUT_MS
  )
  try {
    const response = await waitWithinAbortSignal(
      fetch('/api/posts/bookmarks/status', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${input.accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ postIds: [input.postId], request_id: requestId }),
        cache: 'no-store',
        signal: controller.signal,
      }),
      controller.signal
    )
    const data: unknown = await waitWithinAbortSignal(response.json(), controller.signal)
    const acknowledgement =
      response.ok && response.status === 200
        ? readPostBookmarkStatusAcknowledgement(data, {
            actorId: input.actorId,
            requestId,
            postIds: [input.postId],
          })
        : null
    return acknowledgement ? acknowledgement.bookmarks[input.postId.toLowerCase()] : null
  } catch {
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}

interface CustomPollState {
  customPoll: PostCustomPoll | null
  customPollUserVotes: number[]
  customPollLoadState: PostCustomPollLoadState
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
  onReactionStateChange,
  onVoteStateChange,
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
  /** Marks a local reaction write so an older feed read cannot overwrite it. */
  onReactionStateChange?: (postId: string) => void
  /** Marks a local built-in vote write so an older feed read cannot overwrite it. */
  onVoteStateChange?: (postId: string) => void
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
  const reactionIntentRef = useRef(new Map<string, ReactionIntent>())
  const reactionWorkerRef = useRef(new Map<string, Promise<void>>())
  const reactionRevisionRef = useRef(0)
  const builtInVoteIntentRef = useRef(new Map<string, BuiltInVoteIntent>())
  const builtInVoteWorkerRef = useRef(new Map<string, Promise<void>>())
  const builtInVoteRevisionRef = useRef(0)
  const bookmarkLockRef = useRef<Set<string>>(new Set())
  const bookmarkStatusLockRef = useRef<Set<string>>(new Set())
  const bookmarkMutationRevisionRef = useRef(new Map<string, number>())
  const bookmarkHydrationRevisionRef = useRef(new Map<string, number>())
  useEffect(() => {
    reactionIntentRef.current.clear()
    reactionWorkerRef.current.clear()
    reactionRevisionRef.current = 0
    builtInVoteIntentRef.current.clear()
    builtInVoteWorkerRef.current.clear()
    builtInVoteRevisionRef.current = 0
    // Revision keys include the viewer scope, but retaining completed entries
    // from prior identities would grow these maps for the lifetime of the tab.
    bookmarkMutationRevisionRef.current.clear()
    bookmarkHydrationRevisionRef.current.clear()
  }, [scopeKey])
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
  const [customPollLoadState, setCustomPollLoadState] = useState<PostCustomPollLoadState>('idle')
  const [votingCustomPoll, setVotingCustomPoll] = useState(false)
  const [selectedPollOptions, setSelectedPollOptionsRaw] = useState<number[]>([])
  const pollOwnerScopeKeyRef = useRef(scopeKey)
  const pollResourcePostIdRef = useRef<string | null>(null)
  const pollLoadGenerationRef = useRef(0)
  const claimPollScope = useCallback(() => {
    const current = activeScopeRef.current
    const currentScopeKey = `${current.viewerKey}\u0000${current.sessionGeneration}`
    if (pollOwnerScopeKeyRef.current === currentScopeKey) return
    pollOwnerScopeKeyRef.current = currentScopeKey
    pollResourcePostIdRef.current = null
    pollLoadGenerationRef.current += 1
    setCustomPoll(null)
    setCustomPollUserVotes([])
    setCustomPollLoadState('idle')
    setVotingCustomPoll(false)
    setSelectedPollOptionsRaw([])
  }, [])
  const claimPollResource = useCallback(
    (postId: string) => {
      claimPollScope()
      if (pollResourcePostIdRef.current === postId) return
      pollResourcePostIdRef.current = postId
      pollLoadGenerationRef.current += 1
      setCustomPoll(null)
      setCustomPollUserVotes([])
      setCustomPollLoadState('idle')
      setVotingCustomPoll(false)
      setSelectedPollOptionsRaw([])
    },
    [claimPollScope]
  )
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
      const actorId = capturedScope.userId
      const key = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}\u0000react-${postId}`
      const currentPost = postsRef.current.find((p) => p.id === postId)
      if (!currentPost) return

      // A second click can land before React renders the first optimistic
      // update. The queued desired state, not a stale component snapshot, is
      // therefore the source for the next intent.
      const currentIntent = reactionIntentRef.current.get(key)
      const desiredReaction = nextPostReactionState(
        currentIntent?.desired ?? currentPost.user_reaction ?? null,
        reactionType
      )
      reactionIntentRef.current.set(key, {
        desired: desiredReaction,
        revision: ++reactionRevisionRef.current,
      })

      onReactionStateChange?.(postId)
      setPosts((prev) =>
        prev.map((post) =>
          post.id === postId ? applyDesiredReaction(post, desiredReaction) : post
        )
      )
      {
        const op = openPostRef.current
        if (!openPostAliasesPosts && op?.id === postId)
          setOpenPost(applyDesiredReaction(op, desiredReaction))
      }
      haptic('light')

      const sendCommand = async (intent: ReactionIntent): Promise<ReactionCommandOutcome> => {
        const requestId = createPostReactionRequestId()
        let lastError: unknown = new Error('Post reaction acknowledgement unavailable')

        // Replaying an absolute desired state is safe. One bounded retry turns
        // a lost HTTP response into canonical database truth without toggling.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (!scopeIsCurrent(capturedScope)) return { kind: 'uncertain', error: lastError }
          const controller = new AbortController()
          const timeoutId = setTimeout(
            () =>
              controller.abort(new DOMException('Post reaction request timed out', 'AbortError')),
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
                body: JSON.stringify({
                  operation: POST_REACTION_OPERATION,
                  request_id: requestId,
                  desired_reaction: intent.desired,
                }),
                cache: 'no-store',
                signal: controller.signal,
              }),
              controller.signal
            )

            let json: unknown
            try {
              json = await waitWithinAbortSignal(response.json(), controller.signal)
            } catch (error) {
              if (isDefinitivePostReactionRejection(response.status)) {
                return { kind: 'definitive-rejection', error: null }
              }
              lastError = error
              continue
            }

            const acknowledgement =
              response.ok && response.status === 200
                ? readPostReactionAcknowledgement(json, {
                    actorId,
                    postId,
                    requestId,
                    desiredReaction: intent.desired,
                  })
                : null
            if (acknowledgement) return { kind: 'acknowledged', acknowledgement }

            const rawError =
              json !== null && typeof json === 'object' && !Array.isArray(json)
                ? (json as Record<string, unknown>).error
                : null
            if (isDefinitivePostReactionRejection(response.status)) {
              return {
                kind: 'definitive-rejection',
                error: typeof rawError === 'string' ? rawError : null,
              }
            }
            lastError = typeof rawError === 'string' ? new Error(rawError) : lastError
          } catch (error) {
            lastError = error
          } finally {
            clearTimeout(timeoutId)
          }
        }

        return { kind: 'uncertain', error: lastError }
      }

      const drainIntents = async (): Promise<void> => {
        let knownTruth: ReactionTruth = {
          reaction: currentPost.user_reaction ?? null,
          likeCount: currentPost.like_count,
          dislikeCount: currentPost.dislike_count,
        }
        let knownTruthIsCertain = true

        while (scopeIsCurrent(capturedScope)) {
          const intent = reactionIntentRef.current.get(key)
          if (!intent) return
          const outcome = await sendCommand(intent)
          if (!scopeIsCurrent(capturedScope)) return
          const latestIntent = reactionIntentRef.current.get(key)

          if (outcome.kind === 'acknowledged') {
            const acknowledgement = outcome.acknowledgement
            knownTruth = {
              reaction: acknowledgement.reaction,
              likeCount: acknowledgement.likeCount,
              dislikeCount: acknowledgement.dislikeCount,
            }
            knownTruthIsCertain = true

            // An older ACK must not overwrite a newer opposite click. If the
            // latest intent converged to the same state, it can be coalesced.
            if (latestIntent?.desired === acknowledgement.reaction) {
              onReactionStateChange?.(postId)
              setPosts((prev) =>
                prev.map((post) =>
                  post.id === postId ? applyReactionTruth(post, knownTruth) : post
                )
              )
              usePostStore.getState().updatePostReaction(postId, {
                like_count: acknowledgement.likeCount,
                dislike_count: acknowledgement.dislikeCount,
                reaction: acknowledgement.reaction,
              })
              const op = openPostRef.current
              if (!openPostAliasesPosts && op?.id === postId) {
                setOpenPost(applyReactionTruth(op, knownTruth))
              }
              reactionIntentRef.current.delete(key)
              if (acknowledgement.action !== 'unchanged' && acknowledgement.reaction) {
                trackEvent('post_reaction', {
                  post_id: acknowledgement.postId,
                  reaction: acknowledgement.reaction,
                })
              }
              return
            }
            continue
          }

          if (outcome.kind === 'definitive-rejection') {
            if (latestIntent?.revision === intent.revision) {
              // Rollback is valid only while every earlier command has a
              // definitive result. Once an older request is uncertain, its
              // commit state can differ from this pre-command snapshot.
              if (knownTruthIsCertain) {
                onReactionStateChange?.(postId)
                setPosts((prev) =>
                  prev.map((post) =>
                    post.id === postId ? applyReactionTruth(post, knownTruth) : post
                  )
                )
                usePostStore.getState().updatePostReaction(postId, {
                  like_count: knownTruth.likeCount,
                  dislike_count: knownTruth.dislikeCount,
                  reaction: knownTruth.reaction,
                })
                const op = openPostRef.current
                if (!openPostAliasesPosts && op?.id === postId) {
                  setOpenPost(applyReactionTruth(op, knownTruth))
                }
              }
              reactionIntentRef.current.delete(key)
              showToast(outcome.error ?? t('operationFailed'), 'error')
              return
            }
            continue
          }

          // Both attempts are uncertain. The first may have committed, so a
          // blind inverse rollback would fabricate state. A newer absolute
          // intent can still safely converge; otherwise retain the optimistic
          // state and let the next click/hydration reconcile it.
          knownTruthIsCertain = false
          if (latestIntent?.revision === intent.revision) {
            reactionIntentRef.current.delete(key)
            logger.error('[PostFeed] reaction result remains uncertain:', outcome.error)
            showToast(getNetworkErrorMessage(outcome.error, t), 'error')
            return
          }
        }
      }

      const startWorker = (): Promise<void> => {
        const running = reactionWorkerRef.current.get(key)
        if (running) return running
        const worker = drainIntents().finally(() => {
          if (reactionWorkerRef.current.get(key) === worker) {
            reactionWorkerRef.current.delete(key)
          }
        })
        reactionWorkerRef.current.set(key, worker)
        return worker
      }

      try {
        // A click arriving during the worker's final microtask can enqueue
        // after its last map read. Recheck until no current-scope intent is
        // stranded without a worker.
        while (scopeIsCurrent(capturedScope) && reactionIntentRef.current.has(key)) {
          await startWorker()
        }
      } catch (error) {
        if (!scopeIsCurrent(capturedScope)) return
        reactionIntentRef.current.delete(key)
        logger.error('[PostFeed] reaction queue failed:', error)
        showToast(getNetworkErrorMessage(error, t), 'error')
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      accessToken,
      captureRenderedScope,
      onReactionStateChange,
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
      if (!capturedScope.userId) return
      const actorId = capturedScope.userId
      const key = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}\u0000vote-${postId}`
      const currentPost = postsRef.current.find((post) => post.id === postId)
      if (!currentPost) return

      // Read the latest queued intent so two clicks in one render frame still
      // mean select -> clear (or select -> change), never "ignore the second".
      const currentIntent = builtInVoteIntentRef.current.get(key)
      const desiredChoice = nextPostBuiltInVoteState(
        currentIntent?.desired ?? currentPost.user_vote ?? null,
        choice
      )
      builtInVoteIntentRef.current.set(key, {
        desired: desiredChoice,
        revision: ++builtInVoteRevisionRef.current,
      })

      onVoteStateChange?.(postId)
      setPosts((previous) =>
        previous.map((post) =>
          post.id === postId ? applyDesiredBuiltInVote(post, desiredChoice) : post
        )
      )
      {
        const openedPost = openPostRef.current
        if (!openPostAliasesPosts && openedPost?.id === postId) {
          setOpenPost(applyDesiredBuiltInVote(openedPost, desiredChoice))
        }
      }
      haptic('light')

      const sendCommand = async (intent: BuiltInVoteIntent): Promise<BuiltInVoteCommandOutcome> => {
        const requestId = createPostVoteRequestId()
        let lastError: unknown = new Error('Post vote acknowledgement unavailable')

        // The same request identity and absolute desired state are replayed at
        // most once. A lost response can no longer turn a committed vote off.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (!scopeIsCurrent(capturedScope)) return { kind: 'uncertain', error: lastError }
          const controller = new AbortController()
          const timeoutId = setTimeout(
            () => controller.abort(new DOMException('Post vote request timed out', 'AbortError')),
            POST_VOTE_REQUEST_TIMEOUT_MS
          )
          try {
            const response = await waitWithinAbortSignal(
              fetch(`/api/posts/${postId}/vote`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${accessToken}`,
                  ...getCsrfHeaders(),
                },
                body: JSON.stringify({
                  operation: POST_BUILT_IN_VOTE_OPERATION,
                  request_id: requestId,
                  desired_choice: intent.desired,
                }),
                cache: 'no-store',
                signal: controller.signal,
              }),
              controller.signal
            )

            let json: unknown
            try {
              json = await waitWithinAbortSignal(response.json(), controller.signal)
            } catch (error) {
              if (isDefinitivePostBuiltInVoteRejection(response.status)) {
                return { kind: 'definitive-rejection', error: null }
              }
              lastError = error
              continue
            }

            const acknowledgement =
              response.ok && response.status === 200
                ? readPostBuiltInVoteAcknowledgement(json, {
                    actorId,
                    postId,
                    requestId,
                    desiredChoice: intent.desired,
                  })
                : null
            if (acknowledgement) return { kind: 'acknowledged', acknowledgement }

            const rawError =
              json !== null && typeof json === 'object' && !Array.isArray(json)
                ? (json as Record<string, unknown>).error
                : null
            if (isDefinitivePostBuiltInVoteRejection(response.status)) {
              return {
                kind: 'definitive-rejection',
                error: typeof rawError === 'string' ? rawError : null,
              }
            }
            lastError = typeof rawError === 'string' ? new Error(rawError) : lastError
          } catch (error) {
            lastError = error
          } finally {
            clearTimeout(timeoutId)
          }
        }

        return { kind: 'uncertain', error: lastError }
      }

      const drainIntents = async (): Promise<void> => {
        let knownTruth: BuiltInVoteTruth = {
          vote: currentPost.user_vote ?? null,
          poll: {
            bull: currentPost.poll_bull || 0,
            bear: currentPost.poll_bear || 0,
            wait: currentPost.poll_wait || 0,
          },
        }
        let knownTruthIsCertain = true

        while (scopeIsCurrent(capturedScope)) {
          const intent = builtInVoteIntentRef.current.get(key)
          if (!intent) return
          const outcome = await sendCommand(intent)
          if (!scopeIsCurrent(capturedScope)) return
          const latestIntent = builtInVoteIntentRef.current.get(key)

          if (outcome.kind === 'acknowledged') {
            const acknowledgement = outcome.acknowledgement
            knownTruth = { vote: acknowledgement.vote, poll: acknowledgement.poll }
            knownTruthIsCertain = true

            if (latestIntent?.desired === acknowledgement.vote) {
              onVoteStateChange?.(postId)
              setPosts((previous) =>
                previous.map((post) =>
                  post.id === postId ? applyBuiltInVoteTruth(post, knownTruth) : post
                )
              )
              const openedPost = openPostRef.current
              if (!openPostAliasesPosts && openedPost?.id === postId) {
                setOpenPost(applyBuiltInVoteTruth(openedPost, knownTruth))
              }
              builtInVoteIntentRef.current.delete(key)
              return
            }
            continue
          }

          if (outcome.kind === 'definitive-rejection') {
            if (latestIntent?.revision === intent.revision) {
              if (knownTruthIsCertain) {
                onVoteStateChange?.(postId)
                setPosts((previous) =>
                  previous.map((post) =>
                    post.id === postId ? applyBuiltInVoteTruth(post, knownTruth) : post
                  )
                )
                const openedPost = openPostRef.current
                if (!openPostAliasesPosts && openedPost?.id === postId) {
                  setOpenPost(applyBuiltInVoteTruth(openedPost, knownTruth))
                }
              }
              builtInVoteIntentRef.current.delete(key)
              showToast(outcome.error ?? t('voteFailed'), 'error')
              return
            }
            continue
          }

          knownTruthIsCertain = false
          if (latestIntent?.revision === intent.revision) {
            builtInVoteIntentRef.current.delete(key)
            logger.error('[PostFeed] vote result remains uncertain:', outcome.error)
            showToast(getNetworkErrorMessage(outcome.error, t), 'error')
            return
          }
        }
      }

      const startWorker = (): Promise<void> => {
        const running = builtInVoteWorkerRef.current.get(key)
        if (running) return running
        const worker = drainIntents().finally(() => {
          if (builtInVoteWorkerRef.current.get(key) === worker) {
            builtInVoteWorkerRef.current.delete(key)
          }
        })
        builtInVoteWorkerRef.current.set(key, worker)
        return worker
      }

      try {
        while (scopeIsCurrent(capturedScope) && builtInVoteIntentRef.current.has(key)) {
          await startWorker()
        }
      } catch (error) {
        if (!scopeIsCurrent(capturedScope)) return
        builtInVoteIntentRef.current.delete(key)
        logger.error('[PostFeed] vote queue failed:', error)
        showToast(getNetworkErrorMessage(error, t), 'error')
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      accessToken,
      captureRenderedScope,
      onVoteStateChange,
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
      claimPollResource(postId)
      if (accessToken && !capturedScope.userId) {
        setCustomPollLoadState('error')
        return
      }
      const loadGeneration = ++pollLoadGenerationRef.current
      const requestId = createPostVoteRequestId()
      const requestIsCurrent = () =>
        scopeIsCurrent(capturedScope) &&
        pollResourcePostIdRef.current === postId &&
        pollLoadGenerationRef.current === loadGeneration
      setVotingCustomPoll(false)
      setCustomPollLoadState('loading')
      const controller = new AbortController()
      const timeoutId = setTimeout(
        () => controller.abort(new DOMException('Custom poll request timed out', 'AbortError')),
        POST_VOTE_REQUEST_TIMEOUT_MS
      )
      try {
        const headers: Record<string, string> = {}
        if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`
        const response = await waitWithinAbortSignal(
          fetch(
            `/api/posts/${postId}/poll-vote?operation=${POST_CUSTOM_POLL_READ_OPERATION}&request_id=${requestId}`,
            { headers, cache: 'no-store', signal: controller.signal }
          ),
          controller.signal
        )
        const data: unknown = await waitWithinAbortSignal(response.json(), controller.signal)
        if (!requestIsCurrent()) return
        const acknowledgement =
          response.ok && response.status === 200
            ? readPostCustomPollAcknowledgement(data, {
                actorId: accessToken ? capturedScope.userId : null,
                postId,
                requestId,
              })
            : null
        if (!acknowledgement) throw new Error('Custom poll acknowledgement was invalid')

        if (acknowledgement.action === 'found') {
          setCustomPoll(acknowledgement.poll)
          setCustomPollUserVotes(acknowledgement.userVotes)
          setSelectedPollOptionsRaw(acknowledgement.userVotes)
          setCustomPollLoadState('ready')
        } else {
          setCustomPoll(null)
          setCustomPollUserVotes([])
          setSelectedPollOptionsRaw([])
          setCustomPollLoadState('empty')
        }
      } catch (error) {
        if (!requestIsCurrent()) return
        logger.error('[PostFeed] custom poll load failed:', error)
        // Preserve a same-resource last-known poll, but distinguish the load
        // failure from an authoritative `absent` snapshot.
        setCustomPollLoadState('error')
      } finally {
        clearTimeout(timeoutId)
      }
    },
    [accessToken, captureRenderedScope, claimPollResource, scopeIsCurrent]
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
      if (!capturedScope.userId) return
      claimPollScope()
      const poll = customPoll
      if (pollResourcePostIdRef.current !== postId || !poll || customPollLoadState !== 'ready') {
        showToast(t('voteFailed'), 'error')
        return
      }
      const optionIndexes = [...selectedPollOptions].sort((left, right) => left - right)
      if (
        optionIndexes.length === 0 ||
        new Set(optionIndexes).size !== optionIndexes.length ||
        optionIndexes.some(
          (index) => !Number.isSafeInteger(index) || index < 0 || index >= poll.options.length
        ) ||
        (poll.type === 'single' && optionIndexes.length !== 1)
      ) {
        showToast(t('selectAtLeastOneOption'), 'warning')
        return
      }
      const key = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}\u0000custom-poll-${postId}-${poll.id}`
      if (lockRef.current.has(key)) return
      lockRef.current.add(key)
      const loadGeneration = pollLoadGenerationRef.current
      const requestId = createPostVoteRequestId()
      const requestIsCurrent = () =>
        scopeIsCurrent(capturedScope) &&
        pollResourcePostIdRef.current === postId &&
        pollLoadGenerationRef.current === loadGeneration
      setVotingCustomPoll(true)
      const controller = new AbortController()
      const timeoutId = setTimeout(
        () => controller.abort(new DOMException('Custom poll vote timed out', 'AbortError')),
        POST_VOTE_REQUEST_TIMEOUT_MS
      )
      try {
        const response = await waitWithinAbortSignal(
          fetch(`/api/posts/${postId}/poll-vote`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
              ...getCsrfHeaders(),
            },
            body: JSON.stringify({
              operation: POST_CUSTOM_POLL_VOTE_OPERATION,
              request_id: requestId,
              poll_id: poll.id,
              option_indexes: optionIndexes,
            }),
            cache: 'no-store',
            signal: controller.signal,
          }),
          controller.signal
        )
        const data: unknown = await waitWithinAbortSignal(response.json(), controller.signal)
        if (!requestIsCurrent()) return
        const acknowledgement =
          response.ok && response.status === 200
            ? readPostCustomPollVoteAcknowledgement(data, {
                actorId: capturedScope.userId,
                postId,
                pollId: poll.id,
                requestId,
                pollType: poll.type,
                optionTexts: poll.options.map((option) => option.text),
                optionIndexes,
              })
            : null
        if (acknowledgement) {
          setCustomPoll((prev) =>
            prev?.id === acknowledgement.pollId
              ? {
                  ...prev,
                  options: acknowledgement.options,
                  showResults: true,
                  totalVotes: acknowledgement.totalVotes,
                }
              : prev
          )
          setCustomPollUserVotes(acknowledgement.optionIndexes)
          setSelectedPollOptionsRaw(acknowledgement.optionIndexes)
          setCustomPollLoadState('ready')
          showToast(t('voted'), 'success')
        } else {
          const rawError =
            data !== null && typeof data === 'object' && !Array.isArray(data)
              ? (data as Record<string, unknown>).error
              : null
          showToast(typeof rawError === 'string' ? rawError : t('voteFailed'), 'error')
        }
      } catch (err) {
        if (!requestIsCurrent()) return
        logger.error('[PostFeed] custom poll vote failed:', err)
        showToast(getNetworkErrorMessage(err, t), 'error')
      } finally {
        clearTimeout(timeoutId)
        if (requestIsCurrent()) setVotingCustomPoll(false)
        lockRef.current.delete(key)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      accessToken,
      captureRenderedScope,
      claimPollScope,
      customPoll,
      customPollLoadState,
      scopeIsCurrent,
      selectedPollOptions,
    ]
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
      if (!capturedScope.userId) return
      const actorId = capturedScope.userId
      const requestId = createPostBookmarkRequestId()
      const lockKey = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}\u0000${postId}`
      if (bookmarkLockRef.current.has(lockKey)) return
      bookmarkLockRef.current.add(lockKey)
      bookmarkMutationRevisionRef.current.set(
        lockKey,
        (bookmarkMutationRevisionRef.current.get(lockKey) ?? 0) + 1
      )
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

      const rollback = () => {
        setUserBookmarks((prev) => ({ ...prev, [postId]: prevBookmarked }))
        setBookmarkCounts((prev) => ({ ...prev, [postId]: prevCount }))
      }
      const reconcileUncertainMutation = async (): Promise<'reconciled' | 'failed' | 'stale'> => {
        const bookmarked = await readCurrentPostBookmarkStatus({
          accessToken,
          actorId,
          postId,
        })
        if (!scopeIsCurrent(capturedScope)) return 'stale'
        if (bookmarked === null) return 'failed'

        const ownCountDelta = bookmarked === prevBookmarked ? 0 : bookmarked ? 1 : -1
        const reconciledCount = Math.max(0, prevCount + ownCountDelta)
        setUserBookmarks((prev) => ({ ...prev, [postId]: bookmarked }))
        setBookmarkCounts((prev) => ({ ...prev, [postId]: reconciledCount }))
        setPosts((prev) =>
          prev.map((post) =>
            post.id === postId
              ? {
                  ...post,
                  bookmark_count: Math.max(0, post.bookmark_count + ownCountDelta),
                }
              : post
          )
        )
        const openedPost = openPostRef.current
        if (!openPostAliasesPosts && openedPost?.id === postId) {
          setOpenPost({
            ...openedPost,
            bookmark_count: Math.max(0, openedPost.bookmark_count + ownCountDelta),
          } as Post)
        }

        if (bookmarked === optimisticBookmarked) {
          if (bookmarked && !prevBookmarked) {
            trackEvent('post_bookmark', { post_id: postId })
          }
          showToast(bookmarked ? t('bookmarked') : t('unbookmarked'), 'success')
        } else {
          showToast(t('operationFailed'), 'error')
        }
        return 'reconciled'
      }
      const rejectDefinitively = (status: number, result: unknown) => {
        rollback()
        if (status === 401) {
          showToast(t('loginExpiredPleaseRelogin'), 'error')
          redirectBookmarkToLogin(postId)
          return
        }
        const errorMessage =
          result !== null && typeof result === 'object' && !Array.isArray(result)
            ? (result as Record<string, unknown>).error
            : null
        showToast(typeof errorMessage === 'string' ? errorMessage : t('operationFailed'), 'error')
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(
        () => controller.abort(new DOMException('Post bookmark request timed out', 'AbortError')),
        POST_BOOKMARK_REQUEST_TIMEOUT_MS
      )

      let response: Response | null = null
      try {
        response = await waitWithinAbortSignal(
          fetch(`/api/posts/${postId}/bookmark`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
              ...getCsrfHeaders(),
            },
            body: JSON.stringify({ operation: POST_BOOKMARK_OPERATION, request_id: requestId }),
            cache: 'no-store',
            signal: controller.signal,
          }),
          controller.signal
        )
        const result: unknown = await waitWithinAbortSignal(response.json(), controller.signal)
        if (!scopeIsCurrent(capturedScope)) return
        const acknowledgement =
          response.ok && response.status === 200
            ? readPostBookmarkAcknowledgement(result, {
                actorId,
                postId,
                requestId,
              })
            : null
        if (acknowledgement) {
          // Reconcile with server state
          setUserBookmarks((prev) => ({ ...prev, [postId]: acknowledgement.bookmarked }))
          setBookmarkCounts((prev) => ({ ...prev, [postId]: acknowledgement.bookmarkCount }))
          // Sync bookmark count to feed posts array
          setPosts((prev) =>
            prev.map((p) =>
              p.id === postId ? { ...p, bookmark_count: acknowledgement.bookmarkCount } : p
            )
          )
          const op = openPostRef.current
          if (!openPostAliasesPosts && op?.id === postId)
            setOpenPost({ ...op, bookmark_count: acknowledgement.bookmarkCount } as Post)
          // Analytics: only count adding a bookmark, not removing one
          if (acknowledgement.bookmarked) {
            trackEvent('post_bookmark', { post_id: postId })
          }
          showToast(acknowledgement.bookmarked ? t('bookmarked') : t('unbookmarked'), 'success')
        } else if (isDefinitivePostBookmarkRejection(response.status)) {
          rejectDefinitively(response.status, result)
        } else {
          const reconciliation = await reconcileUncertainMutation()
          if (reconciliation === 'stale') return
          if (reconciliation === 'failed') {
            rollback()
            const errorMessage =
              result !== null && typeof result === 'object' && !Array.isArray(result)
                ? (result as Record<string, unknown>).error
                : null
            showToast(
              typeof errorMessage === 'string' ? errorMessage : t('operationFailed'),
              'error'
            )
          }
        }
      } catch (err) {
        if (!scopeIsCurrent(capturedScope)) return
        if (response && isDefinitivePostBookmarkRejection(response.status)) {
          rejectDefinitively(response.status, null)
        } else {
          const reconciliation = await reconcileUncertainMutation()
          if (reconciliation === 'stale') return
          if (reconciliation === 'failed') {
            rollback()
            showToast(getNetworkErrorMessage(err, t), 'error')
          }
        }
      } finally {
        clearTimeout(timeoutId)
        // A hydration begun while this toggle was in flight must stay stale
        // even after the lock is released. Settlement advances the truth
        // revision for both accepted and rolled-back mutations.
        if (scopeIsCurrent(capturedScope)) {
          bookmarkMutationRevisionRef.current.set(
            lockKey,
            (bookmarkMutationRevisionRef.current.get(lockKey) ?? 0) + 1
          )
        }
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
      // Folder save and plain toggle mutate the same per-viewer/post row, so
      // they share one client lock and one hydration truth revision.
      const lockKey = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}\u0000${capturedPostId}`
      if (bookmarkLockRef.current.has(lockKey)) return false
      bookmarkLockRef.current.add(lockKey)
      bookmarkMutationRevisionRef.current.set(
        lockKey,
        (bookmarkMutationRevisionRef.current.get(lockKey) ?? 0) + 1
      )
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
        if (scopeIsCurrent(capturedScope)) {
          bookmarkMutationRevisionRef.current.set(
            lockKey,
            (bookmarkMutationRevisionRef.current.get(lockKey) ?? 0) + 1
          )
        }
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
      if (!capturedScope.userId) return false
      const post =
        postsRef.current.find((candidate) => candidate.id === postId) ||
        (openPostRef.current?.id === postId ? openPostRef.current : null)
      if (!post) return false
      if (post.author_id === capturedScope.userId) {
        showToast(t('cannotRepostOwn'), 'warning')
        return false
      }
      const rootPostId = post.original_post_id || post.id
      const requestId = createPostRepostRequestId()
      const key = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}\u0000repost-${rootPostId}`
      if (lockRef.current.has(key)) return false
      lockRef.current.add(key)
      setRepostLoading((prev) => ({ ...prev, [postId]: true }))
      const controller = new AbortController()
      const timeoutId = setTimeout(
        () => controller.abort(new DOMException('Post repost request timed out', 'AbortError')),
        POST_REPOST_REQUEST_TIMEOUT_MS
      )
      try {
        const response = await waitWithinAbortSignal(
          fetch(`/api/posts/${postId}/repost`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
              ...getCsrfHeaders(),
            },
            body: JSON.stringify({
              operation: POST_REPOST_OPERATION,
              request_id: requestId,
              comment: comment ?? '',
            }),
            cache: 'no-store',
            signal: controller.signal,
          }),
          controller.signal
        )
        const result: unknown = await waitWithinAbortSignal(response.json(), controller.signal)
        if (!scopeIsCurrent(capturedScope)) return false

        const expectedReceipt = {
          actorId: capturedScope.userId,
          sourcePostId: postId,
          rootPostId,
          requestId,
        }
        const acknowledgement =
          response.ok && response.status === 201
            ? readPostRepostAcknowledgement(result, {
                ...expectedReceipt,
                action: 'created',
              })
            : !response.ok && response.status === 409
              ? readPostRepostAcknowledgement(result, {
                  ...expectedReceipt,
                  action: 'already_exists',
                })
              : null

        if (acknowledgement) {
          setPosts((prev) =>
            prev.map((item) =>
              item.id === acknowledgement.rootPostId
                ? { ...item, repost_count: acknowledgement.repostCount }
                : item
            )
          )
          const openedPost = openPostRef.current
          if (!openPostAliasesPosts && openedPost && openedPost.id === acknowledgement.rootPostId) {
            setOpenPost({ ...openedPost, repost_count: acknowledgement.repostCount })
          }
          if (acknowledgement.action === 'created') {
            trackEvent('post_repost', {
              post_id: acknowledgement.sourcePostId,
              with_comment: comment ? 1 : 0,
            })
            showToast(t('reposted'), 'success')
            return true
          }

          // A duplicate is canonical existing state, not proof that this
          // request created a row. Reconcile its count without publishing a
          // creation success or analytics event.
          showToast(t('alreadyReposted'), 'warning')
          return false
        }

        const rawError =
          result !== null && typeof result === 'object' && !Array.isArray(result)
            ? (result as Record<string, unknown>).error
            : null
        showToast(typeof rawError === 'string' ? rawError : t('repostFailed'), 'error')
        return false
      } catch (err) {
        if (!scopeIsCurrent(capturedScope)) return false
        logger.error('[PostFeed] repost failed:', err)
        showToast(getNetworkErrorMessage(err, t), 'error')
        return false
      } finally {
        clearTimeout(timeoutId)
        if (scopeIsCurrent(capturedScope)) {
          setRepostLoading((prev) => ({ ...prev, [postId]: false }))
        }
        lockRef.current.delete(key)
      }
    },
    [
      accessToken,
      captureRenderedScope,
      scopeIsCurrent,
      setOpenPost,
      setPosts,
      showToast,
      openPostAliasesPosts,
      setRepostLoading,
      t,
    ]
  )

  // Load user bookmarks
  const loadUserBookmarksAndReposts = useCallback(
    async (postIds: string[]) => {
      if (!accessToken || !currentUserId || postIds.length === 0) return
      const capturedScope = captureRenderedScope()
      if (!scopeIsCurrent(capturedScope)) return
      const uniquePostIds = [...new Set(postIds.map((postId) => postId.toLowerCase()))]

      for (let offset = 0; offset < uniquePostIds.length; offset += 100) {
        if (!scopeIsCurrent(capturedScope)) return
        const batchPostIds = uniquePostIds.slice(offset, offset + 100)
        const batchLockKey = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}\u0000${[
          ...batchPostIds,
        ]
          .sort()
          .join(',')}`
        if (bookmarkStatusLockRef.current.has(batchLockKey)) continue
        const requestId = createPostBookmarkRequestId()
        bookmarkStatusLockRef.current.add(batchLockKey)

        const hydrationRevisions = new Map<string, number>()
        const mutationRevisions = new Map<string, number>()
        for (const postId of batchPostIds) {
          const postKey = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}\u0000${postId}`
          const hydrationRevision = (bookmarkHydrationRevisionRef.current.get(postKey) ?? 0) + 1
          bookmarkHydrationRevisionRef.current.set(postKey, hydrationRevision)
          hydrationRevisions.set(postKey, hydrationRevision)
          mutationRevisions.set(postKey, bookmarkMutationRevisionRef.current.get(postKey) ?? 0)
        }

        const controller = new AbortController()
        const timeoutId = setTimeout(
          () =>
            controller.abort(new DOMException('Bookmark status request timed out', 'AbortError')),
          POST_BOOKMARK_REQUEST_TIMEOUT_MS
        )
        try {
          const res = await waitWithinAbortSignal(
            fetch('/api/posts/bookmarks/status', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${accessToken}`,
                ...getCsrfHeaders(),
              },
              body: JSON.stringify({ postIds: batchPostIds, request_id: requestId }),
              cache: 'no-store',
              signal: controller.signal,
            }),
            controller.signal
          )
          const data: unknown = await waitWithinAbortSignal(res.json(), controller.signal)
          if (!scopeIsCurrent(capturedScope)) return
          const acknowledgement =
            res.ok && res.status === 200
              ? readPostBookmarkStatusAcknowledgement(data, {
                  actorId: currentUserId,
                  requestId,
                  postIds: batchPostIds,
                })
              : null
          if (!acknowledgement) continue

          const currentBookmarks: Record<string, boolean> = {}
          for (const postId of acknowledgement.postIds) {
            const postKey = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}\u0000${postId}`
            if (
              bookmarkHydrationRevisionRef.current.get(postKey) ===
                hydrationRevisions.get(postKey) &&
              (bookmarkMutationRevisionRef.current.get(postKey) ?? 0) ===
                mutationRevisions.get(postKey) &&
              !bookmarkLockRef.current.has(postKey)
            ) {
              currentBookmarks[postId] = acknowledgement.bookmarks[postId]
            }
          }
          if (Object.keys(currentBookmarks).length > 0) {
            setUserBookmarks((prev) => ({ ...prev, ...currentBookmarks }))
          }
        } catch {
          // Bookmark status is non-critical. Preserve the last known state.
        } finally {
          clearTimeout(timeoutId)
          bookmarkStatusLockRef.current.delete(batchLockKey)
        }
      }
    },
    [accessToken, captureRenderedScope, currentUserId, scopeIsCurrent, setUserBookmarks]
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
      openPost,
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

  const pollStateOwned =
    pollOwnerScopeKeyRef.current === scopeKey && pollResourcePostIdRef.current === openPost?.id

  return {
    toggleReaction,
    _toggleVote,
    customPoll: pollStateOwned ? customPoll : null,
    customPollUserVotes: pollStateOwned ? customPollUserVotes : [],
    customPollLoadState: pollStateOwned ? customPollLoadState : 'idle',
    loadingCustomPoll: pollStateOwned && customPollLoadState === 'loading',
    votingCustomPoll: pollStateOwned ? votingCustomPoll : false,
    selectedPollOptions: pollStateOwned ? selectedPollOptions : [],
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
