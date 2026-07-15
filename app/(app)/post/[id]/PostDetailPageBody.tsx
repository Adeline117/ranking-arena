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

  // Single post state, seeded from the server-rendered prop (no flash).
  const [post, setPost] = useState<Post>(() => toUserStatePost(initialPost))

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

  // Comments hook (single post)
  const commentsHook = usePostComments({
    accessToken,
    currentUserId,
    authChecked: auth.authChecked,
    viewerKey: auth.viewerKey,
    sessionGeneration: auth.sessionGeneration,
    showToast,
    showDangerConfirm,
    onCommentCountChange: (postId, delta, absoluteCount) => {
      setPost((prev) =>
        prev.id === postId
          ? {
              ...prev,
              comment_count: absoluteCount ?? Math.max(0, (prev.comment_count || 0) + delta),
            }
          : prev
      )
    },
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
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true

    loadComments(initialPost.id)
    if (post.poll_id) actions.loadCustomPoll(initialPost.id)

    const headers: Record<string, string> = {}
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`
    fetch(`/api/posts/${initialPost.id}`, { headers })
      .then((res) => res.json())
      .then((data) => {
        if (data?.success && data.data?.post) {
          const p = data.data.post
          setPost((prev) => ({
            ...prev,
            like_count: p.like_count ?? prev.like_count,
            dislike_count: p.dislike_count ?? prev.dislike_count,
            comment_count: p.comment_count ?? prev.comment_count,
            bookmark_count: p.bookmark_count ?? prev.bookmark_count,
            user_reaction: p.user_reaction,
            user_vote: p.user_vote,
          }))
          if (typeof p.bookmark_count === 'number') {
            actions.setBookmarkCounts((prev) => ({ ...prev, [initialPost.id]: p.bookmark_count }))
          }
        }
      })
      .catch(() => {
        /* per-user hydration is non-critical — server-rendered body already shown */
      })

    if (accessToken) actions.loadUserBookmarksAndReposts([initialPost.id])
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount; hooks are stable refs
  }, [accessToken])

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
          comment={actions.repostComment}
          onCommentChange={actions.setRepostComment}
          onRepost={actions.handleRepost}
          onCancel={() => {
            actions.setShowRepostModal(null)
            actions.setRepostComment('')
          }}
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
