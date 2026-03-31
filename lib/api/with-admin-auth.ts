/**
 * Admin authentication middleware
 * Wraps API handlers with admin verification using the existing verifyAdmin utility.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, verifyAdmin } from '@/lib/admin/auth'
import { handleError, error as errorResponse } from './response'
import { ErrorCode } from './errors'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const logger = createLogger('admin-auth-middleware')

/**
 * Context provided to admin-authenticated handlers
 */
interface AdminContext {
  /** Verified admin user */
  admin: { id: string; email: string }
  /** Supabase admin client */
  supabase: ReturnType<typeof getSupabaseAdmin>
  /** Original request */
  request: NextRequest
}

type AdminHandler = (ctx: AdminContext) => Promise<NextResponse>

interface AdminAuthOptions {
  /** Name for logging */
  name?: string
}

/**
 * Wrap an API handler with admin authentication.
 *
 * Usage:
 * ```ts
 * export const GET = withAdminAuth(async ({ admin, supabase, request }) => {
 *   // admin is guaranteed to be a verified admin user
 *   return success({ message: 'Hello admin' })
 * })
 * ```
 */
export function withAdminAuth(
  handler: AdminHandler,
  options: AdminAuthOptions = {}
): (request: NextRequest) => Promise<NextResponse> {
  const { name = 'admin-api' } = options

  return async (request: NextRequest): Promise<NextResponse> => {
    const startTime = Date.now()

    try {
      const supabase = getSupabaseAdmin()
      const authHeader = request.headers.get('authorization')

      const admin = await verifyAdmin(supabase, authHeader)
      if (!admin) {
        return errorResponse(
          'Admin access required',
          403,
          ErrorCode.FORBIDDEN
        )
      }

      // SECURITY: Audit log for admin access
      console.info(`[ADMIN-AUDIT] ${admin.email} accessed ${request.method} ${request.url}`)

      // Rate limit authenticated admin requests (300/min for admin operations)
      const rateLimitResponse = await checkRateLimit(request, { requests: 300, window: 60, prefix: 'admin' })
      if (rateLimitResponse) {
        return rateLimitResponse
      }

      const response = await handler({ admin, supabase, request })

      const duration = Date.now() - startTime
      response.headers.set('X-Response-Time', `${duration}ms`)

      return response
    } catch (err: unknown) {
      logger.error(`[${name}] Error:`, { error: err instanceof Error ? err.message : String(err) })
      return handleError(err, name)
    }
  }
}
