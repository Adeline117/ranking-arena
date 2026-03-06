/**
 * Cron: Refresh hot_score on posts table
 * Schedule: Every 5 minutes
 *
 * Algorithm V4 includes:
 * - Author quality weight (Pro users, followers)
 * - Content quality signals (length, links, mentions)
 * - Negative signal penalties (dislikes, reports)
 * - Segmented time decay
 * - Interaction velocity boost (recent engagement)
 *
 * Uses incremental updates - only processes posts with changes since last refresh.
 * Invalidates Redis cache after refresh.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { del as cacheDelete } from '@/lib/cache'
import { createLogger } from '@/lib/utils/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 60  // Increased for velocity updates

const logger = createLogger('refresh-hot-scores')
const HOT_POSTS_CACHE_KEY = 'hot_posts:top50'

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  if (!process.env.CRON_SECRET) {
    if (process.env.NODE_ENV !== 'development') {
      return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
    }
  } else if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('refresh-hot-scores')

  try {
    const supabase = getSupabaseAdmin()

    // Step 1: Update velocity metrics (likes/comments in last hour)
    const { data: velocityCount, error: velocityError } = await supabase.rpc('update_post_velocity')
    if (velocityError) {
      logger.warn('Velocity update failed', { error: velocityError.message })
    } else {
      logger.info('Velocity metrics updated', { count: velocityCount })
    }

    // Step 2: Update report counts
    const { data: reportCount, error: reportError } = await supabase.rpc('update_post_report_counts')
    if (reportError) {
      logger.warn('Report count update failed', { error: reportError.message })
    } else {
      logger.info('Report counts updated', { count: reportCount })
    }

    // Step 3: Try incremental refresh first (only posts with changes)
    const { data: incrementalCount, error: incrementalError } = await supabase.rpc('refresh_hot_scores_incremental')

    if (!incrementalError && incrementalCount !== null) {
      logger.info('Hot scores refreshed (incremental)', { count: incrementalCount })

      // Invalidate Redis cache for hot posts
      try {
        await cacheDelete(HOT_POSTS_CACHE_KEY)
      } catch {
        // Cache invalidation failure is non-critical
      }

      await plog.success(incrementalCount ?? 0, { method: 'incremental' })

      return NextResponse.json({
        success: true,
        count: incrementalCount,
        method: 'incremental',
        velocityUpdated: velocityCount,
        reportCountsUpdated: reportCount,
      })
    }

    // Fallback to full refresh
    logger.warn('Incremental refresh failed, trying full refresh', {
      error: incrementalError?.message,
    })

    const { data: fullCount, error: fullError } = await supabase.rpc('refresh_hot_scores')

    if (!fullError && fullCount !== null) {
      try {
        await cacheDelete(HOT_POSTS_CACHE_KEY)
      } catch {
        // non-critical
      }

      logger.info('Hot scores refreshed (full)', { count: fullCount })
      await plog.success(fullCount ?? 0, { method: 'full' })
      return NextResponse.json({
        success: true,
        count: fullCount,
        method: 'full',
        velocityUpdated: velocityCount,
        reportCountsUpdated: reportCount,
      })
    }

    // Last resort: update hot_score directly via Supabase query
    // (replaces dangerous exec_sql RPC with safe parameterized approach)
    logger.warn('RPC refresh failed, trying direct update fallback', { error: fullError?.message })

    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data: recentPosts, error: fetchError } = await supabase
      .from('posts')
      .select('id, like_count, comment_count, repost_count, view_count, created_at')
      .gte('created_at', cutoff)

    if (fetchError || !recentPosts) {
      logger.error('Failed to fetch posts for hot score fallback', { error: fetchError?.message })
      await plog.error(new Error(fetchError?.message || 'No posts for fallback'))
      return NextResponse.json({ success: false, error: fetchError?.message || 'No posts' }, { status: 500 })
    }

    let updateErrors = 0
    for (const post of recentPosts) {
      const likes = post.like_count ?? 0
      const comments = post.comment_count ?? 0
      const reposts = post.repost_count ?? 0
      const views = post.view_count ?? 0
      const ageHours = (Date.now() - new Date(post.created_at).getTime()) / 3_600_000
      const score = (likes * 3 + comments * 5 + reposts * 2 + views * 0.1) / Math.pow(ageHours + 2, 1.5)

      const { error: upErr } = await supabase
        .from('posts')
        .update({ hot_score: Math.round(score * 100) / 100, last_hot_refresh_at: new Date().toISOString() })
        .eq('id', post.id)

      if (upErr) updateErrors++
    }

    if (updateErrors > recentPosts.length / 2) {
      logger.error('Too many hot score update failures', { errors: updateErrors, total: recentPosts.length })
      await plog.error(new Error(`${updateErrors}/${recentPosts.length} updates failed`))
      return NextResponse.json({ success: false, error: `${updateErrors}/${recentPosts.length} updates failed` }, { status: 500 })
    }

    try {
      await cacheDelete(HOT_POSTS_CACHE_KEY)
    } catch {
      // non-critical
    }

    await plog.success(recentPosts.length, { method: 'fallback' })
    return NextResponse.json({ success: true, method: 'fallback' })
  } catch (err: unknown) {
    logger.error('Hot score refresh failed', { error: String(err) })
    await plog.error(err)
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 })
  }
}
