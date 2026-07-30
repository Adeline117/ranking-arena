/**
 * Redis-based cron job deduplication lock.
 * Prevents overlapping executions of the same cron job.
 *
 * Uses SET NX EX (atomic acquire, auto-expire) — the same pattern
 * already proven in compute-leaderboard. Extracted here so every
 * cron route can reuse it without copy-pasting.
 */

import { createLogger } from '@/lib/utils/logger'
import { tryAcquireRedisLease } from '@/lib/cache/redis-lease'

const logger = createLogger('cron-lock')

interface CronLockOptions {
  /** Lock TTL in seconds (default: 300 — matches typical maxDuration) */
  ttlSeconds?: number
}

export type CronLockAcquisition =
  | { status: 'acquired'; release: () => Promise<void> }
  | { status: 'contended' }
  | { status: 'unavailable' }

/**
 * Acquire a Redis lock for a cron job.
 * Distinguishes a real competing owner from coordination failure so callers
 * cannot report HTTP 200 `skipped` while Redis is unavailable.
 *
 * Fail closed: Redis outages return `unavailable`; mutating jobs must expose
 * a retryable failure instead of running concurrently without fencing.
 */
export async function acquireCronLock(
  jobName: string,
  options: CronLockOptions = {}
): Promise<CronLockAcquisition> {
  const { ttlSeconds = 300 } = options
  const lockKey = `cron:lock:${jobName}`
  const leaseTtlSeconds = ttlSeconds + 30

  try {
    const { getSharedRedis } = await import('@/lib/cache/redis-client')
    const redis = await getSharedRedis()

    if (!redis) {
      logger.error(`[${jobName}] Redis unavailable; cron blocked`)
      return { status: 'unavailable' }
    }

    const lease = await tryAcquireRedisLease(redis, lockKey, leaseTtlSeconds)
    if (!lease) {
      logger.info(`[${jobName}] Skipped — already running (lock exists)`)
      return { status: 'contended' }
    }

    return {
      status: 'acquired',
      release: async () => {
        try {
          await lease.release()
        } catch (err) {
          logger.warn(
            `[${jobName}] Failed to release lock:`,
            err instanceof Error ? err.message : String(err)
          )
        }
      },
    }
  } catch (err) {
    logger.error(
      `[${jobName}] Lock check failed; cron blocked:`,
      err instanceof Error ? err.message : String(err)
    )
    return { status: 'unavailable' }
  }
}
