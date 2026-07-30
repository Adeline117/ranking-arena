import { normalizeBookmarkFolderId } from './folder-mutation'

export type BookmarkFolderSnapshot = {
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

export type SubscribedBookmarkFolderSnapshot = BookmarkFolderSnapshot & {
  owner_id: string
  owner_handle: string | null
  owner_avatar_url: string | null
  subscribed_at: string
}

export type BookmarkFolderDetailSnapshot = BookmarkFolderSnapshot & {
  owner_handle: string | null
  owner_avatar_url: string | null
}

export type BookmarkFolderPostSnapshot = {
  bookmark_id: string
  bookmarked_at: string
  id: string
  title: string
  content: string | null
  author_id: string
  author_handle: string | null
  group_id: string | null
  like_count: number | null
  comment_count: number | null
  bookmark_count: number | null
  created_at: string
}

export type BookmarkFolderPagination = {
  limit: number
  offset: number
  has_more: boolean
}

type ReadDenial = { status: 'invalid' | 'actor_inactive' }

export type OwnedBookmarkFoldersRead =
  | ReadDenial
  | { status: 'ok'; actorId: string; folders: BookmarkFolderSnapshot[] }

export type SubscribedBookmarkFoldersRead =
  | ReadDenial
  | {
      status: 'ok'
      actorId: string
      folders: SubscribedBookmarkFolderSnapshot[]
      pagination: BookmarkFolderPagination
    }

export type ProfileBookmarkFoldersRead =
  | ReadDenial
  | { status: 'profile_not_found' }
  | {
      status: 'ok'
      actorId: string | null
      profileId: string
      includePrivate: boolean
      folders: BookmarkFolderSnapshot[]
    }

export type BookmarkFolderDetailRead =
  | ReadDenial
  | { status: 'folder_not_found' | 'folder_forbidden' }
  | {
      status: 'ok'
      actorId: string | null
      folder: BookmarkFolderDetailSnapshot
      posts: BookmarkFolderPostSnapshot[]
      isOwner: boolean
      isSubscribed: boolean
      pagination: BookmarkFolderPagination
    }

const FOLDER_KEYS = [
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
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function normalizedUUID(value: unknown): string | null {
  return typeof value === 'string' ? normalizeBookmarkFolderId(value) : null
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)))
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isSafeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function parseDenial<T extends string>(value: unknown, statuses: readonly T[]): T | null {
  if (!isRecord(value) || !hasExactKeys(value, ['status'])) return null
  return typeof value.status === 'string' && (statuses as readonly string[]).includes(value.status)
    ? (value.status as T)
    : null
}

function parseFolder(value: unknown): BookmarkFolderSnapshot | null {
  if (!isRecord(value) || !hasExactKeys(value, FOLDER_KEYS)) return null
  const id = normalizedUUID(value.id)
  const userId = normalizedUUID(value.user_id)
  if (
    !id ||
    !userId ||
    typeof value.name !== 'string' ||
    value.name.length < 1 ||
    value.name.length > 50 ||
    (value.description !== null && typeof value.description !== 'string') ||
    (value.avatar_url !== null && typeof value.avatar_url !== 'string') ||
    typeof value.is_public !== 'boolean' ||
    typeof value.is_default !== 'boolean' ||
    !isSafeCount(value.post_count) ||
    !isSafeCount(value.subscriber_count) ||
    !isNullableTimestamp(value.created_at) ||
    !isNullableTimestamp(value.updated_at)
  ) {
    return null
  }
  return {
    id,
    user_id: userId,
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

function parseFolders(value: unknown): BookmarkFolderSnapshot[] | null {
  if (!Array.isArray(value)) return null
  const folders = value.map(parseFolder)
  if (folders.some((folder) => folder === null)) return null
  const parsed = folders as BookmarkFolderSnapshot[]
  return new Set(parsed.map((folder) => folder.id)).size === parsed.length ? parsed : null
}

function parsePagination(
  value: unknown,
  expected: { limit: number; offset: number }
): BookmarkFolderPagination | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['has_more', 'limit', 'offset']) ||
    value.limit !== expected.limit ||
    value.offset !== expected.offset ||
    typeof value.has_more !== 'boolean'
  ) {
    return null
  }
  return { limit: expected.limit, offset: expected.offset, has_more: value.has_more }
}

function parseActor(value: unknown, expectedActorId: string | null): string | null | undefined {
  if (expectedActorId === null) return value === null ? null : undefined
  const actorId = normalizedUUID(value)
  return actorId === normalizeBookmarkFolderId(expectedActorId) ? actorId : undefined
}

