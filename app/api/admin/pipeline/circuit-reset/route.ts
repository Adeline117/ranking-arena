/**
 * Admin Circuit Breaker Reset API
 *
 * POST /api/admin/pipeline/circuit-reset
 * Body: { platforms: ["bybit", "bitget_futures", ...] } or { platforms: "all" }
 *
 * Resets both:
 * 1. In-memory cockatiel circuit breakers (circuit-registry.ts)
 * 2. Persistent dead:consecutive:* counters in pipeline_state table
 * 3. Redis pipeline:failures:* counters
 *
 * GET /api/admin/pipeline/circuit-reset
 * Returns current circuit breaker states for all platforms.
 *
 * Auth: x-admin-token or Bearer CRON_SECRET
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyAdminAuth } from '@/lib/auth/verify-service-auth'
import { ApiError } from '@/lib/api/errors'
import { success as apiSuccess, handleError } from '@/lib/api/response'
import { resetCircuit, getCircuitStates, getRegisteredPlatforms } from '@/lib/connectors/circuit-registry'
import { PipelineState } from '@/lib/services/pipeline-state'
import * as cache from '@/lib/cache'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const DEAD_COUNTER_PREFIX = 'dead:consecutive:'
const PIPELINE_FAILURES_PREFIX = 'pipeline:failures:'

export async function GET(request: NextRequest) {
  try {
    if (!(await verifyAdminAuth(request))) {
      throw ApiError.unauthorized()
    }

    const inMemoryStates = getCircuitStates()
    const registeredPlatforms = getRegisteredPlatforms()

    // Get persistent dead counters from pipeline_state
    const deadCounters: Record<string, { value: number; updated_at: string }> = {}
    const entries = await PipelineState.getByPrefix(DEAD_COUNTER_PREFIX)
    for (const entry of entries) {
      const platform = entry.key.replace(DEAD_COUNTER_PREFIX, '')
      deadCounters[platform] = {
        value: typeof entry.value === 'number' ? entry.value : 0,
        updated_at: entry.updated_at,
      }
    }

    return apiSuccess({
      in_memory_circuits: inMemoryStates,
      registered_platforms: registeredPlatforms,
      persistent_dead_counters: deadCounters,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return handleError(error, 'admin-circuit-reset-get')
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!(await verifyAdminAuth(request))) {
      throw ApiError.unauthorized()
    }

    const body = await request.json()
    const { platforms } = body as { platforms: string | string[] }

    if (!platforms) {
      return NextResponse.json(
        { error: 'Missing "platforms" field. Use array of platform names or "all".' },
        { status: 400 }
      )
    }

    // Determine which platforms to reset
    let targetPlatforms: string[]
    if (platforms === 'all') {
      // Get all platforms that have dead counters + registered circuit breakers
      const entries = await PipelineState.getByPrefix(DEAD_COUNTER_PREFIX)
      const deadPlatforms = entries.map(e => e.key.replace(DEAD_COUNTER_PREFIX, ''))
      const registeredPlatforms = getRegisteredPlatforms()
      targetPlatforms = [...new Set([...deadPlatforms, ...registeredPlatforms])]
    } else if (Array.isArray(platforms)) {
      targetPlatforms = platforms
    } else {
      targetPlatforms = [String(platforms)]
    }

    const results: Record<string, { in_memory: boolean; dead_counter: boolean; redis_failures: boolean }> = {}

    for (const platform of targetPlatforms) {
      const result = { in_memory: false, dead_counter: false, redis_failures: false }

      // 1. Reset in-memory cockatiel circuit breaker
      try {
        resetCircuit(platform)
        // Also reset VPS-specific circuit breakers
        resetCircuit(`vps:${platform}`)
        result.in_memory = true
      } catch (err) {
        logger.warn(`[circuit-reset] Failed to reset in-memory circuit for ${platform}: ${err instanceof Error ? err.message : String(err)}`)
      }

      // 2. Reset persistent dead counter in pipeline_state
      try {
        await PipelineState.del(`${DEAD_COUNTER_PREFIX}${platform}`)
        result.dead_counter = true
      } catch (err) {
        logger.warn(`[circuit-reset] Failed to reset dead counter for ${platform}: ${err instanceof Error ? err.message : String(err)}`)
      }

      // 3. Reset Redis pipeline:failures counter
      try {
        await cache.del(`${PIPELINE_FAILURES_PREFIX}${platform}`)
        result.redis_failures = true
      } catch (err) {
        logger.warn(`[circuit-reset] Failed to reset Redis failures for ${platform}: ${err instanceof Error ? err.message : String(err)}`)
      }

      results[platform] = result
    }

    logger.info(`[circuit-reset] Reset circuits for: ${targetPlatforms.join(', ')}`)

    return apiSuccess({
      reset: targetPlatforms,
      results,
      message: `Reset ${targetPlatforms.length} platform circuit breakers`,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return handleError(error, 'admin-circuit-reset-post')
  }
}
