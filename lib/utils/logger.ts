/* eslint-disable no-console -- this is the logger implementation; console usage is intentional */
/**
 * 统一日志工具
 * 生产环境自动关闭 debug/log，保留 warn/error
 */

// Correlation ID support — server-only (node:async_hooks not available in browser)
let _getCorrelationId: (() => string | undefined) | null = null
function correlationId(): string | undefined {
  if (typeof window !== 'undefined') return undefined
  if (!_getCorrelationId) {
    try {
      // Dynamic path to prevent Turbopack from resolving node:async_hooks in client bundles
      const mod = '@/lib/api/' + 'correlation'
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      _getCorrelationId = require(mod).getCorrelationId
    } catch (_err) {
      /* correlation module unavailable (Edge Runtime) */
      _getCorrelationId = () => undefined
    }
  }
  return _getCorrelationId!()
}

// ============================================
// 类型定义
// ============================================

type LogLevel = 'debug' | 'log' | 'info' | 'warn' | 'error'

interface LoggerConfig {
  /** 是否启用 */
  enabled: boolean
  /** 最低日志级别 */
  minLevel: LogLevel
  /** 是否显示时间戳 */
  showTimestamp: boolean
  /** 是否显示日志级别 */
  showLevel: boolean
  /** 前缀 */
  prefix?: string
}

interface LogEntry {
  level: LogLevel
  message: string
  data?: unknown[]
  timestamp: string
  prefix?: string
}

// ============================================
// 常量
// ============================================

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  log: 1,
  info: 2,
  warn: 3,
  error: 4,
}

const LOG_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', // 灰色
  log: '\x1b[37m',   // 白色
  info: '\x1b[36m',  // 青色
  warn: '\x1b[33m',  // 黄色
  error: '\x1b[31m', // 红色
}

const RESET_COLOR = '\x1b[0m'

// ============================================
// 默认配置
// ============================================

const isProduction = process.env.NODE_ENV === 'production'
const isServer = typeof window === 'undefined'

const defaultConfig: LoggerConfig = {
  enabled: true,
  minLevel: isProduction ? 'warn' : 'debug',
  showTimestamp: !isProduction,
  showLevel: true,
  prefix: undefined,
}

// ============================================
// Logger 类
// ============================================

class Logger {
  private config: LoggerConfig
  private name?: string

  constructor(name?: string, config: Partial<LoggerConfig> = {}) {
    this.name = name
    this.config = { ...defaultConfig, ...config }
  }

  /**
   * 检查是否应该输出此级别的日志
   */
  private shouldLog(level: LogLevel): boolean {
    if (!this.config.enabled) return false
    return LOG_LEVELS[level] >= LOG_LEVELS[this.config.minLevel]
  }

  /**
   * 格式化日志消息
   */
  private formatMessage(level: LogLevel, message: string): string {
    const parts: string[] = []

    // 时间戳
    if (this.config.showTimestamp) {
      parts.push(`[${new Date().toISOString()}]`)
    }

    // 级别
    if (this.config.showLevel) {
      parts.push(`[${level.toUpperCase()}]`)
    }

    // 前缀/名称
    const prefix = this.config.prefix || this.name
    if (prefix) {
      parts.push(`[${prefix}]`)
    }

    // Correlation ID (auto-injected from AsyncLocalStorage context)
    const cid = correlationId()
    if (cid) {
      parts.push(`[cid:${cid}]`)
    }

    parts.push(message)

    return parts.join(' ')
  }

