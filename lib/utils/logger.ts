/**
 * 增强版日志系统
 * 提供结构化日志、请求追踪、错误聚合等功能
 */

// ============================================
// 类型定义
// ============================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  level: LogLevel
  message: string
  timestamp: string
  context?: string
  requestId?: string
  userId?: string
  data?: Record<string, unknown>
  error?: {
    name: string
    message: string
    stack?: string
  }
  performance?: {
    duration?: number
    memory?: number
  }
}

export interface LoggerOptions {
  context?: string
  requestId?: string
  userId?: string
  data?: Record<string, unknown>
}

export interface LoggerConfig {
  level: LogLevel
  enableConsole: boolean
  enableStructured: boolean
  enableRequestId: boolean
  maxBufferSize: number
  onLog?: (entry: LogEntry) => void
}

// ============================================
// 常量配置
// ============================================

const LOG_COLORS = {
  debug: '\x1b[36m', // cyan
  info: '\x1b[32m',  // green
  warn: '\x1b[33m',  // yellow
  error: '\x1b[31m', // red
  reset: '\x1b[0m',
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

// ============================================
// 配置管理
// ============================================

const isProduction = process.env.NODE_ENV === 'production'
const isServer = typeof window === 'undefined'

// 安全获取内存使用情况（仅在 Node.js 环境可用，Edge Runtime 不支持）
function getHeapUsed(): number | undefined {
  try {
    // 动态检查以避免 Turbopack 静态分析报错
    const proc = globalThis.process as NodeJS.Process | undefined
    if (proc && typeof proc.memoryUsage === 'function') {
      return proc.memoryUsage().heapUsed
    }
  } catch {
    // Edge Runtime 或其他不支持的环境
  }
  return undefined
}

const defaultConfig: LoggerConfig = {
  level: isProduction ? 'warn' : 'debug',
  enableConsole: true,
  enableStructured: isProduction,
  enableRequestId: true,
  maxBufferSize: 100,
}

let globalConfig: LoggerConfig = { ...defaultConfig }

/**
 * 配置日志系统
 */
export function configureLogger(config: Partial<LoggerConfig>): void {
  globalConfig = { ...globalConfig, ...config }
}

// ============================================
// 请求 ID 管理
// ============================================

let requestIdCounter = 0
const requestIdStore = new Map<string, string>()

/**
 * 生成新的请求 ID
 */
export function generateRequestId(): string {
  const timestamp = Date.now().toString(36)
  const counter = (++requestIdCounter).toString(36).padStart(4, '0')
  const random = Math.random().toString(36).substring(2, 6)
  return `${timestamp}-${counter}-${random}`
}

/**
 * 获取当前请求 ID（需要在请求开始时设置）
 */
export function getCurrentRequestId(): string | undefined {
  if (isServer) {
    // 服务端使用 AsyncLocalStorage 或简单的全局存储
    return requestIdStore.get('current')
  }
  return undefined
}

/**
 * 设置当前请求 ID
 */
export function setCurrentRequestId(id: string): void {
  requestIdStore.set('current', id)
}

/**
 * 清除当前请求 ID
 */
export function clearCurrentRequestId(): void {
  requestIdStore.delete('current')
}

// ============================================
// 日志缓冲区（用于批量处理）
// ============================================

const logBuffer: LogEntry[] = []

function addToBuffer(entry: LogEntry): void {
  logBuffer.push(entry)
  
  // 超出缓冲区大小时移除最旧的日志
  while (logBuffer.length > globalConfig.maxBufferSize) {
    logBuffer.shift()
  }
}

/**
 * 获取日志缓冲区内容
 */
export function getLogBuffer(): LogEntry[] {
  return [...logBuffer]
}

/**
 * 清空日志缓冲区
 */
export function clearLogBuffer(): void {
  logBuffer.length = 0
}

// ============================================
// 核心日志函数
// ============================================

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[globalConfig.level]
}

function formatConsoleMessage(entry: LogEntry): string {
  const color = isProduction ? '' : LOG_COLORS[entry.level]
  const reset = isProduction ? '' : LOG_COLORS.reset
  
  let message = `${color}${entry.timestamp} [${entry.level.toUpperCase()}]`
  
  if (entry.context) {
    message += `[${entry.context}]`
  }
  
  if (entry.requestId) {
    message += `[${entry.requestId.substring(0, 8)}]`
  }
  
  message += ` ${entry.message}${reset}`
  
  return message
}

function createLogEntry(
  level: LogLevel,
  message: string,
  options?: LoggerOptions
): LogEntry {
  const entry: LogEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    context: options?.context,
    requestId: options?.requestId || getCurrentRequestId(),
    userId: options?.userId,
    data: options?.data,
  }
  
  return entry
}

function outputLog(entry: LogEntry): void {
  // 控制台输出
  if (globalConfig.enableConsole) {
    const formattedMessage = formatConsoleMessage(entry)
    
    switch (entry.level) {
      case 'debug':
        entry.data ? console.debug(formattedMessage, entry.data) : console.debug(formattedMessage)
        break
      case 'info':
        entry.data ? console.info(formattedMessage, entry.data) : console.info(formattedMessage)
        break
      case 'warn':
        entry.data ? console.warn(formattedMessage, entry.data) : console.warn(formattedMessage)
        break
      case 'error':
        if (entry.error) {
          console.error(formattedMessage, { ...entry.data, error: entry.error })
        } else {
          entry.data ? console.error(formattedMessage, entry.data) : console.error(formattedMessage)
        }
        break
    }
  }
  
  // 结构化日志输出（JSON 格式，适合日志聚合服务）
  if (globalConfig.enableStructured && isProduction) {
    console.log(JSON.stringify(entry))
  }
  
  // 添加到缓冲区
  addToBuffer(entry)
  
  // 调用自定义处理函数
  if (globalConfig.onLog) {
    globalConfig.onLog(entry)
  }
}

