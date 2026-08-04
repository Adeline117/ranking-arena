const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/
const INTENT_SEQUENCE_PATTERN = /^[1-9][0-9]{0,18}$/
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n

export const COMMENT_REACTION_REQUEST_TIMEOUT_MS = 15_000
export const COMMENT_REACTION_OPERATION = 'set_reaction' as const
export const COMMENT_REACTION_INTENT_OPERATION = 'reserve_reaction_intent' as const

export type CommentReaction = 'like' | 'dislike'
export type CommentReactionAction = 'added' | 'removed' | 'changed' | 'unchanged'

export type CommentReactionAcknowledgement = {
  actorId: string
  postId: string
  commentId: string
  requestId: string
  operation: typeof COMMENT_REACTION_OPERATION
  intentSequence: string
  desiredReaction: CommentReaction | null
  action: CommentReactionAction
  reaction: CommentReaction | null
  liked: boolean
  disliked: boolean
  likeCount: number
  dislikeCount: number
  replayed: boolean
}

export type CommentReactionIntentAcknowledgement = {
  actorId: string
  postId: string
  commentId: string
  requestId: string
  operation: typeof COMMENT_REACTION_INTENT_OPERATION
  desiredReaction: CommentReaction | null
  status: 'issued' | 'replayed'
  intentSequence: string
  expiresAt: string
  replayed: boolean
}

export type CommentReactionFailureKind =
  | 'stale'
  | 'expired'
  | 'unknown_ticket'
  | 'operation_conflict'
  | 'too_many_pending'
  | 'invalid'
  | 'not_found'

export type CommentReactionFailure = { kind: CommentReactionFailureKind }

export type ExpectedCommentReaction = {
  actorId: string
  postId: string
  commentId: string
  requestId: string
  intentSequence: string
  desiredReaction: CommentReaction | null
}

export type ExpectedCommentReactionIntent = Omit<ExpectedCommentReaction, 'intentSequence'>

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

function hasCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

export function isCanonicalCommentReactionRequestId(value: unknown): value is string {
  return canonicalRequestId(value) !== null
}

export function isCanonicalCommentReactionIntentSequence(value: unknown): value is string {
  if (typeof value !== 'string' || !INTENT_SEQUENCE_PATTERN.test(value)) return false
  try {
    return BigInt(value) <= MAX_POSTGRES_BIGINT
  } catch {
    return false
  }
}

export function createCommentReactionRequestId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function nextCommentReactionState(
  current: CommentReaction | null,
  selected: CommentReaction
): CommentReaction | null {
  return current === selected ? null : selected
}

export function commentReactionCountDelta(
  current: CommentReaction | null,
  desired: CommentReaction | null
): { likeCount: number; dislikeCount: number } {
  return {
    likeCount: Number(desired === 'like') - Number(current === 'like'),
    dislikeCount: Number(desired === 'dislike') - Number(current === 'dislike'),
  }
}

/** A bounded 4xx proves the route rejected the command before commit. */
export function isDefinitiveCommentReactionRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 425
}

export function readCommentReactionIntentAcknowledgement(
  value: unknown,
  expected: ExpectedCommentReactionIntent
): CommentReactionIntentAcknowledgement | null {
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
      'actor_id',
      'comment_id',
      'desired_reaction',
      'expires_at',
      'intent_sequence',
      'operation',
      'post_id',
      'replayed',
      'request_id',
      'status',
    ]) ||
    data.operation !== COMMENT_REACTION_INTENT_OPERATION ||
    (data.desired_reaction !== null &&
      data.desired_reaction !== 'like' &&
      data.desired_reaction !== 'dislike') ||
    (data.status !== 'issued' && data.status !== 'replayed') ||
    typeof data.replayed !== 'boolean' ||
    data.replayed !== (data.status === 'replayed') ||
    !isCanonicalCommentReactionIntentSequence(data.intent_sequence) ||
    !hasCanonicalTimestamp(data.expires_at)
  ) {
    return null
  }

  const actorId = canonicalUuid(data.actor_id)
  const postId = canonicalUuid(data.post_id)
  const commentId = canonicalUuid(data.comment_id)
  const requestId = canonicalRequestId(data.request_id)
  const expectedActorId = canonicalUuid(expected.actorId)
  const expectedPostId = canonicalUuid(expected.postId)
  const expectedCommentId = canonicalUuid(expected.commentId)
  const expectedRequestId = canonicalRequestId(expected.requestId)
  if (
    !actorId ||
    !postId ||
    !commentId ||
    !requestId ||
    !expectedActorId ||
    !expectedPostId ||
    !expectedCommentId ||
    !expectedRequestId ||
    actorId !== expectedActorId ||
    postId !== expectedPostId ||
    commentId !== expectedCommentId ||
    requestId !== expectedRequestId ||
    data.desired_reaction !== expected.desiredReaction
  ) {
    return null
  }

  return {
    actorId,
    postId,
    commentId,
    requestId,
    operation: COMMENT_REACTION_INTENT_OPERATION,
    desiredReaction: data.desired_reaction,
    status: data.status,
    intentSequence: data.intent_sequence,
    expiresAt: data.expires_at,
    replayed: data.replayed,
  }
}