  /**
   * 输出日志
   */
  private output(level: LogLevel, message: string, ...data: unknown[]): void {
    if (!this.shouldLog(level)) return

    // Production server-side: structured JSON for log aggregation (Vercel Logs, Datadog, etc.)
    if (isServer && isProduction) {
      const entry: Record<string, unknown> = {
        level,
        msg: message,
        ts: new Date().toISOString(),
      }
      if (this.name) entry.logger = this.name
      const cid = correlationId()
      if (cid) entry.correlationId = cid
      // Merge first data arg if it's an object, append rest as extra
      if (data.length > 0) {
        const first = data[0]
        if (first && typeof first === 'object' && !Array.isArray(first) && !(first instanceof Error)) {
          Object.assign(entry, first)
          if (data.length > 1) entry.extra = data.slice(1)
        } else {
          entry.data = data.length === 1 ? data[0] : data
        }
      }
      const consoleFn = level === 'debug' ? console.log : console[level]
      consoleFn(JSON.stringify(entry))
      return
    }

    const formattedMessage = this.formatMessage(level, message)

    // Dev server-side: colored text
    if (isServer) {
      const color = LOG_COLORS[level]
      console[level === 'debug' ? 'log' : level](
        `${color}${formattedMessage}${RESET_COLOR}`,
        ...data
      )
    } else {
      // Client-side: native console
      const consoleFn = level === 'debug' ? console.log : console[level]
      if (data.length > 0) {
        consoleFn(formattedMessage, ...data)
      } else {
        consoleFn(formattedMessage)
      }
    }
  }

  /**
   * Debug 级别日志（开发环境）
   */
  debug(message: string, ...data: unknown[]): void {
    this.output('debug', message, ...data)
  }

  /**
   * Log 级别日志（开发环境）
   */
  log(message: string, ...data: unknown[]): void {
    this.output('log', message, ...data)
  }

  /**
   * Info 级别日志
   */
  info(message: string, ...data: unknown[]): void {
    this.output('info', message, ...data)
  }

  /**
   * Warn 级别日志（生产环境可见）
   */
  warn(message: string, ...data: unknown[]): void {
    this.output('warn', message, ...data)
  }

  /**
   * 关键业务日志（生产环境始终可见，用于支付、认证等）
   * 使用 warn 级别确保在生产环境输出
   */
  critical(message: string, ...data: unknown[]): void {
    this.output('warn', `[CRITICAL] ${message}`, ...data)
  }

  /**
   * Error 级别日志（生产环境可见）
   */
  error(message: string, ...data: unknown[]): void {
    this.output('error', message, ...data)
  }

  /**
   * Error 日志（带异常信息）
   */
  errorWithException(message: string, error: Error, data?: Record<string, unknown>): void {
    this.output('error', message, { error: error.message, stack: error.stack, ...data })
  }

  /**
   * Log API error with standard format
   */
  apiError(endpoint: string, error: unknown, context?: Record<string, unknown>): void {
    const errorMessage = error instanceof Error
      ? error.message
      : (typeof error === 'object' && error !== null && 'message' in error)
        ? String((error as Record<string, unknown>).message)
        : JSON.stringify(error)
    this.error(`API Error: ${endpoint}`, { endpoint, error: errorMessage, ...context })
    if (error instanceof Error) {
      void captureError(error, { endpoint, ...context })
    }
  }

  /**
   * Log database error
   */
  dbError(operation: string, error: unknown, context?: Record<string, unknown>): void {
    const errorMessage = error instanceof Error
      ? error.message
      : (typeof error === 'object' && error !== null && 'message' in error)
        ? String((error as Record<string, unknown>).message)
        : JSON.stringify(error)
    this.error(`Database Error: ${operation}`, { operation, error: errorMessage, ...context })
    if (error instanceof Error) {
      void captureError(error, { operation, ...context })
    }
  }

  /**
   * 创建子 logger
   */
  child(name: string): Logger {
    const childName = this.name ? `${this.name}:${name}` : name
    return new Logger(childName, this.config)
  }

