export type RealtimePostCommentCount = {
  postId: string
  commentCount: number
}

/**
 * Extract the server-owned absolute count from a posts UPDATE payload.
 * Comment row events intentionally are not accepted: they carry no canonical
 * count and DELETE rows may contain only the primary key.
 */
export function parseRealtimePostCommentCount(
  post: Record<string, unknown>
): RealtimePostCommentCount | null {
  const postId = post.id
  const commentCount = post.comment_count

  if (
    typeof postId !== 'string' ||
    !postId ||
    !Number.isSafeInteger(commentCount) ||
    (commentCount as number) < 0
  ) {
    return null
  }

  return { postId, commentCount: commentCount as number }
}

/** Absolute replacement, never a delta. Duplicate delivery is a no-op. */
export function applyRealtimePostCommentCount<T extends { id: string; comment_count: number }>(
  posts: T[],
  update: RealtimePostCommentCount
): T[] {
  let changed = false
  const next = posts.map((post) => {
    if (post.id !== update.postId || post.comment_count === update.commentCount) return post
    changed = true
    return { ...post, comment_count: update.commentCount }
  })

  return changed ? next : posts
}