const COMMENT_REACTION_FAILURES: ReadonlyArray<{
  code: string
  kind: CommentReactionFailureKind
  status: number
}> = [
  { code: 'COMMENT_REACTION_STALE', kind: 'stale', status: 409 },
  { code: 'COMMENT_REACTION_EXPIRED', kind: 'expired', status: 410 },
  { code: 'COMMENT_REACTION_UNKNOWN_TICKET', kind: 'unknown_ticket', status: 409 },
  { code: 'COMMENT_REACTION_OPERATION_CONFLICT', kind: 'operation_conflict', status: 409 },
  { code: 'COMMENT_REACTION_TOO_MANY_PENDING', kind: 'too_many_pending', status: 429 },
  { code: 'COMMENT_REACTION_INVALID', kind: 'invalid', status: 400 },
  { code: 'COMMENT_REACTION_NOT_FOUND', kind: 'not_found', status: 404 },
]

export function readCommentReactionFailure(
  value: unknown,
  status: number
): CommentReactionFailure | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['code', 'error', 'success']) ||
    value.success !== false ||
    typeof value.error !== 'string' ||
    value.error.length === 0
  ) {
    return null
  }

  const failure = COMMENT_REACTION_FAILURES.find(
    (candidate) => candidate.status === status && candidate.code === value.code
  )
  return failure ? { kind: failure.kind } : null
}

/**
 * Accept only the identity- and request-bound receipt for this exact desired
 * state. Replaying the same desired state can acknowledge `unchanged`, but it
 * must never toggle the reaction away.
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
      'desired_reaction',
      'dislike_count',
      'disliked',
      'like_count',
      'liked',
      'operation',
      'post_id',
      'reaction',
      'replayed',
      'request_id',
      'intent_sequence',
    ]) ||
    data.operation !== COMMENT_REACTION_OPERATION ||
    (data.action !== 'added' &&
      data.action !== 'removed' &&
      data.action !== 'changed' &&
      data.action !== 'unchanged') ||
    (data.desired_reaction !== null &&
      data.desired_reaction !== 'like' &&
      data.desired_reaction !== 'dislike') ||
    typeof data.liked !== 'boolean' ||
    typeof data.disliked !== 'boolean' ||
    typeof data.replayed !== 'boolean' ||
    (data.liked === true && data.disliked === true) ||
    !isNonnegativeSafeInteger(data.like_count) ||
    !isNonnegativeSafeInteger(data.dislike_count)
  ) {
    return null
  }

  const actorId = canonicalUuid(data.actor_id)
  const postId = canonicalUuid(data.post_id)
  const commentId = canonicalUuid(data.comment_id)
  const requestId = canonicalRequestId(data.request_id)
  const expectedActorId = canonicalUuid(expected.actorId)
  const expectedPostId = canonicalUuid(expected.postId)
  const expectedCommentId = canonicalUuid(expected.commentId)
  const expectedRequestId = canonicalRequestId(expected.requestId)
  if (
    !actorId ||
    !postId ||
    !commentId ||
    !requestId ||
    !expectedActorId ||
    !expectedPostId ||
    !expectedCommentId ||
    !expectedRequestId ||
    !isCanonicalCommentReactionIntentSequence(data.intent_sequence) ||
    !isCanonicalCommentReactionIntentSequence(expected.intentSequence) ||
    actorId !== expectedActorId ||
    postId !== expectedPostId ||
    commentId !== expectedCommentId ||
    requestId !== expectedRequestId ||
    data.intent_sequence !== expected.intentSequence ||
    data.desired_reaction !== expected.desiredReaction
  ) {
    return null
  }

  const reaction = data.reaction
  const expectedLiked = reaction === 'like'
  const expectedDisliked = reaction === 'dislike'
  if (
    reaction !== expected.desiredReaction ||
    (data.action === 'removed' && expected.desiredReaction !== null) ||
    ((data.action === 'added' || data.action === 'changed') && expected.desiredReaction === null) ||
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
    requestId,
    operation: COMMENT_REACTION_OPERATION,
    intentSequence: data.intent_sequence,
    desiredReaction: data.desired_reaction,
    action: data.action,
    reaction: reaction as CommentReaction | null,
    liked: data.liked,
    disliked: data.disliked,
    likeCount: data.like_count,
    dislikeCount: data.dislike_count,
    replayed: data.replayed,
  }
}