  /**
   * 设置配置
   */
  setConfig(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * 临时禁用日志
   */
  disable(): void {
    this.config.enabled = false
  }

  /**
   * 启用日志
   */
  enable(): void {
    this.config.enabled = true
  }

  /**
   * 分组日志
   */
  group(label: string): void {
    if (!this.shouldLog('log')) return
    console.group(this.formatMessage('log', label))
  }

  /**
   * 结束分组
   */
  groupEnd(): void {
    if (!this.shouldLog('log')) return
    console.groupEnd()
  }

  /**
   * 计时开始
   */
  time(label: string): void {
    if (!this.shouldLog('debug')) return
    console.time(`${this.name ? `[${this.name}] ` : ''}${label}`)
  }

  /**
   * 计时结束
   */
  timeEnd(label: string): void {
    if (!this.shouldLog('debug')) return
    console.timeEnd(`${this.name ? `[${this.name}] ` : ''}${label}`)
  }

  /**
   * 表格输出
   */
  table(data: unknown): void {
    if (!this.shouldLog('log')) return
    console.table(data)
  }

  /**
   * 创建带上下文的子 logger
   * 上下文信息会附加到每条日志消息中
   */
  withContext(context: Record<string, unknown>): Logger {
    const contextStr = Object.entries(context)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ')
    const newName = this.name ? `${this.name}:${contextStr}` : contextStr
    return new Logger(newName, this.config)
  }
}

// ============================================
// 预定义 Logger 实例
// ============================================

/** 全局默认 logger */
export const logger = new Logger()

/** API 相关日志 */
export const apiLogger = new Logger('API')

/** 数据层日志 */
export const dataLogger = new Logger('Data')

/** 认证相关日志 */
export const authLogger = new Logger('Auth')

/** 性能相关日志 */
export const perfLogger = new Logger('Perf')

/** 交易所相关日志 */
export const exchangeLogger = new Logger('Exchange')

/** 实时功能日志 */
export const realtimeLogger = new Logger('Realtime')

/** UI 组件日志 */
export const uiLogger = new Logger('UI')

/** 消息系统日志 */
export const messageLogger = new Logger('Message')

// ============================================
// 消息追踪辅助函数
// ============================================

/**
 * 消息事件类型
 */
export type MessageEvent =
  | 'send'           // 发送消息
  | 'delivered'      // 消息送达
  | 'read'           // 消息已读
  | 'failed'         // 发送失败
  | 'conversation_created'  // 会话创建
  | 'notification_sent'     // 通知发送

interface MessageTraceContext {
  messageId?: string
  conversationId?: string
  senderId?: string
  receiverId?: string
  event: MessageEvent
  error?: string
  metadata?: Record<string, unknown>
}

/**
 * 记录消息追踪日志
 * 用于追踪消息从发送到已读的完整生命周期
 */
export function traceMessage(context: MessageTraceContext): void {
  const { messageId, conversationId, senderId, receiverId, event, error, metadata } = context
  const timestamp = new Date().toISOString()

  const logData = {
    messageId,
    conversationId,
    senderId,
    receiverId,
    event,
    timestamp,
    ...metadata,
  }

  if (error) {
    messageLogger.error(`Message ${event} failed: ${error}`, logData)
    captureMessage(`Message ${event} failed`, 'error', { ...logData, error })
  } else {
    messageLogger.info(`Message ${event}`, logData)
  }

  // 添加 Sentry breadcrumb 用于追踪
  addBreadcrumb(`msg:${event}`, error ? 'error' : 'info', {
    messageId,
    conversationId,
  })
}

// ============================================
// 请求 ID 管理
// ============================================

let currentRequestId: string | null = null

/**
 * 生成请求 ID
 */
export function generateRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * 设置当前请求 ID
 */
export function setCurrentRequestId(id: string): void {
  currentRequestId = id
}

/**
 * 获取当前请求 ID
 */
export function getCurrentRequestId(): string | null {
  return currentRequestId
}

/**
 * 清除当前请求 ID
 */
export function clearCurrentRequestId(): void {
  currentRequestId = null
}

// ============================================
// 请求日志
// ============================================

interface RequestLogData {
  method: string
  path: string
  statusCode: number
  duration: number
  error?: string
}

/**
 * 记录请求日志
 */
export function logRequest(data: RequestLogData): void {
  const { method, path, statusCode, duration, error } = data
  const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info'
  const message = `${method} ${path} ${statusCode} ${duration}ms${error ? ` - ${error}` : ''}`
  apiLogger[level](message)
}

// ============================================
// 计时器
// ============================================

interface TimerEndOptions {
  status?: number
  error?: string
}

interface Timer {
  end: (options?: TimerEndOptions) => number
}

/**
 * 创建计时器
 */
export function createTimer(label: string, context?: string): Timer {
  const start = Date.now()
  const log = context ? new Logger(context) : logger
  
  return {
    end(options?: TimerEndOptions): number {
      const duration = Date.now() - start
      const status = options?.status
      const error = options?.error
      
      if (error) {
        log.warn(`${label} completed in ${duration}ms with error: ${error}`)
      } else if (status && status >= 400) {
        log.warn(`${label} completed in ${duration}ms with status ${status}`)
      } else {
        log.debug(`${label} completed in ${duration}ms`)
      }
      
      return duration
    }
  }
}

// ============================================
// 便捷函数
// ============================================

/**
 * 创建命名 logger
 */
export function createLogger(name: string, config?: Partial<LoggerConfig>): Logger {
  return new Logger(name, config)
}

/**
 * 静默执行（不输出任何日志）
 */
export function silent<T>(fn: () => T): T {
  const originalEnabled = defaultConfig.enabled
  defaultConfig.enabled = false
  try {
    return fn()
  } finally {
    defaultConfig.enabled = originalEnabled
  }
}

/**
 * 条件日志
 */
export function logIf(condition: boolean, level: LogLevel, message: string, ...data: unknown[]): void {
  if (condition) {
    logger[level](message, ...data)
  }
}

/**
 * 仅开发环境执行
 */
export function devOnly(fn: () => void): void {
  if (!isProduction) {
    fn()
  }
}

// ============================================
// Sentry 集成（从 lib/logger.ts 合并）
// ============================================

let Sentry: typeof import('@sentry/nextjs') | null = null
let sentryLoadFailed = false

// 延迟加载 Sentry（避免客户端导入问题）
async function getSentry() {
  if (Sentry) return Sentry
  if (sentryLoadFailed) return null

  try {
    Sentry = await import('@sentry/nextjs')
    return Sentry
  } catch (e) {
    sentryLoadFailed = true
    // Log to console so we know Sentry isn't working
    if (isProduction) {
      console.warn('[Logger] Sentry load failed, error reporting disabled:', e instanceof Error ? e.message : e)
    }
    return null
  }
}

/**
 * 向 Sentry 发送错误
 */
export async function captureError(error: Error, context?: Record<string, unknown>): Promise<void> {
  try {
    const sentry = await getSentry()
    if (sentry) {
      sentry.captureException(error, { extra: context })
    } else if (isProduction) {
      // Fallback: log to console if Sentry unavailable in production
      console.error('[Sentry Fallback] Error:', error.message, context)
    }
  } catch (e) {
    // Don't let Sentry errors crash the app
    console.error('[Logger] captureError failed:', e instanceof Error ? e.message : e)
  }
}

/**
 * 向 Sentry 发送消息
 */
export async function captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info', context?: Record<string, unknown>): Promise<void> {
  try {
    const sentry = await getSentry()
    if (sentry) {
      sentry.captureMessage(message, { level, extra: context })
    } else if (isProduction && level === 'error') {
      console.error('[Sentry Fallback] Message:', message, context)
    }
  } catch (e) {
    console.error('[Logger] captureMessage failed:', e instanceof Error ? e.message : e)
  }
}

