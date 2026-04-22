/**
 * Redis-based cron job deduplication lock.
 * Prevents overlapping executions of the same cron job.
 *
 * Uses SET NX EX (atomic acquire, auto-expire) — the same pattern
 * already proven in compute-leaderboard. Extracted here so every
 * cron route can reuse it without copy-pasting.
 */

import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('cron-lock')

interface CronLockOptions {
  /** Lock TTL in seconds (default: 300 — matches typical maxDuration) */
  ttlSeconds?: number
}

/**
 * Acquire a Redis lock for a cron job.
 * Returns a release function if acquired, `null` if already locked.
 *
 * Fail-open: if Redis is unavailable or errors, the job runs anyway
 * (availability > dedup correctness).
 */
export async function acquireCronLock(
  jobName: string,
  options: CronLockOptions = {}
): Promise<(() => Promise<void>) | null> {
  const { ttlSeconds = 300 } = options
  const lockKey = `cron:lock:${jobName}`

  try {
    const { getSharedRedis } = await import('@/lib/cache/redis-client')
    const redis = await getSharedRedis()

    if (!redis) {
      // Redis unavailable — allow execution (fail open for availability)
      logger.warn(`[${jobName}] Redis unavailable, running without lock`)
      return async () => {}
    }

    const result = await redis.set(lockKey, Date.now().toString(), { nx: true, ex: ttlSeconds })
    if (result !== 'OK') {
      logger.info(`[${jobName}] Skipped — already running (lock exists)`)
      return null
    }

    // Return release function
    return async () => {
      try {
        await redis.del(lockKey)
      } catch (err) {
        logger.warn(
          `[${jobName}] Failed to release lock:`,
          err instanceof Error ? err.message : String(err)
        )
      }
    }
  } catch (err) {
    // Redis error — allow execution (fail open)
    logger.warn(
      `[${jobName}] Lock check failed, running without lock:`,
      err instanceof Error ? err.message : String(err)
    )
    return async () => {}
  }
}
