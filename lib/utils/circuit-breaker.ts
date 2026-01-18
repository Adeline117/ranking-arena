/**
 * 熔断器模式实现
 * 用于保护外部 API 调用，防止级联故障
 * 
 * 状态机:
 * - CLOSED: 正常状态，请求直接通过
 * - OPEN: 熔断状态，请求直接失败或返回降级结果
 * - HALF_OPEN: 半开状态，允许少量请求测试服务是否恢复
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface CircuitBreakerOptions {
  /** 熔断器名称（用于日志和监控） */
  name: string
  /** 触发熔断的失败次数阈值 */
  failureThreshold?: number
  /** 重置计数器的成功次数阈值 */
  successThreshold?: number
  /** 熔断持续时间（毫秒） */
  timeout?: number
  /** 半开状态允许的最大请求数 */
  halfOpenMaxRequests?: number
  /** 降级函数 */
  fallback?: <T>() => T | Promise<T>
  /** 状态变化回调 */
  onStateChange?: (from: CircuitState, to: CircuitState, name: string) => void
}

export interface RetryOptions {
  /** 最大重试次数 */
  maxRetries?: number
  /** 初始延迟（毫秒） */
  initialDelay?: number
  /** 最大延迟（毫秒） */
  maxDelay?: number
  /** 延迟倍数（指数退避） */
  backoffMultiplier?: number
  /** 是否添加抖动 */
  jitter?: boolean
  /** 可重试的错误判断函数 */
  isRetryable?: (error: unknown) => boolean
  /** 重试回调 */
  onRetry?: (attempt: number, error: unknown, delay: number) => void
}

interface CircuitBreakerStats {
  state: CircuitState
  failures: number
  successes: number
  totalRequests: number
  lastFailureTime: number | null
  lastSuccessTime: number | null
}

/**
 * 熔断器类
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED'
  private failures = 0
  private successes = 0
  private totalRequests = 0
  private lastFailureTime: number | null = null
  private lastSuccessTime: number | null = null
  private halfOpenRequests = 0

  private readonly name: string
  private readonly failureThreshold: number
  private readonly successThreshold: number
  private readonly timeout: number
  private readonly halfOpenMaxRequests: number
  private readonly fallback?: <T>() => T | Promise<T>
  private readonly onStateChange?: (from: CircuitState, to: CircuitState, name: string) => void

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name
    this.failureThreshold = options.failureThreshold ?? 5
    this.successThreshold = options.successThreshold ?? 2
    this.timeout = options.timeout ?? 30000 // 30 秒
    this.halfOpenMaxRequests = options.halfOpenMaxRequests ?? 3
    this.fallback = options.fallback
    this.onStateChange = options.onStateChange
  }

  /**
   * 执行受保护的操作
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.totalRequests++

    // 检查是否应该从 OPEN 转换到 HALF_OPEN
    if (this.state === 'OPEN') {
      if (this.shouldAttemptReset()) {
        this.transitionTo('HALF_OPEN')
      } else {
        // 熔断器打开，直接失败或返回降级结果
        console.warn(`[CircuitBreaker] ${this.name} 熔断器打开，拒绝请求`)
        return this.handleFailure(new Error('Circuit breaker is OPEN'))
      }
    }

    // 半开状态，检查是否超过允许的请求数
    if (this.state === 'HALF_OPEN') {
      if (this.halfOpenRequests >= this.halfOpenMaxRequests) {
        return this.handleFailure(new Error('Circuit breaker HALF_OPEN limit reached'))
      }
      this.halfOpenRequests++
    }

    try {
      const result = await operation()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure(error)
      return this.handleFailure(error)
    }
  }

  /**
   * 处理成功
   */
  private onSuccess(): void {
    this.lastSuccessTime = Date.now()
    this.successes++

    if (this.state === 'HALF_OPEN') {
      if (this.successes >= this.successThreshold) {
        this.transitionTo('CLOSED')
        this.reset()
      }
    } else if (this.state === 'CLOSED') {
      // 重置失败计数
      this.failures = 0
    }
  }

  /**
   * 处理失败
   */
  private onFailure(error: unknown): void {
    this.lastFailureTime = Date.now()
    this.failures++

    console.error(`[CircuitBreaker] ${this.name} 请求失败 (${this.failures}/${this.failureThreshold}):`, error)

    if (this.state === 'HALF_OPEN') {
      // 半开状态失败，回到熔断状态
      this.transitionTo('OPEN')
    } else if (this.state === 'CLOSED' && this.failures >= this.failureThreshold) {
      // 达到失败阈值，触发熔断
      this.transitionTo('OPEN')
    }
  }

  /**
   * 处理失败响应
   */
  private async handleFailure<T>(error: unknown): Promise<T> {
    if (this.fallback) {
      console.log(`[CircuitBreaker] ${this.name} 使用降级响应`)
      return this.fallback()
    }
    throw error
  }

  /**
   * 检查是否应该尝试重置
   */
  private shouldAttemptReset(): boolean {
    if (!this.lastFailureTime) return true
    return Date.now() - this.lastFailureTime >= this.timeout
  }

  /**
   * 状态转换
   */
  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return

    const oldState = this.state
    this.state = newState

    console.log(`[CircuitBreaker] ${this.name} 状态变化: ${oldState} -> ${newState}`)

    if (newState === 'HALF_OPEN') {
      this.halfOpenRequests = 0
      this.successes = 0
    }

    this.onStateChange?.(oldState, newState, this.name)
  }

  /**
   * 重置熔断器
   */
  private reset(): void {
    this.failures = 0
    this.successes = 0
    this.halfOpenRequests = 0
  }

  /**
   * 获取统计信息
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      totalRequests: this.totalRequests,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
    }
  }

  /**
   * 获取当前状态
   */
  getState(): CircuitState {
    return this.state
  }

  /**
   * 强制打开熔断器
   */
  forceOpen(): void {
    this.transitionTo('OPEN')
    this.lastFailureTime = Date.now()
  }

  /**
   * 强制关闭熔断器
   */
  forceClose(): void {
    this.transitionTo('CLOSED')
    this.reset()
  }
}

