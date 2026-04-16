import { withAuth } from '@/lib/api/middleware'
import { badRequest, conflict, serverError, success } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('report-api')

export const dynamic = 'force-dynamic'

const VALID_TYPES = ['post', 'comment', 'profile']
const VALID_REASONS = ['spam', 'scam', 'harassment', 'misinformation', 'nsfw', 'other']

// Auto-hide thresholds: when a piece of content receives this many reports,
// it is automatically hidden pending moderator review.
const POST_REPORT_THRESHOLD = 5
const COMMENT_REPORT_THRESHOLD = 3

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }
    const { content_type, content_id, reason, description } = body as {
      content_type?: string
      content_id?: string
      reason?: string
      description?: string
    }

    if (!content_type || !VALID_TYPES.includes(content_type)) {
      return badRequest('Invalid content type')
    }
    if (!reason || !VALID_REASONS.includes(reason)) {
      return badRequest('Invalid report reason')
    }
    if (!content_id) {
      return badRequest('Missing content ID')
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
      return conflict('You have already reported this content')
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
      logger.error('insert failed', { error: error.message })
      return serverError('Submission failed')
    }

    // Auto-hide: check total report count and hide if threshold reached
    // KEEP 'exact' — drives the auto-hide threshold; scoped per content
    // via (content_type, content_id, status) index. Must be accurate
    // to fire at POST_REPORT_THRESHOLD and not one report too early/late.
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
      logger.warn('Auto-hide check failed', {
        error: autoHideErr instanceof Error ? autoHideErr.message : String(autoHideErr),
      })
    }

    return success({ ok: true })
  },
  { name: 'report', rateLimit: 'write' }
)
