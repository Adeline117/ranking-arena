/**
 * Public launch health API.
 *
 * GET /api/health checks the API transport, database, Redis, complete source
 * registry freshness/coverage, and complete current 90D publication proof.
 * Core checks share one bounded request deadline; deeper diagnostics remain
 * available at /api/health/detailed.
 */

import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getSharedRedis } from '@/lib/cache/redis-client'
import { safeParseInt } from '@/lib/utils/safe-parse'
import { logger } from '@/lib/logger'
import { buildFreshnessAuthoritySnapshot } from '@/lib/rankings/build-freshness-report'

export const dynamic = 'force-dynamic'
export const runtime = 'edge'

const startTime = Date.now()
const version = process.env.npm_package_version || '0.1.0'
// Deployed git commit (Vercel sets VERCEL_GIT_COMMIT_SHA at build). Exposed so a
// scheduled deploy-freshness sentinel can compare it to origin/main HEAD and catch
// a stuck deploy pipeline — the failure mode where CI-red silently withheld 28
// production deploys and the only alert (Telegram) was 401-broken, so nobody knew.
const commit = process.env.VERCEL_GIT_COMMIT_SHA || process.env.ARENA_RELEASE_SHA || 'unknown'
// Deploy timestamp from env (set at build time), fallback to module load time
const deployTime = process.env.NEXT_PUBLIC_DEPLOY_TIME
  ? safeParseInt(process.env.NEXT_PUBLIC_DEPLOY_TIME, startTime)
  : startTime

// The shortest production caller aborts at 15s. Core checks share one absolute
// handler deadline, leaving over five seconds for transport, cold start, and
// response serialization.
const HANDLER_DEADLINE_MS = 9_500
const RESPONSE_RESERVE_MS = 250
const CORE_CHECK_TIMEOUT_MS = 8_000

interface RequestDeadline {
  signal: AbortSignal
  remaining: (phaseCapMs: number) => number
  close: () => void
}

function createRequestDeadline(): RequestDeadline {
  const controller = new AbortController()
  const deadlineAt = Date.now() + HANDLER_DEADLINE_MS
  const timeout = setTimeout(
    () => controller.abort(new Error('public health deadline exceeded')),
    HANDLER_DEADLINE_MS
  )

  return {
    signal: controller.signal,
    remaining: (phaseCapMs) =>
      Math.max(0, Math.min(phaseCapMs, deadlineAt - Date.now() - RESPONSE_RESERVE_MS)),
    close: () => {
      clearTimeout(timeout)
      if (!controller.signal.aborted) controller.abort(new Error('public health response complete'))
    },
  }
}

/** Race any check against a timeout to prevent the health endpoint from hanging. */
function withTimeout<T>(
  deadline: RequestDeadline,
  phaseCapMs: number,
  fallback: T,
  label: string,
  operation: (signal: AbortSignal) => PromiseLike<T>,
  parentSignal: AbortSignal = deadline.signal
): Promise<T> {
  const ms = deadline.remaining(phaseCapMs)
  if (ms <= 0 || deadline.signal.aborted || parentSignal.aborted) {
    logger.warn(`[health] ${label} skipped because the request deadline is exhausted`)
    return Promise.resolve(fallback)
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const controller = new AbortController()
    const parentSignals =
      parentSignal === deadline.signal ? [deadline.signal] : [deadline.signal, parentSignal]
    const abortListeners = parentSignals.map((signal) => {
      const listener = () => {
        if (!controller.signal.aborted) controller.abort(signal.reason)
        if (!settled) {
          settled = true
          cleanup()
          resolve(fallback)
        }
      }
      signal.addEventListener('abort', listener, { once: true })
      return { signal, listener }
    })
    const cleanup = () => {
      clearTimeout(timeout)
      for (const { signal, listener } of abortListeners) {
        signal.removeEventListener('abort', listener)
      }
    }
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        controller.abort(new Error(`${label} deadline exceeded`))
        cleanup()
        logger.warn(`[health] ${label} timed out after ${ms}ms`)
        resolve(fallback)
      }
    }, ms)

    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(value)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          cleanup()
          reject(error)
        }
      )
  })
}

