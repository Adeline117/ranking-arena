/**
 * Worker 专用日志模块
 * 简化版，不依赖 Sentry（在独立 worker 中运行）
 */

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
  debug: (message: string, context?: LogContext): void => {
    if (process.env.NODE_ENV === 'development' || process.env.DEBUG) {
      const entry = createLogEntry('debug', message, context)
      console.debug(formatLogEntry(entry))
    }
  },

  info: (message: string, context?: LogContext): void => {
    const entry = createLogEntry('info', message, context)
    console.log(formatLogEntry(entry))
  },

  warn: (message: string, context?: LogContext): void => {
    const entry = createLogEntry('warn', message, context)
    console.warn(formatLogEntry(entry))
  },

  error: (message: string, error: Error, context?: LogContext): void => {
    const entry = createLogEntry('error', message, context, error)
    console.error(formatLogEntry(entry))
  },

  withContext: (baseContext: LogContext) => ({
    debug: (message: string, context?: LogContext) =>
      logger.debug(message, { ...baseContext, ...context }),
    info: (message: string, context?: LogContext) =>
      logger.info(message, { ...baseContext, ...context }),
    warn: (message: string, context?: LogContext) =>
      logger.warn(message, { ...baseContext, ...context }),
    error: (message: string, error: Error, context?: LogContext) =>
      logger.error(message, error, { ...baseContext, ...context }),
  }),
}

/**
 * 带重试机制的异步函数执行器
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
        const delay = baseDelayMs * attempt
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default logger
