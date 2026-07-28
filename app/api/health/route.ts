/**
 * 健康检查 API (轻量版)
 *
 * GET /api/health - 返回应用健康状态
 * 只检查：数据库连通性 + Redis 连通性
 * 详细信息（平台新鲜度、cron状态等）请用 /api/health/detailed
 * 目标响应时间 <200ms
 */

import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getSharedRedis } from '@/lib/cache/redis-client'
import { safeParseInt } from '@/lib/utils/safe-parse'
import { logger } from '@/lib/logger'
import { buildFreshnessReport } from '@/lib/rankings/build-freshness-report'

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

// The shortest production caller aborts at 15s. Core and supplementary checks
// share one absolute handler deadline, leaving over five seconds for transport,
// cold start, and response serialization.
const HANDLER_DEADLINE_MS = 9_500
const RESPONSE_RESERVE_MS = 250
const CORE_CHECK_TIMEOUT_MS = 8_000
const VPS_SCRAPER_TIMEOUT_MS = 2_000
const VPS_PROXY_TIMEOUT_MS = 1_000
const VPS_HEARTBEAT_TIMEOUT_MS = 1_000

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
}> {
  const t0 = Date.now()
  try {
    const report = await withTimeout(
      deadline,
      CORE_CHECK_TIMEOUT_MS,
      null,
      'checkFreshness',
      (signal) => buildFreshnessReport(signal)
    )
    const latency = Date.now() - t0
    if (!report) {
      return { status: 'fail', latency, message: 'Freshness authority timed out' }
    }

    const { total, fresh, stale, critical, unknown } = report.summary
    const message = `${fresh}/${total} sources fresh; ${stale} stale; ${critical} critical; ${unknown} unknown`
    return { status: report.ok ? 'pass' : 'fail', latency, message }
  } catch {
    return {
      status: 'fail',
      latency: Date.now() - t0,
      message: 'Freshness authority unavailable',
    }
  }
}

