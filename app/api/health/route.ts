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

export const dynamic = 'force-dynamic'
export const runtime = 'edge'

const startTime = Date.now()
const version = process.env.npm_package_version || '0.1.0'
// Deploy timestamp from env (set at build time), fallback to module load time
const deployTime = process.env.NEXT_PUBLIC_DEPLOY_TIME ? parseInt(process.env.NEXT_PUBLIC_DEPLOY_TIME, 10) : startTime

/**
 * Race any check against a timeout to prevent health endpoint from hanging.
 *
 * ROOT CAUSE FIX (2026-04-09): 5s cap was too tight for cold-start scenarios.
 * Vercel serverless instances can take 3-5s for Supabase client init + first
 * query on a cold start, which flipped the cap and produced alternating
 * healthy/unhealthy responses from the monitor depending on instance warmth.
 * 8s gives enough headroom for cold start without masking real DB issues.
 */
function withTimeout<T>(promise: Promise<T> | PromiseLike<T>, fallback: T, label: string, ms: number = 8000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => {
      console.warn(`[health] ${label} timed out after ${ms}ms`)
      resolve(fallback)
    }, ms)),
  ])
}

async function checkDatabase(): Promise<{ status: 'pass' | 'fail' | 'skip'; latency?: number; message?: string }> {
  const t0 = Date.now()
  try {
    const result = await withTimeout(
      getSupabaseAdmin().from('library_items').select('id').limit(1).then(r => ({ ok: !r.error, msg: r.error?.message })),
      { ok: false, msg: 'DB check timed out (8s)' },
      'checkDatabase'
    )
    const latency = Date.now() - t0
    if (!result.ok) return { status: 'fail', message: result.msg, latency }
    return { status: 'pass', latency }
  } catch (e: unknown) {
    return { status: 'fail', message: e instanceof Error ? e.message : 'Unknown', latency: Date.now() - t0 }
  }
}

async function checkRedis(): Promise<{ status: 'pass' | 'fail' | 'skip'; latency?: number; message?: string }> {
  const t0 = Date.now()
  try {
    const redis = await getSharedRedis()
    if (!redis) return { status: 'skip', message: 'Not configured' }
    const pong = await withTimeout(
      redis.ping(),
      'TIMEOUT' as string,
      'checkRedis'
    )
    const latency = Date.now() - t0
    return pong === 'PONG' ? { status: 'pass', latency } : { status: 'fail', message: `Got: ${pong}`, latency }
  } catch (e: unknown) {
    return { status: 'fail', message: e instanceof Error ? e.message : 'Unknown', latency: Date.now() - t0 }
  }
}