export function parseOwnedBookmarkFoldersRead(
  value: unknown,
  expectedActorId: string
): OwnedBookmarkFoldersRead {
  const denial = parseDenial(value, ['invalid', 'actor_inactive'] as const)
  if (denial) return { status: denial }
  if (!isRecord(value) || !hasExactKeys(value, ['actor_id', 'folders', 'status'])) {
    throw new Error('Invalid owned bookmark folders snapshot')
  }
  const actorId = parseActor(value.actor_id, expectedActorId)
  const folders = parseFolders(value.folders)
  if (
    value.status !== 'ok' ||
    actorId === undefined ||
    actorId === null ||
    !folders ||
    folders.some((folder) => folder.user_id !== actorId) ||
    folders.filter((folder) => folder.is_default).length > 1
  ) {
    throw new Error('Owned bookmark folders snapshot mismatch')
  }
  return { status: 'ok', actorId, folders }
}

export function parseSubscribedBookmarkFoldersRead(
  value: unknown,
  expected: { actorId: string; limit: number; offset: number }
): SubscribedBookmarkFoldersRead {
  const denial = parseDenial(value, ['invalid', 'actor_inactive'] as const)
  if (denial) return { status: denial }
  if (!isRecord(value) || !hasExactKeys(value, ['actor_id', 'folders', 'pagination', 'status'])) {
    throw new Error('Invalid subscribed bookmark folders snapshot')
  }
  const actorId = parseActor(value.actor_id, expected.actorId)
  const pagination = parsePagination(value.pagination, expected)
  if (value.status !== 'ok' || actorId === undefined || actorId === null || !pagination) {
    throw new Error('Subscribed bookmark folders snapshot mismatch')
  }
  if (!Array.isArray(value.folders)) {
    throw new Error('Invalid subscribed bookmark folders snapshot')
  }
  const folders = value.folders.map((rawFolder) => {
    if (!isRecord(rawFolder)) return null
    const base = parseFolder(Object.fromEntries(FOLDER_KEYS.map((key) => [key, rawFolder[key]])))
    const ownerId = normalizedUUID(rawFolder.owner_id)
    if (
      !hasExactKeys(rawFolder, [
        ...FOLDER_KEYS,
        'owner_avatar_url',
        'owner_handle',
        'owner_id',
        'subscribed_at',
      ]) ||
      !base ||
      !ownerId ||
      ownerId !== base.user_id ||
      ownerId === actorId ||
      base.is_public !== true ||
      base.subscriber_count < 1 ||
      (rawFolder.owner_handle !== null && typeof rawFolder.owner_handle !== 'string') ||
      (rawFolder.owner_avatar_url !== null && typeof rawFolder.owner_avatar_url !== 'string') ||
      !isTimestamp(rawFolder.subscribed_at)
    ) {
      return null
    }
    return {
      ...base,
      owner_id: ownerId,
      owner_handle: rawFolder.owner_handle,
      owner_avatar_url: rawFolder.owner_avatar_url,
      subscribed_at: rawFolder.subscribed_at,
    }
  })
  if (
    folders.some((folder) => folder === null) ||
    new Set(folders.map((folder) => folder?.id)).size !== folders.length ||
    folders.length > expected.limit ||
    (pagination.has_more && folders.length !== expected.limit)
  ) {
    throw new Error('Invalid subscribed bookmark folders snapshot')
  }
  return {
    status: 'ok',
    actorId,
    folders: folders as SubscribedBookmarkFolderSnapshot[],
    pagination,
  }
}

export function parseProfileBookmarkFoldersRead(
  value: unknown,
  expected: { actorId: string | null; profileId: string; includePrivate: boolean }
): ProfileBookmarkFoldersRead {
  const denial = parseDenial(value, ['invalid', 'actor_inactive', 'profile_not_found'] as const)
  if (denial) return { status: denial }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['actor_id', 'folders', 'include_private', 'profile_id', 'status'])
  ) {
    throw new Error('Invalid profile bookmark folders snapshot')
  }
  const actorId = parseActor(value.actor_id, expected.actorId)
  const profileId = normalizedUUID(value.profile_id)
  const folders = parseFolders(value.folders)
  if (
    value.status !== 'ok' ||
    actorId === undefined ||
    !profileId ||
    profileId !== normalizeBookmarkFolderId(expected.profileId) ||
    value.include_private !== expected.includePrivate ||
    !folders ||
    folders.some(
      (folder) =>
        folder.user_id !== profileId || (!expected.includePrivate && folder.is_public !== true)
    )
  ) {
    throw new Error('Profile bookmark folders snapshot mismatch')
  }
  return {
    status: 'ok',
    actorId,
    profileId,
    includePrivate: expected.includePrivate,
    folders,
  }
}

