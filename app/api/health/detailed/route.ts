/**
 * 详细健康检查 API
 * 提供更全面的系统状态信息
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { Redis } from '@upstash/redis'

// ============================================
// 类型定义
// ============================================

interface DetailedCheckResult {
  status: 'pass' | 'fail' | 'warn' | 'skip'
  message?: string
  latency?: number
  details?: Record<string, unknown>
}

interface DetailedHealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy'
  timestamp: string
  version: string
  environment: string
  uptime: number
  checks: {
    database: DetailedCheckResult
    redis: DetailedCheckResult
    memory: DetailedCheckResult
    cpu: DetailedCheckResult
    disk: DetailedCheckResult
    externalApis: Record<string, DetailedCheckResult>
  }
  metrics: {
    requestsPerMinute?: number
    averageLatency?: number
    errorRate?: number
    activeConnections?: number
  }
}

// ============================================
// 常量
// ============================================

const startTime = Date.now()
const version = process.env.npm_package_version || '0.1.0'
const environment = process.env.NODE_ENV || 'development'

// 内存缓存的指标（可从外部服务更新）
const metricsCache = new Map<string, number>()

/**
 * 获取指标值
 * 可从 Prometheus、Datadog 等外部服务获取
 */
function getMetric(name: string): number | undefined {
  return metricsCache.get(name)
}

// 外部 API 列表
const EXTERNAL_APIS = [
  { name: 'binance', url: 'https://api.binance.com/api/v3/ping', timeout: 5000 },
  { name: 'coingecko', url: 'https://api.coingecko.com/api/v3/ping', timeout: 5000 },
]

// ============================================
// 检查函数
// ============================================

/**
 * 检查数据库（详细版）
 */
async function checkDatabaseDetailed(): Promise<DetailedCheckResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  
  if (!url || !key) {
    return { status: 'skip', message: '未配置数据库连接' }
  }
  
  const checkStart = Date.now()
  
  try {
    const supabase = createClient(url, key, {
      auth: { persistSession: false },
    })
    
    // 多个检查
    const checks = await Promise.all([
      // 连接测试
      supabase.from('trader_snapshots').select('count').limit(1),
      // 查询延迟测试
      supabase.from('posts').select('id').limit(1),
    ])
    
    const latency = Date.now() - checkStart
    const errors = checks.filter(c => c.error)
    
    if (errors.length > 0) {
      return {
        status: 'fail',
        message: errors.map(e => e.error?.message).join('; '),
        latency,
        details: {
          failedChecks: errors.length,
          totalChecks: checks.length,
        },
      }
    }
    
    // 延迟警告
    if (latency > 1000) {
      return {
        status: 'warn',
        message: '数据库响应较慢',
        latency,
        details: {
          threshold: 1000,
        },
      }
    }
    
    return {
      status: 'pass',
      latency,
      details: {
        checksCompleted: checks.length,
      },
    }
  } catch (error) {
    return {
      status: 'fail',
      message: error instanceof Error ? error.message : 'Unknown error',
      latency: Date.now() - checkStart,
    }
  }
}

/**
 * 检查 Redis（详细版）
 */
async function checkRedisDetailed(): Promise<DetailedCheckResult> {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  
  if (!url || !token) {
    return { status: 'skip', message: '未配置 Redis 连接' }
  }
  
  const checkStart = Date.now()
  
  try {
    const redis = new Redis({ url, token })
    
    // 检查连接
    const pingResult = await redis.ping()
    
    const latency = Date.now() - checkStart
    
    if (pingResult !== 'PONG') {
      return { status: 'fail', message: 'Ping 失败', latency }
    }
    
    return {
      status: 'pass',
      latency,
      details: {
        connected: true,
      },
    }
  } catch (error) {
    return {
      status: 'fail',
      message: error instanceof Error ? error.message : 'Unknown error',
      latency: Date.now() - checkStart,
    }
  }
}

/**
 * 检查内存（详细版）
 */
