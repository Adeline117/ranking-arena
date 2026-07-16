'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import ShareButton from '@/app/components/common/ShareButton'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { useDialog } from '@/app/components/ui/Dialog'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { usePostComments } from '@/app/components/post/hooks/usePostComments'
import { usePostActions } from '@/app/components/post/hooks/usePostActions'
import { usePostTranslation } from '@/app/components/post/hooks/usePostTranslation'
import { PostDetailView } from '@/app/components/post/components'
import { RepostModal } from '@/app/components/post/Modals'
import { DynamicBookmarkModal as BookmarkModal } from '@/app/components/ui/Dynamic'
import { trackInteraction } from '@/lib/tracking'
import type { PostWithAuthor } from '@/lib/data/posts'
import type { PostWithUserState } from '@/lib/types/post'
import { authedFetch } from '@/lib/api/client'

type Post = PostWithUserState

/**
 * Bridge the data-layer PostWithAuthor (getPostById) into the UI PostWithUserState
 * the feed components expect. The two `original_post` shapes differ (the data layer
 * allows null title/content/handle), so coalesce those, and seed empty viewer state.
 */
function toUserStatePost(p: PostWithAuthor): Post {
  return {
    ...p,
    original_post: p.original_post
      ? {
          id: p.original_post.id,
          title: p.original_post.title ?? '',
          content: p.original_post.content ?? '',
          author_handle: p.original_post.author_handle ?? '',
          author_avatar_url: p.original_post.author_avatar_url ?? null,
          images: p.original_post.images ?? null,
          created_at: p.original_post.created_at,
        }
      : null,
    user_reaction: null,
    user_vote: null,
  }
}

/**
 * Client island for the /post/[id] detail page.
 *
 * Receives the server-fetched post (PostWithAuthor) and renders the SAME
 * single-post UI used in the feed via <PostDetailView asPage>, but inline
 * (no modal, no global feed query). Initial render is seeded from the server
 * prop so there is no refetch flash; per-user state (reaction/vote/bookmark)
 * and comments hydrate client-side after mount.
 */
