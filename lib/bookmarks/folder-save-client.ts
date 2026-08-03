import { authedFetch, type AuthedFetchScope, type ScopedFetchResult } from '@/lib/api/client'
import {
  readBookmarkFolderSaveResponse,
  type BookmarkFolderSaveAck,
} from '@/lib/bookmarks/folder-save'

const BOOKMARK_FOLDER_SAVE_TIMEOUT_MS = 8_000
const MAX_BOOKMARK_FOLDER_SAVE_ATTEMPTS = 2

type BookmarkFolderSaveSuccess = Exclude<
  BookmarkFolderSaveAck,
  { status: 'invalid' | 'account_inactive' | 'post_not_found' | 'folder_not_found' }
>

export type BookmarkFolderSaveResult =
  | { ok: true; acknowledgement: BookmarkFolderSaveSuccess }
  | { ok: false; status: number; error: string | null; stale: boolean }

function readError(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const error = (value as Record<string, unknown>).error
  return typeof error === 'string' ? error : null
}

export async function savePostToBookmarkFolder(
  input: {
    accessToken: string
    userId: string
    postId: string
    folderId: string
    sessionGeneration: number
  },
  signal?: AbortSignal
): Promise<BookmarkFolderSaveResult> {
  const scope: AuthedFetchScope = {
    expectedUserId: input.userId,
    expectedSessionGeneration: input.sessionGeneration,
    signal,
  }
  let response: ScopedFetchResult<unknown> | null = null

  for (let attempt = 0; attempt < MAX_BOOKMARK_FOLDER_SAVE_ATTEMPTS; attempt += 1) {
    try {
      response = await authedFetch<unknown>(
        `/api/posts/${encodeURIComponent(input.postId)}/bookmark`,
        'POST',
        input.accessToken,
        { folder_id: input.folderId },
        BOOKMARK_FOLDER_SAVE_TIMEOUT_MS,
        scope
      )
    } catch {
      response = { ok: false, status: 0, data: null }
    }

    if (response.stale || response.status !== 0 || signal?.aborted) break
  }

  if (!response || response.stale) {
    return { ok: false, status: 0, error: null, stale: true }
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: readError(response.data),
      stale: false,
    }
  }

  const acknowledgement = readBookmarkFolderSaveResponse(response.data, {
    userId: input.userId,
    postId: input.postId,
    folderId: input.folderId,
  })
  if (!acknowledgement) {
    return { ok: false, status: 502, error: null, stale: false }
  }

  return { ok: true, acknowledgement }
}
