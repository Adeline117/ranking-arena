/**
 * 抓取系统遥测指标
 * 跟踪成功率、延迟、错误分布等关键指标
 */

import { tieredSet, tieredGet, tieredDel } from '@/lib/cache/redis-layer'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('ScraperTelemetry')

// 简化的 Redis 操作包装（使用 tiered cache）
const redis = {
  async set(key: string, value: string | number, options?: { ex?: number; nx?: boolean }): Promise<string | null> {
    if (options?.nx) {
      const existing = await tieredGet(key)
      if (existing.data !== null) return null
    }
    await tieredSet(key, value, 'hot')
    return 'OK'
  },
  async get(key: string): Promise<string | null> {
    const result = await tieredGet<string>(key)
    return result.data
  },
  async del(key: string): Promise<void> {
    await tieredDel(key)
  },
  async incr(key: string): Promise<number> {
    const current = await this.get(key)
    const newValue = (parseInt(current || '0', 10) || 0) + 1
    await this.set(key, newValue.toString())
    return newValue
  },
  async expire(_key: string, _seconds: number): Promise<void> {
    // TTL is handled by tieredSet
  },
  async lpush(key: string, value: string): Promise<void> {
    const current = await this.get(key)
    let list: string[] = []
    if (current) { try { list = JSON.parse(current) } catch { /* corrupted data, reset */ } }
    list.unshift(value)
    await this.set(key, JSON.stringify(list))
  },
  async ltrim(key: string, start: number, stop: number): Promise<void> {
    const current = await this.get(key)
    if (!current) return
    let list: string[] = []
    try { list = JSON.parse(current) } catch { /* corrupted */ }
    const trimmed = list.slice(start, stop + 1)
    await this.set(key, JSON.stringify(trimmed))
  },
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const current = await this.get(key)
    if (!current) return []
    let list: string[] = []
    try { list = JSON.parse(current) } catch { /* corrupted */ }
    return list.slice(start, stop === -1 ? undefined : stop + 1)
  },
  async hset(key: string, updates: Record<string, string | number>): Promise<void> {
    const current = await this.get(key)
    let hash: Record<string, string | number> = {}
    if (current) { try { hash = JSON.parse(current) } catch { /* corrupted data, reset */ } }
    for (const [field, value] of Object.entries(updates)) {
      if (typeof hash[field] === 'number' && typeof value === 'number' && value === 1) {
        hash[field] = (hash[field] as number) + 1
      } else {
        hash[field] = value
      }
    }
    await this.set(key, JSON.stringify(hash))
  },
  async hgetall(key: string): Promise<Record<string, string | number> | null> {
    const current = await this.get(key)
    if (!current) return null
    try { return JSON.parse(current) } catch { return null }
  },
  async xadd(_streamKey: string, _id: string, _data: Record<string, string>, _options?: { maxLen?: number }): Promise<void> {
    // Simplified: store in regular key as JSON array
  },
}

// ============================================
// 类型定义
// ============================================

export interface ScrapeMetrics {
  platform: string
  timeWindow: string
  timestamp: number
  duration: number
  success: boolean
  traderCount: number
  errorType?: string
  errorMessage?: string
  method: 'api' | 'browser' | 'hybrid'
  proxyUsed?: string
  retryCount: number
}

export interface PlatformStats {
  platform: string
  period: string // '1h', '24h', '7d'
  totalRequests: number
  successCount: number
  failureCount: number
  successRate: number
  avgDuration: number
  p50Duration: number
  p95Duration: number
  p99Duration: number
  avgTraderCount: number
  errorDistribution: Record<string, number>
  lastSuccess: number | null
  lastFailure: number | null
}

export interface SystemHealth {
  timestamp: number
  overallSuccessRate: number
  platformsUp: number
  platformsDown: number
  platformsDegraded: number
  alerts: HealthAlert[]
}

export interface HealthAlert {
  level: 'warning' | 'critical'
  platform: string
  message: string
  timestamp: number
}

// ============================================
// Redis Keys
// ============================================

const KEYS = {
  metrics: (platform: string) => `scraper:metrics:${platform}`,
  metricsStream: (platform: string) => `scraper:metrics:stream:${platform}`,
  stats: (platform: string, period: string) => `scraper:stats:${platform}:${period}`,
  health: 'scraper:health',
  alerts: 'scraper:alerts',
  dedup: (platform: string, traderId: string) => `scraper:dedup:${platform}:${traderId}`,
}

// ============================================
// 指标记录
// ============================================

/**
 * 记录抓取指标
 */
