/**
 * 详细健康检查 API
 * 提供更全面的系统状态信息，用于监控和调试
 * 
 * GET /api/health/detailed
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkHealth as checkCacheHealth, getCacheStats } from '@/lib/cache'
import { getSupportedPlatforms } from '@/lib/cron/utils'
import { DEAD_BLOCKED_PLATFORMS } from '@/lib/constants/exchanges'

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
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !key) {
    return {
      database: { status: 'skip', message: 'Database connection not configured' },
      cronRuns: [],
    }
  }

  const start = Date.now()

  try {
    const supabase = createClient(url, key, {
      auth: { persistSession: false },
    })

    // 1. 测试数据库连接
    const { error: dbError } = await supabase
      .from('trader_snapshots')
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

export async function GET() {
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
