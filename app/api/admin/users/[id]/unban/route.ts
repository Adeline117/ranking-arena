/**
 * 解封用户 API
 * POST /api/admin/users/[id]/unban
 */

import { NextRequest } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('admin-unban-user')

export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const handler = withAdminAuth(
    async ({ admin, supabase }) => {
      const { id: userId } = await params

      // Check if user exists
      const { data: targetUser, error: userError } = await supabase
        .from('user_profiles')
        .select('id, handle, banned_at')
        .eq('id', userId)
        .maybeSingle()

      if (userError || !targetUser) {
        throw ApiError.notFound('User not found')
      }

      if (!targetUser.banned_at) {
        throw ApiError.validation('User is not banned')
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
      await supabase.from('admin_logs').insert({
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