export default function PostDetailPageBody({ post: initialPost }: { post: PostWithAuthor }) {
  const router = useRouter()
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const { showDangerConfirm } = useDialog()
  const auth = useAuthSession()
  const accessToken = auth.accessToken
  const currentUserId = auth.userId
  const scopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}`
  const authScopeRef = useRef({
    viewerKey: auth.viewerKey,
    sessionGeneration: auth.sessionGeneration,
  })
  authScopeRef.current = {
    viewerKey: auth.viewerKey,
    sessionGeneration: auth.sessionGeneration,
  }

  // Single post state, seeded from the server-rendered prop (no flash).
  const [postState, setPostState] = useState<Post>(() => toUserStatePost(initialPost))
  const postOwnerScopeKeyRef = useRef<string | null>(null)
  const postFieldRevisionRef = useRef({
    like: 0,
    comment: 0,
    bookmark: 0,
    vote: 0,
  })
  const post =
    postOwnerScopeKeyRef.current === null || postOwnerScopeKeyRef.current === scopeKey
      ? postState
      : { ...postState, user_reaction: null, user_vote: null }
  const setPost = useCallback<React.Dispatch<React.SetStateAction<Post>>>((action) => {
    setPostState((previous) => {
      const current = authScopeRef.current
      const ownerScopeKey = `${current.viewerKey}\u0000${current.sessionGeneration}`
      const ownedPrevious =
        postOwnerScopeKeyRef.current === null || postOwnerScopeKeyRef.current === ownerScopeKey
          ? previous
          : { ...previous, user_reaction: null, user_vote: null }
      const next = typeof action === 'function' ? action(ownedPrevious) : action
      if (
        next.like_count !== ownedPrevious.like_count ||
        next.dislike_count !== ownedPrevious.dislike_count ||
        next.user_reaction !== ownedPrevious.user_reaction
      ) {
        postFieldRevisionRef.current.like += 1
      }
      if (next.comment_count !== ownedPrevious.comment_count) {
        postFieldRevisionRef.current.comment += 1
      }
      if (next.bookmark_count !== ownedPrevious.bookmark_count) {
        postFieldRevisionRef.current.bookmark += 1
      }
      if (next.user_vote !== ownedPrevious.user_vote) {
        postFieldRevisionRef.current.vote += 1
      }
      postOwnerScopeKeyRef.current = ownerScopeKey
      return next
    })
  }, [])

  // View-count tracking (client-side; do NOT rely on a server increment under ISR).
  useEffect(() => {
    trackInteraction({ action: 'view', target_type: 'post', target_id: initialPost.id })
  }, [initialPost.id])

  // Adapters so the feed hooks (which operate on arrays + an "open" post) drive
  // our single post. setPosts maps over a one-element array; setOpenPost routes
  // a null (delete) to navigation.
  const setPosts = useCallback<React.Dispatch<React.SetStateAction<Post[]>>>((action) => {
    setPost((prev) => {
      const next = typeof action === 'function' ? (action as (p: Post[]) => Post[])([prev]) : action
      return next[0] ?? prev
    })
  }, [])

  const setOpenPost = useCallback(
    (v: Post | null) => {
      if (v === null) {
        router.push('/hot')
        return
      }
      setPost(v)
    },
    [router]
  )

  const handleCommentCountChange = useCallback(
    (postId: string, delta: number, absoluteCount?: number) => {
      setPost((prev) =>
        prev.id === postId
          ? {
              ...prev,
              comment_count: absoluteCount ?? Math.max(0, (prev.comment_count || 0) + delta),
            }
          : prev
      )
    },
    [setPost]
  )

  // Comments hook (single post)
  const commentsHook = usePostComments({
    accessToken,
    currentUserId,
    authChecked: auth.authChecked,
    viewerKey: auth.viewerKey,
    sessionGeneration: auth.sessionGeneration,
    showToast,
    showDangerConfirm,
    onCommentCountChange: handleCommentCountChange,
    t,
  })
  const { comments, loadComments } = commentsHook

  // Translation hook (single post)
  const translation = usePostTranslation({ accessToken, showToast, t })
  const {
    translatedListPosts,
    translatedContent,
    showingOriginal,
    setShowingOriginal,
    translating,
    removeImagesFromContent,
    translatedComments,
  } = translation

  // Actions hook (single post)
  const actions = usePostActions({
    accessToken,
    currentUserId,
    viewerKey: auth.viewerKey,
    sessionGeneration: auth.sessionGeneration,
    posts: [post],
    setPosts,
    openPost: post,
    setOpenPost,
    openPostAliasesPosts: true,
    showToast,
    showDangerConfirm,
    t,
  })

  // Hydrate per-user reaction/vote (server prop is fetched with admin client and
  // has no viewer state), comments, bookmarks, and any custom poll — after mount.
  const hydratedScopeKeyRef = useRef<string | null>(null)
  const hydrationGenerationRef = useRef(0)
  useEffect(() => {
    if (!auth.authChecked) return
    const scopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}`
    if (hydratedScopeKeyRef.current === scopeKey) return
    hydratedScopeKeyRef.current = scopeKey
    const generation = ++hydrationGenerationRef.current
    const hydrationRevision = { ...postFieldRevisionRef.current }

    loadComments(initialPost.id)
    if (post.poll_id) actions.loadCustomPoll(initialPost.id)

    authedFetch<{ success?: boolean; data?: { post?: Post } }>(
      `/api/posts/${initialPost.id}`,
      'GET',
      accessToken,
      undefined,
      15_000,
      {
        expectedUserId: currentUserId,
        expectedSessionGeneration: auth.sessionGeneration,
      }
    )
      .then((result) => {
        const currentScope = authScopeRef.current
        if (
          !result.ok ||
          result.stale ||
          generation !== hydrationGenerationRef.current ||
          currentScope.viewerKey !== auth.viewerKey ||
          currentScope.sessionGeneration !== auth.sessionGeneration
        ) {
          return
        }
        const data = result.data
        if (data?.success && data.data?.post) {
          const p = data.data.post
          const applyBookmarkHydration =
            postFieldRevisionRef.current.bookmark === hydrationRevision.bookmark
          setPost((prev) => ({
            ...prev,
            ...(postFieldRevisionRef.current.like === hydrationRevision.like
              ? {
                  like_count: p.like_count ?? prev.like_count,
                  dislike_count: p.dislike_count ?? prev.dislike_count,
                  user_reaction: p.user_reaction,
                }
              : {}),
            ...(postFieldRevisionRef.current.comment === hydrationRevision.comment
              ? { comment_count: p.comment_count ?? prev.comment_count }
              : {}),
            ...(postFieldRevisionRef.current.bookmark === hydrationRevision.bookmark
              ? { bookmark_count: p.bookmark_count ?? prev.bookmark_count }
              : {}),
            ...(postFieldRevisionRef.current.vote === hydrationRevision.vote
              ? { user_vote: p.user_vote }
              : {}),
          }))
          if (applyBookmarkHydration && typeof p.bookmark_count === 'number') {
            actions.setBookmarkCounts((prev) => ({ ...prev, [initialPost.id]: p.bookmark_count }))
          }
        }
      })
      .catch(() => {
        /* per-user hydration is non-critical — server-rendered body already shown */
      })

    if (accessToken) actions.loadUserBookmarksAndReposts([initialPost.id])
    // Same-principal token refresh intentionally keeps this scope key stable;
    // authedFetch can safely refresh/retry without clearing hydrated state.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- actions/hooks are stable adapters
  }, [auth.authChecked, auth.sessionGeneration, auth.viewerKey, initialPost.id])

  return (
    <div
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <div style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: tokens.spacing[3],
          }}
        >
          <Breadcrumb
            items={[
              { label: t('hotBreadcrumb'), href: '/hot' },
              { label: post.title?.slice(0, 30) || '...' },
            ]}
          />
          <ShareButton
            data={{
              type: 'post',
              url: typeof window !== 'undefined' ? window.location.href : '',
              title: post.title,
            }}
          />
        </div>

        <Link
          href="/hot"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: tokens.typography.fontSize.sm,
            color: tokens.colors.text.tertiary,
            textDecoration: 'none',
            marginBottom: tokens.spacing[4],
          }}
        >
          &larr; {t('back')}
        </Link>

        <PostDetailView
          asPage
          openPost={post}
          onClose={() => router.push('/hot')}
          language={language}
          currentUserId={currentUserId}
          accessToken={accessToken}
          showingOriginal={showingOriginal}
          setShowingOriginal={setShowingOriginal}
          translatedContent={translatedContent}
          translating={translating}
          translatedListPosts={translatedListPosts}
          removeImagesFromContent={removeImagesFromContent}
          customPoll={actions.customPoll}
          loadingCustomPoll={actions.loadingCustomPoll}
          customPollUserVotes={actions.customPollUserVotes}
          selectedPollOptions={actions.selectedPollOptions}
          setSelectedPollOptions={actions.setSelectedPollOptions}
          votingCustomPoll={actions.votingCustomPoll}
          submitCustomPollVote={actions.submitCustomPollVote}
          userReaction={post.user_reaction}
          userBookmarks={actions.userBookmarks}
          bookmarkCounts={actions.bookmarkCounts}
          onToggleReaction={actions.toggleReaction}
          onBookmark={actions.handleBookmark}
          onOpenBookmarkFolder={actions.openBookmarkFolderModal}
          onRepost={(id) => actions.openRepostModal(id)}
          showToast={showToast}
          comments={comments}
          loadingComments={commentsHook.loadingComments}
          newComment={commentsHook.newComment}
          setNewComment={commentsHook.setNewComment}
          submittingComment={commentsHook.submittingComment}
          onSubmitComment={commentsHook.submitComment}
          replyingTo={commentsHook.replyingTo}
          setReplyingTo={commentsHook.setReplyingTo}
          replyContent={commentsHook.replyContent}
          setReplyContent={commentsHook.setReplyContent}
          submittingReply={commentsHook.submittingReply}
          onSubmitReply={commentsHook.submitReply}
          commentLikeLoading={commentsHook.commentLikeLoading}
          onToggleCommentLike={commentsHook.toggleCommentLike}
          onToggleCommentDislike={commentsHook.toggleCommentDislike}
          deletingCommentId={commentsHook.deletingCommentId}
          onDeleteComment={commentsHook.deleteComment}
          editingComment={commentsHook.editingComment}
          editContent={commentsHook.editContent}
          setEditContent={commentsHook.setEditContent}
          submittingEdit={commentsHook.submittingEdit}
          onStartEdit={commentsHook.startEditComment}
          onCancelEdit={commentsHook.cancelEditComment}
          onSubmitEdit={commentsHook.submitEditComment}
          expandedReplies={commentsHook.expandedReplies}
          setExpandedReplies={commentsHook.setExpandedReplies}
          translatedComments={translatedComments}
          t={t}
        />
      </div>

      {actions.showRepostModal && (
        <RepostModal
          postId={actions.showRepostModal}
          onRepost={actions.handleRepost}
          onCancel={() => actions.setShowRepostModal(null)}
          loading={actions.repostLoading[actions.showRepostModal] || false}
          t={t}
        />
      )}
      <BookmarkModal
        isOpen={actions.showBookmarkModal}
        onClose={() => {
          actions.setShowBookmarkModal(false)
          actions.setBookmarkingPostId(null)
        }}
        onSelect={actions.handleBookmarkToFolder}
        postId={actions.bookmarkingPostId || ''}
      />
    </div>
  )
}
