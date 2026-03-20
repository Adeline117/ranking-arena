/**
 * Trigger.dev Phase 1 — 6 Core Scheduled Tasks (Canary)
 *
 * Runs alongside Vercel crons as a parallel canary. Does NOT replace
 * any existing cron jobs — both systems fire and we compare results.
 *
 * Each task calls the existing cron route handler INLINE (direct import)
 * to avoid HTTP sub-call issues (401 deployment protection, 524 CF timeout).
 *
 * Benefits over Vercel crons:
 * - Automatic retry with exponential backoff
 * - Observability: built-in logging, traces, run history
 * - No 300s/800s timeout limit
 * - Durable execution with checkpoints
 *
 * Setup:
 *   1. Set TRIGGER_SECRET_KEY env var
 *   2. npx trigger.dev@latest dev   (local development)
 *   3. npx trigger.dev@latest deploy (production)
 */

import { schedules, logger as triggerLogger } from '@trigger.dev/sdk/v3'
import { BASE_URL } from '@/lib/constants/urls'

/**
 * Build a minimal NextRequest with CRON_SECRET auth header.
 * Route handlers check `Authorization: Bearer <CRON_SECRET>` — we satisfy
 * that by constructing a real NextRequest with the correct header.
 */
function buildCronRequest(path: string, method = 'GET'): Request {
  return new Request(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.CRON_SECRET || ''}`,
    },
  })
}

/**
 * Parse a NextResponse-like Response into a plain object for logging.
 */
async function parseResponse(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return { status: res.status, statusText: res.statusText }
  }
}

// ─── 1. Compute Leaderboard (every 30 min) ──────────────────────────────────

export const computeLeaderboard = schedules.task({
  id: 'compute-leaderboard',
  cron: '0,30 * * * *',
  maxDuration: 600,
  retry: { maxAttempts: 2, minTimeoutInMs: 5000, factor: 2 },
  run: async () => {
    triggerLogger.info('Starting compute-leaderboard')

    const { GET } = await import(
      '@/app/api/cron/compute-leaderboard/route'
    )
    const req = buildCronRequest('/api/cron/compute-leaderboard')
    const res = await GET(req as Parameters<typeof GET>[0])
    const result = await parseResponse(res)

    if (res.status !== 200) {
      throw new Error(`compute-leaderboard failed: ${res.status} — ${JSON.stringify(result)}`)
    }

    triggerLogger.info('compute-leaderboard completed', { result })
    return result
  },
})

// ─── 2. Sync Meilisearch (every 30 min, offset 5) ───────────────────────────

export const syncMeilisearch = schedules.task({
  id: 'sync-meilisearch',
  cron: '5,35 * * * *',
  maxDuration: 120,
  retry: { maxAttempts: 2, minTimeoutInMs: 3000 },
  run: async () => {
    triggerLogger.info('Starting sync-meilisearch')

    const { GET } = await import(
      '@/app/api/cron/sync-meilisearch/route'
    )
    const req = buildCronRequest('/api/cron/sync-meilisearch')
    const res = await GET(req as Parameters<typeof GET>[0])
    const result = await parseResponse(res)

    if (res.status !== 200) {
      throw new Error(`sync-meilisearch failed: ${res.status} — ${JSON.stringify(result)}`)
    }

    triggerLogger.info('sync-meilisearch completed', { result })
    return result
  },
})

// ─── 3. Check Data Freshness (every 3 hours) ────────────────────────────────

export const checkDataFreshness = schedules.task({
  id: 'check-data-freshness',
  cron: '15 */3 * * *',
  maxDuration: 120,
  retry: { maxAttempts: 2, minTimeoutInMs: 5000 },
  run: async () => {
    triggerLogger.info('Starting check-data-freshness')

    const { GET } = await import(
      '@/app/api/cron/check-data-freshness/route'
    )
    const req = buildCronRequest('/api/cron/check-data-freshness')
    const res = await GET(req as Parameters<typeof GET>[0])
    const result = await parseResponse(res)

    if (res.status !== 200) {
      throw new Error(`check-data-freshness failed: ${res.status} — ${JSON.stringify(result)}`)
    }

    triggerLogger.info('check-data-freshness completed', { result })
    return result
  },
})

// ─── 4. Analytics Daily (midnight) ──────────────────────────────────────────

export const analyticsDailyTask = schedules.task({
  id: 'analytics-daily',
  cron: '0 0 * * *',
  maxDuration: 60,
  retry: { maxAttempts: 3, minTimeoutInMs: 5000 },
  run: async () => {
    triggerLogger.info('Starting analytics-daily')

    const { GET } = await import(
      '@/app/api/analytics/daily/route'
    )
    const req = buildCronRequest('/api/analytics/daily')
    const res = await GET(req as Parameters<typeof GET>[0])
    const result = await parseResponse(res)

    if (res.status !== 200) {
      throw new Error(`analytics-daily failed: ${res.status} — ${JSON.stringify(result)}`)
    }

    triggerLogger.info('analytics-daily completed', { result })
    return result
  },
})

// ─── 5. Batch Discover (hourly) ─────────────────────────────────────────────

export const batchDiscover = schedules.task({
  id: 'batch-discover',
  cron: '56 * * * *',
  maxDuration: 300,
  retry: { maxAttempts: 1 },
  run: async () => {
    triggerLogger.info('Starting batch-discover')

    const { GET } = await import(
      '@/app/api/cron/batch-discover/route'
    )
    const req = buildCronRequest('/api/cron/batch-discover')
    const res = await GET(req as Parameters<typeof GET>[0])
    const result = await parseResponse(res)

    if (res.status !== 200) {
      throw new Error(`batch-discover failed: ${res.status} — ${JSON.stringify(result)}`)
    }

    triggerLogger.info('batch-discover completed', { result })
    return result
  },
})

// ─── 6. Cleanup Old Data (daily 2 AM) ───────────────────────────────────────

export const cleanupOldData = schedules.task({
  id: 'cleanup-old-data',
  cron: '0 2 * * *',
  maxDuration: 120,
  retry: { maxAttempts: 2, minTimeoutInMs: 5000 },
  run: async () => {
    triggerLogger.info('Starting cleanup-old-data')

    const { GET } = await import(
      '@/app/api/cron/cleanup-deleted-accounts/route'
    )
    const req = buildCronRequest('/api/cron/cleanup-deleted-accounts')
    const res = await GET(req as Parameters<typeof GET>[0])
    const result = await parseResponse(res)

    if (res.status !== 200) {
      throw new Error(`cleanup-old-data failed: ${res.status} — ${JSON.stringify(result)}`)
    }

    triggerLogger.info('cleanup-old-data completed', { result })
    return result
  },
})
