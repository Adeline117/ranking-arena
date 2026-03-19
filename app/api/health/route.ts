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
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return { status: 'skip', message: 'Not configured' }

  const t0 = Date.now()
  try {
    const { Redis } = await import('@upstash/redis')
    const redis = new Redis({ url, token })
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
  let freshness: { status: 'pass' | 'fail' | 'skip'; latency?: number; message?: string }
  try {
    const supabaseFresh = getSupabaseAdmin()
    const t1 = Date.now()
    const { data: latestRow, error: freshErr } = await supabaseFresh
      .from('leaderboard_ranks')
      .select('computed_at')
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const latency = Date.now() - t1
    if (freshErr) {
      freshness = { status: 'fail', message: freshErr.message, latency }
    } else if (!latestRow?.computed_at) {
      freshness = { status: 'fail', message: 'No leaderboard data found', latency }
    } else {
      const ageMs = Date.now() - new Date(latestRow.computed_at).getTime()
      const ageHours = ageMs / (1000 * 60 * 60)
      freshness = ageHours <= 2
        ? { status: 'pass', latency, message: `${ageHours.toFixed(1)}h old` }
        : { status: 'fail', latency, message: `Data is ${ageHours.toFixed(1)}h old (threshold: 2h)` }
    }
  } catch (e: unknown) {
    freshness = { status: 'skip', message: e instanceof Error ? e.message : 'Unknown' }
  }

  const checks = { api, database, redis, freshness }

  // Determine overall status:
  // - All pass → healthy (200)
  // - DB fail → unhealthy (503)
  // - Redis or freshness fail → degraded (202)
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
