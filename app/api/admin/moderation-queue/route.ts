/**
 * Moderation Queue API
 * GET  /api/admin/moderation-queue — list content with pending reports
 * POST /api/admin/moderation-queue — take action on reported content
 */

import { NextRequest } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import {
  CommentMutationRolloutError,
  moderateCommentWithRollout,
  type ModerateCommentAction,
} from '@/lib/data/comment-mutation-rollout'
import { createLogger } from '@/lib/utils/logger'
import { autoEscalate } from '@/lib/services/moderation'
import { parsePage, parseLimit } from '@/lib/utils/safe-parse'

const logger = createLogger('api:moderation-queue')

type ModerationSupabase = Parameters<typeof autoEscalate>[0]

async function moderateQueueComment(
  supabase: ModerationSupabase,
  input: {
    commentId: string
    actorId: string
    action: Extract<ModerateCommentAction, 'soft_delete' | 'restore_auto_hidden'>
    reason: string
  }
): Promise<void> {
  try {
    await moderateCommentWithRollout(supabase, input)
  } catch (error) {
    if (error instanceof CommentMutationRolloutError && error.kind === 'not_found') {
      throw ApiError.notFound('Comment not found')
    }
    logger.error('Comment moderation failed', {
      commentId: input.commentId,
      action: input.action,
      ...(error instanceof CommentMutationRolloutError
        ? { kind: error.kind, code: error.databaseCode, stage: error.stage }
        : {}),
    })
    throw ApiError.database('Failed to moderate comment')
  }
}

async function transitionPendingReports(
  supabase: ModerationSupabase,
  input: {
    reportIds: string[]
    contentType: string
    contentId: string
    status: 'dismissed' | 'resolved'
    resolvedBy: string
    actionTaken: string
  }
): Promise<void> {
  const resolvedAt = new Date().toISOString()
  const { data, error } = await supabase
    .from('content_reports')
    .update({
      status: input.status,
      resolved_by: input.resolvedBy,
      resolved_at: resolvedAt,
      action_taken: input.actionTaken,
    })
    .in('id', input.reportIds)
    .eq('status', 'pending')
    .eq('content_type', input.contentType)
    .eq('content_id', input.contentId)
    .select('id, status, resolved_by, resolved_at, action_taken, content_type, content_id')

  if (error || !Array.isArray(data)) {
    logger.error('Failed to transition moderation reports', {
      contentType: input.contentType,
      contentId: input.contentId,
      ...(error?.code ? { code: error.code } : {}),
    })
    throw ApiError.database('Failed to update reports')
  }

  const expectedIds = new Set(input.reportIds)
  const acknowledgedIds = new Set<string>()
  for (const row of data) {
    if (
      !row ||
      typeof row.id !== 'string' ||
      !expectedIds.has(row.id) ||
      acknowledgedIds.has(row.id) ||
      row.status !== input.status ||
      row.resolved_by !== input.resolvedBy ||
      row.resolved_at !== resolvedAt ||
      row.action_taken !== input.actionTaken ||
      row.content_type !== input.contentType ||
      row.content_id !== input.contentId
    ) {
      throw ApiError.database('Failed to verify report update')
    }
    acknowledgedIds.add(row.id)
  }

  if (acknowledgedIds.size !== expectedIds.size) {
    throw ApiError.database('Failed to verify report update')
  }
}

export const dynamic = 'force-dynamic'

/**
 * GET — List content grouped by reported item, with all reports
 */
