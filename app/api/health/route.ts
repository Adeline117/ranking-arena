/**
 * 健康检查 API (增强版)
 * 
 * GET /api/health - 返回应用健康状态
 * 包含：数据库连接、Redis连接、各平台数据新鲜度、最近cron执行状态
 * 目标响应时间 <500ms
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface CheckResult {
  status: 'pass' | 'fail' | 'skip'
  message?: string
  latency?: number
}

interface PlatformFreshness {
  platform: string
  lastUpdate: string | null
  ageHours: number | null
  status: 'fresh' | 'stale' | 'critical' | 'unknown'
}

const startTime = Date.now()
const version = process.env.npm_package_version || '0.1.0'

// 平台类型分类
const DEX_PLATFORMS = new Set(['gmx', 'kwenta', 'gains', 'mux', 'okx_web3', 'binance_web3'])

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

async function checkDatabase(): Promise<CheckResult> {
  const supabase = getSupabase()
  if (!supabase) return { status: 'skip', message: 'Not configured' }

  const t0 = Date.now()
  try {
    const { error } = await supabase.from('trader_snapshots').select('id').limit(1)
    const latency = Date.now() - t0
    if (error) return { status: 'fail', message: error.message, latency }
    return { status: 'pass', latency }
  } catch (e: unknown) {
    return { status: 'fail', message: e instanceof Error ? e.message : 'Unknown', latency: Date.now() - t0 }
  }
}

async function checkRedis(): Promise<CheckResult> {
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

async function checkPlatformFreshness(): Promise<PlatformFreshness[]> {
  const supabase = getSupabase()
  if (!supabase) return []

  try {
    // Single efficient query: get latest snapshot per platform using a raw approach
    const { data, error } = await supabase
      .rpc('get_platform_freshness')
      .select('*')

    // If RPC doesn't exist, fallback to a simpler query
    if (error) {
      // Fallback: query trader_sources for last update times (much faster than scanning snapshots)
      const { data: sources } = await supabase
        .from('trader_sources')
        .select('source, updated_at')
        .not('updated_at', 'is', null)

      if (!sources) return []

      // Group by platform, get latest
      const latestByPlatform = new Map<string, string>()
      for (const s of sources) {
        const existing = latestByPlatform.get(s.source)
        if (!existing || s.updated_at > existing) {
          latestByPlatform.set(s.source, s.updated_at)
        }
      }

      const now = Date.now()
      return Array.from(latestByPlatform.entries()).map(([platform, lastUpdate]) => {
        const ageMs = now - new Date(lastUpdate).getTime()
        const ageHours = Math.round(ageMs / 36e5 * 10) / 10
        const isDex = DEX_PLATFORMS.has(platform)
        const staleThresholdH = isDex ? 4 : 2
        const criticalThresholdH = isDex ? 12 : 8
        let status: PlatformFreshness['status'] = 'fresh'
        if (ageHours >= criticalThresholdH) status = 'critical'
        else if (ageHours >= staleThresholdH) status = 'stale'
        return { platform, lastUpdate, ageHours, status }
      }).sort((a, b) => a.platform.localeCompare(b.platform))
    }

    return data || []
  } catch {
    return []
  }
}

async function checkRecentCron(): Promise<CheckResult> {
  const supabase = getSupabase()
  if (!supabase) return { status: 'skip', message: 'Not configured' }

  try {
    // Check cron_logs or scrape_telemetry for recent execution
    const { data, error } = await supabase
      .from('scrape_telemetry')
      .select('platform, created_at, status')
      .order('created_at', { ascending: false })
      .limit(5)

    if (error) {
      // Table might not exist, skip gracefully
      return { status: 'skip', message: error.message }
    }

    if (!data || data.length === 0) {
      return { status: 'fail', message: 'No recent cron executions found' }
    }

    const latest = data[0]
    const ageMs = Date.now() - new Date(latest.created_at).getTime()
    const ageHours = Math.round(ageMs / 36e5 * 10) / 10

    if (ageHours > 24) {
      return { status: 'fail', message: `Last cron was ${ageHours}h ago (${latest.platform})` }
    }

    return { status: 'pass', message: `Last: ${latest.platform} ${ageHours}h ago (${latest.status})` }
  } catch {
    return { status: 'skip', message: 'scrape_telemetry not available' }
  }
}

function checkMemory(): CheckResult {
  try {
    const mem = process.memoryUsage()
    const usedMB = Math.round(mem.heapUsed / 1048576)
    const totalMB = Math.round(mem.heapTotal / 1048576)
    const pct = Math.round((mem.heapUsed / mem.heapTotal) * 100)
    if (pct > 90) return { status: 'fail', message: `${usedMB}/${totalMB}MB (${pct}%)` }
    return { status: 'pass', message: `${usedMB}/${totalMB}MB (${pct}%)` }
  } catch {
    return { status: 'skip', message: 'Cannot read memory' }
  }
}

export async function GET() {
  const t0 = Date.now()

  // Run checks in parallel for speed
  const [database, redis, platformFreshness, cronStatus] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkPlatformFreshness(),
    checkRecentCron(),
  ])
  const memory = checkMemory()

  const checks = { database, redis, memory, cronStatus }

  // Calculate overall status
  let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
  if (database.status === 'fail') status = 'unhealthy'
  else if (redis.status === 'fail' || cronStatus.status === 'fail') status = 'degraded'

  const stalePlatforms = platformFreshness.filter(p => p.status === 'stale' || p.status === 'critical')
  if (stalePlatforms.length > platformFreshness.length * 0.5) status = 'degraded'

  const responseTimeMs = Date.now() - t0

  const response = {
    status,
    timestamp: new Date().toISOString(),
    version,
    uptime: Math.round((Date.now() - startTime) / 1000),
    responseTimeMs,
    checks,
    platformFreshness: {
      summary: {
        total: platformFreshness.length,
        fresh: platformFreshness.filter(p => p.status === 'fresh').length,
        stale: platformFreshness.filter(p => p.status === 'stale').length,
        critical: platformFreshness.filter(p => p.status === 'critical').length,
      },
      platforms: platformFreshness,
    },
  }

  return NextResponse.json(response, {
    status: status === 'unhealthy' ? 503 : 200,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  })
}

export async function HEAD() {
  return new NextResponse(null, { status: 200, headers: { 'Cache-Control': 'no-store' } })
}
