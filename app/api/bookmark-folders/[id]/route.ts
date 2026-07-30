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
import {
  hasControlCharacters,
  isBookmarkFolderAuthorityUnavailable,
  normalizeBookmarkFolderId,
  validateBookmarkFolderMutationAck,
} from '@/lib/bookmarks/folder-mutation'

type RouteContext = { params: Promise<{ id: string }> }

function isNoRows(error: { code?: string } | null): boolean {
  return error?.code === 'PGRST116'
}

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

        // 获取收藏夹信息
        const { data: folder, error: folderError } = await supabase
          .from('bookmark_folders')
          .select(
            'id, user_id, name, description, avatar_url, is_public, is_default, post_count, created_at'
          )
          .eq('id', folderId)
          .single()

        if (folderError && !isNoRows(folderError)) {
          throw folderError
        }
        if (!folder) {
          return success({ error: 'Folder not found' }, 404)
        }

        // 检查访问权限 before touching child rows.
        const isOwner = user?.id === folder.user_id
        if (!folder.is_public && !isOwner) {
          return success({ error: 'No permission to access this folder' }, 403)
        }

        // 获取订阅者数量（通过计数订阅表）
        // KEEP 'exact' — displayed as the exact subscriber count on the
        // folder page. Scoped via (folder_id) index → cheap.
        const { count: subscriberCount, error: subscriberCountError } = await supabase
          .from('folder_subscriptions')
          .select('id', { count: 'exact', head: true })
          .eq('folder_id', folderId)
        if (
          subscriberCountError ||
          !Number.isSafeInteger(subscriberCount) ||
          Number(subscriberCount) < 0
        ) {
          throw subscriberCountError ?? new Error('Invalid folder subscriber count')
        }

        // 检查当前用户是否已订阅此收藏夹
        let isSubscribed = false
        if (user && !isOwner && folder.is_public) {
          const { data: subscription, error: subscriptionError } = await supabase
            .from('folder_subscriptions')
            .select('id')
            .eq('user_id', user.id)
            .eq('folder_id', folderId)
            .single()
          if (subscriptionError && !isNoRows(subscriptionError)) {
            throw subscriptionError
          }
          isSubscribed = !!subscription
        }

        // 获取收藏夹中的帖子
        const { data: bookmarks, error: bookmarksError } = await supabase
          .from('post_bookmarks')
          .select(
            `
            id,
            post_id,
            created_at,
            posts (
              id,
              title,
              content,
              author_id,
              author_handle,
              group_id,
              like_count,
              comment_count,
              bookmark_count,
              created_at
            )
          `
          )
          .eq('folder_id', folderId)
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1)

        if (bookmarksError) {
          throw bookmarksError
        }
        if (!Array.isArray(bookmarks)) {
          throw new Error('Invalid bookmark folder post result')
        }

        // GET is read-only. Physical post deletion is already protected by the
        // post_bookmarks FK cascade; treating a null embedded post as an
        // orphan here could delete data merely hidden by post audience RLS and
        // race the canonical bookmark counter trigger.
        const posts = bookmarks
          .map((b) => {
            const rawPost: unknown = b.posts
            if (!rawPost || typeof rawPost !== 'object' || Array.isArray(rawPost)) {
              return null
            }
            const post = rawPost as Record<string, unknown>
            if (!post.id) return null
            return {
              bookmark_id: b.id,
              bookmarked_at: b.created_at,
              ...post,
            }
          })
          .filter((p): p is NonNullable<typeof p> => p !== null)

        // 获取收藏夹所有者的信息
        const { data: owner, error: ownerError } = await supabase
          .from('user_profiles')
          .select('handle, avatar_url')
          .eq('id', folder.user_id)
          .single()
        if (ownerError && !isNoRows(ownerError)) {
          throw ownerError
        }

        return success({
          folder: {
            ...folder,
            subscriber_count: Number(subscriberCount),
            owner_handle: owner?.handle,
            owner_avatar_url: owner?.avatar_url,
          },
          posts,
          is_owner: isOwner,
          is_subscribed: isSubscribed,
          pagination: {
            limit,
            offset,
            has_more: posts.length === limit,
          },
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
    async ({ user, supabase, request: req }) => {
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

        const { data, error } = await supabase.rpc('mutate_bookmark_folder_atomic', {
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
    async ({ user, supabase }) => {
      try {
        if (!folderId) return badRequest('Invalid folder id')

        const { data, error } = await supabase.rpc('mutate_bookmark_folder_atomic', {
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