function parseDetailFolder(value: unknown): BookmarkFolderDetailSnapshot | null {
  if (!isRecord(value)) return null
  const base = parseFolder(Object.fromEntries(FOLDER_KEYS.map((key) => [key, value[key]])))
  if (
    !hasExactKeys(value, [...FOLDER_KEYS, 'owner_avatar_url', 'owner_handle']) ||
    !base ||
    (value.owner_handle !== null && typeof value.owner_handle !== 'string') ||
    (value.owner_avatar_url !== null && typeof value.owner_avatar_url !== 'string')
  ) {
    return null
  }
  return {
    ...base,
    owner_handle: value.owner_handle,
    owner_avatar_url: value.owner_avatar_url,
  }
}

function parsePost(value: unknown): BookmarkFolderPostSnapshot | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'author_handle',
      'author_id',
      'bookmark_count',
      'bookmark_id',
      'bookmarked_at',
      'comment_count',
      'content',
      'created_at',
      'group_id',
      'id',
      'like_count',
      'title',
    ])
  ) {
    return null
  }
  const bookmarkId = normalizedUUID(value.bookmark_id)
  const id = normalizedUUID(value.id)
  const authorId = normalizedUUID(value.author_id)
  const groupId = value.group_id === null ? null : normalizedUUID(value.group_id)
  if (
    !bookmarkId ||
    !id ||
    !authorId ||
    (value.group_id !== null && !groupId) ||
    !isTimestamp(value.bookmarked_at) ||
    typeof value.title !== 'string' ||
    (value.content !== null && typeof value.content !== 'string') ||
    (value.author_handle !== null && typeof value.author_handle !== 'string') ||
    (value.like_count !== null && !isSafeCount(value.like_count)) ||
    (value.comment_count !== null && !isSafeCount(value.comment_count)) ||
    (value.bookmark_count !== null && !isSafeCount(value.bookmark_count)) ||
    !isTimestamp(value.created_at)
  ) {
    return null
  }
  return {
    bookmark_id: bookmarkId,
    bookmarked_at: value.bookmarked_at,
    id,
    title: value.title,
    content: value.content,
    author_id: authorId,
    author_handle: value.author_handle,
    group_id: groupId,
    like_count: value.like_count,
    comment_count: value.comment_count,
    bookmark_count: value.bookmark_count,
    created_at: value.created_at,
  }
}

export function parseBookmarkFolderDetailRead(
  value: unknown,
  expected: { actorId: string | null; folderId: string; limit: number; offset: number }
): BookmarkFolderDetailRead {
  const denial = parseDenial(value, [
    'invalid',
    'actor_inactive',
    'folder_not_found',
    'folder_forbidden',
  ] as const)
  if (denial) return { status: denial }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'actor_id',
      'folder',
      'is_owner',
      'is_subscribed',
      'pagination',
      'posts',
      'status',
    ])
  ) {
    throw new Error('Invalid bookmark folder detail snapshot')
  }
  const actorId = parseActor(value.actor_id, expected.actorId)
  const folder = parseDetailFolder(value.folder)
  const pagination = parsePagination(value.pagination, expected)
  const posts = Array.isArray(value.posts) ? value.posts.map(parsePost) : null
  const expectedFolderId = normalizeBookmarkFolderId(expected.folderId)
  if (
    value.status !== 'ok' ||
    actorId === undefined ||
    !folder ||
    !expectedFolderId ||
    folder.id !== expectedFolderId ||
    !pagination ||
    !posts ||
    posts.some((post) => post === null) ||
    typeof value.is_owner !== 'boolean' ||
    typeof value.is_subscribed !== 'boolean'
  ) {
    throw new Error('Bookmark folder detail snapshot mismatch')
  }
  const parsedPosts = posts as BookmarkFolderPostSnapshot[]
  const isOwner = actorId !== null && actorId === folder.user_id
  if (
    value.is_owner !== isOwner ||
    (isOwner && value.is_subscribed) ||
    (!folder.is_public && !isOwner) ||
    (!folder.is_public && value.is_subscribed) ||
    (value.is_subscribed && (actorId === null || folder.subscriber_count < 1)) ||
    parsedPosts.length > expected.limit ||
    new Set(parsedPosts.map((post) => post.bookmark_id)).size !== parsedPosts.length ||
    new Set(parsedPosts.map((post) => post.id)).size !== parsedPosts.length ||
    (pagination.has_more &&
      (parsedPosts.length !== expected.limit ||
        folder.post_count <= expected.offset + expected.limit)) ||
    (!pagination.has_more &&
      parsedPosts.length > 0 &&
      folder.post_count !== expected.offset + parsedPosts.length) ||
    (!pagination.has_more && parsedPosts.length === 0 && folder.post_count > expected.offset)
  ) {
    throw new Error('Invalid bookmark folder detail snapshot state')
  }
  return {
    status: 'ok',
    actorId,
    folder,
    posts: parsedPosts,
    isOwner,
    isSubscribed: value.is_subscribed,
    pagination,
  }
}
