/**
 * API Timing Middleware
 *
 * Wraps Next.js API handlers to measure response time.
 * Adds `X-Response-Time` header to every response.
 * Logs warnings for responses >1s, errors for >5s.
 *
 * Usage:
 *   import { withTiming } from '@/lib/api/timing'
 *
 *   export const GET = withTiming(async (request) => {
 *     return NextResponse.json({ ok: true })
 *   })
 */

import { NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('api-timing')

const WARN_THRESHOLD_MS = 1000
const ERROR_THRESHOLD_MS = 5000

type RouteHandler = (
  request: NextRequest,
  context?: { params?: Promise<Record<string, string>> }
) => Promise<NextResponse | Response>

/**
 * Wrap an API route handler with response-time measurement.
 *
 * - Injects `X-Response-Time` header (e.g. "123ms")
 * - Logs a warning when the handler takes longer than 1 second
 * - Logs an error when the handler takes longer than 5 seconds
 */
export function withTiming(handler: RouteHandler): RouteHandler {
  return async (request, context) => {
    const start = performance.now()

    const response = await handler(request, context)

    const durationMs = Math.round(performance.now() - start)
    const path = new URL(request.url).pathname

    // Attach timing header (works on both NextResponse and plain Response)
    if (response instanceof NextResponse) {
      response.headers.set('X-Response-Time', `${durationMs}ms`)
    } else if (response.headers && typeof (response.headers as Headers).set === 'function') {
      ;(response.headers as Headers).set('X-Response-Time', `${durationMs}ms`)
    }

    // Log slow responses
    if (durationMs >= ERROR_THRESHOLD_MS) {
      logger.error(`Slow response: ${request.method} ${path} took ${durationMs}ms (>${ERROR_THRESHOLD_MS}ms)`)
    } else if (durationMs >= WARN_THRESHOLD_MS) {
      logger.warn(`Slow response: ${request.method} ${path} took ${durationMs}ms (>${WARN_THRESHOLD_MS}ms)`)
    }

    return response
  }
}
