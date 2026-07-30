/**
 * 收藏夹详情 API
 * GET /api/bookmark-folders/[id] - 获取收藏夹详情和帖子列表
 * PATCH /api/bookmark-folders/[id] - 更新收藏夹信息
 * DELETE /api/bookmark-folders/[id] - 删除收藏夹
 */

import { NextRequest } from 'next/server'
import { withAuth, withPublic } from '@/lib/api/middleware'
import {
  badRequest,
  conflict,
  error as errorResponse,
  forbidden,
  handleError,
  notFound,
  success,
} from '@/lib/api/response'
import { ErrorCode } from '@/lib/api/errors'
import { validateString, validateBoolean, validateNumber } from '@/lib/api/validation'
import { createUserScopedServerClient } from '@/lib/supabase/user-scoped-server'
import {
  hasControlCharacters,
  isBookmarkFolderAuthorityUnavailable,
  normalizeBookmarkFolderId,
  validateBookmarkFolderMutationAck,
} from '@/lib/bookmarks/folder-mutation'
import { parseBookmarkFolderDetailRead } from '@/lib/bookmarks/folder-read'

type RouteContext = { params: Promise<{ id: string }> }

// 获取收藏夹详情和帖子列表
export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const folderId = normalizeBookmarkFolderId(id)

  const handler = withPublic(
    async ({ user, supabase, request: req }) => {
      try {
        if (!folderId) return badRequest('Invalid folder id')

        const { searchParams } = new URL(req.url)

        const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 50 }) ?? 20
        const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0

        const { data, error } = await supabase.rpc('read_bookmark_folder_detail_snapshot', {
          p_actor_id: user?.id ?? null,
          p_folder_id: folderId,
          p_limit: limit,
          p_offset: offset,
        })
        if (error) {
          if (isBookmarkFolderAuthorityUnavailable(error)) {
            return errorResponse(
              'Bookmark folders are temporarily unavailable',
              503,
              ErrorCode.SERVICE_UNAVAILABLE
            )
          }
          throw error
        }

        const snapshot = parseBookmarkFolderDetailRead(data, {
          actorId: user?.id ?? null,
          folderId,
          limit,
          offset,
        })
        if (snapshot.status === 'actor_inactive') return forbidden('Account is inactive')
        if (snapshot.status === 'folder_not_found') return notFound('Folder not found')
        if (snapshot.status === 'folder_forbidden') {
          return forbidden('No permission to access this folder')
        }
        if (snapshot.status !== 'ok') {
          throw new Error('Bookmark folder detail snapshot returned an impossible status')
        }

        return success({
          folder: snapshot.folder,
          posts: snapshot.posts,
          is_owner: snapshot.isOwner,
          is_subscribed: snapshot.isSubscribed,
          pagination: snapshot.pagination,
        })
      } catch (error: unknown) {
        return handleError(error, 'bookmark-folders/[id] GET')
      }
    },
    { name: 'bookmark-folder-detail', rateLimit: 'read', readsAuth: true }
  )

  return handler(request)
}

