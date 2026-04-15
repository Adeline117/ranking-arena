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
  content: string
  user_id?: string
  author_handle: string
  author_avatar_url?: string
  created_at: string
  like_count?: number
  user_liked?: boolean
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
  updatePostReaction: (postId: string, data: {
    like_count: number
    dislike_count: number
    reaction: 'up' | 'down' | null
  }) => void
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

  setPost: (post) => set((state) => ({
    posts: evictOldest({ ...state.posts, [post.id]: post }, MAX_CACHED_POSTS),
  })),

  setPosts: (posts) => set((state) => {
    const updated = { ...state.posts }
    for (const post of posts) {
      updated[post.id] = post
    }
    return { posts: evictOldest(updated, MAX_CACHED_POSTS) }
  }),

  updatePostReaction: (postId, data) => set((state) => {
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

  setComments: (postId, comments) => set((state) => ({
    comments: evictOldest({ ...state.comments, [postId]: comments }, MAX_CACHED_COMMENT_SETS),
  })),

  appendComments: (postId, newComments) => set((state) => {
    const existing = state.comments[postId] || []
    // Deduplicate by ID
    const existingIds = new Set(existing.map(c => c.id))
    const unique = newComments.filter(c => !existingIds.has(c.id))
    return {
      comments: evictOldest({ ...state.comments, [postId]: [...existing, ...unique] }, MAX_CACHED_COMMENT_SETS),
    }
  }),

  addComment: (postId, comment) => set((state) => {
    const existing = state.comments[postId] || []
    // Avoid duplicates
    if (existing.some(c => c.id === comment.id)) return state
    // Also update post comment_count
    const post = state.posts[postId]
    return {
      comments: { ...state.comments, [postId]: [...existing, comment] },
      posts: post ? {
        ...state.posts,
        [postId]: { ...post, comment_count: post.comment_count + 1 },
      } : state.posts,
    }
  }),

  setCommentsPagination: (postId, pagination) => set((state) => ({
    commentsPagination: {
      ...state.commentsPagination,
      [postId]: { ...getDefaultPagination(), ...state.commentsPagination[postId], ...pagination },
    },
  })),

  triggerFeedRefresh: () => set((state) => ({
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
export async function loadPostComments(postId: string): Promise<void> {
  const store = usePostStore.getState()
  store.setCommentsPagination(postId, { loading: true, offset: 0, hasMore: true })

  try {
    const response = await fetch(`/api/posts/${postId}/comments?limit=${COMMENTS_PER_PAGE}&offset=0`)
    const data = await response.json()

    if (response.ok) {
      const comments: CommentData[] = data.comments || []
      store.setComments(postId, comments)
      store.setCommentsPagination(postId, {
        loading: false,
        offset: COMMENTS_PER_PAGE,
        hasMore: data.pagination?.has_more ?? false,
      })
    } else {
      store.setComments(postId, [])
      store.setCommentsPagination(postId, { loading: false, hasMore: false })
    }
  } catch (err) {
    logger.error('[postStore] loadPostComments failed:', err)
    store.setComments(postId, [])
    store.setCommentsPagination(postId, { loading: false, hasMore: false })
  }
}

/**
 * Load more comments (pagination).
 */
export async function loadMorePostComments(postId: string): Promise<void> {
  const store = usePostStore.getState()
  const pagination = store.commentsPagination[postId]
  if (!pagination || pagination.loadingMore || !pagination.hasMore) return

  store.setCommentsPagination(postId, { loadingMore: true })

  try {
    const response = await fetch(
      `/api/posts/${postId}/comments?limit=${COMMENTS_PER_PAGE}&offset=${pagination.offset}`
    )
    const data = await response.json()

    if (response.ok) {
      const newComments: CommentData[] = data.comments || []
      store.appendComments(postId, newComments)
      store.setCommentsPagination(postId, {
        loadingMore: false,
        offset: pagination.offset + COMMENTS_PER_PAGE,
        hasMore: data.pagination?.has_more ?? false,
      })
    } else {
      store.setCommentsPagination(postId, { loadingMore: false, hasMore: false })
    }
  } catch (err) {
    logger.error('[postStore] loadMorePostComments failed:', err)
    store.setCommentsPagination(postId, { loadingMore: false })
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
        'Authorization': `Bearer ${accessToken}`,
        ...getCsrfHeaders(),
      },
      body: JSON.stringify({ content }),
    })

    const json = await response.json()

    if (response.ok && json.success) {
      const comment: CommentData = json.data.comment
      // Only add to store after server ACK
      usePostStore.getState().addComment(postId, comment)
      return { comment }
    } else {
      return { error: json.error || '发表评论失败' }
    }
  } catch (err) {
    logger.error('[postStore] submitPostComment failed:', err)
    return { error: '发表评论失败' }
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
        'Authorization': `Bearer ${accessToken}`,
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
