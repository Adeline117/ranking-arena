/**
 * Event-driven trigger chain: fetch → compute → cache
 *
 * After batch-fetch-traders or batch-enrich successfully writes new data,
 * triggers compute-leaderboard → warm-cache in sequence.
 *
 * Fire-and-forget: errors are logged but never block the caller.
 *
 * Redis-based dedup prevents stampede when multiple cron groups finish
 * within a short window (e.g., groups a1 and a2 complete 30s apart).
 */

import { getSharedRedis } from '@/lib/cache/redis-client'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('trigger-chain')

const DEDUP_KEY = 'trigger-chain:last-run'
const DEDUP_WINDOW_MS = 5 * 60 * 1000 // 5 minutes — skip if last trigger was <5min ago

/**
 * Fire-and-forget trigger for downstream cron jobs after successful data write.
 * Calls compute-leaderboard → warm-cache in sequence.
 * Non-blocking: errors are logged but don't affect the caller.
 *
 * @param source - identifier for logging (e.g. "batch-fetch-traders-a1", "batch-enrich-90D")
 */
export function triggerDownstreamRefresh(source: string): void {
  // Immediately return — entire chain runs in background
  void (async () => {
    try {
      // ── Dedup check via Redis ────────────────────────────────────
      const redis = await getSharedRedis()
      if (redis) {
        const lastRun = await redis.get<number>(DEDUP_KEY)
        if (lastRun && Date.now() - lastRun < DEDUP_WINDOW_MS) {
          logger.info(
            `Skipping trigger (dedup): last run ${Math.round((Date.now() - lastRun) / 1000)}s ago, window=${DEDUP_WINDOW_MS / 1000}s [source=${source}]`
          )
          return
        }
        // Stamp the dedup key before triggering (TTL = 10min, auto-cleanup)
        await redis.set(DEDUP_KEY, Date.now(), { ex: 600 })
      } else {
        logger.warn('Redis unavailable — skipping dedup, triggering anyway')
      }

      // ── Resolve base URL ─────────────────────────────────────────
      const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
        || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
        || 'http://localhost:3000'
      const secret = process.env.CRON_SECRET
      if (!secret) {
        logger.warn('CRON_SECRET not set — cannot trigger downstream jobs')
        return
      }

      const headers = { Authorization: `Bearer ${secret}` }

      // ── 1. Trigger compute-leaderboard ───────────────────────────
      logger.info(`[${source}] Triggering compute-leaderboard...`)
      const computeStart = Date.now()
      const computeRes = await fetch(`${baseUrl}/api/cron/compute-leaderboard`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(240_000), // 4min timeout (compute can be slow)
      })
      logger.info(
        `[${source}] compute-leaderboard: ${computeRes.status} (${Date.now() - computeStart}ms)`
      )

      // ── 2. Trigger warm-cache ────────────────────────────────────
      logger.info(`[${source}] Triggering warm-cache...`)
      const cacheStart = Date.now()
      const cacheRes = await fetch(`${baseUrl}/api/cron/warm-cache`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(30_000), // 30s timeout (warm-cache is lightweight)
      })
      logger.info(
        `[${source}] warm-cache: ${cacheRes.status} (${Date.now() - cacheStart}ms)`
      )

      logger.info(`[${source}] Downstream refresh complete`)
    } catch (err) {
      logger.warn(
        `[${source}] Downstream refresh failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  })()
}
