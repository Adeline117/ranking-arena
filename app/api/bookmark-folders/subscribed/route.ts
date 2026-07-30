/**
 * 已订阅收藏夹 API
 * GET /api/bookmark-folders/subscribed - 获取用户订阅的收藏夹列表
 */

import { withAuth } from '@/lib/api/middleware'
import { error as errorResponse, forbidden, success, handleError } from '@/lib/api/response'
import { ErrorCode } from '@/lib/api/errors'
import { validateNumber } from '@/lib/api/validation'
import { isBookmarkFolderAuthorityUnavailable } from '@/lib/bookmarks/folder-mutation'
import { parseSubscribedBookmarkFoldersRead } from '@/lib/bookmarks/folder-read'

export const GET = withAuth(
  async ({ user, supabase, request }) => {
    try {
      const { searchParams } = new URL(request.url)

      const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 50 }) ?? 20
      const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0

      const { data, error } = await supabase.rpc('read_subscribed_bookmark_folders_snapshot', {
        p_actor_id: user.id,
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
      const snapshot = parseSubscribedBookmarkFoldersRead(data, {
        actorId: user.id,
        limit,
        offset,
      })
      if (snapshot.status === 'actor_inactive') return forbidden('Account is inactive')
      if (snapshot.status !== 'ok') {
        throw new Error('Subscribed bookmark folders snapshot returned an impossible status')
      }

      return success({
        folders: snapshot.folders,
        pagination: snapshot.pagination,
      })
    } catch (error: unknown) {
      return handleError(error, 'bookmark-folders/subscribed GET')
    }
  },
  { name: 'bookmark-folders-subscribed', rateLimit: 'read' }
)
