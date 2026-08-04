const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const COMMENT_REACTION_REQUEST_TIMEOUT_MS = 15_000

export type CommentReaction = 'like' | 'dislike'
export type CommentReactionAction = 'added' | 'removed' | 'changed'

export type CommentReactionAcknowledgement = {
  actorId: string
  postId: string
  commentId: string
  operation: 'toggle'
  requestedReaction: CommentReaction
  action: CommentReactionAction
  reaction: CommentReaction | null
  liked: boolean
  disliked: boolean
  likeCount: number
  dislikeCount: number
}

export type ExpectedCommentReaction = {
  actorId: string
  postId: string
  commentId: string
  requestedReaction: CommentReaction
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const canonicalExpected = [...expected].sort()
  return (
    actual.length === canonicalExpected.length &&
    actual.every((key, index) => key === canonicalExpected[index])
  )
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function hasCanonicalTimestamp(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

/**
 * Read only a receipt for this exact viewer, post, comment and toggle input.
 * `requested_reaction` names the toggle button that was pressed; it is not a
 * desired-state command. The atomic action/reaction pair is the resulting truth.
 */
export function readCommentReactionAcknowledgement(
  value: unknown,
  expected: ExpectedCommentReaction
): CommentReactionAcknowledgement | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['data', 'meta', 'success']) ||
    value.success !== true ||
    !isRecord(value.data) ||
    !isRecord(value.meta) ||
    !hasExactKeys(value.meta, ['timestamp']) ||
    !hasCanonicalTimestamp(value.meta.timestamp)
  ) {
    return null
  }

  const data = value.data
  if (
    !hasExactKeys(data, [
      'action',
      'actor_id',
      'comment_id',
      'dislike_count',
      'disliked',
      'like_count',
      'liked',
      'operation',
      'post_id',
      'reaction',
      'requested_reaction',
    ]) ||
    data.operation !== 'toggle' ||
    (data.requested_reaction !== 'like' && data.requested_reaction !== 'dislike') ||
    (data.action !== 'added' && data.action !== 'removed' && data.action !== 'changed') ||
    typeof data.liked !== 'boolean' ||
    typeof data.disliked !== 'boolean' ||
    (data.liked === true && data.disliked === true) ||
    !isNonnegativeSafeInteger(data.like_count) ||
    !isNonnegativeSafeInteger(data.dislike_count)
  ) {
    return null
  }

  const actorId = canonicalUuid(data.actor_id)
  const postId = canonicalUuid(data.post_id)
  const commentId = canonicalUuid(data.comment_id)
  const expectedActorId = canonicalUuid(expected.actorId)
  const expectedPostId = canonicalUuid(expected.postId)
  const expectedCommentId = canonicalUuid(expected.commentId)
  if (
    !actorId ||
    !postId ||
    !commentId ||
    !expectedActorId ||
    !expectedPostId ||
    !expectedCommentId ||
    actorId !== expectedActorId ||
    postId !== expectedPostId ||
    commentId !== expectedCommentId ||
    data.requested_reaction !== expected.requestedReaction
  ) {
    return null
  }

  const reaction = data.reaction
  const expectedLiked = reaction === 'like'
  const expectedDisliked = reaction === 'dislike'
  if (
    (data.action === 'removed' && reaction !== null) ||
    (data.action !== 'removed' && reaction !== expected.requestedReaction) ||
    data.liked !== expectedLiked ||
    data.disliked !== expectedDisliked ||
    (expectedLiked && data.like_count < 1) ||
    (expectedDisliked && data.dislike_count < 1)
  ) {
    return null
  }

  return {
    actorId,
    postId,
    commentId,
    operation: 'toggle',
    requestedReaction: data.requested_reaction,
    action: data.action,
    reaction: reaction as CommentReaction | null,
    liked: data.liked,
    disliked: data.disliked,
    likeCount: data.like_count,
    dislikeCount: data.dislike_count,
  }
}
