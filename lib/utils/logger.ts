/**
 * 统一日志工具
 * 提供一致的日志格式和级别控制
 * 生产环境只输出 warn 和 error 级别的日志
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LoggerOptions {
  context?: string
  data?: Record<string, unknown>
}

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

// 从环境变量获取日志级别
// 生产环境默认为 'warn'，开发环境默认为 'debug'
const isProduction = process.env.NODE_ENV === 'production'
const defaultLevel: LogLevel = isProduction ? 'warn' : 'debug'
const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || defaultLevel

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLevel]
}

function formatMessage(level: LogLevel, message: string, options?: LoggerOptions): string {
  const timestamp = new Date().toISOString()
  const context = options?.context ? `[${options.context}]` : ''
  const color = isProduction ? '' : LOG_COLORS[level]
  const reset = isProduction ? '' : LOG_COLORS.reset
  
  return `${color}${timestamp} [${level.toUpperCase()}]${context} ${message}${reset}`
}

function log(level: LogLevel, message: string, options?: LoggerOptions): void {
  if (!shouldLog(level)) return

  const formattedMessage = formatMessage(level, message, options)
  const data = options?.data
  
  switch (level) {
    case 'debug':
      data ? console.debug(formattedMessage, data) : console.debug(formattedMessage)
      break
    case 'info':
      data ? console.info(formattedMessage, data) : console.info(formattedMessage)
      break
    case 'warn':
      data ? console.warn(formattedMessage, data) : console.warn(formattedMessage)
      break
    case 'error':
      data ? console.error(formattedMessage, data) : console.error(formattedMessage)
      break
  }
}

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
 * 生产环境只输出 error，开发环境输出所有级别
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
