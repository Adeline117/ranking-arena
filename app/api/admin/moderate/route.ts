/**
 * Community Moderation API
 * POST /api/admin/moderate
 *
 * Actions: delete_post, delete_comment, ban_user
 */

import { NextRequest } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('api:admin-moderate')

export const dynamic = 'force-dynamic'

type ModerationAction = 'delete_post' | 'delete_comment' | 'ban_user'

const VALID_ACTIONS: ModerationAction[] = ['delete_post', 'delete_comment', 'ban_user']

export async function POST(req: NextRequest) {
  const handler = withAdminAuth(
    async ({ admin, supabase }) => {
      const body = await req.json()
      const { action, targetId, reason } = body as {
        action: ModerationAction
        targetId: string
        reason?: string
      }

      if (!action || !VALID_ACTIONS.includes(action)) {
        throw ApiError.validation(`Invalid action. Must be one of: ${VALID_ACTIONS.join(', ')}`)
      }

      if (!targetId) {
        throw ApiError.validation('targetId is required')
      }

      switch (action) {
        case 'delete_post': {
          const { error } = await supabase
            .from('posts')
            .delete()
            .eq('id', targetId)

          if (error) {
            logger.error('Error deleting post', { error, postId: targetId })
            throw ApiError.database('Database operation failed')
          }

          // Log the action
          await supabase.from('admin_logs').insert({
            admin_id: admin.id,
            action: 'delete_post',
            target_type: 'post',
            target_id: targetId,
            details: { reason: reason || null },
          })

          logger.info('Post deleted', { postId: targetId, adminId: admin.id, reason })
          return apiSuccess({ message: 'Post deleted successfully' })
        }

        case 'delete_comment': {
          const { error } = await supabase
            .from('comments')
            .delete()
            .eq('id', targetId)

          if (error) {
            logger.error('Error deleting comment', { error, commentId: targetId })
            throw ApiError.database('Database operation failed')
          }

          await supabase.from('admin_logs').insert({
            admin_id: admin.id,
            action: 'delete_comment',
            target_type: 'comment',
            target_id: targetId,
            details: { reason: reason || null },
          })

          logger.info('Comment deleted', { commentId: targetId, adminId: admin.id, reason })
          return apiSuccess({ message: 'Comment deleted successfully' })
        }

        case 'ban_user': {
          // Check user exists and is not already banned
          const { data: targetUser, error: userError } = await supabase
            .from('user_profiles')
            .select('id, handle, banned_at')
            .eq('id', targetId)
            .maybeSingle()

          if (userError || !targetUser) {
            throw ApiError.notFound('User not found')
          }

          if (targetUser.banned_at) {
            throw ApiError.validation('User is already banned')
          }

          if (targetId === admin.id) {
            throw ApiError.validation('Cannot ban yourself')
          }

          const { error: banError } = await supabase
            .from('user_profiles')
            .update({
              banned_at: new Date().toISOString(),
              banned_reason: reason || null,
              banned_by: admin.id,
            })
            .eq('id', targetId)

          if (banError) {
            logger.error('Error banning user', { error: banError, userId: targetId })
            throw ApiError.database(banError.message)
          }

          await supabase.from('admin_logs').insert({
            admin_id: admin.id,
            action: 'ban_user',
            target_type: 'user',
            target_id: targetId,
            details: { reason: reason || null, handle: targetUser.handle },
          })

          logger.info('User banned via moderate', { userId: targetId, adminId: admin.id, reason })
          return apiSuccess({ message: 'User banned successfully' })
        }

        default:
          throw ApiError.validation('Unknown action')
      }
    },
    { name: 'admin-moderate' }
  )

  return handler(req)
}
