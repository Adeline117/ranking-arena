const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DENIAL_STATUSES = [
  'invalid',
  'account_inactive',
  'post_not_found',
  'folder_not_found',
] as const

export type BookmarkFolderSaveDenialStatus = (typeof DENIAL_STATUSES)[number]
export type BookmarkFolderSaveSuccessStatus = 'added' | 'moved' | 'already_saved'

export type BookmarkFolderSaveAck =
  | { status: BookmarkFolderSaveDenialStatus }
  | {
      status: BookmarkFolderSaveSuccessStatus
      user_id: string
      post_id: string
      bookmark_id: string
      folder_id: string
      bookmarked: true
      bookmark_count: number
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isUUID(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function sameUUID(value: unknown, expected: string): value is string {
  return isUUID(value) && value.toLowerCase() === expected.toLowerCase()
}

export function validateBookmarkFolderSaveAck(
  value: unknown,
  expected: { userId: string; postId: string; folderId: string }
): BookmarkFolderSaveAck {
  if (!isRecord(value)) {
    throw new Error('Invalid atomic bookmark folder save acknowledgement')
  }

  if (
    hasExactKeys(value, ['status']) &&
    typeof value.status === 'string' &&
    (DENIAL_STATUSES as readonly string[]).includes(value.status)
  ) {
    return { status: value.status as BookmarkFolderSaveDenialStatus }
  }

  if (
    !hasExactKeys(value, [
      'bookmark_count',
      'bookmark_id',
      'bookmarked',
      'folder_id',
      'post_id',
      'status',
      'user_id',
    ]) ||
    (value.status !== 'added' && value.status !== 'moved' && value.status !== 'already_saved') ||
    !sameUUID(value.user_id, expected.userId) ||
    !sameUUID(value.post_id, expected.postId) ||
    !isUUID(value.bookmark_id) ||
    !sameUUID(value.folder_id, expected.folderId) ||
    value.bookmarked !== true ||
    !Number.isSafeInteger(value.bookmark_count) ||
    Number(value.bookmark_count) < 0
  ) {
    throw new Error('Atomic bookmark folder save acknowledgement mismatch')
  }

  return {
    status: value.status,
    user_id: value.user_id.toLowerCase(),
    post_id: value.post_id.toLowerCase(),
    bookmark_id: value.bookmark_id.toLowerCase(),
    folder_id: value.folder_id.toLowerCase(),
    bookmarked: true,
    bookmark_count: value.bookmark_count as number,
  }
}

export function readBookmarkFolderSaveResponse(
  value: unknown,
  expected: { userId: string; postId: string; folderId: string }
): Exclude<BookmarkFolderSaveAck, { status: BookmarkFolderSaveDenialStatus }> | null {
  try {
    const acknowledgement = validateBookmarkFolderSaveAck(value, expected)
    return DENIAL_STATUSES.includes(acknowledgement.status as (typeof DENIAL_STATUSES)[number])
      ? null
      : (acknowledgement as Exclude<
          BookmarkFolderSaveAck,
          { status: BookmarkFolderSaveDenialStatus }
        >)
  } catch {
    return null
  }
}
