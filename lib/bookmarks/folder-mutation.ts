const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DENIAL_STATUSES = [
  'invalid',
  'account_inactive',
  'name_conflict',
  'folder_not_found',
  'folder_forbidden',
  'default_protected',
] as const

type BookmarkFolderDenialStatus = (typeof DENIAL_STATUSES)[number]

export type BookmarkFolderMutationAction = 'create' | 'update' | 'delete'

export type BookmarkFolderMutationPayload = {
  id: string
  user_id: string
  name: string
  description: string | null
  avatar_url: string | null
  is_public: boolean
  is_default: boolean
  post_count: number
  subscriber_count: number
  created_at: string | null
  updated_at: string | null
}

export type BookmarkFolderMutationAck =
  | { status: BookmarkFolderDenialStatus }
  | {
      status: 'created' | 'updated'
      userId: string
      folder: BookmarkFolderMutationPayload
    }
  | { status: 'deleted'; userId: string; folderId: string }

export type BookmarkFolderMutationArgs = {
  p_action: BookmarkFolderMutationAction
  p_folder_id: string | null
  p_name: string | null
  p_description: string | null
  p_avatar_url: string | null
  p_is_public: boolean | null
  p_set_name: boolean
  p_set_description: boolean
  p_set_avatar_url: boolean
  p_set_is_public: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)))
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isUUID(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function sameUUID(left: unknown, right: string): boolean {
  return isUUID(left) && left.toLowerCase() === right.toLowerCase()
}

function parseFolder(value: unknown): BookmarkFolderMutationPayload | null {
  if (!isRecord(value)) return null
  if (
    !hasExactKeys(value, [
      'avatar_url',
      'created_at',
      'description',
      'id',
      'is_default',
      'is_public',
      'name',
      'post_count',
      'subscriber_count',
      'updated_at',
      'user_id',
    ]) ||
    !isUUID(value.id) ||
    !isUUID(value.user_id) ||
    typeof value.name !== 'string' ||
    value.name.length < 1 ||
    value.name.length > 50 ||
    (value.description !== null && typeof value.description !== 'string') ||
    (value.avatar_url !== null && typeof value.avatar_url !== 'string') ||
    typeof value.is_public !== 'boolean' ||
    typeof value.is_default !== 'boolean' ||
    !isNonNegativeSafeInteger(value.post_count) ||
    !isNonNegativeSafeInteger(value.subscriber_count) ||
    !isNullableTimestamp(value.created_at) ||
    !isNullableTimestamp(value.updated_at)
  ) {
    return null
  }

  return {
    id: value.id.toLowerCase(),
    user_id: value.user_id.toLowerCase(),
    name: value.name,
    description: value.description,
    avatar_url: value.avatar_url,
    is_public: value.is_public,
    is_default: value.is_default,
    post_count: value.post_count,
    subscriber_count: value.subscriber_count,
    created_at: value.created_at,
    updated_at: value.updated_at,
  }
}

export function normalizeBookmarkFolderId(value: string): string | null {
  const normalized = value.toLowerCase()
  return UUID_PATTERN.test(normalized) ? normalized : null
}

export function hasControlCharacters(value: string | null): boolean {
  return value !== null && /[\u0000-\u001f\u007f-\u009f]/u.test(value)
}

export function isBookmarkFolderAuthorityUnavailable(
  error: { code?: string; message?: string } | null
): boolean {
  if (!error) return false
  return (
    error.code === 'PGRST202' ||
    error.code === 'PGRST205' ||
    error.code === '42883' ||
    error.code === '42P01' ||
    !!error.message?.includes('Could not find the table') ||
    !!error.message?.includes('Could not find the function')
  )
}

export function validateBookmarkFolderMutationAck(
  value: unknown,
  expected: {
    action: BookmarkFolderMutationAction
    userId: string
    folderId?: string
  }
): BookmarkFolderMutationAck {
  if (!isRecord(value)) {
    throw new Error('Invalid atomic bookmark folder acknowledgement')
  }

  if (
    hasExactKeys(value, ['status']) &&
    typeof value.status === 'string' &&
    (DENIAL_STATUSES as readonly string[]).includes(value.status)
  ) {
    return { status: value.status as BookmarkFolderDenialStatus }
  }

  const successStatus = expected.action === 'create' ? 'created' : 'updated'
  if (expected.action !== 'delete' && hasExactKeys(value, ['folder', 'status', 'user_id'])) {
    const folder = parseFolder(value.folder)
    if (
      value.status !== successStatus ||
      !sameUUID(value.user_id, expected.userId) ||
      !folder ||
      !sameUUID(folder.user_id, expected.userId) ||
      (expected.action === 'create' &&
        (folder.is_default || folder.post_count !== 0 || folder.subscriber_count !== 0)) ||
      (expected.folderId !== undefined && !sameUUID(folder.id, expected.folderId))
    ) {
      throw new Error('Atomic bookmark folder acknowledgement mismatch')
    }

    return { status: successStatus, userId: (value.user_id as string).toLowerCase(), folder }
  }

  if (
    expected.action === 'delete' &&
    hasExactKeys(value, ['folder_id', 'status', 'user_id']) &&
    value.status === 'deleted' &&
    sameUUID(value.user_id, expected.userId) &&
    isUUID(value.folder_id) &&
    expected.folderId !== undefined &&
    sameUUID(value.folder_id, expected.folderId)
  ) {
    return {
      status: 'deleted',
      userId: (value.user_id as string).toLowerCase(),
      folderId: value.folder_id.toLowerCase(),
    }
  }

  throw new Error('Invalid atomic bookmark folder acknowledgement')
}
