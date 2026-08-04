const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/

export const POST_REPOST_REQUEST_TIMEOUT_MS = 15_000
export const POST_REPOST_OPERATION = 'create' as const

export type PostRepostAction = 'created' | 'already_exists'

export type PostRepostAcknowledgement = {
  actorId: string
  sourcePostId: string
  rootPostId: string
  requestId: string
  operation: typeof POST_REPOST_OPERATION
  action: PostRepostAction
  repostPostId: string
  repostCount: number
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

export function createPostRepostRequestId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Read only the canonical receipt for this exact actor, clicked source post,
 * resolved root, request nonce and result action. The HTTP status remains part
 * of the caller contract: 201 means `created`, while 409 may reconcile only an
 * exact `already_exists` receipt. The nonce correlates this HTTP exchange; it
 * is not a claim that the database persists an idempotency ledger.
 */
export function readPostRepostAcknowledgement(
  value: unknown,
  expected: {
    actorId: string
    sourcePostId: string
    rootPostId: string
    requestId: string
    action: PostRepostAction
  }
): PostRepostAcknowledgement | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'action',
      'actor_id',
      'operation',
      'repost_count',
      'repost_post_id',
      'request_id',
      'root_post_id',
      'source_post_id',
    ]) ||
    value.operation !== POST_REPOST_OPERATION ||
    value.action !== expected.action ||
    !Number.isSafeInteger(value.repost_count) ||
    (value.repost_count as number) < 1
  ) {
    return null
  }

  const actorId = canonicalUuid(value.actor_id)
  const sourcePostId = canonicalUuid(value.source_post_id)
  const rootPostId = canonicalUuid(value.root_post_id)
  const requestId = canonicalRequestId(value.request_id)
  const repostPostId = canonicalUuid(value.repost_post_id)
  const expectedActorId = canonicalUuid(expected.actorId)
  const expectedSourcePostId = canonicalUuid(expected.sourcePostId)
  const expectedRootPostId = canonicalUuid(expected.rootPostId)
  const expectedRequestId = canonicalRequestId(expected.requestId)

  if (
    !actorId ||
    !sourcePostId ||
    !rootPostId ||
    !requestId ||
    !repostPostId ||
    !expectedActorId ||
    !expectedSourcePostId ||
    !expectedRootPostId ||
    !expectedRequestId ||
    actorId !== expectedActorId ||
    sourcePostId !== expectedSourcePostId ||
    rootPostId !== expectedRootPostId ||
    requestId !== expectedRequestId ||
    repostPostId === sourcePostId ||
    repostPostId === rootPostId
  ) {
    return null
  }

  return {
    actorId,
    sourcePostId,
    rootPostId,
    requestId,
    operation: POST_REPOST_OPERATION,
    action: expected.action,
    repostPostId,
    repostCount: value.repost_count as number,
  }
}
