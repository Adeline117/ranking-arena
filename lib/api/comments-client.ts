import { authedFetch, type AuthedFetchScope } from './client'

type CommentSort = 'best' | 'time'

type CommentsEnvelope<T> = {
  success?: boolean
  data?: {
    comments?: T[]
    post?: { comment_count?: unknown }
  }
  meta?: { pagination?: { has_more?: boolean } }
  error?: unknown
}

export type PostCommentsPage<T> = {
  ok: boolean
  status: number
  comments: T[]
  commentCount: number
  hasMore: boolean
  /** Authoritative 403/404: the viewer may no longer retain this resource. */
  resourceAbsent?: true
  error?: unknown
}

export type CreatedCommentAcknowledgement = {
  id: string
  post_id: string
  user_id: string
  content: string
  parent_id?: string | null
  like_count: number
  dislike_count: number
  created_at: string
  updated_at: string
  author_handle?: string
  author_avatar_url?: string
}

/** Strict actor/resource ACK shared by every direct comment-create client. */
export function isCreatedCommentAcknowledgement(
  value: unknown,
  expected: { postId: string; parentId?: string | null; userId?: string | null }
): value is CreatedCommentAcknowledgement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const comment = value as Partial<CreatedCommentAcknowledgement>
  const expectedParentId = expected.parentId ?? null
  return (
    typeof comment.id === 'string' &&
    comment.id.length > 0 &&
    comment.post_id === expected.postId &&
    typeof comment.user_id === 'string' &&
    comment.user_id.length > 0 &&
    (!expected.userId || comment.user_id === expected.userId) &&
    typeof comment.content === 'string' &&
    (comment.parent_id ?? null) === expectedParentId &&
    Number.isSafeInteger(comment.like_count) &&
    (comment.like_count ?? -1) >= 0 &&
    Number.isSafeInteger(comment.dislike_count) &&
    (comment.dislike_count ?? -1) >= 0 &&
    typeof comment.created_at === 'string' &&
    Number.isFinite(Date.parse(comment.created_at)) &&
    typeof comment.updated_at === 'string' &&
    Number.isFinite(Date.parse(comment.updated_at)) &&
    (comment.author_handle === undefined || typeof comment.author_handle === 'string') &&
    (comment.author_avatar_url === undefined || typeof comment.author_avatar_url === 'string')
  )
}

/**
 * A received 4xx (except request timeout) is a definitive server rejection.
 * Transport failures, 408, 5xx and malformed 2xx responses leave commit state
 * unknown and must be reconciled with an authoritative read.
 */
export function isDefinitiveMutationRejection(result: { ok: boolean; status: number }): boolean {
  return !result.ok && result.status >= 400 && result.status < 500 && result.status !== 408
}

/**
 * Read one canonical comments page, forwarding auth when it is available and
 * requiring the server-owned absolute post comment count in the same envelope.
 */
export async function fetchPostCommentsPage<T>(
  postId: string,
  accessToken: string | null,
  options: {
    limit?: number
    offset?: number
    sort?: CommentSort
    viewerScope?: AuthedFetchScope
  } = {}
): Promise<PostCommentsPage<T>> {
  const params = new URLSearchParams()
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.offset !== undefined) params.set('offset', String(options.offset))
  if (options.sort !== undefined) params.set('sort', options.sort)

  const query = params.toString()
  const url = `/api/posts/${encodeURIComponent(postId)}/comments${query ? `?${query}` : ''}`
  const { ok, status, data } = options.viewerScope
    ? await authedFetch<CommentsEnvelope<T>>(
        url,
        'GET',
        accessToken,
        undefined,
        15_000,
        options.viewerScope
      )
    : await authedFetch<CommentsEnvelope<T>>(url, 'GET', accessToken)
  const comments = data?.data?.comments
  const commentCount = data?.data?.post?.comment_count

  // Missing and access-revoked resources are authoritative clears, not read
  // failures. Transport/5xx and malformed 2xx responses remain unavailable so
  // callers can preserve a known-good tree during a transient outage.
  if (!ok && (status === 403 || status === 404)) {
    return {
      ok: true,
      status,
      comments: [],
      commentCount: 0,
      hasMore: false,
      resourceAbsent: true,
      error: data?.error,
    }
  }

  if (
    !ok ||
    data?.success !== true ||
    !Array.isArray(comments) ||
    !Number.isSafeInteger(commentCount) ||
    (commentCount as number) < 0
  ) {
    return {
      ok: false,
      status,
      comments: [],
      commentCount: 0,
      hasMore: false,
      error: data?.error,
    }
  }

  return {
    ok: true,
    status,
    comments,
    commentCount: commentCount as number,
    hasMore: data.meta?.pagination?.has_more === true,
  }
}