export const GET = withAdminAuth(
  async ({ supabase, request }) => {
    const { searchParams } = new URL(request.url)
    const page = parsePage(searchParams.get('page'))
    const limit = parseLimit(searchParams.get('limit'), 20, 100)

    // Get all pending reports
    const { data: reports, error: reportsError } = await supabase
      .from('content_reports')
      .select('id, content_type, content_id, reporter_id, reason, description, created_at')
      .eq('status', 'pending')
      .in('content_type', ['post', 'comment'])
      .order('created_at', { ascending: false })

    if (reportsError) {
      logger.error('Error fetching pending reports', { error: reportsError })
      throw ApiError.database('Failed to fetch reports')
    }

    if (!reports || reports.length === 0) {
      return apiSuccess({ items: [], total: 0 })
    }

    // Group reports by content
    const grouped: Record<
      string,
      {
        content_type: string
        content_id: string
        reports: typeof reports
      }
    > = {}

    for (const report of reports) {
      const key = `${report.content_type}:${report.content_id}`
      if (!grouped[key]) {
        grouped[key] = {
          content_type: report.content_type,
          content_id: report.content_id,
          reports: [],
        }
      }
      grouped[key].reports.push(report)
    }

    // Sort by report count descending, then by earliest report
    const sortedGroups = Object.values(grouped).sort((a, b) => {
      if (b.reports.length !== a.reports.length) return b.reports.length - a.reports.length
      return (
        new Date(a.reports[0].created_at).getTime() - new Date(b.reports[0].created_at).getTime()
      )
    })

    const total = sortedGroups.length
    const paginatedGroups = sortedGroups.slice((page - 1) * limit, page * limit)

    // Fetch content previews
    const postIds = paginatedGroups
      .filter((g) => g.content_type === 'post')
      .map((g) => g.content_id)
    const commentIds = paginatedGroups
      .filter((g) => g.content_type === 'comment')
      .map((g) => g.content_id)

    const postPreviews: Record<
      string,
      { title: string | null; content: string | null; user_id: string | null }
    > = {}
    const commentPreviews: Record<string, { content: string | null; user_id: string | null }> = {}

    if (postIds.length > 0) {
      const { data: posts } = await supabase
        .from('posts')
        .select('id, title, content, author_id') // posts 用 author_id（无 user_id 列→旧 select 400）
        .in('id', postIds)

      for (const p of posts || []) {
        postPreviews[p.id] = {
          title: p.title,
          content: p.content ? String(p.content).substring(0, 200) : null,
          user_id: p.author_id,
        }
      }
    }

    if (commentIds.length > 0) {
      const { data: comments } = await supabase
        .from('comments')
        .select('id, content, user_id')
        .in('id', commentIds)

      for (const c of comments || []) {
        commentPreviews[c.id] = {
          content: c.content ? String(c.content).substring(0, 200) : null,
          user_id: c.user_id,
        }
      }
    }

    // Collect all user IDs for handles
    const userIds = new Set<string>()
    for (const g of paginatedGroups) {
      for (const r of g.reports) {
        if (r.reporter_id) userIds.add(r.reporter_id)
      }
    }
    for (const p of Object.values(postPreviews)) {
      if (p.user_id) userIds.add(p.user_id)
    }
    for (const c of Object.values(commentPreviews)) {
      if (c.user_id) userIds.add(c.user_id)
    }

    const userHandles: Record<string, string> = {}
    if (userIds.size > 0) {
      const { data: users } = await supabase
        .from('user_profiles')
        .select('id, handle')
        .in('id', Array.from(userIds))

      for (const u of users || []) {
        userHandles[u.id] = u.handle || 'unknown'
      }
    }

    // Build response
    const items = paginatedGroups.map((g) => {
      const preview =
        g.content_type === 'post' ? postPreviews[g.content_id] : commentPreviews[g.content_id]

      const authorId = preview?.user_id || null

      return {
        content_type: g.content_type,
        content_id: g.content_id,
        content_title:
          g.content_type === 'post' ? (preview as (typeof postPreviews)[string])?.title : null,
        content_preview: preview?.content || null,
        author_id: authorId,
        author_handle: authorId ? userHandles[authorId] || null : null,
        report_count: g.reports.length,
        reports: g.reports.map((r) => ({
          id: r.id,
          reporter_id: r.reporter_id,
          reason: r.reason,
          description: r.description,
          created_at: r.created_at,
          reporter_handle: userHandles[r.reporter_id] || null,
        })),
      }
    })

    return apiSuccess({ items, total })
  },
  { name: 'moderation-queue-get' }
)

/**
 * POST — Take action on reported content
 * Actions: approve (dismiss reports), delete, warn, ban
 */
