'use client'

import {
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useModalA11y } from '@/lib/hooks/useModalA11y'
import { formatTimeAgo } from '@/lib/utils/date'
import { authedFetch, getCsrfHeaders } from '@/lib/api/client'
import {
  fetchPostCommentsPage,
  isCreatedCommentAcknowledgement,
  isDefinitiveMutationRejection,
} from '@/lib/api/comments-client'
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
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { jwtSubject } from '@/lib/auth/token-subject'
import { localizedLabel } from '@/lib/utils/format'
import { normalizePostTitle } from '@/lib/utils/post-display'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { useLoginModal } from '@/lib/hooks/useLoginModal'
import { logger } from '@/lib/logger'
import { apiFetch } from '@/lib/utils/api-fetch'
import {
  HOT_DISCOVERY_REQUEST_TIMEOUT_MS,
  readHotGroupsPage,
  readHotPostsPage,
} from '@/lib/hot/hot-discovery-client-contract'
import {
  requestBatchTranslation,
  requestSingleTranslation,
  type BatchTranslationItem,
  type TranslationTargetLanguage,
} from '@/lib/translations/translation-client-contract'
import { detectClearTranslationSourceLanguage } from '@/lib/translations/translation-language'
import type { Post, Comment } from './types'
import { useCommentDraftPersistence } from '@/app/components/post/hooks/useCommentDraftPersistence'
import { useViewerOwnedState } from '@/lib/state/viewer-owned-state'

interface UseHotPageDataOptions {
  initialPosts?: Post[]
}

type HotTranslationScope = {
  viewerKey: string
  sessionGeneration: number
  userId: string | null
  accessToken: string
  language: TranslationTargetLanguage
  generation: number
}

type HotTranslationRequest = {
  key: string
  sequence: number
  scope: HotTranslationScope
  controller: AbortController
  promise: Promise<void>
}

type HotCachedTranslation = {
  source: string
  targetLang: TranslationTargetLanguage
  translatedText: string
}

type HotListTranslationDescriptor = {
  item: BatchTranslationItem
  postId: string
  part: 'title' | 'body'
  laneKey: string
}

type HotReactionTruth = {
  reaction: PostReaction | null
  likeCount: number
  dislikeCount: number
}

type HotReactionScope = {
  viewerKey: string
  sessionGeneration: number
  userId: string | null
}

type HotReactionLane = {
  key: string
  scope: HotReactionScope
  postId: string
  accessToken: string
  desired: PostReaction | null
  revision: number
  confirmed: HotReactionTruth
  confirmedTruthIsCertain: boolean
  promise: Promise<void>
}

function hotReactionKey(scope: HotReactionScope, postId: string): string {
  return `${scope.viewerKey}\u0000${scope.sessionGeneration}\u0000${postId}`
}

const MAX_HOT_TRANSLATION_BATCH_SIZE = 20

function translationLaneKey(...parts: string[]): string {
  return JSON.stringify(parts)
}

function needsHotTranslation(source: string, targetLang: TranslationTargetLanguage): boolean {
  const sourceLang = detectClearTranslationSourceLanguage(source)
  return sourceLang === null || sourceLang !== targetLang
}

function sameTranslationScope(left: HotTranslationScope, right: HotTranslationScope): boolean {
  return (
    left.viewerKey === right.viewerKey &&
    left.sessionGeneration === right.sessionGeneration &&
    left.userId === right.userId &&
    left.accessToken === right.accessToken &&
    left.language === right.language &&
    left.generation === right.generation
  )
}

function applyHotReactionDesired(post: Post, desired: PostReaction | null): Post {
  const current = post.user_reaction ?? null
  const delta = postReactionCountDelta(current, desired)
  const likeCount = Math.max(0, (post.like_count ?? post.likes) + delta.likeCount)
  const dislikeCount = Math.max(0, (post.dislike_count ?? post.dislikes ?? 0) + delta.dislikeCount)
  return {
    ...post,
    likes: likeCount,
    like_count: likeCount,
    dislikes: dislikeCount,
    dislike_count: dislikeCount,
    user_reaction: desired,
  }
}

function applyReactionAcknowledgement(
  post: Post,
  acknowledgement: PostReactionAcknowledgement,
  latestDesired: PostReaction | null
): Post {
  return applyHotReactionDesired(
    {
      ...post,
      likes: acknowledgement.likeCount,
      like_count: acknowledgement.likeCount,
      dislikes: acknowledgement.dislikeCount,
      dislike_count: acknowledgement.dislikeCount,
      user_reaction: acknowledgement.reaction,
    },
    latestDesired
  )
}

