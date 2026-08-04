const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const POST_REACTION_REQUEST_TIMEOUT_MS = 15_000

export type PostReaction = 'up' | 'down'
export type PostReactionAction = 'added' | 'removed' | 'changed'

export type PostReactionAcknowledgement = {
  actorId: string
  postId: string
  requestedReaction: PostReaction
  action: PostReactionAction
  reaction: PostReaction | null
  likeCount: number
  dislikeCount: number
}

export type ExpectedPostReaction = {
  actorId: string
  postId: string
  requestedReaction: PostReaction
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
 * Accept only the identity-bound receipt for this exact viewer, post and
 * requested reaction. A generic 2xx payload must never become reaction truth.
 */
export function readPostReactionAcknowledgement(
  value: unknown,
  expected: ExpectedPostReaction
): PostReactionAcknowledgement | null {
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
      'dislike_count',
      'like_count',
      'post_id',
      'reaction',
      'requested_reaction',
    ]) ||
    (data.action !== 'added' && data.action !== 'removed' && data.action !== 'changed') ||
    (data.requested_reaction !== 'up' && data.requested_reaction !== 'down') ||
    !isNonnegativeSafeInteger(data.like_count) ||
    !isNonnegativeSafeInteger(data.dislike_count)
  ) {
    return null
  }

  const actorId = canonicalUuid(data.actor_id)
  const postId = canonicalUuid(data.post_id)
  const expectedActorId = canonicalUuid(expected.actorId)
  const expectedPostId = canonicalUuid(expected.postId)
  if (
    !actorId ||
    !postId ||
    !expectedActorId ||
    !expectedPostId ||
    actorId !== expectedActorId ||
    postId !== expectedPostId ||
    data.requested_reaction !== expected.requestedReaction
  ) {
    return null
  }

  const reaction = data.reaction
  if (
    (data.action === 'removed' && reaction !== null) ||
    (data.action !== 'removed' && reaction !== expected.requestedReaction) ||
    (reaction === 'up' && data.like_count < 1) ||
    (reaction === 'down' && data.dislike_count < 1)
  ) {
    return null
  }

  return {
    actorId,
    postId,
    requestedReaction: data.requested_reaction,
    action: data.action,
    reaction: reaction as PostReaction | null,
    likeCount: data.like_count,
    dislikeCount: data.dislike_count,
  }
}
