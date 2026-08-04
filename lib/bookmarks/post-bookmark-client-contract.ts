const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/

export const POST_BOOKMARK_REQUEST_TIMEOUT_MS = 15_000
export const POST_BOOKMARK_OPERATION = 'toggle' as const
export const POST_BOOKMARK_STATUS_OPERATION = 'status' as const

/**
 * These client-error responses reject the command before a successful toggle
 * receipt can exist. A request timeout is deliberately excluded because the
 * server may have committed before the transport deadline was observed.
 */
export function isDefinitivePostBookmarkRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408
}

export type PostBookmarkAcknowledgement = {
  actorId: string
  postId: string
  requestId: string
  operation: typeof POST_BOOKMARK_OPERATION
  action: 'added' | 'removed'
  bookmarked: boolean
  bookmarkCount: number
  folderId: string | null
}

export type PostBookmarkStatusAcknowledgement = {
  actorId: string
  requestId: string
  operation: typeof POST_BOOKMARK_STATUS_OPERATION
  postIds: string[]
  bookmarks: Record<string, boolean>
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

export function createPostBookmarkRequestId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Accept only the toggle receipt for this exact viewer, post and request.
 * Folder save/remove commands have separate identity-bound contracts.
 */
export function readPostBookmarkAcknowledgement(
  value: unknown,
  expected: { actorId: string; postId: string; requestId: string }
): PostBookmarkAcknowledgement | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'action',
      'actor_id',
      'bookmark_count',
      'bookmarked',
      'folder_id',
      'operation',
      'post_id',
      'request_id',
    ]) ||
    value.operation !== POST_BOOKMARK_OPERATION ||
    (value.action !== 'added' && value.action !== 'removed') ||
    !isNonnegativeSafeInteger(value.bookmark_count)
  ) {
    return null
  }

  const actorId = canonicalUuid(value.actor_id)
  const postId = canonicalUuid(value.post_id)
  const requestId = canonicalRequestId(value.request_id)
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
    requestId !== expectedRequestId
  ) {
    return null
  }

  const added = value.action === 'added'
  const folderId = value.folder_id === null ? null : canonicalUuid(value.folder_id)
  if (
    value.bookmarked !== added ||
    (added && (!folderId || value.bookmark_count < 1)) ||
    (!added && value.folder_id !== null)
  ) {
    return null
  }

  return {
    actorId,
    postId,
    requestId,
    operation: POST_BOOKMARK_OPERATION,
    action: value.action,
    bookmarked: added,
    bookmarkCount: value.bookmark_count,
    folderId,
  }
}

/**
 * Accept a batch snapshot only when it covers exactly the requested unique
 * posts and is bound to the active viewer and request nonce.
 */
export function readPostBookmarkStatusAcknowledgement(
  value: unknown,
  expected: { actorId: string; requestId: string; postIds: readonly string[] }
): PostBookmarkStatusAcknowledgement | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['actor_id', 'bookmarks', 'operation', 'post_ids', 'request_id']) ||
    value.operation !== POST_BOOKMARK_STATUS_OPERATION ||
    !Array.isArray(value.post_ids) ||
    !isRecord(value.bookmarks)
  ) {
    return null
  }

  const bookmarks = value.bookmarks

  const actorId = canonicalUuid(value.actor_id)
  const requestId = canonicalRequestId(value.request_id)
  const expectedActorId = canonicalUuid(expected.actorId)
  const expectedRequestId = canonicalRequestId(expected.requestId)
  const expectedPostIds = expected.postIds.map(canonicalUuid)
  const responsePostIds = value.post_ids.map(canonicalUuid)
  if (
    !actorId ||
    !requestId ||
    !expectedActorId ||
    !expectedRequestId ||
    actorId !== expectedActorId ||
    requestId !== expectedRequestId ||
    expectedPostIds.some((postId) => postId === null) ||
    responsePostIds.some((postId) => postId === null)
  ) {
    return null
  }

  const canonicalExpectedPostIds = expectedPostIds as string[]
  const canonicalResponsePostIds = responsePostIds as string[]
  if (
    new Set(canonicalExpectedPostIds).size !== canonicalExpectedPostIds.length ||
    new Set(canonicalResponsePostIds).size !== canonicalResponsePostIds.length ||
    canonicalResponsePostIds.length !== canonicalExpectedPostIds.length ||
    canonicalResponsePostIds.some((postId, index) => postId !== canonicalExpectedPostIds[index]) ||
    !hasExactKeys(bookmarks, canonicalExpectedPostIds) ||
    Object.values(bookmarks).some((bookmarked) => typeof bookmarked !== 'boolean')
  ) {
    return null
  }

  return {
    actorId,
    requestId,
    operation: POST_BOOKMARK_STATUS_OPERATION,
    postIds: canonicalResponsePostIds,
    bookmarks: Object.fromEntries(
      canonicalResponsePostIds.map((postId) => [postId, bookmarks[postId] as boolean])
    ),
  }
}
