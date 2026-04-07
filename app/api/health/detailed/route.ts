/**
 * 详细健康检查 API
 * 提供更全面的系统状态信息，用于监控和调试
 *
 * GET /api/health/detailed                     - Full detailed health
 * GET /api/health/detailed?section=connectors  - Connector status (was /api/health/connectors)
 * GET /api/health/detailed?section=dependencies - Dependencies (was /api/health/dependencies)
 *
 * Merges:
 *   - /api/health/connectors (deleted)
 *   - /api/health/dependencies (deleted)
 */

import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { checkHealth as checkCacheHealth, getCacheStats } from '@/lib/cache'
import { getSupportedPlatforms } from '@/lib/cron/utils'
import { DEAD_BLOCKED_PLATFORMS } from '@/lib/constants/exchanges'
import { getFireAndForgetStats } from '@/lib/utils/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 应用启动时间
const startTime = Date.now()

interface DetailedHealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy'
  timestamp: string
  version: string
  environment: string
  uptime: number
  checks: {
    database: ServiceStatus
    redis: ServiceStatus
    cache: CacheStatus
    memory: MemoryStatus
    cron: CronStatus
  }
  metrics: SystemMetrics
}

interface ServiceStatus {
  status: 'pass' | 'fail' | 'skip'
  latency?: number
  message?: string
}

interface CacheStatus {
  redis: boolean
  memoryFallbackActive: boolean
  stats: {
    hits: number
    misses: number
    errors: number
    hitRate: string
  }
  memoryCache: {
    size: number
    maxSize: number
  }
}

interface MemoryStatus {
  status: 'pass' | 'fail'
  heapUsed: number
  heapTotal: number
  external: number
  rss: number
  usagePercent: number
}

interface CronStatus {
  platforms: string[]
  lastRuns: CronRunInfo[]
  status: 'pass' | 'fail' | 'unknown'
}

interface CronRunInfo {
  platform: string
  ran_at: string | null
  success: boolean | null
}

interface SystemMetrics {
  requestsPerMinute?: number
  averageResponseTime?: number
  errorRate?: number
  activeConnections?: number
}

/**
 * 检查数据库连接并获取 Cron 运行状态
 */
async function checkDatabaseAndCron(): Promise<{
  database: ServiceStatus
  cronRuns: CronRunInfo[]
}> {
  const start = Date.now()

  try {
    const supabase = getSupabaseAdmin()

    // 1. 测试数据库连接
    const { error: dbError } = await supabase
      .from('leaderboard_ranks')
      .select('count')
      .limit(1)

    if (dbError) {
      return {
        database: { status: 'fail', message: dbError.message, latency: Date.now() - start },
        cronRuns: [],
      }
    }

    // 2. 获取最近的 Cron 运行记录 (filter out dead/blocked platforms)
    const deadSet = new Set(DEAD_BLOCKED_PLATFORMS as string[])
    const platforms = getSupportedPlatforms().filter(p => !deadSet.has(p))
    const cronRuns: CronRunInfo[] = []

    try {
      const { data: cronLogs } = await supabase
        .from('cron_logs')
        .select('name, ran_at, result')
        .order('ran_at', { ascending: false })
        .limit(20)

      if (cronLogs) {
        // 为每个平台找到最近的运行记录
        for (const platform of platforms) {
          const platformLog = cronLogs.find(
            (log) => log.name === `fetch-traders-${platform}` || log.name === 'fetch-traders-all'
          )

          if (platformLog) {
            let success = true
            try {
              const result = JSON.parse(platformLog.result || '[]')
              success = Array.isArray(result) && result.every((r: { success?: boolean }) => r.success)
            } catch {
              success = false
            }

            cronRuns.push({
              platform,
              ran_at: platformLog.ran_at,
              success,
            })
          } else {
            cronRuns.push({
              platform,
              ran_at: null,
              success: null,
            })
          }
        }
      }
    } catch {
      // cron_logs 表可能不存在，忽略错误
      for (const platform of platforms) {
        cronRuns.push({ platform, ran_at: null, success: null })
      }
    }

    return {
      database: { status: 'pass', latency: Date.now() - start },
      cronRuns,
    }
  } catch (error: unknown) {
    return {
      database: {
        status: 'fail',
        message: error instanceof Error ? error.message : 'Unknown error',
        latency: Date.now() - start,
      },
      cronRuns: [],
    }
  }
}