export async function recordScrapeMetrics(metrics: ScrapeMetrics): Promise<void> {
  try {
    // 更新实时统计
    await updateRealtimeStats(metrics)

    // 检查是否需要告警
    await checkAlertConditions(metrics)

    logger.debug(`记录指标: ${metrics.platform} - ${metrics.success ? '成功' : '失败'} - ${metrics.duration}ms`)
  } catch (error) {
    logger.error('记录指标失败:', error)
  }
}

/**
 * 更新实时统计
 */
async function updateRealtimeStats(metrics: ScrapeMetrics): Promise<void> {
  const periods = ['1h', '24h', '7d']
  const now = Date.now()

  for (const period of periods) {
    const key = KEYS.stats(metrics.platform, period)
    const ttl = getTtlForPeriod(period)

    // 使用 Redis HSET 更新计数
    const updates: Record<string, string | number> = {
      totalRequests: 1, // 将通过 HINCRBY 增加
      lastUpdate: now,
    }

    if (metrics.success) {
      updates.successCount = 1
      updates.lastSuccess = now
      updates[`duration:${metrics.duration}`] = now
    } else {
      updates.failureCount = 1
      updates.lastFailure = now
      if (metrics.errorType) {
        updates[`error:${metrics.errorType}`] = 1
      }
    }

    // 批量更新
    await redis.hset(key, updates)
    await redis.expire(key, ttl)
  }
}

function getTtlForPeriod(period: string): number {
  switch (period) {
    case '1h':
      return 3600
    case '24h':
      return 86400
    case '7d':
      return 604800
    default:
      return 86400
  }
}

// ============================================
// 统计查询
// ============================================

/**
 * 获取平台统计
 */
export async function getPlatformStats(
  platform: string,
  period: string = '24h'
): Promise<PlatformStats | null> {
  try {
    const key = KEYS.stats(platform, period)
    const data = await redis.hgetall(key)

    if (!data || Object.keys(data).length === 0) {
      return null
    }

    const totalRequests = parseInt(String(data.totalRequests || '0'), 10)
    const successCount = parseInt(String(data.successCount || '0'), 10)
    const failureCount = parseInt(String(data.failureCount || '0'), 10)

    // 计算错误分布
    const errorDistribution: Record<string, number> = {}
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('error:')) {
        errorDistribution[key.replace('error:', '')] = parseInt(String(value), 10)
      }
    }

    // 计算延迟百分位 (简化实现)
    const durations: number[] = []
    for (const [key, _] of Object.entries(data)) {
      if (key.startsWith('duration:')) {
        durations.push(parseInt(key.replace('duration:', ''), 10))
      }
    }
    durations.sort((a, b) => a - b)

    const avgDuration = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0

    return {
      platform,
      period,
      totalRequests,
      successCount,
      failureCount,
      successRate: totalRequests > 0 ? successCount / totalRequests : 0,
      avgDuration,
      p50Duration: getPercentile(durations, 50),
      p95Duration: getPercentile(durations, 95),
      p99Duration: getPercentile(durations, 99),
      avgTraderCount: 0, // 需要从 stream 计算
      errorDistribution,
      lastSuccess: data.lastSuccess ? parseInt(String(data.lastSuccess), 10) : null,
      lastFailure: data.lastFailure ? parseInt(String(data.lastFailure), 10) : null,
    }
  } catch (error) {
    logger.error('获取平台统计失败:', error)
    return null
  }
}

function getPercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, index)]
}

/**
 * 获取所有平台概览
 */
export async function getAllPlatformStats(period: string = '24h'): Promise<PlatformStats[]> {
  const { getEnabledPlatforms } = await import('./config')
  const platforms = getEnabledPlatforms()

  const stats = await Promise.all(
    platforms.map(p => getPlatformStats(p.id, period))
  )

  return stats.filter((s): s is PlatformStats => s !== null)
}

// ============================================
// 系统健康
// ============================================

/**
 * 计算系统健康状态
 */
export async function getSystemHealth(): Promise<SystemHealth> {
  const stats = await getAllPlatformStats('1h')
  const now = Date.now()

  let platformsUp = 0
  let platformsDown = 0
  let platformsDegraded = 0
  const alerts: HealthAlert[] = []

  for (const stat of stats) {
    if (stat.successRate >= 0.95) {
      platformsUp++
    } else if (stat.successRate >= 0.5) {
      platformsDegraded++
      alerts.push({
        level: 'warning',
        platform: stat.platform,
        message: `成功率下降: ${(stat.successRate * 100).toFixed(1)}%`,
        timestamp: now,
      })
    } else {
      platformsDown++
      alerts.push({
        level: 'critical',
        platform: stat.platform,
        message: `平台故障: 成功率 ${(stat.successRate * 100).toFixed(1)}%`,
        timestamp: now,
      })
    }

    // 检查数据新鲜度
    if (stat.lastSuccess && now - stat.lastSuccess > 6 * 3600 * 1000) {
      alerts.push({
        level: 'warning',
        platform: stat.platform,
        message: `数据陈旧: ${Math.round((now - stat.lastSuccess) / 3600000)}小时未更新`,
        timestamp: now,
      })
    }
  }

  const totalPlatforms = stats.length || 1
  const overallSuccessRate = stats.reduce((sum, s) => sum + s.successRate, 0) / totalPlatforms

  return {
    timestamp: now,
    overallSuccessRate,
    platformsUp,
    platformsDown,
    platformsDegraded,
    alerts: alerts.slice(0, 10), // 最多返回 10 条
  }
}

