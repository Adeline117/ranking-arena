/**
 * 收藏夹订阅 API
 * POST /api/bookmark-folders/[id]/subscribe - 订阅收藏夹
 * DELETE /api/bookmark-folders/[id]/subscribe - 取消订阅
 * GET /api/bookmark-folders/[id]/subscribe - 检查订阅状态
 */

import { NextRequest } from 'next/server'
import { withAuth, withPublic } from '@/lib/api/middleware'
import { success, handleError } from '@/lib/api/response'

type RouteContext = { params: Promise<{ id: string }> }

function isNoRows(error: { code?: string } | null): boolean {
  return error?.code === 'PGRST116'
}

function validSubscriberCount(count: number | null): count is number {
  return Number.isSafeInteger(count) && Number(count) >= 0
}

// 检查订阅状态（支持已登录和未登录用户）
export async function GET(request: NextRequest, context: RouteContext) {
  const { id: folderId } = await context.params

  const handler = withPublic(
    async ({ user, supabase }) => {
      try {
        if (!user) {
          return success({ is_subscribed: false })
        }

        // 检查是否已订阅
        const { data: subscription, error } = await supabase
          .from('folder_subscriptions')
          .select('id')
          .eq('user_id', user.id)
          .eq('folder_id', folderId)
          .single()

        if (error && !isNoRows(error)) {
          throw error
        }

        return success({ is_subscribed: !!subscription })
      } catch (error: unknown) {
        return handleError(error, 'bookmark-folders/[id]/subscribe GET')
      }
    },
    { name: 'bookmark-folder-subscribe-get', rateLimit: 'read', readsAuth: true }
  )

  return handler(request)
}

// 订阅收藏夹
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: folderId } = await context.params

  const handler = withAuth(
    async ({ user, supabase }) => {
      try {
        // 获取收藏夹信息，检查是否存在、是否公开、是否是自己的
        const { data: folder, error: folderError } = await supabase
          .from('bookmark_folders')
          .select('id, user_id, is_public, name')
          .eq('id', folderId)
          .single()

        if (folderError && !isNoRows(folderError)) {
          throw folderError
        }
        if (!folder) {
          return success({ error: 'Folder not found' }, 404)
        }

        // 不能订阅自己的收藏夹
        if (folder.user_id === user.id) {
          return success({ error: 'Cannot subscribe to your own folder' }, 400)
        }

        // 只能订阅公开的收藏夹
        if (!folder.is_public) {
          return success({ error: 'This folder is not public' }, 403)
        }

        // 检查是否已订阅
        const { data: existing, error: existingError } = await supabase
          .from('folder_subscriptions')
          .select('id')
          .eq('user_id', user.id)
          .eq('folder_id', folderId)
          .single()
        if (existingError && !isNoRows(existingError)) {
          throw existingError
        }

        if (existing) {
          return success({ error: 'Already subscribed to this folder' }, 409)
        }

        // 创建订阅
        const { error: insertError } = await supabase.from('folder_subscriptions').insert({
          user_id: user.id,
          folder_id: folderId,
        })

        if (insertError) {
          if (insertError.code === '23505') {
            return success({ error: 'Already subscribed to this folder' }, 409)
          }
          throw insertError
        }

        // 获取更新后的订阅者数量（如果列存在）
        // KEEP 'exact' — returned to the client as the updated subscriber
        // count right after subscribe; must reflect the new row.
        const { count: subscriberCount, error: countError } = await supabase
          .from('folder_subscriptions')
          .select('id', { count: 'exact', head: true })
          .eq('folder_id', folderId)
        if (countError || !validSubscriberCount(subscriberCount)) {
          throw countError ?? new Error('Invalid folder subscriber count')
        }

        return success(
          {
            message: 'Subscribed successfully',
            is_subscribed: true,
            subscriber_count: Number(subscriberCount),
          },
          201
        )
      } catch (error: unknown) {
        return handleError(error, 'bookmark-folders/[id]/subscribe POST')
      }
    },
    { name: 'bookmark-folder-subscribe-post', rateLimit: 'write' }
  )

  return handler(request)
}

// 取消订阅
export async function DELETE(request: NextRequest, context: RouteContext) {
  const { id: folderId } = await context.params

  const handler = withAuth(
    async ({ user, supabase }) => {
      try {
        // 检查是否已订阅
        const { data: subscription, error: findError } = await supabase
          .from('folder_subscriptions')
          .select('id')
          .eq('user_id', user.id)
          .eq('folder_id', folderId)
          .single()

        if (findError && !isNoRows(findError)) {
          throw findError
        }
        if (!subscription) {
          return success({ error: 'Not subscribed to this folder' }, 404)
        }

        // 删除订阅
        const { error: deleteError } = await supabase
          .from('folder_subscriptions')
          .delete()
          .eq('user_id', user.id)
          .eq('folder_id', folderId)

        if (deleteError) {
          throw deleteError
        }

        // 获取更新后的订阅者数量
        // KEEP 'exact' — same rationale as the POST handler above.
        const { count: subscriberCount, error: countError } = await supabase
          .from('folder_subscriptions')
          .select('id', { count: 'exact', head: true })
          .eq('folder_id', folderId)
        if (countError || !validSubscriberCount(subscriberCount)) {
          throw countError ?? new Error('Invalid folder subscriber count')
        }

        return success({
          message: 'Unsubscribed successfully',
          is_subscribed: false,
          subscriber_count: Number(subscriberCount),
        })
      } catch (error: unknown) {
        return handleError(error, 'bookmark-folders/[id]/subscribe DELETE')
      }
    },
    { name: 'bookmark-folder-subscribe-delete', rateLimit: 'write' }
  )

  return handler(request)
}