/**
 * 获取内存状态
 */
function getMemoryStatus(): MemoryStatus {
  const memory = process.memoryUsage()
  const heapUsed = Math.round(memory.heapUsed / 1024 / 1024)
  const heapTotal = Math.round(memory.heapTotal / 1024 / 1024)
  const external = Math.round(memory.external / 1024 / 1024)
  const rss = Math.round(memory.rss / 1024 / 1024)
  const usagePercent = Math.round((memory.heapUsed / memory.heapTotal) * 100)

  return {
    status: usagePercent > 90 ? 'fail' : 'pass',
    heapUsed,
    heapTotal,
    external,
    rss,
    usagePercent,
  }
}

/**
 * 获取缓存状态
 */
async function getCacheStatus(): Promise<CacheStatus> {
  const health = await checkCacheHealth()
  const stats = getCacheStats()

  const totalRequests = stats.hits + stats.misses
  const hitRate = totalRequests > 0 ? ((stats.hits / totalRequests) * 100).toFixed(1) + '%' : 'N/A'

  return {
    redis: health.redis,
    memoryFallbackActive: stats.memoryFallbackActive,
    stats: {
      hits: stats.hits,
      misses: stats.misses,
      errors: stats.errors,
      hitRate,
    },
    memoryCache: health.memory,
  }
}

/**
 * 计算整体状态
 */
function calculateStatus(checks: DetailedHealthResponse['checks']): DetailedHealthResponse['status'] {
  // 数据库失败 = 不健康
  if (checks.database.status === 'fail') {
    return 'unhealthy'
  }

  // Redis 失败但内存缓存工作 = 降级
  if (!checks.cache.redis && checks.cache.memoryFallbackActive) {
    return 'degraded'
  }

  // 内存过高 = 降级
  if (checks.memory.status === 'fail') {
    return 'degraded'
  }

  // Cron 失败 = 降级
  if (checks.cron.status === 'fail') {
    return 'degraded'
  }

  return 'healthy'
}

// ---------- Connectors section (was /api/health/connectors) ----------

const ACTIVE_PLATFORMS = [
  'binance_futures', 'binance_spot', 'bitget_futures', 'okx_futures',
  'htx_futures', 'mexc', 'coinex', 'bingx', 'gateio', 'xt', 'btcc',
  'bitunix', 'bitfinex', 'toobit', 'etoro',
  'hyperliquid', 'gmx', 'dydx', 'gains', 'jupiter_perps', 'aevo', 'drift',
  'okx_web3', 'binance_web3', 'web3_bot',
]