// ============================================
// 告警检查
// ============================================

/**
 * 检查告警条件
 */
async function checkAlertConditions(metrics: ScrapeMetrics): Promise<void> {
  // 连续失败检测
  if (!metrics.success) {
    const key = `scraper:consecutive_failures:${metrics.platform}`
    const failures = await redis.incr(key)
    await redis.expire(key, 3600) // 1 小时过期

    if (failures >= 3) {
      await createAlert({
        level: 'warning',
        platform: metrics.platform,
        message: `连续失败 ${failures} 次`,
        timestamp: Date.now(),
      })
    }

    if (failures >= 5) {
      await createAlert({
        level: 'critical',
        platform: metrics.platform,
        message: `连续失败 ${failures} 次，建议检查`,
        timestamp: Date.now(),
      })
    }
  } else {
    // 成功时重置计数
    await redis.del(`scraper:consecutive_failures:${metrics.platform}`)
  }

  // 延迟异常检测
  if (metrics.success && metrics.duration > 60000) {
    await createAlert({
      level: 'warning',
      platform: metrics.platform,
      message: `响应时间过长: ${Math.round(metrics.duration / 1000)}s`,
      timestamp: Date.now(),
    })
  }
}

/**
 * 创建告警
 */
async function createAlert(alert: HealthAlert): Promise<void> {
  try {
    // 去重: 同一平台同一消息 5 分钟内只告警一次
    const dedupKey = `scraper:alert_dedup:${alert.platform}:${alert.message}`
    const exists = await redis.get(dedupKey)
    if (exists) return

    await redis.set(dedupKey, '1', { ex: 300 })

    // 存储告警
    await redis.lpush(KEYS.alerts, JSON.stringify(alert))
    await redis.ltrim(KEYS.alerts, 0, 99) // 保留最近 100 条

    logger.warn(`[告警] ${alert.level.toUpperCase()}: ${alert.platform} - ${alert.message}`)
  } catch (error) {
    logger.error('创建告警失败:', error)
  }
}

/**
 * 获取最近告警
 */
export async function getRecentAlerts(limit: number = 20): Promise<HealthAlert[]> {
  try {
    const alerts = await redis.lrange(KEYS.alerts, 0, limit - 1)
    return alerts.map(a => { try { return JSON.parse(a as string) } catch { return null } }).filter(Boolean)
  } catch (error) {
    logger.error('获取告警失败:', error)
    return []
  }
}

// ============================================
// 请求去重
// ============================================

/**
 * 检查是否可以抓取（防止重复请求）
 * @returns true 如果可以抓取，false 如果正在抓取中
 */
export async function acquireScrapeLock(
  platform: string,
  traderId: string,
  ttlSeconds: number = 60
): Promise<boolean> {
  const key = KEYS.dedup(platform, traderId)
  const result = await redis.set(key, Date.now().toString(), {
    nx: true, // 仅当 key 不存在时设置
    ex: ttlSeconds,
  })

  return result === 'OK'
}

/**
 * 释放抓取锁
 */
export async function releaseScrapeLock(platform: string, traderId: string): Promise<void> {
  const key = KEYS.dedup(platform, traderId)
  await redis.del(key)
}

/**
 * 批量检查去重
 */
export async function filterDuplicateTraders(
  platform: string,
  traderIds: string[],
  ttlSeconds: number = 60
): Promise<string[]> {
  const available: string[] = []

  for (const traderId of traderIds) {
    if (await acquireScrapeLock(platform, traderId, ttlSeconds)) {
      available.push(traderId)
    }
  }

  return available
}

// ============================================
// 导出汇总
// ============================================

export const scraperTelemetry = {
  record: recordScrapeMetrics,
  getPlatformStats,
  getAllPlatformStats,
  getSystemHealth,
  getRecentAlerts,
  acquireLock: acquireScrapeLock,
  releaseLock: releaseScrapeLock,
  filterDuplicates: filterDuplicateTraders,
}
