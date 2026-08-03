const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type PostPinScopeType = 'author' | 'group'

export type PostPinAcknowledgement = {
  postId: string
  authorId: string
  groupId: string | null
  scopeType: PostPinScopeType
  scopeId: string
  isPinned: boolean
  alreadySet: boolean
  unpinnedCount: number
  message: 'Pinned' | 'Unpinned'
}

export type ExpectedPostPinState = {
  postId: string
  isPinned: boolean
  groupId?: string | null
  authorId?: string | null
}

type PostPinScopedRow = {
  author_id?: string | null
  group_id?: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function canonicalUuid(value: unknown): string | null {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) return null
  return value.toLowerCase()
}

export function postPinScopeKey(post: PostPinScopedRow): string | null {
  const groupId = typeof post.group_id === 'string' ? post.group_id.toLowerCase() : null
  if (groupId) return `group:${groupId}`

  const authorId = typeof post.author_id === 'string' ? post.author_id.toLowerCase() : null
  return authorId ? `author:${authorId}` : null
}

export function postBelongsToPinScope(
  post: PostPinScopedRow,
  acknowledgement: Pick<PostPinAcknowledgement, 'authorId' | 'groupId' | 'scopeId' | 'scopeType'>
): boolean {
  if (acknowledgement.scopeType === 'group') {
    return (
      acknowledgement.groupId !== null &&
      acknowledgement.scopeId === acknowledgement.groupId &&
      post.group_id?.toLowerCase() === acknowledgement.groupId
    )
  }

  return (
    acknowledgement.groupId === null &&
    acknowledgement.scopeId === acknowledgement.authorId &&
    !post.group_id &&
    post.author_id?.toLowerCase() === acknowledgement.authorId
  )
}

export function readPostPinAcknowledgement(
  value: unknown,
  expected: ExpectedPostPinState
): PostPinAcknowledgement | null {
  if (!isRecord(value) || !hasExactKeys(value, ['data', 'success']) || value.success !== true) {
    return null
  }
  if (!isRecord(value.data)) return null

  const data = value.data
  if (
    !hasExactKeys(data, [
      'already_set',
      'author_id',
      'group_id',
      'is_pinned',
      'message',
      'post_id',
      'scope_id',
      'scope_type',
      'unpinned_count',
    ]) ||
    typeof data.is_pinned !== 'boolean' ||
    typeof data.already_set !== 'boolean' ||
    typeof data.unpinned_count !== 'number' ||
    !Number.isSafeInteger(data.unpinned_count) ||
    data.unpinned_count < 0 ||
    (data.scope_type !== 'author' && data.scope_type !== 'group') ||
    (data.message !== 'Pinned' && data.message !== 'Unpinned')
  ) {
    return null
  }

  const postId = canonicalUuid(data.post_id)
  const authorId = canonicalUuid(data.author_id)
  const groupId = data.group_id === null ? null : canonicalUuid(data.group_id)
  const scopeId = canonicalUuid(data.scope_id)
  const expectedPostId = canonicalUuid(expected.postId)
  const expectedGroupId =
    expected.groupId === undefined || expected.groupId === null
      ? expected.groupId
      : canonicalUuid(expected.groupId)
  const expectedAuthorId =
    expected.authorId === undefined || expected.authorId === null
      ? expected.authorId
      : canonicalUuid(expected.authorId)

  if (
    !postId ||
    !authorId ||
    !scopeId ||
    !expectedPostId ||
    (typeof expected.groupId === 'string' && !expectedGroupId) ||
    (typeof expected.authorId === 'string' && !expectedAuthorId) ||
    postId !== expectedPostId ||
    data.is_pinned !== expected.isPinned ||
    data.message !== (expected.isPinned ? 'Pinned' : 'Unpinned') ||
    (data.already_set && data.unpinned_count !== 0) ||
    (data.group_id !== null && !groupId) ||
    (expected.groupId !== undefined && groupId !== expectedGroupId) ||
    (expected.authorId !== undefined && authorId !== expectedAuthorId)
  ) {
    return null
  }

  if (
    (data.scope_type === 'group' && (groupId === null || scopeId !== groupId)) ||
    (data.scope_type === 'author' && (groupId !== null || scopeId !== authorId))
  ) {
    return null
  }

  return {
    postId,
    authorId,
    groupId,
    scopeType: data.scope_type,
    scopeId,
    isPinned: data.is_pinned,
    alreadySet: data.already_set,
    unpinnedCount: data.unpinned_count,
    message: data.message,
  }
}
