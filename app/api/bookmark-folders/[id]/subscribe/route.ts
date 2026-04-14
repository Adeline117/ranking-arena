/**
 * 收藏夹订阅 API
 * POST /api/bookmark-folders/[id]/subscribe - 订阅收藏夹
 * DELETE /api/bookmark-folders/[id]/subscribe - 取消订阅
 * GET /api/bookmark-folders/[id]/subscribe - 检查订阅状态
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  getAuthUser,
  success,
  handleError,
} from '@/lib/api'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

type RouteContext = { params: Promise<{ id: string }> }

// 检查订阅状态
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id: folderId } = await context.params
    const user = await getAuthUser(request)
    
    if (!user) {
      return success({ is_subscribed: false })
    }

    const supabase = getSupabaseAdmin() as SupabaseClient

    // 检查是否已订阅
    const { data: subscription, error } = await supabase
      .from('folder_subscriptions')
      .select('id')
      .eq('user_id', user.id)
      .eq('folder_id', folderId)
      .single()

    if (error && error.code !== 'PGRST116') {
      // PGRST116 = 没有找到记录，这是正常的
      // 如果表不存在，返回未订阅
      const ignoredCodes = ['42P01', 'PGRST204']
      if (ignoredCodes.includes(error.code || '')) {
        return success({ is_subscribed: false })
      }
      throw error
    }

    return success({ is_subscribed: !!subscription })
  } catch (error: unknown) {
    return handleError(error, 'bookmark-folders/[id]/subscribe GET')
  }
}

// 订阅收藏夹
export async function POST(request: NextRequest, context: RouteContext) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const { id: folderId } = await context.params
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin() as SupabaseClient

    // 获取收藏夹信息，检查是否存在、是否公开、是否是自己的
    const { data: folder, error: folderError } = await supabase
      .from('bookmark_folders')
      .select('id, user_id, is_public, name')
      .eq('id', folderId)
      .single()

    if (folderError || !folder) {
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
    const { data: existing } = await supabase
      .from('folder_subscriptions')
      .select('id')
      .eq('user_id', user.id)
      .eq('folder_id', folderId)
      .single()

    if (existing) {
      return success({ error: 'Already subscribed to this folder' }, 409)
    }

    // 创建订阅
    const { error: insertError } = await supabase
      .from('folder_subscriptions')
      .insert({
        user_id: user.id,
        folder_id: folderId,
      })

    if (insertError) {
      throw insertError
    }

    // 获取更新后的订阅者数量（如果列存在）
    // KEEP 'exact' — returned to the client as the updated subscriber
    // count right after subscribe; must reflect the new row.
    let subscriberCount = 0
    try {
      const { count } = await supabase
        .from('folder_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('folder_id', folderId)
      subscriberCount = count || 0
    } catch {
      // subscriber_count 列可能不存在，忽略错误
    }

    return success({
      message: 'Subscribed successfully',
      is_subscribed: true,
      subscriber_count: subscriberCount,
    }, 201)
  } catch (error: unknown) {
    return handleError(error, 'bookmark-folders/[id]/subscribe POST')
  }
}

// 取消订阅
export async function DELETE(request: NextRequest, context: RouteContext) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const { id: folderId } = await context.params
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin() as SupabaseClient

    // 检查是否已订阅
    const { data: subscription, error: findError } = await supabase
      .from('folder_subscriptions')
      .select('id')
      .eq('user_id', user.id)
      .eq('folder_id', folderId)
      .single()

    if (findError || !subscription) {
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
    let subscriberCount = 0
    try {
      const { count } = await supabase
        .from('folder_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('folder_id', folderId)
      subscriberCount = count || 0
    } catch {
      // Intentionally swallowed: subscriber count query failed, return 0 as default
    }

    return success({
      message: 'Unsubscribed successfully',
      is_subscribed: false,
      subscriber_count: subscriberCount,
    })
  } catch (error: unknown) {
    return handleError(error, 'bookmark-folders/[id]/subscribe DELETE')
  }
}