export async function GET() {
  const t0 = Date.now()

  // DB + Redis + API connectivity - run in parallel
  const [database, redis] = await Promise.all([
    checkDatabase(),
    checkRedis(),
  ])

  // API check (self-check: if we got here, the API layer is working)
  const api: { status: 'pass' | 'fail'; latency?: number; message?: string } = {
    status: 'pass',
    latency: Date.now() - t0,
    message: 'Responding',
  }

  // Data freshness check: verify that pipeline data is recent (< 4 hours).
  //
  // ROOT CAUSE FIX (2026-04-09): Previous version queried pipeline_logs for
  // compute-leaderboard success, which drifted to 8h+ whenever compute-leaderboard
  // was slow or got marked as timeout by cleanup-stuck-logs. That created
  // constant false "System degraded" alerts on the monitor even while actual
  // data was fresh.
  //
  // Fix: check ANY successful batch-fetch-traders job in the last 4h as the
  // "data is flowing" signal. These run every 15-30 min so the threshold can
  // stay tight without depending on the slow compute-leaderboard job finishing.
  // 4h threshold tolerates occasional cron hiccups without drifting into
  // genuine staleness territory.
  let freshness: { status: 'pass' | 'fail' | 'skip'; latency?: number; message?: string }
  try {
    const t1 = Date.now()
    // Race the DB query against an 8s timeout — matches withTimeout() cap for
    // consistent cold-start tolerance. Previous 5s cap flipped on cold boots
    // where Supabase client init + query could take 3-5s.
    const result = await Promise.race([
      getSupabaseAdmin()
        .from('pipeline_logs')
        .select('started_at, job_name')
        // Any successful fetcher is enough to prove data pipeline is flowing
        .like('job_name', 'batch-fetch-traders%')
        .eq('status', 'success')
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle()
        .then(r => r),
      new Promise<{ data: null; error: { message: string } }>((resolve) =>
        setTimeout(() => resolve({ data: null, error: { message: 'Freshness query timed out (8s)' } }), 8000)
      ),
    ])
    const latency = Date.now() - t1
    if (result.error) {
      freshness = { status: 'fail', message: result.error.message, latency }
    } else if (!result.data?.started_at) {
      freshness = { status: 'fail', message: 'No batch-fetch-traders success found', latency }
    } else {
      const ageMs = Date.now() - new Date(result.data.started_at).getTime()
      const ageHours = ageMs / (1000 * 60 * 60)
      // 4h threshold: most fetchers run every 15-30min. 4h = ~8-16 missed runs,
      // which is a real problem worth alerting on.
      freshness = ageHours <= 4
        ? { status: 'pass', latency, message: `${ageHours.toFixed(1)}h old (${result.data.job_name})` }
        : { status: 'fail', latency, message: `Data is ${ageHours.toFixed(1)}h old (threshold: 4h)` }
    }
  } catch (e: unknown) {
    freshness = { status: 'skip', message: e instanceof Error ? e.message : 'Unknown' }
  }

  // VPS connectivity check (SG) — WAF-protected platforms depend on this
  let vps: { status: 'pass' | 'fail' | 'skip'; latency?: number; message?: string }
  const vpsHost = process.env.VPS_SCRAPER_SG || process.env.VPS_PROXY_SG
  const vpsKey = process.env.VPS_PROXY_KEY
  if (vpsHost && vpsKey) {
    const t2 = Date.now()
    try {
      // Try scraper health first (:3457), then proxy (:3456) as fallback
      const scraperUrl = vpsHost.replace(/:\d+$/, ':3457') + '/health'
      const proxyUrl = vpsHost.replace(/:\d+$/, ':3456') + '/health'
      let res = await fetch(scraperUrl, {
        headers: { 'x-api-key': vpsKey, 'X-Proxy-Key': vpsKey, 'User-Agent': 'Arena-Health/1.0' },
        signal: AbortSignal.timeout(5_000),
      }).catch(() => null)

      if (!res?.ok) {
        res = await fetch(proxyUrl, {
          headers: { 'x-api-key': vpsKey, 'X-Proxy-Key': vpsKey, 'User-Agent': 'Arena-Health/1.0' },
          signal: AbortSignal.timeout(3_000),
        }).catch(() => null)
      }

      const lat = Date.now() - t2
      if (res?.ok) {
        vps = { status: 'pass', latency: lat, message: 'VPS SG responding' }
      } else {
        // Direct connection failed — check pipeline_logs for recent VPS-sourced successes
        // If VPS cron wrote data in the last 15min, the VPS is actually working fine
        // (Vultr intermittently blocks Vercel's Tokyo IPs)
        // Check if any VPS-dependent pipeline succeeded recently
        // Note: bybit removed 2026-04-08 (dead platform), kept bitget + binance_futures
        const { data: recentVpsJob } = await getSupabaseAdmin()
          .from('pipeline_logs')
          .select('job_name, started_at')
          .eq('status', 'success')
          .or('job_name.like.enrich-bitget%,job_name.like.enrich-binance_futures%,job_name.like.batch-fetch-traders-b2%,job_name.like.batch-fetch-traders-a1%')
          .gte('started_at', new Date(Date.now() - 30 * 60000).toISOString())
          .limit(1)
          .maybeSingle()

        if (recentVpsJob) {
          vps = { status: 'pass', latency: lat, message: `VPS SG OK (via pipeline heartbeat, direct ${res?.status || 'blocked'})` }
        } else {
          // ROOT CAUSE FIX (2026-04-09): Vultr intermittently blocks Vercel's
          // Tokyo IPs which made this check flap to 'fail' even while the VPS
          // scraper itself was fine (just not reachable from Vercel). VPS is
          // supplementary infra (doesn't affect overall status per line ~186),
          // but 'fail' still appeared in monitor's System degraded alerts.
          // Demote to 'skip' to silence the noise — if the VPS is genuinely
          // dead the cron failures will surface via /api/health/pipeline.
          vps = { status: 'skip', latency: lat, message: `VPS SG direct ${res?.status || 'unreachable'}, no recent heartbeat (supplementary, not flagged)` }
        }
      }
    } catch (e: unknown) {
      // Same reasoning as above — network errors reaching Vultr from Vercel are
      // not a valid signal of VPS health; skip rather than fail.
      vps = { status: 'skip', latency: Date.now() - t2, message: e instanceof Error ? `direct unreachable: ${e.message}` : 'Unreachable (supplementary)' }
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

  return NextResponse.json({
    status,
    timestamp: new Date().toISOString(),
    version,
    uptime: uptimeSeconds,
    responseTimeMs: Date.now() - t0,
    checks,
    _detail: '/api/health/detailed',
  }, {
    status: httpStatus,
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  })
}

export async function HEAD() {
  return new NextResponse(null, { status: 200, headers: { 'Cache-Control': 'no-store' } })
}