async function getConnectorsSection(cronSecret: string | undefined, authHeader: string | null) {
  // Connectors section requires CRON_SECRET auth
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const [{ data: logs }, { data: freshness }] = await Promise.all([
    supabase
      .from('pipeline_logs')
      .select('job_name, status, started_at, ended_at, duration_ms, records_processed, error_message')
      .like('job_name', 'batch-fetch-traders%')
      .gte('started_at', oneDayAgo)
      .order('started_at', { ascending: false }),
    // Get latest computed_at per source using leaderboard_count_cache
    // (was: fetch 5000 rows and dedupe in JS)
    supabase
      .from('leaderboard_count_cache')
      .select('source, updated_at')
      .neq('source', '_all'),
  ])

  const latestByPlatform = new Map<string, string>()
  for (const row of freshness || []) {
    latestByPlatform.set(row.source, row.updated_at)
  }

  const groupStats = new Map<string, { total: number; success: number; errors: string[] }>()
  for (const log of logs || []) {
    const group = log.job_name
    const stats = groupStats.get(group) || { total: 0, success: 0, errors: [] }
    stats.total++
    if (log.status === 'success') stats.success++
    if (log.error_message) stats.errors.push(log.error_message.slice(0, 100))
    groupStats.set(group, stats)
  }

  const connectors: Record<string, {
    status: 'healthy' | 'stale' | 'critical'
    last_update: string | null
    staleness_hours: number | null
  }> = {}

  for (const platform of ACTIVE_PLATFORMS) {
    const latest = latestByPlatform.get(platform)
    const hoursAgo = latest ? (Date.now() - new Date(latest).getTime()) / (60 * 60 * 1000) : null
    connectors[platform] = {
      status: hoursAgo === null ? 'critical' : hoursAgo > 24 ? 'critical' : hoursAgo > 8 ? 'stale' : 'healthy',
      last_update: latest || null,
      staleness_hours: hoursAgo ? Math.round(hoursAgo * 10) / 10 : null,
    }
  }

  const healthy = Object.values(connectors).filter(c => c.status === 'healthy').length
  const stale = Object.values(connectors).filter(c => c.status === 'stale').length
  const critical = Object.values(connectors).filter(c => c.status === 'critical').length

  return NextResponse.json({
    status: critical > 0 ? 'degraded' : 'healthy',
    timestamp: new Date().toISOString(),
    summary: { total: ACTIVE_PLATFORMS.length, healthy, stale, critical },
    connectors,
    pipeline_groups: Object.fromEntries(
      Array.from(groupStats.entries()).map(([k, v]) => [
        k,
        { runs_24h: v.total, success_rate: v.total > 0 ? Math.round((v.success / v.total) * 100) : 0, recent_errors: v.errors.slice(0, 3) },
      ])
    ),
  })
}

// ---------- Dependencies section (was /api/health/dependencies) ----------

interface DependencyStatus {
  status: 'up' | 'down' | 'degraded' | 'skip'
  latencyMs: number
  message?: string
}

async function checkWithTimeout(
  name: string,
  fn: () => Promise<DependencyStatus>,
  timeoutMs = 10_000
): Promise<[string, DependencyStatus]> {
  try {
    const result = await Promise.race([
      fn(),
      new Promise<DependencyStatus>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeoutMs)
      ),
    ])
    return [name, result]
  } catch (err) {
    return [name, { status: 'down', latencyMs: timeoutMs, message: err instanceof Error ? err.message : 'Unknown error' }]
  }
}

async function checkSupabaseDep(): Promise<DependencyStatus> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return { status: 'skip', latencyMs: 0, message: 'Not configured' }
  const start = Date.now()
  const res = await fetch(`${url}/rest/v1/`, { method: 'HEAD', headers: { apikey: key, Authorization: `Bearer ${key}` } })
  return { status: res.ok ? 'up' : 'down', latencyMs: Date.now() - start, message: res.ok ? undefined : `HTTP ${res.status}` }
}

async function checkRedisDep(): Promise<DependencyStatus> {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return { status: 'skip', latencyMs: 0, message: 'Not configured' }
  const start = Date.now()
  const res = await fetch(`${url}/ping`, { headers: { Authorization: `Bearer ${token}` } })
  const body = await res.json().catch(() => null)
  const pong = body?.result === 'PONG'
  return { status: pong ? 'up' : 'down', latencyMs: Date.now() - start, message: pong ? undefined : `Response: ${JSON.stringify(body)}` }
}

async function checkUrl(url: string): Promise<DependencyStatus> {
  const start = Date.now()
  const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) })
  return { status: res.ok || res.status === 403 ? 'up' : 'degraded', latencyMs: Date.now() - start, message: res.ok ? undefined : `HTTP ${res.status}` }
}