async function checkDatabase(deadline: RequestDeadline): Promise<{
  status: 'pass' | 'fail' | 'skip'
  latency?: number
  message?: string
}> {
  const t0 = Date.now()
  const timeoutMessage = `DB check timed out (${CORE_CHECK_TIMEOUT_MS / 1000}s)`
  try {
    const result = await withTimeout(
      deadline,
      CORE_CHECK_TIMEOUT_MS,
      { ok: false, msg: timeoutMessage },
      'checkDatabase',
      (signal) =>
        getSupabaseAdmin()
          .from('trader_sources')
          .select('id')
          .limit(1)
          .abortSignal(signal)
          .then((r) => ({ ok: !r.error, msg: r.error?.message }))
    )
    const latency = Date.now() - t0
    if (!result.ok) {
      if (result.msg !== timeoutMessage) {
        logger.warn('[health] Database dependency failed', { error: result.msg })
      }
      return {
        status: 'fail',
        message: result.msg === timeoutMessage ? timeoutMessage : 'Database unavailable',
        latency,
      }
    }
    return { status: 'pass', latency }
  } catch (e: unknown) {
    logger.warn('[health] Database dependency threw', {
      error: e instanceof Error ? e.message : String(e),
    })
    return {
      status: 'fail',
      message: 'Database unavailable',
      latency: Date.now() - t0,
    }
  }
}

async function checkRedis(deadline: RequestDeadline): Promise<{
  status: 'pass' | 'fail' | 'skip'
  latency?: number
  message?: string
}> {
  const t0 = Date.now()
  try {
    const result = await withTimeout(
      deadline,
      CORE_CHECK_TIMEOUT_MS,
      {
        status: 'fail' as const,
        message: `Redis check timed out (${CORE_CHECK_TIMEOUT_MS / 1000}s)`,
      },
      'checkRedis',
      () =>
        getSharedRedis().then(async (redis) => {
          if (!redis) {
            const redisExpected = Boolean(
              process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_TOKEN
            )
            return redisExpected
              ? { status: 'fail' as const, message: 'Redis unavailable' }
              : { status: 'skip' as const, message: 'Not configured' }
          }
          const pong = await redis.ping()
          return pong === 'PONG'
            ? { status: 'pass' as const }
            : { status: 'fail' as const, message: 'Redis unavailable' }
        })
    )
    return { ...result, latency: Date.now() - t0 }
  } catch (e: unknown) {
    logger.warn('[health] Redis dependency threw', {
      error: e instanceof Error ? e.message : String(e),
    })
    return {
      status: 'fail',
      message: 'Redis unavailable',
      latency: Date.now() - t0,
    }
  }
}

