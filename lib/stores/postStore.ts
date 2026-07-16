'use client'

/**
 * Unified Post Store - Canonical data store for posts and comments
 *
 * PRINCIPLES:
 * 1. Single cache key per entity: post:{id}, comments:{postId}
 * 2. All entry points (hot, groups, direct URL) read/write the same store
 * 3. Write operations update store with SERVER response data only
 * 4. No optimistic updates that can't be reconciled with server state
 * 5. Comment ordering is explicitly: created_at ASC (oldest first)
 */

import { create } from 'zustand'
import { getCsrfHeaders } from '@/lib/api/client'
import {
  fetchPostCommentsPage,
  isCreatedCommentAcknowledgement,
  isDefinitiveMutationRejection,
} from '@/lib/api/comments-client'
import { logger } from '@/lib/logger'

export type PostData = {
  id: string
  title: string
  content: string
  author_handle: string
  group_id?: string
  group_name?: string
  created_at: string
  like_count: number
  dislike_count: number
  comment_count: number
  view_count: number
  hot_score: number
  user_reaction?: 'up' | 'down' | null
  author_avatar_url?: string
}

export type CommentData = {
  id: string
  post_id?: string
  content: string
  user_id?: string
  author_handle: string
  author_avatar_url?: string
  created_at: string
  updated_at?: string
  like_count?: number
  dislike_count?: number
  user_liked?: boolean
  user_disliked?: boolean
  parent_id?: string | null
  replies?: CommentData[]
}

type CommentsPagination = {
  offset: number
  hasMore: boolean
  loading: boolean
  loadingMore: boolean
}

type PostStoreState = {
  /** Canonical post cache: postId → PostData */
  posts: Record<string, PostData>
  /** Canonical comment cache: postId → CommentData[] */
  comments: Record<string, CommentData[]>
  /** Comment pagination state per post */
  commentsPagination: Record<string, CommentsPagination>
  /** Feed refresh trigger - increment to signal feeds to refresh */
  feedRefreshTrigger: number
}

type PostStoreActions = {
  /** Update a single post in the cache (merge with existing) */
  setPost: (post: PostData) => void
  /** Update multiple posts in the cache */
  setPosts: (posts: PostData[]) => void
  /** Update post reaction from server response */
  updatePostReaction: (
    postId: string,
    data: {
      like_count: number
      dislike_count: number
      reaction: 'up' | 'down' | null
    }
  ) => void
  /** Replace comment count with a server-confirmed absolute value */
  updatePostCommentCount: (postId: string, commentCount: number) => void
  /** Set comments for a post (replaces existing) */
  setComments: (postId: string, comments: CommentData[]) => void
  /** Append comments (for pagination) */
  appendComments: (postId: string, comments: CommentData[]) => void
  /** Add a single comment (after server ACK) */
  addComment: (postId: string, comment: CommentData) => void
  /** Update pagination state */
  setCommentsPagination: (postId: string, pagination: Partial<CommentsPagination>) => void
  /** Trigger feed refresh - increments counter to signal feeds to reload */
  triggerFeedRefresh: () => void
  /** Clear all cached data */
  clear: () => void
}

// LRU cache limits to prevent unbounded memory growth in long sessions
const MAX_CACHED_POSTS = 200
const MAX_CACHED_COMMENT_SETS = 50

/** Evict oldest entries from a record to stay under maxSize */
function evictOldest<T>(record: Record<string, T>, maxSize: number): Record<string, T> {
  const keys = Object.keys(record)
  if (keys.length <= maxSize) return record
  // Keep the most recent entries (last N keys — insertion order is preserved)
  const keysToKeep = keys.slice(-maxSize)
  const result: Record<string, T> = {}
  for (const key of keysToKeep) {
    result[key] = record[key]
  }
  return result
}

