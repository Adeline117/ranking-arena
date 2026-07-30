/**
 * 收藏夹 API
 * GET /api/bookmark-folders - 获取用户的收藏夹列表
 * POST /api/bookmark-folders - 创建新收藏夹
 */

import { withAuth } from '@/lib/api/middleware'
import {
  badRequest,
  conflict,
  error as errorResponse,
  forbidden,
  success,
  handleError,
} from '@/lib/api/response'
import { ErrorCode } from '@/lib/api/errors'
import { validateString, validateBoolean } from '@/lib/api/validation'
import { createUserScopedServerClient } from '@/lib/supabase/user-scoped-server'
import {
  hasControlCharacters,
  isBookmarkFolderAuthorityUnavailable,
  validateBookmarkFolderMutationAck,
} from '@/lib/bookmarks/folder-mutation'
import { parseOwnedBookmarkFoldersRead } from '@/lib/bookmarks/folder-read'

function bookmarkFoldersUnavailable() {
  return errorResponse(
    'Bookmark folders are temporarily unavailable',
    503,
    ErrorCode.SERVICE_UNAVAILABLE
  )
}

export const GET = withAuth(
  async ({ user, supabase, request }) => {
    try {
      // A missing default-folder authority is not an authoritative empty
      // collection. Supabase reports RPC failures in the result rather than
      // throwing, so inspect the error explicitly before reading the list.
      const userSupabase = createUserScopedServerClient(request)
      const { error: ensureDefaultError } = await userSupabase.rpc(
        'ensure_default_bookmark_folder',
        {
          p_user_id: user.id,
        }
      )
      if (ensureDefaultError) {
        if (isBookmarkFolderAuthorityUnavailable(ensureDefaultError)) {
          return bookmarkFoldersUnavailable()
        }
        throw ensureDefaultError
      }

      const { data, error } = await supabase.rpc('read_owned_bookmark_folders_snapshot', {
        p_actor_id: user.id,
      })
      if (error) {
        if (isBookmarkFolderAuthorityUnavailable(error)) return bookmarkFoldersUnavailable()
        throw error
      }

      const snapshot = parseOwnedBookmarkFoldersRead(data, user.id)
      if (snapshot.status === 'actor_inactive') return forbidden('Account is inactive')
      if (snapshot.status !== 'ok') {
        throw new Error('Owned bookmark folders snapshot returned an impossible status')
      }
      return success({ folders: snapshot.folders })
    } catch (error: unknown) {
      return handleError(error, 'bookmark-folders GET')
    }
  },
  { name: 'bookmark-folders-list', rateLimit: 'read' }
)

export const POST = withAuth(
  async ({ user, request }) => {
    try {
      let body: Record<string, unknown>
      try {
        body = await request.json()
      } catch {
        return badRequest('Invalid JSON body')
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return badRequest('Invalid JSON body')
      }

      const name = validateString(body.name, {
        required: true,
        minLength: 1,
        maxLength: 50,
        fieldName: 'folder name',
      })!
      const description = validateString(body.description, { maxLength: 200 })
      const avatar_url = validateString(body.avatar_url, { maxLength: 500 })
      const is_public = validateBoolean(body.is_public) ?? false

      if (
        hasControlCharacters(name) ||
        hasControlCharacters(description) ||
        hasControlCharacters(avatar_url)
      ) {
        return badRequest('Folder fields cannot contain control characters')
      }

      const userSupabase = createUserScopedServerClient(request)
      const { data, error } = await userSupabase.rpc('mutate_bookmark_folder_atomic', {
        p_action: 'create',
        p_folder_id: null,
        p_name: name,
        p_description: description,
        p_avatar_url: avatar_url,
        p_is_public: is_public,
        p_set_name: true,
        p_set_description: true,
        p_set_avatar_url: true,
        p_set_is_public: true,
      })
      if (error) {
        if (isBookmarkFolderAuthorityUnavailable(error)) {
          return bookmarkFoldersUnavailable()
        }
        throw error
      }

      const ack = validateBookmarkFolderMutationAck(data, {
        action: 'create',
        userId: user.id,
      })
      if (ack.status === 'account_inactive') return forbidden('Account is inactive')
      if (ack.status === 'name_conflict') {
        return conflict('A folder with this name already exists')
      }
      if (ack.status !== 'created' || !('folder' in ack)) {
        throw new Error('Atomic bookmark folder create returned an impossible status')
      }

      return success({ folder: ack.folder }, 201)
    } catch (error: unknown) {
      return handleError(error, 'bookmark-folders POST')
    }
  },
  { name: 'bookmark-folders-create', rateLimit: 'write' }
)
