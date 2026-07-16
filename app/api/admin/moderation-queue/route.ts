/**
 * Moderation Queue API
 * GET  /api/admin/moderation-queue — list content with pending reports
 * POST /api/admin/moderation-queue — take action on reported content
 */

import { NextRequest } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import { createLogger } from '@/lib/utils/logger'
import { parsePage, parseLimit } from '@/lib/utils/safe-parse'

const logger = createLogger('api:moderation-queue')

type QueueAction = 'approve' | 'delete' | 'warn' | 'ban'
type QueueContentType = 'post' | 'comment'

type AtomicModerationResult = {
  applied: boolean
  result_operation_id: string
  result_action: QueueAction
  result_content_type: QueueContentType
  result_content_id: string
  report_status: 'resolved' | 'dismissed' | null
  report_count: number
  action_taken:
    | 'approved_content'
    | 'content_deleted'
    | 'content_already_absent'
    | 'user_warned'
    | 'user_banned'
    | null
  author_id: string | null
  content_soft_deleted: boolean | null
  content_affected_count: number
  strike_id: string | null
  strike_type: 'warning' | 'mute' | 'temp_ban' | 'perm_ban' | null
}

const ATOMIC_RESULT_KEYS = [
  'action_taken',
  'applied',
  'author_id',
  'content_affected_count',
  'content_soft_deleted',
  'report_count',
  'report_status',
  'result_action',
  'result_content_id',
  'result_content_type',
  'result_operation_id',
  'strike_id',
  'strike_type',
] as const

