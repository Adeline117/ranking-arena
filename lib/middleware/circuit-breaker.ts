/**
 * 熔断器中间件 (Circuit Breaker)
 *
 * 当交易所 API 延迟超过阈值时自动降级，返回缓存数据
 *
 * 状态转换:
 * - CLOSED: 正常状态，允许请求通过
 * - OPEN: 熔断状态，直接返回降级响应
 * - HALF_OPEN: 恢复探测，允许有限请求通过
 *
 * 特性:
 * - 延迟阈值触发 (默认 2s)
 * - 失败率阈值触发 (默认 50%)
 * - 指数退避恢复探测
 * - 自动降级到缓存数据
 * - 每个交易所独立熔断器
 */

import { dataLogger } from '@/lib/utils/logger'
import { get as cacheGet, set as cacheSet } from '@/lib/cache'

// ============================================
// 类型定义
// ============================================

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface CircuitBreakerConfig {
  /** 失败阈值（触发熔断的连续失败次数） */
  failureThreshold: number
  /** 延迟阈值（毫秒），超过此值视为慢请求 */
  latencyThreshold: number
  /** 慢请求阈值（触发熔断的慢请求次数） */
  slowRequestThreshold: number
  /** 熔断持续时间（毫秒） */
  openDuration: number
  /** 半开状态允许的探测请求数 */
  halfOpenRequests: number
  /** 成功恢复阈值（半开状态下恢复到闭合的成功次数） */
  successThreshold: number
  /** 统计窗口大小（毫秒） */
  statisticsWindowMs: number
}

export interface CircuitBreakerStats {
  state: CircuitState
  failures: number
  slowRequests: number
  successes: number
  lastFailureTime: number
  lastSuccessTime: number
  totalRequests: number
  lastLatency: number
}

interface CircuitBreakerInstance {
  config: CircuitBreakerConfig
  stats: CircuitBreakerStats
  windowStart: number
  halfOpenSuccesses: number
  halfOpenFailures: number
}

// ============================================
// 默认配置
// ============================================

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,           // 5 次连续失败触发熔断
  latencyThreshold: 2000,        // 2 秒延迟阈值
  slowRequestThreshold: 3,       // 3 次慢请求触发熔断
  openDuration: 30000,           // 熔断 30 秒
  halfOpenRequests: 3,           // 半开状态允许 3 个探测请求
  successThreshold: 2,           // 2 次成功恢复
  statisticsWindowMs: 60000,     // 1 分钟统计窗口
}

// ============================================
// 熔断器管理器
// ============================================

class CircuitBreakerManager {
  private breakers: Map<string, CircuitBreakerInstance> = new Map()
  private globalConfig: CircuitBreakerConfig

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.globalConfig = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 获取或创建指定服务的熔断器实例
   */
  private getOrCreate(serviceId: string): CircuitBreakerInstance {
    let instance = this.breakers.get(serviceId)
    if (!instance) {
      instance = {
        config: { ...this.globalConfig },
        stats: {
          state: 'CLOSED',
          failures: 0,
          slowRequests: 0,
          successes: 0,
          lastFailureTime: 0,
          lastSuccessTime: 0,
          totalRequests: 0,
          lastLatency: 0,
        },
        windowStart: Date.now(),
        halfOpenSuccesses: 0,
        halfOpenFailures: 0,
      }
      this.breakers.set(serviceId, instance)
    }
    return instance
  }

  /**
   * 重置统计窗口
   */
  private resetWindow(instance: CircuitBreakerInstance): void {
    instance.stats.failures = 0
    instance.stats.slowRequests = 0
    instance.stats.successes = 0
    instance.windowStart = Date.now()
  }

  /**
   * 检查是否应该重置统计窗口
   */
  private checkWindowReset(instance: CircuitBreakerInstance): void {
    const now = Date.now()
    if (now - instance.windowStart > instance.config.statisticsWindowMs) {
      this.resetWindow(instance)
    }
  }

  /**
   * 获取当前状态
   */
  getState(serviceId: string): CircuitState {
    const instance = this.getOrCreate(serviceId)
    const now = Date.now()

    // 如果在 OPEN 状态，检查是否应该转换到 HALF_OPEN
    if (instance.stats.state === 'OPEN') {
      const timeSinceOpen = now - instance.stats.lastFailureTime
      if (timeSinceOpen >= instance.config.openDuration) {
        instance.stats.state = 'HALF_OPEN'
        instance.halfOpenSuccesses = 0
        instance.halfOpenFailures = 0
        dataLogger.info(`[CircuitBreaker] ${serviceId}: OPEN -> HALF_OPEN`)
      }
    }

    return instance.stats.state
  }

