/**
 * 已订阅收藏夹 API
 * GET /api/bookmark-folders/subscribed - 获取用户订阅的收藏夹列表
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  validateNumber,
} from '@/lib/api'
import type { SupabaseClient } from '@supabase/supabase-js'

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin() as SupabaseClient
    const { searchParams } = new URL(request.url)

    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 50 }) ?? 20
    const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0

    // 获取用户订阅的收藏夹
    const { data: subscriptions, error } = await supabase
      .from('folder_subscriptions')
      .select(`
        id,
        created_at,
        bookmark_folders (
          id,
          name,
          description,
          avatar_url,
          is_public,
          post_count,
          created_at,
          user_id
        )
      `)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) {
      // 如果表不存在或列不存在，返回空列表
      const ignoredCodes = ['42P01', 'PGRST116', 'PGRST204', '42703']
      if (ignoredCodes.includes(error.code || '')) {
        return success({ folders: [], pagination: { limit, offset, has_more: false } })
      }
      throw error
    }

    // 收集所有收藏夹所有者的 ID
    const ownerIds = subscriptions
      ?.map(s => ((s.bookmark_folders as unknown as Record<string, unknown> | null)?.user_id) as string | undefined)
      .filter(Boolean) || []
    
    // 获取所有者信息
    let ownerMap: Record<string, { handle: string; avatar_url: string | null }> = {}
    if (ownerIds.length > 0) {
      const { data: owners } = await supabase
        .from('user_profiles')
        .select('id, handle, avatar_url')
        .in('id', ownerIds)
      
      if (owners) {
        ownerMap = owners.reduce((acc, owner) => {
          acc[owner.id] = { handle: owner.handle, avatar_url: owner.avatar_url }
          return acc
        }, {} as Record<string, { handle: string; avatar_url: string | null }>)
      }
    }

    // 格式化返回数据
    const folders = (subscriptions || [])
      .map(s => {
        const folder = s.bookmark_folders as unknown as Record<string, unknown> | null
        if (!folder || !folder.is_public) return null
        
        const owner = ownerMap[String(folder.user_id)]
        return {
          id: folder.id,
          name: folder.name,
          description: folder.description,
          avatar_url: folder.avatar_url,
          is_public: folder.is_public,
          post_count: folder.post_count || 0,
          subscriber_count: folder.subscriber_count || 0,
          created_at: folder.created_at,
          owner_id: folder.user_id,
          owner_handle: owner?.handle,
          owner_avatar_url: owner?.avatar_url,
          subscribed_at: s.created_at,
        }
      })
      .filter(Boolean)

    return success({
      folders,
      pagination: {
        limit,
        offset,
        has_more: folders.length === limit,
      },
    })
  } catch (error: unknown) {
    return handleError(error, 'bookmark-folders/subscribed GET')
  }
}
