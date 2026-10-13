/**
 * Inline maintenance that remains outside the retired legacy `refresh_jobs`
 * dispatcher. Source acquisition and queue consumption are intentionally not
 * exported from this module.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { del as cacheDelete } from '@/lib/cache'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'

const hotScoreLogger = createLogger('refresh-hot-scores')

export interface InlineJobResult {
  name: string
  status: 'success' | 'error'
  durationMs: number
  detail?: Record<string, unknown>
  error?: string
}

const HOT_POSTS_CACHE_KEY = 'hot_posts:top50'

export async function refreshHotScoresInline(): Promise<InlineJobResult> {
  const start = Date.now()
  const name = 'refresh-hot-scores'
  try {
    const supabase = getSupabaseAdmin() as SupabaseClient

    // Step 1: Velocity + report counts (non-blocking)
    const { error: velErr } = await supabase.rpc('update_post_velocity')
    if (velErr) hotScoreLogger.warn('Velocity update failed', { error: velErr.message })

    const { error: repErr } = await supabase.rpc('update_post_report_counts')
    if (repErr) hotScoreLogger.warn('Report count update failed', { error: repErr.message })

    // Step 2: Incremental refresh
    const { data: incCount, error: incErr } = await supabase.rpc('refresh_hot_scores_incremental')
    if (!incErr && incCount !== null) {
      try {
        await cacheDelete(HOT_POSTS_CACHE_KEY)
      } catch {
        /* non-critical */
      }
      return {
        name,
        status: 'success',
        durationMs: Date.now() - start,
        detail: { method: 'incremental', count: incCount },
      }
    }

    // Step 3: Full refresh
    const { data: fullCount, error: fullErr } = await supabase.rpc('refresh_hot_scores')
    if (!fullErr && fullCount !== null) {
      try {
        await cacheDelete(HOT_POSTS_CACHE_KEY)
      } catch {
        /* non-critical */
      }
      return {
        name,
        status: 'success',
        durationMs: Date.now() - start,
        detail: { method: 'full', count: fullCount },
      }
    }

    // Step 4: Direct update fallback
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days — keep fallback fast
    const { data: posts, error: fetchErr } = await supabase
      .from('posts')
      .select('id, like_count, comment_count, repost_count, view_count, created_at, poll_id')
      .gte('created_at', cutoff)

    if (fetchErr || !posts) {
      return {
        name,
        status: 'error',
        durationMs: Date.now() - start,
        error: fetchErr?.message || 'No posts for fallback',
      }
    }

    // Calculate scores and prepare batch upsert
    const now = new Date().toISOString()

    // Fetch poll vote counts for posts with polls
    const pollPostIds = posts.filter((p) => (p as Record<string, unknown>).poll_id).map((p) => p.id)
    const pollVotes = new Map<string, number>()
    if (pollPostIds.length > 0) {
      const { data: polls } = await supabase
        .from('polls')
        .select('post_id, options')
        .in('post_id', pollPostIds.slice(0, 200))
      for (const poll of polls || []) {
        let total = 0
        const opts = (poll.options || []) as Array<{ votes?: number }>
        opts.forEach((o) => {
          total += o.votes || 0
        })
        pollVotes.set(poll.post_id, total)
      }
    }

    const updates = posts.map((post) => {
      const ageHours = (Date.now() - new Date(post.created_at).getTime()) / 3_600_000
      const pv = pollVotes.get(post.id) || 0
      const engagement =
        (post.like_count ?? 0) * 3 +
        (post.comment_count ?? 0) * 5 +
        (post.repost_count ?? 0) * 2 +
        (post.view_count ?? 0) * 0.1 +
        pv * 0.5
      // Freshness boost: new posts get a baseline score
      const freshness = ageHours < 2 ? 10 : ageHours < 6 ? 5 : ageHours < 12 ? 2 : 0
      // Quality multiplier: poll posts get 1.5x
      const quality = pv > 0 ? 1.5 : 1.0
      const score = (engagement / Math.pow(ageHours + 2, 1.5) + freshness) * quality
      return {
        id: post.id,
        hot_score: Math.round(score * 100) / 100,
        last_hot_refresh_at: now,
      }
    })

    // Batch upsert instead of loop
    const BATCH_SIZE = 25
    let errors = 0
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE)
      const { error: upErr } = await supabase
        .from('posts')
        .upsert(batch, { onConflict: 'id', ignoreDuplicates: false })
      if (upErr) {
        hotScoreLogger.error(`Batch ${i} failed:`, upErr)
        errors++
      }
    }

    if (errors > posts.length / 2) {
      return {
        name,
        status: 'error',
        durationMs: Date.now() - start,
        error: `${errors}/${posts.length} updates failed`,
      }
    }

    try {
      await cacheDelete(HOT_POSTS_CACHE_KEY)
    } catch {
      /* non-critical */
    }
    return {
      name,
      status: 'success',
      durationMs: Date.now() - start,
      detail: { method: 'fallback', count: posts.length },
    }
  } catch (err) {
    return {
      name,
      status: 'error',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
