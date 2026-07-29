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
import { AdminUserSanctionError, setAdminUserSanctionAtomic } from '@/lib/admin/user-sanctions'
import {
  CommentMutationRolloutError,
  moderateCommentWithRollout,
} from '@/lib/data/comment-mutation-rollout'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('api:admin-moderate')

export const dynamic = 'force-dynamic'

type ModerationAction = 'delete_post' | 'delete_comment' | 'ban_user'

const VALID_ACTIONS: ModerationAction[] = ['delete_post', 'delete_comment', 'ban_user']

export async function POST(req: NextRequest) {
  const handler = withAdminAuth(
    async ({ admin, supabase }) => {
      let body: { action: ModerationAction; targetId: string; reason?: string }
      try {
        body = await req.json()
      } catch {
        throw ApiError.validation('Invalid JSON in request body')
      }
      const { action, targetId, reason } = body

      if (!action || !VALID_ACTIONS.includes(action)) {
        throw ApiError.validation(`Invalid action. Must be one of: ${VALID_ACTIONS.join(', ')}`)
      }

      if (!targetId) {
        throw ApiError.validation('targetId is required')
      }

      switch (action) {
        case 'delete_post': {
          const { error } = await supabase.from('posts').delete().eq('id', targetId)

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
          try {
            await moderateCommentWithRollout(supabase, {
              commentId: targetId,
              actorId: admin.id,
              action: 'hard_delete',
              reason: reason || null,
            })
          } catch (error) {
            if (error instanceof CommentMutationRolloutError && error.kind === 'not_found') {
              throw ApiError.notFound('Comment not found')
            }
            logger.error('Error deleting comment', {
              commentId: targetId,
              ...(error instanceof CommentMutationRolloutError
                ? { kind: error.kind, code: error.databaseCode, stage: error.stage }
                : {}),
            })
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
          if (targetId === admin.id) {
            throw ApiError.validation('Cannot ban yourself')
          }

          let result: Awaited<ReturnType<typeof setAdminUserSanctionAtomic>>
          try {
            result = await setAdminUserSanctionAtomic(supabase, {
              actorId: admin.id,
              targetId,
              action: 'ban',
              reason: typeof reason === 'string' ? reason : null,
            })
          } catch (error) {
            if (error instanceof AdminUserSanctionError) {
              if (error.kind === 'validation') throw ApiError.validation('Invalid ban request')
              if (error.kind === 'forbidden') throw ApiError.forbidden('Ban action forbidden')
              if (error.kind === 'conflict') {
                throw ApiError.validation('User lifecycle changed concurrently; retry the ban')
              }
            }
            logger.error('Error banning user', {
              userId: targetId,
              adminId: admin.id,
              ...(error instanceof AdminUserSanctionError && error.databaseCode
                ? { code: error.databaseCode }
                : {}),
            })
            throw ApiError.database('Failed to ban user')
          }

          if (result.status === 'not_found' || result.status === 'target_deleted') {
            throw ApiError.notFound('User not found')
          }
          if (result.status === 'already_banned') {
            throw ApiError.validation('User is already banned')
          }
          if (!result.applied || result.status !== 'applied') {
            throw ApiError.database('Invalid ban acknowledgement')
          }

          logger.info('User banned via moderate', {
            userId: targetId,
            adminId: admin.id,
            reason,
            handle: result.target_handle,
          })
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
