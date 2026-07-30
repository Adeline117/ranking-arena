/**
 * In-process cron mutations shared by the five-minute dispatcher.
 *
 * Trader discovery and refresh_jobs processing were retired: the BullMQ ingest
 * worker is the sole first-party ranking ingestion authority.
 */

import { del as cacheDelete } from '@/lib/cache'
import { getSupabaseAdmin } from '@/lib/supabase/server'

export interface InlineJobResult {
  name: string
  status: 'success' | 'error'
  durationMs: number
  detail?: Record<string, unknown>
  error?: string
}

const HOT_POSTS_CACHE_KEY = 'hot_posts:top50'
type HotScoreRpcName =
  | 'update_post_velocity'
  | 'update_post_report_counts'
  | 'refresh_hot_scores_incremental'
  | 'refresh_hot_scores'

function isExactMutationCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function requireMutationCount(
  rpcName: string,
  data: unknown,
  error: { message?: string } | null
): number {
  if (error) throw new Error(`${rpcName} failed: ${error.message || 'database error'}`)
  if (!isExactMutationCount(data)) {
    throw new Error(`${rpcName} returned an invalid mutation count`)
  }
  return data
}

async function executeHotScoreRpc(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  rpcName: HotScoreRpcName,
  signal?: AbortSignal
) {
  const request = supabase.rpc(rpcName)
  return signal ? await request.abortSignal(signal) : await request
}

export async function refreshHotScoresInline(signal?: AbortSignal): Promise<InlineJobResult> {
  const start = Date.now()
  const name = 'refresh-hot-scores'
  try {
    const supabase = getSupabaseAdmin()

    // Velocity and report counts are inputs to the canonical score function.
    // Continuing after either write fails publishes rankings from stale inputs.
    const { data: velocityData, error: velocityError } = await executeHotScoreRpc(
      supabase,
      'update_post_velocity',
      signal
    )
    const velocityCount = requireMutationCount('update_post_velocity', velocityData, velocityError)

    const { data: reportData, error: reportError } = await executeHotScoreRpc(
      supabase,
      'update_post_report_counts',
      signal
    )
    const reportCount = requireMutationCount('update_post_report_counts', reportData, reportError)

    const { data: incCount, error: incErr } = await executeHotScoreRpc(
      supabase,
      'refresh_hot_scores_incremental',
      signal
    )
    if (!incErr && isExactMutationCount(incCount)) {
      await cacheDelete(HOT_POSTS_CACHE_KEY)
      return {
        name,
        status: 'success',
        durationMs: Date.now() - start,
        detail: {
          method: 'incremental',
          count: incCount,
          velocityCount,
          reportCount,
        },
      }
    }

    const { data: fullCount, error: fullErr } = await executeHotScoreRpc(
      supabase,
      'refresh_hot_scores',
      signal
    )
    if (!fullErr && isExactMutationCount(fullCount)) {
      await cacheDelete(HOT_POSTS_CACHE_KEY)
      return {
        name,
        status: 'success',
        durationMs: Date.now() - start,
        detail: { method: 'full', count: fullCount, velocityCount, reportCount },
      }
    }

    const incrementalFailure = incErr?.message || 'invalid mutation count'
    const fullFailure = fullErr?.message || 'invalid mutation count'
    throw new Error(
      `Hot score refresh authorities failed (incremental: ${incrementalFailure}; full: ${fullFailure})`
    )
  } catch (err) {
    return {
      name,
      status: 'error',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
