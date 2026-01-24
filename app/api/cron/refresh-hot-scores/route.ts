/**
 * Cron: Refresh hot_score on posts table
 * Schedule: Every 5 minutes
 *
 * Formula: likes*3 + comments*5 + reposts*2 + views*0.1 - ln(hours+2)*2
 * Uses logarithmic time decay to prevent rapid score collapse.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const logger = createLogger('refresh-hot-scores')

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = getSupabaseAdmin()

    // Update hot_score for posts from last 7 days using logarithmic decay
    const { error, count } = await supabase.rpc('refresh_hot_scores')

    if (error) {
      // Fallback: direct SQL update if RPC not available
      logger.warn('RPC refresh_hot_scores failed, trying raw SQL fallback', { error: error.message })

      const { error: rawError } = await supabase.rpc('exec_sql', {
        sql: `
          UPDATE posts SET hot_score = (
            COALESCE(like_count, 0) * 3 +
            COALESCE(comment_count, 0) * 5 +
            COALESCE(repost_count, 0) * 2 +
            COALESCE(view_count, 0) * 0.1 -
            LN(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 + 2) * 2
          )
          WHERE created_at > NOW() - INTERVAL '7 days'
        `
      })

      if (rawError) {
        logger.error('Failed to refresh hot scores', { error: rawError.message })
        return NextResponse.json({ success: false, error: rawError.message }, { status: 500 })
      }

      return NextResponse.json({ success: true, method: 'fallback' })
    }

    logger.info('Hot scores refreshed', { count })
    return NextResponse.json({ success: true, count })
  } catch (err) {
    logger.error('Hot score refresh failed', { error: String(err) })
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 })
  }
}