/**
 * 添加 Sentry breadcrumb
 */
export async function addBreadcrumb(message: string, level: 'info' | 'warning' | 'error' = 'info', data?: Record<string, unknown>): Promise<void> {
  try {
    const sentry = await getSentry()
    if (sentry) {
      sentry.addBreadcrumb({ message, level, data, timestamp: Date.now() / 1000 })
    }
  } catch (_err) {
    /* breadcrumb recording is non-critical */
  }
}

// ============================================
// 重试和安全执行（从 lib/logger.ts 合并）
// ============================================

/**
 * 创建带重试机制的异步函数执行器
 * 支持指数退避和错误日志记录
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number
    baseDelayMs?: number
    context?: string
    onRetry?: (attempt: number, error: Error) => void
  } = {}
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 2000, context = 'operation', onRetry } = options

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt < maxRetries) {
        const delay = baseDelayMs * attempt // 线性退避
        logger.warn(`${context} failed, retrying in ${delay}ms`, {
          attempt,
          maxRetries,
          error: lastError.message,
        })

        onRetry?.(attempt, lastError)

        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  logger.error(`${context} failed after ${maxRetries} attempts`, lastError!)
  await captureError(lastError!, { maxRetries, context })

  throw lastError
}

/**
 * 安全执行函数，捕获错误但不抛出
 * 返回 [result, error] 元组
 */