function log(level: LogLevel, message: string, options?: LoggerOptions): void {
  if (!shouldLog(level)) return
  
  const entry = createLogEntry(level, message, options)
  outputLog(entry)
}

// ============================================
// 公共 API
// ============================================

/**
 * 创建带有固定上下文的 logger
 */
export function createLogger(context: string) {
  return {
    debug: (message: string, data?: Record<string, unknown>) =>
      log('debug', message, { context, data }),
    info: (message: string, data?: Record<string, unknown>) =>
      log('info', message, { context, data }),
    warn: (message: string, data?: Record<string, unknown>) =>
      log('warn', message, { context, data }),
    error: (message: string, data?: Record<string, unknown>) =>
      log('error', message, { context, data }),
    
    // 带错误对象的日志方法
    errorWithException: (message: string, error: Error, data?: Record<string, unknown>) => {
      const entry = createLogEntry('error', message, { context, data })
      entry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      }
      outputLog(entry)
    },
    
    // 性能日志
    perf: (message: string, duration: number, data?: Record<string, unknown>) => {
      const entry = createLogEntry('info', message, { context, data })
      entry.performance = { duration }
      outputLog(entry)
    },
  }
}

// 默认 logger
export const logger = {
  debug: (message: string, options?: LoggerOptions) => log('debug', message, options),
  info: (message: string, options?: LoggerOptions) => log('info', message, options),
  warn: (message: string, options?: LoggerOptions) => log('warn', message, options),
  error: (message: string, options?: LoggerOptions) => log('error', message, options),
}

// 便捷方法
export const debug = (message: string, context?: string, data?: Record<string, unknown>) =>
  log('debug', message, { context, data })

export const info = (message: string, context?: string, data?: Record<string, unknown>) =>
  log('info', message, { context, data })

export const warn = (message: string, context?: string, data?: Record<string, unknown>) =>
  log('warn', message, { context, data })

export const error = (message: string, context?: string, data?: Record<string, unknown>) =>
  log('error', message, { context, data })

/**
 * 环境感知的日志函数
 */
export const devLog = {
  log: (...args: unknown[]) => {
    if (!isProduction) console.log(...args)
  },
  warn: (...args: unknown[]) => {
    if (!isProduction) console.warn(...args)
  },
  error: (...args: unknown[]) => {
    console.error(...args)
  },
}

// ============================================
// 请求日志工具
// ============================================

export interface RequestLogData {
  method: string
  path: string
  statusCode?: number
  duration?: number
  userAgent?: string
  ip?: string
  error?: string
}

/**
 * 记录 API 请求日志
 */
export function logRequest(data: RequestLogData): void {
  const level: LogLevel = data.statusCode && data.statusCode >= 400 ? 'error' : 'info'
  const message = `${data.method} ${data.path} ${data.statusCode || '-'} ${data.duration || '-'}ms`
  
  log(level, message, {
    context: 'API',
    data: {
      method: data.method,
      path: data.path,
      statusCode: data.statusCode,
      duration: data.duration,
      userAgent: data.userAgent,
      ip: data.ip,
      error: data.error,
    },
  })
}

// ============================================
// 性能日志工具
// ============================================

/**
 * 创建性能计时器
 */
export function createTimer(name: string, context?: string) {
  const startTime = Date.now()
  const startMemory = getHeapUsed()
  
  return {
    end: (additionalData?: Record<string, unknown>) => {
      const duration = Date.now() - startTime
      const endMemory = getHeapUsed()
      
      const entry = createLogEntry('info', `${name} completed in ${duration}ms`, {
        context,
        data: additionalData,
      })
      
      entry.performance = {
        duration,
        memory: startMemory && endMemory ? endMemory - startMemory : undefined,
      }
      
      outputLog(entry)
      
      return duration
    },
  }
}

// ============================================
// 错误聚合
// ============================================

interface AggregatedError {
  count: number
  firstOccurrence: string
  lastOccurrence: string
  sample: LogEntry
}

const errorAggregator = new Map<string, AggregatedError>()

/**
 * 获取错误签名（用于聚合相同错误）
 */
function getErrorSignature(entry: LogEntry): string {
  return `${entry.context || ''}:${entry.message}:${entry.error?.name || ''}`
}

/**
 * 聚合错误日志
 */
export function aggregateError(entry: LogEntry): void {
  const signature = getErrorSignature(entry)
  const existing = errorAggregator.get(signature)
  
  if (existing) {
    existing.count++
    existing.lastOccurrence = entry.timestamp
  } else {
    errorAggregator.set(signature, {
      count: 1,
      firstOccurrence: entry.timestamp,
      lastOccurrence: entry.timestamp,
      sample: entry,
    })
  }
}

/**
 * 获取聚合的错误列表
 */
export function getAggregatedErrors(): AggregatedError[] {
  return Array.from(errorAggregator.values())
    .sort((a, b) => b.count - a.count)
}

/**
 * 清除聚合的错误
 */
export function clearAggregatedErrors(): void {
  errorAggregator.clear()
}

// 配置日志系统在错误时进行聚合
configureLogger({
  onLog: (entry) => {
    if (entry.level === 'error') {
      aggregateError(entry)
    }
  },
})