export async function GET() {
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

    // VPS connectivity check (SG) — WAF-protected platforms depend on this.
    // Do not serialize supplementary network work after a known core DB outage:
    // the response is already unhealthy and must return within the core budget.
    let vps: { status: 'pass' | 'fail' | 'skip'; latency?: number; message?: string }
    const vpsHost = process.env.VPS_SCRAPER_SG || process.env.VPS_PROXY_SG
    const vpsKey = process.env.VPS_PROXY_KEY
    if (database.status === 'fail') {
      vps = { status: 'skip', message: 'Skipped because the core database is unavailable' }
    } else if (vpsHost && vpsKey && deadline.remaining(1) > 0) {
      const t2 = Date.now()
      try {
        // Try scraper health first (:3457), then proxy (:3456) as fallback.
        // Every probe is capped by the request's remaining absolute budget.
        const scraperUrl = vpsHost.replace(/:\d+$/, ':3457') + '/health'
        const proxyUrl = vpsHost.replace(/:\d+$/, ':3456') + '/health'
        let res = await withTimeout(
          deadline,
          VPS_SCRAPER_TIMEOUT_MS,
          null,
          'checkVpsScraper',
          (signal) =>
            fetch(scraperUrl, {
              headers: {
                'x-api-key': vpsKey,
                'X-Proxy-Key': vpsKey,
                'User-Agent': 'Arena-Health/1.0',
              },
              signal,
            }).catch(() => null)
        )

        if (!res?.ok && deadline.remaining(1) > 0) {
          res = await withTimeout(deadline, VPS_PROXY_TIMEOUT_MS, null, 'checkVpsProxy', (signal) =>
            fetch(proxyUrl, {
              headers: {
                'x-api-key': vpsKey,
                'X-Proxy-Key': vpsKey,
                'User-Agent': 'Arena-Health/1.0',
              },
              signal,
            }).catch(() => null)
          )
        }

        const lat = Date.now() - t2
        if (res?.ok) {
          vps = { status: 'pass', latency: lat, message: 'VPS SG responding' }
        } else if (deadline.remaining(1) <= 0) {
          vps = {
            status: 'skip',
            latency: lat,
            message: 'VPS SG check skipped because the health response deadline was exhausted',
          }
        } else {
          // Direct connection failed — check pipeline_logs for recent VPS-sourced successes
          // If VPS cron wrote data in the last 15min, the VPS is actually working fine
          // (Vultr intermittently blocks Vercel's Tokyo IPs)
          // Check if any VPS-dependent pipeline succeeded recently
          // Note: bybit removed 2026-04-08 (dead platform), kept bitget + binance_futures
          const recentVpsJob = await withTimeout(
            deadline,
            VPS_HEARTBEAT_TIMEOUT_MS,
            null,
            'checkVpsHeartbeat',
            (signal) =>
              getSupabaseAdmin()
                .from('pipeline_logs')
                .select('job_name, started_at')
                .eq('status', 'success')
                .or(
                  'job_name.like.enrich-bitget%,job_name.like.enrich-binance_futures%,job_name.like.batch-fetch-traders-b2%,job_name.like.batch-fetch-traders-a1%'
                )
                .gte('started_at', new Date(Date.now() - 30 * 60000).toISOString())
                .limit(1)
                .abortSignal(signal)
                .maybeSingle()
                .then(({ data, error }) => {
                  if (error) throw error
                  return data
                })
          )

          if (recentVpsJob) {
            vps = {
              status: 'pass',
              latency: lat,
              message: `VPS SG OK (via pipeline heartbeat, direct ${res?.status || 'blocked'})`,
            }
          } else {
            // ROOT CAUSE FIX (2026-04-09): Vultr intermittently blocks Vercel's
            // Tokyo IPs which made this check flap to 'fail' even while the VPS
            // scraper itself was fine (just not reachable from Vercel). VPS is
            // supplementary infra (doesn't affect overall status per line ~186),
            // but 'fail' still appeared in monitor's System degraded alerts.
            // Demote to 'skip' to silence the noise — if the VPS is genuinely
            // dead the cron failures will surface via /api/health/pipeline.
            vps = {
              status: 'skip',
              latency: lat,
              message: `VPS SG direct ${res?.status || 'unreachable'}, no recent heartbeat (supplementary, not flagged)`,
            }
          }
        }
      } catch (e: unknown) {
        // Same reasoning as above — network errors reaching Vultr from Vercel are
        // not a valid signal of VPS health; skip rather than fail.
        logger.warn('[health] VPS SG dependency threw', {
          error: e instanceof Error ? e.message : String(e),
        })
        vps = {
          status: 'skip',
          latency: Date.now() - t2,
          message: 'VPS SG unavailable (supplementary)',
        }
      }
    } else if (vpsHost && vpsKey) {
      vps = {
        status: 'skip',
        message: 'VPS SG check skipped because the health response deadline was exhausted',
      }
    } else {
      vps = { status: 'skip', message: 'VPS not configured' }
    }

    const checks = { api, database, redis, freshness, vps }

    // Determine overall status:
    // - All pass → healthy (200)
    // - DB fail → unhealthy (503)
    // - Redis or freshness fail → degraded (202)
    // - VPS fail → still healthy (VPS is supplementary, not core infrastructure)
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
    if (database.status === 'fail') {
      status = 'unhealthy'
    } else if (redis.status === 'fail' || freshness.status === 'fail') {
      status = 'degraded'
    }

    const httpStatus = status === 'unhealthy' ? 503 : status === 'degraded' ? 202 : 200

    // Use deploy time for more stable uptime calculation
    const uptimeSeconds = Math.max(1, Math.round((Date.now() - deployTime) / 1000))

    return NextResponse.json(
      {
        status,
        timestamp: new Date().toISOString(),
        version,
        commit,
        uptime: uptimeSeconds,
        responseTimeMs: Date.now() - t0,
        checks,
        _detail: '/api/health/detailed',
      },
      {
        status: httpStatus,
        headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
      }
    )
  } finally {
    deadline.close()
  }
}

export async function HEAD() {
  return new NextResponse(null, { status: 200, headers: { 'Cache-Control': 'no-store' } })
}
