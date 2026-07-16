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
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { localizedLabel } from '@/lib/utils/format'
import { normalizePostTitle } from '@/lib/utils/post-display'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { useLoginModal } from '@/lib/hooks/useLoginModal'
import { logger } from '@/lib/logger'
import type { Post, Comment } from './types'
import { useCommentDraftPersistence } from '@/app/components/post/hooks/useCommentDraftPersistence'
import { useViewerOwnedState } from '@/lib/state/viewer-owned-state'

interface UseHotPageDataOptions {
  initialPosts?: Post[]
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
  const activeScopeRef = useRef({ viewerKey, sessionGeneration, userId: currentUserId })
  activeScopeRef.current = { viewerKey, sessionGeneration, userId: currentUserId }
  const accessTokenRef = useRef(accessToken)
  accessTokenRef.current = accessToken
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
  const [translationCache, setTranslationCache] = useViewerOwnedState<Record<string, string>>(
    {},
    () => ({}),
    scopeKey
  )
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

  // Tabbed sections state
  const [activeHotTab, setActiveHotTab] = useState<'posts' | 'groups'>('posts')

  // Groups data for the groups tab
  const [groups, setGroups] = useState<
    { id: string; name: string; name_en?: string | null; member_count: number }[]
  >([])
  const [loadingGroups, setLoadingGroups] = useState(false)

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
  const openPostIdRef = useRef<string | null>(null)
  const commentLoadGenerationRef = useRef(new Map<string, number>())
  const commentLoadMoreGenerationRef = useRef(new Map<string, number>())

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

  useEffect(() => {
    if (previousScopeKeyRef.current === scopeKey) return
    previousScopeKeyRef.current = scopeKey
    commentLoadGenerationRef.current.clear()
    commentLoadMoreGenerationRef.current.clear()
    submittingCommentRef.current = null
    setComments([])
    setCommentsOffset(0)
    setHasMoreComments(true)
    setLoadingComments(false)
    setLoadingMoreComments(false)
    setSubmittingComment(false)
    setTranslatedContent(null)
    setShowingOriginal(true)
    setTranslating(false)
    setTranslationCache({})
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
    setTranslationCache,
  ])

  // AbortController for loadPosts — prevents stale setState after unmount
  // and allows the auto-refresh interval to cancel in-flight requests on cleanup.
  const loadPostsAbortRef = useRef<AbortController | null>(null)

