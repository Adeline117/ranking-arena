/**
 * Event-driven trigger chain: fetch → compute → evaluate → cache
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

// In-memory fallback dedup when Redis is unavailable
let memoryLastRun = 0

/**
 * Fetch with retry + exponential backoff for downstream job triggers.
 * Replaces bare fetch() calls that silently failed on transient errors.
 */
async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxRetries: number,
  source: string
): Promise<Record<string, unknown> | null> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      })
      const body = await res.json().catch(() => null)
      if (res.ok) return body as Record<string, unknown>
      // Non-retryable status codes
      if (res.status === 401 || res.status === 404) {
        throw new Error(`HTTP ${res.status} (non-retryable)`)
      }
      lastError = new Error(`HTTP ${res.status}`)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
    if (attempt < maxRetries) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 10_000)
      logger.warn(`[${source}] Retry ${attempt + 1}/${maxRetries} in ${delay}ms: ${lastError?.message}`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastError ?? new Error('fetchWithRetry: unknown error')
}

/** Structured metadata passed from upstream job to downstream (Anthropic harness handoff pattern) */
export interface TraceMetadata {
  trace_id: string
  source: string
  platforms_updated: string[]
  records_written: number
  duration_ms: number
  failed_platforms: string[]
}

/**
 * Fire-and-forget trigger for downstream cron jobs after successful data write.
 * Calls compute-leaderboard → warm-cache in sequence.
 * Non-blocking: errors are logged but don't affect the caller.
 *
 * @param source - identifier for logging (e.g. "batch-fetch-traders-a1", "batch-enrich-90D")
 * @param trace - optional trace metadata from upstream job (for structured handoff)
 */
export function triggerDownstreamRefresh(source: string, trace?: TraceMetadata): void {
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
        // In-memory dedup fallback — prevents duplicate triggers within same process
        if (memoryLastRun && Date.now() - memoryLastRun < DEDUP_WINDOW_MS) {
          logger.info(
            `Skipping trigger (memory dedup): last run ${Math.round((Date.now() - memoryLastRun) / 1000)}s ago [source=${source}]`
          )
          return
        }
        memoryLastRun = Date.now()
        logger.warn('Redis unavailable — using in-memory dedup fallback')
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
      const traceId = trace?.trace_id ?? 'no-trace'
      const traceQs = trace ? `?trace_id=${trace.trace_id}&platforms=${trace.platforms_updated.join(',')}` : ''
      logger.info(`[${source}] Triggering compute-leaderboard (trace=${traceId})...`)
      const computeStart = Date.now()
      const computeBody = await fetchWithRetry(`${baseUrl}/api/cron/compute-leaderboard${traceQs}`, headers, 240_000, 2, source)
      const rolledBack = computeBody?.rolled_back as string[] | undefined
      logger.info(
        `[${source}] compute-leaderboard: ok (${Date.now() - computeStart}ms, trace=${traceId})${rolledBack?.length ? ` rolled_back=[${rolledBack.join(',')}]` : ''}`
      )

      // If ALL seasons rolled back due to degradation, skip downstream — data didn't change
      if (rolledBack && rolledBack.length >= 3) {
        logger.warn(`[${source}] All seasons rolled back — skipping downstream (warm-cache/evaluate would use stale data)`)
        return
      }

      // ── 2. Trigger pipeline-evaluate (Anthropic harness: independent Evaluator) ──
      logger.info(`[${source}] Triggering pipeline-evaluate (trace=${traceId})...`)
      const evalStart = Date.now()
      try {
        const evalBody = await fetchWithRetry(`${baseUrl}/api/cron/pipeline-evaluate${traceQs}`, headers, 60_000, 1, source)
        logger.info(
          `[${source}] pipeline-evaluate: score=${evalBody?.score ?? '?'}/100 (${Date.now() - evalStart}ms, trace=${traceId})`
        )
      } catch (evalErr) {
        // Evaluator failure must not block cache warming
        logger.warn(`[${source}] pipeline-evaluate failed (non-blocking): ${evalErr instanceof Error ? evalErr.message : String(evalErr)}`)
      }

      // ── 3. Trigger warm-cache ────────────────────────────────────
      logger.info(`[${source}] Triggering warm-cache...`)
      const cacheStart = Date.now()
      await fetchWithRetry(`${baseUrl}/api/cron/warm-cache`, headers, 30_000, 1, source)
      logger.info(
        `[${source}] warm-cache: ok (${Date.now() - cacheStart}ms)`
      )

      logger.info(`[${source}] Downstream refresh complete (trace=${traceId})`)
    } catch (err) {
      logger.warn(
        `[${source}] Downstream refresh failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  })()
}
