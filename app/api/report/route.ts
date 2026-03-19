import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('report-api')

export const dynamic = 'force-dynamic'

const VALID_TYPES = ['post', 'comment', 'profile']
const VALID_REASONS = ['spam', 'scam', 'harassment', 'misinformation', 'nsfw', 'other']

// Auto-hide thresholds: when a piece of content receives this many reports,
// it is automatically hidden pending moderator review.
const POST_REPORT_THRESHOLD = 5
const COMMENT_REPORT_THRESHOLD = 3

export async function POST(req: NextRequest) {
  const rateLimitResp = await checkRateLimit(req, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const supabase = getSupabaseAdmin()
    const authHeader = req.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Please log in first' }, { status: 401 })
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.slice(7))
    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication failed' }, { status: 401 })
    }

    const { content_type, content_id, reason, description } = await req.json()

    if (!VALID_TYPES.includes(content_type)) {
      return NextResponse.json({ error: 'Invalid content type' }, { status: 400 })
    }
    if (!VALID_REASONS.includes(reason)) {
      return NextResponse.json({ error: 'Invalid report reason' }, { status: 400 })
    }
    if (!content_id) {
      return NextResponse.json({ error: 'Missing content ID' }, { status: 400 })
    }

    // Check duplicate report
    const { data: existing } = await supabase
      .from('content_reports')
      .select('id')
      .eq('reporter_id', user.id)
      .eq('content_type', content_type)
      .eq('content_id', content_id)
      .eq('status', 'pending')
      .maybeSingle()

    if (existing) {
      return NextResponse.json({ error: 'You have already reported this content' }, { status: 409 })
    }

    const { error } = await supabase
      .from('content_reports')
      .insert({
        reporter_id: user.id,
        content_type,
        content_id,
        reason,
        description: description || null,
      })

    if (error) {
      return NextResponse.json({ error: 'Submission failed' }, { status: 500 })
    }

    // Auto-hide: check total report count and hide if threshold reached
    try {
      const { count } = await supabase
        .from('content_reports')
        .select('id', { count: 'exact', head: true })
        .eq('content_type', content_type)
        .eq('content_id', content_id)
        .eq('status', 'pending')

      if (content_type === 'post' && count && count >= POST_REPORT_THRESHOLD) {
        await supabase
          .from('posts')
          .update({
            deleted_at: new Date().toISOString(),
            deleted_by: null,
            delete_reason: `Auto-hidden: ${count} reports received`,
          })
          .eq('id', content_id)
          .is('deleted_at', null)
        logger.info(`Auto-hidden post ${content_id} after ${count} reports`)
      } else if (content_type === 'comment' && count && count >= COMMENT_REPORT_THRESHOLD) {
        await supabase
          .from('comments')
          .delete()
          .eq('id', content_id)
        logger.info(`Auto-deleted comment ${content_id} after ${count} reports`)
      }
    } catch (autoHideErr) {
      // Non-blocking: report was saved successfully, auto-hide is best-effort
      logger.warn('Auto-hide check failed', { error: autoHideErr instanceof Error ? autoHideErr.message : String(autoHideErr) })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    logger.error('POST /api/report failed', { error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