export async function POST(req: NextRequest) {
  const handler = withAdminAuth(
    async ({ admin, supabase }) => {
      let body: { content_type?: string; content_id?: string; action?: string; author_id?: string }
      try {
        body = await req.json()
      } catch {
        throw ApiError.validation('Invalid JSON in request body')
      }
      const { content_type, content_id, action, author_id } = body

      if (!content_type || !content_id || !action) {
        throw ApiError.validation('Missing required fields: content_type, content_id, action')
      }

      if (!['approve', 'delete', 'warn', 'ban'].includes(action)) {
        throw ApiError.validation('Action must be: approve, delete, warn, or ban')
      }
      if (!['post', 'comment'].includes(content_type)) {
        throw ApiError.validation('Content type must be post or comment')
      }
      if ((action === 'warn' || action === 'ban') && !author_id) {
        throw ApiError.validation('author_id is required for warn and ban actions')
      }

      // Get all pending reports for this content
      const { data: reports, error: reportsError } = await supabase
        .from('content_reports')
        .select('id')
        .eq('content_type', content_type)
        .eq('content_id', content_id)
        .eq('status', 'pending')

      if (reportsError || !Array.isArray(reports)) {
        logger.error('Failed to read pending moderation reports', {
          content_type,
          content_id,
          ...(reportsError?.code ? { code: reportsError.code } : {}),
        })
        throw ApiError.database('Failed to fetch reports')
      }
      const reportIds = reports.map((report) => report.id)
      if (
        reportIds.length === 0 ||
        reportIds.some((reportId) => typeof reportId !== 'string' || reportId.length === 0) ||
        new Set(reportIds).size !== reportIds.length
      ) {
        throw ApiError.notFound('No pending reports found')
      }

      if (action === 'approve') {
        if (content_type === 'comment') {
          await moderateQueueComment(supabase, {
            commentId: content_id,
            actorId: admin.id,
            action: 'restore_auto_hidden',
            reason: 'Approved in moderation queue',
          })
        }
        await transitionPendingReports(supabase, {
          reportIds,
          contentType: content_type,
          contentId: content_id,
          status: 'dismissed',
          resolvedBy: admin.id,
          actionTaken: 'approved_content',
        })

        await supabase.from('admin_logs').insert({
          admin_id: admin.id,
          action: 'dismiss_reports',
          target_type: content_type,
          target_id: content_id,
          details: { report_count: reportIds.length },
        })
      } else if (action === 'delete') {
        // Delete the content (soft delete)
        if (content_type === 'post') {
          await supabase
            .from('posts')
            .update({ deleted_at: new Date().toISOString() })
            .eq('id', content_id)
        } else if (content_type === 'comment') {
          await moderateQueueComment(supabase, {
            commentId: content_id,
            actorId: admin.id,
            action: 'soft_delete',
            reason: 'Deleted from moderation queue',
          })
        }

        await transitionPendingReports(supabase, {
          reportIds,
          contentType: content_type,
          contentId: content_id,
          status: 'resolved',
          resolvedBy: admin.id,
          actionTaken: 'content_deleted',
        })

        await supabase.from('admin_logs').insert({
          admin_id: admin.id,
          action: 'delete_content',
          target_type: content_type,
          target_id: content_id,
          details: { report_count: reportIds.length },
        })
      } else if (action === 'warn' && author_id) {
        // Auto-escalate warning for the author
        await autoEscalate(
          supabase,
          author_id,
          `Reported ${content_type} (${content_id})`,
          admin.id
        )

        await transitionPendingReports(supabase, {
          reportIds,
          contentType: content_type,
          contentId: content_id,
          status: 'resolved',
          resolvedBy: admin.id,
          actionTaken: 'user_warned',
        })
      } else if (action === 'ban' && author_id) {
        // Ban the user + delete content
        const bannedAt = new Date().toISOString()
        const bannedReason = `Banned for reported ${content_type}`
        const { data: bannedUser, error: banError } = await supabase
          .from('user_profiles')
          .update({
            banned_at: bannedAt,
            banned_reason: bannedReason,
            banned_by: admin.id,
          })
          .eq('id', author_id)
          .select('id, banned_at, banned_reason, banned_by')
          .maybeSingle()

        if (
          banError ||
          !bannedUser ||
          bannedUser.id !== author_id ||
          bannedUser.banned_at !== bannedAt ||
          bannedUser.banned_reason !== bannedReason ||
          bannedUser.banned_by !== admin.id
        ) {
          logger.error('Failed to ban reported-content author', {
            author_id,
            ...(banError?.code ? { code: banError.code } : {}),
          })
          throw ApiError.database('Failed to ban user')
        }

        // Soft delete the content
        if (content_type === 'post') {
          await supabase
            .from('posts')
            .update({ deleted_at: new Date().toISOString() })
            .eq('id', content_id)
        } else if (content_type === 'comment') {
          await moderateQueueComment(supabase, {
            commentId: content_id,
            actorId: admin.id,
            action: 'soft_delete',
            reason: 'Author banned for reported comment',
          })
        }

        await transitionPendingReports(supabase, {
          reportIds,
          contentType: content_type,
          contentId: content_id,
          status: 'resolved',
          resolvedBy: admin.id,
          actionTaken: 'user_banned',
        })

        await supabase.from('admin_logs').insert({
          admin_id: admin.id,
          action: 'ban_user_from_queue',
          target_type: 'user',
          target_id: author_id,
          details: { content_type, content_id, report_count: reportIds.length },
        })
      }

      logger.info('Moderation action taken', {
        adminId: admin.id,
        action,
        content_type,
        content_id,
        author_id,
      })

      return apiSuccess({ message: `Action '${action}' completed` })
    },
    { name: 'moderation-queue-post' }
  )

  return handler(req)
}