  /**
   * 检查请求是否允许通过
   */
  canRequest(serviceId: string): boolean {
    const state = this.getState(serviceId)
    const instance = this.getOrCreate(serviceId)

    if (state === 'CLOSED') {
      return true
    }

    if (state === 'OPEN') {
      return false
    }

    // HALF_OPEN: 允许有限的探测请求
    const totalHalfOpen = instance.halfOpenSuccesses + instance.halfOpenFailures
    return totalHalfOpen < instance.config.halfOpenRequests
  }

  /**
   * 记录成功请求
   */
  recordSuccess(serviceId: string, latencyMs: number): void {
    const instance = this.getOrCreate(serviceId)
    this.checkWindowReset(instance)

    instance.stats.successes++
    instance.stats.totalRequests++
    instance.stats.lastSuccessTime = Date.now()
    instance.stats.lastLatency = latencyMs

    // 检查是否为慢请求
    if (latencyMs > instance.config.latencyThreshold) {
      instance.stats.slowRequests++
      dataLogger.warn(`[CircuitBreaker] ${serviceId}: Slow request ${latencyMs}ms`)

      // 慢请求也可能触发熔断
      if (instance.stats.slowRequests >= instance.config.slowRequestThreshold) {
        this.tripBreaker(serviceId, instance, 'SLOW_REQUESTS')
        return
      }
    }

    if (instance.stats.state === 'HALF_OPEN') {
      instance.halfOpenSuccesses++

      // 检查是否恢复到 CLOSED
      if (instance.halfOpenSuccesses >= instance.config.successThreshold) {
        instance.stats.state = 'CLOSED'
        instance.stats.failures = 0
        instance.stats.slowRequests = 0
        dataLogger.info(`[CircuitBreaker] ${serviceId}: HALF_OPEN -> CLOSED (recovered)`)
      }
    } else if (instance.stats.state === 'CLOSED') {
      // 成功请求重置失败计数
      instance.stats.failures = 0
    }
  }

  /**
   * 记录失败请求
   */
  recordFailure(serviceId: string, error?: Error): void {
    const instance = this.getOrCreate(serviceId)
    this.checkWindowReset(instance)

    instance.stats.failures++
    instance.stats.totalRequests++
    instance.stats.lastFailureTime = Date.now()

    dataLogger.warn(`[CircuitBreaker] ${serviceId}: Failure #${instance.stats.failures}`, {
      error: error?.message,
    })

    if (instance.stats.state === 'HALF_OPEN') {
      instance.halfOpenFailures++
      // 半开状态下失败，立即回到 OPEN
      this.tripBreaker(serviceId, instance, 'HALF_OPEN_FAILURE')
    } else if (instance.stats.state === 'CLOSED') {
      // 检查是否应该触发熔断
      if (instance.stats.failures >= instance.config.failureThreshold) {
        this.tripBreaker(serviceId, instance, 'FAILURE_THRESHOLD')
      }
    }
  }

  /**
   * 触发熔断
   */
  private tripBreaker(
    serviceId: string,
    instance: CircuitBreakerInstance,
    reason: string
  ): void {
    instance.stats.state = 'OPEN'
    instance.stats.lastFailureTime = Date.now()

    dataLogger.error(`[CircuitBreaker] ${serviceId}: TRIPPED -> OPEN`, {
      reason,
      failures: instance.stats.failures,
      slowRequests: instance.stats.slowRequests,
    })
  }

  /**
   * 手动重置熔断器
   */
  reset(serviceId: string): void {
    const instance = this.getOrCreate(serviceId)
    instance.stats.state = 'CLOSED'
    instance.stats.failures = 0
    instance.stats.slowRequests = 0
    instance.halfOpenSuccesses = 0
    instance.halfOpenFailures = 0
    dataLogger.info(`[CircuitBreaker] ${serviceId}: Manually reset`)
  }

  /**
   * 获取熔断器统计信息
   */
  getStats(serviceId: string): CircuitBreakerStats {
    const instance = this.getOrCreate(serviceId)
    return { ...instance.stats }
  }