/**
 * 带重试的请求执行器
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    backoffMultiplier = 2,
    jitter = true,
    isRetryable = () => true,
    onRetry,
  } = options

  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error

      // 检查是否可重试
      if (attempt >= maxRetries || !isRetryable(error)) {
        throw error
      }

      // 计算延迟
      let delay = Math.min(initialDelay * Math.pow(backoffMultiplier, attempt), maxDelay)

      // 添加抖动
      if (jitter) {
        delay = delay * (0.5 + Math.random() * 0.5)
      }

      onRetry?.(attempt + 1, error, delay)
      console.log(`[Retry] 第 ${attempt + 1} 次重试，等待 ${Math.round(delay)}ms`)

      await sleep(delay)
    }
  }

  throw lastError
}

/**
 * 组合熔断器和重试
 */
export async function withCircuitBreakerAndRetry<T>(
  circuitBreaker: CircuitBreaker,
  operation: () => Promise<T>,
  retryOptions?: RetryOptions
): Promise<T> {
  return circuitBreaker.execute(() => withRetry(operation, retryOptions))
}

/**
 * 睡眠函数
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ============================================
// 预配置的熔断器工厂
// ============================================

const circuitBreakers = new Map<string, CircuitBreaker>()

/**
 * 获取或创建熔断器
 */
export function getCircuitBreaker(
  name: string,
  options?: Partial<CircuitBreakerOptions>
): CircuitBreaker {
  if (!circuitBreakers.has(name)) {
    circuitBreakers.set(
      name,
      new CircuitBreaker({
        name,
        failureThreshold: 5,
        successThreshold: 2,
        timeout: 30000,
        ...options,
      })
    )
  }
  return circuitBreakers.get(name)!
}

/**
 * 获取所有熔断器状态
 */
export function getAllCircuitBreakerStats(): Record<string, CircuitBreakerStats> {
  const stats: Record<string, CircuitBreakerStats> = {}
  for (const [name, cb] of circuitBreakers) {
    stats[name] = cb.getStats()
  }
  return stats
}

/**
 * 重置所有熔断器
 */
export function resetAllCircuitBreakers(): void {
  for (const cb of circuitBreakers.values()) {
    cb.forceClose()
  }
}

// ============================================
// 预定义的重试配置
// ============================================

export const RetryPresets = {
  /** 快速重试（API 调用） */
  fast: {
    maxRetries: 2,
    initialDelay: 500,
    maxDelay: 2000,
    backoffMultiplier: 2,
    jitter: true,
  } as RetryOptions,

  /** 标准重试 */
  standard: {
    maxRetries: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    backoffMultiplier: 2,
    jitter: true,
  } as RetryOptions,

  /** 耐心重试（网络抖动） */
  patient: {
    maxRetries: 5,
    initialDelay: 2000,
    maxDelay: 60000,
    backoffMultiplier: 2,
    jitter: true,
  } as RetryOptions,

  /** 激进重试（关键操作） */
  aggressive: {
    maxRetries: 10,
    initialDelay: 500,
    maxDelay: 30000,
    backoffMultiplier: 1.5,
    jitter: true,
  } as RetryOptions,
}

// ============================================
// 常见错误判断
// ============================================

/**
 * 判断是否是网络错误（可重试）
 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    return (
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('socket') ||
      message.includes('fetch failed')
    )
  }
  return false
}

/**
 * 判断是否是临时错误（可重试）
 */
export function isTransientError(error: unknown): boolean {
  if (isNetworkError(error)) return true

  // HTTP 状态码判断
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: number }).status
    // 429 (Too Many Requests), 500, 502, 503, 504 是临时错误
    return [429, 500, 502, 503, 504].includes(status)
  }

  return false
}
