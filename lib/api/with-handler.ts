/**
 * DRY wrapper for API route handlers.
 * Provides structured logging + automatic error handling via handleError().
 *
 * Usage:
 *   export const GET = withApiHandler('my-route', async (request) => {
 *     // ... your logic ...
 *     return success({ data })
 *   })
 */

import { NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@/lib/utils/logger'
import { handleError } from '@/lib/api/response'

export function withApiHandler(
  routeName: string,
  handler: (request: NextRequest, ...args: unknown[]) => Promise<NextResponse>
) {
  const logger = createLogger(routeName)
  return async (request: NextRequest, ...args: unknown[]) => {
    try {
      return await handler(request, ...args)
    } catch (error) {
      logger.error(`${routeName} failed`, { error: error instanceof Error ? error.message : error })
      return handleError(error)
    }
  }
}
