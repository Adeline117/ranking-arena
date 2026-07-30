/**
 * 收藏夹详情 API
 * GET /api/bookmark-folders/[id] - 获取收藏夹详情和帖子列表
 * PATCH /api/bookmark-folders/[id] - 更新收藏夹信息
 * DELETE /api/bookmark-folders/[id] - 删除收藏夹
 */

import { NextRequest } from 'next/server'
import { withAuth, withPublic } from '@/lib/api/middleware'
import { success, badRequest, handleError } from '@/lib/api/response'
import { validateString, validateBoolean, validateNumber } from '@/lib/api/validation'

type RouteContext = { params: Promise<{ id: string }> }

function isNoRows(error: { code?: string } | null): boolean {
  return error?.code === 'PGRST116'
}

// 获取收藏夹详情和帖子列表
export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params

  const handler = withPublic(
    async ({ user, supabase, request: req }) => {
      try {
        const { searchParams } = new URL(req.url)

        const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 50 }) ?? 20
        const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0

        // 获取收藏夹信息
        const { data: folder, error: folderError } = await supabase
          .from('bookmark_folders')
          .select(
            'id, user_id, name, description, avatar_url, is_public, is_default, post_count, created_at'
          )
          .eq('id', id)
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
          .eq('folder_id', id)
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
            .eq('folder_id', id)
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
          .eq('folder_id', id)
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

  const handler = withAuth(
    async ({ user, supabase, request: req }) => {
      try {
        // 检查收藏夹是否存在且属于当前用户
        const { data: folder, error: folderError } = await supabase
          .from('bookmark_folders')
          .select('id, user_id, is_default')
          .eq('id', id)
          .single()

        if (folderError && !isNoRows(folderError)) {
          throw folderError
        }
        if (!folder) {
          return success({ error: 'Folder not found' }, 404)
        }

        if (folder.user_id !== user.id) {
          return success({ error: 'No permission to modify this folder' }, 403)
        }

        let body: Record<string, unknown>
        try {
          body = await req.json()
        } catch {
          return badRequest('Invalid JSON body')
        }

        const updateData: Record<string, string | boolean | null> = {}

        // 验证并添加更新字段
        const name = validateString(body.name, { minLength: 1, maxLength: 50 })
        if (name !== undefined) {
          // 默认收藏夹不能修改名称
          if (folder.is_default) {
            return success({ error: 'Cannot rename the default folder' }, 400)
          }
          updateData.name = name
        }

        const description = validateString(body.description, { maxLength: 200 })
        if (description !== undefined) {
          updateData.description = description
        }

        const avatar_url = validateString(body.avatar_url, { maxLength: 500 })
        if (avatar_url !== undefined) {
          updateData.avatar_url = avatar_url
        }

        const is_public = validateBoolean(body.is_public)
        if (is_public !== undefined) {
          updateData.is_public = is_public
        }

        if (Object.keys(updateData).length === 0) {
          return success({ error: 'Nothing to update' }, 400)
        }

        updateData.updated_at = new Date().toISOString()

        // 执行更新
        const { data: updatedFolder, error: updateError } = await supabase
          .from('bookmark_folders')
          .update(updateData)
          .eq('id', id)
          .select()
          .single()

        if (updateError) {
          if (updateError.code === '23505') {
            return success({ error: 'A folder with this name already exists' }, 409)
          }
          throw updateError
        }

        return success({ folder: updatedFolder })
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

  const handler = withAuth(
    async ({ user, supabase }) => {
      try {
        // 检查收藏夹是否存在且属于当前用户
        const { data: folder, error: folderError } = await supabase
          .from('bookmark_folders')
          .select('id, user_id, is_default')
          .eq('id', id)
          .single()

        if (folderError && !isNoRows(folderError)) {
          throw folderError
        }
        if (!folder) {
          return success({ error: 'Folder not found' }, 404)
        }

        if (folder.user_id !== user.id) {
          return success({ error: 'No permission to delete this folder' }, 403)
        }

        // 默认收藏夹不能删除
        if (folder.is_default) {
          return success({ error: 'Cannot delete the default folder' }, 400)
        }

        // 删除收藏夹（收藏记录会通过 CASCADE 自动删除）
        const { error: deleteError } = await supabase.from('bookmark_folders').delete().eq('id', id)

        if (deleteError) {
          throw deleteError
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