// 更新收藏夹信息
export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const folderId = normalizeBookmarkFolderId(id)

  const handler = withAuth(
    async ({ user, request: req }) => {
      try {
        if (!folderId) return badRequest('Invalid folder id')

        let body: Record<string, unknown>
        try {
          body = await req.json()
        } catch {
          return badRequest('Invalid JSON body')
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return badRequest('Invalid JSON body')
        }

        const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key)
        const setName = has('name')
        const setDescription = has('description')
        const setAvatarUrl = has('avatar_url')
        const setIsPublic = has('is_public')
        if (!setName && !setDescription && !setAvatarUrl && !setIsPublic) {
          return badRequest('Nothing to update')
        }

        const name = setName
          ? validateString(body.name, {
              required: true,
              minLength: 1,
              maxLength: 50,
              fieldName: 'folder name',
            })!
          : null
        const description = setDescription
          ? validateString(body.description, { maxLength: 200, fieldName: 'description' })
          : null
        const avatarUrl = setAvatarUrl
          ? validateString(body.avatar_url, { maxLength: 500, fieldName: 'avatar_url' })
          : null
        const isPublic = setIsPublic
          ? validateBoolean(body.is_public, { required: true, fieldName: 'is_public' })!
          : null

        if (
          hasControlCharacters(name) ||
          hasControlCharacters(description) ||
          hasControlCharacters(avatarUrl)
        ) {
          return badRequest('Folder fields cannot contain control characters')
        }

        const userSupabase = createUserScopedServerClient(req)
        const { data, error } = await userSupabase.rpc('mutate_bookmark_folder_atomic', {
          p_action: 'update',
          p_folder_id: folderId,
          p_name: name,
          p_description: description,
          p_avatar_url: avatarUrl,
          p_is_public: isPublic,
          p_set_name: setName,
          p_set_description: setDescription,
          p_set_avatar_url: setAvatarUrl,
          p_set_is_public: setIsPublic,
        })
        if (error) {
          if (isBookmarkFolderAuthorityUnavailable(error)) {
            return errorResponse(
              'Bookmark folders are temporarily unavailable',
              503,
              ErrorCode.SERVICE_UNAVAILABLE
            )
          }
          throw error
        }

        const ack = validateBookmarkFolderMutationAck(data, {
          action: 'update',
          userId: user.id,
          folderId,
        })
        if (ack.status === 'account_inactive') return forbidden('Account is inactive')
        if (ack.status === 'folder_not_found') return notFound('Folder not found')
        if (ack.status === 'folder_forbidden') {
          return forbidden('No permission to modify this folder')
        }
        if (ack.status === 'default_protected') {
          return badRequest('Cannot rename the default folder')
        }
        if (ack.status === 'name_conflict') {
          return conflict('A folder with this name already exists')
        }
        if (ack.status !== 'updated' || !('folder' in ack)) {
          throw new Error('Atomic bookmark folder update returned an impossible status')
        }

        return success({ folder: ack.folder })
      } catch (error: unknown) {
        return handleError(error, 'bookmark-folders/[id] PATCH')
      }
    },
    { name: 'bookmark-folder-patch', rateLimit: 'write' }
  )

  return handler(request)
}

// 删除收藏夹
export async function DELETE(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const folderId = normalizeBookmarkFolderId(id)

  const handler = withAuth(
    async ({ user, request: req }) => {
      try {
        if (!folderId) return badRequest('Invalid folder id')

        const userSupabase = createUserScopedServerClient(req)
        const { data, error } = await userSupabase.rpc('mutate_bookmark_folder_atomic', {
          p_action: 'delete',
          p_folder_id: folderId,
          p_name: null,
          p_description: null,
          p_avatar_url: null,
          p_is_public: null,
          p_set_name: false,
          p_set_description: false,
          p_set_avatar_url: false,
          p_set_is_public: false,
        })
        if (error) {
          if (isBookmarkFolderAuthorityUnavailable(error)) {
            return errorResponse(
              'Bookmark folders are temporarily unavailable',
              503,
              ErrorCode.SERVICE_UNAVAILABLE
            )
          }
          throw error
        }

        const ack = validateBookmarkFolderMutationAck(data, {
          action: 'delete',
          userId: user.id,
          folderId,
        })
        if (ack.status === 'account_inactive') return forbidden('Account is inactive')
        if (ack.status === 'folder_not_found') return notFound('Folder not found')
        if (ack.status === 'folder_forbidden') {
          return forbidden('No permission to delete this folder')
        }
        if (ack.status === 'default_protected') {
          return badRequest('Cannot delete the default folder')
        }
        if (ack.status !== 'deleted') {
          throw new Error('Atomic bookmark folder delete returned an impossible status')
        }

        return success({ message: 'Folder deleted' })
      } catch (error: unknown) {
        return handleError(error, 'bookmark-folders/[id] DELETE')
      }
    },
    { name: 'bookmark-folder-delete', rateLimit: 'write' }
  )

  return handler(request)
}
