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

type LogContextArg = LogContext | unknown

class Logger {
  private isDevelopment = process.env.NODE_ENV === 'development'
  private isProduction = process.env.NODE_ENV === 'production'

  /**
   * Log error with context
   * In production: sends to Sentry
   * In development: logs to console
   */
  error(message: string, context?: LogContextArg, error?: Error): void {
    if (this.isDevelopment) {
      console.error(`[ERROR] ${message}`, context || '', error || '')
    }

    if (this.isProduction && error) {
      // Send to Sentry in production
      this.sendToSentry(error, { message, ...(context && typeof context === 'object' ? context : { context }) })
    }
  }

  /**
   * Log warning
   */
  warn(message: string, context?: LogContextArg): void {
    if (this.isDevelopment) {
      console.warn(`[WARN] ${message}`, context || '')
    }
  }

  /**
   * Log info (development only)
   */
  info(message: string, context?: LogContextArg): void {
    if (this.isDevelopment) {
      console.warn(`[INFO] ${message}`, context || '')
    }
  }

  /**
   * Log debug (development only)
   */
  debug(message: string, context?: LogContextArg): void {
    if (this.isDevelopment) {
      console.warn(`[DEBUG] ${message}`, context || '')
    }
  }

  /**
   * Check if an error should be reported to Sentry
   * Filters out user-caused errors (network, auth, rate-limit)
   */
  private shouldReportToSentry(error: Error): boolean {
    const msg = error.message || ''
    const status = (error as Error & { status?: number; statusCode?: number }).status
      ?? (error as Error & { status?: number; statusCode?: number }).statusCode

    // Don't report 4xx client errors
    if (status && status >= 400 && status < 500) return false

    // Don't report network/timeout errors (user-side or upstream)
    const skipPatterns = [
      'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE',
      'AbortError', 'fetch failed', 'Failed to fetch',
      'JWTExpired', 'JWT expired', 'Invalid Refresh Token',
      'Too Many Requests', 'FUNCTION_INVOCATION_TIMEOUT',
    ]
    if (skipPatterns.some(p => msg.includes(p))) return false

    return true
  }

  /**
   * Send error to Sentry (production only)
   */
  private sendToSentry(error: Error, context?: LogContextArg): void {
    if (!this.isProduction) return
    if (!this.shouldReportToSentry(error)) return

    try {
      import('@sentry/nextjs').then((Sentry) => {
        Sentry.captureException(error, {
          extra: (context && typeof context === 'object' ? context : { value: context }) as Record<string, unknown>,
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
    const errorMessage = error instanceof Error
      ? error.message
      : (typeof error === 'object' && error !== null && 'message' in error)
        ? String((error as Record<string, unknown>).message)
        : JSON.stringify(error)
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
    const errorMessage = error instanceof Error
      ? error.message
      : (typeof error === 'object' && error !== null && 'message' in error)
        ? String((error as Record<string, unknown>).message)
        : JSON.stringify(error)
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