export const usePostStore = create<PostStoreState & PostStoreActions>((set) => ({
  posts: {},
  comments: {},
  commentsPagination: {},
  feedRefreshTrigger: 0,

  setPost: (post) =>
    set((state) => ({
      posts: evictOldest({ ...state.posts, [post.id]: post }, MAX_CACHED_POSTS),
    })),

  setPosts: (posts) =>
    set((state) => {
      const updated = { ...state.posts }
      for (const post of posts) {
        updated[post.id] = post
      }
      return { posts: evictOldest(updated, MAX_CACHED_POSTS) }
    }),

  updatePostReaction: (postId, data) =>
    set((state) => {
      const existing = state.posts[postId]
      if (!existing) return state
      return {
        posts: {
          ...state.posts,
          [postId]: {
            ...existing,
            like_count: data.like_count,
            dislike_count: data.dislike_count,
            user_reaction: data.reaction,
          },
        },
      }
    }),

  updatePostCommentCount: (postId, commentCount) =>
    set((state) => {
      const existing = state.posts[postId]
      if (
        !existing ||
        !Number.isSafeInteger(commentCount) ||
        commentCount < 0 ||
        existing.comment_count === commentCount
      ) {
        return state
      }

      return {
        posts: {
          ...state.posts,
          [postId]: { ...existing, comment_count: commentCount },
        },
      }
    }),

  setComments: (postId, comments) =>
    set((state) => ({
      comments: evictOldest({ ...state.comments, [postId]: comments }, MAX_CACHED_COMMENT_SETS),
    })),

  appendComments: (postId, newComments) =>
    set((state) => {
      const existing = state.comments[postId] || []
      // Deduplicate by ID
      const existingIds = new Set(existing.map((c) => c.id))
      const unique = newComments.filter((c) => !existingIds.has(c.id))
      return {
        comments: evictOldest(
          { ...state.comments, [postId]: [...existing, ...unique] },
          MAX_CACHED_COMMENT_SETS
        ),
      }
    }),

  addComment: (postId, comment) =>
    set((state) => {
      const existing = state.comments[postId] || []
      // Avoid duplicates
      if (existing.some((c) => c.id === comment.id)) return state
      return {
        comments: { ...state.comments, [postId]: [...existing, comment] },
      }
    }),

  setCommentsPagination: (postId, pagination) =>
    set((state) => ({
      commentsPagination: {
        ...state.commentsPagination,
        [postId]: { ...getDefaultPagination(), ...state.commentsPagination[postId], ...pagination },
      },
    })),

  triggerFeedRefresh: () =>
    set((state) => ({
      feedRefreshTrigger: state.feedRefreshTrigger + 1,
    })),

  clear: () => set({ posts: {}, comments: {}, commentsPagination: {}, feedRefreshTrigger: 0 }),
}))

function getDefaultPagination(): CommentsPagination {
  return { offset: 0, hasMore: true, loading: false, loadingMore: false }
}

const COMMENTS_PER_PAGE = 10

/**
 * Load comments for a post. Resets pagination.
 */
export async function loadPostComments(
  postId: string,
  accessToken: string | null = null
): Promise<void> {
  const store = usePostStore.getState()
  store.setCommentsPagination(postId, { loading: true, offset: 0, hasMore: true })

  try {
    const page = await fetchPostCommentsPage<CommentData>(postId, accessToken, {
      limit: COMMENTS_PER_PAGE,
      offset: 0,
    })

    if (page.ok) {
      store.setComments(postId, page.comments)
      store.updatePostCommentCount(postId, page.commentCount)
      store.setCommentsPagination(postId, {
        loading: false,
        offset: page.comments.length,
        hasMore: page.hasMore,
      })
    } else {
      store.setCommentsPagination(postId, { loading: false })
    }
  } catch (err) {
    logger.error('[postStore] loadPostComments failed:', err)
    store.setCommentsPagination(postId, { loading: false })
  }
}

/**
 * Load more comments (pagination).
 */
