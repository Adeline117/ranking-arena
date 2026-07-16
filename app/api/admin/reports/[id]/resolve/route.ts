/**
 * Resolve one content report through the database-owned atomic boundary.
 * POST /api/admin/reports/[id]/resolve
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, verifyAdmin } from '@/lib/admin/auth'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('admin-resolve-report')

export const dynamic = 'force-dynamic'

type ReportAction = 'resolve' | 'dismiss'
type ReportStatus = 'resolved' | 'dismissed'
type ReportContentType = 'post' | 'comment' | 'message' | 'user'
type ReportEffect =
  | 'content_deleted'
  | 'content_already_absent'
  | 'dismissed'
  | 'approved_content'
  | 'user_banned'

type AtomicReportResolution = {
  applied: boolean
  result_action: ReportAction
  result_code: 'applied' | 'already_processed'
  report_id: string
  report_status: ReportStatus
  content_type: ReportContentType
  content_id: string
  action_taken: ReportEffect | null
  content_soft_deleted: boolean | null
  content_affected_count: number
  admin_log_id: string | null
}

const ATOMIC_RESULT_KEYS = [
  'action_taken',
  'admin_log_id',
  'applied',
  'content_affected_count',
  'content_id',
  'content_soft_deleted',
  'content_type',
  'report_id',
  'report_status',
  'result_action',
  'result_code',
] as const

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_REASON_LENGTH = 500

function parseAtomicReportResolution(
  value: unknown,
  expected: { reportId: string; action: ReportAction }
): AtomicReportResolution | null {
  if (!Array.isArray(value) || value.length !== 1) return null
  const row = value[0]
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null

  const candidate = row as Record<string, unknown>
  const keys = Object.keys(candidate).sort()
  if (
    keys.length !== ATOMIC_RESULT_KEYS.length ||
    !ATOMIC_RESULT_KEYS.every((key, index) => keys[index] === key) ||
    typeof candidate.applied !== 'boolean' ||
    candidate.result_action !== expected.action ||
    candidate.report_id !== expected.reportId ||
    !['applied', 'already_processed'].includes(candidate.result_code as string) ||
    !['resolved', 'dismissed'].includes(candidate.report_status as string) ||
    !['post', 'comment', 'message', 'user'].includes(candidate.content_type as string) ||
    typeof candidate.content_id !== 'string' ||
    !UUID_PATTERN.test(candidate.content_id) ||
    !Number.isSafeInteger(candidate.content_affected_count) ||
    (candidate.content_affected_count as number) < 0 ||
    ![true, false, null].includes(candidate.content_soft_deleted as boolean | null) ||
    (candidate.admin_log_id !== null &&
      (typeof candidate.admin_log_id !== 'string' || !UUID_PATTERN.test(candidate.admin_log_id)))
  ) {
    return null
  }

  if (!candidate.applied) {
    const expectedStatus = expected.action === 'resolve' ? 'resolved' : 'dismissed'
    const validEquivalentEffect =
      expected.action === 'dismiss'
        ? ['dismissed', 'approved_content'].includes(candidate.action_taken as string)
        : ['post', 'comment'].includes(candidate.content_type as string) &&
          ['content_deleted', 'content_already_absent', 'user_banned'].includes(
            candidate.action_taken as string
          ) &&
          candidate.content_affected_count === 0 &&
          [true, null].includes(candidate.content_soft_deleted as boolean | null)
    if (
      candidate.result_code !== 'already_processed' ||
      candidate.report_status !== expectedStatus ||
      !validEquivalentEffect ||
      (expected.action === 'dismiss' && candidate.content_soft_deleted !== null) ||
      candidate.content_affected_count !== 0 ||
      candidate.admin_log_id === null
    ) {
      return null
    }
    return candidate as AtomicReportResolution
  }

  const expectedStatus = expected.action === 'resolve' ? 'resolved' : 'dismissed'
  if (
    candidate.result_code !== 'applied' ||
    candidate.report_status !== expectedStatus ||
    candidate.admin_log_id === null
  ) {
    return null
  }

  if (expected.action === 'dismiss') {
    if (
      candidate.action_taken !== 'dismissed' ||
      candidate.content_soft_deleted !== null ||
      candidate.content_affected_count !== 0
    ) {
      return null
    }
    return candidate as AtomicReportResolution
  }

  if (!['post', 'comment'].includes(candidate.content_type as string)) return null
  if (candidate.action_taken === 'content_deleted') {
    if (
      candidate.content_soft_deleted !== true ||
      (candidate.content_affected_count as number) < 1
    ) {
      return null
    }
  } else if (candidate.action_taken === 'content_already_absent') {
    if (
      candidate.content_affected_count !== 0 ||
      ![true, null].includes(candidate.content_soft_deleted as boolean | null)
    ) {
      return null
    }
  } else {
    return null
  }

  return candidate as AtomicReportResolution
}

function resolutionError(error: { code?: string } | null) {
  switch (error?.code) {
    case 'P0002':
      return NextResponse.json(
        { error: 'Report not found', code: 'REPORT_NOT_FOUND' },
        { status: 404 }
      )
    case '22023':
      return NextResponse.json(
        { error: 'Invalid report resolution', code: 'INVALID_INPUT' },
        { status: 400 }
      )
    case '42501':
      return NextResponse.json({ error: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 })
    case '0A000':
      return NextResponse.json(
        { error: 'This report target cannot be resolved here', code: 'UNSUPPORTED_CONTENT' },
        { status: 422 }
      )
    case '40001':
    case '40P01':
    case '55P03':
      return NextResponse.json(
        { error: 'Report changed during moderation; retry', code: 'MODERATION_CONFLICT' },
        { status: 409 }
      )
    default:
      return NextResponse.json(
        { error: 'Failed to resolve report', code: 'DATABASE_ERROR' },
        { status: 500 }
      )
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const rateLimitResponse = await checkRateLimit(req, {
      ...RateLimitPresets.sensitive,
      prefix: 'admin-resolve',
      failClose: true,
    })
    if (rateLimitResponse) return rateLimitResponse

    const supabase = getSupabaseAdmin()
    const admin = await verifyAdmin(supabase, req.headers.get('authorization'))
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: requestedReportId } = await params
    if (!UUID_PATTERN.test(requestedReportId)) {
      return NextResponse.json({ error: 'Invalid report ID' }, { status: 400 })
    }
    const reportId = requestedReportId.toLowerCase()

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 })
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const input = body as Record<string, unknown>
    const inputKeys = Object.keys(input)
    if (
      inputKeys.some((key) => !['action', 'reason'].includes(key)) ||
      !['resolve', 'dismiss'].includes(input.action as string)
    ) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }

    let reason: string | null = null
    if (Object.prototype.hasOwnProperty.call(input, 'reason')) {
      if (typeof input.reason !== 'string') {
        return NextResponse.json({ error: 'Invalid reason' }, { status: 400 })
      }
      reason = input.reason.trim()
      if (reason.length === 0) reason = null
      if (reason !== null && Array.from(reason).length > MAX_REASON_LENGTH) {
        return NextResponse.json({ error: 'Invalid reason' }, { status: 400 })
      }
    }

    const action = input.action as ReportAction
    const { data, error } = await supabase.rpc('resolve_content_report_atomic', {
      p_actor_id: admin.id,
      p_report_id: reportId,
      p_action: action,
      p_reason: reason,
    })

    if (error) {
      logger.error('Atomic report resolution failed', {
        reportId,
        action,
        code: error.code,
      })
      return resolutionError(error)
    }

    const result = parseAtomicReportResolution(data, { reportId, action })
    if (!result) {
      logger.error('Atomic report resolution acknowledgement was invalid', {
        reportId,
        action,
      })
      return NextResponse.json(
        { error: 'Invalid moderation acknowledgement', code: 'INVALID_ACK' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      ok: true,
      applied: result.applied,
      result: result.result_code,
      report: {
        id: result.report_id,
        status: result.report_status,
        content_type: result.content_type,
        content_id: result.content_id,
      },
      action_taken: result.action_taken,
      content_affected_count: result.content_affected_count,
      message: result.applied
        ? action === 'resolve'
          ? result.action_taken === 'content_deleted'
            ? 'Report resolved and content soft-deleted'
            : 'Report resolved; content was already absent'
          : 'Report dismissed'
        : 'Report already processed',
    })
  } catch (error: unknown) {
    logger.error('Resolve report API error', { error })
    return NextResponse.json(
      { error: 'Internal server error', code: 'INTERNAL_ERROR' },
      { status: 500 }
    )
  }
}
