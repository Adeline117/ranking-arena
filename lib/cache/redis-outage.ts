/**
 * Report a failed Redis round trip: opens the circuit breaker and, when this
 * failure is the one that opened it, logs and sends the rate-limited outage
 * alert. Shared by the cache client and the route rate limiter so whichever
 * meets the outage first notifies operators.
 */

import { dataLogger, fireAndForget } from '@/lib/utils/logger'
import { RedisCircuitOpenError, recordRedisFailure } from './redis-circuit'

export function reportRedisFailure(error: unknown): void {
  // A call refused by the open circuit is not a failure of Redis itself.
  if (error instanceof RedisCircuitOpenError) return
  if (!recordRedisFailure()) return

  dataLogger.error('[Redis] Falling back to memory cache after a failed call', {
    lastError: error instanceof Error ? error.message : String(error),
  })
  // Dynamic import avoids a circular dependency with the alert module.
  const alertPromise = import('@/lib/alerts/send-alert')
    .then((m) =>
      m.sendRateLimitedAlert(
        {
          title: 'Redis DOWN — memory fallback active',
          message:
            'A Redis call failed. Cache operations use the in-memory fallback until a probe succeeds. Rankings, rate limiting, and dedup affected.',
          level: 'critical',
        },
        'redis-down',
        30 * 60 * 1000
      )
    )
    .catch(() => undefined)
  fireAndForget(alertPromise, 'redis-down-alert')
}
