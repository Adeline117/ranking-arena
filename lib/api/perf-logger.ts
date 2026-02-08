/**
 * API Response Time Logger
 * 
 * Lightweight middleware to track API response times and log slow queries.
 */

import { createLogger } from '@/lib/utils/logger'
import { performanceBudget } from '@/lib/performance/performance.config'

const logger = createLogger('api-perf')

/**
 * Measure and log API route execution time.
 * Logs a warning for responses exceeding the slow threshold (>1s).
 */
export function measureApiTime(routeName: string) {
  const start = performance.now()

  return {
    /** Call when the request finishes to log elapsed time */
    end(status: number = 200) {
      const elapsed = Math.round(performance.now() - start)
      const { slowThreshold, criticalThreshold } = performanceBudget.api

      if (elapsed >= criticalThreshold) {
        logger.error(`CRITICAL SLOW API: ${routeName} took ${elapsed}ms (status: ${status})`)
      } else if (elapsed >= slowThreshold) {
        logger.warn(`Slow API: ${routeName} took ${elapsed}ms (status: ${status})`)
      } else if (process.env.NODE_ENV === 'development') {
        logger.info(`${routeName}: ${elapsed}ms`)
      }

      return elapsed
    },
  }
}
