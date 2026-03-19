'use client'

import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { type PostWithUserState } from '@/lib/types'
import { useToast } from '../ui/Toast'
import { useDialog } from '../ui/Dialog'
import { DynamicBookmarkModal as BookmarkModal } from '../ui/Dynamic'
import { useUnifiedAuth } from '@/lib/hooks/useUnifiedAuth'
import { usePostStore, type PostData } from '@/lib/stores/postStore'
import { usePostComments } from './hooks/usePostComments'
import { usePostTranslation } from './hooks/usePostTranslation'
import { usePostActions } from './hooks/usePostActions'
import { SectionErrorBoundary } from '../utils/ErrorBoundary'
import { PostSkeleton } from '../ui/Skeleton'
import { SortButtons, type SortType, PostDetailView } from './components'
import { PostListItem } from './PostList'
import { EditPostModal, RepostModal } from './Modals'
import { logger } from '@/lib/logger'

type Post = PostWithUserState

interface PostFeedProps {
  variant?: 'compact' | 'full'
  layout?: 'list' | 'masonry'
  groupId?: string
  groupIds?: string[]
  authorHandle?: string
  initialPostId?: string | null
  showSortButtons?: boolean
  sortBy?: string
  limit?: number
  showRefreshButton?: boolean
  /** When provided and posts are empty, shows a "Write your first post" CTA linking here */
  createPostHref?: string
}

/** Build URLSearchParams for post queries — shared between loadPosts and loadMorePosts */
function buildPostQueryParams(
  opts: { pageSize: number; offset: number; sortBy?: string; sortType: SortType; authorHandle?: string; groupId?: string; groupIds?: string[] }
): URLSearchParams {
  const params = new URLSearchParams()
  params.set('limit', String(opts.pageSize))
  params.set('offset', String(opts.offset))
  if (opts.sortBy) params.set('sort_by', opts.sortBy)
  else if (opts.sortType === 'personalized') params.set('sort_by', 'personalized')
  else if (opts.sortType === 'likes') params.set('sort_by', 'like_count')
  else if (opts.authorHandle) params.set('sort_by', 'created_at')
  else if (opts.groupId || opts.groupIds) params.set('sort_by', 'created_at')
  else params.set('sort_by', 'hot_score')
  params.set('sort_order', 'desc')
  if (opts.groupId) params.set('group_id', opts.groupId)
  if (opts.groupIds && opts.groupIds.length > 0) params.set('group_ids', opts.groupIds.join(','))
  if (opts.authorHandle) params.set('author_handle', opts.authorHandle)
  return params
}

