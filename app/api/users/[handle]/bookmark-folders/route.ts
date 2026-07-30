/**
 * 用户公开收藏夹 API
 * GET /api/users/[handle]/bookmark-folders - 获取指定用户的公开收藏夹列表
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  getAuthUser,
  error as errorResponse,
  ErrorCode,
  forbidden,
  success,
  handleError,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { readPublicProfileAudienceByHandle } from '@/lib/profile/public-audience'
import { isBookmarkFolderAuthorityUnavailable } from '@/lib/bookmarks/folder-mutation'
import { parseProfileBookmarkFoldersRead } from '@/lib/bookmarks/folder-read'

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

    const { data, error } = await supabase.rpc('read_profile_bookmark_folders_snapshot', {
      p_actor_id: currentUser?.id ?? null,
      p_profile_id: audience.profile.id,
      p_include_private: isOwnProfile,
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
    const snapshot = parseProfileBookmarkFoldersRead(data, {
      actorId: currentUser?.id ?? null,
      profileId: audience.profile.id,
      includePrivate: isOwnProfile,
    })
    if (snapshot.status === 'actor_inactive') return forbidden('Account is inactive')
    if (snapshot.status === 'profile_not_found') {
      return success({ error: 'User not found', folders: [] }, 404, noStore)
    }
    if (snapshot.status !== 'ok') {
      throw new Error('Profile bookmark folders snapshot returned an impossible status')
    }

    return success(
      {
        folders: snapshot.folders,
        is_own_profile: isOwnProfile,
      },
      200,
      noStore
    )
  } catch (error: unknown) {
    return handleError(error, 'users/[handle]/bookmark-folders GET')
  }
}
