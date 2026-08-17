import { NextResponse } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { successWithPagination } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import { createLogger } from '@/lib/utils/logger'
import { parseReportEvidenceRef, signReportEvidenceRefs } from '@/lib/reports/evidence'
import { parseLimit, parsePage } from '@/lib/utils/safe-parse'

const _logger = createLogger('api:admin-reports')

export const dynamic = 'force-dynamic'

const REPORT_STATUSES = ['pending', 'resolved', 'dismissed'] as const
const REPORT_CONTENT_TYPES = ['post', 'comment', 'message', 'user'] as const

function readFilter<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T | 'all',
  label: string
): T | 'all' {
  const candidate = value ?? fallback
  if (candidate === 'all' || allowed.includes(candidate as T)) return candidate as T | 'all'
  throw ApiError.validation(`Invalid ${label}`)
}

export const GET = withAdminAuth(
  async ({ supabase, request }) => {
    const { searchParams } = new URL(request.url)
    const page = parsePage(searchParams.get('page'))
    const limit = parseLimit(searchParams.get('limit'), 20, 100)
    const offset = (page - 1) * limit
    const status = readFilter(
      searchParams.get('status'),
      REPORT_STATUSES,
      'pending',
      'report status'
    )
    const contentType = readFilter(
      searchParams.get('content_type'),
      REPORT_CONTENT_TYPES,
      'all',
      'report content type'
    )

    let query = supabase
      .from('content_reports')
      .select(
        'id, content_type, content_id, reporter_id, reason, description, images, status, created_at, resolved_by, resolved_at, action_taken',
        { count: 'exact' }
      )

    if (status !== 'all') query = query.eq('status', status)
    if (contentType !== 'all') query = query.eq('content_type', contentType)

    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) {
      throw ApiError.database('Database operation failed')
    }
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw ApiError.database('Invalid report count')
    }

    const reports = data || []
    const reporterIds = [...new Set(reports.map((report) => report.reporter_id))]
    const { data: reporters, error: reportersError } = reporterIds.length
      ? await supabase.from('user_profiles').select('id, handle, avatar_url').in('id', reporterIds)
      : { data: [], error: null }

    if (reportersError) {
      throw ApiError.database('Database operation failed')
    }

    const evidenceRefs: string[] = []
    for (const report of reports) {
      if (
        !Array.isArray(report.images) ||
        report.images.length < 1 ||
        report.images.length > 4 ||
        new Set(report.images).size !== report.images.length ||
        report.images.some(
          (ref) => typeof ref !== 'string' || !parseReportEvidenceRef(ref, report.reporter_id)
        )
      ) {
        throw ApiError.database('Invalid stored report evidence')
      }
      evidenceRefs.push(...report.images)
    }

    let signedEvidence: string[]
    try {
      signedEvidence = await signReportEvidenceRefs(supabase, evidenceRefs)
    } catch (error) {
      _logger.error('Failed to sign report evidence', { error })
      throw ApiError.database('Failed to load report evidence')
    }

    const reporterById = new Map((reporters || []).map((reporter) => [reporter.id, reporter]))
    let evidenceOffset = 0
    const response = reports.map((report) => {
      const images = signedEvidence.slice(evidenceOffset, evidenceOffset + report.images.length)
      evidenceOffset += report.images.length
      return {
        ...report,
        // Preserve the old alias while also supplying the field consumed by
        // ReportsTab and its typed data hook.
        details: report.description,
        images,
        reporter: reporterById.get(report.reporter_id) || null,
      }
    })

    const result = successWithPagination(response, {
      limit,
      offset,
      has_more: (count as number) > offset + limit,
      total: count as number,
    })
    result.headers.set('Cache-Control', 'private, no-store')
    return result
  },
  { name: 'admin-reports-get' }
)

// Report mutations moved to the target-scoped atomic moderation boundaries.
// Keep this retired collection endpoint explicit so no caller can forge queue
// replay history with an arbitrary status/action_taken pair.
export function POST() {
  return NextResponse.json(
    { success: false, error: 'Method not allowed' },
    { status: 405, headers: { Allow: 'GET' } }
  )
}
