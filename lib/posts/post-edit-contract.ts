const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const POST_KEYS = [
  'id',
  'author_id',
  'group_id',
  'title',
  'content',
  'images',
  'content_version',
  'updated_at',
] as const

export type PostEditPost = {
  id: string
  author_id: string
  group_id: string | null
  title: string
  content: string
  images: string[] | null
  content_version: number
  updated_at: string
}

export type PostEditRpcAcknowledgement =
  | { status: 'invalid' | 'account_inactive' | 'not_found' | 'forbidden' | 'conflict' }
  | {
      status: 'updated' | 'unchanged'
      actorId: string
      post: PostEditPost
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === expected.length && expected.every((key) => actual.includes(key))
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) return false
  if (value !== value.trim() || /[\u0000-\u001f\u007f\s]/.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isImageList(value: unknown): value is string[] | null {
  return (
    value === null ||
    (Array.isArray(value) &&
      value.length <= 9 &&
      value.every(isHttpUrl) &&
      new Set(value).size === value.length)
  )
}

function parsePost(value: unknown): PostEditPost | null {
  if (!isRecord(value) || !hasExactKeys(value, POST_KEYS)) return null
  if (
    !isUuid(value.id) ||
    !isUuid(value.author_id) ||
    (value.group_id !== null && !isUuid(value.group_id)) ||
    typeof value.title !== 'string' ||
    value.title.length < 1 ||
    value.title.length > 200 ||
    value.title !== value.title.trim() ||
    typeof value.content !== 'string' ||
    value.content.length > 50000 ||
    !isImageList(value.images) ||
    !Number.isSafeInteger(value.content_version) ||
    Number(value.content_version) < 0 ||
    typeof value.updated_at !== 'string' ||
    !Number.isFinite(Date.parse(value.updated_at))
  ) {
    return null
  }

  return {
    id: value.id,
    author_id: value.author_id,
    group_id: value.group_id,
    title: value.title,
    content: value.content,
    images: value.images,
    content_version: Number(value.content_version),
    updated_at: value.updated_at,
  }
}

export function readPostEditRpcAcknowledgement(value: unknown): PostEditRpcAcknowledgement | null {
  if (!isRecord(value) || typeof value.status !== 'string') return null

  if (
    ['invalid', 'account_inactive', 'not_found', 'forbidden', 'conflict'].includes(value.status)
  ) {
    if (!hasExactKeys(value, ['status'])) return null
    return {
      status: value.status as
        | 'invalid'
        | 'account_inactive'
        | 'not_found'
        | 'forbidden'
        | 'conflict',
    }
  }

  if (
    (value.status !== 'updated' && value.status !== 'unchanged') ||
    !hasExactKeys(value, ['status', 'actor_id', 'post']) ||
    !isUuid(value.actor_id)
  ) {
    return null
  }

  const post = parsePost(value.post)
  if (!post) return null
  return { status: value.status, actorId: value.actor_id, post }
}

/** Parse the public `/api/posts/:id/edit` success envelope fail-closed. */
export function readPostEditApiAcknowledgement(
  value: unknown,
  expectedPostId: string
): PostEditPost | null {
  if (!isRecord(value) || !hasExactKeys(value, ['success', 'post']) || value.success !== true) {
    return null
  }
  const post = parsePost(value.post)
  return post?.id === expectedPostId ? post : null
}
