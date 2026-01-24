/**
 * Cron: Refresh hot_score on posts table
 * Schedule: Every 5 minutes
 *
 * Improved formula: (likes*3 + comments*5 + reposts*2 + views*0.1) * quality_boost / power(hours+2, 1.5)
 * Uses incremental updates - only processes posts with changes since last refresh.
 * Invalidates Redis cache after refresh.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { del as cacheDelete } from '@/lib/cache'
import { createLogger } from '@/lib/utils/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const logger = createLogger('refresh-hot-scores')
const HOT_POSTS_CACHE_KEY = 'hot_posts:top50'

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = getSupabaseAdmin()

    // Try incremental refresh first (only posts with changes)
    const { data: incrementalCount, error: incrementalError } = await supabase.rpc('refresh_hot_scores_incremental')

    if (!incrementalError && incrementalCount !== null) {
      logger.info('Hot scores refreshed (incremental)', { count: incrementalCount })

      // Invalidate Redis cache for hot posts
      try {
        await cacheDelete(HOT_POSTS_CACHE_KEY)
      } catch {
        // Cache invalidation failure is non-critical
      }

      return NextResponse.json({
        success: true,
        count: incrementalCount,
        method: 'incremental',
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
      return NextResponse.json({
        success: true,
        count: fullCount,
        method: 'full',
      })
    }

    // Last resort: raw SQL fallback
    logger.warn('RPC refresh failed, trying raw SQL fallback', { error: fullError?.message })

    const { error: rawError } = await supabase.rpc('exec_sql', {
      sql: `
        UPDATE posts SET hot_score = (
          (COALESCE(like_count, 0) * 3 +
           COALESCE(comment_count, 0) * 5 +
           COALESCE(repost_count, 0) * 2 +
           COALESCE(view_count, 0) * 0.1)
          / POWER(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 + 2, 1.5)
        ),
        last_hot_refresh_at = now()
        WHERE created_at > NOW() - INTERVAL '7 days'
      `
    })

    if (rawError) {
      logger.error('Failed to refresh hot scores', { error: rawError.message })
      return NextResponse.json({ success: false, error: rawError.message }, { status: 500 })
    }

    try {
      await cacheDelete(HOT_POSTS_CACHE_KEY)
    } catch {
      // non-critical
    }

    return NextResponse.json({ success: true, method: 'fallback' })
  } catch (err) {
    logger.error('Hot score refresh failed', { error: String(err) })
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 })
  }
}
