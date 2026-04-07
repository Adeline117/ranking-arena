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

async function checkDatabase(): Promise<{ status: 'pass' | 'fail' | 'skip'; latency?: number; message?: string }> {
  const supabase = getSupabaseAdmin()

  const t0 = Date.now()
  try {
    const { error } = await supabase.from('library_items').select('id').limit(1)
    const latency = Date.now() - t0
    if (error) return { status: 'fail', message: error.message, latency }
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
    const pong = await redis.ping()
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

  // Data freshness check: verify that leaderboard data is recent (< 2 hours)
  // Uses pipeline_logs (indexed, small table) instead of leaderboard_ranks ORDER BY computed_at
  // which caused statement_timeout on 75K+ rows without a covering index.
  let freshness: { status: 'pass' | 'fail' | 'skip'; latency?: number; message?: string }
  try {
    const supabaseFresh = getSupabaseAdmin()
    const t1 = Date.now()
    const { data: lastCompute, error: freshErr } = await supabaseFresh
      .from('pipeline_logs')
      .select('started_at')
      .eq('job_name', 'compute-leaderboard')
      .eq('status', 'success')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const latency = Date.now() - t1
    if (freshErr) {
      freshness = { status: 'fail', message: freshErr.message, latency }
    } else if (!lastCompute?.started_at) {
      freshness = { status: 'fail', message: 'No compute-leaderboard success found', latency }
    } else {
      const ageMs = Date.now() - new Date(lastCompute.started_at).getTime()
      const ageHours = ageMs / (1000 * 60 * 60)
      freshness = ageHours <= 2
        ? { status: 'pass', latency, message: `${ageHours.toFixed(1)}h old` }
        : { status: 'fail', latency, message: `Data is ${ageHours.toFixed(1)}h old (threshold: 2h)` }
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
        // Check if VPS-dependent pipelines succeeded recently (bybit/bitget use VPS scraper)
        const { data: recentVpsJob } = await getSupabaseAdmin()
          .from('pipeline_logs')
          .select('job_name, started_at')
          .eq('status', 'success')
          .or('job_name.like.enrich-bybit%,job_name.like.enrich-bitget%,job_name.like.enrich-binance_futures%,job_name.like.batch-fetch-traders-b1%')
          .gte('started_at', new Date(Date.now() - 30 * 60000).toISOString())
          .limit(1)
          .maybeSingle()

        if (recentVpsJob) {
          vps = { status: 'pass', latency: lat, message: `VPS SG OK (via pipeline heartbeat, direct ${res?.status || 'blocked'})` }
        } else {
          vps = { status: 'fail', latency: lat, message: `VPS SG returned ${res?.status || 'unreachable'}` }
        }
      }
    } catch (e: unknown) {
      vps = { status: 'fail', latency: Date.now() - t2, message: e instanceof Error ? e.message : 'Unreachable' }
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
