/**
 * 处理举报 API
 * POST /api/admin/reports/[id]/resolve
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, verifyAdmin } from '@/lib/admin/auth'
import {
  CommentMutationRolloutError,
  moderateCommentWithRollout,
} from '@/lib/data/comment-mutation-rollout'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('admin-resolve-report')

export const dynamic = 'force-dynamic'

async function confirmPendingReportCommentIsAbsent(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  input: { reportId: string; commentId: string }
): Promise<boolean> {
  const { data: currentReport, error: reportError } = await supabase
    .from('content_reports')
    .select('id, status, content_type, content_id')
    .eq('id', input.reportId)
    .maybeSingle()

  if (reportError) {
    logger.error('Failed to confirm report binding after missing comment', {
      reportId: input.reportId,
      code: reportError.code,
    })
    throw new Error('Report confirmation failed')
  }
  if (
    !currentReport ||
    currentReport.id !== input.reportId ||
    currentReport.status !== 'pending' ||
    currentReport.content_type !== 'comment' ||
    currentReport.content_id !== input.commentId
  ) {
    return false
  }

  const { data: comment, error: commentError } = await supabase
    .from('comments')
    .select('id')
    .eq('id', input.commentId)
    .maybeSingle()

  if (commentError) {
    logger.error('Failed to confirm missing comment after moderation retry', {
      reportId: input.reportId,
      commentId: input.commentId,
      code: commentError.code,
    })
    throw new Error('Comment confirmation failed')
  }
  return comment === null
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Admin sensitive operation — failClose rate limiting
    const rateLimitResponse = await checkRateLimit(req, {
      ...RateLimitPresets.sensitive,
      prefix: 'admin-resolve',
      failClose: true,
    })
    if (rateLimitResponse) return rateLimitResponse

    const supabase = getSupabaseAdmin()
    const authHeader = req.headers.get('authorization')

    const admin = await verifyAdmin(supabase, authHeader)
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: reportId } = await params
    let body: { action?: string; reason?: string }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 })
    }
    const { action, reason } = body

    // action: 'resolve' (delete content), 'dismiss' (ignore report)
    if (!action || !['resolve', 'dismiss'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }

    // Get the report
    const { data: report, error: reportError } = await supabase
      .from('content_reports')
      .select('id, status, content_type, content_id')
      .eq('id', reportId)
      .maybeSingle()

    if (reportError) {
      logger.error('Error fetching report', { reportId, code: reportError.code })
      return NextResponse.json({ error: 'Failed to fetch report' }, { status: 500 })
    }
    if (!report) {
      return NextResponse.json({ error: 'Report not found' }, { status: 404 })
    }

    // Check if already processed
    if (report.status !== 'pending') {
      return NextResponse.json({ error: 'Report already processed' }, { status: 400 })
    }

    let actionTaken = ''

    if (action === 'resolve') {
      // Delete the content
      if (report.content_type === 'post') {
        const { error: deleteError } = await supabase
          .from('posts')
          .delete()
          .eq('id', report.content_id)

        if (deleteError) {
          logger.warn('Error deleting post', { error: deleteError, postId: report.content_id })
          // Content might already be deleted, continue
        }
        actionTaken = 'content_deleted'
      } else if (report.content_type === 'comment') {
        try {
          await moderateCommentWithRollout(supabase, {
            commentId: report.content_id,
            actorId: admin.id,
            action: 'hard_delete',
            reason: reason || 'Report resolved by moderator',
          })
        } catch (error) {
          const isMissingComment =
            error instanceof CommentMutationRolloutError && error.kind === 'not_found'
          const isSafeRetry =
            isMissingComment &&
            (await confirmPendingReportCommentIsAbsent(supabase, {
              reportId,
              commentId: report.content_id,
            }))

          if (!isSafeRetry) throw error
          logger.info('Continuing idempotent report resolution for removed comment', {
            reportId,
            commentId: report.content_id,
          })
        }
        actionTaken = 'content_deleted'
      }
    } else {
      actionTaken = 'dismissed'
    }

    // Update the report
    const nextStatus = action === 'resolve' ? 'resolved' : 'dismissed'
    const { data: updatedReport, error: updateError } = await supabase
      .from('content_reports')
      .update({
        status: nextStatus,
        resolved_by: admin.id,
        resolved_at: new Date().toISOString(),
        action_taken: actionTaken + (reason ? `: ${reason}` : ''),
      })
      .eq('id', reportId)
      .eq('status', 'pending')
      .eq('content_type', report.content_type)
      .eq('content_id', report.content_id)
      .select('id, status, content_type, content_id')
      .maybeSingle()

    if (
      updateError ||
      !updatedReport ||
      updatedReport.id !== reportId ||
      updatedReport.status !== nextStatus ||
      updatedReport.content_type !== report.content_type ||
      updatedReport.content_id !== report.content_id
    ) {
      logger.error('Error updating report', {
        reportId,
        action,
        ...(updateError?.code ? { code: updateError.code } : {}),
      })
      return NextResponse.json({ error: 'Failed to update report' }, { status: 500 })
    }

    // Log the action
    await supabase.from('admin_logs').insert({
      admin_id: admin.id,
      action: action === 'resolve' ? 'resolve_report' : 'dismiss_report',
      target_type: 'report',
      target_id: reportId,
      details: {
        content_type: report.content_type,
        content_id: report.content_id,
        action_taken: actionTaken,
        reason,
      },
    })

    return NextResponse.json({
      ok: true,
      message: action === 'resolve' ? 'Report resolved and content deleted' : 'Report dismissed',
    })
  } catch (error: unknown) {
    logger.error('Resolve report API error', { error })
    return NextResponse.json(
      { error: 'Internal server error', code: 'INTERNAL_ERROR' },
      { status: 500 }
    )
  }
}
