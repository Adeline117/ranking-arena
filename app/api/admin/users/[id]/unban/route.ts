/**
 * 解封用户 API
 * POST /api/admin/users/[id]/unban
 */

import { NextRequest } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import { createLogger } from '@/lib/utils/logger'
import { recordAdminLog } from '@/lib/admin/audit-log'

const logger = createLogger('admin-unban-user')

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const handler = withAdminAuth(
    async ({ admin, supabase }) => {
      const { id: userId } = await params

      // Check if user exists
      const { data: targetUser, error: userError } = await supabase
        .from('user_profiles')
        .select('id, handle, banned_at, deleted_at')
        .eq('id', userId)
        .maybeSingle()

      if (userError || !targetUser) {
        throw ApiError.notFound('User not found')
      }

      if (!targetUser.banned_at) {
        throw ApiError.validation('User is not banned')
      }

      // Lift the auth-level ban first (so a failure leaves the user still
      // banned and the request retryable), unless the account is also pending
      // deletion: that ban belongs to the deletion flow and only recovery may
      // lift it.
      if (!targetUser.deleted_at) {
        const { error: authUnbanError } = await supabase.auth.admin.updateUserById(userId, {
          ban_duration: 'none',
        })
        if (authUnbanError) {
          logger.error('Auth-level ban could not be lifted; user left banned', {
            userId,
            adminId: admin.id,
            error: authUnbanError.message,
          })
          throw ApiError.database('Failed to lift the sign-in ban; please retry')
        }
      }

      // Unban the user
      const { error: unbanError } = await supabase
        .from('user_profiles')
        .update({
          banned_at: null,
          banned_reason: null,
          banned_by: null,
        })
        .eq('id', userId)

      if (unbanError) {
        logger.error('Error unbanning user', { error: unbanError, userId, adminId: admin.id })
        throw ApiError.database(unbanError.message)
      }

      // Log the action
      await recordAdminLog(supabase, {
        admin_id: admin.id,
        action: 'unban_user',
        target_type: 'user',
        target_id: userId,
        details: { handle: targetUser.handle },
      })

      logger.info('User unbanned', { userId, adminId: admin.id })

      return apiSuccess({ message: 'User unbanned successfully' })
    },
    { name: 'admin-unban-user' }
  )

  return handler(req)
}
