/**
 * 用户公开收藏夹 API
 * GET /api/users/[handle]/bookmark-folders - 获取指定用户的公开收藏夹列表
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  getAuthUser,
  success,
  handleError,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import logger from '@/lib/logger'
import { readPublicProfileAudienceByHandle } from '@/lib/profile/public-audience'

type RouteContext = { params: Promise<{ handle: string }> }

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
    if (rateLimitResponse) return rateLimitResponse

    const { handle } = await context.params
    const supabase = getSupabaseAdmin()
    const noStore = { 'Cache-Control': 'private, no-store, max-age=0' }

    // 检查当前用户（可选）
    const currentUser = await getAuthUser(request)

    // 解码 handle（中文等特殊字符会被编码）
    let decodedHandle: string
    try {
      decodedHandle = decodeURIComponent(handle)
    } catch {
      return success({ error: 'User not found', folders: [] }, 400, noStore)
    }

    // service_role reads must authorize the current public resource state on
    // every request; existence alone is not public-profile authorization.
    const audience = await readPublicProfileAudienceByHandle(supabase, decodedHandle)

    if (audience.status !== 'active') {
      return success({ error: 'User not found', folders: [] }, 404, noStore)
    }

    const isOwnProfile = currentUser?.id === audience.profile.id

    // 获取用户的收藏夹
    let query = supabase
      .from('bookmark_folders')
      .select('id, name, description, avatar_url, is_public, is_default, post_count, created_at')
      .eq('user_id', audience.profile.id)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false })

    // 如果不是自己的主页，只显示公开的收藏夹
    if (!isOwnProfile) {
      query = query.eq('is_public', true)
    }

    const { data: folders, error: foldersError } = await query

    if (foldersError) {
      logger.error('Error fetching bookmark folders:', foldersError)
      return success({ folders: [] }, 200, noStore)
    }

    return success(
      {
        folders: folders || [],
        is_own_profile: isOwnProfile,
      },
      200,
      noStore
    )
  } catch (error: unknown) {
    return handleError(error, 'users/[handle]/bookmark-folders GET')
  }
}
