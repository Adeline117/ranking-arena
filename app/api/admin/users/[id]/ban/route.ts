/**
 * 封禁用户 API
 * POST /api/admin/users/[id]/ban
 */

import { NextRequest } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('admin-ban-user')

export const dynamic = 'force-dynamic'

// withAdminAuth expects (request: NextRequest) => Promise<NextResponse>
// But this route has params, so we use a wrapper pattern
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

      // Log the action
      await supabase.from('admin_logs').insert({
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
