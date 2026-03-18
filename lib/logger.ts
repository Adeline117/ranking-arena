/**
 * Logger re-export for backwards compatibility
 *
 * The canonical logger implementation is at lib/utils/logger.ts
 * This file re-exports for existing imports from '@/lib/logger'
 */

export {
  logger,
  apiLogger,
  dataLogger,
  authLogger,
  perfLogger,
  createLogger,
  captureError,
  captureMessage,
  fireAndForget,
  Logger,
  type LogLevel,
  type LoggerConfig,
} from './utils/logger'

export { logger as default } from './utils/logger'

// Convenience exports for backwards compatibility
import { logger } from './utils/logger'
export const logError = logger.error.bind(logger)
export const logWarn = logger.warn.bind(logger)
export const logInfo = logger.info.bind(logger)
export const logDebug = logger.debug.bind(logger)
export const logApiError = logger.apiError.bind(logger)
export const logDbError = logger.dbError.bind(logger)