export default function PostFeed(props: PostFeedProps = {}): React.ReactNode {
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const { showDangerConfirm } = useDialog()
  const [posts, setPosts] = useState<Post[]>([])
  const postsRef = useRef<Post[]>([])
  // Keep ref in sync for use in loadMorePosts without adding posts to its deps (#38)
  postsRef.current = posts
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [sortType, setSortType] = useState<SortType>('time')
  const [openPost, setOpenPost] = useState<Post | null>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const [mobileViewMode, setMobileViewMode] = useState<'list' | 'masonry'>('list')

  const feedRefreshTrigger = usePostStore(s => s.feedRefreshTrigger)
  const auth = useUnifiedAuth({ onUnauthenticated: () => showToast(t('pleaseLogin'), 'warning') })
  const accessToken = auth.accessToken
  const currentUserId = auth.userId
  const abortControllerRef = useRef<AbortController | null>(null)
  const storeSetPosts = usePostStore(s => s.setPosts)
  const pageSize = props.limit || 20

  // Comments hook
  const commentsHook = usePostComments({
    accessToken, showToast, showDangerConfirm,
    onCommentCountChange: (postId, delta) => {
      setPosts(prev => prev.map(p => p.id === postId ? { ...p, comment_count: p.comment_count + delta } : p))
      if (openPost?.id === postId) setOpenPost(prev => prev ? { ...prev, comment_count: prev.comment_count + delta } : null)
    },
  })
  const { comments, setComments, loadComments } = commentsHook

  // Translation hook
  const translation = usePostTranslation({ accessToken, showToast, t })
  const { translatedListPosts, translatedContent, showingOriginal, setShowingOriginal, translating,
    isChineseText, removeImagesFromContent, translateContent, translateListPosts, translateComments,
    setTranslatedContent, translatedComments } = translation

  // Actions hook
  const actions = usePostActions({
    accessToken, currentUserId, posts, setPosts, openPost, setOpenPost, showToast, showDangerConfirm, t,
  })

  // Load posts
  const loadPosts = useCallback(async () => {
    if (abortControllerRef.current) abortControllerRef.current.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller
    try {
      setLoading(true); setError(null); setOffset(0); setHasMore(true)
      const params = buildPostQueryParams({
        pageSize, offset: 0, sortBy: props.sortBy, sortType,
        authorHandle: props.authorHandle, groupId: props.groupId, groupIds: props.groupIds,
      })
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`
      const response = await fetch(`/api/posts?${params.toString()}`, { headers, signal: controller.signal })
      if (controller.signal.aborted) return
      const data = await response.json()
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : (data.error?.message || t('fetchPostsFailed')))
      const loadedPosts = data.data?.posts || []
      setPosts(loadedPosts); setOffset(loadedPosts.length); setHasMore(data.data?.pagination?.has_more ?? loadedPosts.length >= pageSize)
      const canonicalPosts: PostData[] = loadedPosts.map((p: Post) => ({
        id: p.id, title: p.title || '', content: p.content || '', author_handle: p.author_handle || 'user',
        group_id: p.group_id, group_name: p.group_name, created_at: p.created_at,
        like_count: p.like_count || 0, dislike_count: p.dislike_count || 0, comment_count: p.comment_count || 0,
        view_count: p.view_count || 0, hot_score: p.hot_score || 0, user_reaction: p.user_reaction, author_avatar_url: p.author_avatar_url,
      }))
      storeSetPosts(canonicalPosts)
      const ibc: Record<string, number> = {}; const irc: Record<string, number> = {}
      loadedPosts.forEach((post: Post) => { ibc[post.id] = post.bookmark_count || 0; irc[post.id] = post.repost_count || 0 })
      actions.setBookmarkCounts(prev => ({ ...prev, ...ibc })); actions.setRepostCounts(prev => ({ ...prev, ...irc }))
      // Load bookmarks/reposts in parallel with initial render
      if (accessToken && loadedPosts.length > 0) {
        bookmarksLoadedRef.current = true
        actions.loadUserBookmarksAndReposts(loadedPosts.map((p: Post) => p.id))
      }
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || controller.signal.aborted)) return
      setError(err instanceof Error ? err.message : t('loadFailed'))
    } finally { if (!controller.signal.aborted) setLoading(false) }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- actions/t/showToast are stable refs; only re-create when query params or auth change
  }, [props.groupId, props.authorHandle, accessToken, sortType, pageSize, props.groupIds, props.sortBy, storeSetPosts])

  // Load more posts
  const loadMorePosts = useCallback(async () => {
    if (loadingMore || !hasMore || loading) return
    const controller = new AbortController()
    try {
      setLoadingMore(true)
      const params = buildPostQueryParams({
        pageSize, offset, sortBy: props.sortBy, sortType,
        authorHandle: props.authorHandle, groupId: props.groupId, groupIds: props.groupIds,
      })
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`
      const response = await fetch(`/api/posts?${params.toString()}`, { headers, signal: controller.signal })
      if (controller.signal.aborted) return
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || t('loadMoreFailed'))
      const morePosts = data.data?.posts || []
      const existingIds = new Set(postsRef.current.map(p => p.id))
      const newPosts = morePosts.filter((p: Post) => !existingIds.has(p.id))
      setPosts(prev => [...prev, ...newPosts]); setOffset(prev => prev + newPosts.length)
      setHasMore(data.data?.pagination?.has_more ?? morePosts.length >= pageSize)
      const nbc: Record<string, number> = {}; const nrc: Record<string, number> = {}
      newPosts.forEach((post: Post) => { nbc[post.id] = post.bookmark_count || 0; nrc[post.id] = post.repost_count || 0 })
      actions.setBookmarkCounts(prev => ({ ...prev, ...nbc })); actions.setRepostCounts(prev => ({ ...prev, ...nrc }))
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      logger.error('加载更多失败:', err)
    } finally { setLoadingMore(false) }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- actions/t are stable refs; posts read from postsRef (#38)
  }, [loadingMore, hasMore, loading, offset, pageSize, props.sortBy, sortType, props.authorHandle, props.groupId, props.groupIds, accessToken])

  useEffect(() => { return () => { if (abortControllerRef.current) abortControllerRef.current.abort() } }, [])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true); await loadPosts(); setRefreshing(false); showToast(t('refreshed'), 'success')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t is excluded; read at call time via language dep instead
  }, [loadPosts, showToast, language])

  useEffect(() => { loadPosts() }, [props.groupId, props.authorHandle, accessToken, sortType, feedRefreshTrigger]) // eslint-disable-line react-hooks/exhaustive-deps -- loadPosts is excluded to avoid circular dep; effect triggers are the meaningful query params

  useEffect(() => {
    const el = loadMoreRef.current; if (!el) return
    // #29: Increased rootMargin to 400px for earlier prefetch trigger
    const observer = new IntersectionObserver((entries) => { if (entries[0].isIntersecting && hasMore && !loadingMore && !loading) loadMorePosts() }, { threshold: 0.1, rootMargin: '400px' })
    observer.observe(el); return () => observer.disconnect()
  }, [hasMore, loadingMore, loading, loadMorePosts])

  // Bookmarks/reposts loaded in parallel with initial post load (see loadPosts).
  // This effect handles subsequent post changes (e.g. after sort change).
  const bookmarksLoadedRef = useRef(false)
  useEffect(() => {
    if (posts.length > 0 && accessToken && bookmarksLoadedRef.current) {
      actions.loadUserBookmarksAndReposts(posts.map(p => p.id))
    }
  }, [posts.length, accessToken]) // eslint-disable-line react-hooks/exhaustive-deps -- actions.loadUserBookmarksAndReposts is a stable ref; only re-run when post count or auth changes

  // Handle initialPostId
  const initialPostIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (props.initialPostId && props.initialPostId !== initialPostIdRef.current && !openPost) {
      initialPostIdRef.current = props.initialPostId
      const postToOpen = posts.find(p => p.id === props.initialPostId)
      if (postToOpen) {
        setOpenPost(postToOpen); setComments([])
        fetch(`/api/posts/${postToOpen.id}/comments`).then(res => res.json()).then(data => { if (data.success && data.data?.comments) setComments(data.data.comments) }).catch(err => console.warn('[PostFeed] fetch failed', err))
      } else {
        const loadSinglePost = async () => {
          try {
            const response = await fetch(`/api/posts/${props.initialPostId}`)
            const data = await response.json()
            if (response.ok && data.success && data.data?.post) {
              const post = data.data.post
              setOpenPost({ id: post.id, title: post.title || t('noTitle'), content: post.content || '', author_id: post.author_id, author_handle: post.author_handle || 'user', author_avatar_url: post.author_avatar_url, group_id: post.group_id, group_name: post.group_name, created_at: post.created_at, like_count: post.like_count || 0, dislike_count: post.dislike_count || 0, comment_count: post.comment_count || 0, bookmark_count: post.bookmark_count || 0, repost_count: post.repost_count || 0, view_count: post.view_count || 0, hot_score: post.hot_score || 0, is_pinned: post.is_pinned || false, poll_enabled: post.poll_enabled || false, poll_bull: post.poll_bull || 0, poll_bear: post.poll_bear || 0, poll_wait: post.poll_wait || 0, user_reaction: post.user_reaction, user_vote: post.user_vote })
              setComments([])
              fetch(`/api/posts/${props.initialPostId}/comments`).then(res => res.json()).then(data => { if (data.success && data.data?.comments) setComments(data.data.comments) }).catch(err => console.warn('[PostFeed] fetch failed', err))
            }
          } catch (err) { logger.error('Failed to load single post:', err) }
        }
        loadSinglePost()
      }
    }
  }, [props.initialPostId, posts, openPost, setComments]) // eslint-disable-line react-hooks/exhaustive-deps -- t is excluded; read at call time from closure

  // Translation effects — only for authenticated users (translate API requires auth)
  useEffect(() => {
    if (!accessToken) return
    if (posts.length > 0) translateListPosts(posts, language as 'zh' | 'en')
    if (comments.length > 0 && openPost) translateComments(comments, language === 'en' ? 'en' : 'zh')
  }, [language, posts, translateListPosts, comments, openPost, translateComments, accessToken])

  const sortedPosts = useMemo(() => {
    if (!props.authorHandle) return posts
    return [...posts].sort((a, b) => { if (a.is_pinned && !b.is_pinned) return -1; if (!a.is_pinned && b.is_pinned) return 1; return 0 })
  }, [posts, props.authorHandle])

  const handleOpenPost = useCallback((post: Post) => {
    setOpenPost(post); setComments([]); setTranslatedContent(null); loadComments(post.id)
    if (post.poll_id) actions.loadCustomPoll(post.id)
    else { actions.setSelectedPollOptions([]); }
    const contentIsChinese = post.content ? isChineseText(post.content) : false
    const titleIsChinese = post.title ? isChineseText(post.title) : false
    const needsContentTranslation = post.content && ((language === 'en' && contentIsChinese) || (language === 'zh' && !contentIsChinese))
    const needsTitleTranslation = post.title && ((language === 'en' && titleIsChinese) || (language === 'zh' && !titleIsChinese))
    const hasTranslatedTitle = !!translatedListPosts[post.id]?.title
    if (needsContentTranslation || needsTitleTranslation || hasTranslatedTitle) setShowingOriginal(false)
    else setShowingOriginal(true)
    if (accessToken && needsContentTranslation) translateContent(post.id, post.content!, language)
    if (accessToken && !hasTranslatedTitle && needsTitleTranslation) translateListPosts([post], language as 'zh' | 'en')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- actions/setters/showingOriginal excluded; only re-create when translation dependencies change
  }, [loadComments, language, isChineseText, translateContent, translatedListPosts, translateListPosts])

  if (loading) return <div className="stagger-children" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}><PostSkeleton /><PostSkeleton /><PostSkeleton /></div>

  if (error) return (
    <div style={{ padding: tokens.spacing[6], textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacing[3], background: tokens.colors.bg.secondary, borderRadius: tokens.radius.lg, border: `1px solid ${tokens.colors.border.primary}` }}>
      <div style={{ color: tokens.colors.accent.error, fontSize: tokens.typography.fontSize.sm, fontWeight: tokens.typography.fontWeight.bold }}>{t('failedToLoad')}</div>
      <div style={{ color: tokens.colors.text.tertiary, fontSize: tokens.typography.fontSize.xs }}>{error}</div>
      <button onClick={loadPosts} style={{ padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`, background: tokens.colors.accent.primary, color: tokens.colors.white, border: 'none', borderRadius: tokens.radius.md, cursor: 'pointer', fontWeight: tokens.typography.fontWeight.bold, fontSize: tokens.typography.fontSize.sm, transition: tokens.transition.base }} onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.9' }} onMouseLeave={(e) => { e.currentTarget.style.opacity = '1' }}>{t('tryAgain')}</button>
    </div>
  )

  if (posts.length === 0) return (
    <div>
      {props.showSortButtons && <SortButtons sortType={sortType} setSortType={setSortType} t={t} />}
      <div style={{ padding: tokens.spacing[8], textAlign: 'center', color: tokens.colors.text.tertiary, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacing[3] }}>
        {/* Minimal quill/pen SVG illustration */}
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none" style={{ opacity: 0.3, color: tokens.colors.text.tertiary }}>
          <path d="M30 6C30 6 32 8 32 12C32 18 26 22 20 26L14 30L16 24C20 18 24 12 30 6Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M14 30L10 34" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M20 26L16 22" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeOpacity="0.5" />
        </svg>
        <span style={{ fontWeight: 500, fontSize: tokens.typography.fontSize.sm }}>{t('noPostsYet')}</span>
        <span style={{ fontSize: tokens.typography.fontSize.xs }}>{t('beFirstToPost')}</span>
        {props.createPostHref && (
          <Link
            href={props.createPostHref}
            style={{
              marginTop: tokens.spacing[1],
              padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
              borderRadius: tokens.radius.md,
              background: `${tokens.colors.accent.primary}18`,
              border: `1px solid ${tokens.colors.accent.primary}40`,
              color: tokens.colors.accent.primary,
              textDecoration: 'none',
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: 600,
              transition: 'all 0.15s ease',
              display: 'inline-block',
            }}
          >
            {t('writeFirstPost')}
          </Link>
        )}
      </div>
    </div>
  )

  return (
    <SectionErrorBoundary>
      {props.showRefreshButton && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: tokens.spacing[2] }}>
          <button onClick={handleRefresh} disabled={refreshing} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`, borderRadius: tokens.radius.md, border: `1px solid ${tokens.colors.border.primary}`, background: tokens.colors.bg.secondary, color: tokens.colors.text.secondary, fontSize: tokens.typography.fontSize.xs, cursor: refreshing ? 'not-allowed' : 'pointer', opacity: refreshing ? 0.6 : 1, transition: 'all 0.15s ease' }} onMouseEnter={(e) => { if (!refreshing) e.currentTarget.style.background = tokens.colors.bg.tertiary }} onMouseLeave={(e) => { e.currentTarget.style.background = tokens.colors.bg.secondary }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: refreshing ? 'spin 1s linear infinite' : 'none' }}><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" /><path d="M16 21h5v-5" /></svg>
            {refreshing ? t('refreshing') : t('refresh')}
          </button>
        </div>
      )}
      {props.showSortButtons && <SortButtons sortType={sortType} setSortType={setSortType} t={t} />}
      {props.layout === 'masonry' && (
        <div className="mobile-only" style={{ display: 'none', justifyContent: 'flex-end', marginBottom: 8 }}>
          <button onClick={() => setMobileViewMode(prev => prev === 'list' ? 'masonry' : 'list')} aria-label={mobileViewMode === 'list' ? t('postSwitchToGrid') : t('postSwitchToList')} style={{ padding: '6px 12px', borderRadius: tokens.radius.md, border: `1px solid ${tokens.colors.border.primary}`, background: 'transparent', color: tokens.colors.text.secondary, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
            {mobileViewMode === 'list' ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>}
            {mobileViewMode === 'list' ? t('postGridView') : t('postListView')}
          </button>
        </div>
      )}
      <div style={props.layout === 'masonry' ? { columnGap: 12 } : undefined} className={`stagger-children${props.layout === 'masonry' ? ' post-feed-masonry' : ''} ${props.layout === 'masonry' ? `mobile-view-${mobileViewMode}` : ''}`}>
        {sortedPosts.map((p) => (
          <SectionErrorBoundary key={p.id}>
            <PostListItem post={p} isMasonry={props.layout === 'masonry'} language={language}
              currentUserId={currentUserId} translatedListPosts={translatedListPosts}
              onOpenPost={handleOpenPost} onToggleReaction={actions.toggleReaction} onTogglePin={actions.handleTogglePin}
              onStartEdit={actions.handleStartEdit} onDeletePost={actions.handleDeletePost}
              removeImagesFromContent={removeImagesFromContent} t={t} />
          </SectionErrorBoundary>
        ))}
      </div>

      {hasMore && (
        <div ref={loadMoreRef} style={{ padding: tokens.spacing[4], minHeight: 60 }}>
          {loadingMore && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
              {[1, 2].map(i => (
                <div key={i} style={{
                  background: tokens.colors.bg.secondary,
                  borderRadius: tokens.radius.lg,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  padding: tokens.spacing[4],
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: tokens.colors.bg.tertiary, animation: 'shimmer 1.5s ease-in-out infinite', backgroundImage: `linear-gradient(90deg, ${tokens.colors.bg.tertiary} 0%, var(--glass-bg-light) 50%, ${tokens.colors.bg.tertiary} 100%)`, backgroundSize: '200% 100%' }} />
                    <div style={{ width: 100, height: 14, borderRadius: 4, background: tokens.colors.bg.tertiary, animation: 'shimmer 1.5s ease-in-out infinite', backgroundImage: `linear-gradient(90deg, ${tokens.colors.bg.tertiary} 0%, var(--glass-bg-light) 50%, ${tokens.colors.bg.tertiary} 100%)`, backgroundSize: '200% 100%' }} />
                  </div>
                  <div style={{ width: '70%', height: 16, borderRadius: 4, background: tokens.colors.bg.tertiary, marginBottom: tokens.spacing[2], animation: 'shimmer 1.5s ease-in-out infinite', backgroundImage: `linear-gradient(90deg, ${tokens.colors.bg.tertiary} 0%, var(--glass-bg-light) 50%, ${tokens.colors.bg.tertiary} 100%)`, backgroundSize: '200% 100%' }} />
                  <div style={{ width: '90%', height: 12, borderRadius: 4, background: tokens.colors.bg.tertiary, animation: 'shimmer 1.5s ease-in-out infinite', backgroundImage: `linear-gradient(90deg, ${tokens.colors.bg.tertiary} 0%, var(--glass-bg-light) 50%, ${tokens.colors.bg.tertiary} 100%)`, backgroundSize: '200% 100%' }} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {!hasMore && posts.length > 0 && <div style={{ textAlign: 'center', padding: tokens.spacing[4], color: tokens.colors.text.tertiary, fontSize: tokens.typography.fontSize.sm }}>{t('noMorePosts')}</div>}

      {openPost && (
        <PostDetailView openPost={openPost} onClose={() => setOpenPost(null)} language={language}
          currentUserId={currentUserId} accessToken={accessToken}
          showingOriginal={showingOriginal} setShowingOriginal={setShowingOriginal}
          translatedContent={translatedContent} translating={translating} translatedListPosts={translatedListPosts}
          removeImagesFromContent={removeImagesFromContent}
          customPoll={actions.customPoll} loadingCustomPoll={actions.loadingCustomPoll}
          customPollUserVotes={actions.customPollUserVotes} selectedPollOptions={actions.selectedPollOptions}
          setSelectedPollOptions={actions.setSelectedPollOptions} votingCustomPoll={actions.votingCustomPoll}
          submitCustomPollVote={actions.submitCustomPollVote}
          userReaction={openPost.user_reaction} userBookmarks={actions.userBookmarks}
          bookmarkCounts={actions.bookmarkCounts} onToggleReaction={actions.toggleReaction}
          onBookmark={actions.handleBookmark} onOpenBookmarkFolder={actions.openBookmarkFolderModal}
          onRepost={(id) => actions.setShowRepostModal(id)} showToast={showToast}
          comments={comments} loadingComments={commentsHook.loadingComments}
          newComment={commentsHook.newComment} setNewComment={commentsHook.setNewComment}
          submittingComment={commentsHook.submittingComment} onSubmitComment={commentsHook.submitComment}
          replyingTo={commentsHook.replyingTo} setReplyingTo={commentsHook.setReplyingTo}
          replyContent={commentsHook.replyContent} setReplyContent={commentsHook.setReplyContent}
          submittingReply={commentsHook.submittingReply} onSubmitReply={commentsHook.submitReply}
          commentLikeLoading={commentsHook.commentLikeLoading} onToggleCommentLike={commentsHook.toggleCommentLike}
          onToggleCommentDislike={commentsHook.toggleCommentDislike}
          deletingCommentId={commentsHook.deletingCommentId} onDeleteComment={commentsHook.deleteComment}
          expandedReplies={commentsHook.expandedReplies} setExpandedReplies={commentsHook.setExpandedReplies}
          translatedComments={translatedComments} t={t} />
      )}

      {actions.editingPost && <EditPostModal title={actions.editTitle} content={actions.editContent} onTitleChange={actions.setEditTitle} onContentChange={actions.setEditContent} onSave={actions.handleSaveEdit} onCancel={() => actions.setEditingPost(null)} saving={actions.savingEdit} t={t} />}
      {actions.showRepostModal && <RepostModal postId={actions.showRepostModal} comment={actions.repostComment} onCommentChange={actions.setRepostComment} onRepost={actions.handleRepost} onCancel={() => { actions.setShowRepostModal(null); actions.setRepostComment('') }} loading={actions.repostLoading[actions.showRepostModal] || false} t={t} />}
      <BookmarkModal isOpen={actions.showBookmarkModal} onClose={() => { actions.setShowBookmarkModal(false); actions.setBookmarkingPostId(null) }} onSelect={actions.handleBookmarkToFolder} postId={actions.bookmarkingPostId || ''} />
    </SectionErrorBoundary>
  )
}
