import { NextRequest } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import { createLogger } from '@/lib/utils/logger'
import { parseReportEvidenceRef, signReportEvidenceRefs } from '@/lib/reports/evidence'

const _logger = createLogger('api:admin-reports')

export const dynamic = 'force-dynamic'

export const GET = withAdminAuth(
  async ({ supabase, request }) => {
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status') || 'pending'

    const { data, error } = await supabase
      .from('content_reports')
      .select(
        'id, content_type, content_id, reporter_id, reason, description, images, status, created_at, resolved_by, resolved_at, action_taken'
      )
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) {
      throw ApiError.database('Database operation failed')
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

    return apiSuccess(response, 200, { 'Cache-Control': 'private, no-store' })
  },
  { name: 'admin-reports-get' }
)

export async function POST(req: NextRequest) {
  const handler = withAdminAuth(
    async ({ admin, supabase }) => {
      let reqBody: { reportId?: string; status?: string; action_taken?: string }
      try {
        reqBody = await req.json()
      } catch {
        throw ApiError.validation('Invalid JSON in request body')
      }
      const { reportId, status, action_taken } = reqBody

      if (!reportId || !status || !['reviewed', 'actioned', 'dismissed'].includes(status)) {
        throw ApiError.validation('Invalid parameters')
      }

      const { error } = await supabase
        .from('content_reports')
        .update({
          status,
          resolved_by: admin.id,
          action_taken: action_taken || null,
        })
        .eq('id', reportId)

      if (error) {
        throw ApiError.database('Database operation failed')
      }

      return apiSuccess({ message: 'Report updated' })
    },
    { name: 'admin-reports-post' }
  )

  return handler(req)
}