export function useHotPageData(options: UseHotPageDataOptions = {}) {
  const { t, language } = useLanguage()
  const localizedName = (zh: string, en?: string | null) => localizedLabel(zh, en, language)
  const { showToast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const auth = useAuthSession()
  const { accessToken, authChecked, email, userId: currentUserId } = auth
  const viewerKey = auth.viewerKey ?? (currentUserId ? `user:${currentUserId}` : 'anon')
  const sessionGeneration = auth.sessionGeneration ?? 0
  const loggedIn = authChecked && !!accessToken
  const translationAccessToken =
    authChecked &&
    auth.isLoggedIn &&
    typeof currentUserId === 'string' &&
    currentUserId.trim().length > 0 &&
    viewerKey === `user:${currentUserId}` &&
    Number.isSafeInteger(sessionGeneration) &&
    sessionGeneration >= 0 &&
    typeof accessToken === 'string' &&
    accessToken.trim().length > 0 &&
    jwtSubject(accessToken)?.toLowerCase() === currentUserId.toLowerCase()
      ? accessToken
      : null
  const activeScopeRef = useRef({ viewerKey, sessionGeneration, userId: currentUserId })
  activeScopeRef.current = { viewerKey, sessionGeneration, userId: currentUserId }
  const accessTokenRef = useRef(accessToken)
  accessTokenRef.current = accessToken
  const translationOwnerReadyRef = useRef(translationAccessToken !== null)
  translationOwnerReadyRef.current = translationAccessToken !== null
  const activeLanguageRef = useRef(language)
  activeLanguageRef.current = language
  const scopeKey = `${viewerKey}\u0000${sessionGeneration}`
  const previousScopeKeyRef = useRef(scopeKey)

  // Translation state
  const [translatedContent, setTranslatedContent] = useViewerOwnedState<string | null>(
    null,
    () => null,
    scopeKey
  )
  const [showingOriginal, setShowingOriginal] = useViewerOwnedState(true, () => true, scopeKey)
  const [translating, setTranslating] = useViewerOwnedState(false, () => false, scopeKey)
  const [translatedListPosts, setTranslatedListPosts] = useViewerOwnedState<
    Record<string, { title?: string; body?: string }>
  >({}, () => ({}), scopeKey)
  const [translatingList, setTranslatingList] = useViewerOwnedState(false, () => false, scopeKey)
  const [expandedPosts, setExpandedPosts] = useViewerOwnedState<Record<string, boolean>>(
    {},
    () => ({}),
    scopeKey
  )
  const [posts, setPosts] = useViewerOwnedState<Post[]>(
    options.initialPosts || [],
    () => [],
    scopeKey
  )
  const [loadingPosts, setLoadingPosts] = useState(
    !options.initialPosts || options.initialPosts.length === 0
  )
  const [postsError, setPostsError] = useState<Error | null>(null)
  const postsRef = useRef(posts)
  postsRef.current = posts

  // Tabbed sections state
  const [activeHotTab, setActiveHotTab] = useState<'posts' | 'groups'>('posts')

  // Groups data for the groups tab
  const [groups, setGroups] = useState<
    { id: string; name: string; name_en?: string | null; member_count: number }[]
  >([])
  const [loadingGroups, setLoadingGroups] = useState(false)
  const [groupsError, setGroupsError] = useState<Error | null>(null)
  const groupsRef = useRef(groups)
  groupsRef.current = groups

  const latestPostTime = useRef<string>('')

  // Post detail modal state
  const [openPost, setOpenPost] = useViewerOwnedState<Post | null>(null, () => null, scopeKey)
  const [comments, setCommentsOwned] = useViewerOwnedState<Comment[]>([], () => [], scopeKey)
  const commentsRevisionRef = useRef(new Map<string, number>())
  const setComments = useCallback<Dispatch<SetStateAction<Comment[]>>>(
    (action) => {
      const invocationScopeKey = `${activeScopeRef.current.viewerKey}\u0000${activeScopeRef.current.sessionGeneration}`
      commentsRevisionRef.current.set(
        invocationScopeKey,
        (commentsRevisionRef.current.get(invocationScopeKey) || 0) + 1
      )
      setCommentsOwned(action)
    },
    [setCommentsOwned]
  )
  const [loadingComments, setLoadingComments] = useViewerOwnedState(false, () => false, scopeKey)
  const {
    draft: newComment,
    setDraft: setNewComment,
    captureDraftSnapshot,
    clearDraftIfUnchanged,
  } = useCommentDraftPersistence(openPost?.id, viewerKey)
  const [submittingComment, setSubmittingComment] = useViewerOwnedState(
    false,
    () => false,
    scopeKey
  )
  const submittingCommentRef = useRef<symbol | null>(null)
  const reactionRequestLanesRef = useRef<Map<string, HotReactionLane>>(new Map())
  const reactionStateRevisionRef = useRef<Map<string, number>>(new Map())
  const openPostIdRef = useRef<string | null>(null)
  const commentLoadGenerationRef = useRef(new Map<string, number>())
  const commentLoadMoreGenerationRef = useRef(new Map<string, number>())
  const translationMountedRef = useRef(false)
  const translationGenerationRef = useRef(0)
  const translationSequenceRef = useRef(0)
  const previousTranslationScopeRef = useRef({
    scopeKey,
    accessToken: translationAccessToken,
    language,
  })
  const contentTranslationCacheRef = useRef(new Map<string, HotCachedTranslation>())
  const listTranslationCacheRef = useRef(new Map<string, HotCachedTranslation>())
  const translatedListPostsRef = useRef(translatedListPosts)
  translatedListPostsRef.current = translatedListPosts
  const activeContentTranslationRef = useRef<HotTranslationRequest | null>(null)
  const activeListTranslationRef = useRef<HotTranslationRequest | null>(null)
  const openPostTranslationRef = useRef<{ postId: string; content: string } | null>(null)
  openPostTranslationRef.current = openPost ? { postId: openPost.id, content: openPost.body } : null

  // Comment pagination
  const COMMENTS_PER_PAGE = 10
  const [commentsOffset, setCommentsOffset] = useViewerOwnedState(0, () => 0, scopeKey)
  const [hasMoreComments, setHasMoreComments] = useViewerOwnedState(true, () => true, scopeKey)
  const [loadingMoreComments, setLoadingMoreComments] = useViewerOwnedState(
    false,
    () => false,
    scopeKey
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

  const captureTranslationScope = useCallback(
    (token: string, targetLang: TranslationTargetLanguage): HotTranslationScope => ({
      ...activeScopeRef.current,
      accessToken: token,
      language: targetLang,
      generation: translationGenerationRef.current,
    }),
    []
  )

  const translationScopeIsCurrent = useCallback((scope: HotTranslationScope): boolean => {
    const current = activeScopeRef.current
    return (
      translationMountedRef.current &&
      translationOwnerReadyRef.current &&
      current.userId !== null &&
      current.viewerKey === `user:${current.userId}` &&
      jwtSubject(scope.accessToken)?.toLowerCase() === current.userId.toLowerCase() &&
      current.viewerKey === scope.viewerKey &&
      current.sessionGeneration === scope.sessionGeneration &&
      current.userId === scope.userId &&
      accessTokenRef.current === scope.accessToken &&
      activeLanguageRef.current === scope.language &&
      translationGenerationRef.current === scope.generation
    )
  }, [])

  const abortTranslationRequests = useCallback(() => {
    const reason = new DOMException('Hot translation scope changed', 'AbortError')
    for (const active of [activeContentTranslationRef.current, activeListTranslationRef.current]) {
      if (active && !active.controller.signal.aborted) active.controller.abort(reason)
    }
    activeContentTranslationRef.current = null
    activeListTranslationRef.current = null
  }, [])

  const cancelContentTranslation = useCallback(() => {
    const active = activeContentTranslationRef.current
    if (active && !active.controller.signal.aborted) {
      active.controller.abort(new DOMException('Hot content translation cancelled', 'AbortError'))
    }
    activeContentTranslationRef.current = null
    translationSequenceRef.current += 1
    setTranslating(false)
  }, [setTranslating])

  useEffect(() => {
    translationMountedRef.current = true
    return () => {
      translationMountedRef.current = false
      translationGenerationRef.current += 1
      abortTranslationRequests()
    }
  }, [abortTranslationRequests])

  useEffect(() => {
    const previous = previousTranslationScopeRef.current
    if (
      previous.scopeKey === scopeKey &&
      previous.accessToken === translationAccessToken &&
      previous.language === language
    ) {
      return
    }

    previousTranslationScopeRef.current = {
      scopeKey,
      accessToken: translationAccessToken,
      language,
    }
    translationGenerationRef.current += 1
    abortTranslationRequests()
    contentTranslationCacheRef.current.clear()
    listTranslationCacheRef.current.clear()
    translatedListPostsRef.current = {}
    setTranslatedContent(null)
    setShowingOriginal(true)
    setTranslating(false)
    setTranslatedListPosts({})
    setTranslatingList(false)
  }, [
    abortTranslationRequests,
    language,
    scopeKey,
    setShowingOriginal,
    setTranslatedContent,
    setTranslatedListPosts,
    setTranslating,
    setTranslatingList,
    translationAccessToken,
  ])

  useEffect(() => {
    if (previousScopeKeyRef.current === scopeKey) return
    previousScopeKeyRef.current = scopeKey
    commentLoadGenerationRef.current.clear()
    commentLoadMoreGenerationRef.current.clear()
    submittingCommentRef.current = null
    reactionRequestLanesRef.current.clear()
    reactionStateRevisionRef.current.clear()
    setComments([])
    setCommentsOffset(0)
    setHasMoreComments(true)
    setLoadingComments(false)
    setLoadingMoreComments(false)
    setSubmittingComment(false)
    setTranslatedContent(null)
    setShowingOriginal(true)
    setTranslating(false)
    setTranslatedListPosts({})
    setTranslatingList(false)
    setExpandedPosts({})
    setPosts((previous) => previous.map((post) => ({ ...post, user_reaction: null })))
    setOpenPost((previous) => (previous ? { ...previous, user_reaction: null } : null))
  }, [
    scopeKey,
    setComments,
    setCommentsOffset,
    setExpandedPosts,
    setHasMoreComments,
    setLoadingComments,
    setLoadingMoreComments,
    setOpenPost,
    setPosts,
    setShowingOriginal,
    setSubmittingComment,
    setTranslatedContent,
    setTranslatedListPosts,
    setTranslating,
    setTranslatingList,
  ])

  // AbortController for loadPosts — prevents stale setState after unmount
  // and allows the auto-refresh interval to cancel in-flight requests on cleanup.
  const loadPostsAbortRef = useRef<AbortController | null>(null)

  const markReactionStateChanged = useCallback((key: string) => {
    reactionStateRevisionRef.current.set(key, (reactionStateRevisionRef.current.get(key) || 0) + 1)
  }, [])

  const preserveNewerReactionState = useCallback(
    (
      incoming: Post[],
      revisionAtStart: ReadonlyMap<string, number>,
      scope: HotReactionScope
    ): Post[] => {
      const currentById = new Map(postsRef.current.map((post) => [post.id, post]))
      return incoming.map((post) => {
        const key = hotReactionKey(scope, post.id)
        const changedAfterReadStarted =
          (reactionStateRevisionRef.current.get(key) || 0) !== (revisionAtStart.get(key) || 0)
        if (!changedAfterReadStarted && !reactionRequestLanesRef.current.has(key)) return post
        const current = currentById.get(post.id)
        if (!current) return post
        return {
          ...post,
          likes: current.likes,
          like_count: current.like_count,
          dislikes: current.dislikes,
          dislike_count: current.dislike_count,
          user_reaction: current.user_reaction,
        }
      })
    },
    []
  )

  // Load hot posts from cache API
  const loadPosts = useCallback(async () => {
    if (!authChecked) return
    const capturedScope = activeScopeRef.current
    const reactionRevisionAtStart = new Map(reactionStateRevisionRef.current)
    // Cancel any in-flight loadPosts before starting a new one
    loadPostsAbortRef.current?.abort()
    const controller = new AbortController()
    loadPostsAbortRef.current = controller

    // Keep SSR/current last-good posts visible during background refreshes.
    // The full loading state is only for a first load with no usable data.
    if (postsRef.current.length === 0) setLoadingPosts(true)
    setPostsError(null)
    try {
      const headers: Record<string, string> = {}
      if (accessTokenRef.current) {
        headers['Authorization'] = `Bearer ${accessTokenRef.current}`
      }
      const payload = await apiFetch<unknown>(
        `/api/posts?sort_by=hot_score&sort_order=desc&limit=30`,
        {
          headers,
          signal: controller.signal,
          cache: 'no-store',
          timeoutMs: HOT_DISCOVERY_REQUEST_TIMEOUT_MS,
        }
      )
      if (controller.signal.aborted || !scopeIsCurrent(capturedScope)) return
      const data = readHotPostsPage(payload)
      if (!data) throw new Error('Hot posts returned an invalid page')

      if (data.length > 0) {
        const postsData: Post[] = data.map((post) => {
          const createdAt = new Date(post.created_at)
          const diffMs = Date.now() - createdAt.getTime()
          const timeStr = formatTimeAgo(post.created_at, language)
          // Default ("General") category has no real group row. Feed the
          // UI-localized default into BOTH slots so localizedLabel() renders a
          // localized badge for ja/ko instead of the English "General"
          // (localizedLabel prefers the en slot for any non-zh language, and
          // there is no ja/ko group data — but the default IS localizable via t()).
          const rawGroupName = post.group_name ?? undefined
          const groupName = rawGroupName || t('generalDiscussion')
          const groupNameEn = rawGroupName
            ? post.group_name_en || t('generalDiscussionEn')
            : t('generalDiscussion')

          const hotScore =
            post.hot_score ||
            (() => {
              const hours = diffMs / 3600000
              return (
                post.like_count * 3 +
                post.comment_count * 5 +
                post.view_count * 0.1 -
                Math.log(hours + 2) * 2
              )
            })()
          const likeCount = post.like_count
          const dislikeCount = post.dislike_count

          return {
            id: post.id,
            group: groupName,
            group_en: groupNameEn,
            group_id: post.group_id || undefined,
            // Keep parity with the server mapper (page.tsx): empty/placeholder
            // titles stay '' in data; render points decide the fallback.
            title: normalizePostTitle(post.title),
            author: post.author_handle,
            author_handle: post.author_handle,
            author_avatar_url: post.author_avatar_url,
            time: timeStr,
            body: post.content,
            comments: post.comment_count,
            likes: likeCount,
            like_count: likeCount,
            dislikes: dislikeCount,
            dislike_count: dislikeCount,
            hotScore,
            views: post.view_count,
            created_at: post.created_at,
            user_reaction: post.user_reaction,
          }
        })
        setPosts(preserveNewerReactionState(postsData, reactionRevisionAtStart, capturedScope))
        if (postsData.length > 0 && postsData[0].created_at) {
          latestPostTime.current = postsData[0].created_at
        }
      } else {
        // A successful, validated empty response is the only condition allowed
        // to replace last-good posts with the product's no-data state.
        setPosts([])
      }
    } catch (e) {
      // Swallow aborts (unmount/navigation) — not real errors
      if (e instanceof Error && (e.name === 'AbortError' || controller.signal.aborted)) return
      if (!scopeIsCurrent(capturedScope)) return
      logger.error('Failed to load posts:', e)
      setPostsError(e instanceof Error ? e : new Error('Failed to load hot posts'))
      showToast(t('loadHotPostsFailed'), 'error')
    } finally {
      if (!controller.signal.aborted && scopeIsCurrent(capturedScope)) setLoadingPosts(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable ref t excluded to avoid re-creating callback
  }, [
    authChecked,
    language,
    preserveNewerReactionState,
    scopeIsCurrent,
    sessionGeneration,
    showToast,
    viewerKey,
  ])

  useEffect(() => {
    loadPosts()
    const interval = setInterval(loadPosts, 180000)
    return () => {
      clearInterval(interval)
      // Abort in-flight fetch on unmount so setState can't leak onto unmounted tree
      // and response bodies aren't held in memory waiting for GC.
      loadPostsAbortRef.current?.abort()
      loadPostsAbortRef.current = null
    }
  }, [loadPosts])

  const groupsAbortRef = useRef<AbortController | null>(null)
  const loadGroups = useCallback(async () => {
    const capturedScope = activeScopeRef.current
    groupsAbortRef.current?.abort()
    const controller = new AbortController()
    groupsAbortRef.current = controller

    if (groupsRef.current.length === 0) setLoadingGroups(true)
    setGroupsError(null)
    try {
      const payload = await apiFetch<unknown>('/api/groups?sort_by=activity&limit=30', {
        signal: controller.signal,
        cache: 'no-store',
        timeoutMs: HOT_DISCOVERY_REQUEST_TIMEOUT_MS,
      })
      if (controller.signal.aborted || !scopeIsCurrent(capturedScope)) return
      const data = readHotGroupsPage(payload)
      if (!data) throw new Error('Hot groups returned an invalid page')
      setGroups(
        data.map((group) => ({
          id: group.id,
          name: group.name,
          name_en: group.name_en,
          member_count: group.member_count,
        }))
      )
    } catch (error) {
      if (controller.signal.aborted || !scopeIsCurrent(capturedScope)) return
      logger.error('Groups load error:', error)
      setGroupsError(error instanceof Error ? error : new Error('Failed to load hot groups'))
    } finally {
      if (
        groupsAbortRef.current === controller &&
        !controller.signal.aborted &&
        scopeIsCurrent(capturedScope)
      ) {
        setLoadingGroups(false)
      }
    }
  }, [scopeIsCurrent])

  // Load groups only for the visible tab, and rebind the page after a viewer
  // scope change so a late response can never cross accounts.
  useEffect(() => {
    if (activeHotTab !== 'groups') return
    void loadGroups()
    return () => {
      groupsAbortRef.current?.abort()
      groupsAbortRef.current = null
    }
  }, [activeHotTab, loadGroups, scopeKey])

  const hotPosts = useMemo(() => {
    const sorted = [...posts].sort((a, b) => (b.hotScore ?? 0) - (a.hotScore ?? 0))
    return sorted
  }, [posts])

  // Hot tags
  const getHotTag = useCallback(
    (post: Post, _rank: number): { label: string; color: string } | null => {
      const createdAt = post.created_at ? new Date(post.created_at) : null
      const hoursAgo = createdAt ? (Date.now() - createdAt.getTime()) / 3600000 : 999
      const score = post.hotScore ?? 0
      const commentCount = post.comments ?? 0

      if (score >= 95 && commentCount >= 150) {
        return { label: t('hotPageTagBoom'), color: 'var(--color-accent-error)' }
      }
      if (score >= 80 && hoursAgo < 24) {
        return { label: t('hotPageTagHot'), color: 'var(--color-chart-orange)' }
      }
      if (hoursAgo < 6) {
        return { label: t('hotPageTagNew'), color: 'var(--color-chart-blue)' }
      }
      return null
    },
    [t]
  )

  const visibleHot = useMemo(() => {
    // Show all posts for everyone — non-logged users get full feed
    // Login prompt shown via CTA banner, not content gating
    return hotPosts
  }, [hotPosts])

  // Load comments (initial)
  const loadComments = useCallback(
    async (
      postId: string,
      showError = true,
      capturedScope = activeScopeRef.current,
      retryAfterNewerState = true
    ): Promise<boolean> => {
      if (!authChecked || !scopeIsCurrent(capturedScope)) return false
      const generationKey = `${capturedScope.viewerKey}\u0000${postId}`
      const revisionKey = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}`
      const generation = (commentLoadGenerationRef.current.get(generationKey) || 0) + 1
      commentLoadGenerationRef.current.set(generationKey, generation)
      const requestStartRevision = commentsRevisionRef.current.get(revisionKey) || 0
      try {
        setLoadingComments(true)

        const page = await fetchPostCommentsPage<Comment>(postId, accessTokenRef.current, {
          limit: COMMENTS_PER_PAGE,
          offset: 0,
          viewerScope: {
            expectedUserId: capturedScope.userId,
            expectedSessionGeneration: capturedScope.sessionGeneration,
          },
        })
        if (
          page.ok &&
          scopeIsCurrent(capturedScope) &&
          commentLoadGenerationRef.current.get(generationKey) === generation
        ) {
          if (page.resourceAbsent) {
            setComments([])
            setPosts((previous) => previous.filter((post) => post.id !== postId))
            setOpenPost((previous) => (previous?.id === postId ? null : previous))
            return true
          }
          if ((commentsRevisionRef.current.get(revisionKey) || 0) !== requestStartRevision) {
            return retryAfterNewerState && openPostIdRef.current === postId
              ? loadComments(postId, showError, capturedScope, false)
              : false
          }
          if (openPostIdRef.current === postId) {
            setComments(page.comments)
            setHasMoreComments(page.hasMore)
            setCommentsOffset(page.comments.length)
          }
          setPosts((prev) =>
            prev.map((post) =>
              post.id === postId ? { ...post, comments: page.commentCount } : post
            )
          )
          setOpenPost((prev) =>
            prev?.id === postId ? { ...prev, comments: page.commentCount } : prev
          )
          return true
        }
        if (
          showError &&
          scopeIsCurrent(capturedScope) &&
          commentLoadGenerationRef.current.get(generationKey) === generation
        ) {
          showToast(t('loadCommentsFailed'), 'error')
        }
        return false
      } catch (err) {
        logger.error('[HotPage] Load comments failed:', err)
        if (
          showError &&
          scopeIsCurrent(capturedScope) &&
          commentLoadGenerationRef.current.get(generationKey) === generation
        ) {
          showToast(t('loadCommentsFailed'), 'error')
        }
        return false
      } finally {
        if (
          scopeIsCurrent(capturedScope) &&
          commentLoadGenerationRef.current.get(generationKey) === generation
        ) {
          setLoadingComments(false)
          commentLoadGenerationRef.current.delete(generationKey)
        }
      }
    },
    [
      authChecked,
      scopeIsCurrent,
      setComments,
      setCommentsOffset,
      setHasMoreComments,
      setLoadingComments,
      setOpenPost,
      setPosts,
      showToast,
      t,
    ]
  )

  // Load more comments
  const loadMoreComments = useCallback(async () => {
    if (!openPost || loadingMoreComments || !hasMoreComments) return

    const capturedScope = activeScopeRef.current
    const postId = openPost.id
    const generationKey = `${capturedScope.viewerKey}\u0000${postId}`
    const revisionKey = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}`
    const generation = (commentLoadMoreGenerationRef.current.get(generationKey) || 0) + 1
    commentLoadMoreGenerationRef.current.set(generationKey, generation)
    const requestStartRevision = commentsRevisionRef.current.get(revisionKey) || 0
    const requestOffset = commentsOffset

    try {
      setLoadingMoreComments(true)
      const page = await fetchPostCommentsPage<Comment>(postId, accessTokenRef.current, {
        limit: COMMENTS_PER_PAGE,
        offset: requestOffset,
        viewerScope: {
          expectedUserId: capturedScope.userId,
          expectedSessionGeneration: capturedScope.sessionGeneration,
        },
      })

      if (
        page.ok &&
        scopeIsCurrent(capturedScope) &&
        commentLoadMoreGenerationRef.current.get(generationKey) === generation
      ) {
        if (page.resourceAbsent) {
          setComments([])
          setPosts((previous) => previous.filter((post) => post.id !== postId))
          setOpenPost((previous) => (previous?.id === postId ? null : previous))
          return
        }
        if ((commentsRevisionRef.current.get(revisionKey) || 0) !== requestStartRevision) {
          await loadComments(postId, false, capturedScope)
          return
        }
        setPosts((prev) =>
          prev.map((post) => (post.id === postId ? { ...post, comments: page.commentCount } : post))
        )
        setOpenPost((prev) =>
          prev?.id === postId ? { ...prev, comments: page.commentCount } : prev
        )
        if (openPostIdRef.current === postId) {
          setComments((prev) => {
            const ids = new Set(prev.map((comment) => comment.id))
            return [...prev, ...page.comments.filter((comment) => !ids.has(comment.id))]
          })
          setHasMoreComments(page.hasMore)
          setCommentsOffset(requestOffset + page.comments.length)
        }
      }
    } catch (err) {
      logger.error('[HotPage] Load more comments failed:', err)
    } finally {
      if (
        scopeIsCurrent(capturedScope) &&
        commentLoadMoreGenerationRef.current.get(generationKey) === generation
      ) {
        setLoadingMoreComments(false)
        commentLoadMoreGenerationRef.current.delete(generationKey)
      }
    }
  }, [
    commentsOffset,
    hasMoreComments,
    loadComments,
    loadingMoreComments,
    openPost,
    scopeIsCurrent,
    setComments,
    setCommentsOffset,
    setHasMoreComments,
    setLoadingMoreComments,
    setOpenPost,
    setPosts,
  ])

  // Defer the first read until session restoration is complete, then reload if
  // the viewer token changes. This prevents URL-restored modals from getting
  // stuck with an anonymous response for a signed-in viewer.
  const openPostId = openPostIdRef.current
  useEffect(() => {
    if (!authChecked || !openPostId) return
    void loadComments(openPostId)
  }, [authChecked, openPostId, loadComments, scopeKey])

  const removeStaleListTranslations = useCallback(
    (stale: readonly [string, 'title' | 'body'][]) => {
      if (stale.length === 0) return
      const current = translatedListPostsRef.current
      let next = current
      for (const [postId, part] of stale) {
        if (!next[postId]?.[part]) continue
        if (next === current) next = { ...current }
        const post = { ...next[postId] }
        delete post[part]
        if (post.title || post.body) next[postId] = post
        else delete next[postId]
      }
      if (next !== current) {
        translatedListPostsRef.current = next
        setTranslatedListPosts(next)
      }
    },
    [setTranslatedListPosts]
  )

  // Batch translate list posts. The route does not expose an explicit partial
  // partition, so the shared contract publishes only a complete result set.
  const translateListPosts = useCallback(
    async (postsToTranslate: Post[], targetLang: TranslationTargetLanguage) => {
      // /api/translate requires auth (Bearer header) — skip for anonymous visitors
      const token = translationAccessToken
      if (!token || activeLanguageRef.current !== targetLang) return

      const stopActiveListTranslation = () => {
        const active = activeListTranslationRef.current
        if (active) {
          if (!active.controller.signal.aborted) {
            active.controller.abort(
              new DOMException('Hot translation batch replaced', 'AbortError')
            )
          }
          activeListTranslationRef.current = null
          translationSequenceRef.current += 1
        }
        setTranslatingList(false)
      }
      const postIds = postsToTranslate.map((post) => post.id)
      if (
        postIds.some((postId) => typeof postId !== 'string' || postId.trim().length === 0) ||
        new Set(postIds).size !== postIds.length
      ) {
        listTranslationCacheRef.current.clear()
        translatedListPostsRef.current = {}
        setTranslatedListPosts({})
        stopActiveListTranslation()
        return
      }

      const descriptors: HotListTranslationDescriptor[] = []
      const stale: Array<[string, 'title' | 'body']> = []
      const seenLanes = new Set<string>()
      const addPart = (
        postId: string,
        part: 'title' | 'body',
        source: string,
        needsTranslation: boolean
      ) => {
        const laneKey = translationLaneKey(postId, part)
        if (seenLanes.has(laneKey)) return
        seenLanes.add(laneKey)
        const shouldTranslate = needsTranslation && source.trim().length > 0
        const cached = listTranslationCacheRef.current.get(laneKey)
        const cacheMatches =
          cached?.source === source && cached.targetLang === targetLang && shouldTranslate
        if (!cacheMatches) {
          listTranslationCacheRef.current.delete(laneKey)
          stale.push([postId, part])
        }
        if (shouldTranslate && !cacheMatches) {
          descriptors.push({
            item: {
              id: `item-${descriptors.length}`,
              text: source,
              contentType: part === 'title' ? 'post_title' : 'post_content',
              contentId: postId,
              targetLang,
            },
            postId,
            part,
            laneKey,
          })
        }
      }

      for (const post of postsToTranslate) {
        if (!post.id) continue
        addPart(post.id, 'title', post.title, needsHotTranslation(post.title, targetLang))
        addPart(post.id, 'body', post.body, needsHotTranslation(post.body, targetLang))
      }
      for (const postId of Object.keys(translatedListPostsRef.current)) {
        if (!seenLanes.has(translationLaneKey(postId, 'title'))) stale.push([postId, 'title'])
        if (!seenLanes.has(translationLaneKey(postId, 'body'))) stale.push([postId, 'body'])
      }
      for (const laneKey of listTranslationCacheRef.current.keys()) {
        if (!seenLanes.has(laneKey)) listTranslationCacheRef.current.delete(laneKey)
      }
      removeStaleListTranslations(stale)

      if (descriptors.length === 0) {
        stopActiveListTranslation()
        return
      }

      const scope = captureTranslationScope(token, targetLang)
      const requestKey = JSON.stringify({
        targetLang,
        items: descriptors.map(({ item, postId, part }) => [item.id, postId, part, item.text]),
      })
      const existing = activeListTranslationRef.current
      if (existing && existing.key === requestKey && sameTranslationScope(existing.scope, scope)) {
        return existing.promise
      }
      if (existing && !existing.controller.signal.aborted) {
        existing.controller.abort(
          new DOMException('Hot translation batch superseded', 'AbortError')
        )
      }

      const controller = new AbortController()
      const sequence = ++translationSequenceRef.current
      setTranslatingList(true)
      const promise = (async () => {
        try {
          const batches: HotListTranslationDescriptor[][] = []
          for (
            let offset = 0;
            offset < descriptors.length;
            offset += MAX_HOT_TRANSLATION_BATCH_SIZE
          ) {
            batches.push(descriptors.slice(offset, offset + MAX_HOT_TRANSLATION_BATCH_SIZE))
          }
          const receipts = await Promise.all(
            batches.map((batch) =>
              requestBatchTranslation(
                batch.map(({ item }) => item),
                targetLang,
                {
                  accessToken: token,
                  csrfHeaders: getCsrfHeaders(),
                  signal: controller.signal,
                }
              )
            )
          )
          const active = activeListTranslationRef.current
          if (!active || active.sequence !== sequence || !translationScopeIsCurrent(scope)) return

          const translatedResults = Object.assign(
            {},
            ...receipts.map((receipt) => receipt.results)
          ) as Record<string, { translatedText: string; cached: boolean }>
          const current = translatedListPostsRef.current
          let next = current
          for (const descriptor of descriptors) {
            const result = translatedResults[descriptor.item.id]
            if (result.translatedText.trim() === descriptor.item.text.trim()) {
              listTranslationCacheRef.current.delete(descriptor.laneKey)
              continue
            }
            listTranslationCacheRef.current.set(descriptor.laneKey, {
              source: descriptor.item.text,
              targetLang,
              translatedText: result.translatedText,
            })
            if (next === current) next = { ...current }
            next[descriptor.postId] = {
              ...next[descriptor.postId],
              [descriptor.part]: result.translatedText,
            }
          }
          if (next !== current) {
            translatedListPostsRef.current = next
            setTranslatedListPosts(next)
          }
        } catch {
          if (!controller.signal.aborted) {
            controller.abort(new DOMException('Hot translation batch failed', 'AbortError'))
          }
          // Automatic translation remains silent and publishes no partial cache.
        } finally {
          const active = activeListTranslationRef.current
          if (active?.sequence === sequence && translationScopeIsCurrent(scope)) {
            activeListTranslationRef.current = null
            setTranslatingList(false)
          }
        }
      })()
      activeListTranslationRef.current = { key: requestKey, sequence, scope, controller, promise }
      return promise
    },
    [
      captureTranslationScope,
      removeStaleListTranslations,
      setTranslatedListPosts,
      setTranslatingList,
      translationAccessToken,
      translationScopeIsCurrent,
    ]
  )

  // Translate list when posts load or language changes (requires auth — translation uses OpenAI credits)
  useEffect(() => {
    if (translationAccessToken) {
      // Translate posts into the active UI language (zh/en/ja/ko).
      translateListPosts(posts, language)
    }
  }, [language, posts, translateListPosts, translationAccessToken])

  // Translate post content (with cache)
  const translateContent = useCallback(
    async (postId: string, content: string, targetLang: TranslationTargetLanguage) => {
      // /api/translate requires auth (Bearer header) — skip silently for anonymous visitors
      const token = translationAccessToken
      if (!token || !postId || !content || activeLanguageRef.current !== targetLang) return
      const scope = captureTranslationScope(token, targetLang)
      const cacheKey = translationLaneKey(postId, targetLang)
      const requestKey = translationLaneKey(postId, targetLang, content)
      const existing = activeContentTranslationRef.current
      if (existing && existing.key === requestKey && sameTranslationScope(existing.scope, scope)) {
        return existing.promise
      }
      if (existing && !existing.controller.signal.aborted) {
        existing.controller.abort(
          new DOMException('Hot content translation superseded', 'AbortError')
        )
      }
      activeContentTranslationRef.current = null
      translationSequenceRef.current += 1

      const cached = contentTranslationCacheRef.current.get(cacheKey)
      if (cached && cached.source === content && cached.targetLang === targetLang) {
        const currentPost = openPostTranslationRef.current
        if (
          translationScopeIsCurrent(scope) &&
          currentPost?.postId === postId &&
          currentPost.content === content
        ) {
          setTranslatedContent(cached.translatedText)
          setShowingOriginal(false)
          setTranslating(false)
        }
        return
      }
      contentTranslationCacheRef.current.delete(cacheKey)

      setTranslatedContent(null)
      setTranslating(true)
      const controller = new AbortController()
      const sequence = translationSequenceRef.current
      const promise = (async () => {
        try {
          const receipt = await requestSingleTranslation(
            {
              text: content,
              targetLang,
              contentType: 'post_content',
              contentId: postId,
            },
            {
              accessToken: token,
              csrfHeaders: getCsrfHeaders(),
              signal: controller.signal,
            }
          )
          const active = activeContentTranslationRef.current
          const currentPost = openPostTranslationRef.current
          if (
            !active ||
            active.sequence !== sequence ||
            !translationScopeIsCurrent(scope) ||
            currentPost?.postId !== postId ||
            currentPost.content !== content
          ) {
            return
          }

          if (receipt.sameLanguage) {
            contentTranslationCacheRef.current.delete(cacheKey)
            setTranslatedContent(null)
            setShowingOriginal(true)
            return
          }

          contentTranslationCacheRef.current.set(cacheKey, {
            source: content,
            targetLang,
            translatedText: receipt.translatedText,
          })
          setTranslatedContent(receipt.translatedText)
          setShowingOriginal(false)
        } catch {
          const active = activeContentTranslationRef.current
          const currentPost = openPostTranslationRef.current
          if (
            active?.sequence === sequence &&
            translationScopeIsCurrent(scope) &&
            currentPost?.postId === postId &&
            currentPost.content === content &&
            !controller.signal.aborted
          ) {
            setTranslatedContent(null)
            setShowingOriginal(true)
            showToast(t('translationServiceError'), 'error')
          }
        } finally {
          const active = activeContentTranslationRef.current
          if (active?.sequence === sequence && translationScopeIsCurrent(scope)) {
            activeContentTranslationRef.current = null
            setTranslating(false)
          }
        }
      })()
      activeContentTranslationRef.current = {
        key: requestKey,
        sequence,
        scope,
        controller,
        promise,
      }
      return promise
    },
    [
      captureTranslationScope,
      setShowingOriginal,
      setTranslatedContent,
      setTranslating,
      showToast,
      t,
      translationAccessToken,
      translationScopeIsCurrent,
    ]
  )

  // Track whether this modal was opened via navigation
  const openedViaNav = useRef(false)

  // Guard against the URL-restore effect re-opening a just-closed post:
  // handleClosePost sets openPost to null and then router.replace()s the
  // ?post= param away, but the effect re-runs on that same render while
  // searchParams still holds the stale ?post= value — without this ref it
  // would immediately re-open the modal (close button appears dead).
  const justClosedIdRef = useRef<string | null>(null)

  // Open post detail
  const handleOpenPost = useCallback(
    (post: Post, fromUrlRestore = false) => {
      justClosedIdRef.current = null
      openPostIdRef.current = post.id
      openPostTranslationRef.current = { postId: post.id, content: post.body }
      setOpenPost(post)
      setComments([])
      setCommentsOffset(0)
      setHasMoreComments(true)
      setTranslatedContent(null)
      setShowingOriginal(true)

      if (!fromUrlRestore) {
        const params = new URLSearchParams(searchParams.toString())
        params.set('post', post.id)
        openedViaNav.current = true
        router.push(`/hot?${params.toString()}`, { scroll: false })
      }

      if (post.body) {
        // Detect all supported scripts. Ambiguous or mixed text is sent to the
        // strict translation contract instead of being guessed as English.
        const needsTranslation = needsHotTranslation(post.body, language)

        if (needsTranslation) {
          translateContent(post.id, post.body, language)
        } else {
          cancelContentTranslation()
        }
      } else {
        cancelContentTranslation()
      }
    },
    [
      cancelContentTranslation,
      language,
      router,
      searchParams,
      setComments,
      setCommentsOffset,
      setHasMoreComments,
      setOpenPost,
      setShowingOriginal,
      setTranslatedContent,
      translateContent,
    ]
  )

  // Close post detail
  const handleClosePost = useCallback(() => {
    justClosedIdRef.current = searchParams.get('post')
    openPostIdRef.current = null
    openPostTranslationRef.current = null
    cancelContentTranslation()
    setTranslatedContent(null)
    setShowingOriginal(true)
    setOpenPost(null)
    openedViaNav.current = false
    const params = new URLSearchParams(searchParams.toString())
    params.delete('post')
    const newUrl = params.toString() ? `/hot?${params.toString()}` : '/hot'
    router.replace(newUrl, { scroll: false })
  }, [
    cancelContentTranslation,
    router,
    searchParams,
    setOpenPost,
    setShowingOriginal,
    setTranslatedContent,
  ])

  useModalA11y({ open: !!openPost, onClose: handleClosePost })

  // Post modal: URL restore + browser back button
  useEffect(() => {
    const postId = searchParams.get('post')
    if (postId !== justClosedIdRef.current) {
      // URL has moved past the just-closed post — clear the guard so a
      // later back/forward navigation or shared link can re-open it.
      justClosedIdRef.current = null
    }
    if (postId && posts.length > 0 && !openPost && postId !== justClosedIdRef.current) {
      const post = posts.find((p) => p.id === postId)
      if (post) {
        handleOpenPost(post, true)
      }
    }

    if (!openPost) return

    const handlePopState = () => {
      const urlParams = new URLSearchParams(window.location.search)
      if (!urlParams.get('post') && openPost) {
        openPostIdRef.current = null
        openPostTranslationRef.current = null
        setOpenPost(null)
      }
    }

    window.addEventListener('popstate', handlePopState)

    return () => {
      window.removeEventListener('popstate', handlePopState)
    }
  }, [handleClosePost, handleOpenPost, openPost, posts, searchParams, setOpenPost])

  // Re-evaluate the open post whenever its viewer token, language, identity or
  // source content changes. Exact in-flight requests coalesce in translateContent.
  const openTranslationPostId = openPost?.id
  const openTranslationContent = openPost?.body
  useEffect(() => {
    if (openTranslationPostId && openTranslationContent && translationAccessToken) {
      const needsTranslation = needsHotTranslation(openTranslationContent, language)

      setTranslatedContent(null)
      setShowingOriginal(true)

      if (needsTranslation) {
        translateContent(openTranslationPostId, openTranslationContent, language)
      } else {
        cancelContentTranslation()
      }
    } else if (!openTranslationPostId) {
      cancelContentTranslation()
    }
  }, [
    cancelContentTranslation,
    language,
    openTranslationContent,
    openTranslationPostId,
    setShowingOriginal,
    setTranslatedContent,
    translateContent,
    translationAccessToken,
  ])

  // Submit comment
  const submitComment = useCallback(
    async (postId: string) => {
      if (!authChecked) return
      if (!accessToken) {
        useLoginModal.getState().openLoginModal()
        return
      }
      if (!newComment.trim()) return
      if (submittingCommentRef.current) return

      const operation = Symbol('hot-comment')
      const capturedScope = activeScopeRef.current
      submittingCommentRef.current = operation
      setSubmittingComment(true)
      const content = newComment.trim()
      const draftSnapshot = captureDraftSnapshot(postId)
      try {
        const response = await authedFetch<{
          success?: boolean
          error?: string | { message?: string }
          data?: { comment?: unknown }
        }>(`/api/posts/${postId}/comments`, 'POST', accessToken, { content }, 15_000, {
          expectedUserId: capturedScope.userId,
          expectedSessionGeneration: capturedScope.sessionGeneration,
        })

        if (!scopeIsCurrent(capturedScope) || response.stale) return
        const json = response.data
        const rawComment = json?.data?.comment

        if (
          response.ok &&
          json?.success === true &&
          isCreatedCommentAcknowledgement(rawComment, {
            postId,
            userId: capturedScope.userId,
          })
        ) {
          clearDraftIfUnchanged(draftSnapshot)
          if (
            !(await loadComments(postId, false, capturedScope)) &&
            scopeIsCurrent(capturedScope) &&
            openPostIdRef.current === postId
          ) {
            setComments((prev) => {
              if (prev.some((comment) => comment.id === rawComment.id)) return prev
              return [...prev, rawComment]
            })
          }
        } else if (isDefinitiveMutationRejection(response)) {
          if (response.status === 401) {
            showToast(t('sessionExpired'), 'error')
          } else if (response.status === 403) {
            showToast(t('permissionDenied'), 'error')
          } else {
            const error = json?.error
            showToast(
              (typeof error === 'object' ? error?.message : error) || t('postCommentFailed'),
              'error'
            )
          }
        } else if (!(await loadComments(postId, false, capturedScope))) {
          // Transport/408/5xx/malformed 2xx is not proof of rollback. Preserve
          // the current tree and draft when canonical truth is unavailable.
          if (scopeIsCurrent(capturedScope)) showToast(t('networkErrorRetry'), 'error')
        }
      } catch (err) {
        logger.error('[HotPage] Submit comment failed:', err)
        if (scopeIsCurrent(capturedScope) && !(await loadComments(postId, false, capturedScope))) {
          if (scopeIsCurrent(capturedScope)) showToast(t('networkErrorRetry'), 'error')
        }
      } finally {
        if (submittingCommentRef.current === operation) {
          submittingCommentRef.current = null
          if (scopeIsCurrent(capturedScope)) setSubmittingComment(false)
        }
      }
    },
    [
      accessToken,
      authChecked,
      captureDraftSnapshot,
      clearDraftIfUnchanged,
      loadComments,
      newComment,
      scopeIsCurrent,
      setComments,
      setSubmittingComment,
      showToast,
      t,
    ]
  )

  const runReactionLane = useCallback(
    async (lane: HotReactionLane): Promise<void> => {
      while (reactionRequestLanesRef.current.get(lane.key) === lane && scopeIsCurrent(lane.scope)) {
        const desired = lane.desired
        const revision = lane.revision
        const requestId = createPostReactionRequestId()
        let response: Awaited<ReturnType<typeof authedFetch<Record<string, unknown>>>> | null = null
        let transportError: unknown = null
        let acknowledgement: PostReactionAcknowledgement | null = null
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            response = await authedFetch<Record<string, unknown>>(
              `/api/posts/${lane.postId}/like`,
              'POST',
              lane.accessToken,
              {
                operation: POST_REACTION_OPERATION,
                request_id: requestId,
                desired_reaction: desired,
              },
              POST_REACTION_REQUEST_TIMEOUT_MS,
              {
                expectedUserId: lane.scope.userId,
                expectedSessionGeneration: lane.scope.sessionGeneration,
              }
            )
            transportError = null
          } catch (error) {
            response = null
            transportError = error
          }

          if (
            reactionRequestLanesRef.current.get(lane.key) !== lane ||
            !scopeIsCurrent(lane.scope)
          ) {
            return
          }
          if (response?.stale) return

          acknowledgement =
            response?.ok && response.status === 200 && lane.scope.userId
              ? readPostReactionAcknowledgement(response.data, {
                  actorId: lane.scope.userId,
                  postId: lane.postId,
                  requestId,
                  desiredReaction: desired,
                })
              : null
          if (acknowledgement || (response && isDefinitivePostReactionRejection(response.status))) {
            break
          }
          lane.confirmedTruthIsCertain = false
        }

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
                ? applyReactionAcknowledgement(post, acknowledgement, latestDesired)
                : post
            )
          )
          setOpenPost((previous) =>
            previous?.id === lane.postId
              ? applyReactionAcknowledgement(previous, acknowledgement, latestDesired)
              : previous
          )
          if (lane.revision === revision || latestDesired === desired) return
          continue
        }

        const definitiveRejection =
          response != null && isDefinitivePostReactionRejection(response.status)
        if (lane.revision !== revision) continue

        if (definitiveRejection && lane.confirmedTruthIsCertain) {
          const confirmedReaction = lane.confirmed.reaction
          markReactionStateChanged(lane.key)
          setPosts((previous) =>
            previous.map((post) =>
              post.id === lane.postId ? applyHotReactionDesired(post, confirmedReaction) : post
            )
          )
          setOpenPost((previous) =>
            previous?.id === lane.postId
              ? applyHotReactionDesired(previous, confirmedReaction)
              : previous
          )
        }

        const error = response?.data?.error
        if (response) logger.error('[HotPage] Reaction API error:', error || response.status)
        else logger.error('[HotPage] Reaction failed:', transportError)
        showToast(typeof error === 'string' ? error : t('actionFailedRetry'), 'error')
        return
      }
    },
    [markReactionStateChanged, scopeIsCurrent, setOpenPost, setPosts, showToast, t]
  )

  // Toggle reaction (like/dislike)
  const toggleReaction = useCallback(
    async (postId: string, reactionType: 'up' | 'down') => {
      if (!authChecked) return
      if (!accessToken) {
        useLoginModal.getState().openLoginModal()
        return
      }

      const capturedScope = activeScopeRef.current
      if (!capturedScope.userId) return
      const post = postsRef.current.find((candidate) => candidate.id === postId)
      if (!post) return
      const key = hotReactionKey(capturedScope, postId)
      const existingLane = reactionRequestLanesRef.current.get(key)
      if (existingLane) {
        const desired = nextPostReactionState(existingLane.desired, reactionType)
        existingLane.accessToken = accessToken
        if (existingLane.desired === desired) return existingLane.promise
        existingLane.desired = desired
        existingLane.revision += 1
        markReactionStateChanged(key)
        setPosts((previous) =>
          previous.map((candidate) =>
            candidate.id === postId ? applyHotReactionDesired(candidate, desired) : candidate
          )
        )
        setOpenPost((previous) =>
          previous?.id === postId ? applyHotReactionDesired(previous, desired) : previous
        )
        return existingLane.promise
      }

      const desired = nextPostReactionState(post.user_reaction ?? null, reactionType)
      const lane: HotReactionLane = {
        key,
        scope: capturedScope,
        postId,
        accessToken,
        desired,
        revision: 1,
        confirmed: {
          reaction: post.user_reaction ?? null,
          likeCount: post.like_count ?? post.likes,
          dislikeCount: post.dislike_count ?? post.dislikes ?? 0,
        },
        confirmedTruthIsCertain: true,
        promise: Promise.resolve(),
      }
      reactionRequestLanesRef.current.set(key, lane)
      markReactionStateChanged(key)
      setPosts((previous) =>
        previous.map((candidate) =>
          candidate.id === postId ? applyHotReactionDesired(candidate, desired) : candidate
        )
      )
      setOpenPost((previous) =>
        previous?.id === postId ? applyHotReactionDesired(previous, desired) : previous
      )
      try {
        lane.promise = runReactionLane(lane)
        await lane.promise
      } finally {
        if (reactionRequestLanesRef.current.get(key) === lane) {
          reactionRequestLanesRef.current.delete(key)
        }
      }
    },
    [accessToken, authChecked, markReactionStateChanged, runReactionLane, setOpenPost, setPosts]
  )

  return {
    // Language
    t,
    language,
    localizedName,
    email,

    // Auth
    loggedIn,
    accessToken,

    // Posts
    loadingPosts,
    postsError,
    refreshPosts: loadPosts,
    hotPosts,
    visibleHot,
    expandedPosts,
    setExpandedPosts,
    translatedListPosts,
    translatingList,
    getHotTag,
    handleOpenPost,

    // Tabs
    activeHotTab,
    setActiveHotTab,

    // Groups
    groups,
    loadingGroups,
    groupsError,
    refreshGroups: loadGroups,

    // Post detail modal
    openPost,
    comments,
    loadingComments,
    hasMoreComments,
    loadingMoreComments,
    newComment,
    setNewComment,
    submittingComment,
    translatedContent,
    showingOriginal,
    setShowingOriginal,
    translating,
    handleClosePost,
    submitComment,
    toggleReaction,
    loadMoreComments,
  }
}