async function checkFreshness(deadline: RequestDeadline): Promise<{
  status: 'pass' | 'fail'
  latency?: number
  message?: string
  details?: {
    checkedAt: string
    sourceSummary: {
      total: number
      fresh: number
      stale: number
      critical: number
      unknown: number
    }
    coverage: {
      expectedSourceBoards: number
      visibleSourceBoards: number
    }
    thresholds: {
      staleHours: number
      criticalHours: number
    }
    latestSuccessfulPublicationAt: string | null
    publicationSeason: '90D'
    sources: Array<{
      platform: string
      displayName: string
      lastUpdate: string | null
      ageHours: number | null
      status: 'fresh' | 'stale' | 'critical' | 'unknown'
      recordCount: number
    }>
  }
}> {
  const t0 = Date.now()
  try {
    const report = await withTimeout(
      deadline,
      CORE_CHECK_TIMEOUT_MS,
      null,
      'checkFreshness',
      (signal) => buildFreshnessAuthoritySnapshot(signal)
    )
    const latency = Date.now() - t0
    if (!report) {
      return { status: 'fail', latency, message: 'Freshness authority timed out' }
    }

    const { total, fresh, stale, critical, unknown } = report.report.summary
    const coverageComplete =
      report.coverage.expectedSourceBoards > 0 &&
      report.coverage.visibleSourceBoards === report.coverage.expectedSourceBoards
    const publicationProven = report.latestSuccessfulPublication !== null
    const authorityProblems: string[] = []

    if (report.coverage.expectedSourceBoards <= 0) {
      authorityProblems.push('Source-board coverage authority unavailable')
    } else if (!coverageComplete) {
      authorityProblems.push(
        `${report.coverage.visibleSourceBoards}/${report.coverage.expectedSourceBoards} source boards visible`
      )
    }
    if (!publicationProven) {
      authorityProblems.push('90D publication proof unavailable')
    }

    const message = [
      `${fresh}/${total} sources fresh; ${stale} stale; ${critical} critical; ${unknown} unknown`,
      ...authorityProblems,
    ].join('; ')
    const authorityComplete = report.report.ok && coverageComplete && publicationProven

    return {
      status: authorityComplete ? 'pass' : 'fail',
      latency,
      message,
      details: {
        checkedAt: report.report.checked_at,
        sourceSummary: report.report.summary,
        coverage: report.coverage,
        thresholds: {
          staleHours: report.report.thresholds.stale_hours,
          criticalHours: report.report.thresholds.critical_hours,
        },
        latestSuccessfulPublicationAt: report.latestSuccessfulPublication?.publishedAt ?? null,
        publicationSeason: '90D',
        sources: report.report.platforms.map((source) => ({
          platform: source.platform,
          displayName: source.displayName,
          lastUpdate: source.lastUpdate,
          ageHours: source.ageHours,
          status: source.status,
          recordCount: source.recordCount,
        })),
      },
    }
  } catch {
    return {
      status: 'fail',
      latency: Date.now() - t0,
      message: 'Freshness authority unavailable',
    }
  }
}

interface HealthResult {
  httpStatus: number
  body: Record<string, unknown>
}

/**
 * HTTP status contract (2026-11 audit P1-2): generic uptime monitors judge by
 * status code (or HEAD), not by JSON. A stale/unproven public leaderboard is
 * the outage users actually see, so it must be non-2xx:
 *   - all pass                          → 200 healthy
 *   - database fail                     → 503 unhealthy
 *   - freshness/publication proof fail  → 503 degraded (`stale: true`)
 *   - Redis-only fail                   → 202 degraded (serving still works)
 * The body is returned for every status so readers keep the details.
 */
async function computeHealth(): Promise<HealthResult> {
  const t0 = Date.now()
  const deadline = createRequestDeadline()

  try {
    // Independent launch authorities run in parallel so complete source closure
    // does not add its latency after the DB/Redis checks.
    const [database, redis, freshness] = await Promise.all([
      checkDatabase(deadline),
      checkRedis(deadline),
      checkFreshness(deadline),
    ])

    // API check (self-check: if we got here, the API layer is working)
    const api: { status: 'pass' | 'fail'; latency?: number; message?: string } = {
      status: 'pass',
      latency: Date.now() - t0,
      message: 'Responding',
    }

    const checks = { api, database, redis, freshness }

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
    if (database.status === 'fail') {
      status = 'unhealthy'
    } else if (redis.status === 'fail' || freshness.status === 'fail') {
      status = 'degraded'
    }
    const stale = freshness.status === 'fail'

    const httpStatus = status === 'unhealthy' || stale ? 503 : status === 'degraded' ? 202 : 200

    // Use deploy time for more stable uptime calculation
    const uptimeSeconds = Math.max(1, Math.round((Date.now() - deployTime) / 1000))

    return {
      httpStatus,
      body: {
        status,
        stale,
        timestamp: new Date().toISOString(),
        version,
        commit,
        uptime: uptimeSeconds,
        responseTimeMs: Date.now() - t0,
        checks,
        _detail: '/api/health/detailed',
      },
    }
  } finally {
    deadline.close()
  }
}

export async function GET() {
  const { httpStatus, body } = await computeHealth()
  return NextResponse.json(body, {
    status: httpStatus,
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  })
}

/** HEAD runs the same checks so HEAD-based monitors see the same verdict. */
export async function HEAD() {
  const { httpStatus } = await computeHealth()
  return new NextResponse(null, { status: httpStatus, headers: { 'Cache-Control': 'no-store' } })
}
