/**
 * Cron: Retry Dead Letters — re-enrich failed traders
 * Schedule: Daily at 05:00 UTC (1h after data-reconciliation)
 *
 * Scans PipelineState for enrich:dead:* keys (written by enrichment-runner.ts).
 * Traders with failCount < 5 are re-queued for enrichment.
 * Traders with failCount >= 5 are marked permanently failed and alerted.
 *
 * Also processes reconciliation:gaps:* keys from data-reconciliation cron
 * to trigger re-fetch for traders missing from leaderboard entirely.
 */

import { withCron } from '@/lib/api/with-cron'
import { PipelineState } from '@/lib/services/pipeline-state'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const MAX_RETRY_ATTEMPTS = 5
const MAX_REQUEUE_PER_RUN = 200

export const GET = withCron('retry-dead-letters', async (_request, { supabase }) => {
  let retried = 0
  let permanentlyFailed = 0
  let cleaned = 0

  // Phase 1: Process enrichment dead letters (enrich:dead:*)
  const deadLetters = await PipelineState.getByPrefix('enrich:dead:')

  for (const entry of deadLetters) {
    const value = entry.value as {
      traderIds?: string[]
      failCount?: number
      lastFailedAt?: string
    } | null

    if (!value?.traderIds?.length) {
      // Empty entry, clean up
      await PipelineState.del(entry.key)
      cleaned++
      continue
    }

    if ((value.failCount ?? 0) >= MAX_RETRY_ATTEMPTS) {
      // Permanently failed — log and skip
      permanentlyFailed += value.traderIds.length
      continue
    }

    // Extract platform and period from key: enrich:dead:{platform}:{period}
    const parts = entry.key.replace('enrich:dead:', '').split(':')
    const platform = parts[0]
    const period = parts[1] || '7D'

    if (!platform) continue

    // Re-queue: mark these traders as priority for next enrichment run
    // by setting a priority key that batch-enrich can check
    if (retried < MAX_REQUEUE_PER_RUN) {
      const traderIds = value.traderIds.slice(0, MAX_REQUEUE_PER_RUN - retried)
      await PipelineState.set(`enrich:retry:${platform}:${period}`, {
        traderIds,
        requeuedAt: new Date().toISOString(),
        originalFailCount: value.failCount ?? 0,
      })

      // Increment fail count on the dead letter (so next retry sees higher count)
      await PipelineState.set(entry.key, {
        ...value,
        failCount: (value.failCount ?? 0) + 1,
        lastRetriedAt: new Date().toISOString(),
      })

      retried += traderIds.length
      logger.info(
        `[retry-dead-letters] Re-queued ${traderIds.length} traders for ${platform}:${period}`
      )
    }
  }

  // Phase 2: Process reconciliation gaps (reconciliation:gaps:*)
  const gapEntries = await PipelineState.getByPrefix('reconciliation:gaps:')
  let gapTraders = 0

  for (const entry of gapEntries) {
    const value = entry.value as {
      traderIds?: string[]
      count?: number
      detectedAt?: string
    } | null

    if (!value?.traderIds?.length) {
      await PipelineState.del(entry.key)
      continue
    }

    const platform = entry.key.replace('reconciliation:gaps:', '')

    // Store as priority enrichment targets
    if (retried < MAX_REQUEUE_PER_RUN) {
      const traderIds = value.traderIds.slice(0, Math.min(50, MAX_REQUEUE_PER_RUN - retried))
      await PipelineState.set(`enrich:retry:${platform}:7D`, {
        traderIds,
        requeuedAt: new Date().toISOString(),
        source: 'reconciliation',
      })
      gapTraders += traderIds.length
      retried += traderIds.length
    }

    // Clean up processed gap entries
    await PipelineState.del(entry.key)
  }

  // Phase 3: Clean up stale entries (>7 days old)
  const staleCleanedCount = await PipelineState.cleanupStale(7 * 24 * 3600 * 1000)
  cleaned += staleCleanedCount

  // Alert if there are permanently failed traders
  if (permanentlyFailed > 0) {
    const failedPlatforms = deadLetters
      .filter((e) => {
        const v = e.value as { failCount?: number } | null
        return (v?.failCount ?? 0) >= MAX_RETRY_ATTEMPTS
      })
      .map((e) => e.key.replace('enrich:dead:', ''))

    await sendRateLimitedAlert(
      {
        title: `${permanentlyFailed} traders permanently failed enrichment`,
        message: `Platforms: ${failedPlatforms.join(', ')}\nThese have failed ${MAX_RETRY_ATTEMPTS}+ times. Manual investigation needed.`,
        level: 'warning',
        details: { permanently_failed: permanentlyFailed, platforms: failedPlatforms },
      },
      'dead-letters:permanent',
      24 * 60 * 60 * 1000 // 24h cooldown
    )
  }

  return {
    count: retried,
    retried,
    gap_traders_requeued: gapTraders,
    permanently_failed: permanentlyFailed,
    stale_cleaned: cleaned,
  }
})
