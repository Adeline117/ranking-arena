/**
 * 封禁用户 API
 * POST /api/admin/users/[id]/ban
 */

import { NextRequest } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import { AdminUserSanctionError, setAdminUserSanctionAtomic } from '@/lib/admin/user-sanctions'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('admin-ban-user')

export const dynamic = 'force-dynamic'

// withAdminAuth expects (request: NextRequest) => Promise<NextResponse>
// But this route has params, so we use a wrapper pattern
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const handler = withAdminAuth(
    async ({ admin, supabase }) => {
      const { id: userId } = await params
      let body: unknown
      try {
        body = await req.json()
      } catch {
        throw ApiError.validation('Invalid JSON in request body')
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw ApiError.validation('Request body must be an object')
      }
      const requestBody = body as Record<string, unknown>
      const keys = Object.keys(requestBody)
      if (keys.some((key) => key !== 'reason')) {
        throw ApiError.validation('Request body may only contain reason')
      }
      if (
        requestBody.reason !== undefined &&
        requestBody.reason !== null &&
        typeof requestBody.reason !== 'string'
      ) {
        throw ApiError.validation('Ban reason must be a string')
      }
      const reason =
        typeof requestBody.reason === 'string' ? requestBody.reason.trim() || null : null
      if (reason && reason.length > 1000) {
        throw ApiError.validation('Ban reason must be at most 1000 characters')
      }

      if (userId === admin.id) {
        throw ApiError.validation('Cannot ban yourself')
      }

      let result: Awaited<ReturnType<typeof setAdminUserSanctionAtomic>>
      try {
        result = await setAdminUserSanctionAtomic(supabase, {
          actorId: admin.id,
          targetId: userId,
          action: 'ban',
          reason,
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
          userId,
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

      logger.info('User banned', {
        userId,
        adminId: admin.id,
        reason,
        handle: result.target_handle,
      })

      return apiSuccess({ message: 'User banned successfully' })
    },
    { name: 'admin-ban-user' }
  )

  return handler(req)
}
