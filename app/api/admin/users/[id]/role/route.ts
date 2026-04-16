/**
 * Manage user roles API
 * PUT /api/admin/users/[id]/role
 * Admin-only: promote/demote users to moderator
 */

import { NextRequest } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('admin-user-role')

export const dynamic = 'force-dynamic'

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const handler = withAdminAuth(
    async ({ admin, supabase }) => {
      const { id: userId } = await params
      let body: { role?: string }
      try {
        body = await req.json()
      } catch {
        throw ApiError.validation('Invalid JSON in request body')
      }
      const { role } = body

      if (!role || !['user', 'moderator'].includes(role)) {
        throw ApiError.validation('Role must be "user" or "moderator"')
      }

      if (userId === admin.id) {
        throw ApiError.validation('Cannot change your own role')
      }

      // Check target user exists
      const { data: targetUser, error: userError } = await supabase
        .from('user_profiles')
        .select('id, handle, role')
        .eq('id', userId)
        .maybeSingle()

      if (userError || !targetUser) {
        throw ApiError.notFound('User not found')
      }

      // Cannot demote another admin
      if (targetUser.role === 'admin') {
        throw ApiError.validation('Cannot change admin role via this endpoint')
      }

      // Update role
      const { error: updateError } = await supabase
        .from('user_profiles')
        .update({ role })
        .eq('id', userId)

      if (updateError) {
        logger.error('Error updating user role', { error: updateError, userId, adminId: admin.id })
        throw ApiError.database(updateError.message)
      }

      // Audit log
      await supabase.from('admin_logs').insert({
        admin_id: admin.id,
        action: role === 'moderator' ? 'promote_to_moderator' : 'demote_from_moderator',
        target_type: 'user',
        target_id: userId,
        details: { handle: targetUser.handle, previousRole: targetUser.role, newRole: role },
      })

      logger.info('User role updated', { userId, adminId: admin.id, previousRole: targetUser.role, newRole: role })

      return apiSuccess({ message: `User role updated to ${role}` })
    },
    { name: 'admin-user-role' }
  )

  return handler(req)
}