function checkMemoryDetailed(): DetailedCheckResult {
  if (typeof process === 'undefined' || !process.memoryUsage) {
    return { status: 'skip', message: '无法获取内存信息' }
  }
  
  try {
    const memory = process.memoryUsage()
    const heapUsedMB = Math.round(memory.heapUsed / 1024 / 1024)
    const heapTotalMB = Math.round(memory.heapTotal / 1024 / 1024)
    const rssMB = Math.round(memory.rss / 1024 / 1024)
    const externalMB = Math.round(memory.external / 1024 / 1024)
    const usagePercent = Math.round((memory.heapUsed / memory.heapTotal) * 100)
    
    const details = {
      heapUsed: `${heapUsedMB}MB`,
      heapTotal: `${heapTotalMB}MB`,
      rss: `${rssMB}MB`,
      external: `${externalMB}MB`,
      usagePercent: `${usagePercent}%`,
    }
    
    if (usagePercent > 90) {
      return {
        status: 'fail',
        message: `内存使用过高: ${usagePercent}%`,
        details,
      }
    }
    
    if (usagePercent > 75) {
      return {
        status: 'warn',
        message: `内存使用较高: ${usagePercent}%`,
        details,
      }
    }
    
    return { status: 'pass', details }
  } catch (error) {
    return {
      status: 'fail',
      message: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * 检查 CPU（仅 Node.js 环境）
 */
function checkCpuDetailed(): DetailedCheckResult {
  if (typeof process === 'undefined' || !process.cpuUsage) {
    return { status: 'skip', message: '无法获取 CPU 信息' }
  }
  
  try {
    const cpuUsage = process.cpuUsage()
    const userMicros = cpuUsage.user
    const systemMicros = cpuUsage.system
    const totalMicros = userMicros + systemMicros
    
    return {
      status: 'pass',
      details: {
        userTime: `${Math.round(userMicros / 1000)}ms`,
        systemTime: `${Math.round(systemMicros / 1000)}ms`,
        totalTime: `${Math.round(totalMicros / 1000)}ms`,
      },
    }
  } catch (error) {
    return {
      status: 'fail',
      message: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * 检查磁盘（Vercel 环境不适用）
 */
function checkDiskDetailed(): DetailedCheckResult {
  // Vercel 等无服务器环境无法检查磁盘
  return { status: 'skip', message: '无服务器环境不支持磁盘检查' }
}

/**
 * 检查外部 API
 */
async function checkExternalApis(): Promise<Record<string, DetailedCheckResult>> {
  const results: Record<string, DetailedCheckResult> = {}
  
  await Promise.all(
    EXTERNAL_APIS.map(async (api) => {
      const checkStart = Date.now()
      
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), api.timeout)
        
        const response = await fetch(api.url, {
          method: 'GET',
          signal: controller.signal,
        })
        
        clearTimeout(timeoutId)
        const latency = Date.now() - checkStart
        
        if (response.ok) {
          results[api.name] = {
            status: latency > 2000 ? 'warn' : 'pass',
            latency,
            message: latency > 2000 ? '响应较慢' : undefined,
          }
        } else {
          results[api.name] = {
            status: 'fail',
            message: `HTTP ${response.status}`,
            latency,
          }
        }
      } catch (error) {
        results[api.name] = {
          status: 'fail',
          message: error instanceof Error ? error.message : 'Unknown error',
          latency: Date.now() - checkStart,
        }
      }
    })
  )
  
  return results
}

/**
 * 计算整体状态
 */
function calculateOverallStatus(checks: DetailedHealthResponse['checks']): DetailedHealthResponse['status'] {
  const coreChecks = [checks.database, checks.redis]
  const allChecks = [
    ...coreChecks,
    checks.memory,
    checks.cpu,
    ...Object.values(checks.externalApis),
  ]
  
  // 核心服务失败 = 不健康
  if (coreChecks.some(c => c.status === 'fail')) {
    return 'unhealthy'
  }
  
  // 任何失败或警告 = 降级
  if (allChecks.some(c => c.status === 'fail' || c.status === 'warn')) {
    return 'degraded'
  }
  
  return 'healthy'
}

// ============================================
// API 路由
// ============================================

/**
 * GET /api/health/detailed
 * 返回详细健康状态
 */
export async function GET() {
  // 并行执行所有检查
  const [database, redis, externalApis] = await Promise.all([
    checkDatabaseDetailed(),
    checkRedisDetailed(),
    checkExternalApis(),
  ])
  
  const memory = checkMemoryDetailed()
  const cpu = checkCpuDetailed()
  const disk = checkDiskDetailed()
  
  const checks = {
    database,
    redis,
    memory,
    cpu,
    disk,
    externalApis,
  }
  
  const status = calculateOverallStatus(checks)
  
  const response: DetailedHealthResponse = {
    status,
    timestamp: new Date().toISOString(),
    version,
    environment,
    uptime: Math.round((Date.now() - startTime) / 1000),
    checks,
    metrics: {
      // 这些指标可从外部监控服务获取（如 Prometheus、Datadog）
      // 配置 METRICS_ENDPOINT 环境变量启用指标采集
      requestsPerMinute: getMetric('requests_per_minute'),
      averageLatency: getMetric('average_latency'),
      errorRate: getMetric('error_rate'),
      activeConnections: getMetric('active_connections'),
    },
  }
  
  const httpStatus = status === 'healthy' ? 200 : status === 'degraded' ? 200 : 503
  
  return NextResponse.json(response, {
    status: httpStatus,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Content-Type': 'application/json',
    },
  })
}
