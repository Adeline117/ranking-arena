/**
 * 统一日志模块
 * 提供结构化日志记录和 Sentry 集成
 */

import * as Sentry from '@sentry/nextjs'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogContext {
  [key: string]: unknown
}

interface LogEntry {
  level: LogLevel
  message: string
  timestamp: string
  context?: LogContext
  error?: {
    name: string
    message: string
    stack?: string
  }
}

function formatLogEntry(entry: LogEntry): string {
  return JSON.stringify(entry)
}

function createLogEntry(
  level: LogLevel,
  message: string,
  context?: LogContext,
  error?: Error
): LogEntry {
  const entry: LogEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
  }

  if (context && Object.keys(context).length > 0) {
    entry.context = context
  }

  if (error) {
    entry.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }

  return entry
}

export const logger = {
  /**
   * Debug 级别日志 - 仅在开发环境输出
   */
  debug: (message: string, context?: LogContext): void => {
    if (process.env.NODE_ENV === 'development') {
      const entry = createLogEntry('debug', message, context)
      console.debug(formatLogEntry(entry))
    }
  },

  /**
   * Info 级别日志 - 记录正常操作
   */
  info: (message: string, context?: LogContext): void => {
    const entry = createLogEntry('info', message, context)
    console.log(formatLogEntry(entry))
  },

  /**
   * Warn 级别日志 - 记录警告，添加 Sentry breadcrumb
   */
  warn: (message: string, context?: LogContext): void => {
    const entry = createLogEntry('warn', message, context)
    console.warn(formatLogEntry(entry))

    // 添加 Sentry breadcrumb
    Sentry.addBreadcrumb({
      message,
      level: 'warning',
      data: context,
      timestamp: Date.now() / 1000,
    })
  },

  /**
   * Error 级别日志 - 记录错误，发送到 Sentry
   * 支持两种调用方式：
   * - logger.error('message', error, context) - 推荐，error 会发送到 Sentry
   * - logger.error('message', context) - context 中的 error 字段会被提取
   */
  error: (message: string, errorOrContext?: Error | LogContext, context?: LogContext): void => {
    let error: Error | undefined
    let ctx: LogContext | undefined

    if (errorOrContext instanceof Error) {
      error = errorOrContext
      ctx = context
    } else if (errorOrContext) {
      ctx = errorOrContext
      // 从 context 中提取 error 字段
      if (ctx.error instanceof Error) {
        error = ctx.error
      } else if (ctx.error) {
        error = new Error(String(ctx.error))
      }
    }

    const entry = createLogEntry('error', message, ctx, error)
    console.error(formatLogEntry(entry))

    // 发送到 Sentry
    if (error) {
      Sentry.captureException(error, {
        extra: {
          message,
          ...ctx,
        },
      })
    } else {
      Sentry.captureMessage(message, {
        level: 'error',
        extra: ctx,
      })
    }
  },

  /**
   * 创建带有固定上下文的 logger 实例
   * 用于模块级别的日志记录
   */
  withContext: (baseContext: LogContext) => ({
    debug: (message: string, context?: LogContext) =>
      logger.debug(message, { ...baseContext, ...context }),
    info: (message: string, context?: LogContext) =>
      logger.info(message, { ...baseContext, ...context }),
    warn: (message: string, context?: LogContext) =>
      logger.warn(message, { ...baseContext, ...context }),
    error: (message: string, errorOrContext?: Error | LogContext, context?: LogContext) => {
      if (errorOrContext instanceof Error) {
        logger.error(message, errorOrContext, { ...baseContext, ...context })
      } else {
        logger.error(message, { ...baseContext, ...errorOrContext })
      }
    },
  }),
}

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

  logger.error(`${context} failed after ${maxRetries} attempts`, lastError!, {
    maxRetries,
    context,
  })

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

export default logger
