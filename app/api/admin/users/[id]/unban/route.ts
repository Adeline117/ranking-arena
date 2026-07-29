/**
 * 解封用户 API
 * POST /api/admin/users/[id]/unban
 */

import { NextRequest } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import { AdminUserSanctionError, setAdminUserSanctionAtomic } from '@/lib/admin/user-sanctions'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('admin-unban-user')

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const handler = withAdminAuth(
    async ({ admin, supabase }) => {
      const { id: userId } = await params

      let result: Awaited<ReturnType<typeof setAdminUserSanctionAtomic>>
      try {
        result = await setAdminUserSanctionAtomic(supabase, {
          actorId: admin.id,
          targetId: userId,
          action: 'unban',
        })
      } catch (error) {
        if (error instanceof AdminUserSanctionError) {
          if (error.kind === 'validation') throw ApiError.validation('Invalid unban request')
          if (error.kind === 'forbidden') throw ApiError.forbidden('Unban action forbidden')
          if (error.kind === 'conflict') {
            throw ApiError.validation('User lifecycle changed concurrently; retry the unban')
          }
        }
        logger.error('Error unbanning user', {
          userId,
          adminId: admin.id,
          ...(error instanceof AdminUserSanctionError && error.databaseCode
            ? { code: error.databaseCode }
            : {}),
        })
        throw ApiError.database('Failed to unban user')
      }

      if (result.status === 'not_found' || result.status === 'target_deleted') {
        throw ApiError.notFound('User not found')
      }
      if (result.status === 'not_banned') {
        throw ApiError.validation('User is not banned')
      }
      if (!result.applied || result.status !== 'applied') {
        throw ApiError.database('Invalid unban acknowledgement')
      }

      logger.info('User unbanned', {
        userId,
        adminId: admin.id,
        handle: result.target_handle,
      })

      return apiSuccess({ message: 'User unbanned successfully' })
    },
    { name: 'admin-unban-user' }
  )

  return handler(req)
}
