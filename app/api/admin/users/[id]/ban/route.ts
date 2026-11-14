/**
 * 封禁用户 API
 * POST /api/admin/users/[id]/ban
 */

import { NextRequest } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import { createLogger } from '@/lib/utils/logger'
import { recordAdminLog } from '@/lib/admin/audit-log'
import { ADMIN_BAN_DURATION } from '@/lib/auth/deletion-ban'

const logger = createLogger('admin-ban-user')

export const dynamic = 'force-dynamic'

// withAdminAuth expects (request: NextRequest) => Promise<NextResponse>
// But this route has params, so we use a wrapper pattern
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const handler = withAdminAuth(
    async ({ admin, supabase }) => {
      const { id: userId } = await params
      let body: { reason?: string }
      try {
        body = await req.json()
      } catch {
        throw ApiError.validation('Invalid JSON in request body')
      }
      const { reason } = body

      // Check if user exists
      const { data: targetUser, error: userError } = await supabase
        .from('user_profiles')
        .select('id, handle, banned_at')
        .eq('id', userId)
        .maybeSingle()

      if (userError || !targetUser) {
        throw ApiError.notFound('User not found')
      }

      if (targetUser.banned_at) {
        throw ApiError.validation('User is already banned')
      }

      if (userId === admin.id) {
        throw ApiError.validation('Cannot ban yourself')
      }

      // Ban the user
      const { error: banError } = await supabase
        .from('user_profiles')
        .update({
          banned_at: new Date().toISOString(),
          banned_reason: reason || null,
          banned_by: admin.id,
        })
        .eq('id', userId)

      if (banError) {
        logger.error('Error banning user', { error: banError, userId, adminId: admin.id })
        throw ApiError.database(banError.message)
      }

      // Block sign-in and token refresh too. banned_at stays the source of
      // truth for server routes, so a failure here is logged, not fatal.
      const { error: authBanError } = await supabase.auth.admin.updateUserById(userId, {
        ban_duration: ADMIN_BAN_DURATION,
      })
      if (authBanError) {
        logger.error('User banned in profile but auth-level ban failed', {
          userId,
          adminId: admin.id,
          error: authBanError.message,
        })
      }

      // Log the action
      await recordAdminLog(supabase, {
        admin_id: admin.id,
        action: 'ban_user',
        target_type: 'user',
        target_id: userId,
        details: { reason, handle: targetUser.handle },
      })

      logger.info('User banned', { userId, adminId: admin.id, reason })

      return apiSuccess({ message: 'User banned successfully' })
    },
    { name: 'admin-ban-user' }
  )

  return handler(req)
}