export async function safeExecute<T>(
  fn: () => Promise<T>,
  context?: string
): Promise<[T | null, Error | null]> {
  try {
    const result = await fn()
    return [result, null]
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    if (context) {
      logger.warn(`${context} failed`, { error: err.message })
    }
    return [null, err]
  }
}

// ---------------------------------------------------------------------------
// Fire-and-forget failure tracking
// ---------------------------------------------------------------------------

/** In-memory failure counts per label, for health check observability */
const _fireAndForgetFailures = new Map<string, { count: number; lastError: string; lastAt: number }>()

/** Escalation threshold: log at error level after this many consecutive failures */
const FIRE_AND_FORGET_ERROR_THRESHOLD = 3

/**
 * Returns a snapshot of all fire-and-forget failure counts.
 * Useful for health check endpoints to surface silent background failures.
 */
export function getFireAndForgetStats(): Record<string, { count: number; lastError: string; lastAt: string }> {
  const result: Record<string, { count: number; lastError: string; lastAt: string }> = {}
  for (const [label, data] of _fireAndForgetFailures) {
    result[label] = {
      count: data.count,
      lastError: data.lastError,
      lastAt: new Date(data.lastAt).toISOString(),
    }
  }
  return result
}

/**
 * Fire-and-forget：执行异步操作，记录错误但不阻塞
 * 用于替代 `.catch(() => {})` 模式，提供更好的可观测性
 *
 * Tracks failure counts per label in-memory. If the same label fails
 * 3+ times, logs at error level (instead of warn) for visibility.
 * Use `getFireAndForgetStats()` to inspect failure counts from health endpoints.
 *
 * @param promise - 要执行的 Promise
 * @param context - 描述操作的上下文（用于错误日志）
 * @param options - 可选配置
 */
export function fireAndForget<T>(
  promise: PromiseLike<T> | Promise<T>,
  context: string,
  options?: {
    /** 是否发送到 Sentry (默认 false，仅 warn 级别日志) */
    reportToSentry?: boolean
    /** 自定义日志实例 */
    log?: Logger
  }
): void {
  const log = options?.log ?? logger
  Promise.resolve(promise).catch((error) => {
    const err = error instanceof Error ? error : new Error(String(error))

    // Track failure count
    const existing = _fireAndForgetFailures.get(context)
    const count = (existing?.count ?? 0) + 1
    _fireAndForgetFailures.set(context, {
      count,
      lastError: err.message,
      lastAt: Date.now(),
    })

    // Escalate to error level after repeated failures
    if (count >= FIRE_AND_FORGET_ERROR_THRESHOLD) {
      log.error(`[FireAndForget] ${context} failed (${count}x):`, err.message)
    } else {
      log.warn(`[FireAndForget] ${context} failed:`, err.message)
    }

    if (options?.reportToSentry) {
      void captureError(err, { context, fireAndForget: true, failureCount: count })
    }
  })
}

// ============================================
// 导出
// ============================================

export { Logger }
export type { LogLevel, LoggerConfig, LogEntry }

/**
 * Alias for captureError (for Sentry compatibility)
 */
export const captureException = captureError
