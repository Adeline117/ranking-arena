const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/

export const POST_REACTION_REQUEST_TIMEOUT_MS = 15_000
export const POST_REACTION_OPERATION = 'set_reaction' as const

export type PostReaction = 'up' | 'down'
export type PostReactionAction = 'added' | 'removed' | 'changed' | 'unchanged'

export type PostReactionAcknowledgement = {
  actorId: string
  postId: string
  requestId: string
  operation: typeof POST_REACTION_OPERATION
  desiredReaction: PostReaction | null
  action: PostReactionAction
  reaction: PostReaction | null
  likeCount: number
  dislikeCount: number
}

export type ExpectedPostReaction = {
  actorId: string
  postId: string
  requestId: string
  desiredReaction: PostReaction | null
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

function canonicalRequestId(value: unknown): string | null {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : null
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function hasCanonicalTimestamp(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

export function isCanonicalPostReactionRequestId(value: unknown): value is string {
  return canonicalRequestId(value) !== null
}

export function createPostReactionRequestId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function nextPostReactionState(
  current: PostReaction | null,
  selected: PostReaction
): PostReaction | null {
  return current === selected ? null : selected
}

export function postReactionCountDelta(
  current: PostReaction | null,
  desired: PostReaction | null
): { likeCount: number; dislikeCount: number } {
  return {
    likeCount: Number(desired === 'up') - Number(current === 'up'),
    dislikeCount: Number(desired === 'down') - Number(current === 'down'),
  }
}

/** A bounded 4xx proves the route rejected the command before commit. */
export function isDefinitivePostReactionRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 425
}

/**
 * Accept only the identity- and request-bound receipt for this exact desired
 * state. The command is intrinsically idempotent: replaying the same desired
 * state can acknowledge `unchanged`, but must never toggle it away.
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
      'desired_reaction',
      'dislike_count',
      'like_count',
      'operation',
      'post_id',
      'reaction',
      'request_id',
    ]) ||
    data.operation !== POST_REACTION_OPERATION ||
    (data.action !== 'added' &&
      data.action !== 'removed' &&
      data.action !== 'changed' &&
      data.action !== 'unchanged') ||
    (data.desired_reaction !== null &&
      data.desired_reaction !== 'up' &&
      data.desired_reaction !== 'down') ||
    !isNonnegativeSafeInteger(data.like_count) ||
    !isNonnegativeSafeInteger(data.dislike_count)
  ) {
    return null
  }

  const actorId = canonicalUuid(data.actor_id)
  const postId = canonicalUuid(data.post_id)
  const requestId = canonicalRequestId(data.request_id)
  const expectedActorId = canonicalUuid(expected.actorId)
  const expectedPostId = canonicalUuid(expected.postId)
  const expectedRequestId = canonicalRequestId(expected.requestId)
  if (
    !actorId ||
    !postId ||
    !requestId ||
    !expectedActorId ||
    !expectedPostId ||
    !expectedRequestId ||
    actorId !== expectedActorId ||
    postId !== expectedPostId ||
    requestId !== expectedRequestId ||
    data.desired_reaction !== expected.desiredReaction
  ) {
    return null
  }

  const reaction = data.reaction
  if (
    reaction !== expected.desiredReaction ||
    (data.action === 'removed' && expected.desiredReaction !== null) ||
    ((data.action === 'added' || data.action === 'changed') && expected.desiredReaction === null) ||
    (reaction === 'up' && data.like_count < 1) ||
    (reaction === 'down' && data.dislike_count < 1)
  ) {
    return null
  }

  return {
    actorId,
    postId,
    requestId,
    operation: POST_REACTION_OPERATION,
    desiredReaction: data.desired_reaction,
    action: data.action,
    reaction: reaction as PostReaction | null,
    likeCount: data.like_count,
    dislikeCount: data.dislike_count,
  }
}
