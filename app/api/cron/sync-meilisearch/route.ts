/**
 * Cron: atomically rebuild the public trader search index.
 *
 * The live `traders` index is never incrementally patched. Every run builds a
 * complete candidate from sealed leaderboard generations, reconciles its full
 * identity set, revalidates the generations, and swaps only after every
 * Meilisearch task reaches `succeeded`.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { acquireCronLock } from '@/lib/cron/with-cron-lock'
import { rebuildMeilisearchTraders } from '@/lib/search/rebuild-meilisearch-traders'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { PipelineState } from '@/lib/services/pipeline-state'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const logger = createLogger('sync-meilisearch')
const TIME_BUDGET_MS = 90_000
const LAST_SYNC_KEY = 'meilisearch:last_sync'

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const meiliUrl = process.env.MEILISEARCH_URL
  const meiliAdminKey = process.env.MEILISEARCH_ADMIN_KEY
  if (!meiliUrl || !meiliAdminKey) {
    return NextResponse.json({ error: 'Meilisearch not configured' }, { status: 503 })
  }

  const lock = await acquireCronLock('sync-meilisearch', { ttlSeconds: 120 })
  if (lock.status !== 'acquired') {
    return NextResponse.json(
      lock.status === 'contended'
        ? { ok: true, status: 'skipped', reason: 'already running' }
        : { ok: false, status: 'error', reason: 'lock_unavailable' },
      { status: lock.status === 'contended' ? 200 : 503 }
    )
  }
  const releaseLock = lock.release

  const startedAt = Date.now()
  let plog: Awaited<ReturnType<typeof PipelineLogger.start>> | undefined
  try {
    plog = await PipelineLogger.start('sync-meilisearch')
    const result = await rebuildMeilisearchTraders({
      supabase: getSupabaseAdmin(),
      meiliUrl,
      meiliAdminKey,
      timeBudgetMs: TIME_BUDGET_MS,
    })

    // This marker means the candidate was reconciled, the generation fence was
    // revalidated, the swap task succeeded, and the old index deletion task
    // succeeded. A mere Meilisearch HTTP 202 can never reach this write.
    const completedAt = new Date().toISOString()
    await PipelineState.set(LAST_SYNC_KEY, completedAt)

    const elapsed = Date.now() - startedAt
    await plog.success(result.evidence.total_count, {
      elapsed_ms: elapsed,
      seasons: result.evidence.season_counts,
      sorted_id_sha256: result.evidence.sorted_id_sha256,
      task_count: result.task_count,
      mode: result.mode,
    })
    logger.info(
      `Meilisearch authoritative rebuild published ${result.evidence.total_count} traders in ${elapsed}ms`
    )

    return NextResponse.json({
      ok: true,
      traders: result.evidence.total_count,
      seasons: result.evidence.season_counts,
      sorted_id_sha256: result.evidence.sorted_id_sha256,
      tasks: result.task_count,
      elapsed_ms: elapsed,
      mode: result.mode,
    })
  } catch (error: unknown) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    const elapsed = Date.now() - startedAt
    logger.error('Meilisearch authoritative rebuild failed:', normalized)
    if (plog) {
      try {
        await plog.error(normalized, {
          elapsed_ms: elapsed,
          mode: 'authoritative',
        })
      } catch (pipelineError) {
        logger.error('Meilisearch pipeline error logging failed:', pipelineError)
      }
    }
    return NextResponse.json(
      {
        ok: false,
        error: 'Meilisearch authoritative rebuild failed',
        elapsed_ms: elapsed,
        mode: 'authoritative',
      },
      { status: 502 }
    )
  } finally {
    try {
      await releaseLock()
    } catch (error) {
      logger.error('Meilisearch cron lock release failed:', error)
    }
  }
}
