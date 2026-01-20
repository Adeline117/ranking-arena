/**
 * 健康检查 API
 * 用于负载均衡器和监控系统探测应用状态
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// 健康检查响应类型
interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy'
  timestamp: string
  version: string
  uptime: number
  checks: {
    database: CheckResult
    memory: CheckResult
  }
}

interface CheckResult {
  status: 'pass' | 'fail' | 'skip'
  message?: string
  latency?: number
}

// 应用启动时间
const startTime = Date.now()

// 获取版本号
const version = process.env.npm_package_version || '0.1.0'

/**
 * 检查数据库连接
 */
async function checkDatabase(): Promise<CheckResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  
  if (!url || !key) {
    return { status: 'skip', message: '未配置数据库连接' }
  }
  
  const startTime = Date.now()
  
  try {
    const supabase = createClient(url, key, {
      auth: { persistSession: false },
    })
    
    // 简单查询测试连接
    const { error } = await supabase.from('trader_snapshots').select('count').limit(1)
    
    const latency = Date.now() - startTime
    
    if (error) {
      return { status: 'fail', message: error.message, latency }
    }
    
    return { status: 'pass', latency }
  } catch (error) {
    const latency = Date.now() - startTime
    return {
      status: 'fail',
      message: error instanceof Error ? error.message : 'Unknown error',
      latency,
    }
  }
}

/**
 * 检查内存使用
 */
function checkMemory(): CheckResult {
  if (typeof process === 'undefined' || !process.memoryUsage) {
    return { status: 'skip', message: '无法获取内存信息' }
  }
  
  try {
    const memory = process.memoryUsage()
    const heapUsedMB = Math.round(memory.heapUsed / 1024 / 1024)
    const heapTotalMB = Math.round(memory.heapTotal / 1024 / 1024)
    const usagePercent = Math.round((memory.heapUsed / memory.heapTotal) * 100)
    
    // 内存使用超过 90% 视为不健康
    if (usagePercent > 90) {
      return {
        status: 'fail',
        message: `内存使用过高: ${heapUsedMB}MB / ${heapTotalMB}MB (${usagePercent}%)`,
      }
    }
    
    return {
      status: 'pass',
      message: `${heapUsedMB}MB / ${heapTotalMB}MB (${usagePercent}%)`,
    }
  } catch (error) {
    return {
      status: 'fail',
      message: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * 计算整体健康状态
 */
function calculateOverallStatus(checks: HealthCheckResponse['checks']): HealthCheckResponse['status'] {
  const results = Object.values(checks)
  
  // 任何关键服务失败 = 不健康
  if (checks.database.status === 'fail') {
    return 'unhealthy'
  }
  
  // 有服务失败但不是关键服务 = 降级
  if (results.some(r => r.status === 'fail')) {
    return 'degraded'
  }
  
  return 'healthy'
}

/**
 * GET /api/health
 * 返回应用健康状态
 */
export async function GET() {
  // 执行健康检查
  const database = await checkDatabase()
  const memory = checkMemory()
  
  const checks = { database, memory }
  const status = calculateOverallStatus(checks)
  
  const response: HealthCheckResponse = {
    status,
    timestamp: new Date().toISOString(),
    version,
    uptime: Math.round((Date.now() - startTime) / 1000), // 秒
    checks,
  }
  
  // 根据状态返回不同的 HTTP 状态码
  const httpStatus = status === 'healthy' ? 200 : status === 'degraded' ? 200 : 503
  
  return NextResponse.json(response, {
    status: httpStatus,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Content-Type': 'application/json',
    },
  })
}

/**
 * HEAD /api/health
 * 简单的存活检查（用于负载均衡器）
 */
export async function HEAD() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
