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
} from '@/lib/api'
import logger from '@/lib/logger'

type RouteContext = { params: Promise<{ handle: string }> }

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { handle } = await context.params
    const supabase = getSupabaseAdmin()

    // 检查当前用户（可选）
    const currentUser = await getAuthUser(request)

    // 解码 handle（中文等特殊字符会被编码）
    const decodedHandle = decodeURIComponent(handle)

    // 通过 handle 获取用户 ID
    const { data: userProfile, error: profileError } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('handle', decodedHandle)
      .single()

    if (profileError || !userProfile) {
      return success({ error: '用户不存在', folders: [] }, 404)
    }

    const isOwnProfile = currentUser?.id === userProfile.id

    // 获取用户的收藏夹
    let query = supabase
      .from('bookmark_folders')
      .select('id, name, description, avatar_url, is_public, is_default, post_count, created_at')
      .eq('user_id', userProfile.id)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false })

    // 如果不是自己的主页，只显示公开的收藏夹
    if (!isOwnProfile) {
      query = query.eq('is_public', true)
    }

    const { data: folders, error: foldersError } = await query

    if (foldersError) {
      logger.error('Error fetching bookmark folders:', foldersError)
      return success({ folders: [] })
    }

    return success({
      folders: folders || [],
      is_own_profile: isOwnProfile,
    })
  } catch (error: unknown) {
    return handleError(error, 'users/[handle]/bookmark-folders GET')
  }
}
