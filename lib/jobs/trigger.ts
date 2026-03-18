/**
 * Trigger.dev Task Definitions
 *
 * Replaces Vercel cron jobs with durable, retryable workflow steps.
 * Each task can be triggered via API, webhook, or schedule.
 *
 * Benefits over Vercel crons:
 * - Automatic retry with exponential backoff
 * - Fan-out: process each exchange in parallel steps
 * - Observability: built-in logging, traces, and run history
 * - No 300s/800s timeout limit (tasks can run for hours)
 * - Idempotent: safe to retry without duplicates
 *
 * Usage:
 *   1. Set TRIGGER_SECRET_KEY env var
 *   2. npx trigger.dev@latest dev (local development)
 *   3. npx trigger.dev@latest deploy (production)
 *
 * Inspired by trigger.dev (14K★) and inngest (5K★).
 */

import { task, schedules } from '@trigger.dev/sdk/v3'

// ─── Scheduled Tasks ──────────────────────────────────────────────────────

/**
 * Compute leaderboard rankings every 30 minutes.
 * Replaces: vercel.json cron "/api/cron/compute-leaderboard" at "0,30 * * * *"
 */
export const computeLeaderboard = schedules.task({
  id: 'compute-leaderboard',
  cron: '0,30 * * * *',
  maxDuration: 600, // 10 minutes
  retry: { maxAttempts: 2, minTimeoutInMs: 5000, factor: 2 },
  run: async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/server')
    const { PipelineLogger } = await import('@/lib/services/pipeline-logger')

    const supabase = getSupabaseAdmin()
    const plog = await PipelineLogger.start('compute-leaderboard')

    try {
      // Call existing API route (reuse existing logic)
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'
      const res = await fetch(`${baseUrl}/api/cron/compute-leaderboard`, {
        headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
        signal: AbortSignal.timeout(550_000),
      })
      if (!res.ok) throw new Error(`compute-leaderboard failed: ${res.status}`)
      const result = await res.json()
      await plog.success(result.stats ? Object.values(result.stats.seasons as Record<string, number>).reduce((a: number, b: number) => a + b, 0) : 0, result)
      return result
    } catch (err) {
      await plog.error(err instanceof Error ? err : new Error(String(err)))
      throw err // trigger.dev will retry
    }
  },
})

/**
 * Fetch traders from exchanges — fan-out per platform group.
 * Replaces: 15 vercel.json crons for batch-fetch-traders groups A-J
 */
export const fetchTradersGroup = task({
  id: 'fetch-traders-group',
  maxDuration: 900, // 15 minutes
  retry: { maxAttempts: 1 }, // Don't retry full group — individual platforms retry internally
  run: async (payload: { group: string }) => {
    const { group } = payload
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

    // Call the existing API route (reuse existing logic)
    const res = await fetch(`${baseUrl}/api/cron/batch-fetch-traders?group=${group}`, {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      signal: AbortSignal.timeout(800_000),
    })

    if (!res.ok) {
      throw new Error(`batch-fetch-traders group=${group} failed: ${res.status}`)
    }

    return await res.json()
  },
})

/**
 * Sync Meilisearch index after leaderboard compute.
 * Replaces: vercel.json cron "/api/cron/sync-meilisearch" at "5,35 * * * *"
 */
export const syncMeilisearch = schedules.task({
  id: 'sync-meilisearch',
  cron: '5,35 * * * *',
  maxDuration: 120,
  retry: { maxAttempts: 2 },
  run: async () => {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'
    const res = await fetch(`${baseUrl}/api/cron/sync-meilisearch`, {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`sync-meilisearch failed: ${res.status}`)
    return await res.json()
  },
})

/**
 * Enrichment batch — run per period.
 * Replaces: vercel.json crons for batch-enrich-90D/30D/7D
 */
export const enrichBatch = task({
  id: 'enrich-batch',
  maxDuration: 900,
  retry: { maxAttempts: 1 },
  run: async (payload: { period: string }) => {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'
    const res = await fetch(`${baseUrl}/api/cron/batch-enrich?period=${payload.period}`, {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      signal: AbortSignal.timeout(800_000),
    })
    if (!res.ok) throw new Error(`batch-enrich period=${payload.period} failed: ${res.status}`)
    return await res.json()
  },
})

/**
 * Daily analytics aggregation.
 * Replaces: vercel.json cron "/api/analytics/daily"
 */
export const analyticsDailyTask = schedules.task({
  id: 'analytics-daily',
  cron: '0 0 * * *', // midnight
  maxDuration: 60,
  retry: { maxAttempts: 3 },
  run: async () => {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'
    const res = await fetch(`${baseUrl}/api/analytics/daily`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`analytics-daily failed: ${res.status}`)
    return await res.json()
  },
})

/**
 * Check data freshness and alert on stale platforms.
 * Replaces: vercel.json cron "/api/cron/check-data-freshness"
 */
export const checkDataFreshness = schedules.task({
  id: 'check-data-freshness',
  cron: '15 */3 * * *', // every 3h at :15
  maxDuration: 120,
  retry: { maxAttempts: 2 },
  run: async () => {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'
    const res = await fetch(`${baseUrl}/api/cron/check-data-freshness`, {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`check-data-freshness failed: ${res.status}`)
    return await res.json()
  },
})