const EXCHANGE_ENDPOINTS: Record<string, string> = {
  binance: 'https://fapi.binance.com/fapi/v1/ping',
  bybit: 'https://api.bybit.com/v5/market/time',
  okx: 'https://www.okx.com/api/v5/public/time',
  bitget: 'https://api.bitget.com/api/v2/public/time',
  hyperliquid: 'https://api.hyperliquid.xyz/info',
  mexc: 'https://api.mexc.com/api/v3/ping',
  kucoin: 'https://api.kucoin.com/api/v1/timestamp',
  gateio: 'https://api.gateio.ws/api/v4/spot/currencies/BTC',
  htx: 'https://api.huobi.pro/v1/common/timestamp',
  coinex: 'https://api.coinex.com/v2/ping',
}

async function getDependenciesSection() {
  const checks = await Promise.all([
    checkWithTimeout('supabase', checkSupabaseDep),
    checkWithTimeout('redis', checkRedisDep),
    checkWithTimeout('tradingview_cdn', () => checkUrl('https://s3.tradingview.com/tv.js')),
    ...Object.entries(EXCHANGE_ENDPOINTS).map(([name, url]) =>
      checkWithTimeout(name, () => checkUrl(url))
    ),
  ])

  const dependencies: Record<string, DependencyStatus> = {}
  for (const [name, status] of checks) {
    dependencies[name] = status
  }

  const statuses = Object.values(dependencies)
  const coreDown = dependencies.supabase?.status === 'down'
  const anyDown = statuses.some((s) => s.status === 'down')

  const status = coreDown ? 'unhealthy' : anyDown ? 'degraded' : 'healthy'

  return NextResponse.json(
    { status, timestamp: new Date().toISOString(), dependencies },
    { status: status === 'unhealthy' ? 503 : 200, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } }
  )
}

// ---------- Main GET handler ----------

export async function GET(request: NextRequest) {
  const section = request.nextUrl.searchParams.get('section')

  // Route to specific section
  if (section === 'connectors') {
    const authHeader = request.headers.get('authorization')
    return getConnectorsSection(env.CRON_SECRET, authHeader)
  }
  if (section === 'dependencies') {
    return getDependenciesSection()
  }

  // Default: full detailed health check
  try {
    // 并行执行检查
    const [{ database, cronRuns }, cacheStatus] = await Promise.all([
      checkDatabaseAndCron(),
      getCacheStatus(),
    ])

    const memory = getMemoryStatus()

    // 计算 Cron 状态
    const cronHasFailures = cronRuns.some((r) => r.success === false)
    const cronHasRecent = cronRuns.some((r) => {
      if (!r.ran_at) return false
      const hourAgo = Date.now() - 7 * 60 * 60 * 1000 // 7 小时内（允许 6 小时间隔 + 1 小时容差）
      return new Date(r.ran_at).getTime() > hourAgo
    })

    const cronStatus: CronStatus = {
      platforms: getSupportedPlatforms(),
      lastRuns: cronRuns,
      status: cronHasFailures ? 'fail' : cronHasRecent ? 'pass' : 'unknown',
    }

    const checks = {
      database,
      redis: { status: cacheStatus.redis ? 'pass' : 'fail' } as ServiceStatus,
      cache: cacheStatus,
      memory,
      cron: cronStatus,
    }

    // Surface fire-and-forget background failures (inspired by Uptime Kuma's
    // approach to making hidden failures visible). These are operations like
    // cache invalidation, analytics tracking, etc. that run in the background
    // and may silently fail without anyone noticing.
    const backgroundFailures = getFireAndForgetStats()

    const response: DetailedHealthResponse = {
      status: calculateStatus(checks),
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '0.1.0',
      environment: process.env.NODE_ENV || 'development',
      uptime: Math.round((Date.now() - startTime) / 1000),
      checks,
      metrics: {
        // 这些指标需要单独的监控系统收集
        // 这里只提供占位
      },
      ...(Object.keys(backgroundFailures).length > 0 ? { backgroundFailures } : {}),
    }

    const httpStatus = response.status === 'healthy' ? 200 : response.status === 'degraded' ? 200 : 503

    return NextResponse.json(response, {
      status: httpStatus,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Content-Type': 'application/json',
      },
    })
  } catch (error: unknown) {
    return NextResponse.json(
      {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json',
        },
      }
    )
  }
}