export async function loadMorePostComments(
  postId: string,
  accessToken: string | null = null
): Promise<void> {
  const store = usePostStore.getState()
  const pagination = store.commentsPagination[postId]
  if (!pagination || pagination.loadingMore || !pagination.hasMore) return

  store.setCommentsPagination(postId, { loadingMore: true })

  try {
    const page = await fetchPostCommentsPage<CommentData>(postId, accessToken, {
      limit: COMMENTS_PER_PAGE,
      offset: pagination.offset,
    })

    if (page.ok) {
      store.appendComments(postId, page.comments)
      store.updatePostCommentCount(postId, page.commentCount)
      store.setCommentsPagination(postId, {
        loadingMore: false,
        offset: pagination.offset + page.comments.length,
        hasMore: page.hasMore,
      })
    } else {
      store.setCommentsPagination(postId, { loadingMore: false })
    }
  } catch (err) {
    logger.error('[postStore] loadMorePostComments failed:', err)
    store.setCommentsPagination(postId, { loadingMore: false })
  }
}

async function reconcilePostStoreComments(postId: string, accessToken: string): Promise<boolean> {
  try {
    const page = await fetchPostCommentsPage<CommentData>(postId, accessToken, {
      limit: COMMENTS_PER_PAGE,
      offset: 0,
    })
    if (!page.ok) return false

    const store = usePostStore.getState()
    store.setComments(postId, page.comments)
    store.updatePostCommentCount(postId, page.commentCount)
    store.setCommentsPagination(postId, {
      loading: false,
      offset: page.comments.length,
      hasMore: page.hasMore,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Submit a comment. Only updates store on server ACK.
 * Returns the created comment or null on failure.
 */
export async function submitPostComment(
  postId: string,
  content: string,
  accessToken: string
): Promise<{ comment: CommentData } | { error: string }> {
  try {
    const response = await fetch(`/api/posts/${postId}/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...getCsrfHeaders(),
      },
      body: JSON.stringify({ content }),
    })

    const json = await response.json().catch(() => null)

    if (
      response.ok &&
      json?.success &&
      isCreatedCommentAcknowledgement(json.data?.comment, { postId, content })
    ) {
      const acknowledgement = json.data.comment
      const comment: CommentData = {
        ...acknowledgement,
        author_handle: acknowledgement.author_handle || 'user',
      }
      // The ACK proves the row committed, while the follow-up authenticated
      // read supplies the absolute post count. Keep the ACK visible even when
      // it falls outside the first canonical page or that read is unavailable.
      await reconcilePostStoreComments(postId, accessToken)
      usePostStore.getState().addComment(postId, comment)
      return { comment }
    }

    if (isDefinitiveMutationRejection({ ok: response.ok, status: response.status })) {
      return { error: json?.error || '发表评论失败' }
    }

    await reconcilePostStoreComments(postId, accessToken)
    return { error: json?.error || '发表评论结果未知，请检查最新评论' }
  } catch (err) {
    logger.error('[postStore] submitPostComment failed:', err)
    await reconcilePostStoreComments(postId, accessToken)
    return { error: '发表评论结果未知，请检查最新评论' }
  }
}

/**
 * Toggle post reaction (like/dislike). Only updates store on server ACK.
 */
export async function togglePostReaction(
  postId: string,
  reactionType: 'up' | 'down',
  accessToken: string
): Promise<{ success: boolean; error?: string }> {
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

    if (response.ok && json.success) {
      const result = json.data
      // Update store with server-confirmed data
      usePostStore.getState().updatePostReaction(postId, {
        like_count: result.like_count,
        dislike_count: result.dislike_count,
        reaction: result.reaction,
      })
      return { success: true }
    } else {
      return { success: false, error: json.error || '操作失败' }
    }
  } catch (err) {
    logger.error('[postStore] togglePostReaction failed:', err)
    return { success: false, error: '操作失败' }
  }
}