  // Load hot posts from cache API
  const loadPosts = useCallback(async () => {
    if (!authChecked) return
    const capturedScope = activeScopeRef.current
    // Cancel any in-flight loadPosts before starting a new one
    loadPostsAbortRef.current?.abort()
    const controller = new AbortController()
    loadPostsAbortRef.current = controller

    setLoadingPosts(true)
    try {
      const headers: Record<string, string> = {}
      if (accessTokenRef.current) {
        headers['Authorization'] = `Bearer ${accessTokenRef.current}`
      }
      const res = await fetch(`/api/posts?sort_by=hot_score&sort_order=desc&limit=30`, {
        headers,
        signal: controller.signal,
      })
      if (controller.signal.aborted || !scopeIsCurrent(capturedScope)) return
      const json = await res.json()
      if (controller.signal.aborted || !scopeIsCurrent(capturedScope)) return
      const data = json.posts || json.data?.posts || []

      if (data.length > 0) {
        const postsData: Post[] = data.map((post: Record<string, unknown>) => {
          const createdAt = new Date(post.created_at as string)
          const diffMs = Date.now() - createdAt.getTime()
          const timeStr = formatTimeAgo(post.created_at as string, language)
          // Default ("General") category has no real group row. Feed the
          // UI-localized default into BOTH slots so localizedLabel() renders a
          // localized badge for ja/ko instead of the English "General"
          // (localizedLabel prefers the en slot for any non-zh language, and
          // there is no ja/ko group data — but the default IS localizable via t()).
          const rawGroupName = post.group_name as string | undefined
          const groupName = rawGroupName || t('generalDiscussion')
          const groupNameEn = rawGroupName
            ? (post.group_name_en as string) || t('generalDiscussionEn')
            : t('generalDiscussion')

          const hotScore =
            (post.hot_score as number) ||
            (() => {
              const hours = diffMs / 3600000
              return (
                ((post.like_count as number) || 0) * 3 +
                ((post.comment_count as number) || 0) * 5 +
                ((post.view_count as number) || 0) * 0.1 -
                Math.log(hours + 2) * 2
              )
            })()

          return {
            id: post.id as string,
            group: groupName,
            group_en: groupNameEn,
            group_id: (post.group_id as string) || undefined,
            // Keep parity with the server mapper (page.tsx): empty/placeholder
            // titles stay '' in data; render points decide the fallback.
            title: normalizePostTitle(post.title as string),
            author: (post.author_handle as string) || 'user',
            author_handle: post.author_handle as string,
            time: timeStr,
            body: (post.content as string) || '',
            comments: (post.comment_count as number) || 0,
            likes: (post.like_count as number) || 0,
            dislikes: (post.dislike_count as number) || 0,
            hotScore,
            views: (post.view_count as number) || 0,
            created_at: post.created_at as string,
            user_reaction: (post.user_reaction as 'up' | 'down' | null) || null,
          }
        })
        setPosts(postsData)
        if (postsData.length > 0 && postsData[0].created_at) {
          latestPostTime.current = postsData[0].created_at
        }
      } else {
        setPosts([])
      }
    } catch (e) {
      // Swallow aborts (unmount/navigation) — not real errors
      if (e instanceof Error && (e.name === 'AbortError' || controller.signal.aborted)) return
      if (!scopeIsCurrent(capturedScope)) return
      logger.error('Failed to load posts:', e)
      showToast(t('loadHotPostsFailed'), 'error')
    } finally {
      if (!controller.signal.aborted && scopeIsCurrent(capturedScope)) setLoadingPosts(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable ref t excluded to avoid re-creating callback
  }, [authChecked, language, scopeIsCurrent, sessionGeneration, showToast, viewerKey])

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

  // Load groups when groups tab is active
  useEffect(() => {
    if (activeHotTab !== 'groups') return
    const loadGroups = async () => {
      setLoadingGroups(true)
      try {
        const res = await fetch('/api/groups?sort_by=activity&limit=30')
        const json = await res.json()
        const data = json.data?.groups || json.groups || json.data || []
        setGroups(
          data.map((g: Record<string, unknown>) => ({
            id: (g.id as string) || '',
            name: (g.name as string) || '',
            name_en: (g.name_en as string | null) || null,
            member_count: (g.member_count as number) || 0,
          }))
        )
      } catch (error) {
        // Ignore navigation-interrupted fetches (route change aborts the in-flight
        // request → AbortError or "TypeError: Failed to fetch"). These are not real
        // errors and were spamming the console during normal navigation.
        const msg = error instanceof Error ? error.message : ''
        const interrupted =
          (error instanceof DOMException && error.name === 'AbortError') ||
          /Failed to fetch|aborted/i.test(msg)
        if (!interrupted) logger.error('Groups load error:', error)
        setGroups([])
      } finally {
        setLoadingGroups(false)
      }
    }
    loadGroups()
  }, [activeHotTab])

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

  // Detect Chinese text
  const isChineseText = useCallback((text: string) => {
    if (!text) return false
    const chineseRegex = /[\u4e00-\u9fa5]/g
    const chineseMatches = text.match(chineseRegex)
    const chineseRatio = chineseMatches ? chineseMatches.length / text.length : 0
    return chineseRatio > 0.1
  }, [])

  // Batch translate list posts
  const translateListPosts = useCallback(
    async (postsToTranslate: Post[], targetLang: 'zh' | 'en' | 'ja' | 'ko') => {
      if (translatingList) return
      // /api/translate requires auth (Bearer header) — skip for anonymous visitors
      if (!accessToken) return
      const capturedScope = activeScopeRef.current

      const needsTranslation = postsToTranslate.filter((p) => {
        if (translatedListPosts[p.id]?.title && translatedListPosts[p.id]?.body) return false
        if (!p.title && !p.body) return false
        // ja/ko targets: sources are a mix of zh and en, translate anything with text.
        if (targetLang === 'ja' || targetLang === 'ko') return true
        const titleIsChinese = isChineseText(p.title || '')
        const bodyIsChinese = isChineseText(p.body || '')
        return targetLang === 'en'
          ? titleIsChinese || bodyIsChinese
          : !titleIsChinese || !bodyIsChinese
      })

      if (needsTranslation.length === 0) return

      setTranslatingList(true)

      try {
        const items: Array<{
          id: string
          text: string
          contentType: 'post_title' | 'post_content'
          contentId: string
        }> = []

        needsTranslation.slice(0, 10).forEach((post) => {
          if (post.title && !translatedListPosts[post.id]?.title) {
            items.push({
              id: `${post.id}_title`,
              text: post.title,
              contentType: 'post_title',
              contentId: post.id,
            })
          }
          if (post.body && !translatedListPosts[post.id]?.body) {
            items.push({
              id: `${post.id}_body`,
              text: post.body.slice(0, 500),
              contentType: 'post_content',
              contentId: post.id,
            })
          }
        })

        if (items.length === 0) return

        const response = await fetch('/api/translate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ items, targetLang }),
        })
        const data = await response.json()

        if (
          response.ok &&
          data.success &&
          data.data?.results &&
          scopeIsCurrent(capturedScope) &&
          activeLanguageRef.current === targetLang
        ) {
          const results = data.data.results as Record<
            string,
            { translatedText: string; cached: boolean }
          >

          setTranslatedListPosts((prev) => {
            const updated = { ...prev }
            for (const [id, result] of Object.entries(results)) {
              const [postId, type] = id.split('_')
              if (!updated[postId]) {
                updated[postId] = {}
              }
              if (type === 'title') {
                updated[postId].title = result.translatedText
              } else if (type === 'body') {
                updated[postId].body = result.translatedText
              }
            }
            return updated
          })
        }
      } catch {
        // Translation failed, silent
      } finally {
        if (scopeIsCurrent(capturedScope) && activeLanguageRef.current === targetLang) {
          setTranslatingList(false)
        }
      }
    },
    [
      accessToken,
      isChineseText,
      scopeIsCurrent,
      setTranslatedListPosts,
      setTranslatingList,
      translatedListPosts,
      translatingList,
    ]
  )

  // Clear the id-keyed title/body cache when language changes so posts
  // re-translate for the new language instead of showing the previous one.
  const hotLangMountRef = useRef(true)
  useEffect(() => {
    if (hotLangMountRef.current) {
      hotLangMountRef.current = false
      return
    }
    setTranslatedListPosts({})
  }, [language, setTranslatedListPosts])

  // Translate list when posts load or language changes (requires auth — translation uses OpenAI credits)
  useEffect(() => {
    if (posts.length > 0 && email) {
      // Translate posts into the active UI language (zh/en/ja/ko).
      translateListPosts(posts, language)
    }
  }, [posts, language, translateListPosts, email])

  // Translate post content (with cache)
  const translateContent = useCallback(
    async (postId: string, content: string, targetLang: 'zh' | 'en' | 'ja' | 'ko') => {
      // /api/translate requires auth (Bearer header) — skip silently for anonymous visitors
      if (!email || !accessToken) return
      const capturedScope = activeScopeRef.current
      const cacheKey = `${postId}-content-${targetLang}`

      if (translationCache[cacheKey]) {
        if (
          scopeIsCurrent(capturedScope) &&
          activeLanguageRef.current === targetLang &&
          openPostIdRef.current === postId
        ) {
          setTranslatedContent(translationCache[cacheKey])
          setShowingOriginal(false)
        }
        return
      }

      setTranslating(true)
      try {
        const response = await fetch('/api/translate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({
            text: content,
            targetLang,
            contentType: 'post_content',
            contentId: postId,
          }),
        })
        const data = await response.json()

        if (
          response.ok &&
          data.success &&
          data.data?.translatedText &&
          scopeIsCurrent(capturedScope) &&
          activeLanguageRef.current === targetLang &&
          openPostIdRef.current === postId
        ) {
          const translated = data.data.translatedText
          setTranslatedContent(translated)
          setShowingOriginal(false)
          setTranslationCache((prev) => ({ ...prev, [cacheKey]: translated }))
        } else if (scopeIsCurrent(capturedScope) && activeLanguageRef.current === targetLang) {
          showToast(data.error || t('translationFailed'), 'error')
        }
      } catch {
        if (scopeIsCurrent(capturedScope) && activeLanguageRef.current === targetLang) {
          showToast(t('translationServiceError'), 'error')
        }
      } finally {
        if (
          scopeIsCurrent(capturedScope) &&
          activeLanguageRef.current === targetLang &&
          openPostIdRef.current === postId
        ) {
          setTranslating(false)
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [translationCache, showToast, email, accessToken, scopeIsCurrent]
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
        const isChinese = isChineseText(post.body)
        // zh → translate non-Chinese posts; en → translate Chinese posts;
        // ja/ko → translate anything (sources are a zh/en mix).
        const needsTranslation =
          language === 'zh' ? !isChinese : language === 'en' ? isChinese : true

        if (needsTranslation) {
          translateContent(post.id, post.body, language)
        }
      }
    },
    [
      isChineseText,
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
    setOpenPost(null)
    openedViaNav.current = false
    const params = new URLSearchParams(searchParams.toString())
    params.delete('post')
    const newUrl = params.toString() ? `/hot?${params.toString()}` : '/hot'
    router.replace(newUrl, { scroll: false })
  }, [router, searchParams, setOpenPost])

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
        setOpenPost(null)
      }
    }

    window.addEventListener('popstate', handlePopState)

    return () => {
      window.removeEventListener('popstate', handlePopState)
    }
  }, [handleClosePost, handleOpenPost, openPost, posts, searchParams, setOpenPost])

  // Re-translate when language changes
  useEffect(() => {
    if (openPost && openPost.body) {
      const isChinese = isChineseText(openPost.body)
      const needsTranslation = language === 'zh' ? !isChinese : language === 'en' ? isChinese : true

      setTranslatedContent(null)
      setShowingOriginal(true)

      if (needsTranslation) {
        translateContent(openPost.id, openPost.body, language)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-translate when language changes; openPost and translateContent are stable refs
  }, [language])

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

  // Toggle reaction (like/dislike)
  const toggleReaction = useCallback(
    async (postId: string, reactionType: 'up' | 'down') => {
      if (!authChecked) return
      if (!accessToken) {
        useLoginModal.getState().openLoginModal()
        return
      }

      const capturedScope = activeScopeRef.current
      try {
        const response = await authedFetch<{
          success?: boolean
          error?: string
          data?: { like_count: number; dislike_count: number; reaction: 'up' | 'down' | null }
        }>(
          `/api/posts/${postId}/like`,
          'POST',
          accessToken,
          { reaction_type: reactionType },
          15_000,
          {
            expectedUserId: capturedScope.userId,
            expectedSessionGeneration: capturedScope.sessionGeneration,
          }
        )
        if (!scopeIsCurrent(capturedScope) || response.stale) return
        const json = response.data
        if (response.ok && json?.success && json.data) {
          const result = json.data
          setPosts((prev) =>
            prev.map((p) => {
              if (p.id === postId) {
                return {
                  ...p,
                  likes: result.like_count,
                  dislikes: result.dislike_count,
                  user_reaction: result.reaction,
                }
              }
              return p
            })
          )
          if (openPost?.id === postId) {
            setOpenPost((prev) =>
              prev
                ? {
                    ...prev,
                    likes: result.like_count,
                    dislikes: result.dislike_count,
                    user_reaction: result.reaction,
                  }
                : null
            )
          }
        } else {
          logger.error('[HotPage] Reaction API error:', json?.error || response.status)
          showToast(t('actionFailedRetry'), 'error')
        }
      } catch (err) {
        if (!scopeIsCurrent(capturedScope)) return
        logger.error('[HotPage] Reaction failed:', err)
        showToast(t('actionFailedRetry'), 'error')
      }
    },
    [accessToken, authChecked, openPost?.id, scopeIsCurrent, setOpenPost, setPosts, showToast, t]
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
    hotPosts,
    visibleHot,
    expandedPosts,
    setExpandedPosts,
    translatedListPosts,
    getHotTag,
    handleOpenPost,

    // Tabs
    activeHotTab,
    setActiveHotTab,

    // Groups
    groups,
    loadingGroups,

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
