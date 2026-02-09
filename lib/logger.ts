/**
 * Production-safe logging utility
 *
 * Replaces console.error with proper error handling:
 * - Development: logs to console
 * - Production: sends to Sentry and logs minimal info
 */

type _LogLevel = 'error' | 'warn' | 'info' | 'debug'

interface LogContext {
  [key: string]: unknown
}

class Logger {
  private isDevelopment = process.env.NODE_ENV === 'development'
  private isProduction = process.env.NODE_ENV === 'production'

  /**
   * Log error with context
   * In production: sends to Sentry
   * In development: logs to console
   */
  error(message: string, context?: LogContext, error?: Error): void {
    if (this.isDevelopment) {
      console.error(`[ERROR] ${message}`, context || '', error || '')
    }

    if (this.isProduction && error) {
      // Send to Sentry in production
      this.sendToSentry(error, { message, ...context })
    }
  }

  /**
   * Log warning
   */
  warn(message: string, context?: LogContext): void {
    if (this.isDevelopment) {
      console.warn(`[WARN] ${message}`, context || '')
    }
  }

  /**
   * Log info (development only)
   */
  info(message: string, context?: LogContext): void {
    if (this.isDevelopment) {
      console.warn(`[INFO] ${message}`, context || '')
    }
  }

  /**
   * Log debug (development only)
   */
  debug(message: string, context?: LogContext): void {
    if (this.isDevelopment) {
      console.warn(`[DEBUG] ${message}`, context || '')
    }
  }

  /**
   * Send error to Sentry (production only)
   */
  private sendToSentry(error: Error, context?: LogContext): void {
    if (!this.isProduction) return

    try {
      import('@sentry/nextjs').then((Sentry) => {
        Sentry.captureException(error, {
          extra: context,
          tags: {
            source: 'api-logger',
          },
        })
      }).catch(() => {
        // Silently fail if Sentry is not available
      })
    } catch {
      // Silently fail
    }
  }

  /**
   * Log API error with standard format
   */
  apiError(
    endpoint: string,
    error: unknown,
    context?: LogContext
  ): void {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorObj = error instanceof Error ? error : new Error(errorMessage)

    this.error(
      `API Error: ${endpoint}`,
      {
        endpoint,
        error: errorMessage,
        ...context,
      },
      errorObj
    )
  }

  /**
   * Log database error
   */
  dbError(
    operation: string,
    error: unknown,
    context?: LogContext
  ): void {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorObj = error instanceof Error ? error : new Error(errorMessage)

    this.error(
      `Database Error: ${operation}`,
      {
        operation,
        error: errorMessage,
        ...context,
      },
      errorObj
    )
  }
}

export const logger = new Logger()

// Convenience exports
export const logError = logger.error.bind(logger)
export const logWarn = logger.warn.bind(logger)
export const logInfo = logger.info.bind(logger)
export const logDebug = logger.debug.bind(logger)
export const logApiError = logger.apiError.bind(logger)
export const logDbError = logger.dbError.bind(logger)

export default logger
