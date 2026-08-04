import { getHandleShapeError, normalizeHandle } from '@/lib/identity/handle-policy'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

export const FOLLOW_LIST_PAGE_SIZE = 50

export type FollowListType = 'followers' | 'following'

export type FollowListUser = Readonly<{
  id: string
  handle: string
  bio: string | null
  avatar_url: string | null
  followed_at: string
  is_following: boolean
}>

export type FollowListPage = Readonly<{
  viewerId: string | null
  targetUserId: string
  targetHandle: string
  list: FollowListType
  hidden: boolean
  users: readonly FollowListUser[]
  hasMore: boolean
  nextCursor: string | null
}>

type FollowListExpectation = Readonly<{
  viewerId: string | null
  targetHandle: string
  list: FollowListType
  targetUserId?: string | null
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const canonical = [...expected].sort()
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  )
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    ISO_TIMESTAMP_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

export function compareFollowListTimestamps(left: string, right: string): number {
  const leftFraction = left.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? ''
  const rightFraction = right.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? ''
  const leftMicros = Date.parse(left) * 1_000 + Number(leftFraction.padEnd(6, '0').slice(3, 6))
  const rightMicros = Date.parse(right) * 1_000 + Number(rightFraction.padEnd(6, '0').slice(3, 6))
  return leftMicros - rightMicros
}

function isHandle(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    getHandleShapeError(value, { allowUnchangedLegacyDot: true }) === null
  )
}

function sameHandle(left: string, right: string): boolean {
  return normalizeHandle(left).toLowerCase() === normalizeHandle(right).toLowerCase()
}

function isNullableText(value: unknown, maxLength: number): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' && value.length <= maxLength && !CONTROL_PATTERN.test(value))
  )
}

function readUser(value: unknown): FollowListUser | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['avatar_url', 'bio', 'followed_at', 'handle', 'id', 'is_following']) ||
    !isCanonicalUuid(value.id) ||
    !isHandle(value.handle) ||
    !isNullableText(value.bio, 2_000) ||
    !isNullableText(value.avatar_url, 4_096) ||
    !isTimestamp(value.followed_at) ||
    typeof value.is_following !== 'boolean'
  ) {
    return null
  }

  return {
    id: value.id,
    handle: value.handle,
    bio: value.bio,
    avatar_url: value.avatar_url,
    followed_at: value.followed_at,
    is_following: value.is_following,
  }
}

export function readFollowListPage(
  value: unknown,
  expected: FollowListExpectation
): FollowListPage | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['data', 'meta', 'success']) ||
    value.success !== true ||
    !isRecord(value.meta) ||
    !hasExactKeys(value.meta, ['timestamp']) ||
    !isTimestamp(value.meta.timestamp) ||
    !isRecord(value.data) ||
    !hasExactKeys(value.data, [
      'hidden',
      'list',
      'pagination',
      'target_handle',
      'target_user_id',
      'users',
      'viewer_id',
    ]) ||
    (expected.viewerId !== null && !isCanonicalUuid(expected.viewerId)) ||
    value.data.viewer_id !== expected.viewerId ||
    !isCanonicalUuid(value.data.target_user_id) ||
    (expected.targetUserId != null && value.data.target_user_id !== expected.targetUserId) ||
    !isHandle(value.data.target_handle) ||
    !sameHandle(value.data.target_handle, expected.targetHandle) ||
    value.data.list !== expected.list ||
    typeof value.data.hidden !== 'boolean' ||
    !Array.isArray(value.data.users) ||
    value.data.users.length > FOLLOW_LIST_PAGE_SIZE ||
    !isRecord(value.data.pagination) ||
    !hasExactKeys(value.data.pagination, ['has_more', 'limit', 'next_cursor']) ||
    value.data.pagination.limit !== FOLLOW_LIST_PAGE_SIZE ||
    typeof value.data.pagination.has_more !== 'boolean' ||
    (value.data.pagination.next_cursor !== null &&
      (typeof value.data.pagination.next_cursor !== 'string' ||
        !CURSOR_PATTERN.test(value.data.pagination.next_cursor))) ||
    value.data.pagination.has_more !== (value.data.pagination.next_cursor !== null)
  ) {
    return null
  }

  const users: FollowListUser[] = []
  const userIds = new Set<string>()
  let previousTimestamp: string | null = null
  for (const candidate of value.data.users) {
    const user = readUser(candidate)
    if (!user || userIds.has(user.id)) return null
    if (
      previousTimestamp !== null &&
      compareFollowListTimestamps(user.followed_at, previousTimestamp) > 0
    ) {
      return null
    }
    previousTimestamp = user.followed_at
    userIds.add(user.id)
    users.push(user)
  }

  if (
    value.data.hidden &&
    (users.length !== 0 ||
      value.data.pagination.has_more ||
      value.data.pagination.next_cursor !== null)
  ) {
    return null
  }

  return {
    viewerId: value.data.viewer_id as string | null,
    targetUserId: value.data.target_user_id,
    targetHandle: value.data.target_handle,
    list: value.data.list as FollowListType,
    hidden: value.data.hidden,
    users,
    hasMore: value.data.pagination.has_more,
    nextCursor: value.data.pagination.next_cursor,
  }
}
