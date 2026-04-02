import { NextRequest } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import { createLogger } from '@/lib/utils/logger'

const _logger = createLogger('api:admin-reports')

export const dynamic = 'force-dynamic'

export const GET = withAdminAuth(
  async ({ supabase, request }) => {
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status') || 'pending'

    const { data, error } = await supabase
      .from('content_reports')
      .select('id, content_type, content_id, reporter_id, reason, details, status, created_at, resolved_by, resolved_at, action_taken')
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) {
      throw ApiError.database('Database operation failed')
    }

    return apiSuccess(data || [])
  },
  { name: 'admin-reports-get' }
)

export async function POST(req: NextRequest) {
  const handler = withAdminAuth(
    async ({ admin, supabase }) => {
      const { reportId, status, action_taken } = await req.json()

      if (!reportId || !['reviewed', 'actioned', 'dismissed'].includes(status)) {
        throw ApiError.validation('Invalid parameters')
      }

      const { error } = await supabase
        .from('content_reports')
        .update({
          status,
          reviewer_id: admin.id,
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