const MODERATION_REQUEST_KEYS = ['action', 'content_id', 'content_type', 'operation_id'] as const

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function parseAtomicModerationResult(
  value: unknown,
  expected: {
    action: QueueAction
    contentType: QueueContentType
    contentId: string
    operationId: string
  }
): AtomicModerationResult | null {
  if (!Array.isArray(value) || value.length !== 1) return null
  const row = value[0]
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const candidate = row as Record<string, unknown>
  const keys = Object.keys(candidate).sort()
  if (
    keys.length !== ATOMIC_RESULT_KEYS.length ||
    !ATOMIC_RESULT_KEYS.every((key, index) => keys[index] === key) ||
    typeof candidate.applied !== 'boolean' ||
    candidate.result_operation_id !== expected.operationId ||
    candidate.result_action !== expected.action ||
    candidate.result_content_type !== expected.contentType ||
    candidate.result_content_id !== expected.contentId ||
    !Number.isSafeInteger(candidate.report_count) ||
    (candidate.report_count as number) < 0 ||
    !Number.isSafeInteger(candidate.content_affected_count) ||
    (candidate.content_affected_count as number) < 0 ||
    ![true, false, null].includes(candidate.content_soft_deleted as boolean | null) ||
    (candidate.author_id !== null &&
      (typeof candidate.author_id !== 'string' || !UUID_PATTERN.test(candidate.author_id))) ||
    (candidate.strike_id !== null &&
      (typeof candidate.strike_id !== 'string' || !UUID_PATTERN.test(candidate.strike_id))) ||
    !['warning', 'mute', 'temp_ban', 'perm_ban', null].includes(
      candidate.strike_type as AtomicModerationResult['strike_type']
    )
  ) {
    return null
  }

  const expectedStatus = expected.action === 'approve' ? 'dismissed' : 'resolved'
  const validActionTaken =
    expected.action === 'approve'
      ? candidate.action_taken === 'approved_content'
      : expected.action === 'delete'
        ? ['content_deleted', 'content_already_absent'].includes(candidate.action_taken as string)
        : expected.action === 'warn'
          ? candidate.action_taken === 'user_warned'
          : candidate.action_taken === 'user_banned'

  if (!candidate.applied) {
    if (
      (candidate.report_count as number) <= 0 ||
      candidate.content_affected_count !== 0 ||
      candidate.report_status !== expectedStatus ||
      !validActionTaken ||
      candidate.strike_id !== null ||
      candidate.strike_type !== null
    ) {
      return null
    }
    return candidate as AtomicModerationResult
  }

  const validDeleteEffect =
    expected.action !== 'delete' ||
    (candidate.action_taken === 'content_deleted'
      ? candidate.content_soft_deleted === true && (candidate.content_affected_count as number) > 0
      : candidate.content_affected_count === 0 &&
        (candidate.content_soft_deleted === null
          ? candidate.author_id === null
          : candidate.content_soft_deleted === true && candidate.author_id !== null))
  if (
    (candidate.report_count as number) <= 0 ||
    candidate.report_status !== expectedStatus ||
    !validActionTaken ||
    (['approve', 'warn'].includes(expected.action) && candidate.content_affected_count !== 0) ||
    (['warn', 'ban'].includes(expected.action) && candidate.author_id === null) ||
    (expected.action === 'ban' &&
      (candidate.content_soft_deleted !== true ||
        (candidate.content_affected_count as number) < 1)) ||
    !validDeleteEffect ||
    (expected.action === 'warn'
      ? candidate.strike_id === null || candidate.strike_type === null
      : candidate.strike_id !== null || candidate.strike_type !== null)
  ) {
    return null
  }

  return candidate as AtomicModerationResult
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
      let body: unknown
      try {
        body = await req.json()
      } catch {
        throw ApiError.validation('Invalid JSON in request body')
      }

      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw ApiError.validation('Request body must be a JSON object')
      }
      const requestBody = body as Record<string, unknown>
      const requestKeys = Object.keys(requestBody).sort()
      if (
        requestKeys.length !== MODERATION_REQUEST_KEYS.length ||
        !MODERATION_REQUEST_KEYS.every((key, index) => requestKeys[index] === key)
      ) {
        throw ApiError.validation(
          'Request body must contain exactly: content_type, content_id, action, operation_id'
        )
      }

      const { content_type, content_id, action, operation_id } = requestBody

      if (
        typeof content_type !== 'string' ||
        typeof content_id !== 'string' ||
        typeof action !== 'string' ||
        typeof operation_id !== 'string' ||
        !content_type ||
        !content_id ||
        !action ||
        !operation_id
      ) {
        throw ApiError.validation(
          'Missing required fields: content_type, content_id, action, operation_id'
        )
      }

      if (!['approve', 'delete', 'warn', 'ban'].includes(action)) {
        throw ApiError.validation('Action must be: approve, delete, warn, or ban')
      }
      if (!['post', 'comment'].includes(content_type)) {
        throw ApiError.validation('Content type must be post or comment')
      }
      if (!UUID_PATTERN.test(content_id)) {
        throw ApiError.validation('Content ID must be a UUID')
      }
      if (!UUID_PATTERN.test(operation_id)) {
        throw ApiError.validation('Operation ID must be a UUID')
      }

      const expected = {
        action: action as QueueAction,
        contentType: content_type as QueueContentType,
        // PostgreSQL serializes uuid values canonically in lowercase.
        contentId: content_id.toLowerCase(),
        operationId: operation_id.toLowerCase(),
      }
      const { data, error } = await supabase.rpc('moderate_report_queue_atomic', {
        p_actor_id: admin.id,
        p_content_type: expected.contentType,
        p_content_id: expected.contentId,
        p_action: expected.action,
        p_operation_id: expected.operationId,
      })

      if (error) {
        logger.error('Atomic moderation queue action failed', {
          adminId: admin.id,
          action,
          content_type,
          content_id,
          ...(error.code ? { code: error.code } : {}),
        })
        if (error.code === '22023') throw ApiError.validation('Invalid moderation action')
        if (error.code === 'P0002') throw ApiError.notFound('Reported content not found')
        if (error.code === '42501') throw ApiError.forbidden('Moderation action forbidden')
        if (error.code === '40001') {
          throw new ApiError('Moderation action conflicts with latest committed action', {
            code: 'DUPLICATE_ACTION',
          })
        }
        throw ApiError.database('Failed to apply moderation action')
      }

      const result = parseAtomicModerationResult(data, expected)
      if (!result) throw ApiError.database('Invalid moderation acknowledgement')

      logger.info('Moderation action taken', {
        adminId: admin.id,
        action,
        content_type,
        content_id,
        applied: result.applied,
        reportCount: result.report_count,
      })

      return apiSuccess({
        message: result.applied
          ? `Action '${action}' completed`
          : 'Matching moderation action was already committed; no action was repeated',
        result,
      })
    },
    { name: 'moderation-queue-post' }
  )

  return handler(req)
}