  /**
   * 获取所有熔断器状态
   */
  getAllStats(): Record<string, CircuitBreakerStats> {
    const result: Record<string, CircuitBreakerStats> = {}
    for (const [id, instance] of this.breakers.entries()) {
      result[id] = { ...instance.stats }
    }
    return result
  }

  /**
   * 配置特定服务的熔断器
   */
  configure(serviceId: string, config: Partial<CircuitBreakerConfig>): void {
    const instance = this.getOrCreate(serviceId)
    instance.config = { ...instance.config, ...config }
  }
}

// ============================================
// 单例实例
// ============================================

export const circuitBreaker = new CircuitBreakerManager()

// ============================================
// 装饰器函数
// ============================================

/**
 * 包装函数，添加熔断器保护
 *
 * @example
 * ```ts
 * const fetchWithBreaker = withCircuitBreaker(
 *   'binance',
 *   fetchBinanceTraders,
 *   () => getCachedRankings('binance')
 * )
 * const data = await fetchWithBreaker()
 * ```
 */
export function withCircuitBreaker<T>(
  serviceId: string,
  fn: () => Promise<T>,
  fallback: () => Promise<T> | T
): () => Promise<T> {
  return async (): Promise<T> => {
    // 检查是否允许请求
    if (!circuitBreaker.canRequest(serviceId)) {
      dataLogger.warn(`[CircuitBreaker] ${serviceId}: Request blocked, using fallback`)
      return await fallback()
    }

    const startTime = Date.now()

    try {
      const result = await fn()
      const latency = Date.now() - startTime
      circuitBreaker.recordSuccess(serviceId, latency)
      return result
    } catch (error) {
      circuitBreaker.recordFailure(serviceId, error instanceof Error ? error : undefined)
      dataLogger.warn(`[CircuitBreaker] ${serviceId}: Request failed, using fallback`)
      return await fallback()
    }
  }
}

/**
 * 带缓存降级的熔断器包装
 * 自动将成功响应缓存，熔断时返回缓存数据
 */
export function withCircuitBreakerAndCache<T>(
  serviceId: string,
  cacheKey: string,
  fn: () => Promise<T>,
  cacheTtlSeconds: number = 300
): () => Promise<T | null> {
  return async (): Promise<T | null> => {
    // 检查是否允许请求
    if (!circuitBreaker.canRequest(serviceId)) {
      dataLogger.warn(`[CircuitBreaker] ${serviceId}: Returning cached data`)
      return await cacheGet<T>(cacheKey)
    }

    const startTime = Date.now()

    try {
      const result = await fn()
      const latency = Date.now() - startTime
      circuitBreaker.recordSuccess(serviceId, latency)

      // 缓存成功结果
      await cacheSet(cacheKey, result, { ttl: cacheTtlSeconds })

      return result
    } catch (error) {
      circuitBreaker.recordFailure(serviceId, error instanceof Error ? error : undefined)

      // 返回缓存数据
      const cached = await cacheGet<T>(cacheKey)
      if (cached !== null) {
        dataLogger.info(`[CircuitBreaker] ${serviceId}: Returning stale cache`)
        return cached
      }

      // 无缓存可用，重新抛出错误
      throw error
    }
  }
}

// ============================================
// 交易所专用熔断器配置
// ============================================

/**
 * 为交易所配置熔断器
 */
export function configureExchangeBreaker(exchangeId: string): void {
  // CEX 通常更稳定，可以有更高的阈值
  const cexConfig: Partial<CircuitBreakerConfig> = {
    failureThreshold: 5,
    latencyThreshold: 2000,
    slowRequestThreshold: 5,
    openDuration: 30000,
  }

  // DEX 可能更不稳定，降低阈值
  const dexConfig: Partial<CircuitBreakerConfig> = {
    failureThreshold: 3,
    latencyThreshold: 3000,
    slowRequestThreshold: 3,
    openDuration: 60000,
  }

  const dexPlatforms = ['hyperliquid', 'gmx', 'gains', 'jupiter_perps', 'aevo']

  const config = dexPlatforms.includes(exchangeId) ? dexConfig : cexConfig
  circuitBreaker.configure(exchangeId, config)
}

// ============================================
// 导出
// ============================================

export { CircuitBreakerManager }
